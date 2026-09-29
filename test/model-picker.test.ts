import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	availableModelRefs,
	COMMON_THINKING_LEVELS,
	defaultThinkingForModel,
	isThinkingLevel,
	modelRefLabel,
	THINKING_LEVELS,
	thinkingOptionsForModel,
	TwoPaneModelThinking,
	type ModelRef,
	type ThinkingLevel,
} from "../src/model-picker.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { createFakeCtx, makeModel } from "./helpers/fake-ctx.ts";
import { createFakeTui } from "./helpers/fake-tui.ts";
import { KEY } from "./helpers/keys.ts";
import { bootstrapGlobalTheme, makeTheme } from "./helpers/theme.ts";
import { assertLinesExact } from "./helpers/width.ts";

bootstrapGlobalTheme();

describe("thinking-level vocabulary (M-01, M-02)", () => {
	it("matches the documented level lists", () => {
		assert.deepEqual([...THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.deepEqual([...COMMON_THINKING_LEVELS], ["off", "low", "medium", "high"]);
	});
	it("isThinkingLevel accepts exactly the seven levels", () => {
		for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true, level);
		for (const junk of ["", "OFF", "med", "maximum", "none", "42"]) {
			assert.equal(isThinkingLevel(junk), false, junk);
		}
	});
});

describe("pure helpers (M-03..M-06)", () => {
	it("modelRefLabel names both provider and id", () => {
		const label = modelRefLabel({ provider: "anthropic", id: "claude-opus-4" });
		assert.ok(label.includes("anthropic"));
		assert.ok(label.includes("claude-opus-4"));
	});
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
	it("thinkingOptionsForModel normalizes into THINKING_LEVELS order", () => {
		assert.deepEqual(thinkingOptionsForModel(["high", "off"] as ThinkingLevel[]), ["off", "high"]);
		assert.deepEqual(thinkingOptionsForModel(["max", "low", "xhigh"] as ThinkingLevel[]), ["low", "xhigh", "max"]);
	});
	it("falls back to the common levels when the registry knows none", () => {
		assert.deepEqual(thinkingOptionsForModel(undefined), [...COMMON_THINKING_LEVELS]);
	});
	it("defaultThinkingForModel prefers current, then medium", () => {
		assert.equal(defaultThinkingForModel(["off", "low", "medium", "high"], "low"), "low");
		assert.equal(defaultThinkingForModel(["off", "medium"], "high"), "medium");
		const fallback = defaultThinkingForModel(["off", "low"], "high");
		assert.ok(["off", "low"].includes(fallback), `UNSPECIFIED beyond medium; must stay in options: ${fallback}`);
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
		return new TwoPaneModelThinking(makeTheme(), ctx.ctx, REFS, currentThinking);
	}

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
		const joined = (p: TwoPaneModelThinking) => p.render(80).map((l) => sanitizeTuiText(l)).join("\n");
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
			assertLinesExact(picker.render(bodyWidth), bodyWidth, `render(${bodyWidth})`);
		}
	});

	it("render holds the width invariant with a filter active", () => {
		const picker = makePicker();
		for (const ch of "gpt") picker.handleInput(ch);
		for (let bodyWidth = 4; bodyWidth <= 120; bodyWidth += 3) {
			assertLinesExact(picker.render(bodyWidth), bodyWidth, `filtered render(${bodyWidth})`);
		}
	});

	it("renderFooter stays within bodyWidth with exact-width rules (M-11)", () => {
		const picker = makePicker();
		for (const bodyWidth of [30, 40, 80, 160]) {
			const lines = picker.renderFooter(bodyWidth, "tab move · enter select");
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
		const lines = picker.renderFooter(20, "hints");
		for (const [i, line] of lines.entries()) {
			const width = sanitizeTuiText(line).length;
			assert.ok(width <= 20, `footer line ${i} width ${width} > 20`);
		}
	});
});
