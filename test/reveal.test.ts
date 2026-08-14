import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	renderTagline,
	REVEAL_BAND_HALF,
	REVEAL_HOLD_MS,
	REVEAL_MS_PER_CHAR,
	REVEAL_PEAK_ALPHA,
	REVEAL_TICK_MS,
	revealPos,
	sgrChannels,
	shimmerCell,
	shimmerPalette,
	startTaglineReveal,
	stopTaglineReveal,
	TAGLINE_PLACEHOLDER,
	taglineReveal,
} from "../src/reveal.ts";
import { headerRenderState } from "../src/state.ts";
import { sanitizeTuiText, visibleLength } from "../src/text.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { makeTheme } from "./helpers/theme.ts";

beforeEach(() => resetModuleState());
afterEach(() => stopTaglineReveal());

type TimerCtx = { mock: { timers: { enable(opts: { apis: string[] }): void; tick(ms: number): void } } };

// Single cast site for @types/node's untyped t.mock.timers; returns the handle so tests can tick.
function enableTimers(t: unknown): TimerCtx["mock"]["timers"] {
	const timers = (t as TimerCtx).mock.timers;
	timers.enable({ apis: ["setInterval", "Date"] });
	return timers;
}

describe("constants (R-01)", () => {
	it("match the documented values", () => {
		assert.equal(TAGLINE_PLACEHOLDER, "model · system prompt");
		assert.equal(REVEAL_HOLD_MS, 500);
		assert.equal(REVEAL_MS_PER_CHAR, 20);
		assert.equal(REVEAL_TICK_MS, REVEAL_MS_PER_CHAR);
		assert.equal(REVEAL_BAND_HALF, 5);
		assert.equal(REVEAL_PEAK_ALPHA, 0.9);
	});
});

describe("reveal lifecycle (R-02, R-03, R-04)", () => {
	it("is settled before starting", () => {
		assert.equal(revealPos(), undefined);
	});
	it("starts a full band off the left edge", (t) => {
		enableTimers(t);
		startTaglineReveal();
		assert.equal(revealPos(), -REVEAL_BAND_HALF);
	});
	it("holds for REVEAL_HOLD_MS before the wipe advances", (t) => {
		const timers = enableTimers(t);
		startTaglineReveal();
		const holdTicks = REVEAL_HOLD_MS / REVEAL_TICK_MS;
		for (let i = 0; i < holdTicks - 1; i++) {
			timers.tick(REVEAL_TICK_MS);
		}
		assert.equal(revealPos(), -REVEAL_BAND_HALF, "wipe must not move during the hold");
		for (let i = 0; i < 6; i++) {
			timers.tick(REVEAL_TICK_MS);
		}
		const pos = revealPos();
		assert.ok(pos !== undefined && pos > -REVEAL_BAND_HALF, `wipe should have started, pos=${pos}`);
	});
	it("advances about one cell per tick once running", (t) => {
		const timers = enableTimers(t);
		startTaglineReveal();
		const holdTicks = REVEAL_HOLD_MS / REVEAL_TICK_MS;
		for (let i = 0; i < holdTicks + 2; i++) {
			timers.tick(REVEAL_TICK_MS);
		}
		const before = revealPos();
		assert.ok(before !== undefined);
		for (let i = 0; i < 10; i++) {
			timers.tick(REVEAL_TICK_MS);
		}
		const after = revealPos();
		assert.ok(after !== undefined, "reveal ended too early");
		const advance = after - before;
		assert.ok(advance >= 5 && advance <= 15, `10 ticks advanced ${advance} cells, expected ~10`);
	});
	it("requests a repaint as the wipe advances", (t) => {
		const timers = enableTimers(t);
		let renders = 0;
		headerRenderState.requestRender = () => {
			renders++;
		};
		startTaglineReveal();
		const holdTicks = REVEAL_HOLD_MS / REVEAL_TICK_MS;
		for (let i = 0; i < holdTicks + 10; i++) {
			timers.tick(REVEAL_TICK_MS);
		}
		assert.ok(renders >= 5, `expected repaint requests once advancing, got ${renders}`);
	});
});

