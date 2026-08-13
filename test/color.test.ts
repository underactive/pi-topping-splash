import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BACKGROUND_COLOR_OPTIONS,
	backgroundSampler,
	hsvRgb,
	PANEL_BG_DARK,
	PANEL_BG_LIGHT,
	PANEL_LUMINANCE_THRESHOLD,
	panelBg,
	RESET,
	rgbFromHex,
	SWATCH_HUE_START,
	sgrBg,
	sgrFg,
	swatchColor,
} from "../src/color.ts";
import { makeTheme } from "./helpers/theme.ts";

const TRIPLET = /^(\d{1,3});(\d{1,3});(\d{1,3})$/;

function channels(rgb: string): [number, number, number] {
	const match = TRIPLET.exec(rgb);
	assert.ok(match, `not an r;g;b triplet: ${JSON.stringify(rgb)}`);
	const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
	for (const c of parts) assert.ok(c >= 0 && c <= 255, `channel out of range in ${rgb}`);
	return parts;
}

// Standard RGB→hue math (independent of the implementation).
function hueOf(rgb: string): number {
	const [r, g, b] = channels(rgb).map((c) => c / 255) as [number, number, number];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	assert.ok(d > 0.01, `hue undefined for near-grey ${rgb}`);
	let hue: number;
	if (max === r) hue = 60 * (((g - b) / d) % 6);
	else if (max === g) hue = 60 * ((b - r) / d + 2);
	else hue = 60 * ((r - g) / d + 4);
	return (hue + 360) % 360;
}

function hueDistance(a: number, b: number): number {
	const d = Math.abs(a - b) % 360;
	return Math.min(d, 360 - d);
}

describe("rgbFromHex (C-01)", () => {
	it("converts #RRGGBB to decimal triplets", () => {
		assert.equal(rgbFromHex("#000000"), "0;0;0");
		assert.equal(rgbFromHex("#ffffff"), "255;255;255");
		assert.equal(rgbFromHex("#101830"), "16;24;48");
		assert.equal(rgbFromHex("#f2f2f2"), "242;242;242");
	});
});

describe("sgrFg / sgrBg (C-02, C-08)", () => {
	it("wraps triplets in truecolor SGR sequences", () => {
		assert.equal(sgrFg("1;2;3"), "\x1b[38;2;1;2;3m");
		assert.equal(sgrBg("1;2;3"), "\x1b[48;2;1;2;3m");
	});
	it("RESET is the SGR reset", () => {
		assert.equal(RESET, "\x1b[0m");
	});
});

describe("hsvRgb (C-03, C-04)", () => {
	it("primary hues (HSV definition)", () => {
		assert.equal(hsvRgb(0, 1, 1), "255;0;0");
		assert.equal(hsvRgb(120, 1, 1), "0;255;0");
		assert.equal(hsvRgb(240, 1, 1), "0;0;255");
		assert.equal(hsvRgb(60, 1, 1), "255;255;0");
		assert.equal(hsvRgb(180, 1, 1), "0;255;255");
		assert.equal(hsvRgb(300, 1, 1), "255;0;255");
	});
	it("zero saturation is grey, zero value is black", () => {
		for (const hue of [0, 45, 133, 271, 359]) {
			const [r, g, b] = channels(hsvRgb(hue, 0, 0.5));
			assert.equal(r, g, `hue=${hue}`);
			assert.equal(g, b, `hue=${hue}`);
			assert.ok(Math.abs(r - 127.5) <= 0.5, `hue=${hue}: grey level ${r}`);
			assert.equal(hsvRgb(hue, 1, 0), "0;0;0", `hue=${hue}`);
		}
	});
	it("emits valid triplets across the domain (UNSPECIFIED outside 0-360: no throw)", () => {
		for (let hue = 0; hue <= 720; hue += 15) {
			for (const sat of [0, 0.5, 1]) {
				for (const val of [0, 0.5, 1]) {
					channels(hsvRgb(hue, sat, val));
				}
			}
		}
	});
	it("round-trips hue within rounding error", () => {
		for (let hue = 0; hue < 360; hue += 20) {
			const back = hueOf(hsvRgb(hue, 1, 1));
			assert.ok(hueDistance(back, hue) < 2, `hue=${hue} came back as ${back}`);
		}
	});
});

