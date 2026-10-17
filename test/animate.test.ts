import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GRADIENT_TICK_MS, LOGO_TICK_MS, gradientAnimation, logoAnimation, startGradientAnimation, startLogoAnimation, stopGradientAnimation, stopLogoAnimation } from "../src/animate.ts";
import { INSTALLER_LOGO_DURATION_MS, INSTALLER_LOGO_LAST_FRAME } from "../src/installer-logo.ts";
import { headerRenderState } from "../src/state.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { enableTimers } from "./helpers/timers.ts";

const importedLogoFrame = logoAnimation.frame;

beforeEach(() => resetModuleState());
afterEach(() => {
	stopGradientAnimation();
	stopLogoAnimation();
});

describe("gradient animation ticker (A-01, A-02)", () => {
	it("GRADIENT_TICK_MS matches the documented cadence", () => {
		assert.equal(GRADIENT_TICK_MS, 100);
	});

	it("advances the clock, bumps the repaint key and requests a render per tick", (t) => {
		const timers = enableTimers(t);
		let renders = 0;
		headerRenderState.requestRender = () => {
			renders++;
		};
		startGradientAnimation();
		for (let i = 0; i < 10; i++) {
			timers.tick(GRADIENT_TICK_MS);
		}
		assert.equal(gradientAnimation.timeMs, 10 * GRADIENT_TICK_MS);
		assert.equal(gradientAnimation.tick, 10);
		assert.equal(renders, 10);
	});

	it("a 2000ms event-loop block advances the clock by a capped step (R-05 pattern)", (t) => {
		const timers = enableTimers(t);
		startGradientAnimation();
		for (let i = 0; i < 3; i++) {
			timers.tick(GRADIENT_TICK_MS);
		}
		const before = gradientAnimation.timeMs;
		timers.tick(2000);
		const jump = gradientAnimation.timeMs - before;
		assert.ok(jump <= GRADIENT_TICK_MS * 2, `2000ms block advanced the clock ${jump}ms — uncapped math would advance 2000`);
	});

	it("loops forever: hundreds of ticks never stop the timer", (t) => {
		const timers = enableTimers(t);
		startGradientAnimation();
		for (let i = 0; i < 500; i++) {
			timers.tick(GRADIENT_TICK_MS);
		}
		assert.notEqual(gradientAnimation.timer, null, "the animation must not stop itself");
	});
});

describe("logo animation ticker (A-04..A-06)", () => {
	it("initializes idle state on the last source frame", () => {
		assert.equal(importedLogoFrame, INSTALLER_LOGO_LAST_FRAME);
	});

	it("advances on hold boundaries and requests renders only when the frame changes", (t) => {
		const timers = enableTimers(t);
		let renders = 0;
		headerRenderState.requestRender = () => { renders++; };
		startLogoAnimation();
		assert.equal(logoAnimation.frame, 0);
		assert.equal(renders, 1, "fresh start paints frame zero");
		for (let index = 0; index < 3; index++) timers.tick(LOGO_TICK_MS);
		assert.equal(logoAnimation.frame, 0, "the first hold is 75ms");
		assert.equal(renders, 1, "clock ticks without frame changes do not repaint");
		timers.tick(LOGO_TICK_MS);
		assert.equal(logoAnimation.frame, 1, "the next tick crosses the 75ms boundary");
		assert.equal(renders, 2);
		assert.equal(logoAnimation.tick, 2);
	});

	it("caps a late step so the animation pauses instead of skipping frames", (t) => {
		const timers = enableTimers(t);
		startLogoAnimation();
		logoAnimation.lastTickAt = Date.now() - 2000;
		timers.tick(LOGO_TICK_MS);
		assert.equal(logoAnimation.timeMs, LOGO_TICK_MS * 2);
		assert.equal(logoAnimation.frame, 0);
	});

	it("plays once and holds the final source frame on stop/completion", (t) => {
		const timers = enableTimers(t);
		let renders = 0;
		headerRenderState.requestRender = () => { renders++; };
		startLogoAnimation();
		timers.tick(100);
		const runningTimer = logoAnimation.timer;
		const time = logoAnimation.timeMs;
		startLogoAnimation();
		assert.equal(logoAnimation.timer, runningTimer, "active start is idempotent");
		assert.equal(logoAnimation.timeMs, time, "active start preserves progress");
		const rendersBeforeStop = renders;
		stopLogoAnimation();
		assert.equal(logoAnimation.timer, null);
		assert.equal(logoAnimation.frame, INSTALLER_LOGO_LAST_FRAME);
		assert.equal(renders, rendersBeforeStop + 1, "stopping away from the last frame repaints once");
		const rendersAfterStop = renders;
		stopLogoAnimation();
		assert.equal(renders, rendersAfterStop, "idle stop is inert");
		startLogoAnimation();
		assert.equal(logoAnimation.frame, 0, "fresh start replays from the first frame");
		assert.equal(logoAnimation.timeMs, 0);
		assert.equal(logoAnimation.completed, false);
		for (let elapsed = 0; elapsed <= INSTALLER_LOGO_DURATION_MS; elapsed += LOGO_TICK_MS) timers.tick(LOGO_TICK_MS);
		assert.equal(logoAnimation.timer, null, "one-shot stops itself");
		assert.equal(logoAnimation.completed, true, "one-shot marks playback complete");
		assert.equal(logoAnimation.frame, INSTALLER_LOGO_LAST_FRAME, "completion holds the final source frame");
		const settledRenders = renders;
		stopLogoAnimation();
		assert.equal(renders, settledRenders);
	});
});

describe("start/stop lifecycle (A-03)", () => {
	it("start is idempotent while running: same timer, clock preserved", (t) => {
		const timers = enableTimers(t);
		startGradientAnimation();
		for (let i = 0; i < 5; i++) {
			timers.tick(GRADIENT_TICK_MS);
		}
		const timer = gradientAnimation.timer;
		startGradientAnimation();
		assert.equal(gradientAnimation.timer, timer, "no restart");
		assert.equal(gradientAnimation.timeMs, 5 * GRADIENT_TICK_MS, "clock keeps counting");
	});

	it("stop clears the timer and is idempotent", (t) => {
		enableTimers(t);
		startGradientAnimation();
		stopGradientAnimation();
		assert.equal(gradientAnimation.timer, null);
		stopGradientAnimation();
		assert.equal(gradientAnimation.timer, null);
	});
});
