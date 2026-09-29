import type {
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	type Keybinding,
	SelectList,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	type HistoryRecord,
	MAX_RESULTS,
	type SearchRequest,
} from "./history.ts";

const VISIBLE_ROWS = 10;
const PREVIEW_LINES = 8;

/** One search's outcome; file access happens outside the picker. */
export type PickerContent =
	| { kind: "records"; records: readonly HistoryRecord[]; capped: boolean }
	| { kind: "unavailable"; guidance: string };

export type PickerSearch = (request: SearchRequest) => Promise<PickerContent>;

export type PickerOptions = {
	/** The directory the picker opens scoped to. */
	cwd: string;
	/** Results for an empty query in `cwd`, loaded before the picker opens. */
	initial: PickerContent;
	/** Must resolve, reporting failures as unavailable content. */
	search: PickerSearch;
	theme: Theme;
	keybindings: KeybindingsManager;
	requestRender(): void;
	/** Receives the selected record's stored text, or undefined on cancel. */
	done(text: string | undefined): void;
};

/**
 * History picker for `ctx.ui.custom()`. Each query or scope change runs a new
 * search; only the latest one's results are shown. Selection hands back the
 * stored text untouched; only its display is made safe.
 */
export function createPicker(options: PickerOptions): Component & Focusable {
	const { theme, keybindings, done } = options;
	const input = new Input();
	let allDirectories = false;
	let content = options.initial;
	let list: SelectList | undefined;
	let byId = new Map<string, HistoryRecord>();
	let focused = false;
	// Only the newest search may replace the results.
	let latestSearch = 0;
	let searching = false;
	// Enter pressed mid-search applies to the results the user is waiting for,
	// unless another key arrives first.
	let confirmWhenSettled = false;

	const listTheme = {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};

	const selected = () => {
		const item = list?.getSelectedItem();
		return item ? byId.get(item.value) : undefined;
	};

	const confirm = () => {
		const record = selected();
		if (record) done(record.text);
	};

	const metadata = (record: HistoryRecord) =>
		[
			formatTimestamp(record.ts),
			...(allDirectories ? [displayLine(record.cwd)] : []),
		].join("  ");

	// SelectList has no way to replace its items, and its own filter is a
	// prefix match, so each result set builds a fresh list, selecting the top.
	const setResults = (next: PickerContent) => {
		content = next;
		const records = next.kind === "records" ? next.records : [];
		byId = new Map(records.map((record) => [record.id, record]));
		list =
			records.length === 0
				? undefined
				: new SelectList(
						records.map((record) => ({
							value: record.id,
							label: displayLine(record.text),
							description: metadata(record),
						})),
						VISIBLE_ROWS,
						listTheme,
						{ minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 60 },
					);
	};
	setResults(options.initial);

	const refresh = () => {
		const id = ++latestSearch;
		searching = true;
		void options
			.search({
				query: input.getValue(),
				cwd: allDirectories ? undefined : options.cwd,
			})
			.then((next) => {
				if (id !== latestSearch) return;
				searching = false;
				setResults(next);
				if (confirmWhenSettled) {
					confirmWhenSettled = false;
					confirm();
				}
				options.requestRender();
			});
	};

	const keyName = (binding: Keybinding) =>
		keybindings.getKeys(binding)[0] ?? binding;

	const body = (width: number): string[] => {
		if (content.kind === "unavailable")
			return [theme.fg("error", `  History unavailable. ${content.guidance}`)];
		if (content.records.length === 0) {
			if (input.getValue() !== "")
				return [theme.fg("warning", "  No prompts match.")];
			return [
				theme.fg(
					"muted",
					allDirectories
						? "  No prompts recorded yet."
						: "  No prompts recorded in this directory yet.",
				),
			];
		}
		const lines = list?.render(width) ?? [];
		if (content.capped)
			lines.push(
				theme.fg(
					"dim",
					`  Showing the newest ${MAX_RESULTS} matches; type more to find older prompts.`,
				),
			);
		return [...lines, ...preview()];
	};

	const preview = (): string[] => {
		const record = selected();
		if (!record) return [];
		const lines = record.text.split(/\r\n|\r|\n/);
		const shown = lines.slice(0, PREVIEW_LINES);
		const hidden = lines.length - shown.length;
		return [
			"",
			theme.fg("muted", metadata(record)),
			...shown.map((line) => `  ${displayLine(line)}`),
			...(hidden > 0 ? [theme.fg("dim", `  ... ${hidden} more lines`)] : []),
		];
	};

	return {
		get focused() {
			return focused;
		},
		// Propagated so the terminal cursor, and with it IME composition, sits
		// in the query field.
		set focused(value: boolean) {
			focused = value;
			input.focused = value;
		},
		render(width) {
			const scope = allDirectories ? "all directories" : "this directory";
			const toggle = allDirectories ? "this directory" : "all directories";
			return [
				theme.fg("accent", `Prompt history: ${scope}`),
				...input.render(width),
				...body(width),
				theme.fg(
					"dim",
					`${keyName("tui.select.up")}/${keyName("tui.select.down")} select  ${keyName("tui.input.tab")} ${toggle}  ${keyName("tui.select.confirm")} restore  ${keyName("tui.select.cancel")} cancel`,
				),
			].map((line) => truncateToWidth(line, width, ""));
		},
		invalidate() {
			input.invalidate();
			list?.invalidate();
		},
		handleInput(data) {
			const confirming = keybindings.matches(data, "tui.select.confirm");
			if (!confirming) confirmWhenSettled = false;
			if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
			else if (confirming) {
				if (searching) confirmWhenSettled = true;
				else confirm();
			} else if (
				keybindings.matches(data, "tui.select.up") ||
				keybindings.matches(data, "tui.select.down")
			)
				list?.handleInput(data);
			else if (keybindings.matches(data, "tui.input.tab")) {
				allDirectories = !allDirectories;
				refresh();
			} else {
				const before = input.getValue();
				input.handleInput(data);
				if (input.getValue() !== before) refresh();
			}
			options.requestRender();
		},
	};
}

/** Local time to the minute, e.g. "2026-09-29 14:05". */
function formatTimestamp(ts: number): string {
	const date = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * One display line with terminal controls shown as visible symbols, so a
 * stored escape sequence can never drive the terminal. Line breaks and tabs
 * become spaces; restoration uses the stored text, not this.
 */
function displayLine(text: string): string {
	return Array.from(text.replace(/[\t\n\r]+/g, " "), (char) => {
		const code = char.charCodeAt(0);
		if (code < 0x20) return String.fromCharCode(0x2400 + code);
		if (code === 0x7f) return "\u2421";
		if (code >= 0x80 && code <= 0x9f) return "\ufffd";
		return char;
	}).join("");
}
