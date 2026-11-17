import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startGradientAnimation, startLogoAnimation, stopGradientAnimation, stopLogoAnimation } from "./animate.ts";
import { DEFAULT_DYNAMIC_TINT, isDynamicTint } from "./color.ts";
import { readPreferences, writePreferences } from "./preferences.ts";
import { headerRenderState, state } from "./state.ts";
import { openSettingsDialog } from "./ui/settings-dialog.ts";

/** Open the splash settings TUI and persist changes on apply. */
export async function showSplashSettings(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/topping-splash-settings requires TUI mode", "error");
		return;
	}

	const prefs = readPreferences();
	// Null when cancelled, and when the dialog failed: it has said so and saved nothing.
	const applied = await openSettingsDialog(ctx, prefs);
	if (!applied) return;

	const { backgroundColor, gradientAnimation, logoStyle } = applied;
	const dynamicTint = isDynamicTint(backgroundColor) ? backgroundColor : prefs.dynamicTint ?? DEFAULT_DYNAMIC_TINT;
	// Gate/reveal and startup-summary keys are read at startup; background, animation, and logo
	// style also apply immediately below, to a splash that may already be visible. Applying a theme color
	// also records it as the tint for the dynamic backdrop.
	if (writePreferences({
		menuGate: applied.menuGate ? "on" : "off",
		taglineReveal: applied.taglineReveal ? "on" : "off",
		backgroundColor,
		dynamicTint,
		gradientAnimation,
		logoStyle,
		changesSummary: applied.changesSummary ? "on" : "off",
		changesSummaryModel: applied.changesSummaryModel,
	})) {
		ctx.ui.notify("Pi Topping Splash settings saved", "info");
		state.backgroundColor = backgroundColor;
		state.dynamicTint = dynamicTint;
		state.gradientAnimation = gradientAnimation;
		const logoChanged = logoStyle !== state.logoStyle;
		state.logoStyle = logoStyle;
		if (logoStyle === "logo" && logoChanged && !state.conversationStarted && headerRenderState.requestRender) startLogoAnimation();
		else if (logoStyle === "symbol") stopLogoAnimation();
		// requestRender doubles as the "a splash header is wired" signal: without one there
		// is nothing to animate, so the ticker stays off until the next startup seeds it.
		// conversationStarted means the splash has scrolled (or is about to scroll) off-viewport,
		// where each tick would force a full-screen redraw — persist the preference but never
		// restart the ticker mid-session.
		if (gradientAnimation !== "off" && !state.conversationStarted && headerRenderState.requestRender) startGradientAnimation();
		else stopGradientAnimation();
		headerRenderState.invalidate?.();
		headerRenderState.requestRender?.();
	} else {
		ctx.ui.notify("Failed to save Pi Topping Splash settings", "error");
	}
}
