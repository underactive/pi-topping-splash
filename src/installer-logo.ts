import { isAppleTerminalSession } from "@earendil-works/pi-tui";
import type { TerminalColorMode } from "@earendil-works/pi-tui";
import { rgbFromHex } from "./color.ts";
import type { Rgb } from "./color.ts";
import { LOGO_INK } from "./logo.ts";
import type { ConcreteLogoStyle } from "./logo.ts";

/**
 * Literal transcription of `pi_logo_animation` / `draw_logo_frame` from
 * https://pi.dev/install.sh, fetched 2026-10-17 (SHA-256
 * 822e94298a79e61b5285fc559b7bfe89ac6ff64aac53d3dc9fc331a23d72e12e).
 * Source function lines 1709-1737; frame painter lines 1742-1816. The fetched
 * script contains no explicit license or attribution notice. Frame pixels and
 * holds are transcribed, not executed; `.` is transparent and palette keys are
 * the installer's coral/blue/gold/turquoise/white/flash colors.
 *
 * The colored brand frame (index 19) crops to `ccc.` / `b.c.` / `bb.y` / `b..y`,
 * matching pi-logo.js, but frame 20 is the installer's final white hand-off frame.
 * One scale is computed from the 6x7 active pixel union across every source frame.
 * The installer palette (240/144/130, 77/154/191, 241/190/88) differs from
 * pi-logo.js (228/138/122, 79/142/179, 234/182/93); installer values are authoritative.
 * Playback and stop both remain on the final source frame.
 */
export const INSTALLER_LOGO_PALETTE: Readonly<Record<string, Rgb>> = {
	c: rgbFromHex("#f09082"),
	b: rgbFromHex("#4d9abf"),
	g: rgbFromHex("#f1be58"),
	t: rgbFromHex("#83ccd2"),
	w: LOGO_INK,
	f: rgbFromHex("#ffffff"),
};

export interface LogoFrame {
	/** One equal-width pixel row per string; `.` is transparent. */
	pixels: readonly string[];
	/** How long the installer holds this frame before drawing the next. */
	holdMs: number;
}

/** All 21 `draw_logo_frame` calls, with their source `sleep` holds in milliseconds. */
export const INSTALLER_LOGO_FRAMES: readonly LogoFrame[] = [
	{ pixels: [".b......", ".bb.....", ".b......", "........", "........", "........", "tttt....", "........", "........"], holdMs: 75 },
	{ pixels: ["........", ".b......", ".bb.....", ".b......", "........", "........", "tttt....", "........", "........"], holdMs: 75 },
	{ pixels: ["........", "........", ".b......", ".bb.....", ".b......", "........", "tttt....", "........", "........"], holdMs: 75 },
	{ pixels: ["........", "........", "........", ".b......", ".bb.....", ".b......", "tttt....", "........", "........"], holdMs: 75 },
	{ pixels: [".ccc....", "...c....", "........", ".b......", ".bb.....", ".b......", "tttt....", "........", "........"], holdMs: 75 },
	{ pixels: ["........", ".ccc....", "...c....", ".b......", ".bb.....", ".b......", "tttt....", "........", "........"], holdMs: 75 },
	{ pixels: ["........", "........", ".ccc....", ".b.c....", ".bb.....", ".b......", "tttt....", "........", "........"], holdMs: 75 },
	{ pixels: ["....g...", "....g...", ".cccgg..", ".b.c....", ".bb.....", ".b......", "tttt....", "........", "........"], holdMs: 75 },
	{ pixels: ["........", "....g...", ".cccg...", ".b.cgg..", ".bb.....", ".b......", "tttt....", "........", "........"], holdMs: 75 },
	{ pixels: ["........", "........", ".cccg...", ".b.cg...", ".bb.gg..", ".b......", "tttt....", "........", "........"], holdMs: 75 },
	{ pixels: ["........", "........", ".ccc....", ".b.cg...", ".bb.g...", ".b..gg..", "tttt....", "........", "........"], holdMs: 75 },
	{ pixels: ["........", "........", ".ccc....", ".b.c....", ".bb.g...", ".b..g...", "ttttgg..", "........", "........"], holdMs: 75 },
	{ pixels: ["........", "........", ".ccc....", ".b.c....", ".bb.g...", ".b..g...", "ttttgg..", "........", "........"], holdMs: 250 },
	{ pixels: ["........", "........", ".ccc....", ".b.c....", ".bb.g...", ".b..g...", "ffffff..", "........", "........"], holdMs: 80 },
	{ pixels: ["........", "........", ".ccc....", ".b.c....", ".bb.g...", ".b..g...", "ttttgg..", "........", "........"], holdMs: 80 },
	{ pixels: ["........", "........", ".ccc....", ".b.c....", ".bb.g...", ".b..g...", "ffffff..", "........", "........"], holdMs: 80 },
	{ pixels: ["........", "........", ".ccc....", ".b.c....", ".bb.g...", ".b..g...", "........", "........", "........"], holdMs: 100 },
	{ pixels: ["........", "........", "........", ".ccc....", ".b.c....", ".bb.g...", ".b..g...", "........", "........"], holdMs: 450 },
	{ pixels: ["........", "........", "........", ".www....", ".w.w....", ".ww.w...", ".w..w...", "........", "........"], holdMs: 120 },
	{ pixels: ["........", "........", "........", ".ccc....", ".b.c....", ".bb.g...", ".b..g...", "........", "........"], holdMs: 120 },
	{ pixels: ["........", "........", "........", ".www....", ".w.w....", ".ww.w...", ".w..w...", "........", "........"], holdMs: 450 },
];

