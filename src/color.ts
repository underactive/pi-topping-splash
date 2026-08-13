import type { Theme } from "@earendil-works/pi-coding-agent";

export const SWATCH_SATURATION = 0.78;
export const SWATCH_VALUE = 0.9;
/** Hue at the left edge: starts on pi's magenta so the logo sits over the sweep's warm end. */
export const SWATCH_HUE_START = 320;
/** Plate colors for the info panel: navy under light-on-dark themes, paper under dark-on-light. */
export const PANEL_BG_DARK = rgbFromHex("#101830");
export const PANEL_BG_LIGHT = rgbFromHex("#eef0f7");
/** Rec.601 luma threshold that separates light-on-dark from dark-on-light themes. */
export const PANEL_LUMINANCE_THRESHOLD = 140;

/** An `r;g;b` triplet, ready to splice into a truecolor SGR sequence. */
export type Rgb = string;

export const RESET = "\x1b[0m";

export function rgbFromHex(hex: string): Rgb {
	const value = hex.replace("#", "");
	const r = Number.parseInt(value.slice(0, 2), 16);
	const g = Number.parseInt(value.slice(2, 4), 16);
	const b = Number.parseInt(value.slice(4, 6), 16);
	return `${r};${g};${b}`;
}

export function sgrFg(color: Rgb): string {
	return `\x1b[38;2;${color}m`;
}

export function sgrBg(color: Rgb): string {
	return `\x1b[48;2;${color}m`;
}

/** Convert HSV to an r;g;b SGR triplet. Hue in degrees 0-360, saturation and value 0-1. */
export function hsvRgb(hue: number, saturation: number, value: number): Rgb {
	const chroma = value * saturation;
	const sector = (((hue % 360) + 360) % 360) / 60;
	const x = chroma * (1 - Math.abs((sector % 2) - 1));
	let r: number, g: number, b: number;
	if (sector < 1) { r = chroma; g = x; b = 0; }
	else if (sector < 2) { r = x; g = chroma; b = 0; }
	else if (sector < 3) { r = 0; g = chroma; b = x; }
	else if (sector < 4) { r = 0; g = x; b = chroma; }
	else if (sector < 5) { r = x; g = 0; b = chroma; }
	else { r = chroma; g = 0; b = x; }
	const base = value - chroma;
	return `${Math.round((r + base) * 255)};${Math.round((g + base) * 255)};${Math.round((b + base) * 255)}`;
}

/**
 * Picks the plate the panel text can actually be read on. Themes that draw body text light
 * (the usual dark-terminal case) get the navy plate; dark body text gets a paper plate.
 * Both truecolor and indexed-color (256-color) ANSI sequences are analysed for luminance.
 */
export function panelBg(theme: Theme): Rgb {
	const rgb = parseThemeRgb(theme.getFgAnsi("text"));
	if (!rgb) return PANEL_BG_DARK;
	const [r, g, b] = rgb.split(";").map(Number);
	const luminance = r * 0.299 + g * 0.587 + b * 0.114;
	return luminance > PANEL_LUMINANCE_THRESHOLD ? PANEL_BG_DARK : PANEL_BG_LIGHT;
}

/**
 * Backdrop color for one half-cell: hue sweeps a full turn across the terminal width while
 * `level` (1 at the top row, 0 at the bottom) fades the whole sweep out to black.
 */
export function swatchColor(x: number, width: number, level: number): Rgb {
	const hue = SWATCH_HUE_START + (x / Math.max(1, width)) * 360;
	return hsvRgb(hue, SWATCH_SATURATION, SWATCH_VALUE * Math.max(0, level));
}

/** Selectable splash backdrops: the animated rainbow sweep, or a theme color faded to black. */
export type BackgroundColor = "rainbow" | "accent" | "border" | "borderAccent" | "borderMuted" | "success" | "error" | "warning";

/** Cycle order shown in the settings menu. */
export const BACKGROUND_COLOR_OPTIONS: readonly BackgroundColor[] = ["rainbow", "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning"];

/** Animations for the splash backdrop; "off" keeps it static. They wrap any backdrop, rainbow included. */
export type GradientAnimation = "off" | "breathe" | "flow" | "sheen" | "wave";

/** Cycle order shown in the settings menu. */
export const GRADIENT_ANIMATION_OPTIONS: readonly GradientAnimation[] = ["off", "breathe", "flow", "sheen", "wave"];

export const BREATHE_PERIOD_MS = 4000;
/** Brightness floor at the trough of the breathe cycle. */
export const BREATHE_MIN = 0.55;
export const FLOW_PERIOD_MS = 3000;
/** Brightness bands stacked down the gradient. */
export const FLOW_CYCLES = 1.5;
/** How far the rolling bands dip below the base fade. */
export const FLOW_DEPTH = 0.3;
export const SHEEN_PERIOD_MS = 4000;
/** The highlight crosses the whole splash in this span; the cycle's remainder rests. */
export const SHEEN_SWEEP_MS = 1400;
/** Half-width of the sheen band in diagonal units (x/width + 1-level spans 0..2). */
export const SHEEN_BAND = 0.18;
/** Peak blend toward white at the crest, scaled by the local fade level. */
export const SHEEN_ALPHA = 0.55;
export const WAVE_PERIOD_MS = 2500;
/** Horizontal wavelength of the ripple, in cells. */
export const WAVE_LENGTH_CELLS = 24;
/** How far the ripple displaces the fade level. */
export const WAVE_AMP = 0.08;