describe("pause, not skip (R-05)", () => {
	it("a 2000ms event-loop block advances the wipe by a capped step", (t) => {
		const timers = enableTimers(t);
		startTaglineReveal();
		const holdTicks = REVEAL_HOLD_MS / REVEAL_TICK_MS;
		for (let i = 0; i < holdTicks + 5; i++) {
			timers.tick(REVEAL_TICK_MS);
		}
		const before = revealPos();
		assert.ok(before !== undefined, "reveal must be mid-wipe before the block");
		timers.tick(2000);
		const after = revealPos();
		assert.ok(after !== undefined, "a block must pause the reveal, not finish it");
		const jump = after - before;
		assert.ok(
			jump <= 4,
			`2000ms block advanced ${jump} cells — uncapped elapsed-time math would advance ${2000 / REVEAL_MS_PER_CHAR}`,
		);
	});
});

describe("one-shot (R-06, R-07)", () => {
	it("stops itself after sweeping the field and never restarts", (t) => {
		const timers = enableTimers(t);
		startTaglineReveal();
		for (let i = 0; i < 300; i++) {
			timers.tick(REVEAL_TICK_MS);
		}
		assert.equal(revealPos(), undefined, "reveal should have settled");
		assert.equal(taglineReveal.timer, null, "ticker should have cleared itself");
		for (let i = 0; i < 50; i++) {
			timers.tick(REVEAL_TICK_MS);
		}
		assert.equal(revealPos(), undefined, "reveal must not loop");
	});
	it("stopTaglineReveal is idempotent and settles the reveal", (t) => {
		enableTimers(t);
		startTaglineReveal();
		stopTaglineReveal();
		assert.equal(revealPos(), undefined);
		assert.equal(taglineReveal.timer, null);
		stopTaglineReveal();
		assert.equal(revealPos(), undefined);
	});
});

describe("sgrChannels (R-08)", () => {
	it("parses truecolor SGR sequences", () => {
		assert.deepEqual(sgrChannels("\x1b[38;2;10;20;30m"), [10, 20, 30]);
		assert.deepEqual(sgrChannels("\x1b[38;2;0;0;0m"), [0, 0, 0]);
	});
	it("yields null for 256-color and garbage input", () => {
		assert.equal(sgrChannels("\x1b[38;5;100m"), null);
		assert.equal(sgrChannels(""), null);
		assert.equal(sgrChannels("plain"), null);
	});
});

describe("shimmerPalette (R-09)", () => {
	it("derives base/highlight from a truecolor theme's dim and text", () => {
		const palette = shimmerPalette(makeTheme({ text: "#e8e8e8", dim: "#808080" }));
		assert.ok(palette, "truecolor theme must yield a palette");
		const got = [palette.base, palette.highlight].map((c) => JSON.stringify(c)).sort();
		const expected = [JSON.stringify([128, 128, 128]), JSON.stringify([232, 232, 232])].sort();
		assert.deepEqual(got, expected);
	});
	it("is disabled on 256-color themes", () => {
		assert.equal(shimmerPalette(makeTheme({ mode: "256color" })), null);
	});
});

