/**
 * Adapter between the startup gate's View system prompt action and the generated OpenTUI system
 * prompt viewer.
 *
 * Hand-written. The viewer itself is `./generated/splash/system-prompt-view.ts`, converted from
 * the mockup in `../pi-topping-mockups`; this file only reads the prompt and opens the dialog, the
 * way `./model-picker-dialog.ts` opens the model picker. It opens as a capturing overlay above
 * the gate, so the gate keeps rendering the menu beneath while the viewer owns input.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showOpenTuiDialog } from "@underactive/pi-topping-opentui/host";
import { createElement } from "react";
import { DIALOG_MAX_HEIGHT } from "./dialog-size.ts";
import { SystemPromptViewer } from "./generated/splash/system-prompt-view.ts";

/** Reported to pi as the question the session is blocked on while the view is open. */
export const SYSTEM_PROMPT_DIALOG_TITLE = "System Prompt";

/** Overlay width: the generated viewer's full size. */
const SYSTEM_PROMPT_VIEWER_WIDTH = 110;

/**
 * Show the generated system prompt viewer and resolve when it closes. Swallows its own failure:
 * the view is display-only, and the failure has been reported to the user by then.
 */
export async function showSystemPromptDialog(ctx: ExtensionContext): Promise<void> {
	let prompt = "";
	try {
		prompt = ctx.getSystemPrompt();
	} catch { /* display-only, like the splash's prompt-size line */ }
	try {
		await showOpenTuiDialog<void>(
			ctx,
			(done) => createElement(SystemPromptViewer, {
				prompt,
				width: SYSTEM_PROMPT_VIEWER_WIDTH,
				onDone: done,
			}),
			{ title: SYSTEM_PROMPT_DIALOG_TITLE, width: SYSTEM_PROMPT_VIEWER_WIDTH, maxHeight: DIALOG_MAX_HEIGHT, fallback: undefined },
		);
	} catch (error) {
		ctx.ui.notify(`Pi Topping Splash system prompt view failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}
