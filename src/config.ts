import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type StorePaths = { dir: string; historyFile: string };

/**
 * Store paths under Pi's agent directory, honoring PI_CODING_AGENT_DIR as set
 * at call time. Performs no I/O.
 */
export function resolveStorePaths(): StorePaths {
	const dir = join(getAgentDir(), "prompt-history");
	return { dir, historyFile: join(dir, "history.jsonl") };
}
