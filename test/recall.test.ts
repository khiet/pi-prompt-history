import assert from "node:assert/strict";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	type Host,
	keys,
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
	await chmod(store.historyFile, 0o600).catch(() => {});
	await host.shutdown();
	await store.cleanup();
});

type Seed = { text: string; ts: number; id?: string; cwd?: string };

/** Writes records as an earlier runtime would have left them. */
const seed = async (records: Seed[]) => {
	await mkdir(dirname(store.historyFile), { recursive: true });
	const lines = records.map(({ text, ts, id, cwd }) =>
		JSON.stringify({
			v: 1,
			id: id ?? `id-${ts}`,
			text,
			cwd: cwd ?? "/work/project",
			session: "earlier",
			ts,
		}),
	);
	await writeFile(store.historyFile, `${lines.join("\n")}\n`);
};

/** Runs /history and hands back the picker it opens plus the settling command. */
const openHistory = async (ctx = host.context()) => {
	const opened = host.nextPicker();
	const running = host.command("history", "", ctx);
	return { picker: await opened, running };
};

const screen = (lines: string[]) => lines.join("\n");

describe("/history picker", () => {
	test("opens on recent prompts from the current directory, newest first", async () => {
		await seed([
			{ text: "oldest here", ts: 1 },
			{ text: "elsewhere", ts: 5, cwd: "/work/other" },
			{ text: "tie low id", ts: 3, id: "a" },
			{ text: "tie high id", ts: 3, id: "b" },
			{ text: "newest here", ts: 4 },
		]);
		const { picker, running } = await openHistory();

		const shown = screen(picker.render());
		const order = ["newest here", "tie high id", "tie low id", "oldest here"];
		const positions = order.map((text) => shown.indexOf(text));
		assert.ok(
			positions.every((position) => position >= 0),
			shown,
		);
		assert.deepEqual(
			positions,
			[...positions].sort((a, b) => a - b),
		);
		assert.ok(!shown.includes("elsewhere"));

		picker.press(keys.escape);
		await running;
	});

	test("offers only the newest 100 prompts", async () => {
		await seed(
			Array.from({ length: 101 }, (_, i) => ({
				text: `prompt number ${i}`,
				ts: i,
			})),
		);
		const { picker, running } = await openHistory();

		// Up from the first entry wraps to the last one offered.
		picker.press(keys.up, keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["prompt number 1"]);
	});

	test("Enter restores the complete stored text without submitting it", async () => {
		const stored = "  first line\ttabbed\r\nsecond line café 日本語 👋  ";
		await seed([
			{ text: stored, ts: 2 },
			{ text: "newer", ts: 3 },
		]);
		host.ui.draft = "work in progress";
		const { picker, running } = await openHistory();

		picker.press(keys.down, keys.enter);
		await running;

		// Stored text goes to the editor unnormalized; Pi's editor then turns
		// tabs into spaces and CR/CRLF into LF.
		assert.deepEqual(host.ui.editorWrites, [stored]);
		assert.ok(!host.registrations.includes("sendUserMessage"));
		await host.shutdown();
		assert.equal((await store.readLines()).length, 2);
	});

	test("Escape leaves the draft unchanged", async () => {
		await seed([{ text: "old prompt", ts: 1 }]);
		host.ui.draft = "draft with /tmp/pi-clipboard-1.png";
		const { picker, running } = await openHistory();

		picker.press(keys.down, keys.escape);
		await running;

		assert.deepEqual(host.ui.editorWrites, []);
		assert.equal(host.ui.draft, "draft with /tmp/pi-clipboard-1.png");
		assert.deepEqual(host.ui.confirms, []);
	});

	test("typing narrows the list to prompts containing the query", async () => {
		await seed([
			{ text: "Explain this DIFF", ts: 1 },
			{ text: "write tests", ts: 2 },
		]);
		const { picker, running } = await openHistory();

		picker.press(..."diff");
		assert.ok(!screen(picker.render()).includes("write tests"));
		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["Explain this DIFF"]);
	});

	test("a query with no matches says so and restores nothing", async () => {
		await seed([{ text: "write tests", ts: 1 }]);
		const { picker, running } = await openHistory();

		picker.press(..."zzz");
		assert.match(screen(picker.render()), /no prompts match/i);
		picker.press(keys.enter, keys.escape);
		await running;

		assert.deepEqual(host.ui.editorWrites, []);
	});
});

