import assert from "node:assert/strict";
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StorePaths } from "../src/config.ts";
import { openHistory } from "../src/history.ts";
import { skipPermissionTests } from "./harness.ts";

let root: string;
let paths: StorePaths;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-prompt-history-store-"));
	const dir = join(root, "prompt-history");
	paths = { dir, historyFile: join(dir, "history.jsonl") };
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const entry = (text: string, cwd = "/work/a") => ({
	text,
	cwd,
	session: "s-1",
});

const line = (fields: Record<string, unknown>) =>
	`${JSON.stringify({ v: 1, id: "id", text: "t", cwd: "/work/a", session: "s", ts: 1, ...fields })}\n`;

describe("history store", () => {
	test("returns exactly what was recorded after reopening", async () => {
		const text = "  tab\there\r\ncrlf\rcr café 日本語 👋\n";
		const first = openHistory(paths);
		assert.equal(await first.record(entry(text)), "recorded");
		await first.close();

		const reopened = openHistory(paths);
		const [record] = (await reopened.search({ query: "", cwd: "/work/a" }))
			.records;
		assert.equal(record?.text, text);
		assert.deepEqual(Object.keys(record ?? {}).sort(), [
			"cwd",
			"id",
			"session",
			"text",
			"ts",
			"v",
		]);
		await reopened.close();
	});

	test("writes one complete JSON line per record", async () => {
		const history = openHistory(paths);
		await history.record(entry("line\nbreak"));
		await history.record(entry("second"));
		await history.close();

		const content = await readFile(paths.historyFile, "utf8");
		const lines = content.split("\n");
		assert.equal(lines.pop(), "", "file ends with a newline");
		assert.deepEqual(
			lines.map((l) => JSON.parse(l).text),
			["line\nbreak", "second"],
		);
	});

	test("orders newest first by timestamp, then by id, within one cwd", async () => {
		await mkdir(paths.dir, { recursive: true });
		await writeFile(
			paths.historyFile,
			line({ id: "a", text: "older", ts: 1 }) +
				line({ id: "b", text: "tie low id", ts: 2 }) +
				line({ id: "c", text: "tie high id", ts: 2 }) +
				line({ id: "d", text: "other project", cwd: "/work/b", ts: 3 }),
		);

		const history = openHistory(paths);
		const { records: found } = await history.search({
			query: "",
			cwd: "/work/a",
		});
		assert.deepEqual(
			found.map((record) => record.text),
			["tie high id", "tie low id", "older"],
		);
	});

	test("ignores unknown fields and skips lines it cannot read", async () => {
		await mkdir(paths.dir, { recursive: true });
		await writeFile(
			paths.historyFile,
			`${line({ id: "a", text: "kept", future: { nested: true } })}{"v":1,"id":"torn","te\n\nnot json\n[]\n${line({ id: "b", v: 2 })}${line({ id: "c", ts: "yesterday" })}`,
		);

		const history = openHistory(paths);
		const { records: found, malformed } = await history.search({
			query: "",
			cwd: "/work/a",
		});
		assert.deepEqual(found, [
			{ v: 1, id: "a", text: "kept", cwd: "/work/a", session: "s", ts: 1 },
		]);
		// Blank lines are not counted.
		assert.equal(malformed, 5);
	});

	test("never rewrites the file when reading", async () => {
		await mkdir(paths.dir, { recursive: true });
		const original = `${line({ id: "a" })}garbage\n`;
		await writeFile(paths.historyFile, original);

		const history = openHistory(paths);
		await history.search({ query: "", cwd: "/work/a" });
		await history.record(entry("appended"));
		await history.close();

		const content = await readFile(paths.historyFile, "utf8");
		assert.ok(content.startsWith(original));
	});

	test("does no I/O until used and treats a missing file as empty", async () => {
		const history = openHistory(paths);
		assert.deepEqual(await history.search({ query: "", cwd: "/work/a" }), {
			records: [],
			capped: false,
			malformed: 0,
		});
		await history.close();
		await assert.rejects(stat(paths.dir), { code: "ENOENT" });
	});

	test("rejects when the file is unreadable and leaves it untouched", {
		skip: skipPermissionTests,
	}, async () => {
		await mkdir(paths.dir, { recursive: true });
		await writeFile(paths.historyFile, line({ id: "a" }));
		await chmod(paths.historyFile, 0o000);

		const history = openHistory(paths);
		await assert.rejects(history.search({ query: "", cwd: "/work/a" }), {
			code: "EACCES",
		});
		await chmod(paths.historyFile, 0o600);
		assert.equal(await readFile(paths.historyFile, "utf8"), line({ id: "a" }));
	});

	test("appends lines written by another writer in between", async () => {
		const history = openHistory(paths);
		await history.record(entry("mine"));
		await appendFile(
			paths.historyFile,
			line({ id: "z", text: "theirs", ts: 1 }),
		);
		await history.record(entry("mine again"));

		const { records: found } = await history.search({
			query: "",
			cwd: "/work/a",
		});
		assert.deepEqual(found.map((record) => record.text).sort(), [
			"mine",
			"mine again",
			"theirs",
		]);
		await history.close();
	});

	test("sees a rewrite by another writer even at the same size", async () => {
		await mkdir(paths.dir, { recursive: true });
		await writeFile(paths.historyFile, line({ id: "a", text: "before" }));
		const history = openHistory(paths);
		assert.equal(
			(await history.search({ query: "" })).records[0]?.text,
			"before",
		);

		const replacement = join(paths.dir, "replacement");
		await writeFile(replacement, line({ id: "a", text: "after!" }));
		await rename(replacement, paths.historyFile);
		assert.equal(
			(await history.search({ query: "" })).records[0]?.text,
			"after!",
		);
	});

	test("treats a file deleted after loading as empty", async () => {
		const history = openHistory(paths);
		await history.record(entry("gone"));
		await history.search({ query: "" });
		await rm(paths.historyFile);

		assert.deepEqual((await history.search({ query: "" })).records, []);
		await history.close();
	});

	test("keeps accepting appends while the file is unreadable", {
		skip: skipPermissionTests,
	}, async () => {
		await mkdir(paths.dir, { recursive: true });
		await writeFile(paths.historyFile, line({ id: "a", text: "kept" }));
		await chmod(paths.historyFile, 0o200);
		const history = openHistory(paths);
		try {
			assert.equal(await history.record(entry("while broken")), "recorded");
		} finally {
			await chmod(paths.historyFile, 0o600);
		}
		const texts = (await history.search({ query: "" })).records.map(
			(record) => record.text,
		);
		assert.deepEqual(texts.sort(), ["kept", "while broken"]);
		await history.close();
	});

	test("refuses records after close, and close is idempotent", async () => {
		const history = openHistory(paths);
		await history.close();
		await history.close();
		assert.equal(await history.record(entry("late")), "closed");
		await assert.rejects(stat(paths.historyFile), { code: "ENOENT" });
	});
});

