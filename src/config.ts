import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type StorePaths = { dir: string; historyFile: string };

/**
 * Resolves the store under Pi's agent directory, which honors
 * PI_CODING_AGENT_DIR. Reads the environment on every call so a process that
 * changes it between sessions gets the current location; performs no I/O.
 */
export function resolveStorePaths(): StorePaths {
	const dir = join(getAgentDir(), "prompt-history");
	return { dir, historyFile: join(dir, "history.jsonl") };
}
