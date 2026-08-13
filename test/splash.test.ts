import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
	buildCountsLine,
	buildHeader,
	buildLabeledWrappedSection,
	buildPanelLines,
	LOGO_GAP,
	MAX_SPLASH_ROW_SHARE,
	PANEL_MARGIN_Y,
	PANEL_MAX_WIDTH,
	PANEL_MIN_WIDTH,
	PANEL_PADDING_X,
	paintPanelRow,
	paintRow,
	paintSplash,
	SPLASH_MARGIN_X,
	stampLogo,
	SWATCH_CELL,
	type Ink,
	type PanelPlacement,
} from "../src/splash.ts";
import { LOGO_INK, LOGO_LINES, LOGO_SHADOW, LOGO_SHADOW_OFFSET, LOGO_WIDTH } from "../src/logo.ts";
import { PANEL_BG_DARK } from "../src/color.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { makeTheme } from "./helpers/theme.ts";
import { assertLinesAtMost, assertLinesExact } from "./helpers/width.ts";

beforeEach(() => resetModuleState());

const theme = makeTheme();
const MODEL = { id: "claude-opus-4", provider: "anthropic" };

describe("constants (S-01)", () => {
	it("README-documented layout anchors", () => {
		assert.equal(SWATCH_CELL, "▀");
		assert.equal(SPLASH_MARGIN_X, 3);
		assert.equal(LOGO_GAP, 4);
		assert.equal(PANEL_PADDING_X, 2);
		assert.equal(PANEL_MAX_WIDTH, 72);
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
	it("collapses all three lists to counts", () => {
		const context = ["AGENTS.md", "CLAUDE.md"];
		const skills = ["a", "b", "c"];
		const extensions = ["p", "q", "r", "s", "t"];
		for (let width = 45; width <= 90; width += 5) {
			const line = buildCountsLine(theme, context, skills, extensions, width);
			const text = sanitizeTuiText(line);
			assert.ok(text.includes("[context] 2"), `width=${width}: ${JSON.stringify(text)}`);
			assert.ok(text.includes("[skills] 3"), `width=${width}: ${JSON.stringify(text)}`);
			assert.ok(text.includes("[extensions] 5"), `width=${width}`);
			assert.ok(text.includes("·"), `width=${width}`);
			assertLinesAtMost([line], width, `counts(width=${width})`);
		}
	});
	it("context comes first in the collapsed line", () => {
		const text = sanitizeTuiText(buildCountsLine(theme, ["AGENTS.md"], ["a"], ["b"], 60));
		assert.ok(text.indexOf("[context]") < text.indexOf("[skills]"), text);
		assert.ok(text.indexOf("[skills]") < text.indexOf("[extensions]"), text);
	});
});

describe("buildPanelLines (S-04)", () => {
	it("carries version, model tagline and body within innerWidth", () => {
		const body = ["[skills] one, two", "[extensions] three"];
		for (let innerWidth = PANEL_MIN_WIDTH; innerWidth <= PANEL_MAX_WIDTH; innerWidth++) {
			const lines = buildPanelLines(theme, innerWidth, body, MODEL, 4000);
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
			lines: buildPanelLines(theme, innerWidth, ["[skills] 2 · [extensions] 3"], MODEL, 4000),
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
			colors.add(ink.get(key)!.color);
		}
		assert.deepEqual([...colors].sort(), [LOGO_INK, LOGO_SHADOW].sort());
	});
});

describe("shadow spare row (S-09)", () => {
	const glyphRows = (lines: string[], columns: number): number[] =>
		lines.flatMap((line, row) => (/[^▀ ]/.test(sanitizeTuiText(line).slice(0, columns)) ? [row] : []));

	it("side-by-side: glyph rows span the logo plus one shadow row", () => {
		const width = 160;
		const lines = buildHeader(width, 60, theme, [], [], [], MODEL, 2048);
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
		const lines = buildHeader(40, 60, theme, [], [], [], MODEL, 2048);
		assert.match(sanitizeTuiText(lines[LOGO_LINES.length] ?? ""), /[^▀ ]/, "spare row carries shadow glyphs");
		assert.doesNotMatch(sanitizeTuiText(lines[LOGO_LINES.length + 1] ?? ""), /[^▀ ]/, "shadow stops at the spare row");
	});
});

describe("buildHeader width invariant (S-06) — the process-killer guard", () => {
	const itemSets: [string, string[], string[], string[]][] = [
		["empty", [], [], []],
		["short", ["AGENTS.md"], ["alpha", "beta"], ["gamma-ext"]],
		[
			"many",
			Array.from({ length: 3 }, (_, i) => `docs/CLAUDE-${i}.md`),
			Array.from({ length: 24 }, (_, i) => `skill-${i}`),
			Array.from({ length: 40 }, (_, i) => `extension-package-${i}`),
		],
	];
	it("every line exactly fills the width, for widths 1..200", () => {
		for (const [label, context, skills, extensions] of itemSets) {
			for (const termRows of [10, 24, 40, 120]) {
				for (let width = 1; width <= 200; width++) {
					const lines = buildHeader(width, termRows, theme, context, skills, extensions, MODEL, 4000);
					assertLinesExact(lines, width, `buildHeader(${label}, rows=${termRows}, width=${width})`);
				}
			}
		}
	});
	it("holds without model or prompt size", () => {
		for (let width = 1; width <= 200; width += 7) {
			assertLinesExact(buildHeader(width, 40, theme, ["AGENTS.md"], ["a"], ["b"]), width, `no-model width=${width}`);
		}
	});
});

describe("collapse conditions (S-07)", () => {
	const context = ["AGENTS.md"];
	const skills = ["alpha", "beta"];
	const extensions = ["gamma", "delta"];

	it("tall terminal with fitting names lists everything inline, context first", () => {
		const lines = buildHeader(160, 60, theme, context, skills, extensions, MODEL, 4000);
		const text = lines.map((l) => sanitizeTuiText(l)).join("\n");
		for (const name of [...context, ...skills, ...extensions]) {
			assert.ok(text.includes(name), `${name} should be listed inline`);
		}
		assert.ok(text.includes("[context] 1"), "context heading with count");
		assert.ok(text.indexOf("[context]") < text.indexOf("[skills]"), "context section precedes skills");
		assert.ok(text.indexOf("[skills]") < text.indexOf("[extensions]"), "skills precedes extensions");
	});

	it("row budget exceeded collapses to a counts line", () => {
		const manySkills = Array.from({ length: 40 }, (_, i) => `skill-number-${i}`);
		const lines = buildHeader(160, 12, theme, context, manySkills, extensions, MODEL, 4000);
		const text = lines.map((l) => sanitizeTuiText(l)).join("\n");
		assert.ok(text.includes("[skills] 40"), "counts line expected");
		assert.equal(text.includes("skill-number-0"), false, "names must not be listed");
	});

	it("a context path wider than the panel collapses to a counts line", () => {
		const wide = "an/extraordinarily-long/path/with-a-very-long-AGENTS-name-that-cannot-fit-any-panel.md";
		const lines = buildHeader(100, 60, theme, [wide], skills, extensions, MODEL, 4000);
		const text = lines.map((l) => sanitizeTuiText(l)).join("\n");
		assert.ok(text.includes("[context] 1"), "counts line expected");
		assert.equal(text.includes(wide), false, "the overlong path must not be listed");
	});

	it("inline listing never exceeds the 60% row budget (README)", () => {
		const mediumSet = Array.from({ length: 60 }, (_, i) => `skill-name-${String(i).padStart(4, "0")}`);
		let inlineSeen = false;
		let collapsedSeen = false;
		for (let termRows = 30; termRows <= 60; termRows += 2) {
			const lines = buildHeader(160, termRows, theme, ["AGENTS.md"], mediumSet, extensions, MODEL, 4000);
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
		const lines = buildHeader(100, 60, theme, ["AGENTS.md"], [wide], extensions, MODEL, 4000);
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
		const lines = buildHeader(sideBySideMin + 20, 50, theme, ["AGENTS.md"], ["alpha"], ["beta"], MODEL, 4000);
		assert.ok(
			lines.some((l) => l.includes(logoFg) && l.includes(panelBgSgr)),
			"some row should carry both logo ink and panel plate",
		);
	});

	it("narrow terminals stack the panel under the logo", () => {
		const lines = buildHeader(sideBySideMin - 6, 60, theme, ["AGENTS.md"], ["alpha"], ["beta"], MODEL, 4000);
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
			lines: buildPanelLines(theme, innerWidth, ["body"], MODEL, 4000),
		};
		const fixed: import("../src/color.ts").SwatchSampler = () => "9;9;9";
		const row = paintRow(0, width, height, ink, panel, fixed);
		assert.ok(row.includes("\x1b[38;2;9;9;9m") || row.includes("\x1b[48;2;9;9;9m"), "custom sampler color must appear");
		const rows = paintSplash(width, height, SPLASH_MARGIN_X, 1, panel, fixed);
		assertLinesExact(rows, width, "paintSplash with custom sampler");
	});

	it("buildHeader accepts a background selection and stays exact-width for every mode", () => {
		for (const background of ["rainbow", "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning"] as const) {
			for (const width of [1, 40, 80, 160]) {
				const lines = buildHeader(width, 40, theme, ["AGENTS.md"], ["a"], ["b"], MODEL, 4000, background);
				assertLinesExact(lines, width, `buildHeader(background=${background}, width=${width})`);
			}
		}
	});
});
