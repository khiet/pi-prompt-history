import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type Host, keys, loadExtension, useAgentDir } from "./harness.ts";

let store: Awaited<ReturnType<typeof useAgentDir>>;
let configFile: string;
const hosts: Host[] = [];

beforeEach(async () => {
	store = await useAgentDir();
	configFile = join(store.agentDir, "prompt-history", "config.json");
});

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.shutdown();
	await store.cleanup();
});

/** Loads a runtime the way Pi does at startup or after /reload. */
const start = async () => {
	const host = loadExtension();
	hosts.push(host);
	await host.fire("session_start", { reason: "startup" });
	return host;
};

const writeConfig = async (content: string) => {
	await mkdir(join(store.agentDir, "prompt-history"), { recursive: true });
	await writeFile(configFile, content);
};

const shortcutsOf = (host: Host) =>
	host.registrations.filter((entry) => entry.startsWith("registerShortcut:"));

/** Presses the shortcut and closes the picker it opens without choosing. */
const openWith = async (host: Host, key: string) => {
	const opened = host.nextPicker();
	const running = host.shortcut(key);
	const picker = await opened;
	picker.press(keys.escape);
	await running;
};

describe("search shortcut", () => {
	test("defaults to ctrl+r without a config file, silently", async () => {
		const host = await start();

		assert.deepEqual(shortcutsOf(host), ["registerShortcut:ctrl+r"]);
		await openWith(host, "ctrl+r");
		assert.equal(host.ui.pickers.length, 1);
		assert.deepEqual(host.notices, []);
	});

	test("uses the configured key instead of ctrl+r", async () => {
		await writeConfig(JSON.stringify({ shortcut: "alt+h" }));
		const host = await start();

		assert.deepEqual(shortcutsOf(host), ["registerShortcut:alt+h"]);
		await openWith(host, "alt+h");
		assert.equal(host.ui.pickers.length, 1);
		assert.deepEqual(host.notices, []);
	});

	test("accepts the documented modifier and key forms", async () => {
		for (const shortcut of [
			"ctrl+shift+h",
			"alt+ctrl+x",
			"super+k",
			"ctrl+1",
			"ctrl+pageUp",
			"alt+/",
			"f5",
			"shift+f5",
		]) {
			await writeConfig(JSON.stringify({ shortcut }));
			const host = await start();
			assert.deepEqual(shortcutsOf(host), [`registerShortcut:${shortcut}`]);
			assert.deepEqual(host.notices, [], shortcut);
		}
	});

	test("does nothing outside the TUI", async () => {
		const host = await start();
		await host.shortcut("ctrl+r", host.context({ mode: "rpc" }));
		assert.equal(host.ui.pickers.length, 0);
	});

	test("opens no second picker while one is open", async () => {
		const host = await start();
		const opened = host.nextPicker();
		const first = host.shortcut("ctrl+r");
		const picker = await opened;
		await host.command("history");
		await host.shortcut("ctrl+r");
		assert.equal(host.ui.pickers.length, 1);
		picker.press(keys.escape);
		await first;
	});
});

describe("invalid settings", () => {
	const invalid: [string, string][] = [
		["malformed JSON", "{ shortcut: alt+h"],
		["a top-level array", '["alt+h"]'],
		["a non-string shortcut", '{"shortcut": 7}'],
		["an unknown modifier", '{"shortcut": "meta+h"}'],
		["an unknown key", '{"shortcut": "ctrl+hh"}'],
		["a repeated modifier", '{"shortcut": "ctrl+ctrl+h"}'],
		["a key that types text", '{"shortcut": "h"}'],
		["a shifted key that types text", '{"shortcut": "shift+h"}'],
		["a bare editing key", '{"shortcut": "enter"}'],
		["an unsupported setting", '{"shortcut": "alt+h", "retention": 10}'],
	];

	for (const [name, content] of invalid) {
		test(`${name} falls back to ctrl+r with one actionable warning`, async () => {
			await writeConfig(content);
			const host = await start();

			assert.deepEqual(shortcutsOf(host), ["registerShortcut:ctrl+r"]);
			assert.equal(host.notices.length, 1);
			const [notice] = host.notices;
			assert.equal(notice?.type, "warning");
			assert.match(notice?.message ?? "", /ctrl\+r/);
			assert.ok(notice?.message.includes(configFile));
			assert.match(notice?.message ?? "", /\/reload/);
			assert.match(notice?.message ?? "", /\/history/);
		});
	}

	test("warns once per runtime", async () => {
		await writeConfig('{"shortcut": 7}');
		const host = await start();
		await host.fire("session_start", { reason: "startup" });
		assert.equal(host.notices.length, 1);
	});
});

describe("unavailable configuration", () => {
	test("keeps prompting and /history working with the default key", async () => {
		// A directory where the file should be fails every read with EISDIR.
		await mkdir(configFile, { recursive: true });
		const host = await start();

		assert.deepEqual(shortcutsOf(host), ["registerShortcut:ctrl+r"]);
		assert.equal(host.notices.length, 1);
		assert.match(host.notices[0]?.message ?? "", /EISDIR/);
		assert.ok(host.notices[0]?.message.includes(configFile));

		assert.deepEqual(await host.input({ text: "private prompt" }), {
			action: "continue",
		});
		await host.shutdown();
		assert.deepEqual(
			(await store.readLines()).map((line) => line.text),
			["private prompt"],
		);

		const next = await start();
		const opened = next.nextPicker();
		const running = next.command("history");
		(await opened).press(keys.escape);
		await running;
		assert.ok(
			next.notices.every(({ message }) => !message.includes("private prompt")),
		);
	});
});

describe("reload", () => {
	test("a new runtime applies the changed key; the running one keeps its own", async () => {
		await writeConfig(JSON.stringify({ shortcut: "alt+h" }));
		const before = await start();

		await writeConfig(JSON.stringify({ shortcut: "ctrl+shift+h" }));
		assert.deepEqual(shortcutsOf(before), ["registerShortcut:alt+h"]);

		await before.shutdown();
		const after = await start();
		assert.deepEqual(shortcutsOf(after), ["registerShortcut:ctrl+shift+h"]);

		// The replaced runtime's shortcut restores nothing.
		await before.shortcut("alt+h");
		assert.equal(before.ui.pickers.length, 0);
	});
});
