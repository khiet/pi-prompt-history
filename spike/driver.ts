// Test-only companion for spike/pause.py, loaded after the real extension.
// It logs session starts and swallows prompts so no provider is ever called.
// It never touches pause state.

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const logPath = process.env.DRIVER_LOG;
	if (!logPath) throw new Error("Run only through spike/pause.py");
	const log = (kind: string, data: object = {}) =>
		appendFileSync(logPath, `${JSON.stringify({ kind, ...data })}\n`);

	pi.on("session_start", (event) => log("start", { reason: event.reason }));
	// Runs after the real extension's input hook, which has already recorded.
	pi.on("input", (event) => {
		log("input", { text: event.text });
		return { action: "handled" };
	});
}
