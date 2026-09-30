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
import { type Component, getKeybindings } from "@earendil-works/pi-tui";
import promptHistory from "../src/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type ShortcutHandler = (ctx: ExtensionContext) => Promise<void> | void;

export type Notice = { message: string; type: string | undefined };

/** A picker the extension opened with `ui.custom()`, driven by raw key data. */
export type Picker = {
	render(width?: number): string[];
	press(...keys: string[]): void;
	/**
	 * Resolves once the rendered screen satisfies `ready`, re-checking on each
	 * render the picker requests; searches settle asynchronously.
	 */
	until(ready: (screen: string) => boolean, width?: number): Promise<string>;
};

/** Raw terminal key sequences for driving a picker. */
export const keys = {
	up: "\x1b[A",
	down: "\x1b[B",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	ctrlD: "\x04",
	ctrlU: "\x15",
};

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

/**
 * The host's core editor and dialogs, shared by every context, as Pi's are.
 * Writes are recorded verbatim; the harness does not model Pi's editor
 * normalization.
 */
export type HostUI = {
	draft: string;
	editorWrites: string[];
	confirms: { title: string; message: string }[];
	/** What the next confirmation dialogs answer. */
	confirmAnswer: boolean;
	/** Runs while a confirmation dialog is open, before it answers. */
	whileConfirming: (() => Promise<void> | void) | undefined;
	/** Pickers opened so far, oldest first. */
	pickers: Picker[];
};

export type Host = {
	/** Everything the factory registered, by kind, for registration assertions. */
	registrations: string[];
	notices: Notice[];
	ui: HostUI;
	context(options?: ContextOptions): ExtensionContext;
	input(
		event: Partial<InputEvent> & { text: string },
		ctx?: ExtensionContext,
	): Promise<InputEventResult | undefined>;
	/** Fires any other event, for lifecycle cases with no dedicated helper. */
	fire(name: string, event: object, ctx?: ExtensionContext): Promise<unknown>;
	shutdown(reason?: string): Promise<void>;
	/** Runs a registered command; settles when its handler does. */
	command(name: string, args?: string, ctx?: ExtensionContext): Promise<void>;
	/** Presses a registered shortcut; settles when its handler does. */
	shortcut(key: string, ctx?: ExtensionContext): Promise<void>;
	/** Resolves with the next picker the extension opens. */
	nextPicker(): Promise<Picker>;
};

export function loadExtension(): Host {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const shortcuts = new Map<string, ShortcutHandler>();
	const registrations: string[] = [];
	const notices: Notice[] = [];
	const ui: HostUI = {
		draft: "",
		editorWrites: [],
		confirms: [],
		confirmAnswer: true,
		whileConfirming: undefined,
		pickers: [],
	};
	const pickerWaiters: ((picker: Picker) => void)[] = [];
	const record =
		(kind: string) =>
		(name: string, ...rest: unknown[]) => {
			registrations.push(`${kind}:${name}`);
			if (kind === "on")
				handlers.set(name, [...(handlers.get(name) ?? []), rest[0] as Handler]);
			if (kind === "registerCommand")
				commands.set(name, (rest[0] as { handler: CommandHandler }).handler);
			if (kind === "registerShortcut")
				shortcuts.set(name, (rest[0] as { handler: ShortcutHandler }).handler);
		};

	// A plain theme keeps rendered lines free of ANSI styling, so any escape
	// sequence in the output came from the rendered content itself.
	const theme = { fg: (_color: string, text: string) => text };
	const custom = async <T>(
		factory: (
			tui: { requestRender(): void },
			theme: unknown,
			keybindings: unknown,
			done: (result: T) => void,
		) => Component | Promise<Component>,
	): Promise<T> => {
		let done!: (result: T) => void;
		const result = new Promise<T>((resolve) => {
			done = resolve;
		});
		const renderWaiters = new Set<() => void>();
		const component = await factory(
			{
				requestRender: () => {
					for (const waiter of renderWaiters) waiter();
				},
			},
			theme,
			getKeybindings(),
			done,
		);
		if ("focused" in component) component.focused = true;
		const picker: Picker = {
			render: (width = 80) => component.render(width),
			press: (...data) => {
				for (const key of data) component.handleInput?.(key);
			},
			until: (ready, width = 80) =>
				new Promise((resolve, reject) => {
					const check = () => {
						const screen = component.render(width).join("\n");
						if (!ready(screen)) return false;
						cleanup();
						resolve(screen);
						return true;
					};
					const timer = setTimeout(() => {
						cleanup();
						reject(
							new Error(
								`screen never matched:\n${component.render(width).join("\n")}`,
							),
						);
					}, 2000);
					const cleanup = () => {
						clearTimeout(timer);
						renderWaiters.delete(check);
					};
					if (!check()) renderWaiters.add(check);
				}),
		};
		ui.pickers.push(picker);
		for (const waiter of pickerWaiters.splice(0)) waiter(picker);
		return result;
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
				custom,
				getEditorText: () => ui.draft,
				setEditorText: (text: string) => {
					ui.editorWrites.push(text);
					ui.draft = text;
				},
				confirm: async (title: string, message: string) => {
					ui.confirms.push({ title, message });
					await ui.whileConfirming?.();
					return ui.confirmAnswer;
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
		ui,
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
		command: async (name, args = "", ctx = context()) => {
			const handler = commands.get(name);
			if (!handler) throw new Error(`no command registered as ${name}`);
			await handler(args, ctx);
		},
		shortcut: async (key, ctx = context()) => {
			const handler = shortcuts.get(key);
			if (!handler) throw new Error(`no shortcut registered as ${key}`);
			await handler(ctx);
		},
		nextPicker: () =>
			new Promise((resolve) => {
				pickerWaiters.push(resolve);
			}),
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
