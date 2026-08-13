import type { Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SizeValue } from "@earendil-works/pi-tui";

export const GATE_PANEL_MAX_WIDTH = 90;
/**
 * Resume rows are a preview column plus two fixed metadata columns, so every extra terminal
 * column goes straight into how much of the session's first message is legible. Unlike the
 * other views it takes whatever width the terminal offers.
 */
export const RESUME_PANEL_WIDTH: SizeValue = "100%";
export const GATE_LIST_HEIGHT = 10;
/** Terminals this short drop the spacer above the menu so the splash + gate still fit. */
export const SHORT_TERMINAL_ROWS = 24;

/**
 * True when `data` is plain typed/pasted text safe to append to a filter query: non-empty,
 * no control characters (which covers escape sequences — they start with `\x1b`) and no DEL.
 */
export function isPrintableInput(data: string): boolean {
	if (data.length === 0) return false;
	for (const ch of data) {
		if (ch < " " || ch === "\x7f") return false;
	}
	return true;
}

/** Compute a scroll window [start, end) that keeps `selected` visible within `height` rows. */
export function listWindow(total: number, height: number, selected: number): { start: number; end: number } {
	if (total <= height) return { start: 0, end: total };
	let start = selected - Math.floor(height / 2);
	start = Math.max(0, Math.min(start, total - height));
	return { start, end: start + height };
}

/**
 * Fuzzy matches ranked best-first, with literal-substring matches stably partitioned to the front.
 * `fuzzyFilter` splits the query on whitespace and slashes, so "anthropic opus" and partial ids
 * both work; an empty query is returned in its original order. Because `fuzzyMatch` scores a greedy
 * first-occurrence path a scattered match can outrank a literal one (e.g. "opus" scoring
 * "anthropic/claude-sonnet" above "anthropic/claude-opus"), hence the partition.
 */
export function fuzzyRanked<T>(items: T[], query: string, key: (item: T) => string): T[] {
	const matches = fuzzyFilter(items, query, key);
	const tokens = query.trim().toLowerCase().split(/[\s/]+/).filter(Boolean);
	if (tokens.length === 0) return matches;
	const isSubstringMatch = (item: T) => {
		const haystack = key(item).toLowerCase();
		return tokens.every((token) => haystack.includes(token));
	};
	const sub: T[] = [];
	const rest: T[] = [];
	for (const m of matches) (isSubstringMatch(m) ? sub : rest).push(m);
	return [...sub, ...rest];
}

/**
 * Wrap pre-styled body lines in a rounded bordered box exactly `width` columns wide, with the
 * title embedded in the top border (`╭─ title ────╮`). Body lines are truncated to the interior
 * width and padded so the right border stays aligned; a blank row above and below the body
 * gives the box breathing room.
 */
export function renderPopupBox(theme: Theme, width: number, title: string, bodyLines: string[]): string[] {
	const innerW = Math.max(1, width - 4);
	const border = (text: string) => theme.fg("border", text);
	const titleText = truncateToWidth(title, Math.max(0, innerW - 2));
	// Top border columns: "╭─ " (3) + title + " " (1) + dashes + "╮" (1).
	const dashes = "─".repeat(Math.max(0, width - visibleWidth(titleText) - 5));
	const top = `${border("╭─ ")}${theme.fg("accent", titleText)}${border(` ${dashes}╮`)}`;
	const bottom = border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
	const rows = ["", ...bodyLines, ""].map((line) => {
		const fitted = truncateToWidth(line, innerW);
		return `${border("│")} ${fitted}${" ".repeat(Math.max(0, innerW - visibleWidth(fitted)))} ${border("│")}`;
	});
	return [top, ...rows, bottom];
}
