import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_COLOR_OPTIONS, GRADIENT_ANIMATION_OPTIONS, type BackgroundColor, type GradientAnimation } from "./color.ts";
import { startGradientAnimation, stopGradientAnimation } from "./animate.ts";
import { headerRenderState, state } from "./state.ts";
import { showMenu } from "./menu.ts";
import { readPreferences, writePreferences } from "./preferences.ts";

type SplashSettingsValues = {
	menuGate: boolean;
	taglineReveal: boolean;
	backgroundColor: BackgroundColor;
	gradientAnimation: GradientAnimation;
};

/** Open the shared splash settings TUI and persist changes on apply. */
export async function showSplashSettings(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/topping-splash-settings requires TUI mode", "error");
		return;
	}

	const prefs = readPreferences();
	const result = await showMenu<SplashSettingsValues>(ctx, {
		title: "Pi Topping Splash: Settings",
		sections: [
			{
				title: "Startup Gate",
				items: [{ id: "menuGate", label: "Startup gate menu", value: prefs.menuGate === "on" }],
			},
			{
				title: "Splash",
				items: [
					{ id: "taglineReveal", label: "Model + prompt size reveal animation", value: prefs.taglineReveal === "on" },
					{ id: "backgroundColor", label: "Background color", value: prefs.backgroundColor, cycleValues: BACKGROUND_COLOR_OPTIONS },
					{ id: "gradientAnimation", label: "Animate gradient", value: prefs.gradientAnimation, cycleValues: GRADIENT_ANIMATION_OPTIONS },
				],
			},
		],
		hints: ["\u2191\u2193 move", "\u2423 toggle", "\u2190\u2192 cycle", "\u23ce apply", "esc cancel"],
	});
	if (!result.applied) return;

	const backgroundColor = result.values.backgroundColor;
	const gradientAnimation = result.values.gradientAnimation;
	// The gate toggle is read during session_start, so it lands on the next launch; the
	// background and its animation are also applied immediately below, to a splash that
	// may already be visible.
	if (writePreferences({
		menuGate: result.values.menuGate ? "on" : "off",
		taglineReveal: result.values.taglineReveal ? "on" : "off",
		backgroundColor,
		gradientAnimation,
	})) {
		ctx.ui.notify("Pi Topping Splash settings saved", "info");
		state.backgroundColor = backgroundColor;
		state.gradientAnimation = gradientAnimation;
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
