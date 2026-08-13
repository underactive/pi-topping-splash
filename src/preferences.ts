import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_COLOR_OPTIONS, type BackgroundColor } from "./color.ts";

/** "on" enables the feature; every toggle defaults to "on" when missing or unrecognized. */
export type ToggleMode = "on" | "off";

export interface SplashPreferences {
	/** "on" shows the startup gate menu below the splash; "off" opens the editor directly beneath it. */
	menuGate: ToggleMode;
	/** "on" shimmer-reveals the model · prompt-size tagline; "off" renders the settled text immediately. */
	taglineReveal: ToggleMode;
	/** Splash backdrop; defaults to "rainbow" when missing or unrecognized. */
	backgroundColor: BackgroundColor;
}

// Resolved per call rather than cached: PI_CODING_AGENT_DIR can point somewhere else by the
// time the extension runs (tests redirect it after import).
function preferencesPath(): string {
	return join(getAgentDir(), "pi-topping-splash.json");
}

type RawPreferences = { menuGate?: unknown; taglineReveal?: unknown; backgroundColor?: unknown } | null;

/** Anything missing, unreadable or unrecognized falls back to the defaults: toggles "on", background "rainbow". */
export function readPreferences(): SplashPreferences {
	let parsed: RawPreferences = null;
	try {
		parsed = JSON.parse(readFileSync(preferencesPath(), "utf8")) as RawPreferences;
	} catch {
		// Missing or corrupt file: fall through to the defaults.
	}
	const bg = parsed?.backgroundColor;
	const backgroundColor = BACKGROUND_COLOR_OPTIONS.includes(bg as BackgroundColor) ? (bg as BackgroundColor) : "rainbow";
	return {
		menuGate: parsed?.menuGate === "off" ? "off" : "on",
		taglineReveal: parsed?.taglineReveal === "off" ? "off" : "on",
		backgroundColor,
	};
}

/** Returns false when the preferences could not be persisted, so the caller can report it. */
export function writePreferences(prefs: SplashPreferences): boolean {
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(preferencesPath(), `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
		return true;
	} catch {
		// Swallowed, not thrown: console output would corrupt the TUI.
		return false;
	}
}
