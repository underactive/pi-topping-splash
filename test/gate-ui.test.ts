import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	fuzzyRanked,
	GATE_LIST_HEIGHT,
	GATE_PANEL_MAX_WIDTH,
	isPrintableInput,
	listWindow,
	renderPopupBox,
	RESUME_PANEL_WIDTH,
	SHORT_TERMINAL_ROWS,
} from "../src/gate-ui.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { makeTheme } from "./helpers/theme.ts";
import { assertLinesExact } from "./helpers/width.ts";

describe("isPrintableInput (G-01)", () => {
	it("rejects empty input", () => {
		assert.equal(isPrintableInput(""), false);
	});
	it("classifies every single 7-bit character: no C0 controls, no DEL", () => {
		for (let code = 0; code <= 0x7f; code++) {
			const expected = code >= 0x20 && code !== 0x7f;
			assert.equal(isPrintableInput(String.fromCharCode(code)), expected, `code=0x${code.toString(16)}`);
		}
	});
	it("rejects C1 control characters (U+0080-009F)", () => {
		for (let code = 0x80; code <= 0x9f; code++) {
			assert.equal(isPrintableInput(String.fromCharCode(code)), false, `C1 code=0x${code.toString(16)}`);
		}
	});
	it("accepts characters above the C1 range", () => {
		assert.equal(isPrintableInput("\u00a0"), true, "non-breaking space");
		assert.equal(isPrintableInput("\u00ff"), true, "ÿ (U+00FF)");
	});
	it("rejects escape sequences and strings containing controls", () => {
		assert.equal(isPrintableInput("\x1b[A"), false);
		assert.equal(isPrintableInput("a\x1bb"), false);
		assert.equal(isPrintableInput("ab\x7f"), false);
		assert.equal(isPrintableInput("line\nbreak"), false);
	});
	it("accepts pasted multi-character text", () => {
		assert.equal(isPrintableInput("hello world"), true);
	});
});

describe("listWindow (G-02)", () => {
	it("keeps the selection visible within the window, exhaustively", () => {
		for (let total = 0; total <= 40; total++) {
			for (let height = 1; height <= 12; height++) {
				const selectables = total === 0 ? [0] : Array.from({ length: total }, (_, i) => i);
				for (const selected of selectables) {
					const { start, end } = listWindow(total, height, selected);
					const label = `total=${total} height=${height} selected=${selected}`;
					assert.ok(start >= 0, `${label}: start ${start} < 0`);
					assert.ok(end <= total, `${label}: end ${end} > total`);
					assert.equal(end - start, Math.min(total, height), `${label}: window size`);
					if (total > 0) {
						assert.ok(start <= selected && selected < end, `${label}: selection outside [${start},${end})`);
					}
				}
			}
		}
	});
});

describe("fuzzyRanked (G-03, G-04)", () => {
	const models = [
		"anthropic/claude-sonnet",
		"anthropic/claude-opus",
		"openai/gpt-4o",
		"google/gemini-pro",
	];
	const identity = (s: string) => s;

	it("returns the original order for an empty query", () => {
		assert.deepEqual(fuzzyRanked(models, "", identity), models);
	});
	it("drops items that do not match", () => {
		assert.deepEqual(fuzzyRanked(models, "zzzz", identity), []);
	});
	it("partitions literal-substring matches to the front (doc's own example)", () => {
		const ranked = fuzzyRanked(models, "opus", identity);
		assert.ok(ranked.includes("anthropic/claude-opus"));
		assert.equal(ranked[0], "anthropic/claude-opus", `got ${JSON.stringify(ranked)}`);
		if (ranked.includes("anthropic/claude-sonnet")) {
			assert.ok(
				ranked.indexOf("anthropic/claude-opus") < ranked.indexOf("anthropic/claude-sonnet"),
				"scattered fuzzy match must not outrank the literal one",
			);
		}
	});
	it("keeps literal matches in stable original order", () => {
		const items = ["bb-opus-first", "aa-opus-second", "cc-opus-third"];
		assert.deepEqual(fuzzyRanked(items, "opus", identity), items);
	});
	it("splits the query on whitespace (README: 'anth opus')", () => {
		const ranked = fuzzyRanked(models, "anth opus", identity);
		assert.ok(ranked.includes("anthropic/claude-opus"), `got ${JSON.stringify(ranked)}`);
		assert.equal(ranked.includes("openai/gpt-4o"), false);
	});
	it("gap pass (observed): the substring partition is case-insensitive", () => {
		const items = ["Anthropic/Claude-Sonnet", "Anthropic/Claude-Opus"];
		const ranked = fuzzyRanked(items, "opus", identity);
		assert.equal(ranked[0], "Anthropic/Claude-Opus", `got ${JSON.stringify(ranked)}`);
	});
	it("works through a key extractor", () => {
		const objects = models.map((name) => ({ name }));
		const ranked = fuzzyRanked(objects, "gemini", (o) => o.name);
		assert.equal(ranked.length, 1);
		assert.equal(ranked[0]?.name, "google/gemini-pro");
	});
});

describe("renderPopupBox (G-05)", () => {
	const theme = makeTheme();
	const body = ["hello", "a considerably longer body line that will need truncation somewhere", ""];

	it("every line is exactly the requested width, for widths 5..200", () => {
		for (let width = 5; width <= 200; width++) {
			const lines = renderPopupBox(theme, width, "Test Title", body);
			assertLinesExact(lines, width, `renderPopupBox(width=${width})`);
		}
	});
	it.todo("FINDING F-3: widths below the 5-column chrome minimum still emit 5 columns", () => {
		// Doc promises "exactly `width` columns wide" unconditionally; observed minimum is
		// the bare chrome. Kept as a todo per the report-don't-reconcile protocol.
		for (let width = 1; width <= 4; width++) {
			const lines = renderPopupBox(theme, width, "Test Title", body);
			assertLinesExact(lines, width, `renderPopupBox(width=${width})`);
		}
	});
	it("emits body rows plus borders and breathing room", () => {
		const lines = renderPopupBox(theme, 60, "Test Title", body);
		assert.equal(lines.length, body.length + 4);
	});
	it("embeds the title in a rounded top border", () => {
		const lines = renderPopupBox(theme, 60, "Test Title", body);
		const top = sanitizeTuiText(lines[0] ?? "");
		const bottom = sanitizeTuiText(lines.at(-1) ?? "");
		assert.ok(top.startsWith("╭"), `top border: ${JSON.stringify(top)}`);
		assert.ok(top.endsWith("╮"), `top border: ${JSON.stringify(top)}`);
		assert.ok(top.includes("Test Title"));
		assert.ok(bottom.startsWith("╰"), `bottom border: ${JSON.stringify(bottom)}`);
		assert.ok(bottom.endsWith("╯"), `bottom border: ${JSON.stringify(bottom)}`);
	});
	it("truncates body lines rather than widening the box", () => {
		const lines = renderPopupBox(theme, 24, "T", ["x".repeat(100)]);
		assertLinesExact(lines, 24, "overlong body");
	});
});

describe("exported constants (G-06)", () => {
	it("anchor values other modules size against", () => {
		assert.equal(GATE_PANEL_MAX_WIDTH, 90);
		assert.equal(RESUME_PANEL_WIDTH, "100%");
		assert.equal(GATE_LIST_HEIGHT, 10);
		assert.equal(SHORT_TERMINAL_ROWS, 24);
	});
});

describe("width oracle sanity", () => {
	it("visibleWidth agrees with plain string length for ASCII", () => {
		assert.equal(visibleWidth("hello"), 5);
	});
});
