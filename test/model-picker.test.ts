import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	availableModelRefs,
	createSplashModelPicker,
	modelRefLabel,
	renderFooter,
	renderSplashModelPicker,
	type TwoPaneModelThinking,
	type ModelRef,
	type ThinkingLevel,
} from "../src/model-picker.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { GATE_LIST_HEIGHT } from "../src/gate-ui.ts";
import { createFakeCtx, makeModel } from "./helpers/fake-ctx.ts";
import { createFakeTui } from "./helpers/fake-tui.ts";
import { KEY } from "./helpers/keys.ts";
import { bootstrapGlobalTheme, makeTheme } from "./helpers/theme.ts";
import { assertLinesExact } from "./helpers/width.ts";

bootstrapGlobalTheme();

describe("availableModelRefs (M-04)", () => {
	it("availableModelRefs sorts by display label", () => {
		const tui = createFakeTui();
		const ctx = createFakeCtx({
			cwd: "/tmp",
			theme: makeTheme(),
			tui: tui.tui,
			models: [makeModel("zeta", "m-late"), makeModel("alpha", "m-early"), makeModel("mid", "m-mid")],
		});
		const refs = availableModelRefs(ctx.ctx);
		const labels = refs.map(modelRefLabel);
		assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b)));
		assert.equal(refs.length, 3);
	});
});

