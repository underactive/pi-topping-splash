/**
 * Adapter between the splash preferences and the generated `/topping-splash-settings` dialog.
 *
 * Hand-written. The dialog itself is `./generated/splash/settings-dialog.ts`, converted from the
 * mockup in `../pi-topping-mockups`; this file only translates data in and the result out.
 */
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMMON_THINKING_LEVELS, defaultThinkingForModel, thinkingOptionsForModel, type ThinkingLevel } from "@underactive/pi-topping-primitives/models";
import { showOpenTuiDialog } from "@underactive/pi-topping-opentui/host";
import { createElement } from "react";
import type { BackgroundColor, GradientAnimation } from "../color.ts";
import type { LogoStyle } from "../logo.ts";
import { availableModelRefs, modelRefLabel, type ModelRef } from "../model-picker.ts";
import type { SplashPreferences } from "../preferences.ts";
import { DIALOG_MAX_HEIGHT, SETTINGS_DIALOG_WIDTH } from "./dialog-size.ts";
import type { Level as DialogLevel, Model as DialogModel, SplashPrefs as DialogPrefs } from "./generated/splash/data.ts";
import { SplashSettings, type SplashSettingsResult } from "./generated/splash/settings-dialog.ts";

/** Reported to pi as the question the session is blocked on while the dialog is open. */
export const SETTINGS_DIALOG_TITLE = "Pi Topping Splash: Settings";

/** What the user chose, in the extension's own types. */
export interface AppliedSettings {
	menuGate: boolean;
	taglineReveal: boolean;
	backgroundColor: BackgroundColor;
	gradientAnimation: GradientAnimation;
	logoStyle: LogoStyle;
	changesSummary: boolean;
	/** `undefined` while the summary uses the session's model. */
	changesSummaryModel: ModelRef | undefined;
}

export interface SettingsDialogProps {
	initial: DialogPrefs;
	models: DialogModel[];
	/** Left out when the session has no model; the picker then starts on its first one. */
	sessionModelId?: string;
}

/** The dialog identifies a model by one string; `provider/id` is unique where an id alone is not. */
const modelKey = modelRefLabel;

/** How the picker's thinking pane describes each level pi can offer. */
const LEVEL_INFO: Record<ThinkingLevel, DialogLevel> = {
	off: { id: "off", label: "Off", depth: 0, desc: "Answer directly, no extended thinking" },
	minimal: { id: "minimal", label: "Minimal", depth: 1, desc: "Fastest, barely any reasoning" },
	low: { id: "low", label: "Low", depth: 1, desc: "Brief check before answering" },
	medium: { id: "medium", label: "Medium", depth: 2, desc: "Balanced depth for everyday tasks" },
	high: { id: "high", label: "High", depth: 3, desc: "Thorough, for complex multi-step work" },
	xhigh: { id: "xhigh", label: "XHigh", depth: 4, desc: "Very deep reasoning; slow" },
	max: { id: "max", label: "Max", depth: 4, desc: "Deepest reasoning; slowest, priciest" },
};

/**
 * A registry model in the dialog's shape. `supported` is what the registry reports for it, or
 * `undefined` for a model pi does not list, which gets no thinking pane content. The summary never
 * uses a thinking level, so the pane only shows what the model offers and nothing reads the choice.
 */
function toDialogModel(ref: ModelRef, supported?: readonly string[]): DialogModel {
	if (!supported) return { id: modelKey(ref), name: ref.id, provider: ref.provider, tags: [], levels: null };
	const options = thinkingOptionsForModel(supported, { fallback: COMMON_THINKING_LEVELS });
	return {
		id: modelKey(ref),
		name: ref.id,
		provider: ref.provider,
		tags: [],
		levels: options.map((level) => LEVEL_INFO[level]),
		defaultLevel: defaultThinkingForModel(modelKey(ref), {}, "off", supported),
	};
}

/**
 * The models the dialog lists: the registry's, plus the pinned one when pi no longer offers it
 * (its credentials were removed, say), so the row keeps naming it instead of showing an empty key.
 * `levelsOf` reads the levels the registry reports for one model.
 */
