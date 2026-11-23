/**
 * Adapter between the startup gate's Model action and the generated OpenTUI model picker.
 *
 * Hand-written. The picker itself is `./generated/splash/model-picker.ts`, converted from the
 * mockup in `../opentui-dialogs`; this file only translates data in and the result out, the way
 * `./settings-dialog.ts` does for settings. It opens as a capturing overlay above the gate,
 * like Settings and the system prompt view, so the gate keeps rendering the menu beneath.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isThinkingLevel, type ThinkingLevel } from "@underactive/pi-topping-primitives/models";
import { showOpenTuiDialog } from "@underactive/pi-topping-opentui/host";
import { createElement } from "react";
import { availableModelRefs, modelRefLabel, type ModelRef } from "../model-picker.ts";
import { DIALOG_MAX_HEIGHT, MODEL_PICKER_WIDTH } from "./dialog-size.ts";
import { ModelPickerPopup } from "./generated/splash/model-picker.ts";
import { registryLevels, toDialogModels } from "./settings-dialog.ts";

/** Reported to pi as the question the session is blocked on while the picker is open. */
export const MODEL_PICKER_DIALOG_TITLE = "Select Model";

/** What the user picked, in the extension's own types. */
export interface ModelPickerResult {
	model: ModelRef;
	/** Null when the picked model exposes no thinking control. */
	thinking: ThinkingLevel | null;
}

/**
 * Show the generated model picker over the gate. Resolves with the picked model and thinking
 * level, or `null` when cancelled. Also `null` when the dialog failed: the failure has been
 * reported to the user by then, and nothing was applied.
 */
export async function showModelPickerDialog(ctx: ExtensionContext, currentThinking: ThinkingLevel): Promise<ModelPickerResult | null> {
	try {
		// The registry is display-only: a read failure opens an empty picker, not an error.
		let refs: ModelRef[];
		try {
			refs = availableModelRefs(ctx);
		} catch {
			refs = [];
		}
		// Keep naming the session model even if pi no longer offers it (credentials removed, say).
		const pinned = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		const models = toDialogModels(refs, pinned, (ref) => registryLevels(ctx, ref));
		const result = await showOpenTuiDialog<{ id: string; level: string | null } | null>(
			ctx,
			(done) => createElement(ModelPickerPopup, {
				title: MODEL_PICKER_DIALOG_TITLE,
				models,
				currentId: pinned ? modelRefLabel(pinned) : "",
				currentLevel: currentThinking,
				withThinking: true,
				width: MODEL_PICKER_WIDTH,
				onDone: done,
			}),
			{
				title: MODEL_PICKER_DIALOG_TITLE,
				width: MODEL_PICKER_WIDTH,
				maxHeight: DIALOG_MAX_HEIGHT,
				fallback: null,
			},
		);
		if (!result) return null;
		// The dialog identifies a model by `provider/id`, the same key `toDialogModels` built;
		// resolve it against the refs (pinned included) rather than parsing the string back.
		const known = pinned && !refs.some((ref) => ref.provider === pinned.provider && ref.id === pinned.id)
			? [...refs, pinned]
			: refs;
		const model = known.find((ref) => modelRefLabel(ref) === result.id);
		if (!model) return null;
		return { model, thinking: result.level && isThinkingLevel(result.level) ? result.level : null };
	} catch (error) {
		ctx.ui.notify(`Pi Topping Splash model picker failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}
}