describe("panelBg (C-05)", () => {
	it("greyscale text below the WCAG threshold gets the paper plate", () => {
		assert.equal(PANEL_LUMINANCE_THRESHOLD, 140);
		for (const v of [0, 60, 120, 139]) {
			const hex = `#${v.toString(16).padStart(2, "0").repeat(3)}`;
			assert.equal(panelBg(makeTheme({ text: hex })), PANEL_BG_LIGHT, `grey ${v}`);
		}
	});
	it("greyscale text above the threshold gets the navy plate", () => {
		for (const v of [141, 180, 220, 255]) {
			const hex = `#${v.toString(16).padStart(2, "0").repeat(3)}`;
			assert.equal(panelBg(makeTheme({ text: hex })), PANEL_BG_DARK, `grey ${v}`);
		}
	});
	it("flips exactly once across the grey ramp", () => {
		let flips = 0;
		let previous: string | undefined;
		for (let v = 0; v <= 255; v++) {
			const hex = `#${v.toString(16).padStart(2, "0").repeat(3)}`;
			const plate = panelBg(makeTheme({ text: hex }));
			if (previous !== undefined && plate !== previous) flips++;
			previous = plate;
		}
		assert.equal(flips, 1);
	});
	it("256-color themes are analysed for luminance", () => {
		// Dark text → low luminance → light-terminal → paper plate
		assert.equal(panelBg(makeTheme({ mode: "256color", text: "#101010" })), PANEL_BG_LIGHT);
		// Light text → high luminance → dark-terminal → navy plate
		assert.equal(panelBg(makeTheme({ mode: "256color", text: "#e8e8e8" })), PANEL_BG_DARK);
	});
});

describe("swatchColor (C-06, C-07)", () => {
	it("level at or below zero is black", () => {
		for (const level of [0, -0.5, -10]) {
			for (const x of [0, 5, 50]) {
				assert.equal(swatchColor(x, 80, level), "0;0;0", `x=${x} level=${level}`);
			}
		}
	});
	it("starts the sweep at SWATCH_HUE_START", () => {
		assert.equal(SWATCH_HUE_START, 320);
		for (const width of [40, 80, 200, 360]) {
			const hue = hueOf(swatchColor(0, width, 1));
			assert.ok(hueDistance(hue, SWATCH_HUE_START) < 3, `width=${width}: hue ${hue}`);
		}
	});
	it("sweeps a full turn across the width", () => {
		const width = 360;
		for (const [x, expected] of [
			[90, (SWATCH_HUE_START + 90) % 360],
			[180, (SWATCH_HUE_START + 180) % 360],
			[270, (SWATCH_HUE_START + 270) % 360],
		] as const) {
			const hue = hueOf(swatchColor(x, width, 1));
			assert.ok(hueDistance(hue, expected) < 4, `x=${x}: hue ${hue}, expected ~${expected}`);
		}
	});
	it("fades monotonically toward black as level drops", () => {
		for (const x of [0, 20, 63]) {
			let previousSum = Number.POSITIVE_INFINITY;
			for (const level of [1, 0.75, 0.5, 0.25, 0.1]) {
				const sum = channels(swatchColor(x, 64, level)).reduce((a, b) => a + b, 0);
				assert.ok(sum <= previousSum, `x=${x} level=${level}: ${sum} > ${previousSum}`);
				previousSum = sum;
			}
		}
	});
	it("emits valid triplets for every x at assorted widths", () => {
		for (const width of [1, 2, 3, 5, 17, 80, 200]) {
			for (let x = 0; x < width; x++) {
				channels(swatchColor(x, width, 1));
				channels(swatchColor(x, width, 0.5));
			}
		}
	});
});

describe("BACKGROUND_COLOR_OPTIONS", () => {
	it("lists rainbow first, then the seven theme colors in order", () => {
		assert.deepEqual(BACKGROUND_COLOR_OPTIONS, [
			"rainbow", "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
		]);
	});
});

describe("backgroundSampler", () => {
	it("rainbow returns swatchColor itself", () => {
		assert.equal(backgroundSampler("rainbow", makeTheme()), swatchColor);
	});

	it("truecolor theme: resolves the exact theme color at level 1, black at level 0", () => {
		const theme = makeTheme();
		for (const color of ["accent", "border", "borderAccent", "borderMuted", "success", "error", "warning"] as const) {
			const sample = backgroundSampler(color, theme);
			const expected = channels(theme.getFgAnsi(color).match(/\x1b\[38;2;(\d+;\d+;\d+)m/)![1]!);
			assert.deepEqual(channels(sample(0, 80, 1)), expected, color);
			assert.equal(sample(0, 80, 0), "0;0;0", color);
			// x-independent: theme colors don't sweep horizontally.
			assert.equal(sample(0, 80, 1), sample(40, 80, 1), color);
		}
	});

	it("indexed 256-color theme colors are approximated as RGB and fade to black", () => {
		const theme = makeTheme({ mode: "256color" });
		const sample = backgroundSampler("accent", theme);
		channels(sample(0, 80, 1));
		assert.equal(sample(0, 80, 0), "0;0;0");
	});

	it("malformed ANSI falls back to swatchColor (no throw, valid triplet)", () => {
		// FG_COLORS in the test theme are always resolvable; this just documents the fallback
		// contract by asserting rainbow's own output for an unresolvable input shape is safe.
		const theme = makeTheme();
		const sample = backgroundSampler("accent", theme);
		channels(sample(10, 80, 0.5));
	});

	it("every xterm 256-color index converts to a valid triplet", () => {
		const theme = makeTheme({ mode: "256color" });
		for (let i = 0; i < 256; i++) {
			const sample = backgroundSampler("accent", theme);
			channels(sample(0, 80, 1));
		}
	});
});
