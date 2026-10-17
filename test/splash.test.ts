import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ShortcutHint } from "../src/discovery.ts";
import {
	buildCountsLine,
	buildHeaderParts,
	buildLabeledWrappedSection,
	buildPanelLines,
	buildShortcutSection,
	LOGO_GAP,
	LOGO_LIFT_ROWS,
	MAX_SPLASH_ROW_SHARE,
	PANEL_MARGIN_Y,
	PANEL_MAX_WIDTH,
	PANEL_MIN_WIDTH,
	PANEL_PADDING_X,
	paintPanelRow,
	paintRow,
	paintSplash,
	SPLASH_MARGIN_X,
	installerLogoMetrics,
	stampInstallerLogo,
	stampLogo,
	SWATCH_CELL,
	type Ink,
	type PanelPlacement,
	type SplashBand,
} from "../src/splash.ts";
import { LOGO_INK, LOGO_LINES, LOGO_ROWS, LOGO_SHADOW, LOGO_SHADOW_OFFSET, LOGO_WIDTH } from "../src/logo.ts";
import { INSTALLER_LOGO_ANIMATION_BOUNDS, INSTALLER_LOGO_FRAMES, INSTALLER_LOGO_LAST_FRAME, INSTALLER_LOGO_PALETTE } from "../src/installer-logo.ts";
import { PANEL_BG_DARK } from "../src/color.ts";
import { sanitizeTuiText, visibleLength } from "../src/text.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { makeTheme } from "./helpers/theme.ts";
import { assertLinesAtMost, assertLinesExact } from "./helpers/width.ts";

beforeEach(() => resetModuleState());

const theme = makeTheme();
const MODEL = { id: "claude-opus-4", provider: "anthropic" };
const buildHeader = (...args: Parameters<typeof buildHeaderParts>) => buildHeaderParts(...args).lines;

describe("constants (S-01)", () => {
	it("README-documented layout anchors", () => {
		assert.equal(SWATCH_CELL, "▀");
		assert.equal(SPLASH_MARGIN_X, 3);
		assert.equal(LOGO_GAP, 4);
		assert.equal(PANEL_PADDING_X, 2);
		assert.equal(PANEL_MAX_WIDTH, 100);
		assert.equal(PANEL_MIN_WIDTH, 34);
		assert.equal(PANEL_MARGIN_Y, 1);
		assert.equal(MAX_SPLASH_ROW_SHARE, 0.6);
	});
});

describe("buildLabeledWrappedSection (S-02)", () => {
	it("heading row then wrapped items, all within width", () => {
		// This unit renders whatever label it's given verbatim; buildHeader is what appends the
		// count ("[skills] 24") before calling in, resolving F-5 in the report.
		const items = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
		for (let width = 12; width <= 90; width++) {
			const lines = buildLabeledWrappedSection(theme, "skills", items, width);
			assertLinesAtMost(lines, width, `section(width=${width})`);
			assert.equal(sanitizeTuiText(lines[0] ?? "").trim(), "skills", `width=${width}: heading row`);
			const text = lines.map((l) => sanitizeTuiText(l)).join("\n");
			for (const item of items) {
				assert.ok(text.includes(item), `width=${width}: item ${item} missing`);
			}
		}
	});
	it("UNSPECIFIED: empty items render a placeholder row, not nothing", () => {
		const lines = buildLabeledWrappedSection(theme, "skills", [], 40);
		assert.equal(lines.length >= 2, true);
		assert.equal(sanitizeTuiText(lines[1] ?? "").trim(), "none");
	});
});

describe("buildCountsLine (S-03)", () => {
	const EMPTY_SHORTCUTS: ShortcutHint[] = [];
	const EMPTY_PROMPTS: string[] = [];

	it("collapses all five lists to counts", () => {
		const context = ["AGENTS.md", "CLAUDE.md"];
		const skills = ["a", "b", "c"];
		const extensions = ["p", "q", "r", "s", "t"];
		const shortcuts: ShortcutHint[] = [
			{ key: "Ctrl+C", description: "interrupt" },
			{ key: "/", description: "commands" },
		];
		const prompts = ["/analyze", "/rewrite"];
		for (let width = 75; width <= 120; width += 5) {
			const lines = buildCountsLine(theme, context, skills, extensions, shortcuts, prompts, width);
			const text = lines.map(sanitizeTuiText).join(" · ");
			assert.ok(text.includes("[shortcuts] 2"), `width=${width}: ${JSON.stringify(text)}`);
			assert.ok(text.includes("[context] 2"), `width=${width}: ${JSON.stringify(text)}`);
			assert.ok(text.includes("[skills] 3"), `width=${width}: ${JSON.stringify(text)}`);
			assert.ok(text.includes("[prompts] 2"), `width=${width}: ${JSON.stringify(text)}`);
			assert.ok(text.includes("[extensions] 5"), `width=${width}`);
			assert.ok(text.includes("·"), `width=${width}`);
			assertLinesAtMost(lines, width, `counts(width=${width})`);
		}
	});

	it("wraps between whole counts instead of truncating when they overflow the width", () => {
		const context = ["AGENTS.md", "CLAUDE.md"];
		const skills = ["a", "b", "c"];
		const extensions = ["p", "q", "r", "s", "t"];
		const shortcuts: ShortcutHint[] = [
			{ key: "Ctrl+C", description: "interrupt" },
			{ key: "/", description: "commands" },
		];
		const prompts = ["/analyze", "/rewrite"];
		for (const width of [30, 45, 60]) {
			const lines = buildCountsLine(theme, context, skills, extensions, shortcuts, prompts, width);
			assert.ok(lines.length >= 2, `width=${width}: expected the counts to wrap, got ${lines.length} line(s)`);
			assertLinesAtMost(lines, width, `counts-wrap(width=${width})`);
			const text = lines.map(sanitizeTuiText).join("\n");
			for (const label of ["[shortcuts] 2", "[context] 2", "[skills] 3", "[prompts] 2", "[extensions] 5"]) {
				assert.ok(text.includes(label), `width=${width}: ${label} missing from ${JSON.stringify(text)}`);
			}
			assert.equal(text.includes("..."), false, `width=${width}: counts must not truncate with an ellipsis`);
			// A count is never split across the line break: every line ends on a complete `[label] N`.
			for (const line of lines) assert.match(sanitizeTuiText(line).trim(), /\d$/, `width=${width}: line ends mid-count: ${JSON.stringify(line)}`);
		}
	});

	it("shortcuts comes first in the collapsed counts", () => {
		const text = buildCountsLine(theme, ["AGENTS.md"], ["a"], ["b"], [{ key: "K", description: "d" }], ["/p"], 80).map(sanitizeTuiText).join("\n");
		assert.ok(text.indexOf("[shortcuts]") < text.indexOf("[context]"), text);
		assert.ok(text.indexOf("[context]") < text.indexOf("[skills]"), text);
		assert.ok(text.indexOf("[skills]") < text.indexOf("[prompts]"), text);
		assert.ok(text.indexOf("[prompts]") < text.indexOf("[extensions]"), text);
	});
});

