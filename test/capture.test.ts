import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	type Host,
	loadExtension,
	skipPermissionTests,
	useAgentDir,
} from "./harness.ts";

let store: Awaited<ReturnType<typeof useAgentDir>>;
let host: Host;

beforeEach(async () => {
	store = await useAgentDir();
	host = loadExtension();
});

afterEach(async () => {
	await host.shutdown();
	await store.cleanup();
});

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

const texts = async () => (await store.readLines()).map((line) => line.text);

describe("capture", () => {
	test("records typed TUI input as one version-1 line and continues", async () => {
		const result = await host.input(
			{ text: "explain this diff" },
			host.context({ cwd: "/work/a", sessionId: "s-1" }),
		);
		await host.shutdown();

		assert.deepEqual(result, { action: "continue" });
		const [line, ...rest] = await store.readLines();
		assert.equal(rest.length, 0);
		assert.equal(line?.v, 1);
		assert.equal(line?.text, "explain this diff");
		assert.equal(line?.cwd, "/work/a");
		assert.equal(line?.session, "s-1");
		assert.equal(typeof line?.id, "string");
		assert.equal(typeof line?.ts, "number");
	});

	test("stores the observed text exactly, without normalizing it", async () => {
		const observed = [
			"  leading and trailing  ",
			"tab\there",
			"crlf\r\nline\rcarriage",
			"café 日本語 👋\nsecond line",
			"/skill:review src/index.ts",
			"/my-template some argument",
		];
		for (const text of observed) await host.input({ text });
		await host.shutdown();

		assert.deepEqual(await texts(), observed);
	});

	test("records steering and follow-up input typed while streaming", async () => {
		await host.input({ text: "steer now", streamingBehavior: "steer" });
		await host.input({ text: "then this", streamingBehavior: "followUp" });
		await host.shutdown();

		assert.deepEqual(await texts(), ["steer now", "then this"]);
	});

	test("keeps repeated submissions as separate records", async () => {
		await host.input({ text: "run the tests" });
		await host.input({ text: "run the tests" });
		await host.shutdown();

		const lines = await store.readLines();
		assert.deepEqual(
			lines.map((line) => line.text),
			["run the tests", "run the tests"],
		);
		assert.notEqual(lines[0]?.id, lines[1]?.id);
	});

	test("stores only the text of a mixed text and image prompt", async () => {
		await host.input({
			text: "what is in this screenshot?",
			images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
		});
		await host.shutdown();

		const [line] = await store.readLines();
		assert.equal(line?.text, "what is in this screenshot?");
		assert.equal(JSON.stringify(line).includes("iVBORw0KGgo="), false);
	});

	test("ignores ineligible input but always continues", async () => {
		const ineligible = [
			host.input({ text: "via rpc", source: "rpc" }),
			host.input({ text: "from an extension", source: "extension" }),
			host.input({ text: "rpc mode" }, host.context({ mode: "rpc" })),
			host.input({ text: "json mode" }, host.context({ mode: "json" })),
			host.input({ text: "print mode" }, host.context({ mode: "print" })),
			host.input(
				{ text: "ephemeral" },
				host.context({ sessionFile: undefined }),
			),
			host.input({ text: " \n\t\r\n " }),
			host.input({
				text: "",
				images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			}),
		];
		const results = await Promise.all(ineligible);
		await host.shutdown();

		for (const result of results)
			assert.deepEqual(result, { action: "continue" });
		assert.equal(await exists(store.historyFile), false);
	});
});

describe("prompt size limit", () => {
	test("accepts exactly 32,768 UTF-8 bytes of multibyte text", async () => {
		// 10,922 three-byte characters plus one two-byte character: 32,768 bytes
		// in far fewer than 32,768 UTF-16 code units.
		const atLimit = `${"日".repeat(10_922)}é`;
		await host.input({ text: atLimit });
		await host.shutdown();

		assert.deepEqual(await texts(), [atLimit]);
		assert.deepEqual(host.notices, []);
	});

	test("skips a prompt one byte over the limit with a warning that omits it", async () => {
		const overLimit = `${"日".repeat(10_922)}éa`;
		const result = await host.input({ text: overLimit });
		await host.shutdown();

		assert.deepEqual(result, { action: "continue" });
		assert.equal(await exists(store.historyFile), false);
		assert.equal(host.notices.length, 1);
		assert.equal(host.notices[0]?.type, "warning");
		assert.match(host.notices[0]?.message ?? "", /32768 bytes/);
		assert.equal(host.notices[0]?.message.includes("日"), false);
	});

	test("rate-limits repeated oversize warnings", async () => {
		const overLimit = "x".repeat(32_769);
		await host.input({ text: overLimit });
		await host.input({ text: overLimit });
		await host.shutdown();

		assert.equal(host.notices.length, 1);
	});
});

