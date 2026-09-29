import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	type Host,
	keys,
	loadExtension,
	restartProcess,
	useAgentDir,
} from "./harness.ts";

let store: Awaited<ReturnType<typeof useAgentDir>>;
let host: Host;

beforeEach(async () => {
	restartProcess();
	store = await useAgentDir();
	host = loadExtension();
});

afterEach(async () => {
	await host.shutdown();
	await store.cleanup();
	restartProcess();
});

const PAUSED = "history paused";

const status = (on = host) => on.ui.statuses.get("prompt-history");

/** Replaces the runtime as Pi does on reload, new, resume, and fork. */
const replaceRuntime = async (reason: string) => {
	await host.shutdown(reason);
	host = loadExtension();
	await host.fire("session_start", { reason });
};

const texts = async () => (await store.readLines()).map((line) => line.text);

describe("pause and resume", () => {
	test("pause stops recording new prompts until resume", async () => {
		await host.input({ text: "before pause" });
		await host.command("history", "pause");
		await host.input({ text: "while paused" });
		await host.command("history", "resume");
		await host.input({ text: "after resume" });
		await host.shutdown();

		assert.deepEqual(await texts(), ["before pause", "after resume"]);
	});

	test("saved history stays searchable and restorable while paused", async () => {
		await host.input({ text: "saved earlier" });
		await host.command("history", "pause");

		const opened = host.nextPicker();
		const running = host.command("history");
		const picker = await opened;
		await picker.until((screen) => screen.includes("saved earlier"));
		picker.press(keys.enter);
		await running;

		assert.equal(host.ui.draft, "saved earlier");
	});

	test("pause shows a status indicator and resume clears it", async () => {
		assert.equal(status(), undefined);
		await host.command("history", "pause");
		assert.equal(status(), PAUSED);
		await host.command("history", "resume");
		assert.equal(status(), undefined);
	});

	test("repeated commands keep the state and say so", async () => {
		await host.command("history", "pause");
		await host.command("history", "pause");
		assert.equal(status(), PAUSED);
		await host.command("history", "resume");
		await host.command("history", "resume");
		await host.input({ text: "recorded" });
		await host.shutdown();

		assert.deepEqual(
			host.notices.map((notice) => notice.message.split(".")[0]),
			[
				"Prompt history paused",
				"Prompt history is already paused",
				"Prompt history resumed",
				"Prompt history is already recording",
			],
		);
		assert.deepEqual(await texts(), ["recorded"]);
	});

	for (const reason of ["reload", "new", "resume", "fork"])
		test(`pause survives ${reason} with its status restored`, async () => {
			await host.command("history", "pause");
			await replaceRuntime(reason);

			assert.equal(status(), PAUSED);
			await host.input({ text: `after ${reason}` });
			await host.command("history", "resume");
			assert.equal(status(), undefined);
			await host.input({ text: "after resume" });
			await host.shutdown();

			assert.deepEqual(await texts(), ["after resume"]);
		});

	test("a process restart starts recording again with no status", async () => {
		await host.command("history", "pause");
		await host.shutdown("quit");
		restartProcess();
		host = loadExtension();
		await host.fire("session_start", { reason: "startup" });

		assert.equal(status(), undefined);
		await host.input({ text: "after restart" });
		await host.shutdown();
		assert.deepEqual(await texts(), ["after restart"]);
	});

	test("pausing writes nothing to disk", async () => {
		await host.command("history", "pause");
		await host.command("history", "resume");
		await host.shutdown();

		assert.deepEqual(await readdir(store.agentDir), []);
	});

	test("a replaced runtime's commands change nothing", async () => {
		const previous = host;
		await previous.command("history", "pause");
		await replaceRuntime("reload");

		await previous.command("history", "resume");
		assert.equal(status(previous), PAUSED);
		await host.input({ text: "still paused" });
		await host.shutdown();

		assert.deepEqual(await readdir(store.agentDir), []);
	});

	test("an unknown subcommand shows usage and opens nothing", async () => {
		await host.command("history", "stop");

		assert.equal(host.ui.pickers.length, 0);
		assert.equal(status(), undefined);
		assert.deepEqual(host.notices, [
			{
				message: "Usage: /history, /history pause, or /history resume.",
				type: "warning",
			},
		]);
	});
});
