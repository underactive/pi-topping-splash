import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { headerRenderState, state } from "./src/state.ts";
import { stopTaglineReveal } from "./src/reveal.ts";
import { stopGradientAnimation } from "./src/animate.ts";
import { ensureQuietStartup, installHeader } from "./src/header.ts";
import { abortChangesSummary, installChangesHeader, startChangesSummary, stopSummaryStream } from "./src/changes-summary.ts";
import { readPreferences } from "./src/preferences.ts";
import { GATE_DONE_ENV } from "./src/relaunch.ts";
import { runStartupGate } from "./src/gate.ts";
import { showSplashSettings } from "./src/settings.ts";
import { abortLocalChanges, registerLocalChanges } from "./src/local-changes.ts";

function refreshPromptSize(systemPrompt: string): void {
	const newSize = Buffer.byteLength(systemPrompt, "utf8");
	if (newSize === state.systemPromptSize) return;
	state.systemPromptSize = newSize;
	headerRenderState.invalidate?.();
	headerRenderState.requestRender?.();
}

/** Pi extension: installs the splash, optional startup gate, and on-by-default startup changes summary. It registers /topping-splash-settings and /local-changes. */
export default function piStartupGreeter(pi: ExtensionAPI) {
	pi.on("model_select", (_event, ctx) => {
		// Model rotation may change the base system prompt — refresh the size.
		// Guard against calls before the model is fully initialized.
		try {
			refreshPromptSize(ctx.getSystemPrompt());
		} catch (err) {
			if (!(err instanceof Error && /not (?:available|ready)/i.test(err.message))) throw err;
		}
	});

	pi.on("session_shutdown", () => {
		abortChangesSummary();
		abortLocalChanges();
		stopGradientAnimation();
		stopTaglineReveal();
	});

	pi.on("before_agent_start", (event) => {
		if (!state.conversationStarted) {
			state.conversationStarted = true;
			stopGradientAnimation();
			stopTaglineReveal();
			// The header scrolls away from here, so a summary still streaming settles instead of redrawing it.
			stopSummaryStream();
		}
		refreshPromptSize(event.systemPrompt);
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
		if (!shouldGate) { stopGradientAnimation(); return; }

		// Install the splash header so it renders at the top during the gate (a non-overlay
		// custom component replaces only the editor region below it), then clear the terminal
		// so the splash starts at the very top of the window instead of inline below leftover
		// shell output.
		const prefs = readPreferences();
		installHeader(pi, ctx, prefs);
		headerRenderState.forceRedraw?.();
		// Start before the menuGate off-return so splash-only launches receive the same listing.
		startChangesSummary(pi, ctx, prefs);

		// Splash-only mode: keep the header wired (model/prompt-size lines keep refreshing)
		// and open the editor beneath it. The tagline reveal stops itself when the wipe ends.
		if (prefs.menuGate === "off") return;

		const resolution = await runStartupGate(pi, ctx);
		stopTaglineReveal();
		stopGradientAnimation();
		if (resolution === "quit") {
			ctx.shutdown();
			return;
		}
		// "proceed" (New session / esc): stop the splash, but retain a slim changes-only header
		// unless the changes summary is turned off.
		const clearScreen = headerRenderState.forceRedraw;
		if (readPreferences().changesSummary === "on") installChangesHeader(ctx);
		else ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
		headerRenderState.invalidate = null;
		headerRenderState.requestRender = null;
		headerRenderState.forceRedraw = null;
		clearScreen?.();
	});

	pi.registerCommand("topping-splash-settings", {
		description: "Configure the startup splash header and gate menu.",
		handler: async (_args, ctx) => {
			await showSplashSettings(ctx);
		},
	});
	registerLocalChanges(pi);
}
