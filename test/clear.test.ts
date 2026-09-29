import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
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
	await chmod(dirname(store.historyFile), 0o700).catch(() => {});
	await host.shutdown();
	await store.cleanup();
});

const line = (id: string, cwd = "/work/project") =>
	`${JSON.stringify({ v: 1, id, text: `text ${id}`, cwd, session: "s", ts: 1 })}\n`;

/** Two records in the harness's default cwd, one elsewhere. */
const seed = async () => {
	await mkdir(dirname(store.historyFile), { recursive: true });
	await writeFile(
		store.historyFile,
		line("here-1") + line("elsewhere", "/work/other") + line("here-2"),
	);
};

const storedIds = async () => (await store.readLines()).map((r) => r.id);

describe("/history clear", () => {
	for (const args of ["clear", "clear  ", "clear here", "clear cwd now"])
		test(`"/history ${args}" shows usage and clears nothing`, async () => {
			await seed();
			await host.command("history", args);

			assert.deepEqual(host.ui.confirms, []);
			assert.match(host.notices.at(-1)?.message ?? "", /\/history clear cwd/);
			assert.match(host.notices.at(-1)?.message ?? "", /\/history clear all/);
			assert.equal((await storedIds()).length, 3);
		});

	test("clear cwd confirms the directory and count, then clears only it", async () => {
		await seed();
		await host.command("history", "clear cwd");

		assert.equal(host.ui.confirms.length, 1);
		const { message } = host.ui.confirms[0] ?? { message: "" };
		assert.match(message, /2 prompts/);
		assert.match(message, /\/work\/project/);
		assert.deepEqual(await storedIds(), ["elsewhere"]);
		assert.match(host.notices.at(-1)?.message ?? "", /Cleared 2 prompts/);
	});

	test("clear all confirms every directory and count, then clears everything", async () => {
		await seed();
		await host.command("history", "clear all");

		const { message } = host.ui.confirms[0] ?? { message: "" };
		assert.match(message, /3 prompts/);
		assert.match(message, /all directories/);
		assert.deepEqual(await storedIds(), []);
		assert.match(host.notices.at(-1)?.message ?? "", /Cleared 3 prompts/);
	});

	test("cancelling the confirmation leaves every record", async () => {
		await seed();
		host.ui.confirmAnswer = false;
		await host.command("history", "clear all");

		assert.equal(host.ui.confirms.length, 1);
		assert.equal((await storedIds()).length, 3);
		assert.ok(!host.notices.some((n) => /Cleared/.test(n.message)));
	});

	test("an empty scope says so without asking", async () => {
		await host.command("history", "clear cwd");

		assert.deepEqual(host.ui.confirms, []);
		assert.match(host.notices.at(-1)?.message ?? "", /nothing to clear/i);
	});

	test("clears and reports what is in scope when it runs, not when confirmed", async () => {
		await seed();
		host.ui.whileConfirming = () =>
			appendFile(store.historyFile, line("typed-meanwhile"));
		await host.command("history", "clear cwd");

		assert.match(host.ui.confirms[0]?.message ?? "", /2 prompts/);
		assert.deepEqual(await storedIds(), ["elsewhere"]);
		assert.match(host.notices.at(-1)?.message ?? "", /Cleared 3 prompts/);
	});

	test("a failed rewrite warns without claiming success or touching the draft", {
		skip: skipPermissionTests,
	}, async () => {
		await seed();
		host.ui.draft = "my draft";
		host.ui.whileConfirming = () => chmod(dirname(store.historyFile), 0o500);
		await host.command("history", "clear all");

		const notice = host.notices.at(-1);
		assert.equal(notice?.type, "warning");
		assert.match(notice?.message ?? "", /EACCES/);
		assert.ok(notice?.message.includes(store.historyFile));
		assert.ok(!host.notices.some((n) => /Cleared/.test(n.message)));
		assert.equal(host.ui.draft, "my draft");
		assert.equal((await storedIds()).length, 3);

		// Prompting still records afterwards.
		await chmod(dirname(store.historyFile), 0o700);
		await host.input({ text: "still recording" });
		await host.shutdown();
		assert.equal((await storedIds()).length, 4);
	});

	test("an unreadable file warns and clears nothing", {
		skip: skipPermissionTests,
	}, async () => {
		await seed();
		await chmod(store.historyFile, 0o200);
		try {
			await host.command("history", "clear all");
		} finally {
			await chmod(store.historyFile, 0o600);
		}

		assert.deepEqual(host.ui.confirms, []);
		assert.match(host.notices.at(-1)?.message ?? "", /EACCES/);
		assert.equal((await storedIds()).length, 3);
	});

	test("does nothing outside the TUI", async () => {
		await seed();
		await host.command("history", "clear all", host.context({ mode: "rpc" }));

		assert.deepEqual(host.ui.confirms, []);
		assert.equal((await storedIds()).length, 3);
	});

	test("a session that shut down while confirming clears nothing", async () => {
		await seed();
		host.ui.whileConfirming = () => host.shutdown();
		await host.command("history", "clear all");

		assert.equal((await storedIds()).length, 3);
		assert.ok(!host.notices.some((n) => /Cleared/.test(n.message)));
	});
});
