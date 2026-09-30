import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, stat, writeFile } from "node:fs/promises";
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
		await picker.until((shown) => !shown.includes("write tests"));
		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["Explain this DIFF"]);
	});

	test("a query with no matches says so and restores nothing", async () => {
		await seed([{ text: "write tests", ts: 1 }]);
		const { picker, running } = await openHistory();

		picker.press(..."zzz");
		await picker.until((shown) => /no prompts match/i.test(shown));
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

		// The query field draws its own cursor with escapes, so check the list
		// row and the preview.
		const shown = picker.render().filter((line) => line.includes("red"));
		assert.equal(shown.length, 2, shown.join("\n"));
		const isControl = (char: string) =>
			char < " " || (char >= "\x7f" && char <= "\x9f");
		for (const line of shown) assert.ok(![...line].some(isControl), line);
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

describe("/history arguments", () => {
	for (const args of ["stop", "pause", "resume"])
		test(`"/history ${args}" shows usage and opens nothing`, async () => {
			await host.command("history", args);

			assert.equal(host.ui.pickers.length, 0);
			assert.deepEqual(host.notices, [
				{
					message:
						"Usage: /history, /history clear cwd, or /history clear all.",
					type: "warning",
				},
			]);
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

describe("searching history", () => {
	test("finds a match older than the first 100 prompts", async () => {
		await seed([
			{ text: "the old needle", ts: 0 },
			...Array.from({ length: 150 }, (_, i) => ({
				text: `recent ${i}`,
				ts: i + 1,
			})),
		]);
		const { picker, running } = await openHistory();
		assert.ok(!screen(picker.render()).includes("old needle"));

		picker.press(..."NEEDLE", keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["the old needle"]);
	});

	test("says when matches are capped and stops saying so once refined", async () => {
		await seed(
			Array.from({ length: 101 }, (_, i) => ({
				text: i === 0 ? "oldest prompt" : `prompt ${i}`,
				ts: i,
			})),
		);
		const { picker, running } = await openHistory();
		assert.match(screen(picker.render()), /newest 100/i);

		picker.press(..."oldest");
		const refined = await picker.until((shown) => !/newest 100/i.test(shown));
		assert.ok(refined.includes("oldest prompt"));
		picker.press(keys.escape);
		await running;
	});

	test("matches punctuation literally", async () => {
		await seed([
			{ text: "run a.*b please", ts: 1 },
			{ text: "run axxb please", ts: 2 },
		]);
		const { picker, running } = await openHistory();

		picker.press(..."a.*b");
		await picker.until((shown) => !shown.includes("axxb"));
		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["run a.*b please"]);
	});

	test("matches Unicode case-insensitively", async () => {
		await seed([
			{ text: "CAFÉ 日本語", ts: 1 },
			{ text: "plain", ts: 2 },
		]);
		const { picker, running } = await openHistory();

		picker.press(..."café 日本");
		await picker.until((shown) => !shown.includes("plain"));
		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["CAFÉ 日本語"]);
	});

	test("Tab switches between this directory and all directories", async () => {
		await seed([
			{ text: "prompt here", ts: 1 },
			{ text: "prompt elsewhere", ts: 2, cwd: "/work/other" },
		]);
		const { picker, running } = await openHistory();
		assert.match(screen(picker.render()), /this directory/i);

		picker.press(keys.tab);
		const all = await picker.until((shown) =>
			shown.includes("prompt elsewhere"),
		);
		assert.match(all, /all directories/i);
		assert.ok(all.includes("/work/other"), all);
		assert.ok(all.includes("/work/project"), all);

		picker.press(keys.tab);
		const back = await picker.until(
			(shown) => !shown.includes("prompt elsewhere"),
		);
		assert.ok(!back.includes("/work/project"), back);
		picker.press(keys.escape);
		await running;
	});

	test("keeps the query when switching scope", async () => {
		await seed([
			{ text: "deploy here", ts: 1 },
			{ text: "deploy elsewhere", ts: 2, cwd: "/work/other" },
			{ text: "unrelated elsewhere", ts: 3, cwd: "/work/other" },
		]);
		const { picker, running } = await openHistory();

		picker.press(..."deploy", keys.tab);
		const shown = await picker.until((s) => s.includes("deploy elsewhere"));
		assert.ok(!shown.includes("unrelated"));
		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["deploy elsewhere"]);
	});

	test("the footer shows the scope-toggle control", async () => {
		await seed([{ text: "old prompt", ts: 1 }]);
		const { picker, running } = await openHistory();

		assert.match(screen(picker.render()).split("\n").at(-1) ?? "", /tab/i);
		picker.press(keys.escape);
		await running;
	});

	test("every opening starts with an empty query in this directory", async () => {
		await seed([
			{ text: "prompt here", ts: 1 },
			{ text: "prompt elsewhere", ts: 2, cwd: "/work/other" },
		]);
		host.ui.draft = "elsewhere";
		const first = await openHistory();
		assert.ok(screen(first.picker.render()).includes("prompt here"));
		first.picker.press(..."else", keys.tab);
		await first.picker.until((shown) => shown.includes("prompt elsewhere"));
		first.picker.press(keys.escape);
		await first.running;

		const { picker, running } = await openHistory();
		const shown = screen(picker.render());
		assert.match(shown, /this directory/i);
		assert.ok(shown.includes("prompt here"), shown);
		assert.ok(!shown.includes("prompt elsewhere"), shown);
		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["prompt here"]);
	});

	test("scopes by the exact cwd string", async () => {
		await seed([
			{ text: "in subdirectory", ts: 1, cwd: "/work/project/sub" },
			{ text: "with trailing slash", ts: 2, cwd: "/work/project/" },
		]);
		const { picker, running } = await openHistory();

		assert.match(screen(picker.render()), /no prompts .*this directory/i);
		picker.press(keys.escape);
		await running;
	});

	test("says no prompts are recorded anywhere when all history is empty", async () => {
		const { picker, running } = await openHistory();

		picker.press(keys.tab);
		const shown = await picker.until((s) => /all directories/i.test(s));
		assert.match(shown, /no prompts recorded yet/i);
		assert.doesNotMatch(shown, /no prompts match/i);
		picker.press(keys.escape);
		await running;
	});

	test("shows unavailable rather than earlier results when a search fails", {
		skip: skipPermissionTests,
	}, async () => {
		await seed([{ text: "secret prompt", ts: 1 }]);
		const { picker, running } = await openHistory();

		await chmod(store.historyFile, 0o000);
		picker.press("s");
		const shown = await picker.until((s) => /unavailable/i.test(s), 200);
		assert.ok(!shown.includes("secret prompt"), shown);
		picker.press(keys.enter, keys.escape);
		await running;

		assert.deepEqual(host.ui.editorWrites, []);
	});
});

describe("history shared with other writers", () => {
	test("recovers once the file is readable again", {
		skip: skipPermissionTests,
	}, async () => {
		await seed([{ text: "kept prompt", ts: 1 }]);
		const loaded = await openHistory();
		loaded.picker.press(keys.escape);
		await loaded.running;
		await chmod(store.historyFile, 0o000);
		const first = await openHistory();
		assert.match(screen(first.picker.render(200)), /unavailable/i);
		first.picker.press(keys.escape);
		await first.running;

		await chmod(store.historyFile, 0o600);
		const { picker, running } = await openHistory();
		assert.ok(screen(picker.render()).includes("kept prompt"));
		picker.press(keys.escape);
		await running;
	});

	test("shows prompts another process appended while the picker is open", async () => {
		await seed([{ text: "first prompt", ts: 1 }]);
		const { picker, running } = await openHistory();
		await appendFile(
			store.historyFile,
			`${JSON.stringify({ v: 1, id: "x", text: "appended elsewhere", cwd: "/work/project", session: "other", ts: 2 })}\n`,
		);
		picker.press("p");
		await picker.until((shown) => shown.includes("appended elsewhere"));
		picker.press(keys.escape);
		await running;
	});

	test("warns once per session about unreadable lines, without their content", async () => {
		await seed([{ text: "good prompt", ts: 1 }]);
		await appendFile(store.historyFile, "secret torn line\n[]\n");

		const first = await openHistory();
		assert.ok(screen(first.picker.render()).includes("good prompt"));
		first.picker.press("g");
		await first.picker.until((shown) => shown.includes("good prompt"));
		first.picker.press(keys.escape);
		await first.running;
		const second = await openHistory();
		second.picker.press(keys.escape);
		await second.running;

		assert.equal(host.notices.length, 1);
		const { message, type } = host.notices[0] ?? {};
		assert.equal(type, "warning");
		assert.match(message ?? "", /skipped 2 unreadable lines/i);
		assert.ok(message?.includes(store.historyFile));
		assert.ok(!message?.includes("secret"));

		await host.shutdown();
		host = loadExtension();
		const later = await openHistory();
		later.picker.press(keys.escape);
		await later.running;
		assert.equal(host.notices.length, 1, "a new session warns again");
	});
});

describe("selection", () => {
	test("Up and Down move the selection that Enter restores", async () => {
		await seed([
			{ text: "first", ts: 3 },
			{ text: "second", ts: 2 },
			{ text: "third", ts: 1 },
		]);
		const { picker, running } = await openHistory();

		picker.press(keys.down, keys.down, keys.up, keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["second"]);
	});

	test("a repeated prompt is one row", async () => {
		await seed([
			{ text: "older", ts: 1 },
			{ text: "repeated", ts: 2 },
			{ text: "repeated", ts: 3 },
		]);
		const { picker, running } = await openHistory();

		picker.press(keys.down, keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["older"]);
	});

	test("filtering moves the selection to the newest match", async () => {
		await seed([
			{ text: "alpha one", ts: 3 },
			{ text: "beta", ts: 2 },
			{ text: "alpha two", ts: 1 },
		]);
		const { picker, running } = await openHistory();

		// Select "beta", then filter it out.
		picker.press(keys.down, ..."alpha");
		await picker.until((shown) => !shown.includes("beta"));
		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["alpha one"]);
	});

	test("switching scope moves the selection into the new results", async () => {
		await seed([
			{ text: "here newer", ts: 3 },
			{ text: "here older", ts: 1 },
			{ text: "elsewhere", ts: 2, cwd: "/work/other" },
		]);
		const { picker, running } = await openHistory();

		picker.press(keys.down, keys.tab);
		await picker.until((shown) => shown.includes("elsewhere"));
		picker.press(keys.down, keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["elsewhere"]);
	});

	test("Enter pressed while a search is running restores its newest match", async () => {
		await seed([
			{ text: "newest", ts: 2 },
			{ text: "wanted", ts: 1 },
		]);
		const { picker, running } = await openHistory();

		picker.press(..."want", keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["wanted"]);
	});
});

describe("Enter during a search", () => {
	test("typing after a pending Enter cancels it", async () => {
		await seed([
			{ text: "want that", ts: 3 },
			{ text: "want this", ts: 2 },
			{ text: "other", ts: 1 },
		]);
		const { picker, running } = await openHistory();

		picker.press(..."want", keys.enter, ..." th");
		await picker.until((shown) => !shown.includes("other"));
		picker.press(keys.escape);
		await running;

		assert.deepEqual(host.ui.editorWrites, []);
	});
});

describe("previews and metadata", () => {
	const utc = (iso: string) => Date.parse(`${iso}Z`);
	let previousTz: string | undefined;
	beforeEach(() => {
		previousTz = process.env.TZ;
		process.env.TZ = "UTC";
	});
	afterEach(() => {
		if (previousTz === undefined) delete process.env.TZ;
		else process.env.TZ = previousTz;
	});

	test("previews every line of the selected multiline prompt", async () => {
		await seed([
			{ text: "one line", ts: 2 },
			{ text: "Refactor:\n- step one\n\tstep two", ts: 1 },
		]);
		const { picker, running } = await openHistory();
		// The list row flattens the prompt; only the preview splits it.
		assert.ok(!picker.render().some((line) => line.trim() === "- step one"));

		picker.press(keys.down);
		const lines = picker.render();
		for (const expected of ["Refactor:", "- step one", "step two"])
			assert.ok(
				lines.some((line) => line.trim() === expected),
				lines.join("\n"),
			);
		picker.press(keys.escape);
		await running;
	});

	test("bounds a long preview and says how much is hidden", async () => {
		const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		await seed([{ text, ts: 1 }]);
		const { picker, running } = await openHistory();

		const shown = picker.render();
		assert.ok(shown.length < 30, shown.join("\n"));
		assert.match(shown.join("\n"), /more lines/i);
		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, [text]);
	});

	test("shows local timestamps and hides record and session ids", async () => {
		await seed([
			{ text: "old prompt", ts: utc("2026-03-04T05:06:07"), id: "rec-7f3a" },
		]);
		const { picker, running } = await openHistory();

		const shown = screen(picker.render());
		assert.ok(shown.includes("2026-03-04 05:06"), shown);
		assert.ok(!shown.includes("rec-7f3a"));
		assert.ok(!shown.includes("earlier"), "session id");
		picker.press(keys.escape);
		await running;
	});

	test("keeps all-directory rows and previews within narrow widths", async () => {
		await seed([
			{
				text: "a long prompt that will not fit\n日本語のとても長いプロンプト👋👋",
				ts: 1,
				cwd: "/a/very/long/working/directory/path",
			},
			{ text: "x", ts: 2 },
		]);
		const { picker, running } = await openHistory();
		picker.press(keys.tab);
		await picker.until((shown) => shown.includes("/a/very"), 200);
		picker.press(keys.down);

		for (const width of [120, 41, 40, 24, 10, 3, 1])
			for (const line of picker.render(width))
				assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		picker.press(keys.escape);
		await running;
	});
});