describe("buildShortcutSection (S-13)", () => {
	const hints: ShortcutHint[] = [
		{ key: "Ctrl+C", description: "interrupt" },
		{ key: "Ctrl+L/Ctrl+Q", description: "clear/exit" },
		{ key: "/", description: "commands" },
	];

	it("renders keys dim and descriptions as text within width", () => {
		for (let width = 40; width <= 90; width++) {
			const lines = buildShortcutSection(theme, hints, width);
			assertLinesAtMost(lines, width, `shortcuts(width=${width})`);
			// First row is the heading
			assert.equal(sanitizeTuiText(lines[0] ?? "").trim(), "[shortcuts]");
			// All hints present in the output
			const text = lines.map((l) => sanitizeTuiText(l)).join("\n");
			for (const h of hints) {
				assert.ok(text.includes(h.key), `width=${width}: key ${h.key} missing`);
				assert.ok(text.includes(h.description), `width=${width}: description ${h.description} missing`);
			}
		}
	});

	it("wraps only between complete hints", () => {
		const wideHints: ShortcutHint[] = [
			{ key: "Ctrl+Shift+Alt+K", description: "very long action" },
			{ key: "Ctrl+Shift+Alt+L", description: "another long action" },
		];
		for (let width = 40; width <= 80; width += 5) {
			const lines = buildShortcutSection(theme, wideHints, width);
			assertLinesAtMost(lines, width, `shortcuts/wrap(width=${width})`);
		}
	});

	it("empty hints return no lines", () => {
		assert.deepEqual(buildShortcutSection(theme, [], 60), []);
	});
});

describe("buildPanelLines (S-04)", () => {
	it("carries version, model tagline and body within innerWidth", () => {
		const body = ["[skills] one, two", "[extensions] three"];
		for (let innerWidth = PANEL_MIN_WIDTH; innerWidth <= PANEL_MAX_WIDTH; innerWidth++) {
		const { lines } = buildPanelLines(theme, innerWidth, body, MODEL, 4000);
			assertLinesAtMost(lines, innerWidth, `panel(innerWidth=${innerWidth})`);
			const text = lines.map((l) => sanitizeTuiText(l)).join("\n");
			assert.ok(text.includes(`pi v${VERSION}`), `innerWidth=${innerWidth}: version missing`);
			assert.ok(text.includes("claude-opus-4"), `innerWidth=${innerWidth}: model missing`);
			assert.ok(text.includes("~1.0k tokens"), `innerWidth=${innerWidth}: prompt size missing`);
			assert.ok(text.includes("[skills] one, two"), `innerWidth=${innerWidth}: body missing`);
		}
	});
});

describe("paint primitives (S-05, S-10)", () => {
	function makePanel(x: number, y: number, innerWidth: number): PanelPlacement {
		return {
			x,
			y,
			width: innerWidth + 2 * PANEL_PADDING_X,
			bg: PANEL_BG_DARK,
			lines: buildPanelLines(theme, innerWidth, ["[skills] 2 · [extensions] 3"], MODEL, 4000).lines,
		};
	}

	it("paintPanelRow fills exactly the plate width", () => {
		const panel = makePanel(10, 2, 40);
		for (let y = panel.y; y < panel.y + panel.lines.length; y++) {
			const row = paintPanelRow(panel, y);
			assertLinesExact([row], panel.width, `paintPanelRow(y=${y})`);
		}
	});

	it("paintRow and paintSplash fill exactly the terminal width", () => {
		const ink = new Map<number, Ink>();
		const height = LOGO_LINES.length + 6;
		for (const width of [40, 80, 120, 200]) {
			stampLogo(ink, width, height, SPLASH_MARGIN_X, 1);
			const innerWidth = Math.min(40, width - 2 * PANEL_PADDING_X - 4);
			const panel = makePanel(2, 2, innerWidth);
			for (let y = 0; y < height; y++) {
				assertLinesExact([paintRow(y, width, height, ink, panel)], width, `paintRow(y=${y}, width=${width})`);
			}
			const rows = paintSplash(width, height, SPLASH_MARGIN_X, 1, panel);
			assert.equal(rows.length, height);
			assertLinesExact(rows, width, `paintSplash(width=${width})`);
			ink.clear();
		}
	});

	it("stampLogo writes ink and shadow within bounds", () => {
		const ink = new Map<number, Ink>();
		const width = LOGO_WIDTH + 10;
		const height = LOGO_LINES.length + 4;
		stampLogo(ink, width, height, 2, 1);
		assert.ok(ink.size > 0, "logo must stamp cells");
		const colors = new Set<string>();
		for (const key of ink.keys()) {
			assert.ok(Number.isInteger(key) && key >= 0 && key < width * height, `cell ${key} out of bounds`);
			colors.add(ink.get(key)!.color!);
		}
		assert.deepEqual([...colors].sort(), [LOGO_INK, LOGO_SHADOW].sort());
	});
});