describe("TwoPaneModelThinking (M-07..M-12)", () => {
	const REFS: ModelRef[] = [
		{ provider: "anthropic", id: "claude-opus-4" },
		{ provider: "openai", id: "gpt-4o" },
	];

	function makePicker(currentThinking: ThinkingLevel = "medium"): TwoPaneModelThinking {
		const tui = createFakeTui();
		// Registry deliberately knows none of the refs → right pane uses the common fallback.
		const ctx = createFakeCtx({ cwd: "/tmp", theme: makeTheme(), tui: tui.tui, models: [] });
		return createSplashModelPicker(makeTheme(), ctx.ctx, REFS, currentThinking);
	}

	it("keeps GATE_LIST_HEIGHT model rows before and after filtering overflow", () => {
		const tui = createFakeTui();
		const ctx = createFakeCtx({ cwd: "/tmp", theme: makeTheme(), tui: tui.tui, models: [] });
		for (const count of [9, 10, 11, 12, 15]) {
			const refs = Array.from({ length: count }, (_, i) => ({ provider: "p", id: `model-${i}` }));
			const picker = createSplashModelPicker(makeTheme(), ctx.ctx, refs, "medium");
			for (const filter of ["", "model"]) {
				if (filter) picker.handleInput(filter);
				for (const width of [40, 80, 160]) {
					const rows = renderSplashModelPicker(picker, width);
					const label = `count=${count} filter=${filter} width=${width}`;
					assertLinesExact(rows, width, label);
					const modelRows = rows.filter((row) => sanitizeTuiText(row).split("│")[0]?.includes("p/model-"));
					assert.equal(modelRows.length, Math.min(count, GATE_LIST_HEIGHT), label);
					const hasScroll = rows.some((row) => /\(\d+\/\d+\)/.test(sanitizeTuiText(row).split("│")[0] ?? ""));
					assert.equal(hasScroll, count > GATE_LIST_HEIGHT, label);
					assert.equal(rows.length, Math.min(count, GATE_LIST_HEIGHT) + 1 + (count > GATE_LIST_HEIGHT ? 1 : 0) + (filter ? 1 : 0), label);
				}
			}
		}
	});

	it("keeps the last of eleven models visible through navigation and filtering", () => {
		const tui = createFakeTui();
		const ctx = createFakeCtx({ cwd: "/tmp", theme: makeTheme(), tui: tui.tui, models: [] });
		const refs = Array.from({ length: 11 }, (_, i) => ({ provider: "p", id: `model-${i}` }));
		const picker = createSplashModelPicker(makeTheme(), ctx.ctx, refs, "medium", refs[10]);
		const assertVisible = (index: number) => {
			assert.deepEqual(picker.getSelected().ref, refs[index]);
			const rows = renderSplashModelPicker(picker, 80);
			assertLinesExact(rows, 80, `selected model-${index}`);
			assert.ok(rows.some((row) => sanitizeTuiText(row).includes(`→ p/model-${index}`)));
		};
		assertVisible(10);
		picker.handleInput(KEY.up);
		assertVisible(9);
		picker.handleInput(KEY.down);
		assertVisible(10);
		picker.handleInput("model");
		assertVisible(10);
		for (let i = 0; i < "model".length; i++) picker.handleInput(KEY.backspace);
		assertVisible(10);
	});

	it("confirms via the Select button with the default selection", () => {
		const picker = makePicker("medium");
		assert.equal(picker.handleInput(KEY.tab), undefined);
		assert.equal(picker.handleInput(KEY.tab), undefined);
		assert.equal(picker.handleInput(KEY.enter), "confirm");
		const { ref, thinking } = picker.getSelected();
		assert.deepEqual(ref, REFS[0]);
		assert.equal(thinking, "medium");
	});

	it("arrow selection in the model pane carries into getSelected", () => {
		const picker = makePicker();
		picker.handleInput(KEY.down);
		picker.handleInput(KEY.tab);
		picker.handleInput(KEY.tab);
		assert.equal(picker.handleInput(KEY.enter), "confirm");
		assert.deepEqual(picker.getSelected().ref, REFS[1]);
	});

	it("thinking pane selection carries into getSelected", () => {
		const picker = makePicker("medium");
		picker.handleInput(KEY.tab);
		picker.handleInput(KEY.down);
		picker.handleInput(KEY.tab);
		assert.equal(picker.handleInput(KEY.enter), "confirm");
		const { thinking } = picker.getSelected();
		// Fallback options are off/low/medium/high preselected at medium; one step down is high.
		assert.equal(thinking, "high");
	});

	it("Esc backs out directly, even with a filter active (README)", () => {
		const picker = makePicker();
		assert.equal(picker.handleInput(KEY.esc), "back");
		const filtered = makePicker();
		for (const ch of "gpt") filtered.handleInput(ch);
		assert.equal(filtered.handleInput(KEY.esc), "back");
	});

	it("Cancel button returns back", () => {
		const picker = makePicker();
		picker.handleInput(KEY.tab);
		picker.handleInput(KEY.tab);
		picker.handleInput(KEY.right);
		assert.equal(picker.handleInput(KEY.enter), "back");
	});

	it("typing narrows the model filter; backspace edits it (M-12)", () => {
		const picker = makePicker();
		const joined = (p: TwoPaneModelThinking) => renderSplashModelPicker(p, 80).map((l) => sanitizeTuiText(l)).join("\n");
		assert.ok(joined(picker).includes("claude-opus-4"));
		for (const ch of "gpt") picker.handleInput(ch);
		assert.equal(joined(picker).includes("claude-opus-4"), false, "filter must hide non-matches");
		assert.ok(joined(picker).includes("gpt-4o"));
		picker.handleInput(KEY.backspace);
		picker.handleInput(KEY.backspace);
		picker.handleInput(KEY.backspace);
		assert.ok(joined(picker).includes("claude-opus-4"), "cleared filter must restore the list");
	});

	it("a filter matching nothing makes confirm unreachable", () => {
		const picker = makePicker();
		for (const ch of "zzzz") picker.handleInput(ch);
		picker.handleInput(KEY.tab);
		picker.handleInput(KEY.tab);
		assert.notEqual(picker.handleInput(KEY.enter), "confirm");
	});

	it("render emits rows exactly bodyWidth wide (M-10)", () => {
		const picker = makePicker();
		for (let bodyWidth = 4; bodyWidth <= 200; bodyWidth++) {
			assertLinesExact(renderSplashModelPicker(picker, bodyWidth), bodyWidth, `render(${bodyWidth})`);
		}
	});

	it("render holds the width invariant with a filter active", () => {
		const picker = makePicker();
		for (const ch of "gpt") picker.handleInput(ch);
		for (let bodyWidth = 4; bodyWidth <= 120; bodyWidth += 3) {
			assertLinesExact(renderSplashModelPicker(picker, bodyWidth), bodyWidth, `filtered render(${bodyWidth})`);
		}
	});

	it("renderFooter stays within bodyWidth with exact-width rules (M-11)", () => {
		const picker = makePicker();
		for (const bodyWidth of [30, 40, 80, 160]) {
			const lines = renderFooter(makeTheme(), picker, bodyWidth, "tab move · enter select");
			for (const [i, line] of lines.entries()) {
				const width = sanitizeTuiText(line).length;
				assert.ok(width <= bodyWidth, `footer line ${i} width ${width} > ${bodyWidth}`);
			}
			assert.equal(sanitizeTuiText(lines[0] ?? "").length, bodyWidth, "top rule should span the body");
		}
	});

	it("footer button row does not overflow very narrow bodies (F-6)", () => {
		// The Select/Cancel row and hints are clamped to bodyWidth (W invariant).
		const picker = makePicker();
		const lines = renderFooter(makeTheme(), picker, 20, "hints");
		for (const [i, line] of lines.entries()) {
			const width = sanitizeTuiText(line).length;
			assert.ok(width <= 20, `footer line ${i} width ${width} > 20`);
		}
	});
});
