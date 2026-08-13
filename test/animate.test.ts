import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GRADIENT_TICK_MS, gradientAnimation, startGradientAnimation, stopGradientAnimation } from "../src/animate.ts";
import { headerRenderState } from "../src/state.ts";
import { resetModuleState } from "./helpers/reset.ts";

beforeEach(() => resetModuleState());
afterEach(() => stopGradientAnimation());

type TimerCtx = { mock: { timers: { enable(opts: { apis: string[] }): void; tick(ms: number): void } } };

// Single cast site for @types/node's untyped t.mock.timers; returns the handle so tests can tick.
function enableTimers(t: unknown): TimerCtx["mock"]["timers"] {
	const timers = (t as TimerCtx).mock.timers;
	timers.enable({ apis: ["setInterval", "Date"] });
	return timers;
}

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
