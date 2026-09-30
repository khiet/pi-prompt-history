import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
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
	await chmod(dirname(store.historyFile), 0o700).catch(() => {});
	await host.shutdown();
	await store.cleanup();
});

type Seed = { id: string; text: string; ts: number; cwd?: string };

const seed = async (records: Seed[]) => {
	await mkdir(dirname(store.historyFile), { recursive: true });
	await writeFile(
		store.historyFile,
		`${records
			.map(({ id, text, ts, cwd }) =>
				JSON.stringify({
					v: 1,
					id,
					text,
					cwd: cwd ?? "/work/project",
					session: "earlier",
					ts,
				}),
			)
			.join("\n")}\n`,
	);
};

const openHistory = async () => {
	const opened = host.nextPicker();
	const running = host.command("history");
	return { picker: await opened, running };
};

const storedIds = async () => (await store.readLines()).map((r) => r.id);

/** Newest first: c, b, a. */
const threeHere = () =>
	seed([
		{ id: "a", text: "alpha", ts: 1 },
		{ id: "b", text: "bravo", ts: 2 },
		{ id: "c", text: "charlie", ts: 3 },
	]);

describe("picker deletion", () => {
	test("the footer shows the delete and scope controls", async () => {
		await threeHere();
		const { picker, running } = await openHistory();

		const footer = picker.render().at(-1) ?? "";
		assert.match(footer, /ctrl\+d delete/);
		assert.match(footer, /tab all directories/);

		picker.press(keys.escape);
		await running;
	});

	test("Ctrl+D asks first, and any key but y keeps the record", async () => {
		await threeHere();
		const { picker, running } = await openHistory();

		picker.press(keys.ctrlD);
		// One copy needs no count.
		assert.match(picker.render().join("\n"), /Delete this prompt\? y/);
		picker.press("n");
		assert.doesNotMatch(picker.render().join("\n"), /Delete this prompt\?/);
		picker.press(keys.ctrlD, keys.escape);
		assert.doesNotMatch(picker.render().join("\n"), /Delete this prompt\?/);

		// Escape only cancelled the question; the picker is still open.
		picker.press(keys.enter);
		await running;
		assert.deepEqual(host.ui.editorWrites, ["charlie"]);
		assert.deepEqual(await storedIds(), ["a", "b", "c"]);
	});

	test("Ctrl+D waits for a pending search rather than asking about stale results", async () => {
		await threeHere();
		const { picker, running } = await openHistory();

		picker.press(..."alp", keys.ctrlD);
		assert.doesNotMatch(picker.render().join("\n"), /Delete this prompt\?/);
		await picker.until((screen) => !screen.includes("charlie"));
		picker.press(keys.escape);
		await running;
		assert.deepEqual(await storedIds(), ["a", "b", "c"]);
	});

	test("deletes every copy in this directory, keeping other directories' copies", async () => {
		await seed([
			{ id: "old", text: "same", ts: 1 },
			{ id: "there", text: "same", ts: 2, cwd: "/work/other" },
			{ id: "near", text: "same ", ts: 3 },
			{ id: "new", text: "same", ts: 4 },
		]);
		const { picker, running } = await openHistory();

		picker.press(keys.ctrlD);
		assert.match(
			picker.render().join("\n"),
			/Delete this prompt \(2 copies\)\?/,
		);
		picker.press("y");
		await picker.until((screen) => !screen.includes("Deleting"));
		picker.press(keys.escape);
		await running;

		assert.deepEqual(await storedIds(), ["there", "near"]);
	});

	test("in all directories, deletes every copy anywhere", async () => {
		await seed([
			{ id: "old", text: "same", ts: 1 },
			{ id: "there", text: "same", ts: 2, cwd: "/work/other" },
			{ id: "kept", text: "kept", ts: 3 },
		]);
		const { picker, running } = await openHistory();

		picker.press(keys.tab);
		// The newest copy's directory shows once the scope's results arrive.
		await picker.until((screen) => screen.includes("/work/other"));
		picker.press(keys.down, keys.ctrlD);
		assert.match(
			picker.render().join("\n"),
			/Delete this prompt \(2 copies\)\?/,
		);
		picker.press("y");
		await picker.until((screen) => !screen.includes("Deleting"));
		picker.press(keys.escape);
		await running;

		assert.deepEqual(await storedIds(), ["kept"]);
	});

	test("selects the next remaining result after deleting", async () => {
		await threeHere();
		const { picker, running } = await openHistory();

		picker.press(keys.down, keys.ctrlD, "y");
		await picker.until((screen) => !screen.includes("bravo"));
		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["alpha"]);
		assert.deepEqual(await storedIds(), ["a", "c"]);
	});

	test("selects the previous result after deleting the last one", async () => {
		await threeHere();
		const { picker, running } = await openHistory();

		picker.press(keys.up, keys.ctrlD, "y");
		await picker.until((screen) => !screen.includes("alpha"));
		picker.press(keys.enter);
		await running;

		assert.deepEqual(host.ui.editorWrites, ["bravo"]);
	});

	test("keeps the query and scope after deleting", async () => {
		await seed([
			{ id: "a", text: "fix tests", ts: 1, cwd: "/work/other" },
			{ id: "b", text: "fix build", ts: 2, cwd: "/work/other" },
			{ id: "c", text: "write docs", ts: 3 },
		]);
		const { picker, running } = await openHistory();

		picker.press(keys.tab, ..."fix");
		await picker.until((screen) => !screen.includes("write docs"));
		picker.press(keys.ctrlD, "y");
		const screen = await picker.until((s) => !s.includes("fix build"));

		assert.match(screen, /all directories/);
		assert.match(screen, /fix tests/);
		assert.doesNotMatch(screen, /write docs/);
		picker.press(keys.escape);
		await running;
	});

	test("says when nothing is left to match or recorded", async () => {
		await seed([
			{ id: "a", text: "only one", ts: 1 },
			{ id: "b", text: "unrelated", ts: 2 },
		]);
		const { picker, running } = await openHistory();

		picker.press(..."only");
		await picker.until((screen) => !screen.includes("unrelated"));
		picker.press(keys.ctrlD, "y");
		await picker.until((screen) => screen.includes("No prompts match."));
		picker.press(...Array.from({ length: 4 }, () => "\x7f"));
		await picker.until((screen) => screen.includes("unrelated"));
		picker.press(keys.ctrlD, "y");
		await picker.until((screen) =>
			screen.includes("No prompts recorded in this directory yet."),
		);
		// Ctrl+D with nothing selected does nothing.
		picker.press(keys.ctrlD);
		assert.doesNotMatch(picker.render().join("\n"), /Delete this prompt\?/);

		picker.press(keys.escape);
		await running;
		assert.deepEqual(await storedIds(), []);
	});

	test("refills a capped list after deleting", async () => {
		await seed(
			Array.from({ length: 101 }, (_, i) => ({
				id: `id-${String(i).padStart(3, "0")}`,
				text: `prompt number ${i}`,
				ts: i,
			})),
		);
		const { picker, running } = await openHistory();
		assert.match(picker.render().join("\n"), /Showing the newest 100/);

		picker.press(keys.ctrlD, "y");
		const screen = await picker.until(
			(s) => !s.includes("Showing the newest 100") && !s.includes("Deleting"),
		);
		assert.doesNotMatch(screen, /prompt number 100/);

		// The oldest prompt is now offered: up from the top wraps to it.
		picker.press(keys.up, keys.enter);
		await running;
		assert.deepEqual(host.ui.editorWrites, ["prompt number 0"]);
	});

	test("a failed deletion shows guidance and keeps the list", {
		skip: skipPermissionTests,
	}, async () => {
		await threeHere();
		host.ui.draft = "my draft\nsecond line";
		const { picker, running } = await openHistory();
		await chmod(dirname(store.historyFile), 0o500);

		picker.press(keys.ctrlD, "y");
		const screen = await picker.until((s) => s.includes("EACCES"), 400);

		assert.ok(screen.includes(store.historyFile));
		assert.match(screen, /charlie/);
		assert.equal(host.ui.draft, "my draft\nsecond line");
		await chmod(dirname(store.historyFile), 0o700);
		picker.press(keys.escape);
		await running;
		assert.deepEqual(await storedIds(), ["a", "b", "c"]);
		assert.deepEqual(host.ui.editorWrites, []);
	});

	test("a picker whose session shut down deletes nothing", async () => {
		await threeHere();
		const { picker, running } = await openHistory();

		picker.press(keys.ctrlD);
		await host.shutdown();
		picker.press("y");
		await picker.until((screen) => !screen.includes("Deleting"));
		picker.press(keys.enter);
		await running;

		assert.deepEqual(await storedIds(), ["a", "b", "c"]);
		assert.deepEqual(host.ui.editorWrites, []);
	});
});