export const INSTALLER_LOGO_DURATION_MS = INSTALLER_LOGO_FRAMES.reduce((sum, frame) => sum + frame.holdMs, 0);
export const INSTALLER_LOGO_BRAND_FRAME = INSTALLER_LOGO_FRAMES.length - 2;
/** The final installer source frame, including its white hand-off flash. */
export const INSTALLER_LOGO_LAST_FRAME = INSTALLER_LOGO_FRAMES.length - 1;

interface PixelBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

function pixelBounds(frames: readonly LogoFrame[]): PixelBounds {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const frame of frames) {
		frame.pixels.forEach((row, y) => {
			for (let x = 0; x < row.length; x++) {
				if (row[x] === ".") continue;
				minX = Math.min(minX, x);
				minY = Math.min(minY, y);
				maxX = Math.max(maxX, x);
				maxY = Math.max(maxY, y);
			}
		});
	}
	return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** The source-pixel union used to compute one shared scale for every frame. */
export const INSTALLER_LOGO_ANIMATION_BOUNDS = pixelBounds(INSTALLER_LOGO_FRAMES);
/** The final frame's own pixels: the mark that holds after playback, in the lower rows of the union. */
export const INSTALLER_LOGO_HELD_BOUNDS = pixelBounds([INSTALLER_LOGO_FRAMES[INSTALLER_LOGO_LAST_FRAME]!]);

/** Select the frame held at `timeMs`, clamping on the final frame. */
export function installerFrameIndex(timeMs: number): number {
	let elapsed = Math.max(0, timeMs);
	for (let index = 0; index < INSTALLER_LOGO_FRAMES.length; index++) {
		elapsed -= INSTALLER_LOGO_FRAMES[index]!.holdMs;
		if (elapsed < 0) return index;
	}
	return INSTALLER_LOGO_LAST_FRAME;
}

/** The installer animation needs RGB color and half-block-safe row alignment. */
export function resolveLogoStyle(style: ConcreteLogoStyle, colorMode: TerminalColorMode): ConcreteLogoStyle {
	if (style !== "logo" || colorMode !== "truecolor" || process.env.TERM === "dumb" || isAppleTerminalSession()) {
		return "symbol";
	}
	return "logo";
}
