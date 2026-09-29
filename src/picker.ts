import type {
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	SelectList,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { HistoryRecord } from "./history.ts";

const MAX_RESULTS = 100;
const VISIBLE_ROWS = 10;

/** What the picker shows; loading and file access happen before it opens. */
export type PickerContent =
	| { kind: "records"; records: readonly HistoryRecord[] }
	| { kind: "unavailable"; guidance: string };

export type PickerOptions = {
	content: PickerContent;
	theme: Theme;
	keybindings: KeybindingsManager;
	requestRender(): void;
	/** Receives the selected record's stored text, or undefined on cancel. */
	done(text: string | undefined): void;
};

/**
 * History picker for `ctx.ui.custom()`. Records must arrive newest first; the
 * first 100 that match the query are offered. Selection hands back the stored text untouched; only its
 * display is made safe.
 */
export function createPicker(options: PickerOptions): Component & Focusable {
	const { content, theme, keybindings, done } = options;
	const records = content.kind === "records" ? content.records : [];
	const input = new Input();
	let list: SelectList | undefined;
	let focused = false;

	const listTheme = {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};

	// SelectList has no way to replace its items, and its own filter is a
	// prefix match, so each query builds a fresh list.
	const applyQuery = () => {
		const query = input.getValue().toLowerCase();
		const matches = records
			.filter((record) => record.text.toLowerCase().includes(query))
			.slice(0, MAX_RESULTS);
		const byId = new Map(matches.map((record) => [record.id, record.text]));
		list =
			matches.length === 0
				? undefined
				: new SelectList(
						matches.map((record) => ({
							value: record.id,
							label: displayText(record.text),
						})),
						VISIBLE_ROWS,
						listTheme,
					);
		if (list) list.onSelect = (item) => done(byId.get(item.value));
	};
	applyQuery();

	const body = (width: number): string[] => {
		if (content.kind === "unavailable")
			return [theme.fg("error", `  History unavailable. ${content.guidance}`)];
		if (records.length === 0)
			return [
				theme.fg("muted", "  No prompts recorded in this directory yet."),
			];
		return list?.render(width) ?? [theme.fg("warning", "  No prompts match.")];
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
			return [
				theme.fg("accent", "Prompt history: this directory"),
				...input.render(width),
				...body(width),
				theme.fg("dim", "up/down select  enter restore  esc cancel"),
			].map((line) => truncateToWidth(line, width, ""));
		},
		invalidate() {
			input.invalidate();
			list?.invalidate();
		},
		handleInput(data) {
			if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
			else if (
				keybindings.matches(data, "tui.select.up") ||
				keybindings.matches(data, "tui.select.down") ||
				keybindings.matches(data, "tui.select.confirm")
			)
				list?.handleInput(data);
			else {
				input.handleInput(data);
				applyQuery();
			}
			options.requestRender();
		},
	};
}

/**
 * One display line with terminal controls shown as visible symbols, so a
 * stored escape sequence can never drive the terminal. Line breaks and tabs
 * become spaces; restoration uses the stored text, not this.
 */
function displayText(text: string): string {
	return Array.from(text.replace(/[\t\n\r]+/g, " "), (char) => {
		const code = char.charCodeAt(0);
		if (code < 0x20) return String.fromCharCode(0x2400 + code);
		if (code === 0x7f) return "\u2421";
		if (code >= 0x80 && code <= 0x9f) return "\ufffd";
		return char;
	}).join("");
}
