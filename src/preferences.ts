import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_COLOR_OPTIONS, GRADIENT_ANIMATION_OPTIONS, type BackgroundColor, type GradientAnimation } from "./color.ts";
import { isModelRef } from "./model-picker.ts";
import type { ModelRef } from "./model-picker.ts";

/** A persisted feature toggle. Individual preferences document their own default. */
export type ToggleMode = "on" | "off";

export interface SplashPreferences {
	/** "on" shows the startup gate menu below the splash; "off" opens the editor directly beneath it. */
	menuGate: ToggleMode;
	/** "on" shimmer-reveals the model · prompt-size tagline and streams in the changes summary; "off" renders both settled immediately. */
	taglineReveal: ToggleMode;
	/** Splash backdrop; defaults to "rainbow" when missing or unrecognized. */
	backgroundColor: BackgroundColor;
	/** Animation for the splash backdrop (any background, rainbow included); defaults to "off". */
	gradientAnimation: GradientAnimation;
	/** "on" summarizes uncommitted changes at startup; opt-in and defaults to "off". */
	changesSummary: ToggleMode;
	/** Model for the changes summary; undefined means the session model. */
	changesSummaryModel?: ModelRef;
}

// Resolved per call rather than cached: PI_CODING_AGENT_DIR can point somewhere else by the
// time the extension runs (tests redirect it after import).
function preferencesPath(): string {
	return join(getAgentDir(), "pi-topping-splash.json");
}

type RawPreferences = {
	menuGate?: unknown;
	taglineReveal?: unknown;
	backgroundColor?: unknown;
	gradientAnimation?: unknown;
	changesSummary?: unknown;
	changesSummaryModel?: unknown;
} | null;

/** Anything missing, unreadable or unrecognized falls back to the defaults: gate/reveal toggles "on", changes summary "off", background "rainbow", animation "off". */
export function readPreferences(): SplashPreferences {
	let parsed: RawPreferences = null;
	try {
		parsed = JSON.parse(readFileSync(preferencesPath(), "utf8")) as RawPreferences;
	} catch {
		// Missing or corrupt file: fall through to the defaults.
	}
	const bg = parsed?.backgroundColor;
	const backgroundColor = BACKGROUND_COLOR_OPTIONS.includes(bg as BackgroundColor) ? (bg as BackgroundColor) : "rainbow";
	const anim = parsed?.gradientAnimation;
	const gradientAnimation = GRADIENT_ANIMATION_OPTIONS.includes(anim as GradientAnimation) ? (anim as GradientAnimation) : "off";
	const configuredSummaryModel = isModelRef(parsed?.changesSummaryModel)
		? { provider: parsed.changesSummaryModel.provider, id: parsed.changesSummaryModel.id }
		: undefined;
	return {
		menuGate: parsed?.menuGate === "off" ? "off" : "on",
		taglineReveal: parsed?.taglineReveal === "off" ? "off" : "on",
		backgroundColor,
		gradientAnimation,
		changesSummary: parsed?.changesSummary === "on" ? "on" : "off",
		changesSummaryModel: configuredSummaryModel,
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
