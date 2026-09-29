import assert from "node:assert/strict";
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
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
		const [record] = await reopened.search({ cwd: "/work/a" });
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
		const found = await history.search({ cwd: "/work/a" });
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
		const found = await history.search({ cwd: "/work/a" });
		assert.deepEqual(found, [
			{ v: 1, id: "a", text: "kept", cwd: "/work/a", session: "s", ts: 1 },
		]);
	});

	test("never rewrites the file when reading", async () => {
		await mkdir(paths.dir, { recursive: true });
		const original = `${line({ id: "a" })}garbage\n`;
		await writeFile(paths.historyFile, original);

		const history = openHistory(paths);
		await history.search({ cwd: "/work/a" });
		await history.record(entry("appended"));
		await history.close();

		const content = await readFile(paths.historyFile, "utf8");
		assert.ok(content.startsWith(original));
	});

	test("does no I/O until used and treats a missing file as empty", async () => {
		const history = openHistory(paths);
		assert.deepEqual(await history.search({ cwd: "/work/a" }), []);
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
		await assert.rejects(history.search({ cwd: "/work/a" }), {
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

		const found = await history.search({ cwd: "/work/a" });
		assert.deepEqual(found.map((record) => record.text).sort(), [
			"mine",
			"mine again",
			"theirs",
		]);
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
