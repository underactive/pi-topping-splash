import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

/** Compute a scroll window [start, end) that keeps `selected` visible within `height` rows. */
export function listWindow(total: number, height: number, selected: number): { start: number; end: number } {
	if (total <= height) return { start: 0, end: total };
	let start = selected - Math.floor(height / 2);
	start = Math.max(0, Math.min(start, total - height));
	return { start, end: start + height };
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
	const lines = [top, ...rows, bottom];
	if (width >= 5) return lines;
	// The rounded chrome needs five columns at its natural size, but callers still rely on the
	// exact-width invariant for narrower terminals. Keep the first visible columns rather than
	// allowing the popup to widen the terminal layout.
	return lines.map((line) => truncateToWidth(line, Math.max(0, width), "", true));
}
