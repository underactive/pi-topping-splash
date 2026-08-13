import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_COLOR_OPTIONS, type BackgroundColor } from "./src/color.ts";
import { headerRenderState, state } from "./src/state.ts";
import { stopTaglineReveal } from "./src/reveal.ts";
import { ensureQuietStartup, installHeader } from "./src/header.ts";
import { showMenu } from "./src/menu.ts";
import { readPreferences, writePreferences } from "./src/preferences.ts";
import { GATE_DONE_ENV } from "./src/relaunch.ts";
import { runStartupGate } from "./src/gate.ts";

export default function piStartupGreeter(pi: ExtensionAPI) {
	pi.on("model_select", (_event, ctx) => {
		// Model rotation may change the base system prompt — refresh the size.
		// Guard against calls before the model is fully initialized.
		try {
			const newSize = Buffer.byteLength(ctx.getSystemPrompt(), "utf8");
			if (newSize !== state.systemPromptSize) {
				state.systemPromptSize = newSize;
			}
		} catch (err) {
			if (!(err instanceof Error && /not (?:available|ready)/i.test(err.message))) throw err;
		}
		headerRenderState.invalidate?.();
		headerRenderState.requestRender?.();
	});

	pi.on("before_agent_start", (event) => {
		const newSize = Buffer.byteLength(event.systemPrompt, "utf8");
		if (newSize !== state.systemPromptSize) {
			state.systemPromptSize = newSize;
			headerRenderState.invalidate?.();
			headerRenderState.requestRender?.();
		}
	});

	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;

		if (!state.quietStartupEnsured) {
			state.quietStartupEnsured = true;
			const changed = ensureQuietStartup(ctx.cwd);
			if (changed) {
				ctx.ui.notify("Enabled quietStartup for future Pi launches", "info");
			}
		}

		// Only gate a genuine fresh startup: never on reload, and never on a relaunched child
		// (GATE_DONE_ENV guard). Non-gated sessions start clean, without the splash.
		const shouldGate = event.reason === "startup" && process.env[GATE_DONE_ENV] !== "1";
		if (!shouldGate) return;

		// Install the splash header so it renders at the top during the gate (a non-overlay
		// custom component replaces only the editor region below it), then clear the terminal
		// so the splash starts at the very top of the window instead of inline below leftover
		// shell output.
		installHeader(pi, ctx);
		headerRenderState.forceRedraw?.();

		// Splash-only mode: keep the header wired (model/prompt-size lines keep refreshing)
		// and open the editor beneath it. The tagline reveal stops itself when the wipe ends.
		if (readPreferences().menuGate === "off") return;

		const resolution = await runStartupGate(pi, ctx);
		if (resolution === "quit") {
			ctx.shutdown();
			return;
		}
		// "proceed" (New session / esc): swap the splash for an empty header and clear again
		// so the session itself starts at the top of a clean screen, without the logo.
		stopTaglineReveal();
		const clearScreen = headerRenderState.forceRedraw;
		ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
		headerRenderState.invalidate = null;
		headerRenderState.requestRender = null;
		headerRenderState.forceRedraw = null;
		clearScreen?.();
	});

	pi.registerCommand("topping-splash-settings", {
		description: "Configure the startup splash header and gate menu.",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/topping-splash-settings requires TUI mode", "error");
				return;
			}

			const prefs = readPreferences();
			const result = await showMenu<{ menuGate: boolean; taglineReveal: boolean; backgroundColor: string }>(ctx, {
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
						],
					},
				],
				hints: ["\u2191\u2193 move", "\u2423 toggle", "\u2190\u2192 cycle", "\u23ce apply", "esc cancel"],
			});
			if (!result.applied) return;

			const backgroundColor = result.values.backgroundColor as BackgroundColor;
			// The gate toggle is read during session_start, so it lands on the next launch; the
			// background is also applied immediately below, to a splash that may already be visible.
			if (writePreferences({ menuGate: result.values.menuGate ? "on" : "off", taglineReveal: result.values.taglineReveal ? "on" : "off", backgroundColor })) {
				ctx.ui.notify("Pi Topping Splash settings saved", "info");
				state.backgroundColor = backgroundColor;
				headerRenderState.invalidate?.();
				headerRenderState.requestRender?.();
			} else {
				ctx.ui.notify("Failed to save Pi Topping Splash settings", "error");
			}
		},
	});
}
