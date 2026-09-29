// Several processes sharing one history file, as several Pi instances do.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { StorePaths } from "../src/config.ts";
import { openHistory } from "../src/history.ts";

const HISTORY_MODULE = new URL("../src/history.ts", import.meta.url).href;

let root: string;
let paths: StorePaths;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-prompt-history-procs-"));
	const dir = join(root, "prompt-history");
	paths = { dir, historyFile: join(dir, "history.jsonl") };
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Runs an ES module in its own Node process with `paths` and the store module in scope. */
const node = (body: string): ChildProcess =>
	spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { openHistory } from ${JSON.stringify(HISTORY_MODULE)};
			const paths = ${JSON.stringify(paths)};
			${body}`,
		],
		{ stdio: ["pipe", "pipe", "inherit"] },
	);

const exited = async (child: ChildProcess) => {
	const [code] = await once(child, "exit");
	assert.equal(code, 0);
};

/** Another process records `count` copies of `text` in `cwd`. */
const recordIn = (cwd: string, text: string, count: number) =>
	exited(
		node(`const history = openHistory(paths);
		for (let i = 0; i < ${count}; i++)
			await history.record({ text: ${JSON.stringify(text)}, cwd: ${JSON.stringify(cwd)}, session: "s" });
		await history.close();`),
	);

const line = (fields: Record<string, unknown>) =>
	`${JSON.stringify({ v: 1, id: "id", text: "t", cwd: "/seed", session: "s", ts: 1, ...fields })}\n`;

test("concurrent processes keep every record, repeats included, around a torn line", async () => {
	await mkdir(paths.dir, { recursive: true });
	const writers = ["/p/0", "/p/1", "/p/2", "/p/3"].map((cwd) =>
		recordIn(cwd, "same prompt", 50),
	);
	// A line another writer left torn midway.
	await appendFile(paths.historyFile, '{"v":1,"id":"torn","te\n');
	await Promise.all(writers);

	const history = openHistory(paths);
	for (const cwd of ["/p/0", "/p/1", "/p/2", "/p/3"]) {
		const { records, capped, malformed } = await history.search({
			query: "same prompt",
			cwd,
		});
		assert.equal(records.length, 50, cwd);
		assert.equal(capped, false);
		assert.equal(new Set(records.map((record) => record.id)).size, 50);
		assert.equal(malformed, 1);
	}
});

test("a search sees records another process appended since the last one", async () => {
	const history = openHistory(paths);
	await history.record({ text: "mine", cwd: "/p", session: "s" });
	assert.equal((await history.search({ query: "" })).records.length, 1);

	await recordIn("/p", "theirs", 1);
	const texts = (await history.search({ query: "" })).records.map(
		(record) => record.text,
	);
	assert.deepEqual(texts.sort(), ["mine", "theirs"]);
	await history.close();
});

test("an append by a writer holding the file open across a rewrite is lost", async () => {
	// Accepted limitation, not a guarantee: rewrites do not lock. A writer that
	// opened the file before the rename writes into the replaced file.
	await mkdir(paths.dir, { recursive: true });
	await writeFile(
		paths.historyFile,
		Array.from({ length: 11_000 }, (_, i) =>
			line({ id: `id-${i}`, ts: i + 1 }),
		).join(""),
	);
	const straggler = node(`import { open } from "node:fs/promises";
		const handle = await open(paths.historyFile, "a");
		console.log("opened");
		for await (const _ of process.stdin) break;
		await handle.appendFile(${JSON.stringify(line({ id: "straggler", text: "straggler", ts: 1e15 }))});
		await handle.close();
		process.exit(0);`);
	await once(straggler.stdout as NodeJS.ReadableStream, "data");

	const history = openHistory(paths);
	await history.record({ text: "compacting", cwd: "/seed", session: "s" });
	straggler.stdin?.write("go\n");
	await exited(straggler);
	// A writer that opens the file after the rewrite is kept.
	await recordIn("/seed", "after rewrite", 1);

	const texts = (await history.search({ query: "", cwd: "/seed" })).records
		.slice(0, 2)
		.map((record) => record.text);
	assert.deepEqual(texts.sort(), ["after rewrite", "compacting"]);
	assert.equal(
		(await history.search({ query: "straggler" })).records.length,
		0,
	);
	await history.close();
});
