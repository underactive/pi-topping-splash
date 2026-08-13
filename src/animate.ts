import { headerRenderState } from "./state.ts";

/**
 * Repaint cadence of the animated backdrop. Deliberately far coarser than the reveal's 20ms
 * tick: every backdrop frame repaints the whole splash, not a single row.
 */
export const GRADIENT_TICK_MS = 100;

/**
 * The looping backdrop animation clock. `timeMs` is advanced by capped steps rather than read
 * from the wall clock, so pi's startup event-loop blocks pause the motion instead of teleporting
 * it (same rationale as the tagline reveal). `tick` is part of the header's memo key, so bumping
 * it is what makes a frame repaint. Unlike the reveal, the loop never stops itself.
 */
export const gradientAnimation = {
	timer: null as ReturnType<typeof setInterval> | null,
	lastTickAt: 0,
	timeMs: 0,
	tick: 0,
};

/** Starts the loop; a ticker that is already running keeps its clock (no restart jump). */
export function startGradientAnimation(): void {
	if (gradientAnimation.timer) return;
	gradientAnimation.lastTickAt = Date.now();
	gradientAnimation.timer = setInterval(() => {
		const now = Date.now();
		const step = Math.min(now - gradientAnimation.lastTickAt, GRADIENT_TICK_MS * 2);
		gradientAnimation.lastTickAt = now;
		gradientAnimation.timeMs += step;
		gradientAnimation.tick++;
		headerRenderState.requestRender?.();
	}, GRADIENT_TICK_MS);
	// Never hold the process open for a decoration.
	gradientAnimation.timer.unref();
}

export function stopGradientAnimation(): void {
	if (!gradientAnimation.timer) return;
	clearInterval(gradientAnimation.timer);
	gradientAnimation.timer = null;
}
