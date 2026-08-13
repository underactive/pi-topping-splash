
import type { BackgroundColor } from "./color.ts";

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
	systemPromptSize: undefined as number | undefined,
	/** Rows the splash header last rendered; the gate menu centers itself in the space below it. */
	splashRows: 0,
	/** Current render-time splash backdrop, seeded from preferences and updated immediately on apply. */
	backgroundColor: "rainbow" as BackgroundColor,
};

/** Callbacks wired by the active header component so model_select can force a refresh. */
export const headerRenderState = {
	invalidate: null as (() => void) | null,
	requestRender: null as (() => void) | null,
	/** Clears the terminal (screen + scrollback) and repaints all TUI content from the top row. */
	forceRedraw: null as (() => void) | null,
};
