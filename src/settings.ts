import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_COLOR_OPTIONS, GRADIENT_ANIMATION_OPTIONS, type BackgroundColor, type GradientAnimation } from "./color.ts";
import { startGradientAnimation, stopGradientAnimation } from "./animate.ts";
import { GATE_PANEL_MAX_WIDTH } from "./gate-ui.ts";
import { modelRefLabel, SummaryModelPicker } from "./model-picker.ts";
import type { ModelRef } from "./model-picker.ts";
import { headerRenderState, state } from "./state.ts";
import { showMenu } from "./menu.ts";
import { readPreferences, writePreferences } from "./preferences.ts";

interface SplashSettingsValues {
	[key: string]: boolean | string;
	menuGate: boolean;
	taglineReveal: boolean;
	backgroundColor: BackgroundColor;
	gradientAnimation: GradientAnimation;
	changesSummary: boolean;
	changesSummaryModel: string;
}

/** Open the filterable summary-model picker; undefined means Escape/cancel, null means session model. */
export async function pickSummaryModel(ctx: ExtensionContext, current?: ModelRef): Promise<ModelRef | null | undefined> {
	if (ctx.mode !== "tui") return undefined;
	return ctx.ui.custom<ModelRef | null | undefined>(
		(tui, theme, _keybindings, done) => {
			const picker = new SummaryModelPicker(theme, ctx, current);
			return {
				render: (width: number) => picker.render(width),
				handleInput: (data: string): void => {
					const action = picker.handleInput(data);
					tui.requestRender();
					if (action === "back") done(undefined);
					else if (action === "confirm") done(picker.getSelected());
				},
				invalidate: () => picker.invalidate(),
			};
		},
		{ overlay: true, overlayOptions: { width: GATE_PANEL_MAX_WIDTH, maxHeight: "100%" } },
	);
}

/** Open the shared splash settings TUI and persist changes on apply. */
export async function showSplashSettings(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/topping-splash-settings requires TUI mode", "error");
		return;
	}

	const prefs = readPreferences();
	let summaryModel = prefs.changesSummaryModel;
	let values: SplashSettingsValues = {
		menuGate: prefs.menuGate === "on",
		taglineReveal: prefs.taglineReveal === "on",
		backgroundColor: prefs.backgroundColor,
		gradientAnimation: prefs.gradientAnimation,
		changesSummary: prefs.changesSummary === "on",
		changesSummaryModel: summaryModel ? modelRefLabel(summaryModel) : "session model",
	};
	let initialCursor: string | undefined;

	while (true) {
		const result = await showMenu<SplashSettingsValues>(ctx, {
			title: "Pi Topping Splash: Settings",
			initialCursor,
			sections: [
				{
					title: "Startup Gate",
					items: [{ id: "menuGate", label: "Startup gate menu", value: values.menuGate }],
				},
				{
					title: "Splash",
					items: [
						{ id: "taglineReveal", label: "Model + prompt size reveal animation", value: values.taglineReveal },
						{ id: "backgroundColor", label: "Background color", value: values.backgroundColor, cycleValues: BACKGROUND_COLOR_OPTIONS },
						{ id: "gradientAnimation", label: "Animate gradient", value: values.gradientAnimation, cycleValues: GRADIENT_ANIMATION_OPTIONS },
					],
				},
				{
					title: "Startup Changes",
					items: [
						{ id: "changesSummary", label: "Summarize uncommitted changes", value: values.changesSummary },
						{
							id: "changesSummaryModel",
							label: "Summary model",
							value: values.changesSummaryModel,
							pick: true,
						},
					],
				},
			],
			hints: ["\u2191\u2193 move", "\u2423 toggle/pick", "\u2190\u2192 cycle", "\u23ce apply", "esc cancel"],
		});

		if (result.picked === "changesSummaryModel") {
			values = { ...result.values };
			const picked = await pickSummaryModel(ctx, summaryModel);
			if (picked !== undefined) {
				summaryModel = picked ?? undefined;
				values.changesSummaryModel = summaryModel ? modelRefLabel(summaryModel) : "session model";
			}
			initialCursor = "changesSummaryModel";
			continue;
		}
		if (!result.applied) return;

		const backgroundColor = result.values.backgroundColor;
		const gradientAnimation = result.values.gradientAnimation;
		// Gate/reveal and startup-summary keys are read at startup; background and animation also
		// apply immediately below, to a splash that may already be visible.
		if (writePreferences({
			menuGate: result.values.menuGate ? "on" : "off",
			taglineReveal: result.values.taglineReveal ? "on" : "off",
			backgroundColor,
			gradientAnimation,
			changesSummary: result.values.changesSummary ? "on" : "off",
			changesSummaryModel: summaryModel,
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
		return;
	}
}
