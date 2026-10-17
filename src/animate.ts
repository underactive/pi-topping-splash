import { headerRenderState } from "./state.ts";
import { INSTALLER_LOGO_DURATION_MS, INSTALLER_LOGO_LAST_FRAME, INSTALLER_LOGO_LOOP, installerFrameIndex } from "./installer-logo.ts";

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

/** Frame-change cadence for the installer logo; its shortest source hold is 75ms. */
export const LOGO_TICK_MS = 20;

/** One-shot installer logo clock; idle holds the final source frame. */
export const logoAnimation = {
	timer: null as ReturnType<typeof setInterval> | null,
	lastTickAt: 0,
	timeMs: 0,
	frame: INSTALLER_LOGO_LAST_FRAME,
	tick: 0,
	completed: false,
};

/** Starts (or replays) the installer animation; an active ticker keeps its current run. */
export function startLogoAnimation(): void {
	if (logoAnimation.timer) return;
	logoAnimation.timeMs = 0;
	logoAnimation.frame = 0;
	logoAnimation.completed = false;
	logoAnimation.lastTickAt = Date.now();
	logoAnimation.tick++;
	headerRenderState.requestRender?.();
	logoAnimation.timer = setInterval(() => {
		const now = Date.now();
		const step = Math.min(now - logoAnimation.lastTickAt, LOGO_TICK_MS * 2);
		logoAnimation.lastTickAt = now;
		logoAnimation.timeMs += step;
		const frame = installerFrameIndex(logoAnimation.timeMs);
		if (frame !== logoAnimation.frame) {
			logoAnimation.frame = frame;
			logoAnimation.tick++;
			headerRenderState.requestRender?.();
		}
		if (!INSTALLER_LOGO_LOOP && logoAnimation.timeMs >= INSTALLER_LOGO_DURATION_MS) {
			logoAnimation.completed = true;
			stopLogoAnimation();
		}
	}, LOGO_TICK_MS);
	logoAnimation.timer.unref();
}

/** Stops the clock and restores the final installer source frame. */
export function stopLogoAnimation(): void {
	if (!logoAnimation.timer) return;
	clearInterval(logoAnimation.timer);
	logoAnimation.timer = null;
	if (logoAnimation.frame !== INSTALLER_LOGO_LAST_FRAME) {
		logoAnimation.frame = INSTALLER_LOGO_LAST_FRAME;
		logoAnimation.tick++;
		headerRenderState.requestRender?.();
	}
}
