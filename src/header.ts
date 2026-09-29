import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { BackgroundColor, GradientAnimation } from "./color.ts";
import { changesRenderState, headerRenderState, state } from "./state.ts";
import { gradientAnimation, startGradientAnimation } from "./animate.ts";
import { startTaglineReveal, taglineReveal } from "./reveal.ts";
import { readPreferences } from "./preferences.ts";
import { getLoadedHeaderItems } from "./discovery.ts";
import { buildHeaderParts } from "./splash.ts";
import { EDITOR_RESERVED_ROWS, layoutChangesSection, summaryStream } from "./changes-summary.ts";
import { gateMenuRows } from "./gate.ts";

/** Runs `fn` with a `SettingsManager` for `cwd`, logging errors to stderr rather than corrupting the TUI. */
export function withSettings(cwd: string, fn: (settings: SettingsManager) => void): void {
	try {
		const settings = SettingsManager.create(cwd);
		fn(settings);
	} catch (e) {
		console.error("withSettings failed:", e);
	}
}

/** Enables Pi's quietStartup setting for cwd when not already enabled. Returns true when the setting was changed (first call only per agent dir). */
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

/** Wires the splash header, seeds shared state, and starts the configured reveal/gradient tickers. */
export function installHeader(pi: ExtensionAPI, ctx: ExtensionContext): void {
	try {
		({ skills: state.loadedSkills, extensions: state.loadedExtensions, context: state.loadedContext, prompts: state.loadedPrompts, shortcuts: state.loadedShortcuts } = getLoadedHeaderItems(pi, ctx.cwd, ctx.isProjectTrusted()));
	} catch { /* discovery is display-only; never abort the startup */ }
	const prefs = readPreferences();
	state.backgroundColor = prefs.backgroundColor;
	state.gradientAnimation = prefs.gradientAnimation;
	ctx.ui.setHeader((tui: TUI, theme: Theme) => {
		headerRenderState.requestRender = () => tui.requestRender();
		changesRenderState.requestRender = () => tui.requestRender();
		// force=true resets the differential renderer and repaints from a cleared screen
		// (the TUI emits \x1b[2J\x1b[H\x1b[3J before redrawing all content at the top).
		headerRenderState.forceRedraw = () => tui.requestRender(true);
		let cachedWidth = -1;
		let cachedRows = -1;
		let cachedModelKey = "";
		let cachedSystemPromptSize: number | undefined = undefined;
		let cachedTick = -1;
		let cachedBackground: BackgroundColor | undefined = undefined;
		let cachedAnimation: GradientAnimation | undefined = undefined;
		let cachedAnimTick = -1;
		let cachedChangesVersion = -1;
		let cachedStreamTick = -1;
		let cachedSplashLines: string[] = [];
		let cachedRepaintTagline: (() => { row: number; line: string }) | undefined = undefined;
		let cachedRepaintBackdrop: ((timeMs: number) => string[]) | undefined = undefined;
		let cachedRepaintSection: (() => { row: number; line: string }[] | null) | undefined = undefined;
		const component = {
			render: (width: number): string[] => {
				const rows = tui.terminal.rows;
				const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
				const changesVersion = state.changes?.version ?? -1;
				let structural = width !== cachedWidth || rows !== cachedRows || modelKey !== cachedModelKey
					|| state.systemPromptSize !== cachedSystemPromptSize || state.backgroundColor !== cachedBackground
					|| state.gradientAnimation !== cachedAnimation || changesVersion !== cachedChangesVersion;
				if (!structural && summaryStream.tick !== cachedStreamTick) {
					// Stream tick: restyle only the section rows it touched, unless the section changed height.
					cachedStreamTick = summaryStream.tick;
					const repainted = cachedRepaintSection?.();
					if (repainted === null) structural = true;
					else if (repainted && repainted.length > 0) {
						cachedSplashLines = cachedSplashLines.slice();
						for (const { row, line } of repainted) {
							if (row >= 0 && row < cachedSplashLines.length) cachedSplashLines[row] = line;
						}
					}
				}
				if (structural) {
					cachedWidth = width;
					cachedRows = rows;
					cachedModelKey = modelKey;
					cachedSystemPromptSize = state.systemPromptSize;
					cachedTick = taglineReveal.tick;
					cachedBackground = state.backgroundColor;
					cachedAnimation = state.gradientAnimation;
					cachedAnimTick = gradientAnimation.tick;
					cachedChangesVersion = changesVersion;
					cachedStreamTick = summaryStream.tick;
					// The changes section closes the info panel, in whatever rows the gate or editor leaves free.
					const reserve = prefs.menuGate === "on" ? gateMenuRows(rows) : EDITOR_RESERVED_ROWS;
					const parts = buildHeaderParts(width, rows, theme, state.loadedContext, state.loadedSkills, state.loadedExtensions, ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : undefined, state.systemPromptSize, state.backgroundColor, state.gradientAnimation, gradientAnimation.timeMs, state.loadedPrompts, state.loadedShortcuts,
						(band) => layoutChangesSection(theme, state.changes, band.width, rows - band.rows - reserve));
					cachedSplashLines = parts.lines;
					cachedRepaintTagline = parts.repaintTagline;
					cachedRepaintBackdrop = parts.repaintBackdrop;
					cachedRepaintSection = parts.repaintSection;
				} else {
					if (gradientAnimation.tick !== cachedAnimTick) {
						// Animation tick with nothing structural changed: repaint only the splash rows.
						cachedAnimTick = gradientAnimation.tick;
						if (cachedRepaintBackdrop) cachedSplashLines = cachedRepaintBackdrop(gradientAnimation.timeMs);
					}
					if (taglineReveal.tick !== cachedTick) {
						// Reveal tick with nothing structural changed: restyle only the tagline row.
						cachedTick = taglineReveal.tick;
						if (cachedRepaintTagline) {
							const { row, line } = cachedRepaintTagline();
							if (row >= 0 && row < cachedSplashLines.length) {
								cachedSplashLines = cachedSplashLines.slice();
								cachedSplashLines[row] = line;
							}
						}
					}
				}

				state.splashRows = cachedSplashLines.length;
				return cachedSplashLines;
			},
			invalidate(): void {
				cachedWidth = -1;
				cachedRows = -1;
				cachedModelKey = "";
				cachedSystemPromptSize = undefined;
				cachedTick = -1;
				cachedBackground = undefined;
				cachedAnimation = undefined;
				cachedAnimTick = -1;
				cachedSplashLines = [];
				cachedStreamTick = -1;
				cachedRepaintTagline = undefined;
				cachedRepaintBackdrop = undefined;
				cachedRepaintSection = undefined;
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
	if (prefs.gradientAnimation !== "off") startGradientAnimation();
}
