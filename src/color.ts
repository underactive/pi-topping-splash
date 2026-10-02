import type { Theme } from "@earendil-works/pi-coding-agent";
import { colorToRgb } from "@earendil-works/pi-tui";

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
 * Theme colors include resolved terminal defaults, so their luminance can be analysed directly.
 */
export function panelBg(theme: Theme): Rgb {
	const { r, g, b } = colorToRgb(theme.colors.text);
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

/** Selectable splash backdrops: the animated rainbow sweep, a theme color faded to black, or a time-of-day-scaled theme color. */
export type BackgroundColor = "rainbow" | "accent" | "border" | "borderAccent" | "borderMuted" | "success" | "error" | "warning" | "dynamic";

/** Cycle order shown in the settings menu. */
export const BACKGROUND_COLOR_OPTIONS: readonly BackgroundColor[] = ["rainbow", "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "dynamic"];

/** The seven theme colors a "dynamic" backdrop can scale. */
export type DynamicTint = Exclude<BackgroundColor, "rainbow" | "dynamic">;
/** Tint "dynamic" uses until a theme color has been applied as the background. */
export const DEFAULT_DYNAMIC_TINT: DynamicTint = "accent";
export function isDynamicTint(value: unknown): value is DynamicTint {
	return value !== "rainbow" && value !== "dynamic" && BACKGROUND_COLOR_OPTIONS.includes(value as BackgroundColor);
}

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

/** Local hour at which "dynamic" shows its tint at full strength; the trough falls 12 hours later. */
export const DYNAMIC_PEAK_HOUR = 13;
/** Brightness of the "dynamic" tint at the trough, as a share of the full theme color. */
export const DYNAMIC_NIGHT_SCALE = 0.35;

const TAU = Math.PI * 2;

/** Brightness share for "dynamic" at a fractional local hour: 1 at DYNAMIC_PEAK_HOUR, DYNAMIC_NIGHT_SCALE twelve hours away. */
export function daylightScale(hours: number): number {
	return DYNAMIC_NIGHT_SCALE + (1 - DYNAMIC_NIGHT_SCALE) * 0.5 * (1 + Math.cos((TAU * (hours - DYNAMIC_PEAK_HOUR)) / 24));
}

/** Samples the backdrop for one half-cell: horizontal position, terminal width, and vertical fade level (1 top, 0 bottom). */
export type SwatchSampler = (x: number, width: number, level: number) => Rgb;

export function backgroundSampler(background: BackgroundColor, theme: Theme, animation: GradientAnimation = "off", timeMs = 0, dynamicTint: DynamicTint = DEFAULT_DYNAMIC_TINT, now: Date = new Date()): SwatchSampler {
	return animateSampler(baseSampler(background, theme, dynamicTint, now), animation, timeMs);
}

/** The static backdrop: the rainbow sweep itself, or a theme color scaled by the fade level and, for "dynamic", the local time of day. */
function baseSampler(background: BackgroundColor, theme: Theme, dynamicTint: DynamicTint, now: Date): SwatchSampler {
	if (background === "rainbow") return swatchColor;
	const { r, g, b } = colorToRgb(theme.colors[background === "dynamic" ? dynamicTint : background]);
	const scale = background === "dynamic" ? daylightScale(now.getHours() + now.getMinutes() / 60) : 1;
	return (_x: number, _width: number, level: number) => {
		const f = Math.min(1, Math.max(0, level)) * scale;
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