describe("installer logo compositor (S-15, S-16)", () => {
	const installerParts = (width: number, animation: "off" | "breathe" = "off", frame = INSTALLER_LOGO_LAST_FRAME) =>
		buildHeaderParts(width, 60, theme, [], [], [], MODEL, 2048, "rainbow", animation, 0, [], [], undefined, "accent", "logo", frame);

	it("stamps bounded half-block cells, all frame colors, and a down-right shadow", () => {
		const width = 80;
		const height = 40;
		const originX = 3;
		const originY = 2;
		let finalShadowCells: { x: number; y: number }[] = [];
		let finalLogoCells: { x: number; y: number }[] = [];
		for (const [frameIndex, frame] of INSTALLER_LOGO_FRAMES.entries()) {
			const ink = new Map<number, Ink>();
			stampInstallerLogo(ink, width, height, originX, originY, frameIndex);
			assert.ok(ink.size > 0, `frame ${frameIndex} paints cells`);
			const colors = new Set<string>();
			const shadowCells: { x: number; y: number }[] = [];
			const logoCells: { x: number; y: number }[] = [];
			for (const [index, cell] of ink) {
				assert.ok(Number.isInteger(index) && index >= 0 && index < width * height, `frame ${frameIndex} cell ${index} in bounds`);
				assert.equal(cell.ch, "▀");
				if (cell.color) colors.add(cell.color);
				if (cell.backdrop) colors.add(cell.backdrop);
				const point = { x: index % width, y: Math.floor(index / width) };
				if (cell.color === LOGO_SHADOW || cell.backdrop === LOGO_SHADOW) shadowCells.push(point);
				if (Object.values(INSTALLER_LOGO_PALETTE).some((color) => cell.color === color || cell.backdrop === color)) logoCells.push(point);
			}
			const { x, y, width: cropWidth, height: cropHeight } = INSTALLER_LOGO_ANIMATION_BOUNDS;
			const usedKeys = new Set(frame.pixels.slice(y, y + cropHeight).map((row) => row.slice(x, x + cropWidth)).join("").replaceAll(".", ""));
			for (const key of usedKeys) assert.ok(colors.has(INSTALLER_LOGO_PALETTE[key]!), `frame ${frameIndex} visible color ${key} stamped`);
			for (const color of colors) assert.ok(color === LOGO_SHADOW || Object.values(INSTALLER_LOGO_PALETTE).includes(color));
			if (frameIndex === INSTALLER_LOGO_LAST_FRAME) {
				finalShadowCells = shadowCells;
				finalLogoCells = logoCells;
			}
		}
		assert.equal(Math.min(...finalShadowCells.map((point) => point.x)), Math.min(...finalLogoCells.map((point) => point.x)) + LOGO_SHADOW_OFFSET);
		assert.equal(Math.min(...finalShadowCells.map((point) => point.y)), Math.min(...finalLogoCells.map((point) => point.y)) + LOGO_SHADOW_OFFSET);
	});

	it("keeps the final hand-off frame on the animation-wide scale", () => {
		const ink = new Map<number, Ink>();
		const width = 80;
		stampInstallerLogo(ink, width, 32, 20, 3, INSTALLER_LOGO_LAST_FRAME);
		const white = INSTALLER_LOGO_PALETTE.w;
		const body = [...ink.entries()].flatMap(([index, cell]) =>
			cell.color === white || cell.backdrop === white
				? [{ x: index % width, y: Math.floor(index / width) }]
				: [],
		);
		assert.ok(body.length > 0, "final source pixels are stamped with the installer white");
		const minX = Math.min(...body.map(({ x }) => x));
		const maxX = Math.max(...body.map(({ x }) => x));
		const minY = Math.min(...body.map(({ y }) => y));
		const maxY = Math.max(...body.map(({ y }) => y));
		const { scale } = installerLogoMetrics();
		const fitted = Math.floor(Math.min(LOGO_WIDTH / INSTALLER_LOGO_ANIMATION_BOUNDS.width, (2 * LOGO_ROWS) / INSTALLER_LOGO_ANIMATION_BOUNDS.height));
		assert.equal(scale, fitted * 2, "the installer mark is twice the glyph-slot fit");
		assert.equal(maxX - minX + 1, 4 * scale, "final frame's four active columns use the doubled shared scale");
		assert.equal(maxY - minY + 1, 12, "the half-block raster is twice as tall as the previous scale-3 mark");
	});

	it("keeps both styles exact-width and preserves layout, repaint scope, and the glyph default", () => {
		const glyphDefault = buildHeaderParts(120, 60, theme, [], [], [], MODEL, 2048, "rainbow", "off", 0, [], [], undefined, "accent", "symbol");
		assert.deepEqual(
			buildHeaderParts(120, 60, theme, [], [], [], MODEL, 2048, "rainbow", "off", 0, [], [], undefined, "accent", "symbol", 0).lines,
			glyphDefault.lines,
			"the explicit glyph style preserves the original bytes",
		);
		assert.equal(glyphDefault.repaintLogo, undefined);
		assert.notEqual(installerParts(120).repaintLogo, undefined);
		for (const style of ["symbol", "logo"] as const) {
			for (let width = 1; width <= 200; width++) {
				const parts = buildHeaderParts(width, 60, theme, [], [], [], MODEL, 2048, "rainbow", "off", 0, [], [], undefined, "accent", style);
				assertLinesExact(parts.lines, width, `${style} header width=${width}`);
			}
		}
		const slot = installerLogoMetrics();
		for (const width of [120, 160]) {
			const glyph = buildHeaderParts(width, 60, theme, [], [], [], MODEL, 2048, "rainbow", "off", 0, [], [], undefined, "accent", "symbol");
			assert.equal(installerParts(width).lines.length, slot.rows + 2, `side-by-side installer grows to its slot at width ${width}`);
			assert.ok(glyph.lines.length < slot.rows + 2, `glyph band stays shorter than the installer slot at width ${width}`);
		}
		const parts = installerParts(120, "breathe");
		const repainted = parts.repaintLogo!(0);
		assert.ok(repainted.length > 0);
		assert.ok(repainted.length <= slot.rows + 1);
		assert.ok(repainted.every(({ row }) => row >= 0 && row < parts.lines.length));
		assert.ok(repainted.at(-1)!.row - repainted[0]!.row <= slot.rows);
		const afterLogo = parts.repaintBackdrop!(2000);
		const expected = installerParts(120, "breathe", 0).repaintBackdrop!(2000);
		assert.deepEqual(afterLogo, expected, "backdrop repaint sees the latest shared ink frame");
	});

	it("keeps the final source frame's shadow inside its row budget in both layouts", () => {
		const esc = String.fromCharCode(27);
		const sgrs = (mode: 38 | 48, color: string) => `${esc}[${mode};2;${color}m`;
		const shadowSgrs = [sgrs(38, LOGO_SHADOW), sgrs(48, LOGO_SHADOW)];
		const bodySgrs = Object.values(INSTALLER_LOGO_PALETTE).flatMap((color) => [sgrs(38, color), sgrs(48, color)]);
		for (const width of [60, 160]) {
			const lines = installerParts(width).lines;
			const shadowRows = lines.flatMap((line, row) => shadowSgrs.some((code) => line.includes(code)) ? [row] : []);
			const bodyRows = lines.flatMap((line, row) => bodySgrs.some((code) => line.includes(code)) ? [row] : []);
			assert.ok(shadowRows.length > 0 && bodyRows.length > 0, `logo and shadow at width ${width}`);
			assert.equal(Math.max(...shadowRows), Math.max(...bodyRows) + LOGO_SHADOW_OFFSET, `one-row shadow at width ${width}`);
			assert.ok(!shadowSgrs.some((code) => lines[Math.max(...shadowRows) + 1]?.includes(code)), `shadow does not leak at width ${width}`);
		}
	});

	it("lifts the installer brand mark LOGO_LIFT_ROWS above the splash's vertical center, side by side", () => {
		// The glyph stays exactly centered; only the installer logo gets the optical lift.
		// Use a section big enough that the panel outgrows the installer slot, so the lift is visible
		// and the top-edge clamp (`max(0, ...)`) does not hide it.
		const section = () => Array.from({ length: 40 }, () => "x");
		// Frame 0 paints at source row 0, so its topmost ink cell sits exactly at `logoY` (slot.offsetYSub
		// is 0 for the animation bounds). The white hand-off frame would gap down to row 9 instead.
		const FIRST_FRAME = 0;
		const paletteSgrs = Object.values(INSTALLER_LOGO_PALETTE).flatMap((color) => [`\x1b[38;2;${color}m`, `\x1b[48;2;${color}m`]);
		const logoInkSgr = `\x1b[38;2;${LOGO_INK}m`;
		const topmostInkRow = (lines: string[], needles: string[]): number => {
			for (let row = 0; row < lines.length; row++) {
				if (needles.some((code) => lines[row]!.includes(code))) return row;
			}
			return -1;
		};
		for (const width of [120, 160]) {
			const installer = buildHeaderParts(width, 100, theme, [], [], [], MODEL, 2048, "rainbow", "off", 0, [], [], section, "accent", "logo", FIRST_FRAME);
			const glyph = buildHeaderParts(width, 100, theme, [], [], [], MODEL, 2048, "rainbow", "off", 0, [], [], section, "accent", "symbol");
			const slot = installerLogoMetrics();
			const height = installer.lines.length;
			assert.equal(height, glyph.lines.length, "same splash height either way");
			const installerMinY = topmostInkRow(installer.lines, paletteSgrs);
			const glyphMinY = topmostInkRow(glyph.lines, [logoInkSgr]);
			assert.equal(installerMinY, Math.max(0, Math.floor((height - slot.rows) / 2) - LOGO_LIFT_ROWS), `width ${width}: installer mark lifted LOGO_LIFT_ROWS above center`);
			assert.equal(glyphMinY, Math.floor((height - LOGO_LINES.length) / 2), `width ${width}: glyph stays exactly centered`);
			assert.ok(installerMinY < glyphMinY, `width ${width}: installer mark sits above the centered glyph`);
			// A splash no taller than the installer slot clamps the lift at the top edge.
			const tight = buildHeaderParts(width, 60, theme, [], [], [], MODEL, 2048, "rainbow", "off", 0, [], [], undefined, "accent", "logo", FIRST_FRAME);
			assert.equal(topmostInkRow(tight.lines, paletteSgrs), 0, `width ${width}: clamp at the top edge when the slot fills the splash`);
		}
	});
});