describe("history retention", () => {
	/** Writes `count` records with ts 1..count, ids derived from ts. */
	const seedCount = async (count: number, extra = "") => {
		await mkdir(paths.dir, { recursive: true });
		await writeFile(
			paths.historyFile,
			Array.from({ length: count }, (_, i) =>
				line({ id: `id-${String(i + 1).padStart(5, "0")}`, ts: i + 1 }),
			).join("") + extra,
		);
	};

	const storedLines = async () =>
		(await readFile(paths.historyFile, "utf8"))
			.split("\n")
			.filter((l) => l !== "");

	test("keeps appending without a rewrite up to 11,000 records", async () => {
		await seedCount(10_999);
		const history = openHistory(paths);
		await history.record(entry("the 11,000th"));
		await history.close();

		assert.equal((await storedLines()).length, 11_000);
	});

	test("compacts to the newest 10,000 once an append passes 11,000", async () => {
		await seedCount(11_000);
		const history = openHistory(paths);
		assert.equal(await history.record(entry("newest")), "recorded");

		const kept = (await storedLines()).map((l) => JSON.parse(l));
		assert.equal(kept.length, 10_000);
		assert.ok(kept.some((record) => record.text === "newest"));
		// The newest 9,999 seeded records survive: ts 1,002..11,000.
		const seeded = kept.filter((record) => record.text !== "newest");
		assert.equal(Math.min(...seeded.map((record) => record.ts)), 1_002);

		const all = await history.search({ query: "" });
		assert.equal(all.records[0]?.text, "newest");
		await history.close();
	});

	test("breaks retention ties by id, like search order", async () => {
		// 10,001 records share ts 5; the one with the lowest id is dropped.
		await mkdir(paths.dir, { recursive: true });
		await writeFile(
			paths.historyFile,
			Array.from({ length: 11_000 }, (_, i) =>
				line({
					id: `id-${String(i).padStart(5, "0")}`,
					ts: i < 1_000 ? 1 : 5,
				}),
			).join(""),
		);
		const history = openHistory(paths);
		await history.record(entry("newest"));
		await history.close();

		const ids = (await storedLines()).map((l) => JSON.parse(l).id);
		assert.equal(ids.length, 10_000);
		assert.ok(!ids.includes("id-01000"));
		assert.ok(ids.includes("id-01001"));
	});

	test("rewrites with private permissions and keeps appending afterwards", {
		skip: skipPermissionTests,
	}, async () => {
		await seedCount(11_000);
		await chmod(paths.historyFile, 0o644);
		const history = openHistory(paths);
		await history.record(entry("compacting"));
		assert.equal((await stat(paths.historyFile)).mode & 0o777, 0o600);

		await history.record(entry("after"));
		await history.close();
		const reopened = openHistory(paths);
		const texts = (await reopened.search({ query: "", cwd: "/work/a" })).records
			.slice(0, 2)
			.map((record) => record.text);
		assert.deepEqual(texts.sort(), ["after", "compacting"]);
		assert.equal((await storedLines()).length, 10_001);
	});

	test("a compaction keeps records another writer appended after the load", async () => {
		await seedCount(11_000);
		const history = openHistory(paths);
		await history.search({ query: "" });
		await appendFile(
			paths.historyFile,
			line({ id: "theirs", text: "theirs", ts: Date.now() + 60_000 }),
		);
		await history.record(entry("mine"));
		await history.close();

		const texts = (await storedLines()).map((l) => JSON.parse(l).text);
		assert.equal(texts.length, 10_000);
		assert.ok(texts.includes("theirs"));
		assert.ok(texts.includes("mine"));
	});

	test("a compaction drops malformed lines", async () => {
		await seedCount(11_000, "torn line\n");
		const history = openHistory(paths);
		await history.record(entry("newest"));
		await history.close();

		assert.ok(!(await storedLines()).includes("torn line"));
	});

	test("keeps the original and leaves no temporary file when a rewrite cannot be prepared", {
		skip: skipPermissionTests,
	}, async () => {
		await seedCount(11_000);
		const history = openHistory(paths);
		await chmod(paths.dir, 0o500);
		try {
			await assert.rejects(history.record(entry("newest")), {
				name: "CompactionError",
				code: "EACCES",
			});
		} finally {
			await chmod(paths.dir, 0o700);
		}
		// The append itself landed; only the rewrite failed.
		assert.equal((await storedLines()).length, 11_001);
		assert.deepEqual(await readdir(paths.dir), ["history.jsonl"]);

		// Retrying after the problem is fixed compacts.
		await history.record(entry("retry"));
		await history.close();
		assert.equal((await storedLines()).length, 10_000);
	});

	test("never rewrites an unreadable file", {
		skip: skipPermissionTests,
	}, async () => {
		await seedCount(11_000);
		const history = openHistory(paths);
		await history.search({ query: "" });
		await chmod(paths.historyFile, 0o200);
		try {
			await assert.rejects(history.record(entry("newest")), {
				name: "CompactionError",
				code: "EACCES",
			});
		} finally {
			await chmod(paths.historyFile, 0o600);
		}
		assert.equal((await storedLines()).length, 11_001);
		await history.close();
	});
});

