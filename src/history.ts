import { randomUUID } from "node:crypto";
import {
	appendFile,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type { StorePaths } from "./config.ts";

/** Larger prompts are skipped, never truncated, so every stored line stays small. */
export const MAX_PROMPT_BYTES = 32_768;

/** Most matches one search returns; refining the query reaches older ones. */
export const MAX_RESULTS = 100;

export type HistoryRecord = {
	v: 1;
	id: string;
	text: string;
	cwd: string;
	session: string;
	/** Epoch milliseconds. */
	ts: number;
};

export type RecordOutcome = "recorded" | "too-large" | "closed";

export type SearchRequest = {
	/** Literal text; an empty query matches every record in scope. */
	query: string;
	/** Exact cwd string to search; omitted searches every directory. */
	cwd?: string | undefined;
};

export type SearchResult = {
	/** At most MAX_RESULTS matches, newest first with `id` breaking ties. */
	records: HistoryRecord[];
	/** More records matched than were returned. */
	capped: boolean;
	/** Every record that matched, returned or not. */
	total: number;
	/** Lines in the file that were skipped because they are not records. */
	malformed: number;
};

export type History = {
	/**
	 * Appends one line, then compacts when the count passes COMPACT_ABOVE.
	 * Rejects with CompactionError when the append landed but the rewrite
	 * failed, and with the I/O error when the append itself failed; the caller
	 * decides how to report either.
	 */
	record(
		entry: Pick<HistoryRecord, "text" | "cwd" | "session">,
	): Promise<RecordOutcome>;
	/**
	 * Matches `query` against every stored record in scope. Matching is a
	 * literal substring test after `toLowerCase()` on both sides: simple case
	 * mappings apply in any script, but there is no locale-aware or full case
	 * folding ("ß" never matches "ss") and no Unicode normalization (composed
	 * and decomposed accents differ). Reloads first when the file changed since
	 * the last load, so other processes' appends appear. Rejects when the file
	 * exists but cannot be read, rather than answering from earlier records;
	 * never recreates or rewrites it.
	 */
	search(request: SearchRequest): Promise<SearchResult>;
	/**
	 * Removes the one record with this id, leaving other submissions of the
	 * same text. Resolves false, without rewriting, when no record has it.
	 */
	delete(id: string): Promise<boolean>;
	/**
	 * Removes every record in scope (every directory when `cwd` is omitted)
	 * and resolves with how many. Scope and count are decided when the rewrite
	 * reads the file, so records appended after an earlier search are cleared
	 * and counted too. Clearing every directory also drops malformed lines.
	 */
	clear(scope: Pick<SearchRequest, "cwd">): Promise<number>;
	/**
	 * Waits for pending work; later records are refused, and later deletions
	 * reject. Safe to call twice.
	 */
	close(): Promise<void>;
};

/** Records kept by every rewrite, newest first by the search order. */
export const MAX_RECORDS = 10_000;

/**
 * An append that takes the count past this compacts to MAX_RECORDS. The
 * slack keeps rewrites to one per thousand appends.
 */
export const COMPACT_ABOVE = MAX_RECORDS + 1_000;

/** The record was appended, but trimming the file to MAX_RECORDS failed. */
export class CompactionError extends Error {
	override name = "CompactionError";
	readonly code: string | undefined;
	constructor(cause: unknown) {
		const code = (cause as NodeJS.ErrnoException | undefined)?.code;
		super(`history compaction failed (${code ?? "unexpected error"})`, {
			cause,
		});
		this.code = code;
	}
}

/** What was loaded, and the file identity it came from. */
type Snapshot = {
	records: HistoryRecord[];
	/** Lines that were not blank and could not be read as a record. */
	malformed: number;
	/** Undefined when the file did not exist; STALE forces the next reload. */
	stamp: string | undefined;
};

/** Never equals a real file stamp. */
const STALE = "stale";

/**
 * Performs no I/O until the first record or search.
 *
 * Rewrites (compaction, delete, and clear) replace the file by rename without locking. Another
 * process's append that lands between this process reading the file and
 * renaming over it, or that opened the old file before the rename, is lost.
 * Appends are one write per line in append mode, which local filesystems
 * keep whole; network filesystems may not.
 */
export function openHistory(paths: StorePaths): History {
	let closed = false;
	let directoryReady = false;
	let loaded: Snapshot | undefined;
	// Appends, rewrites, and loads run one at a time so lines land in
	// submission order and a load never races a rewrite in this process.
	let pending: Promise<unknown> = Promise.resolve();

	const append = async (line: string) => {
		if (!directoryReady) {
			await mkdir(paths.dir, { recursive: true, mode: 0o700 });
			directoryReady = true;
		}
		// Opening per record, rather than holding a descriptor, keeps appends on
		// whatever file currently sits at the path, including after a rewrite.
		await appendFile(paths.historyFile, line, { flag: "a", mode: 0o600 });
	};

	/** Reloads when the file's identity changed; a failure drops the cache. */
	const refresh = async (): Promise<Snapshot> => {
		try {
			const stamp = await fileStamp(paths.historyFile);
			if (loaded && loaded.stamp === stamp) return loaded;
			loaded =
				stamp === undefined
					? { records: [], malformed: 0, stamp }
					: { ...parse(await readFile(paths.historyFile, "utf8")), stamp };
			return loaded;
		} catch (error) {
			loaded = undefined;
			throw error;
		}
	};

	/**
	 * Keeps the newest MAX_RECORDS records that `keep` accepts, and resolves
	 * with how many records `keep` rejected. Skips the rewrite when it rejects
	 * none, unless `always`. Rejects, leaving the file as it was, when it cannot
	 * be read or replaced.
	 */
	const rewrite = async (
		keep: (record: HistoryRecord) => boolean,
		always = false,
	): Promise<number> => {
		// Reads afresh so records other processes appended are kept too.
		const { records } = await refresh();
		const retained = records.filter(keep);
		const removed = records.length - retained.length;
		if (removed === 0 && !always) return 0;
		const kept = retained.sort(newestFirst).slice(0, MAX_RECORDS);
		const temp = join(
			paths.dir,
			`.${basename(paths.historyFile)}.${randomUUID()}.tmp`,
		);
		try {
			// Oldest first, so the file still reads in append order.
			const body = kept
				.reverse()
				.map((record) => `${JSON.stringify(record)}\n`)
				.join("");
			await writeFile(temp, body, { flag: "wx", mode: 0o600 });
			await rename(temp, paths.historyFile);
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {});
			throw error;
		}
		// Keeps the count so the next append stays cheap; the next search reloads.
		loaded = { records: kept, malformed: 0, stamp: STALE };
		return removed;
	};

	/** Queues a rewrite behind pending work, as appends are queued. */
	const queueRewrite = (keep: (record: HistoryRecord) => boolean) => {
		if (closed) return Promise.reject(new Error("history is closed"));
		const run = pending.then(() => rewrite(keep));
		pending = run.catch(() => {});
		return run;
	};

	return {
		async record(entry) {
			if (closed) return "closed";
			if (Buffer.byteLength(entry.text, "utf8") > MAX_PROMPT_BYTES)
				return "too-large";
			const record: HistoryRecord = {
				v: 1,
				id: randomUUID(),
				text: entry.text,
				cwd: entry.cwd,
				session: entry.session,
				ts: Date.now(),
			};
			const write = pending.then(async () => {
				// Loading once gives the count that decides compaction; after that,
				// appends only add to memory and stay cheap. An unreadable file
				// still takes appends, and search reports it.
				if (!loaded) await refresh().catch(() => {});
				await append(`${JSON.stringify(record)}\n`);
				if (!loaded) return;
				// The file's stamp no longer matches, so the next search reloads.
				loaded.records.push(record);
				if (loaded.records.length <= COMPACT_ABOVE) return;
				try {
					await rewrite(() => true, true);
				} catch (error) {
					throw new CompactionError(error);
				}
			});
			pending = write.catch(() => {});
			await write;
			return "recorded";
		},

		async search({ query, cwd }) {
			const read = pending.then(refresh);
			pending = read.catch(() => {});
			const { records, malformed } = await read;
			const needle = query.toLowerCase();
			const matches = records
				.filter(
					(record) =>
						(cwd === undefined || record.cwd === cwd) &&
						record.text.toLowerCase().includes(needle),
				)
				.sort(newestFirst);
			return {
				records: matches.slice(0, MAX_RESULTS),
				capped: matches.length > MAX_RESULTS,
				total: matches.length,
				malformed,
			};
		},

		async delete(id) {
			return (await queueRewrite((record) => record.id !== id)) > 0;
		},

		clear({ cwd }) {
			return queueRewrite((record) => cwd !== undefined && record.cwd !== cwd);
		},

		async close() {
			closed = true;
			await pending;
		},
	};
}

