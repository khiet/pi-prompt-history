// Test-only companion for spike/acceptance.py, loaded after the real extension.
// It registers an in-process scripted model so Pi really streams, queues, and
// compacts with no network or inference. Each reply and each compaction waits
// for a gate file the driver creates, so the driver can type while Pi is busy.
// It logs what it observes to SCRIPTED_LOG and never consumes input.

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const logPath = process.env.SCRIPTED_LOG;
	const gates = process.env.SCRIPTED_GATES;
	if (!logPath || !gates)
		throw new Error("Run only through spike/acceptance.py");
	const log = (kind: string, data: object = {}) =>
		appendFileSync(logPath, `${JSON.stringify({ kind, ...data })}\n`);
	const gate = async (name: string, signal?: AbortSignal) => {
		while (!existsSync(join(gates, name))) {
			signal?.throwIfAborted();
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	let turns = 0;

	pi.registerProvider("scripted", {
		baseUrl: "https://invalid.invalid",
		apiKey: "synthetic-not-a-secret",
		api: "scripted-api",
		models: [
			{
				id: "synthetic",
				name: "Scripted synthetic model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 1024,
			},
		],
		streamSimple: (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			const turn = ++turns;
			const output: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 10,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const users = context.messages
				.filter((message) => message.role === "user")
				.map((message) =>
					typeof message.content === "string"
						? message.content
						: message.content
								.map((part) => (part.type === "text" ? part.text : ""))
								.join(""),
				);
			queueMicrotask(async () => {
				try {
					stream.push({ type: "start", partial: output });
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					const text = `scripted reply ${turn}`;
					(output.content[0] as { text: string }).text = text;
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: text,
						partial: output,
					});
					log("turn", { turn, users });
					await gate(`turn-${turn}`, options?.signal);
					stream.push({
						type: "text_end",
						contentIndex: 0,
						content: text,
						partial: output,
					});
					stream.push({ type: "done", reason: "stop", message: output });
				} catch {
					output.stopReason = "aborted";
					stream.push({ type: "error", reason: "aborted", error: output });
				} finally {
					stream.end();
				}
			});
			return stream;
		},
	});

	pi.on("session_before_compact", async (event) => {
		log("compact", { reason: event.reason });
		await gate("compact", event.signal);
		return {
			compaction: {
				summary: "synthetic summary",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		};
	});

	pi.on("session_start", (event) => log("start", { reason: event.reason }));
	pi.on("input", (event) => {
		log("input", {
			text: event.text,
			source: event.source,
			streamingBehavior: event.streamingBehavior ?? null,
		});
		return { action: "continue" };
	});

	// Reads the draft without changing it, so the driver can check restores.
	pi.registerShortcut("f9", {
		description: "Log the editor text (test only)",
		handler: (ctx) => log("editor", { text: ctx.ui.getEditorText() }),
	});

	// Replaces the session after a delay, so a picker can be open when it does.
	pi.registerCommand("scripted-new-later", {
		description: "Start a new session after a delay (test only)",
		handler: async (_args, ctx) => {
			setTimeout(() => {
				ctx.newSession().catch((error: unknown) => {
					log("new-failed", { error: String(error) });
				});
			}, 1500);
		},
	});
}