describe("shimmerCell (R-10)", () => {
	const palette = { base: [100, 100, 100] as [number, number, number], highlight: [200, 200, 200] as [number, number, number] };
	it("keeps the cell one column wide with the same glyph", () => {
		for (const dist of [0, 1, 3, REVEAL_BAND_HALF, REVEAL_BAND_HALF + 1, 20]) {
			const cell = shimmerCell("x", dist, palette);
			assert.equal(sanitizeTuiText(cell), "x", `dist=${dist}`);
			assert.equal(visibleLength(cell), 1, `dist=${dist}`);
		}
	});
	it("uses base ink outside the band and brightens toward the crest", () => {
		// Crest cells also carry bold; extract the truecolor code specifically.
		const channelAt = (dist: number): number => {
			const parsed = sgrChannels(shimmerCell("x", dist, palette).match(/\x1b\[38;2;\d+;\d+;\d+m/)?.[0] ?? "");
			assert.ok(parsed, `dist=${dist}: no truecolor SGR found`);
			return parsed[0];
		};
		const outside = channelAt(REVEAL_BAND_HALF + 2);
		assert.equal(outside, 100, "outside the band the crest must not tint the base ink");
		const crest = channelAt(0);
		// Peak blend REVEAL_PEAK_ALPHA toward the highlight: 100 + (200-100)*0.9.
		assert.equal(crest, 190);
		const shoulder = channelAt(REVEAL_BAND_HALF - 1);
		assert.ok(crest >= shoulder && shoulder >= outside, `raised cosine: ${crest} >= ${shoulder} >= ${outside}`);
	});
});

describe("renderTagline (R-11, R-12, R-13)", () => {
	const theme = makeTheme();
	const LONG_TAGLINE = "anthropic/claude-opus-4 · ~12.5k tokens";

	it("settled form hugs the tagline in dashes", () => {
		assert.equal(sanitizeTuiText(renderTagline(theme, LONG_TAGLINE)), `- ${LONG_TAGLINE} -`);
	});
	it("shows the intact placeholder during the hold", (t) => {
		const timers = enableTimers(t);
		startTaglineReveal();
		timers.tick(REVEAL_TICK_MS);
		assert.equal(sanitizeTuiText(renderTagline(theme, LONG_TAGLINE)), `- ${TAGLINE_PLACEHOLDER} -`);
	});
	it("overwrites the placeholder from the left mid-wipe", (t) => {
		const timers = enableTimers(t);
		startTaglineReveal();
		const holdTicks = REVEAL_HOLD_MS / REVEAL_TICK_MS;
		for (let i = 0; i < holdTicks + 8; i++) {
			timers.tick(REVEAL_TICK_MS);
		}
		const pos = taglineReveal.pos;
		assert.ok(pos >= 2 && pos < TAGLINE_PLACEHOLDER.length, `test setup: pos=${pos}`);
		const visible = sanitizeTuiText(renderTagline(theme, LONG_TAGLINE));
		assert.ok(
			visible.startsWith(`- ${LONG_TAGLINE.slice(0, pos - 1)}`),
			`left of the wipe must be revealed: pos=${pos} visible=${JSON.stringify(visible)}`,
		);
		assert.ok(
			visible.endsWith(`${TAGLINE_PLACEHOLDER.slice(pos + 1)} -`),
			`right of the wipe must still be placeholder: pos=${pos} visible=${JSON.stringify(visible)}`,
		);
	});
	it("row holds the placeholder width until the wipe outgrows it", (t) => {
		const timers = enableTimers(t);
		startTaglineReveal();
		const holdTicks = REVEAL_HOLD_MS / REVEAL_TICK_MS;
		for (let i = 0; i < holdTicks + 8; i++) {
			timers.tick(REVEAL_TICK_MS);
		}
		const width = visibleLength(renderTagline(theme, LONG_TAGLINE));
		assert.equal(width, TAGLINE_PLACEHOLDER.length + 4);
	});
	it("falls back to settled on 256-color themes (R-12)", (t) => {
		enableTimers(t);
		startTaglineReveal();
		const dumb = makeTheme({ mode: "256color" });
		assert.equal(sanitizeTuiText(renderTagline(dumb, LONG_TAGLINE)), `- ${LONG_TAGLINE} -`);
	});
	it("FINDING F-4: SGR-carrying taglines are sanitized and revealed, not settled (R-12)", (t) => {
		// ANSI escapes in the tagline are sanitized before the fallback check, so the reveal
		// proceeds on the cleaned text rather than falling back to settled.
		const timers = enableTimers(t);
		startTaglineReveal();
		const holdTicks = REVEAL_HOLD_MS / REVEAL_TICK_MS;
		for (let i = 0; i < holdTicks + 8; i++) {
			timers.tick(REVEAL_TICK_MS);
		}
		const escaped = `\x1b[38;2;1;2;3m${LONG_TAGLINE}\x1b[0m`;
		const output = renderTagline(theme, escaped);
		assert.equal(/\x1b(?!\[[0-9;]*m)/.test(output), false, "no broken escapes");
		const pos = taglineReveal.pos;
		assert.ok(
			sanitizeTuiText(output).startsWith(`- ${LONG_TAGLINE.slice(0, Math.max(0, pos - 1))}`),
			"the revealed prefix must come from the sanitized tagline",
		);
	});
	it("strips OSC sequences instead of embedding them in the settled line", () => {
		const osc = `\x1b]8;;https://evil.example\x07${LONG_TAGLINE}\x1b]8;;\x07`;
		const output = renderTagline(theme, osc);
		assert.equal(output.includes("\x1b]"), false, "raw OSC bytes must never reach the terminal");
		assert.equal(sanitizeTuiText(output), `- ${LONG_TAGLINE} -`);
	});
	it("falls back to settled on surrogate pairs (R-12)", (t) => {
		enableTimers(t);
		startTaglineReveal();
		const emoji = "model 😀 with surrogates padding!!";
		assert.equal(sanitizeTuiText(renderTagline(theme, emoji)), `- ${emoji} -`);
	});
	it("falls back to settled when shorter than the placeholder (R-12)", (t) => {
		enableTimers(t);
		startTaglineReveal();
		assert.equal(sanitizeTuiText(renderTagline(theme, "short")), "- short -");
	});
});