describe("shadow spare row (S-09)", () => {
	const glyphRows = (lines: string[], columns: number): number[] =>
		lines.flatMap((line, row) => (/[^▀ ]/.test(sanitizeTuiText(line).slice(0, columns)) ? [row] : []));

	it("side-by-side: glyph rows span the logo plus one shadow row", () => {
		const width = 160;
		const lines = buildHeader(width, 60, theme, [], [], [], MODEL, 2048, "rainbow", "off", 0, [], [], undefined, undefined, "symbol");
		const panelX = width - SPLASH_MARGIN_X - Math.min(PANEL_MAX_WIDTH, width - SPLASH_MARGIN_X * 2 - LOGO_WIDTH - LOGO_GAP);
		const rows = glyphRows(lines, panelX);
		assert.ok(rows.length > 0, "logo ink present");
		assert.equal(
			rows[rows.length - 1]! - rows[0]!,
			LOGO_LINES.length - 1 + LOGO_SHADOW_OFFSET,
			"glyph rows cover the logo plus the spare shadow row",
		);
	});

	it("stacked: the row below the logo carries the shadow, the next is bare swatch", () => {
		const lines = buildHeader(40, 60, theme, [], [], [], MODEL, 2048, "rainbow", "off", 0, [], [], undefined, undefined, "symbol");
		assert.match(sanitizeTuiText(lines[LOGO_LINES.length] ?? ""), /[^▀ ]/, "spare row carries shadow glyphs");
		assert.doesNotMatch(sanitizeTuiText(lines[LOGO_LINES.length + 1] ?? ""), /[^▀ ]/, "shadow stops at the spare row");
	});
});

