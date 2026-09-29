import { dirname } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveStorePaths } from "./config.ts";
import {
	CompactionError,
	type History,
	MAX_PROMPT_BYTES,
	MAX_RECORDS,
	openHistory,
} from "./history.ts";
import {
	createPicker,
	type PickerDelete,
	type PickerSearch,
} from "./picker.ts";

const WARNING_INTERVAL_MS = 60_000;

/** Each kind of problem is rate-limited on its own. */
type WarningKind =
	| "too-large"
	| "write-failed"
	| "trim-failed"
	| "capture-failed"
	| "config-ignored";

/**
 * Pi keeps a pasted image in the draft as its file path; these are the image
 * types Pi's read tool attaches.
 */
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|bmp)(?=$|[\s'"])/im;

/**
 * Not a documented Pi API: Pi replaces the extension runtime on reload, new,
 * resume, and fork, yet keeps the Node process and its `globalThis`, so state
 * kept here lasts until the process exits. It is never written to disk.
 * `spike/pause.py` must pass on each supported Pi release to keep relying on it.
 */
type ProcessState = { paused: boolean };
const PROCESS_STATE = Symbol.for("pi-prompt-history/process-state");

function processState(): ProcessState {
	const slots = globalThis as Record<symbol, ProcessState | undefined>;
	slots[PROCESS_STATE] ??= { paused: false };
	return slots[PROCESS_STATE];
}

const STATUS_KEY = "prompt-history";
const PAUSED_STATUS = "history paused";
const USAGE =
	"Usage: /history, /history pause, /history resume, /history clear cwd, or /history clear all.";

/**
 * Pi runs this factory once per session runtime: at startup and again after
 * every reload, new, resume, and fork. Each run owns its own store handle and
 * closes it on shutdown, so only the live runtime captures or restores.
 */
export default function promptHistory(pi: ExtensionAPI): void {
	// Opened with the paths it writes to, so warnings name the file actually used.
	let store: { history: History; historyFile: string } | undefined;
	let live = true;
	let pickerOpen = false;
	// Captures still writing; shutdown lets them settle so their warnings reach
	// the context that is still live, and nothing touches it afterwards.
	const inFlight = new Set<Promise<void>>();
	const lastWarning = new Map<WarningKind, number>();
	let warnedMalformed = false;
	const state = processState();

	// Warnings name the problem and the fix, never the prompt text.
	const warn = (ctx: ExtensionContext, kind: WarningKind, message: string) => {
		const now = Date.now();
		const last = lastWarning.get(kind);
		if (last !== undefined && now - last < WARNING_INTERVAL_MS) return;
		lastWarning.set(kind, now);
		try {
			ctx.ui.notify(message, "warning");
		} catch {
			// Reporting is best effort too; a capture must never reject.
		}
	};

	// Best effort, like warnings: failing to show feedback never undoes a state
	// change that already took effect or fails a search.
	const tryUI = (show: () => void) => {
		try {
			show();
		} catch {}
	};

	const openStore = () => {
		if (!store) {
			const paths = resolveStorePaths();
			store = { history: openHistory(paths), historyFile: paths.historyFile };
		}
		return store;
	};

	const capture = (text: string, ctx: ExtensionContext) => {
		const { history, historyFile } = openStore();
		const settled = history
			.record({
				text,
				cwd: ctx.cwd,
				session: ctx.sessionManager.getSessionId(),
			})
			.then(
				(outcome) => {
					if (outcome === "too-large")
						warn(
							ctx,
							"too-large",
							`Prompt history skipped a prompt over ${MAX_PROMPT_BYTES} bytes; it was not saved. Prompting is unaffected.`,
						);
				},
				(error: unknown) =>
					error instanceof CompactionError
						? warn(
								ctx,
								"trim-failed",
								`Prompt history saved the prompt but could not trim ${historyFile} to the newest ${MAX_RECORDS} (${errorCode(error)}). Check that the file is readable and ${dirname(historyFile)} is writable; the file was not changed. Prompting is unaffected.`,
							)
						: warn(
								ctx,
								"write-failed",
								`Prompt history could not save to ${historyFile} (${errorCode(error)}). Check that the file and its directory are writable. Prompting is unaffected.`,
							),
			);
		inFlight.add(settled);
		void settled.finally(() => inFlight.delete(settled));
	};

	pi.on("input", (event, ctx) => {
		// Capture is best effort: nothing it does may hold up or block the prompt.
		try {
			if (live && !state.paused && isEligible(event, ctx))
				capture(event.text, ctx);
		} catch (error) {
			warn(
				ctx,
				"capture-failed",
				`Prompt history could not save this prompt (${errorCode(error)}). Prompting is unaffected.`,
			);
		}
		return { action: "continue" };
	});

	// The store rereads a changed file before every search and rejects rather
	// than answering from cache, so the picker never shows stale records.
	const searchFor =
		(ctx: ExtensionContext): PickerSearch =>
		async ({ query, cwd }) => {
			let historyFile = "prompt history";
			try {
				const opened = openStore();
				historyFile = opened.historyFile;
				const { records, capped, malformed } = await opened.history.search({
					query,
					cwd,
				});
				if (malformed > 0 && !warnedMalformed && live) {
					warnedMalformed = true;
					tryUI(() =>
						ctx.ui.notify(
							`Prompt history skipped ${malformed} unreadable lines in ${historyFile}; the other prompts are still searchable. Reading leaves the file unchanged.`,
							"warning",
						),
					);
				}
				return { kind: "records", records, capped };
			} catch (error) {
				return {
					kind: "unavailable",
					guidance: `Could not read ${historyFile} (${errorCode(error)}). Check that the file is readable, then run /history again. It has not been changed.`,
				};
			}
		};

	const deleteRecord: PickerDelete = async (record) => {
		if (!live)
			return {
				kind: "failed",
				guidance: "This session has ended; nothing was deleted.",
			};
		let historyFile = "prompt history";
		try {
			const opened = openStore();
			historyFile = opened.historyFile;
			// A record another process already removed counts as deleted.
			await opened.history.delete(record.id);
			return { kind: "deleted" };
		} catch (error) {
			return {
				kind: "failed",
				guidance: `Could not delete from ${historyFile} (${errorCode(error)}). Check that the file is readable and ${dirname(historyFile)} is writable; nothing was deleted.`,
			};
		}
	};

	const recall = async (ctx: ExtensionContext) => {
		const search = searchFor(ctx);
		const initial = await search({ query: "", cwd: ctx.cwd });
		if (!live) return;
		const text = await ctx.ui.custom<string | undefined>(
			(tui, theme, keybindings, done) =>
				createPicker({
					cwd: ctx.cwd,
					initial,
					search,
					delete: deleteRecord,
					theme,
					keybindings,
					requestRender: () => tui.requestRender(),
					done,
				}),
		);
		// A selection from a session that has since shut down is dropped.
		if (!live || text === undefined) return;
		if (
			IMAGE_PATH.test(ctx.ui.getEditorText()) &&
			!(await ctx.ui.confirm(
				"Replace draft?",
				"Your draft contains an image. Restoring this prompt replaces the whole draft, including the image.",
			))
		)
			return;
		if (live) ctx.ui.setEditorText(text);
	};

	const openPicker = async (ctx: ExtensionContext) => {
		if (!live || ctx.mode !== "tui" || pickerOpen) return;
		pickerOpen = true;
		try {
			await recall(ctx);
		} finally {
			pickerOpen = false;
		}
	};

	// Every new runtime restores the indicator, so a pause is never out of sight.
	const showPauseStatus = (ctx: ExtensionContext) =>
		tryUI(() =>
			ctx.ui.setStatus(STATUS_KEY, state.paused ? PAUSED_STATUS : undefined),
		);

	const setPaused = (paused: boolean, ctx: ExtensionContext) => {
		if (!live) return;
		const changed = state.paused !== paused;
		state.paused = paused;
		showPauseStatus(ctx);
		const message = paused
			? `Prompt history ${changed ? "paused" : "is already paused"}. New prompts are not recorded until /history resume or Pi restarts. Saved history stays searchable.`
			: `Prompt history ${changed ? "resumed" : "is already recording"}. New prompts are recorded.`;
		tryUI(() => ctx.ui.notify(message, "info"));
	};

	/**
	 * Confirms with the count in scope now, then clears whatever is in scope
	 * when the rewrite runs, so the reported count can differ from the
	 * confirmed one when other processes record in between.
	 */
	const clear = async (cwd: string | undefined, ctx: ExtensionContext) => {
		if (!live || ctx.mode !== "tui") return;
		const scope = cwd === undefined ? "all directories" : cwd;
		let historyFile = "prompt history";
		try {
			const opened = openStore();
			historyFile = opened.historyFile;
			const { total } = await opened.history.search({ query: "", cwd });
			if (!live) return;
			if (total === 0) {
				tryUI(() =>
					ctx.ui.notify(
						`No prompts recorded in ${scope}; nothing to clear.`,
						"info",
					),
				);
				return;
			}
			const confirmed = await ctx.ui.confirm(
				"Clear prompt history?",
				`Delete ${plural(total)} recorded in ${scope} from ${historyFile}? Prompts recorded meanwhile are cleared too. This cannot be undone, and Pi's session files are not changed.`,
			);
			if (!confirmed || !live) return;
			const removed = await opened.history.clear({ cwd });
			if (live)
				tryUI(() =>
					ctx.ui.notify(`Cleared ${plural(removed)} from ${scope}.`, "info"),
				);
		} catch (error) {
			if (live)
				tryUI(() =>
					ctx.ui.notify(
						`Prompt history could not clear ${historyFile} (${errorCode(error)}). Check that the file is readable and ${dirname(historyFile)} is writable; nothing was cleared. Prompting is unaffected.`,
						"warning",
					),
				);
		}
	};

	pi.registerCommand("history", {
		description:
			"Search recorded prompts and restore one into the editor; pause or resume recording; clear cwd or all history",
		handler: async (args, ctx) => {
			const action = args.trim().split(/\s+/).join(" ");
			if (action === "") return openPicker(ctx);
			if (action === "pause" || action === "resume")
				return setPaused(action === "pause", ctx);
			if (action === "clear cwd") return clear(ctx.cwd, ctx);
			if (action === "clear all") return clear(undefined, ctx);
			if (live) tryUI(() => ctx.ui.notify(USAGE, "warning"));
		},
	});

	pi.on("session_start", (_event, ctx) => showPauseStatus(ctx));

	// Read once per runtime, so an edited config applies on /reload or restart
	// and never rebinds a running one.
	const config = loadConfig();
	pi.registerShortcut(config.shortcut, {
		description: "Search recorded prompts",
		handler: openPicker,
	});

	if (config.problem) {
		const message = `Prompt history config ${config.configFile} ${config.problem}. Using ${config.shortcut}; /history still works. Fix the file, then run /reload.`;
		// The shortcut exists only in the TUI, so other modes are not told.
		pi.on("session_start", (_event, ctx) => {
			if (ctx.mode === "tui") warn(ctx, "config-ignored", message);
		});
	}

	pi.on("session_shutdown", async () => {
		live = false;
		await Promise.all(inFlight);
		await store?.history.close();
	});
}

/**
 * Typed prompts in a persisted TUI session. Extension- and RPC-origin input,
 * non-TUI modes, and ephemeral sessions (no session file) are never recorded.
 * Only text is stored; attached images are ignored.
 */
function isEligible(event: InputEvent, ctx: ExtensionContext): boolean {
	return (
		event.source === "interactive" &&
		ctx.mode === "tui" &&
		!!ctx.sessionManager.getSessionFile() &&
		event.text.trim() !== ""
	);
}

function plural(count: number): string {
	return `${count} ${count === 1 ? "prompt" : "prompts"}`;
}

/** An error's code, or a fixed label; never its message, which may quote input. */
function errorCode(error: unknown): string {
	return (
		(error as NodeJS.ErrnoException | undefined)?.code ?? "unexpected error"
	);
}