export function toDialogModels(
	refs: readonly ModelRef[],
	pinned?: ModelRef,
	levelsOf: (ref: ModelRef) => readonly string[] | undefined = () => undefined,
): DialogModel[] {
	const models = refs.map((ref) => toDialogModel(ref, levelsOf(ref)));
	if (pinned && !models.some((model) => model.id === modelKey(pinned))) models.push(toDialogModel(pinned));
	return models;
}

export function toDialogPrefs(prefs: SplashPreferences): DialogPrefs {
	return {
		menuGate: prefs.menuGate === "on",
		taglineReveal: prefs.taglineReveal === "on",
		backgroundColor: prefs.backgroundColor,
		gradientAnimation: prefs.gradientAnimation,
		logoStyle: prefs.logoStyle ?? "random",
		changesSummary: prefs.changesSummary === "on",
		changesSummaryModel: prefs.changesSummaryModel ? modelKey(prefs.changesSummaryModel) : null,
	};
}

/**
 * The dialog's result in the extension's types. A model key the dialog could not have been given
 * resolves to `undefined`, the session model, rather than to a made-up reference.
 */
export function fromDialogPrefs(values: DialogPrefs, models: readonly ModelRef[], pinned?: ModelRef): AppliedSettings {
	const known = pinned ? [...models, pinned] : models;
	const changesSummaryModel = values.changesSummaryModel === null
		? undefined
		: known.find((ref) => modelKey(ref) === values.changesSummaryModel);
	return {
		menuGate: values.menuGate,
		taglineReveal: values.taglineReveal,
		backgroundColor: values.backgroundColor as BackgroundColor,
		gradientAnimation: values.gradientAnimation as GradientAnimation,
		logoStyle: values.logoStyle as LogoStyle,
		changesSummary: values.changesSummary,
		changesSummaryModel: changesSummaryModel && { provider: changesSummaryModel.provider, id: changesSummaryModel.id },
	};
}

/** The thinking levels the registry reports for `ref`; undefined when it does not list the model. */
export function registryLevels(ctx: ExtensionContext, ref: ModelRef): readonly string[] | undefined {
	const model = ctx.modelRegistry.find(ref.provider, ref.id);
	return model ? getSupportedThinkingLevels(model) : undefined;
}

/** The registry's models, or none when it cannot be read: a registry read is display-only. */
function readModelRefs(ctx: ExtensionContext): ModelRef[] {
	try {
		return availableModelRefs(ctx);
	} catch {
		return [];
	}
}

/**
 * Show the generated settings dialog. Resolves with what the user applied, or `null` when they
 * cancelled. Also `null` when the dialog failed: the failure has been reported to the user by
 * then, so the command handler never sees it thrown, and nothing was applied.
 */
export async function openSettingsDialog(ctx: ExtensionContext, prefs: SplashPreferences): Promise<AppliedSettings | null> {
	try {
		const refs = readModelRefs(ctx);
		const pinned = prefs.changesSummaryModel;
		const props: SettingsDialogProps = {
			initial: toDialogPrefs(prefs),
			models: toDialogModels(refs, pinned, (ref) => registryLevels(ctx, ref)),
			...(ctx.model ? { sessionModelId: modelKey({ provider: ctx.model.provider, id: ctx.model.id }) } : {}),
		};
		const result = await showOpenTuiDialog<SplashSettingsResult>(
			ctx,
			(done) => createElement(SplashSettings, { ...props, onDone: done }),
			{
				title: SETTINGS_DIALOG_TITLE,
				width: SETTINGS_DIALOG_WIDTH,
				maxHeight: DIALOG_MAX_HEIGHT,
				fallback: { applied: false, values: props.initial, changes: 0 },
			},
		);
		return result.applied ? fromDialogPrefs(result.values, refs, pinned) : null;
	} catch (error) {
		ctx.ui.notify(`Pi Topping Splash settings dialog failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}
}