describe("buildHeader width invariant (S-06) — the process-killer guard", () => {
	const EMPTY_SHORTCUTS: ShortcutHint[] = [];
	const EMPTY_PROMPTS: string[] = [];

	const itemSets: [string, string[], string[], string[], ShortcutHint[], string[]][] = [
		["empty", [], [], [], EMPTY_SHORTCUTS, EMPTY_PROMPTS],
		["short", ["AGENTS.md"], ["alpha", "beta"], ["gamma-ext"], [{ key: "Ctrl+C", description: "interrupt" }], ["/rewrite"]],
		[
			"many",
			Array.from({ length: 3 }, (_, i) => `docs/CLAUDE-${i}.md`),
			Array.from({ length: 24 }, (_, i) => `skill-${i}`),
			Array.from({ length: 40 }, (_, i) => `extension-package-${i}`),
			[{ key: "Ctrl+C", description: "interrupt" }, { key: "Ctrl+L", description: "clear/exit" }, { key: "/", description: "commands" }, { key: "!", description: "bash" }, { key: "Ctrl+T", description: "more" }],
			Array.from({ length: 10 }, (_, i) => `/prompt-${i}`),
		],
	];
	it("every line exactly fills the width, for widths 1..200", () => {
		for (const [label, context, skills, extensions, shortcuts, prompts] of itemSets) {
			for (const termRows of [10, 24, 40, 120]) {
				for (let width = 1; width <= 200; width++) {
					const lines = buildHeader(width, termRows, theme, context, skills, extensions, MODEL, 4000, "rainbow", "off", 0, prompts, shortcuts);
					assertLinesExact(lines, width, `buildHeader(${label}, rows=${termRows}, width=${width})`);
				}
			}
		}
	});
	it("holds without model or prompt size", () => {
		for (let width = 1; width <= 200; width += 7) {
			assertLinesExact(buildHeader(width, 40, theme, ["AGENTS.md"], ["a"], ["b"], undefined, undefined, "rainbow", "off", 0, [], []), width, `no-model width=${width}`);
		}
	});
});

describe("collapse conditions (S-07)", () => {
	const context = ["AGENTS.md"];
	const skills = ["alpha", "beta"];
	const extensions = ["gamma", "delta"];

	it("tall terminal with fitting names lists everything inline, shortcuts first", () => {
		const lines = buildHeader(160, 60, theme, context, skills, extensions, MODEL, 4000, "rainbow", "off", 0, ["/rewrite"], [{ key: "Ctrl+C", description: "interrupt" }]);
		const text = lines.map((l) => sanitizeTuiText(l)).join("\n");
		for (const name of [...context, ...skills, ...extensions]) {
			assert.ok(text.includes(name), `${name} should be listed inline`);
		}
		assert.ok(text.includes("[shortcuts] 1"), "shortcuts heading with count");
		assert.ok(text.includes("[context] 1"), "context heading with count");
		assert.ok(text.indexOf("[shortcuts]") < text.indexOf("[context]"), "shortcuts section precedes context");
		assert.ok(text.indexOf("[context]") < text.indexOf("[skills]"), "context section precedes skills");
		assert.ok(text.indexOf("[skills]") < text.indexOf("[prompts]"), "skills precedes prompts");
		assert.ok(text.indexOf("[prompts]") < text.indexOf("[extensions]"), "prompts precedes extensions");
	});

	it("row budget exceeded collapses to a counts line", () => {
		const manySkills = Array.from({ length: 40 }, (_, i) => `skill-number-${i}`);
		const lines = buildHeader(160, 12, theme, context, manySkills, extensions, MODEL, 4000, "rainbow", "off", 0, ["/rewrite"], [{ key: "Ctrl+C", description: "interrupt" }]);
		const text = lines.map((l) => sanitizeTuiText(l)).join("\n");
		assert.ok(text.includes("[shortcuts] 1"), "shortcuts count expected");
		assert.ok(text.includes("[skills] 40"), "skills count expected");
		assert.ok(text.includes("[prompts] 1"), "prompts count expected");
		assert.equal(text.includes("skill-number-0"), false, "names must not be listed");
	});

	it("a context path wider than the panel collapses to a counts line", () => {
		const wide = "an/extraordinarily-long/path/with-a-very-long-AGENTS-name-that-cannot-fit-any-panel.md";
		const lines = buildHeader(100, 60, theme, [wide], skills, extensions, MODEL, 4000, "rainbow", "off", 0, ["/rewrite"], [{ key: "Ctrl+C", description: "interrupt" }]);
		const text = lines.map((l) => sanitizeTuiText(l)).join("\n");
		assert.ok(text.includes("[context] 1"), "counts line expected");
		assert.equal(text.includes(wide), false, "the overlong path must not be listed");
	});

	it("inline listing never exceeds the 60% row budget (README)", () => {
		const mediumSet = Array.from({ length: 60 }, (_, i) => `skill-name-${String(i).padStart(4, "0")}`);
		let inlineSeen = false;
		let collapsedSeen = false;
		for (let termRows = 30; termRows <= 60; termRows += 2) {
			const lines = buildHeader(160, termRows, theme, ["AGENTS.md"], mediumSet, extensions, MODEL, 4000, "rainbow", "off", 0, [], []);
			if (lines.some((line) => sanitizeTuiText(line).includes(mediumSet[0]!))) {
				inlineSeen = true;
				assert.ok(
					lines.length <= Math.floor(termRows * MAX_SPLASH_ROW_SHARE),
					`termRows=${termRows}: inline splash is ${lines.length} rows, budget ${Math.floor(termRows * MAX_SPLASH_ROW_SHARE)}`,
				);
			} else {
				collapsedSeen = true;
			}
		}
		assert.ok(inlineSeen, "sweep must exercise the inline branch");
		assert.ok(collapsedSeen, "sweep must exercise the collapsed branch");
	});

	it("a name wider than the panel collapses to a counts line", () => {
		const wide = "an-extraordinarily-long-skill-name-that-cannot-possibly-fit-in-any-panel-column-budget";
		const lines = buildHeader(100, 60, theme, ["AGENTS.md"], [wide], extensions, MODEL, 4000, "rainbow", "off", 0, [], []);
		const text = lines.map((l) => sanitizeTuiText(l)).join("\n");
		assert.ok(text.includes("[skills] 1"), "counts line expected");
		assert.equal(text.includes(wide), false, "the overlong name must not be listed");
	});
});