describe("storage", () => {
	test("registration performs no storage I/O", async () => {
		assert.ok(host.registrations.includes("on:input"));
		assert.equal(await exists(dirname(store.historyFile)), false);
	});

	test("creates a private directory and file", {
		skip: process.platform === "win32",
	}, async () => {
		await host.input({ text: "private" });
		await host.shutdown();

		const mode = async (path: string) => (await stat(path)).mode & 0o777;
		assert.equal(await mode(dirname(store.historyFile)), 0o700);
		assert.equal(await mode(store.historyFile), 0o600);
	});

	test("appends to history left by an earlier runtime", async () => {
		await host.input({ text: "before restart" });
		await host.shutdown();

		host = loadExtension();
		await host.input({ text: "after restart" });
		await host.shutdown();

		assert.deepEqual(await texts(), ["before restart", "after restart"]);
	});

	test("warns when trimming history fails, without the prompt", {
		skip: skipPermissionTests,
	}, async () => {
		await mkdir(dirname(store.historyFile), { recursive: true });
		const line = JSON.stringify({
			v: 1,
			id: "i",
			text: "t",
			cwd: "/",
			session: "s",
			ts: 1,
		});
		await writeFile(store.historyFile, `${line}\n`.repeat(11_000));
		await chmod(dirname(store.historyFile), 0o500);
		try {
			const result = await host.input({ text: "secret prompt" });
			await host.shutdown();
			assert.deepEqual(result, { action: "continue" });
		} finally {
			await chmod(dirname(store.historyFile), 0o700);
		}

		assert.equal((await store.readLines()).length, 11_001);
		assert.equal(host.notices.length, 1);
		const { message, type } = host.notices[0] ?? {};
		assert.equal(type, "warning");
		assert.match(message ?? "", /saved the prompt but could not trim/i);
		assert.match(message ?? "", /EACCES/);
		assert.ok(message?.includes(dirname(store.historyFile)));
		assert.ok(!message?.includes("secret"));
	});

	test("a failed capture still continues and warns without the prompt", async () => {
		// A directory where the history file belongs makes every append fail.
		await mkdir(store.historyFile, { recursive: true });

		const first = await host.input({ text: "secret one" });
		const second = await host.input({ text: "secret two" });
		await host.shutdown();
		const noticesAtShutdown = host.notices.length;
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(
			host.notices.length,
			noticesAtShutdown,
			"no warning after shutdown",
		);
		assert.deepEqual(first, { action: "continue" });
		assert.deepEqual(second, { action: "continue" });
		assert.equal(host.notices.length, 1, "warnings are rate-limited");
		const [notice] = host.notices;
		assert.equal(notice?.type, "warning");
		assert.match(notice?.message ?? "", /EISDIR/);
		assert.match(notice?.message ?? "", /history\.jsonl/);
		assert.equal(notice?.message.includes("secret"), false);
		assert.ok((await stat(store.historyFile)).isDirectory());
	});

	test("leaves an unwritable history file in place rather than recreating it", {
		skip: skipPermissionTests,
	}, async () => {
		await mkdir(dirname(store.historyFile), { recursive: true });
		await writeFile(store.historyFile, "existing line\n");
		await chmod(store.historyFile, 0o000);

		const result = await host.input({ text: "new prompt" });
		await host.shutdown();
		await chmod(store.historyFile, 0o600);

		assert.deepEqual(result, { action: "continue" });
		assert.match(host.notices[0]?.message ?? "", /EACCES/);
		assert.equal(await readFile(store.historyFile, "utf8"), "existing line\n");
	});

	test("a capture that throws before writing still continues", async () => {
		const result = await host.input(
			{ text: "late prompt" },
			host.context({ stale: true }),
		);
		await host.shutdown();

		assert.deepEqual(result, { action: "continue" });
		assert.equal(host.notices.length, 1);
		assert.equal(host.notices[0]?.message.includes("late prompt"), false);
		assert.equal(await exists(store.historyFile), false);
	});

	test("a failing warning does not break capture or shutdown", async () => {
		await mkdir(store.historyFile, { recursive: true });

		const result = await host.input(
			{ text: "prompt" },
			host.context({ notifyThrows: true }),
		);

		assert.deepEqual(result, { action: "continue" });
		await host.shutdown();
		assert.equal(host.notices.length, 1);
	});
});

describe("lifecycle", () => {
	test("does not backfill history from an existing session", async () => {
		const resumed = host.context({
			entries: [
				{
					type: "message",
					message: { role: "user", content: "typed in an earlier run" },
				},
			],
		});
		await host.fire("session_start", { reason: "resume" }, resumed);
		await host.shutdown();

		assert.equal(await exists(store.historyFile), false);
	});

	test("shutdown waits for pending writes, is idempotent, and stops capture", async () => {
		await host.input({ text: "before shutdown" });
		await host.shutdown("reload");
		await host.shutdown("reload");
		await host.input({ text: "after shutdown" });

		assert.deepEqual(await texts(), ["before shutdown"]);
	});

	test("a replacement runtime captures each prompt once", async () => {
		const previous = host;
		await previous.input({ text: "old session" });
		await previous.shutdown("new");

		host = loadExtension();
		const next = host.context({ sessionId: "session-two" });
		await host.input({ text: "new session" }, next);
		// The replaced runtime may still receive a late event; it must not record.
		await previous.input({ text: "new session" }, next);
		await host.shutdown();

		const lines = await store.readLines();
		assert.deepEqual(
			lines.map((line) => [line.text, line.session]),
			[
				["old session", "session-one"],
				["new session", "session-two"],
			],
		);
	});
});
