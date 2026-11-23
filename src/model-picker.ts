import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelRefLabel, type ModelRef } from "@underactive/pi-topping-primitives/models";

export { modelRefLabel, type ModelRef, type ThinkingLevel } from "@underactive/pi-topping-primitives/models";

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
