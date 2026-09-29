import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
} from "@earendil-works/pi-coding-agent";
import { resolveStorePaths } from "./config.ts";
import { type History, MAX_PROMPT_BYTES, openHistory } from "./history.ts";

const WARNING_INTERVAL_MS = 60_000;

/** Each kind of problem is rate-limited on its own. */
type WarningKind = "too-large" | "write-failed" | "capture-failed";

/**
 * Pi runs this factory once per session runtime: at startup and again after
 * every reload, new, resume, and fork. Each run owns its own store handle and
 * closes it on shutdown, so only the live runtime captures.
 */
export default function promptHistory(pi: ExtensionAPI): void {
	// Opened with the paths it writes to, so warnings name the file actually used.
	let store: { history: History; historyFile: string } | undefined;
	let accepting = true;
	// Captures still writing; shutdown lets them settle so their warnings reach
	// the context that is still live, and nothing touches it afterwards.
	const inFlight = new Set<Promise<void>>();
	const lastWarning = new Map<WarningKind, number>();

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

	const capture = (text: string, ctx: ExtensionContext) => {
		if (!store) {
			const paths = resolveStorePaths();
			store = { history: openHistory(paths), historyFile: paths.historyFile };
		}
		const { historyFile } = store;
		const settled = store.history
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
					warn(
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
			if (accepting && isEligible(event, ctx)) capture(event.text, ctx);
		} catch (error) {
			warn(
				ctx,
				"capture-failed",
				`Prompt history could not save this prompt (${errorCode(error)}). Prompting is unaffected.`,
			);
		}
		return { action: "continue" };
	});

	pi.on("session_shutdown", async () => {
		accepting = false;
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

/** An error's code, or a fixed label; never its message, which may quote input. */
function errorCode(error: unknown): string {
	return (
		(error as NodeJS.ErrnoException | undefined)?.code ?? "unexpected error"
	);
}
