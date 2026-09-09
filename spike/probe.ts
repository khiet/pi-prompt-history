// Diagnostic extension: synthetic inputs only. NOT a history implementation.

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, truncateToWidth } from "@earendil-works/pi-tui";

const exactText = "  café 日本語 👋\nsecond line  ";

export default function (pi: ExtensionAPI) {
	const logPath = process.env.SPIKE_LOG;
	const sessionPath = process.env.SPIKE_SESSION;
	if (!logPath || !sessionPath)
		throw new Error("Run only through spike/tui.py");
	const instance = randomUUID();
	let paused = false;
	let closed = false;
	const log = (kind: string, data: object = {}) => {
		appendFileSync(logPath, `${JSON.stringify({ kind, instance, ...data })}\n`);
	};
	pi.on("session_start", (event, ctx) => {
		ctx.ui.setStatus("spike", paused ? "SPIKE PAUSED" : "SPIKE ACTIVE");
		log("start", {
			reason: event.reason,
			paused,
			mode: ctx.mode,
			file: ctx.sessionManager.getSessionFile() ?? null,
			agentDir: getAgentDir(),
		});
	});
	pi.on("session_shutdown", (event) => {
		if (closed) return;
		closed = true;
		log("shutdown", { reason: event.reason });
	});
	pi.on("session_info_changed", () => log("renamed"));
	pi.on("agent_start", () => {
		// Any model turn is a failure of this no-model probe.
		log("unexpected-agent-start");
		throw new Error("Probe must not start an agent turn");
	});
	// Demonstrate ordered transforms; the observer itself always continues.
	pi.on("input", (event) =>
		event.text === "transform-me"
			? { action: "transform", text: "transformed\ttext" }
			: { action: "continue" },
	);
	pi.on("input", (event, ctx) => {
		log("input", {
			text: event.text,
			source: event.source,
			mode: ctx.mode,
			streamingBehavior: event.streamingBehavior ?? null,
			images: event.images?.length ?? 0,
			eligible:
				event.source === "interactive" &&
				ctx.mode === "tui" &&
				!!ctx.sessionManager.getSessionFile(),
		});
		return { action: "continue" };
	});
	// Test-only sink prevents all provider requests. Does not verify expansion or replay.
	pi.on("input", () => ({ action: "handled" }));

	async function open(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		const before = ctx.ui.getEditorText();
		log("open", { before });
		const result = await ctx.ui.custom<string | null>(
			(tui, theme, kb, done) => {
				const input = new Input();
				const list = new SelectList(
					[
						{ value: exactText, label: "Unicode multiline" },
						{ value: "second", label: "Second result" },
					],
					2,
					{
						selectedPrefix: (s) => theme.fg("accent", s),
						selectedText: (s) => theme.fg("accent", s),
						description: (s) => theme.fg("muted", s),
						scrollInfo: (s) => theme.fg("dim", s),
						noMatch: (s) => theme.fg("warning", s),
					},
				);
				list.onSelect = (item) => done(item.value);
				let focused = false;
				return {
					get focused() {
						return focused;
					},
					set focused(value: boolean) {
						focused = value;
						input.focused = value;
						log("focus", { value });
					},
					render(width) {
						return [
							theme.fg("accent", "SPIKE PICKER"),
							...input.render(width),
							...list.render(width),
						].map((line) => truncateToWidth(line, width));
					},
					invalidate() {
						input.invalidate();
						list.invalidate();
					},
					handleInput(data) {
						if (kb.matches(data, "tui.select.cancel")) done(null);
						else if (
							(
								[
									"tui.select.up",
									"tui.select.down",
									"tui.select.confirm",
								] as const
							).some((key) => kb.matches(data, key))
						)
							list.handleInput(data);
						else {
							input.handleInput(data);
							list.setFilter(input.getValue());
						}
						tui.requestRender();
					},
				};
			},
		);
		if (!closed && result !== null && result !== undefined)
			ctx.ui.setEditorText(result);
		if (!closed)
			log("close", {
				selected: result ?? null,
				before,
				after: ctx.ui.getEditorText(),
			});
	}
	pi.registerCommand("history", { handler: async (_args, ctx) => open(ctx) });
	pi.registerShortcut(
		process.env.SPIKE_SHORTCUT === "alt+h" ? "alt+h" : "ctrl+r",
		{ handler: open },
	);
	pi.registerShortcut("alt+k", {
		handler: async (ctx) => {
			ctx.ui.setEditorText("");
		},
	});
	// Observe editor without clearing/submitting its draft.
	pi.registerShortcut("alt+j", {
		handler: async (ctx) => {
			log("draft", { text: ctx.ui.getEditorText() });
		},
	});
	pi.registerCommand("probe", {
		handler: async (args, ctx) => {
			log("command", { args });
			if (args === "pause") {
				paused = true;
				ctx.ui.setStatus("spike", "SPIKE PAUSED");
				log("pause", { paused });
			} else if (args === "new") {
				await ctx.newSession();
				return;
			} else if (args === "resume") {
				await ctx.switchSession(sessionPath);
				return;
			} else if (args === "fork") {
				const entry = ctx.sessionManager
					.getBranch()
					.find(
						(entry) =>
							entry.type === "message" && entry.message.role === "user",
					);
				if (!entry) throw new Error("Missing synthetic user entry");
				await ctx.fork(entry.id);
				return;
			} else if (args === "normalize") {
				const requested = "a\tb\r\nc\rd";
				ctx.ui.setEditorText(requested);
				log("normalize", { requested, actual: ctx.ui.getEditorText() });
			} else if (args === "inject")
				pi.sendUserMessage("synthetic extension input");
		},
	});
}
