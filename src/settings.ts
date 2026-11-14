import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { showMenu } from "@underactive/pi-topping-primitives/menu";
import { BACKGROUND_COLOR_OPTIONS, DEFAULT_DYNAMIC_TINT, GRADIENT_ANIMATION_OPTIONS, isDynamicTint, type BackgroundColor, type GradientAnimation } from "./color.ts";
import { LOGO_STYLE_OPTIONS } from "./logo.ts";
import type { LogoStyle } from "./logo.ts";
import { startGradientAnimation, startLogoAnimation, stopGradientAnimation, stopLogoAnimation } from "./animate.ts";
import { GATE_PANEL_MAX_WIDTH, renderPopupBox } from "./gate-ui.ts";
import { createSplashModelPicker, availableModelRefs, modelRefLabel, renderFooter, renderSplashModelPicker } from "./model-picker.ts";
import type { ModelRef } from "./model-picker.ts";
import { headerRenderState, state } from "./state.ts";
import { readPreferences, writePreferences, type SplashPreferences } from "./preferences.ts";
import { dialogFits, readTerminalSize, SETTINGS_DIALOG_SIZE } from "./ui/dialog-fit.ts";
import { openSettingsDialog, type AppliedSettings } from "./ui/settings-dialog.ts";

interface SplashSettingsValues {
	[key: string]: boolean | string;
	menuGate: boolean;
	taglineReveal: boolean;
	backgroundColor: BackgroundColor;
	gradientAnimation: GradientAnimation;
	logoStyle: LogoStyle;
	changesSummary: boolean;
	changesSummaryModel: string;
}

/** What the Summary model row shows, and resets to on Backspace, while no model is pinned. */
const SESSION_MODEL_LABEL = "session model";
const SUMMARY_MODEL_TITLE = "Summary Model";
const SUMMARY_MODEL_DESCRIPTION = "Summarizes uncommitted changes at startup. Always called with thinking off, so the thinking level is ignored; pick a cheap, fast model.";
const PICKER_HINTS = "type to filter · ↑↓ move · tab/←→ switch pane · enter select · esc back";

/**
 * Open the two-pane model picker the startup gate uses; undefined means Escape/cancel. Its
 * thinking pane is part of the shared component, but the summary never uses a thinking level,
 * so only the model is returned. Pi 1.5.1+ reports blocked until the picker settles; closing it
 * restores the settings menu's status underneath.
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
			const picker = createSplashModelPicker(theme, ctx, refs, "off", preselected);
			return {
				render: (width: number) => {
					// `renderPopupBox` pads its interior to exactly `width - 4`, which is what the picker emits.
					const bodyWidth = Math.max(1, width - 4);
					return renderPopupBox(theme, Math.max(width, 1), SUMMARY_MODEL_TITLE, [
						...wrapTextWithAnsi(theme.fg("muted", SUMMARY_MODEL_DESCRIPTION), bodyWidth),
						"",
						...renderSplashModelPicker(picker, bodyWidth),
						...renderFooter(theme, picker, bodyWidth, PICKER_HINTS),
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
		{ overlay: true, overlayOptions: { width: GATE_PANEL_MAX_WIDTH, maxHeight: "100%" }, blocked: { kind: "question", message: SUMMARY_MODEL_TITLE } },
	);
}

/** The settings as the `showMenu` fallback returns them, in the extension's own types. */
function fromMenuValues(values: SplashSettingsValues, summaryModel: ModelRef | undefined): AppliedSettings {
	return {
		menuGate: values.menuGate,
		taglineReveal: values.taglineReveal,
		backgroundColor: values.backgroundColor,
		gradientAnimation: values.gradientAnimation,
		logoStyle: values.logoStyle,
		changesSummary: values.changesSummary,
		// A row cleared back to the session model drops the pinned ref its label was showing.
		changesSummaryModel: values.changesSummaryModel === SESSION_MODEL_LABEL ? undefined : summaryModel,
	};
}

/** The `showMenu` settings dialog: the fallback for a terminal too small for the generated one. */
async function showSettingsMenu(ctx: ExtensionContext, prefs: SplashPreferences): Promise<AppliedSettings | null> {
	// The pinned ref behind the Summary model row's label; the row itself only holds the label.
	let summaryModel = prefs.changesSummaryModel;
	// Primitives showMenu reports the menu title as blocked on Pi 1.5.1+; closing the menu restores the status underneath (the gate's, or idle).
	const result = await showMenu<SplashSettingsValues>(ctx, {
		title: "Pi Topping Splash: Settings",
		sections: [
			{
				title: "Startup Gate",
				items: [{ kind: "toggle", id: "menuGate", label: "Startup gate menu", value: prefs.menuGate === "on" }],
			},
			{
				title: "Splash Banner",
				items: [
					{ kind: "cycle", id: "backgroundColor", label: "Background color", value: prefs.backgroundColor, values: BACKGROUND_COLOR_OPTIONS },
					{ kind: "cycle", id: "gradientAnimation", label: "Animate gradient", value: prefs.gradientAnimation, values: GRADIENT_ANIMATION_OPTIONS },
					{ kind: "cycle", id: "logoStyle", label: "Logo style", value: prefs.logoStyle ?? "random", values: LOGO_STYLE_OPTIONS },
				],
			},
			{
				title: "Info Panel",
				items: [
					{ kind: "toggle", id: "taglineReveal", label: "Model + prompt size reveal animation", value: prefs.taglineReveal === "on" },
					{ kind: "toggle", id: "changesSummary", label: "Summarize uncommitted changes", value: prefs.changesSummary === "on" },
					{
						kind: "pick",
						id: "changesSummaryModel",
						label: "Summary model",
						value: summaryModel ? modelRefLabel(summaryModel) : SESSION_MODEL_LABEL,
						clearValue: SESSION_MODEL_LABEL,
					},
				],
			},
		],
		buttons: [
			{ id: "apply", label: "Apply", applies: true, primary: true },
			{ id: "cancel", label: "Cancel", closeOnAction: true },
		],
		hints: ["\u2191\u2193 move", "\u2423 toggle", "\u2190\u2192 cycle", "\u23ce pick", "\u232b clear", "\u21e5 actions", "esc cancel"],
		// The picker opens over the still-mounted menu, which ignores keys until this settles.
		onPick: async (_id, values) => {
			// Backspace resets only the row's label, so a cleared row starts the picker on the session model.
			const picked = await pickSummaryModel(ctx, values.changesSummaryModel === SESSION_MODEL_LABEL ? undefined : summaryModel);
			if (!picked) return undefined;
			summaryModel = picked;
			return modelRefLabel(picked);
		},
	});
	return result.applied ? fromMenuValues(result.values, summaryModel) : null;
}

/** Open the splash settings TUI and persist changes on apply. */
export async function showSplashSettings(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/topping-splash-settings requires TUI mode", "error");
		return;
	}

	const prefs = readPreferences();
	// The generated dialog has a fixed size. A terminal too small for it keeps the menu, which fits any size.
	const fromDialog = dialogFits(await readTerminalSize(ctx), SETTINGS_DIALOG_SIZE) ? await openSettingsDialog(ctx, prefs) : undefined;
	// Undefined also when the dialog failed. It has said so and saved nothing, and the menu keeps the settings reachable.
	const applied = fromDialog === undefined ? await showSettingsMenu(ctx, prefs) : fromDialog;
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