/**
 * Identifies the file's content without reading it. Inode catches a rename
 * over it, and ctime a permission change that makes it unreadable.
 */
async function fileStamp(file: string): Promise<string | undefined> {
	try {
		const { ino, size, mtimeMs, ctimeMs } = await stat(file);
		return `${ino}:${size}:${mtimeMs}:${ctimeMs}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function parse(content: string): Omit<Snapshot, "stamp"> {
	const records: HistoryRecord[] = [];
	let malformed = 0;
	for (const line of content.split("\n")) {
		if (line.trim() === "") continue;
		const record = parseRecord(line);
		if (record) records.push(record);
		else malformed++;
	}
	return { records, malformed };
}

/**
 * Keeps only the known fields so later versions can add fields without a
 * migration. Torn or foreign lines yield undefined and are skipped.
 */
function parseRecord(line: string): HistoryRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { v, id, text, cwd, session, ts } = value as Record<string, unknown>;
	if (
		v !== 1 ||
		typeof id !== "string" ||
		typeof text !== "string" ||
		typeof cwd !== "string" ||
		typeof session !== "string" ||
		typeof ts !== "number"
	)
		return undefined;
	return { v, id, text, cwd, session, ts };
}

function newestFirst(a: HistoryRecord, b: HistoryRecord): number {
	return b.ts - a.ts || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);
}
