import { headerRenderState, state } from "../../src/state.ts";
import {
	REVEAL_BAND_HALF,
	REVEAL_HOLD_MS,
	stopTaglineReveal,
	TAGLINE_PLACEHOLDER,
	taglineReveal,
} from "../../src/reveal.ts";

/**
 * state.ts and reveal.ts hold process-lifetime mutable state; node --test runs one process
 * per file, so cross-file isolation is free, but within a file every test must start clean.
 */
export function resetModuleState(): void {
	stopTaglineReveal();
	taglineReveal.timer = null;
	taglineReveal.lastTickAt = 0;
	taglineReveal.holdLeftMs = REVEAL_HOLD_MS;
	taglineReveal.pos = -REVEAL_BAND_HALF;
	taglineReveal.tick = 0;
	taglineReveal.fieldWidth = TAGLINE_PLACEHOLDER.length;
	headerRenderState.invalidate = null;
	headerRenderState.requestRender = null;
	headerRenderState.forceRedraw = null;
	state.quietStartupEnsured = false;
	state.loadedSkills = [];
	state.loadedExtensions = [];
	state.systemPromptSize = undefined;
	state.splashRows = 0;
	state.backgroundColor = "rainbow";
}
