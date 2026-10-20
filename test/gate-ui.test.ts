import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	GATE_LIST_HEIGHT,
	GATE_PANEL_MAX_WIDTH,
	listWindow,
	renderPopupBox,
	RESUME_PANEL_WIDTH,
	SHORT_TERMINAL_ROWS,
} from "../src/gate-ui.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { makeTheme } from "./helpers/theme.ts";
import { assertLinesExact } from "./helpers/width.ts";

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

describe("renderPopupBox (G-05)", () => {
	const theme = makeTheme();
	const body = ["hello", "a considerably longer body line that will need truncation somewhere", ""];

	it("every line is exactly the requested width, for widths 1..200", () => {
		for (let width = 1; width <= 200; width++) {
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
