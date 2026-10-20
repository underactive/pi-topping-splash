import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	COMMON_THINKING_LEVELS,
	defaultThinkingForModel,
	fuzzyRanked,
	modelRefLabel,
	thinkingOptionsForModel,
	TwoPaneModelThinking,
	type ModelRef,
	type ThinkingLevel,
} from "@underactive/pi-topping-primitives/models";
import { sanitizeTuiText } from "./text.ts";
import { GATE_LIST_HEIGHT } from "./gate-ui.ts";

export { modelRefLabel, type ModelRef, type ThinkingLevel, type TwoPaneModelThinking } from "@underactive/pi-topping-primitives/models";

/**
 * Every registry model as a provider/id pair, sorted by the label the picker displays.
 * Read live on every open (not the shared cached catalogue): pi refreshes its registry
 * in place after a login or a models.json reload.
 */
export function availableModelRefs(ctx: ExtensionContext): ModelRef[] {
	return ctx.modelRegistry
		.getAvailable()
		.map((model) => ({ provider: model.provider, id: model.id }))
		.sort((a, b) => modelRefLabel(a).localeCompare(modelRefLabel(b)));
}

/** The registry's levels for `ref`, looked up live; unknown or level-less models get the common four. */
function liveLevelOptions(ctx: ExtensionContext): (ref: ModelRef) => ThinkingLevel[] {
	return (ref) => {
		const model = ctx.modelRegistry.find(ref.provider, ref.id);
		return thinkingOptionsForModel(model ? getSupportedThinkingLevels(model) : undefined, { fallback: COMMON_THINKING_LEVELS });
	};
}

/** Render-pure: gate and settings owners schedule their own repaint after dispatching. */
export function createSplashModelPicker(
	theme: Theme,
	ctx: ExtensionContext,
	refs: ModelRef[],
	currentThinking: ThinkingLevel,
	defaultRef?: ModelRef,
): TwoPaneModelThinking {
	return new TwoPaneModelThinking({
		theme,
		refs,
		defaultRef,
		filter: fuzzyRanked,
		highlightSelectedRow: false,
		marker: "→ ",
		itemLabel: (ref) => sanitizeTuiText(modelRefLabel(ref)) || "(invalid model)",
		levelOptions: liveLevelOptions(ctx),
		preferredLevel: (ref, options) => defaultThinkingForModel(modelRefLabel(ref), {}, currentThinking, options),
		maxVisibleRows: GATE_LIST_HEIGHT + 2,
	});
}

/** Reserve header, potential scroll row and optional filter outside the ten model rows. */
export function renderSplashModelPicker(picker: TwoPaneModelThinking, bodyWidth: number): string[] {
	const { filter } = picker.snapshot();
	picker.setMaxVisibleRows(GATE_LIST_HEIGHT + 2 + (filter ? 1 : 0));
	return picker.render(bodyWidth);
}

/** Splash owns the rule sandwich; shared buttons and wrapped hints stay unframed. */
export function renderFooter(theme: Theme, picker: TwoPaneModelThinking, bodyWidth: number, hints: string): string[] {
	const { actionRow, hintRows } = picker.renderFooter(bodyWidth, hints);
	const rule = theme.fg("border", "─".repeat(bodyWidth));
	return [rule, actionRow, rule, ...hintRows];
}