describe("replacing a draft that contains an image", () => {
	for (const draft of [
		"compare with /tmp/pi-clipboard-0f3a.png please",
		"'/Users/me/Screen Shot.JPEG'",
		"/tmp/a.webp\nand /tmp/b.gif",
	])
		test(`warns before replacing ${JSON.stringify(draft)}`, async () => {
			await seed([{ text: "old prompt", ts: 1 }]);
			host.ui.draft = draft;
			host.ui.confirmAnswer = false;
			const { picker, running } = await openHistory();

			picker.press(keys.enter);
			await running;

			assert.equal(host.ui.confirms.length, 1);
			assert.match(host.ui.confirms[0]?.message ?? "", /image/i);
			assert.deepEqual(host.ui.editorWrites, []);
			assert.equal(host.ui.draft, draft);
		});

	test("replaces the whole draft once the warning is accepted", async () => {
		await seed([{ text: "old prompt", ts: 1 }]);
		host.ui.draft = "see /tmp/pi-clipboard-1.png";
		const { picker, running } = await openHistory();

		picker.press(keys.enter);
		await running;

		assert.equal(host.ui.confirms.length, 1);
		assert.deepEqual(host.ui.editorWrites, ["old prompt"]);
	});

	test("does not warn for a draft without an image", async () => {
		await seed([{ text: "old prompt", ts: 1 }]);
		host.ui.draft = "mention image.png.bak and pngs";
		const { picker, running } = await openHistory();

		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.confirms, []);
		assert.deepEqual(host.ui.editorWrites, ["old prompt"]);
	});
});

describe("picker states and display", () => {
	test("shows an empty state without creating the history file", async () => {
		const { picker, running } = await openHistory();

		assert.match(screen(picker.render()), /no prompts .*this directory/i);
		picker.press(keys.enter, keys.escape);
		await running;

		assert.deepEqual(host.ui.editorWrites, []);
		await assert.rejects(stat(dirname(store.historyFile)));
	});

	test("shows an unavailable state rather than earlier records", {
		skip: skipPermissionTests,
	}, async () => {
		await seed([{ text: "secret prompt", ts: 1 }]);
		const first = await openHistory();
		assert.ok(screen(first.picker.render()).includes("secret prompt"));
		first.picker.press(keys.escape);
		await first.running;

		await chmod(store.historyFile, 0o000);
		const { picker, running } = await openHistory();
		const shown = screen(picker.render(200));

		assert.match(shown, /unavailable/i);
		assert.ok(shown.includes(store.historyFile));
		assert.ok(shown.includes("EACCES"));
		assert.ok(!shown.includes("secret prompt"));
		picker.press(keys.enter, keys.escape);
		await running;

		assert.deepEqual(host.ui.editorWrites, []);
		assert.equal((await stat(store.historyFile)).size > 0, true);
	});

	test("renders terminal controls as safe text but restores them intact", async () => {
		const stored = "\x1b[2J\x1b]0;title\x07red\x9b31m\x7f";
		await seed([{ text: stored, ts: 1 }]);
		const { picker, running } = await openHistory();

		// The query field draws its own cursor with escapes, so check the entry.
		const entry = picker.render().find((line) => line.includes("red"));
		assert.ok(entry);
		const isControl = (char: string) =>
			char < " " || (char >= "\x7f" && char <= "\x9f");
		assert.ok(![...entry].some(isControl), entry);
		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, [stored]);
	});

	test("keeps every line within narrow terminal widths", async () => {
		await seed([
			{ text: "a long prompt that will not fit ".repeat(4), ts: 1 },
			{ text: "日本語のとても長いプロンプト👋👋👋", ts: 2 },
		]);
		const { picker, running } = await openHistory();

		for (const width of [80, 24, 10, 3])
			for (const line of picker.render(width))
				assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		picker.press(keys.escape);
		await running;
	});
});

describe("/history lifecycle guards", () => {
	test("does nothing outside the TUI", async () => {
		await seed([{ text: "old prompt", ts: 1 }]);
		await host.command("history", "", host.context({ mode: "rpc" }));

		assert.equal(host.ui.pickers.length, 0);
		assert.deepEqual(host.ui.editorWrites, []);
	});

	test("does not open a second picker over an open one", async () => {
		await seed([{ text: "old prompt", ts: 1 }]);
		const { picker, running } = await openHistory();

		await host.command("history");
		assert.equal(host.ui.pickers.length, 1);

		picker.press(keys.escape);
		await running;
		const reopened = await openHistory();
		reopened.picker.press(keys.escape);
		await reopened.running;
		assert.equal(host.ui.pickers.length, 2);
	});

	test("ignores a selection that arrives after the session shut down", async () => {
		await seed([{ text: "old prompt", ts: 1 }]);
		const { picker, running } = await openHistory();

		await host.shutdown();
		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, []);
	});

	test("does not open when the session shuts down while history loads", async () => {
		await seed([{ text: "old prompt", ts: 1 }]);
		const running = host.command("history");
		await host.shutdown();
		await running;

		assert.equal(host.ui.pickers.length, 0);
	});

	test("recalls prompts captured earlier in the same runtime", async () => {
		await host.input({ text: "just typed" });
		const { picker, running } = await openHistory();

		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["just typed"]);
	});
});
