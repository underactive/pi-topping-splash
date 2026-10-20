import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createSettingsStore, sanitize } from "@underactive/pi-topping-primitives/settings";
import { BACKGROUND_COLOR_OPTIONS, DEFAULT_DYNAMIC_TINT, GRADIENT_ANIMATION_OPTIONS, isDynamicTint, type BackgroundColor, type DynamicTint, type GradientAnimation } from "./color.ts";
import { isModelRef } from "@underactive/pi-topping-primitives/models";
import { LOGO_STYLE_OPTIONS } from "./logo.ts";
import type { LogoStyle } from "./logo.ts";
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
	/** Theme color a "dynamic" backdrop scales: the last theme color applied as the background. `readPreferences` always resolves it; optional so writers that never touch it can omit it. */
	dynamicTint?: DynamicTint;
	/** Animation for the splash backdrop (any background, rainbow included); defaults to "off". */
	gradientAnimation: GradientAnimation;
	/** Banner logo style; `readPreferences` always resolves it, optional so unrelated writers can omit it. */
	logoStyle?: LogoStyle;
	/** "on" summarizes uncommitted changes at startup; defaults to "on" when missing or unrecognized and is "off" only when explicitly stored. */
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
	dynamicTint?: unknown;
	gradientAnimation?: unknown;
	logoStyle?: unknown;
	changesSummary?: unknown;
	changesSummaryModel?: unknown;
} | null;

/** Anything missing, unreadable or unrecognized falls back to the defaults: gate "off", reveal/changes-summary toggles "on", background "rainbow", dynamic tint "accent", animation "off", logo style "random".
 * For `dynamicTint`, precedence is a theme-color `backgroundColor`, then a valid stored `dynamicTint`, then "accent"; "rainbow", "dynamic", and invalid values are excluded.
 */
function sanitizePreferences(raw: unknown): SplashPreferences {
	const parsed = (sanitize.isRecord(raw) ? raw : null) as RawPreferences;
	const bg = parsed?.backgroundColor;
	const backgroundColor = BACKGROUND_COLOR_OPTIONS.includes(bg as BackgroundColor) ? (bg as BackgroundColor) : "rainbow";
	const dynamicTint = isDynamicTint(backgroundColor) ? backgroundColor
		: isDynamicTint(parsed?.dynamicTint) ? parsed.dynamicTint : DEFAULT_DYNAMIC_TINT;
	const anim = parsed?.gradientAnimation;
	const gradientAnimation = GRADIENT_ANIMATION_OPTIONS.includes(anim as GradientAnimation) ? (anim as GradientAnimation) : "off";
	const logoStyle = LOGO_STYLE_OPTIONS.includes(parsed?.logoStyle as LogoStyle) ? (parsed?.logoStyle as LogoStyle) : "random";
	const configuredSummaryModel = isModelRef(parsed?.changesSummaryModel)
		? { provider: parsed.changesSummaryModel.provider, id: parsed.changesSummaryModel.id }
		: undefined;
	return {
		menuGate: parsed?.menuGate === "on" ? "on" : "off",
		taglineReveal: parsed?.taglineReveal === "off" ? "off" : "on",
		backgroundColor,
		dynamicTint,
		gradientAnimation,
		logoStyle,
		changesSummary: parsed?.changesSummary === "off" ? "off" : "on",
		changesSummaryModel: configuredSummaryModel,
	};
}

const preferencesStore = createSettingsStore<SplashPreferences>({
	path: preferencesPath,
	codec: { sanitize: sanitizePreferences },
});

export function readPreferences(): SplashPreferences {
	return preferencesStore.read();
}

/** Returns false when the preferences could not be persisted, so the caller can report it. */
export function writePreferences(prefs: SplashPreferences): boolean {
	// Swallowed, not thrown: console output would corrupt the TUI.
	return preferencesStore.write(prefs).ok;
}
