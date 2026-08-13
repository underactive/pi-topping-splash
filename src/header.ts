import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { BackgroundColor } from "./color.ts";
import { headerRenderState, state } from "./state.ts";
import { startTaglineReveal, taglineReveal } from "./reveal.ts";
import { readPreferences } from "./preferences.ts";
import { getLoadedHeaderItems } from "./discovery.ts";
import { buildHeaderParts } from "./splash.ts";

/** Runs `fn` with a `SettingsManager` for `cwd`, swallowing errors to avoid corrupting the TUI with console output. */
export function withSettings(cwd: string, fn: (settings: SettingsManager) => void): void {
	try {
		const settings = SettingsManager.create(cwd);
		fn(settings);
	} catch {
		// Avoid corrupting the TUI with console output.
	}
}

export function ensureQuietStartup(cwd: string): boolean {
	let changed = false;
	withSettings(cwd, (settings) => {
		if (!settings.getQuietStartup()) {
			settings.setQuietStartup(true);
			changed = true;
		}
	});
	return changed;
}

export function installHeader(pi: ExtensionAPI, ctx: ExtensionContext) {
	({ skills: state.loadedSkills, extensions: state.loadedExtensions, context: state.loadedContext } = getLoadedHeaderItems(pi, ctx.cwd, ctx.isProjectTrusted()));
	const prefs = readPreferences();
	state.backgroundColor = prefs.backgroundColor;
	ctx.ui.setHeader((tui: TUI, theme: Theme) => {
		headerRenderState.requestRender = () => tui.requestRender();
		// force=true resets the differential renderer and repaints from a cleared screen
		// (the TUI emits \x1b[2J\x1b[H\x1b[3J before redrawing all content at the top).
		headerRenderState.forceRedraw = () => tui.requestRender(true);
		let cachedWidth = -1;
		let cachedRows = -1;
		let cachedModelKey = "";
		let cachedSystemPromptSize: number | undefined = undefined;
		let cachedTick = -1;
		let cachedBackground: BackgroundColor | undefined = undefined;
		let cachedLines: string[] = [];
		let cachedRepaintTagline: (() => { row: number; line: string }) | undefined = undefined;
		const component = {
			render: (width: number) => {
				const rows = tui.terminal.rows;
				const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
				const structural = width !== cachedWidth || rows !== cachedRows || modelKey !== cachedModelKey
					|| state.systemPromptSize !== cachedSystemPromptSize || state.backgroundColor !== cachedBackground;
				if (structural) {
					cachedWidth = width;
					cachedRows = rows;
					cachedModelKey = modelKey;
					cachedSystemPromptSize = state.systemPromptSize;
					cachedTick = taglineReveal.tick;
					cachedBackground = state.backgroundColor;
					const parts = buildHeaderParts(width, rows, theme, state.loadedContext, state.loadedSkills, state.loadedExtensions, ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : undefined, state.systemPromptSize, state.backgroundColor);
					cachedLines = parts.lines;
					cachedRepaintTagline = parts.repaintTagline;
					state.splashRows = cachedLines.length;
				} else if (taglineReveal.tick !== cachedTick) {
					// Reveal tick with nothing structural changed: restyle only the tagline row.
					cachedTick = taglineReveal.tick;
					if (cachedRepaintTagline) {
						const { row, line } = cachedRepaintTagline();
						if (row >= 0 && row < cachedLines.length) {
							// Fresh array with one row replaced, so the differential renderer sees the change.
							cachedLines = cachedLines.slice();
							cachedLines[row] = line;
						}
					}
				}
				return cachedLines;
			},
			invalidate() {
				cachedWidth = -1;
				cachedRows = -1;
				cachedModelKey = "";
				cachedSystemPromptSize = undefined;
				cachedTick = -1;
				cachedBackground = undefined;
				cachedRepaintTagline = undefined;
			},
		};
		headerRenderState.invalidate = () => component.invalidate();
		return component;
	});
	// Capture the initial system prompt size so the line appears on the first splash render.
	try {
		state.systemPromptSize = Buffer.byteLength(ctx.getSystemPrompt(), "utf8");
	} catch {
		state.systemPromptSize = undefined;
	}
	// Started last: the first tick needs the wired requestRender and the size captured above.
	// With the reveal disabled the ticker never starts, so renderTagline settles on frame one.
	if (prefs.taglineReveal === "on") startTaglineReveal();
}
