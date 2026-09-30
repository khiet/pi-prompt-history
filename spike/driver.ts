// Test-only companion for scripts/smoke-install.mjs, loaded after the real
// extension. It logs prompts and swallows them so no provider is ever called.

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const logPath = process.env.DRIVER_LOG;
	if (!logPath) throw new Error("Run only through scripts/smoke-install.mjs");
	const log = (kind: string, data: object = {}) =>
		appendFileSync(logPath, `${JSON.stringify({ kind, ...data })}\n`);

	// Runs after the real extension's input hook, which has already recorded.
	pi.on("input", (event, ctx) => {
		log("input", { text: event.text, source: event.source, mode: ctx.mode });
		return { action: "handled" };
	});
}
