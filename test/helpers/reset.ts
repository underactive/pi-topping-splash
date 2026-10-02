import { changesRenderState, headerRenderState, state } from "../../src/state.ts";
import { abortChangesSummary, summaryStream } from "../../src/changes-summary.ts";
import { gradientAnimation, stopGradientAnimation } from "../../src/animate.ts";
import {
	REVEAL_BAND_HALF,
	REVEAL_HOLD_MS,
	stopTaglineReveal,
	TAGLINE_PLACEHOLDER,
	taglineReveal,
} from "../../src/reveal.ts";

/**
 * state.ts, reveal.ts, animate.ts, and the summary stream hold process-lifetime mutable state;
 * node --test runs one process per file, so cross-file isolation is free, but within a file every
 * test must start clean.
 */
export function resetModuleState(): void {
	abortChangesSummary();
	summaryStream.lastTickAt = 0;
	summaryStream.shown = Number.POSITIVE_INFINITY;
	summaryStream.total = 0;
	summaryStream.tick = 0;
	stopTaglineReveal();
	stopGradientAnimation();
	gradientAnimation.lastTickAt = 0;
	gradientAnimation.timeMs = 0;
	gradientAnimation.tick = 0;
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
	state.loadedContext = [];
	state.loadedPrompts = [];
	state.loadedShortcuts = [];
	state.systemPromptSize = undefined;
	state.splashRows = 0;
	state.changes = null;
	state.changesStarted = false;
	changesRenderState.requestRender = null;
	state.backgroundColor = "rainbow";
	state.dynamicTint = "accent";
	state.gradientAnimation = "off";
	state.conversationStarted = false;
}
