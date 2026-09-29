// Minimal stand-in for the Pi host: records what the extension registers and
// lets tests fire events at it. It does not model Pi's runtime; real TUI
// behavior stays covered only by the release gates in the README.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import promptHistory from "../src/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

export type Notice = { message: string; type: string | undefined };

export type ContextOptions = {
	mode?: ExtensionContext["mode"];
	cwd?: string;
	sessionFile?: string | undefined;
	sessionId?: string;
	/** Session entries a resumed or forked session would already contain. */
	entries?: unknown[];
	/** Session accessors throw, as a context from a replaced runtime can. */
	stale?: boolean;
	/** `ui.notify` records the notice and then throws. */
	notifyThrows?: boolean;
};

export type Host = {
	/** Everything the factory registered, by kind, for registration assertions. */
	registrations: string[];
	notices: Notice[];
	context(options?: ContextOptions): ExtensionContext;
	input(
		event: Partial<InputEvent> & { text: string },
		ctx?: ExtensionContext,
	): Promise<InputEventResult | undefined>;
	/** Fires any other event, for lifecycle cases with no dedicated helper. */
	fire(name: string, event: object, ctx?: ExtensionContext): Promise<unknown>;
	shutdown(reason?: string): Promise<void>;
};

export function loadExtension(): Host {
	const handlers = new Map<string, Handler[]>();
	const registrations: string[] = [];
	const notices: Notice[] = [];
	const record =
		(kind: string) =>
		(name: string, ...rest: unknown[]) => {
			registrations.push(`${kind}:${name}`);
			if (kind === "on")
				handlers.set(name, [...(handlers.get(name) ?? []), rest[0] as Handler]);
		};
	const api = new Proxy(
		{},
		{
			get: (_, property) => record(String(property)),
		},
	) as ExtensionAPI;

	const context = (options: ContextOptions = {}): ExtensionContext => {
		const live =
			<T>(value: () => T) =>
			() => {
				if (options.stale) throw new Error("stale extension context");
				return value();
			};
		return {
			mode: options.mode ?? "tui",
			cwd: options.cwd ?? "/work/project",
			hasUI: true,
			sessionManager: {
				getSessionFile: live(() =>
					"sessionFile" in options
						? options.sessionFile
						: "/sessions/one.jsonl",
				),
				getSessionId: live(() => options.sessionId ?? "session-one"),
				getEntries: () => options.entries ?? [],
				getBranch: () => options.entries ?? [],
			},
			ui: {
				notify: (message: string, type?: string) => {
					notices.push({ message, type });
					if (options.notifyThrows) throw new Error("notify failed");
				},
			},
		} as unknown as ExtensionContext;
	};

	const fire = async (name: string, event: unknown, ctx: ExtensionContext) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? [])
			result = await handler(event, ctx);
		return result;
	};

	promptHistory(api);

	return {
		registrations,
		notices,
		context,
		input: (event, ctx = context()) =>
			fire(
				"input",
				{ type: "input", source: "interactive", ...event },
				ctx,
			) as Promise<InputEventResult | undefined>,
		fire: (name, event, ctx = context()) =>
			fire(name, { type: name, ...event }, ctx),
		shutdown: async (reason = "quit") => {
			await fire(
				"session_shutdown",
				{ type: "session_shutdown", reason },
				context(),
			);
		},
	};
}

/** Permission tests are meaningless for root, which bypasses file modes. */
export const skipPermissionTests =
	process.getuid?.() === 0 || process.platform === "win32";

/** Points getAgentDir() at a fresh temporary directory for one test. */
export async function useAgentDir(): Promise<{
	agentDir: string;
	historyFile: string;
	readLines(): Promise<Record<string, unknown>[]>;
	cleanup(): Promise<void>;
}> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-prompt-history-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const historyFile = join(agentDir, "prompt-history", "history.jsonl");
	return {
		agentDir,
		historyFile,
		readLines: async () =>
			(await readFile(historyFile, "utf8"))
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line)),
		cleanup: async () => {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(agentDir, { recursive: true, force: true });
		},
	};
}
