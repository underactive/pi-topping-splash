
import type { BackgroundColor, GradientAnimation } from "./color.ts";
import type { ShortcutHint } from "./discovery.ts";
import type { ChangesPresentation } from "./changes-summary.ts";

/**
 * Module-scoped state that lives for the lifetime of the extension process (not per-session).
 * - `quietStartupEnsured` guards the settings write so it only runs once per process.
 * - `loadedSkills`/`loadedExtensions` cache the most recent header item lists so the header
 *   component's `render()` (invoked on every TUI frame) doesn't need to re-scan commands/tools.
 * Bundled into one object so the intentional shared-state pattern is explicit at a glance.
 */
export const state = {
	quietStartupEnsured: false,
	loadedSkills: [] as string[],
	loadedExtensions: [] as string[],
	loadedContext: [] as string[],
	/** Discovered prompt template commands, formatted as `/name`. */
	loadedPrompts: [] as string[],
	/** Compact startup shortcut hints with effective keybindings. */
	loadedShortcuts: [] as ShortcutHint[],
	systemPromptSize: undefined as number | undefined,
	/** Rows the splash/header block last rendered; the gate menu centers itself below it. */
	splashRows: 0,
	/** Published startup changes listing/summary, or null before a dirty repository is found. */
	changes: null as ChangesPresentation | null,
	/** Guards the one startup collection attempt for the current extension process. */
	changesStarted: false,
	/** Current render-time splash backdrop, seeded from preferences and updated immediately on apply. */
	backgroundColor: "rainbow" as BackgroundColor,
	/** Current render-time backdrop animation, seeded from preferences and updated immediately on apply. */
	gradientAnimation: "off" as GradientAnimation,
	/**
	 * Set at the first agent turn. From then on the transcript outgrows the splash and scrolls it
	 * off-viewport, where every animation tick would force a full-screen redraw — so the backdrop
	 * ticker is stopped there and never restarted for the rest of the process.
	 */
	conversationStarted: false,
};

/** Callbacks wired by the active header component so model_select can force a refresh. */
export const headerRenderState = {
	invalidate: null as (() => void) | null,
	requestRender: null as (() => void) | null,
	/** Clears the terminal (screen + scrollback) and repaints all TUI content from the top row. */
	forceRedraw: null as (() => void) | null,
};

/** Changes-only redraw callback; kept apart so it never signals that a splash is wired. */
export const changesRenderState = {
	requestRender: null as (() => void) | null,
};
