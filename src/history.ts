import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
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
};

export type History = {
	/** Appends one line. Rejects on I/O failure; the caller decides how to report it. */
	record(
		entry: Pick<HistoryRecord, "text" | "cwd" | "session">,
	): Promise<RecordOutcome>;
	/**
	 * Matches `query` against every stored record in scope. Matching is a
	 * literal substring test after `toLowerCase()` on both sides: simple case
	 * mappings apply in any script, but there is no locale-aware or full case
	 * folding ("ß" never matches "ss") and no Unicode normalization (composed
	 * and decomposed accents differ). Rejects when the file exists but cannot
	 * be read; never recreates or rewrites it.
	 */
	search(request: SearchRequest): Promise<SearchResult>;
	/** Waits for pending appends; later records are refused. Safe to call twice. */
	close(): Promise<void>;
};

/** Performs no I/O until the first record or search. */
export function openHistory(paths: StorePaths): History {
	let closed = false;
	let directoryReady = false;
	// Appends run one at a time so lines land in submission order.
	let pending: Promise<unknown> = Promise.resolve();

	const append = async (line: string) => {
		if (!directoryReady) {
			await mkdir(paths.dir, { recursive: true, mode: 0o700 });
			directoryReady = true;
		}
		// Opening per record, rather than holding a descriptor, keeps appends on
		// whatever file currently sits at the path.
		await appendFile(paths.historyFile, line, { flag: "a", mode: 0o600 });
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
			const write = pending.then(() => append(`${JSON.stringify(record)}\n`));
			pending = write.catch(() => {});
			await write;
			return "recorded";
		},

		async search({ query, cwd }) {
			await pending;
			let content: string;
			try {
				content = await readFile(paths.historyFile, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					return { records: [], capped: false };
				throw error;
			}
			const needle = query.toLowerCase();
			const matches = content
				.split("\n")
				.map(parseRecord)
				.filter(
					(record): record is HistoryRecord =>
						record !== undefined &&
						(cwd === undefined || record.cwd === cwd) &&
						record.text.toLowerCase().includes(needle),
				)
				.sort(newestFirst);
			return {
				records: matches.slice(0, MAX_RESULTS),
				capped: matches.length > MAX_RESULTS,
			};
		},

		async close() {
			closed = true;
			await pending;
		},
	};
}

/**
 * Keeps only the known fields so later versions can add fields without a
 * migration. Blank, torn, or foreign lines yield undefined and are skipped.
 */
function parseRecord(line: string): HistoryRecord | undefined {
	if (line.trim() === "") return undefined;
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
