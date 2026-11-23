/**
 * Adapter between the startup gate's Theme action and the generated OpenTUI theme picker.
 *
 * Hand-written. The picker itself is `./generated/splash/theme-picker.ts`, converted from the
 * mockup in `../opentui-dialogs`; this file only translates themes in and the chosen name out,
 * the way `./model-picker-dialog.ts` does for the model picker. It opens as a capturing overlay
 * above the gate, like Settings and the system prompt view, so the gate keeps rendering the menu
 * beneath. Live preview works through `ctx.ui.setTheme` with a Theme *instance* (in-memory, not
 * persisted); the string form persists, and cancel restores the theme that was active on open.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showOpenTuiDialog } from "@underactive/pi-topping-opentui/host";
import { createElement } from "react";
import { headerRenderState } from "../state.ts";
import { DIALOG_MAX_HEIGHT } from "./dialog-size.ts";
import { ThemePickerPopup } from "./generated/splash/theme-picker.ts";

/** Reported to pi as the question the session is blocked on while the picker is open. */
export const THEME_PICKER_DIALOG_TITLE = "Select Theme";

/** Overlay width: the generated picker's full size. */
const THEME_PICKER_WIDTH = 56;

/**
 * Show the generated theme picker over the gate. Resolves with the chosen theme name — already
 * persisted to settings — or `null` when cancelled (the preview is restored). Also `null` when
 * the dialog failed: the failure has been reported to the user by then, and nothing changed.
 */
export async function showThemePickerDialog(ctx: ExtensionContext): Promise<string | null> {
	try {
		// The registry is display-only: a read failure opens an empty picker, not an error.
		let themes: string[];
		try {
			themes = ctx.ui.getAllThemes().map((entry) => entry.name).filter((name): name is string => Boolean(name));
		} catch {
			themes = [];
		}
		// `ctx.ui.theme` is a live proxy to the global theme, so `.name` is the effective
		// current theme even when the user never persisted one in settings.
		const saved = ctx.ui.theme.name;
		let previewed = false;
		const preview = (name: string | null) => {
			if (!name || !saved) return;
			try {
				const loaded = ctx.ui.getTheme(name);
				if (loaded) {
					ctx.ui.setTheme(loaded);
					previewed = true;
					headerRenderState.invalidate?.();
				}
			} catch { /* keep the current theme */ }
		};
		const result = await showOpenTuiDialog<string | null>(
			ctx,
			(done) => createElement(ThemePickerPopup, {
				themes,
				current: saved ?? "",
				width: THEME_PICKER_WIDTH,
				onPreview: preview,
				onDone: done,
			}),
			{ title: THEME_PICKER_DIALOG_TITLE, width: THEME_PICKER_WIDTH, maxHeight: DIALOG_MAX_HEIGHT, fallback: null },
		);
		if (result !== null) {
			// String form: switches the theme and persists the choice to settings.
			ctx.ui.setTheme(result);
			headerRenderState.invalidate?.();
			return result;
		}
		// Abandon any preview: restore the theme that was active when the popup opened.
		if (previewed && saved) {
			ctx.ui.setTheme(saved);
			headerRenderState.invalidate?.();
		}
		return null;
	} catch (error) {
		ctx.ui.notify(`Pi Topping Splash theme picker failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}
}