describe("layout stacking (S-08)", () => {
	const logoFg = `\x1b[38;2;${LOGO_INK}m`;
	const panelBgSgr = `\x1b[48;2;${PANEL_BG_DARK}m`;
	const sideBySideMin = 2 * SPLASH_MARGIN_X + LOGO_WIDTH + LOGO_GAP + PANEL_MIN_WIDTH;

	it("wide terminals put the panel beside the logo", () => {
		const lines = buildHeader(sideBySideMin + 20, 50, theme, ["AGENTS.md"], ["alpha"], ["beta"], MODEL, 4000, "rainbow", "off", 0, [], [], undefined, undefined, "symbol");
		assert.ok(
			lines.some((l) => l.includes(logoFg) && l.includes(panelBgSgr)),
			"some row should carry both logo ink and panel plate",
		);
	});

	it("narrow terminals stack the panel under the logo", () => {
		const lines = buildHeader(sideBySideMin - 6, 60, theme, ["AGENTS.md"], ["alpha"], ["beta"], MODEL, 4000, "rainbow", "off", 0, [], [], undefined, undefined, "symbol");
		assert.equal(
			lines.some((l) => l.includes(logoFg) && l.includes(panelBgSgr)),
			false,
			"no row should carry both logo ink and panel plate when stacked",
		);
		const firstLogoRow = lines.findIndex((l) => l.includes(logoFg));
		const firstPanelRow = lines.findIndex((l) => l.includes(panelBgSgr));
		assert.ok(firstLogoRow >= 0, "logo must render");
		assert.ok(firstPanelRow > firstLogoRow, "panel must sit below the logo");
	});
});

