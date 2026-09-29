import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

export type StorePaths = { dir: string; historyFile: string };

/**
 * Store paths under Pi's agent directory, honoring PI_CODING_AGENT_DIR as set
 * at call time. Performs no I/O.
 */
export function resolveStorePaths(): StorePaths {
	const dir = join(getAgentDir(), "prompt-history");
	return { dir, historyFile: join(dir, "history.jsonl") };
}

export const DEFAULT_SHORTCUT: KeyId = "ctrl+r";

export type Config = {
	shortcut: KeyId;
	configFile: string;
	/** Why the file was ignored; the defaults above apply instead. */
	problem?: string;
};

/**
 * Reads the global config once. Never throws: a missing file means defaults,
 * and an unreadable or invalid one means defaults plus a `problem` that names
 * the fault without quoting the file's contents.
 */
export function loadConfig(): Config {
	const configFile = join(resolveStorePaths().dir, "config.json");
	const fallback = (problem: string): Config => ({
		shortcut: DEFAULT_SHORTCUT,
		configFile,
		problem,
	});

	let raw: string;
	try {
		raw = readFileSync(configFile, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") return { shortcut: DEFAULT_SHORTCUT, configFile };
		return fallback(`could not be read (${code ?? "unexpected error"})`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return fallback("is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return fallback('must be a JSON object like {"shortcut": "alt+h"}');

	const unsupported = Object.keys(parsed).filter((key) => key !== "shortcut");
	if (unsupported.length > 0)
		return fallback(
			`has unsupported settings (${unsupported.map((key) => JSON.stringify(key)).join(", ")}); "shortcut" is the only one`,
		);

	const { shortcut } = parsed as { shortcut?: unknown };
	if (shortcut === undefined) return { shortcut: DEFAULT_SHORTCUT, configFile };
	if (typeof shortcut !== "string" || !isUsableShortcut(shortcut))
		return fallback(
			'has an invalid "shortcut"; use a key in Pi\'s keybindings format with ctrl, alt, or super, like "alt+h", or a function key like "f5"',
		);
	return { shortcut: shortcut as KeyId, configFile };
}

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

const FUNCTION_KEY = /^f(?:[1-9]|1[0-2])$/;

/** Base keys from Pi's documented keybindings format. */
const BASE_KEYS = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789",
	..."`-=[]\\;',./!@#$%^&*()_+|~{}:<>?",
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageUp",
	"pageDown",
	"up",
	"down",
	"left",
	"right",
]);

/**
 * A documented key that leaves typing and editing alone: it needs ctrl, alt,
 * or super, unless it is a function key. Whether Pi reserves the key for one
 * of its own actions is left to Pi, which warns and skips the shortcut.
 */
function isUsableShortcut(shortcut: string): boolean {
	// "+" is itself a key, written last as in "ctrl++".
	const plusKey = shortcut === "+" || shortcut.endsWith("++");
	const prefix = plusKey ? shortcut.slice(0, -2) : shortcut;
	const parts = prefix === "" ? [] : prefix.split("+");
	const base = plusKey ? "+" : (parts.pop() ?? "");
	const modifiers = parts;
	if (new Set(modifiers).size !== modifiers.length) return false;
	if (!modifiers.every((modifier) => MODIFIERS.has(modifier))) return false;
	if (FUNCTION_KEY.test(base)) return true;
	return (
		BASE_KEYS.has(base) && modifiers.some((modifier) => modifier !== "shift")
	);
}
