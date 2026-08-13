import type { Theme } from "@earendil-works/pi-coding-agent";
import { headerRenderState } from "./state.ts";
import { sgrFg } from "./color.ts";
import { sanitizeTuiText, visibleLength } from "./text.ts";


/** Placeholder naming the tagline's two fields, wiped away by the reveal. */
export const TAGLINE_PLACEHOLDER = "model · system prompt";
/** How long the placeholder sits untouched before the wipe starts. */
export const REVEAL_HOLD_MS = 500;
/**
 * Wall-clock cost of one revealed character. The repaint cadence matches it so each frame advances
 * the wipe by about one cell — the finest step a character grid can show.
 */
export const REVEAL_MS_PER_CHAR = 20;
export const REVEAL_TICK_MS = REVEAL_MS_PER_CHAR;
/** Half-width of the shimmer band, and so how far off the left edge the band starts. */
export const REVEAL_BAND_HALF = 5;
/** Peak blend toward the highlight; short of 1 so the crest keeps a trace of the base ink. */
export const REVEAL_PEAK_ALPHA = 0.9;

/**
 * One-shot reveal of the info panel's tagline. `pos` is the wipe's leading edge in cells, advanced
 * by the ticker rather than derived from a start time, and `tick` is part of the header's memo key
 * so bumping it is what makes a frame repaint. `fieldWidth` is reported back by the renderer
 * because only it knows the panel's inner width, and the ticker needs it to know when to stop.
 */
export const taglineReveal = {
	timer: null as ReturnType<typeof setInterval> | null,
	lastTickAt: 0,
	holdLeftMs: REVEAL_HOLD_MS,
	/** Starts a full band off the left edge so the crest sweeps in rather than snapping on. */
	pos: -REVEAL_BAND_HALF,
	tick: 0,
	fieldWidth: TAGLINE_PLACEHOLDER.length,
};

/** The wipe's leading edge, or undefined once the tagline has settled. */
export function revealPos(): number | undefined {
	return taglineReveal.timer ? taglineReveal.pos : undefined;
}

export function startTaglineReveal(): void {
	stopTaglineReveal();
	taglineReveal.lastTickAt = Date.now();
	taglineReveal.holdLeftMs = REVEAL_HOLD_MS;
	taglineReveal.pos = -REVEAL_BAND_HALF;
	taglineReveal.fieldWidth = TAGLINE_PLACEHOLDER.length;
	taglineReveal.timer = setInterval(() => {
		const now = Date.now();
		// Pi's startup blocks the event loop for over a second at a time, which no timer can fire
		// through. Capping the time one tick may account for pauses the wipe across a block instead
		// of teleporting it to the end, so the reveal is still seen once the loop frees up.
		const step = Math.min(now - taglineReveal.lastTickAt, REVEAL_TICK_MS * 2);
		taglineReveal.lastTickAt = now;
		if (taglineReveal.holdLeftMs > 0) {
			taglineReveal.holdLeftMs -= step;
			return;
		}
		taglineReveal.pos += step / REVEAL_MS_PER_CHAR;
		taglineReveal.tick++;
		headerRenderState.requestRender?.();
		// The band trails the last character by its own half-width before the row is fully settled.
		if (taglineReveal.pos >= taglineReveal.fieldWidth - 1 + REVEAL_BAND_HALF) stopTaglineReveal();
	}, REVEAL_TICK_MS);
	// Never hold the process open for a decoration.
	taglineReveal.timer.unref();
}

export function stopTaglineReveal(): void {
	if (!taglineReveal.timer) return;
	clearInterval(taglineReveal.timer);
	taglineReveal.timer = null;
	// revealPos() reads undefined now, so this repaint lands the settled tagline.
	taglineReveal.tick++;
	headerRenderState.requestRender?.();
}

export interface ShimmerPalette {
	base: [number, number, number];
	highlight: [number, number, number];
}

/** Channels of a truecolor SGR; 256-color themes yield null, which disables the shimmer. */
export function sgrChannels(ansi: string): [number, number, number] | null {
	const match = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(ansi);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function shimmerPalette(theme: Theme): ShimmerPalette | null {
	const base = sgrChannels(theme.getFgAnsi("dim"));
	const highlight = sgrChannels(theme.getFgAnsi("text"));
	return base && highlight ? { base, highlight } : null;
}

/** One cell of the shimmer: a raised-cosine crest fading to the base ink outside the band. */
export function shimmerCell(ch: string, dist: number, palette: ShimmerPalette): string {
	const t = dist <= REVEAL_BAND_HALF ? 0.5 * (1 + Math.cos((Math.PI * dist) / REVEAL_BAND_HALF)) : 0;
	const alpha = t * REVEAL_PEAK_ALPHA;
	const blend = (channel: 0 | 1 | 2) =>
		Math.round(palette.highlight[channel] * alpha + palette.base[channel] * (1 - alpha));
	return `${t > 0.2 ? "\x1b[1m" : ""}${sgrFg(`${blend(0)};${blend(1)};${blend(2)}`)}${ch}\x1b[22m`;
}

/**
 * The tagline, settled or mid-reveal. The reveal overwrites the placeholder with the real text from
 * the left, one cell at a time, with the shimmer band riding the wipe's leading edge so a character
 * becomes legible exactly as the crest passes it. The brackets hug the content, so the row holds the
 * placeholder's width until the wipe outgrows it and then widens toward the finished tagline, being
 * recentered in the panel by the caller throughout.
 *
 * Falls back to the settled line whenever a frame could not be drawn faithfully: ANSI is stripped
 * before reveal, a 256-color theme has no channels to interpolate, a surrogate pair would
 * desynchronize the code point index from the `visibleLength` the panel budgets by, and a tagline
 * shorter than the placeholder could never overwrite all of it, so the label would still be showing
 * once the wipe ran out of characters.
 */
export function renderTagline(theme: Theme, tagline: string): string {
	// Strip ANSI escapes from model/provider names that could break out of the themed styling.
	const safeTagline = sanitizeTuiText(tagline);
	const settled = theme.fg("dim", `- ${safeTagline} -`);
	const pos = revealPos();
	const palette = shimmerPalette(theme);
	const chars = [...safeTagline];
	if (
		pos === undefined ||
		!palette ||
		safeTagline.includes("\x1b") ||
		chars.length !== visibleLength(safeTagline) ||
		chars.length < TAGLINE_PLACEHOLDER.length
	) {
		return settled;
	}

	taglineReveal.fieldWidth = chars.length;
	const placeholder = [...TAGLINE_PLACEHOLDER];
	const revealed = Math.max(0, Math.min(chars.length, Math.ceil(pos)));

	let field = "";
	for (let i = 0; i < Math.max(revealed, placeholder.length); i++) {
		field += shimmerCell(i < revealed ? chars[i] : placeholder[i], Math.abs(i - pos), palette);
	}
	const dash = theme.fg("dim", "-");
	// Foreground-only reset: the panel's background plate has to survive the field.
	return `${dash} ${field}\x1b[39m ${dash}`;
}