describe("history search", () => {
	/** Writes records whose ids derive from `ts`. */
	const seed = async (
		records: { text: string; ts: number; cwd?: string }[],
	) => {
		await mkdir(paths.dir, { recursive: true });
		await writeFile(
			paths.historyFile,
			records
				.map(({ text, ts, cwd }) =>
					line({
						id: `id-${String(ts).padStart(5, "0")}`,
						text,
						ts,
						cwd: cwd ?? "/work/a",
					}),
				)
				.join(""),
		);
	};

	const texts = async (query: string, cwd?: string) =>
		(await openHistory(paths).search({ query, cwd })).records.map(
			(record) => record.text,
		);

	test("matches a literal, case-insensitive substring", async () => {
		await seed([
			{ text: "Fix the BUG in parser", ts: 1 },
			{ text: "write docs", ts: 2 },
		]);

		assert.deepEqual(await texts("bug in"), ["Fix the BUG in parser"]);
		assert.deepEqual(await texts("FIX THE"), ["Fix the BUG in parser"]);
		assert.deepEqual(await texts("bugin"), []);
	});

	test("treats punctuation and pattern syntax as plain characters", async () => {
		await seed([
			{ text: "grep 'a.*b' | sort", ts: 1 },
			{ text: "axxb and (group)", ts: 2 },
			{ text: "price is $5 [approx]?", ts: 3 },
		]);

		assert.deepEqual(await texts("a.*b"), ["grep 'a.*b' | sort"]);
		assert.deepEqual(await texts("(group)"), ["axxb and (group)"]);
		assert.deepEqual(await texts("$5 [approx]?"), ["price is $5 [approx]?"]);
		assert.deepEqual(await texts("| sort"), ["grep 'a.*b' | sort"]);
		assert.deepEqual(await texts("a+b"), []);
	});

	test("folds case with toLowerCase only, without locale or normalization", async () => {
		await seed([
			{ text: "CAFÉ order", ts: 1 },
			{ text: "Straße name", ts: 2 },
			{ text: "decomposed café", ts: 3 },
			{ text: "ΣΟΦΙΑ greek", ts: 4 },
			{ text: "日本語のプロンプト 👋", ts: 5 },
		]);

		// Simple case mappings apply to any script.
		assert.deepEqual(await texts("café"), ["CAFÉ order"]);
		assert.deepEqual(await texts("σοφια"), ["ΣΟΦΙΑ greek"]);
		assert.deepEqual(await texts("プロンプト 👋"), ["日本語のプロンプト 👋"]);
		// No full case folding: ß does not match "ss".
		assert.deepEqual(await texts("strasse"), []);
		assert.deepEqual(await texts("STRASSE"), []);
		// No Unicode normalization: composed é does not match e + combining acute.
		assert.deepEqual(await texts("decomposed café"), []);
		assert.deepEqual(await texts("café"), ["decomposed café"]);
	});

	test("an empty query matches everything in scope", async () => {
		await seed([
			{ text: "here", ts: 1 },
			{ text: "elsewhere", ts: 2, cwd: "/work/b" },
		]);

		assert.deepEqual(await texts("", "/work/a"), ["here"]);
	});

	test("searches every directory when no cwd is given", async () => {
		await seed([
			{ text: "prompt in a", ts: 1 },
			{ text: "prompt in b", ts: 2, cwd: "/work/b" },
			{ text: "other thing", ts: 3, cwd: "/work/c" },
		]);

		assert.deepEqual(await texts("prompt"), ["prompt in b", "prompt in a"]);
	});

	test("returns only the newest 100 matches and reports the cap", async () => {
		await seed(
			Array.from({ length: 150 }, (_, i) => ({
				text: i % 2 === 0 ? `even ${i}` : `odd ${i}`,
				ts: i,
			})),
		);
		const history = openHistory(paths);

		const all = await history.search({ query: "" });
		assert.equal(all.records.length, 100);
		assert.equal(all.capped, true);
		assert.equal(all.records[0]?.text, "odd 149");
		assert.equal(all.records[99]?.text, "even 50");

		const even = await history.search({ query: "even" });
		assert.equal(even.records.length, 75);
		assert.equal(even.capped, false);
	});

	test("finds matches older than the newest 100 records", async () => {
		await seed([
			{ text: "the one old needle", ts: 0 },
			...Array.from({ length: 200 }, (_, i) => ({
				text: `recent ${i}`,
				ts: i + 1,
			})),
		]);

		assert.deepEqual(await texts("needle"), ["the one old needle"]);
	});

	test("reports no cap at exactly 100 matches", async () => {
		await seed(
			Array.from({ length: 100 }, (_, i) => ({ text: `p${i}`, ts: i })),
		);

		const result = await openHistory(paths).search({ query: "" });
		assert.equal(result.records.length, 100);
		assert.equal(result.capped, false);
	});
});