const TAU = Math.PI * 2;

/** Samples the backdrop for one half-cell: horizontal position, terminal width, and vertical fade level (1 top, 0 bottom). */
export type SwatchSampler = (x: number, width: number, level: number) => Rgb;

/** Standard xterm 16-color palette, used to approximate indexed ANSI colors 0-15 as RGB. */
const XTERM_16 = [
	"0;0;0", "205;0;0", "0;205;0", "205;205;0", "0;0;238", "205;0;205", "0;205;205", "229;229;229",
	"127;127;127", "255;0;0", "0;255;0", "255;255;0", "92;92;255", "255;0;255", "0;255;255", "255;255;255",
] as const;

/** Converts an xterm 256-color index (0-255) to an r;g;b triplet: 16-color palette, 6x6x6 cube, then grayscale ramp. */
function xterm256ToRgb(index: number): Rgb {
	if (index < 16) return XTERM_16[index]!;
	if (index < 232) {
		const i = index - 16;
		const levels = [0, 95, 135, 175, 215, 255];
		const r = levels[Math.floor(i / 36) % 6]!;
		const g = levels[Math.floor(i / 6) % 6]!;
		const b = levels[i % 6]!;
		return `${r};${g};${b}`;
	}
	const v = 8 + (index - 232) * 10;
	return `${v};${v};${v}`;
}

/** Parses a theme's foreground ANSI escape into an r;g;b triplet, from either truecolor or indexed sequences. */
function parseThemeRgb(ansi: string): Rgb | undefined {
	const truecolor = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(ansi);
	if (truecolor) return `${truecolor[1]};${truecolor[2]};${truecolor[3]}`;
	const indexed = /\x1b\[38;5;(\d+)m/.exec(ansi);
	if (indexed) {
		const index = Number(indexed[1]);
		if (index >= 0 && index <= 255) return xterm256ToRgb(index);
	}
	return undefined;
}

export function backgroundSampler(background: BackgroundColor, theme: Theme, animation: GradientAnimation = "off", timeMs = 0): SwatchSampler {
	return animateSampler(baseSampler(background, theme), animation, timeMs);
}

/** The static backdrop: the rainbow sweep itself, or a theme color scaled by the fade level. */
function baseSampler(background: BackgroundColor, theme: Theme): SwatchSampler {
	if (background === "rainbow") return swatchColor;
	const rgb = parseThemeRgb(theme.getFgAnsi(background));
	if (!rgb) return swatchColor;
	const [r, g, b] = rgb.split(";").map(Number) as [number, number, number];
	return (_x: number, _width: number, level: number) => {
		const f = Math.min(1, Math.max(0, level));
		return `${Math.round(r * f)};${Math.round(g * f)};${Math.round(b * f)}`;
	};
}

/**
 * Wraps a base backdrop in the chosen animation, frozen at `timeMs`. Breathe, flow and wave
 * transform the fade level fed to the base (so the rainbow keeps its hue sweep and a theme
 * color keeps its tint); sheen post-blends the base's output toward white inside its band.
 */
function animateSampler(base: SwatchSampler, animation: GradientAnimation, timeMs: number): SwatchSampler {
	switch (animation) {
		case "breathe": {
			const breath = BREATHE_MIN + (1 - BREATHE_MIN) * 0.5 * (1 + Math.cos((TAU * timeMs) / BREATHE_PERIOD_MS));
			return (x: number, width: number, level: number) => base(x, width, Math.max(0, level) * breath);
		}
		case "flow": {
			const phase = timeMs / FLOW_PERIOD_MS;
			// Crests sit where level·FLOW_CYCLES + phase is constant, so they travel downward as time passes.
			return (x: number, width: number, level: number) => {
				const f = Math.max(0, level);
				return base(x, width, f * (1 - FLOW_DEPTH + FLOW_DEPTH * Math.sin(TAU * (f * FLOW_CYCLES + phase))));
			};
		}
		case "sheen": {
			const cycle = timeMs % SHEEN_PERIOD_MS;
			if (cycle >= SHEEN_SWEEP_MS) return base;
			// The band enters fully off the top-left and exits fully off the bottom-right.
			const pos = (cycle / SHEEN_SWEEP_MS) * (2 + 2 * SHEEN_BAND) - SHEEN_BAND;
			return (x: number, width: number, level: number) => {
				const f = Math.min(1, Math.max(0, level));
				const dist = Math.abs(x / Math.max(1, width) + (1 - f) - pos);
				if (dist >= SHEEN_BAND) return base(x, width, f);
				const alpha = 0.5 * (1 + Math.cos((Math.PI * dist) / SHEEN_BAND)) * SHEEN_ALPHA * f;
				const [r, g, b] = base(x, width, f).split(";").map(Number) as [number, number, number];
				const glint = (c: number) => Math.round(c + (255 - c) * alpha);
				return `${glint(r)};${glint(g)};${glint(b)}`;
			};
		}
		case "wave": {
			const phase = timeMs / WAVE_PERIOD_MS;
			return (x: number, width: number, level: number) =>
				base(x, width, Math.min(1, Math.max(0, level + WAVE_AMP * Math.sin(TAU * (x / WAVE_LENGTH_CELLS - phase)))));
		}
		default:
			return base;
	}
}
