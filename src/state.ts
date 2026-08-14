
import type { BackgroundColor, GradientAnimation } from "./color.ts";
import type { ShortcutHint } from "./discovery.ts";

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
	/** Rows the splash header last rendered; the gate menu centers itself in the space below it. */
	splashRows: 0,
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
