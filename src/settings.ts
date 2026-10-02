import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { BACKGROUND_COLOR_OPTIONS, DEFAULT_DYNAMIC_TINT, GRADIENT_ANIMATION_OPTIONS, isDynamicTint, type BackgroundColor, type GradientAnimation } from "./color.ts";
import { startGradientAnimation, stopGradientAnimation } from "./animate.ts";
import { GATE_PANEL_MAX_WIDTH, renderPopupBox } from "./gate-ui.ts";
import { TwoPaneModelThinking, availableModelRefs, modelRefLabel } from "./model-picker.ts";
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

/** What the Summary model row shows, and resets to on Backspace, while no model is pinned. */
const SESSION_MODEL_LABEL = "session model";
const SUMMARY_MODEL_DESCRIPTION = "Summarizes uncommitted changes at startup. Always called with thinking off, so the thinking level is ignored; pick a cheap, fast model.";
const PICKER_HINTS = "type to filter · ↑↓ move · tab/←→ switch pane · enter select · esc back";

/**
 * Open the two-pane model picker the startup gate uses; undefined means Escape/cancel. Its
 * thinking pane is part of the shared component, but the summary never uses a thinking level,
 * so only the model is returned.
 */
export async function pickSummaryModel(ctx: ExtensionContext, current?: ModelRef): Promise<ModelRef | undefined> {
	if (ctx.mode !== "tui") return undefined;
	let refs: ModelRef[] = [];
	try {
		refs = availableModelRefs(ctx);
	} catch {
		// A registry read is display-only; the empty case is reported below.
	}
	if (refs.length === 0) {
		ctx.ui.notify("No models available", "warning");
		return undefined;
	}
	// With nothing pinned the effective model is the session's, so start the cursor there.
	const preselected = current ?? (ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);
	return ctx.ui.custom<ModelRef | undefined>(
		(tui, theme, _keybindings, done) => {
			const picker = new TwoPaneModelThinking(theme, ctx, refs, "off", preselected);
			return {
				render: (width: number) => {
					// `renderPopupBox` pads its interior to exactly `width - 4`, which is what the picker emits.
					const bodyWidth = Math.max(1, width - 4);
					return renderPopupBox(theme, Math.max(width, 1), "Summary Model", [
						...wrapTextWithAnsi(theme.fg("muted", SUMMARY_MODEL_DESCRIPTION), bodyWidth),
						"",
						...picker.render(bodyWidth),
						...picker.renderFooter(bodyWidth, PICKER_HINTS),
					]);
				},
				handleInput: (data: string): void => {
					const action = picker.handleInput(data);
					tui.requestRender();
					if (action === "back") done(undefined);
					else if (action === "confirm") done(picker.getSelected().ref);
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
		changesSummaryModel: summaryModel ? modelRefLabel(summaryModel) : SESSION_MODEL_LABEL,
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
					title: "Splash Banner",
					items: [
						{ id: "backgroundColor", label: "Background color", value: values.backgroundColor, cycleValues: BACKGROUND_COLOR_OPTIONS },
						{ id: "gradientAnimation", label: "Animate gradient", value: values.gradientAnimation, cycleValues: GRADIENT_ANIMATION_OPTIONS },
					],
				},
				{
					title: "Info Panel",
					items: [
						{ id: "taglineReveal", label: "Model + prompt size reveal animation", value: values.taglineReveal },
						{ id: "changesSummary", label: "Summarize uncommitted changes", value: values.changesSummary },
						{
							id: "changesSummaryModel",
							label: "Summary model",
							value: values.changesSummaryModel,
							pick: true,
							clearValue: SESSION_MODEL_LABEL,
						},
					],
				},
			],
			buttons: [
				{ id: "apply", label: "Apply", primary: true },
				{ id: "cancel", label: "Cancel" },
			],
			hints: ["\u2191\u2193 move", "\u2423 toggle", "\u2190\u2192 cycle", "\u23ce pick", "\u232b clear", "\u21e5 actions", "esc cancel"],
		});

		// Backspace resets only the row's label, so drop the pinned ref that label was showing.
		if (result.values.changesSummaryModel === SESSION_MODEL_LABEL) summaryModel = undefined;

		if (result.picked === "changesSummaryModel") {
			values = { ...result.values };
			const picked = await pickSummaryModel(ctx, summaryModel);
			if (picked) {
				summaryModel = picked;
				values.changesSummaryModel = modelRefLabel(picked);
			}
			initialCursor = "changesSummaryModel";
			continue;
		}
		if (result.action !== "apply") return;

		const backgroundColor = result.values.backgroundColor;
		const gradientAnimation = result.values.gradientAnimation;
		const dynamicTint = isDynamicTint(backgroundColor) ? backgroundColor : prefs.dynamicTint ?? DEFAULT_DYNAMIC_TINT;
		// Gate/reveal and startup-summary keys are read at startup; background and animation also
		// apply immediately below, to a splash that may already be visible. Applying a theme color
		// also records it as the tint for the dynamic backdrop.
		if (writePreferences({
			menuGate: result.values.menuGate ? "on" : "off",
			taglineReveal: result.values.taglineReveal ? "on" : "off",
			backgroundColor,
			dynamicTint,
			gradientAnimation,
			changesSummary: result.values.changesSummary ? "on" : "off",
			changesSummaryModel: summaryModel,
		})) {
			ctx.ui.notify("Pi Topping Splash settings saved", "info");
			state.backgroundColor = backgroundColor;
			state.dynamicTint = dynamicTint;
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