describe("custom sampler plumbing", () => {
	it("paintRow and paintSplash use the supplied sampler instead of the rainbow default", () => {
		const ink = new Map<number, Ink>();
		const width = 40;
		const height = LOGO_LINES.length + 6;
		const innerWidth = Math.min(30, width - 2 * PANEL_PADDING_X - 4);
		const panel: PanelPlacement = {
			x: 2,
			y: 2,
			width: innerWidth + 2 * PANEL_PADDING_X,
			bg: PANEL_BG_DARK,
			lines: buildPanelLines(theme, innerWidth, ["body"], MODEL, 4000).lines,
		};
		const fixed: import("../src/color.ts").SwatchSampler = () => "9;9;9";
		const row = paintRow(0, width, height, ink, panel, fixed);
		assert.ok(row.includes("\x1b[38;2;9;9;9m") || row.includes("\x1b[48;2;9;9;9m"), "custom sampler color must appear");
		const rows = paintSplash(width, height, SPLASH_MARGIN_X, 1, panel, fixed);
		assertLinesExact(rows, width, "paintSplash with custom sampler");
	});

	it("buildHeader accepts a background selection and stays exact-width for every mode", () => {
		for (const background of ["rainbow", "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "dynamic"] as const) {
			for (const width of [1, 40, 80, 160]) {
				const lines = buildHeader(width, 40, theme, ["AGENTS.md"], ["a"], ["b"], MODEL, 4000, background, "off", 0, [], []);
				assertLinesExact(lines, width, `buildHeader(background=${background}, width=${width})`);
			}
		}
	});
});

describe("animated backdrop repaint (S-12)", () => {
	it("repaintBackdrop exists exactly when an animation is on, for any backdrop", () => {
		const partsFor = (background: "rainbow" | "accent" | "dynamic", animation: "off" | "breathe" | "flow") =>
			buildHeaderParts(100, 40, theme, ["AGENTS.md"], ["a"], ["b"], MODEL, 4000, background, animation, 0);
		assert.equal(partsFor("rainbow", "off").repaintBackdrop, undefined, "static rainbow has nothing to repaint");
		assert.equal(partsFor("accent", "off").repaintBackdrop, undefined, "off stays static");
		assert.equal(partsFor("dynamic", "off").repaintBackdrop, undefined, "dynamic adds no timer of its own");
		assert.notEqual(partsFor("accent", "flow").repaintBackdrop, undefined, "animated theme color must expose the hook");
		assert.notEqual(partsFor("rainbow", "breathe").repaintBackdrop, undefined, "animated rainbow must expose the hook");
		assert.notEqual(partsFor("dynamic", "breathe").repaintBackdrop, undefined, "animated dynamic must expose the hook");
	});

	it("repainted frames stay exact-width, keep the row count and reflect the advanced clock", () => {
		// Times chosen mid-motion for each animation so the frame visibly differs from timeMs=0.
		const midpoints = { breathe: 2000, flow: 2000, sheen: 700, wave: 1250 } as const;
		for (const background of ["accent", "rainbow", "dynamic"] as const) {
			for (const [animation, timeMs] of Object.entries(midpoints) as [keyof typeof midpoints, number][]) {
				const parts = buildHeaderParts(100, 40, theme, ["AGENTS.md"], ["a"], ["b"], MODEL, 4000, background, animation, 0);
				const frame = parts.repaintBackdrop!(timeMs);
				assertLinesExact(frame, 100, `repaintBackdrop(${background}, ${animation})`);
				assert.equal(frame.length, parts.lines.length, `${background} ${animation}: row count stable`);
				assert.notDeepEqual(frame, parts.lines, `${background} ${animation}: the frame must move`);
			}
		}
	});

	it("threads the dynamic tint through the splash sampler", () => {
		const success = buildHeaderParts(100, 40, theme, ["AGENTS.md"], ["a"], ["b"], MODEL, 4000, "dynamic", "off", 0, [], [], undefined, "success");
		const error = buildHeaderParts(100, 40, theme, ["AGENTS.md"], ["a"], ["b"], MODEL, 4000, "dynamic", "off", 0, [], [], undefined, "error");
		assertLinesExact(success.lines, 100, "dynamic success tint");
		assertLinesExact(error.lines, 100, "dynamic error tint");
		assert.notDeepEqual(success.lines, error.lines, "different dynamic tints must change the backdrop");
	});
});

describe("panel section (S-14)", () => {
	const PLATE_BG_SGR = `\x1b[48;2;${PANEL_BG_DARK}m`;
	const LOGO_FG_SGR = `\x1b[38;2;${LOGO_INK}m`;
	const CONTEXT = ["AGENTS.md"];
	const SKILLS = ["alpha"];
	const EXTENSIONS = ["beta"];
	const SECTION = ["", "[gamma] 2", "delta"];
	const build = (width: number, termRows: number, section?: (band: SplashBand) => string[], animation: "off" | "breathe" = "off", background: "rainbow" | "accent" = "rainbow") =>
		buildHeaderParts(width, termRows, theme, CONTEXT, SKILLS, EXTENSIONS, MODEL, 4000, background, animation, 0, [], [], section, undefined, "symbol");
	const bandOf = (width: number, termRows: number): SplashBand => {
		let seen: SplashBand | undefined;
		build(width, termRows, (band) => { seen = band; return []; });
		return seen!;
	};
	/** Red channel of the first swatch cell's lower half on a row: the fade measured down column 0. */
	const edgeRed = (row: string): number => Number(/\x1b\[48;2;(\d+);/.exec(row)?.[1]);
	/** Indexes of the rows the panel's plate covers. */
	const panelRows = (lines: string[]) => lines.flatMap((line, index) => (line.includes(PLATE_BG_SGR) ? [index] : []));

	it("closes the panel with the section, after [extensions] and above the closing padding row", () => {
		// 40 columns stacks the panel under the logo; the rest sit side by side. Sixty rows keep the lists listed.
		for (const width of [40, 100, 120, 160]) {
			const base = build(width, 60);
			const parts = build(width, 60, () => SECTION);
			const text = parts.lines.map(sanitizeTuiText);
			const extensionsRow = text.findIndex((line) => line.includes("[extensions] 1"));
			const headingRow = text.findIndex((line) => line.includes("[gamma] 2"));
			const column = text[extensionsRow].indexOf("[extensions]");
			assert.equal(headingRow, extensionsRow + 3, `width ${width}: after the extension list and the section's own gap`);
			assert.equal(text[headingRow].indexOf("[gamma]"), column, `width ${width}: flush with the other headings`);
			assert.equal(text[headingRow + 1].indexOf("delta"), column, `width ${width}: flush with the other items`);
			const padding = parts.lines[headingRow + 2];
			assert.ok(padding.includes(PLATE_BG_SGR), `width ${width}: the panel's closing padding row follows the section`);
			assert.equal(sanitizeTuiText(padding).slice(column - PANEL_PADDING_X, column + 20).trim(), "", `width ${width}: padding row is blank`);
			assert.equal(parts.lines.length, base.lines.length + SECTION.length, `width ${width}: the panel outgrows the logo, so each row adds one`);
			assertLinesExact(parts.lines, width, `section at width ${width}`);
		}
	});

	it("reports the panel's text width and the rows spent down to its foot", () => {
		assert.deepEqual(bandOf(120, 50), { width: Math.min(PANEL_MAX_WIDTH, 120 - 2 * SPLASH_MARGIN_X - LOGO_WIDTH - LOGO_GAP) - 2 * PANEL_PADDING_X, rows: build(120, 50).lines.length });
		assert.deepEqual(bandOf(40, 50), { width: 40 - 2 * SPLASH_MARGIN_X - 2 * PANEL_PADDING_X, rows: build(40, 50).lines.length });
		// Ten rows collapse the lists to counts, so the logo beside the panel is the taller of the two.
		assert.ok(bandOf(160, 10).rows < build(160, 10).lines.length, "a panel shorter than the logo leaves rows under its foot");
	});

	it("fills the rows beside a taller logo before growing the splash", () => {
		// Ten rows collapse the lists to counts, so the logo's band is the taller one.
		const logoBand = LOGO_LINES.length + 2;
		const base = build(160, 10);
		assert.equal(base.lines.length, logoBand);
		const listsRows = panelRows(base.lines).length;
		for (let extra = 0; extra <= logoBand; extra++) {
			const parts = build(160, 10, () => Array.from({ length: extra }, () => "x"));
			assert.equal(parts.lines.length, Math.max(logoBand, listsRows + extra + 2 * PANEL_MARGIN_Y), `extra ${extra}`);
		}
	});

	it("leaves the splash untouched when there is no section", () => {
		for (const section of [undefined, () => []]) {
			assert.deepEqual(build(120, 50, section).lines, build(120, 50).lines);
		}
	});

	it("centers the glyph and the panel on the finished splash, section included", () => {
		// Panel taller than the logo (120x50), and logo taller until the section outgrows it (160x10).
		for (const [width, termRows] of [[120, 50], [160, 10]] as const) {
			for (const extra of [0, 3, 12, 20]) {
				const parts = build(width, termRows, () => Array.from({ length: extra }, () => "x"));
				const height = parts.lines.length;
				const label = `${width}x${termRows} with ${extra} section rows`;
				assert.equal(parts.lines.findIndex((line) => line.includes(LOGO_FG_SGR)), Math.floor((height - LOGO_LINES.length) / 2), `${label}: glyph centered`);
				const rows = panelRows(parts.lines);
				assert.equal(rows[0], Math.floor((height - rows.length) / 2), `${label}: panel centered`);
			}
		}
	});

	it("keeps the lists and the tagline row in place when the panel is already the taller of the two", () => {
		const base = build(120, 50);
		const parts = build(120, 50, () => SECTION);
		// The logo re-centers, so compare only the panel's columns. The taller fade shifts colors, so
		// compare the visible glyphs. The section's gap takes the row where the closing padding was.
		const column = sanitizeTuiText(base.lines.find((line) => line.includes("[extensions]"))!).indexOf("[extensions]") - PANEL_PADDING_X;
		const panelText = (lines: string[]) => lines.slice(0, base.lines.length - 2).map((line) => sanitizeTuiText(line).slice(column));
		assert.deepEqual(panelText(parts.lines), panelText(base.lines));
		assert.equal(parts.repaintTagline?.().row, base.repaintTagline?.().row);
	});

	it("runs the fade over the whole taller splash, so the old foot is brighter than without the section", () => {
		const base = build(120, 50, undefined, "off", "accent");
		const parts = build(120, 50, () => Array.from({ length: 12 }, () => "x"), "off", "accent");
		const foot = base.lines.length - 1;
		assert.ok(edgeRed(parts.lines[foot]) > edgeRed(base.lines[foot]) + 20, "the old last row is lifted off black");
		const topRed = (row: string): number => Number(/\x1b\[38;2;(\d+);/.exec(row)?.[1]);
		assert.equal(topRed(parts.lines[0]), topRed(base.lines[0]), "the top edge is full brightness either way");
		const reds = parts.lines.map(edgeRed);
		reds.slice(1).forEach((red, i) => assert.ok(red <= reds[i], `row ${i + 1} is no brighter than the row above it`));
		assert.ok(reds.at(-1)! < reds[foot], "the fade keeps going beside the section");
	});

	it("repaints the section rows with the backdrop and never moves them", () => {
		const parts = build(120, 50, () => SECTION, "breathe");
		const frame = parts.repaintBackdrop!(2000);
		assert.equal(frame.length, parts.lines.length);
		assertLinesExact(frame, 120, "repainted section frame");
		assert.deepEqual(frame.map(sanitizeTuiText), parts.lines.map(sanitizeTuiText));
		assert.notDeepEqual(frame, parts.lines, "the backdrop around the panel must move");
	});

	it("repaints only the section rows that changed, and asks for a rebuild when the row count moves", () => {
		let rows = [...SECTION];
		const parts = build(120, 50, () => rows, "breathe");
		assert.deepEqual(parts.repaintSection!(), [], "unchanged rows repaint nothing");
		const deltaRow = parts.lines.findIndex((line) => sanitizeTuiText(line).includes("delta"));
		rows = ["", "[gamma] 2", "epsilon"];
		const repainted = parts.repaintSection!()!;
		assert.equal(repainted.length, 1);
		assert.equal(repainted[0].row, deltaRow);
		assert.ok(sanitizeTuiText(repainted[0].line).includes("epsilon"));
		assertLinesExact([repainted[0].line], 120, "repainted section row");
		// A later backdrop frame keeps the new row, since the panel holds it now.
		assert.ok(sanitizeTuiText(parts.repaintBackdrop!(2000)[deltaRow]).includes("epsilon"));
		rows = ["", "[gamma] 2"];
		assert.equal(parts.repaintSection!(), null, "a section that changed height needs a rebuild");
		assert.equal(build(120, 50).repaintSection, undefined);
		assert.equal(build(120, 50, () => []).repaintSection, undefined);
	});

	it("stays exact-width at every width and terminal height, section included", () => {
		for (const termRows of [10, 24, 40]) {
			for (let width = 1; width <= 200; width++) {
				assertLinesExact(build(width, termRows, (band) => [" ".repeat(band.width), "y".repeat(band.width + 5)]).lines, width, `section rows=${termRows} width=${width}`);
			}
		}
	});
});
