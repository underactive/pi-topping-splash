import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { renderPopupBox } from "./gate-ui.ts";
import { sanitizeTuiText } from "./text.ts";

/** Wider than the other gate popups: the prompt is prose, so extra columns mean fewer wrapped rows. */
export const SYSTEM_PROMPT_PANEL_WIDTH = 120;
const TITLE = "System Prompt";
const HINT = "↑↓ scroll · pgup/pgdn page · esc back";
const EMPTY = "No system prompt available";
/** Shared by the overlay options and the height budget so the two cannot drift apart. */
const MARGIN = { top: 1, bottom: 1, left: 2, right: 2 };
/** Rows `renderPopupBox` adds around the body: both borders plus the blank row inside each. */
const POPUP_CHROME_ROWS = 4;

/** Read-only, scrollable view of the base system prompt, wrapped to the popup width. */
export class SystemPromptView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly lines: string[];
	/** Index of the first wrapped row shown. */
	private scroll = 0;
	/** Prompt rows shown at the last render; the PgUp/PgDn step. */
	private viewportRows = 1;
	private wrapWidth = -1;
	private wrapped: string[] = [];

	constructor(tui: TUI, theme: Theme, prompt: string, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.lines = prompt.trim() ? prompt.split(/\r?\n/).map((line) => sanitizeTuiText(line.replace(/\t/g, "   "))) : [];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done();
			return;
		}
		let delta = 0;
		if (matchesKey(data, "up")) delta = -1;
		else if (matchesKey(data, "down")) delta = 1;
		else if (matchesKey(data, "pageUp")) delta = -this.viewportRows;
		else if (matchesKey(data, "pageDown")) delta = this.viewportRows;
		if (delta !== 0) this.scroll = Math.max(0, Math.min(this.scroll + delta, this.wrapped.length - this.viewportRows));
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		if (innerWidth !== this.wrapWidth) {
			this.wrapWidth = innerWidth;
			this.wrapped = this.lines.flatMap((line) => {
				const rows = line ? wrapTextWithAnsi(line, innerWidth) : [];
				return rows.length > 0 ? rows : [""];
			});
		}
		const hintRows = wrapTextWithAnsi(HINT, innerWidth).map((row) => this.theme.fg("dim", row));
		const available = Math.max(1, this.tui.terminal.rows - MARGIN.top - MARGIN.bottom);
		// Chrome, the blank row above the hint, and the hint itself come out of the overlay's height.
		const budget = Math.max(1, available - POPUP_CHROME_ROWS - 1 - hintRows.length);

		let body: string[];
		if (this.wrapped.length === 0) {
			this.scroll = 0;
			this.viewportRows = 1;
			body = [this.theme.fg("muted", EMPTY)];
		} else if (this.wrapped.length <= budget) {
			this.scroll = 0;
			this.viewportRows = this.wrapped.length;
			body = this.wrapped.map((row) => this.theme.fg("text", row));
		} else {
			// One row of the budget is kept for the position indicator.
			this.viewportRows = Math.max(1, budget - 1);
			this.scroll = Math.max(0, Math.min(this.scroll, this.wrapped.length - this.viewportRows));
			const last = this.scroll + this.viewportRows;
			body = [
				...this.wrapped.slice(this.scroll, last).map((row) => this.theme.fg("text", row)),
				this.theme.fg("dim", `  ${this.scroll + 1}-${last} of ${this.wrapped.length}`),
			];
		}
		return renderPopupBox(this.theme, width, TITLE, [...body, "", ...hintRows]);
	}

	invalidate(): void {
		this.wrapWidth = -1;
	}
}

/**
 * Show the base system prompt in a read-only overlay and resolve when it closes. The overlay is
 * capturing so it is modal and keeps Pi's fullscreen viewport from consuming PgUp/PgDn.
 */
export async function showSystemPrompt(ctx: ExtensionContext): Promise<void> {
	let prompt = "";
	try {
		prompt = ctx.getSystemPrompt();
	} catch { /* display-only, like the splash's prompt-size line */ }
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new SystemPromptView(tui, theme, prompt, () => done()),
		{ overlay: true, overlayOptions: { width: SYSTEM_PROMPT_PANEL_WIDTH, maxHeight: "100%", margin: MARGIN } },
	);
}
