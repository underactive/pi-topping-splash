import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SYSTEM_PROMPT_PANEL_WIDTH, SystemPromptView, showSystemPrompt } from "../src/system-prompt-view.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { createFakeCtx } from "./helpers/fake-ctx.ts";
import { createFakeTui } from "./helpers/fake-tui.ts";
import { KEY } from "./helpers/keys.ts";
import { makeTheme } from "./helpers/theme.ts";
import { assertLinesExact } from "./helpers/width.ts";

const HINT = "↑↓ scroll · pgup/pgdn page · esc back";

function makeView(prompt: string, rows = 40) {
	const tui = createFakeTui({ rows });
	let closes = 0;
	const view = new SystemPromptView(tui.tui, makeTheme(), prompt, () => closes++);
	return { view, tui, closes: () => closes };
}

/** The text between a boxed row's borders, without its right padding. */
function inner(line: string): string {
	const match = /^│ (.*) │$/.exec(sanitizeTuiText(line));
	assert.ok(match, `not a boxed row: ${JSON.stringify(line)}`);
	return match[1]!.trimEnd();
}

/** Splits a rendered popup into prompt rows, the position indicator, and the hint rows. */
function parts(lines: string[]): { body: string[]; indicator: string | undefined; hint: string[] } {
	const content = lines.slice(2, -2).map(inner);
	const separator = content.lastIndexOf("");
	const body = content.slice(0, separator);
	let indicator: string | undefined;
	if (body.length > 0 && /^\d+-\d+ of \d+$/.test(body.at(-1)!.trim())) indicator = body.pop()!.trim();
	return { body, indicator, hint: content.slice(separator + 1) };
}

/** Every wrapped row, read by scrolling one row at a time from the top to the bottom. */
function readAll(view: SystemPromptView, width: number): string[] {
	view.render(width);
	for (let i = 0; i < 2000; i++) view.handleInput(KEY.pageUp);
	const rows: string[] = [];
	let current = view.render(width);
	for (let step = 0; step < 5000; step++) {
		view.handleInput(KEY.down);
		const next = view.render(width);
		if (next.join("\n") === current.join("\n")) return [...rows, ...parts(current).body];
		rows.push(parts(current).body[0]!);
		current = next;
	}
	throw new Error("never reached the bottom");
}

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`).join("\n");
const squash = (text: string) => text.replace(/\s+/g, "");

describe("SystemPromptView (SP-03..SP-08)", () => {
	it("shows a short prompt whole, with blank lines kept and no indicator (SP-03, SP-05)", () => {
		const { view } = makeView("alpha\nbeta\n\ngamma");
		const lines = view.render(90);
		const { body, indicator, hint } = parts(lines);
		assert.deepEqual(body, ["alpha", "beta", "", "gamma"]);
		assert.equal(indicator, undefined);
		assert.equal(hint.join(" "), HINT);
		assert.ok(lines.length <= 38);
		for (const key of [KEY.up, KEY.down, KEY.pageUp, KEY.pageDown, KEY.left, KEY.right]) {
			view.handleInput(key);
			assert.deepEqual(view.render(90), lines, `${JSON.stringify(key)} must not move a prompt that fits`);
		}
	});

	it("scrolls one row with arrows and one page with PgUp/PgDn, clamped at both ends (SP-04)", () => {
		const { view } = makeView(numbered(200), 24);
		const first = () => parts(view.render(76));
		assert.equal(first().body.length, 15);
		assert.equal(first().body[0], "line 001");
		assert.equal(first().indicator, "1-15 of 200");
		view.handleInput(KEY.up);
		assert.equal(first().body[0], "line 001", "Up at the top does nothing");
		view.handleInput(KEY.down);
		assert.equal(first().body[0], "line 002");
		assert.equal(first().indicator, "2-16 of 200");
		view.handleInput(KEY.up);
		assert.equal(first().body[0], "line 001");
		view.handleInput(KEY.pageDown);
		assert.equal(first().body[0], "line 016");
		assert.equal(first().indicator, "16-30 of 200");
		view.handleInput(KEY.pageUp);
		assert.equal(first().body[0], "line 001");
		for (let i = 0; i < 40; i++) view.handleInput(KEY.pageDown);
		assert.equal(first().body.length, 15, "the last page is still full");
		assert.deepEqual([first().body[0], first().body.at(-1)], ["line 186", "line 200"]);
		view.handleInput(KEY.down);
		view.handleInput(KEY.pageDown);
		assert.equal(first().indicator, "186-200 of 200", "nothing scrolls past the end");
		assert.equal(first().hint.join(" "), HINT, "the footer stays on every page");
	});

	it("loses nothing and invents nothing across a full read (SP-03)", () => {
		const words = Array.from({ length: 90 }, (_, i) => `word${i}`);
		const source = [0, 1, 2, 3, 4, 5].map((p) => words.slice(p * 15, p * 15 + 15).reduce<string[]>((acc, w, i) => {
			if (i % 7 === 0) acc.push(w);
			else acc[acc.length - 1] += ` ${w}`;
			return acc;
		}, []).join("\n")).join("\n\n");
		const { view } = makeView(source, 14);
		assert.equal(readAll(view, 44).join(" ").split(/\s+/).join(" "), words.join(" "));
	});

	it("breaks unbroken tokens to the interior width and never scrolls sideways (SP-03)", () => {
		const x = "x".repeat(500);
		const url = `https://example.invalid/${"a1b2/".repeat(60)}`;
		const cjk = "日本語のテキスト".repeat(20);
		for (const width of [20, 41, 76, 90, 120]) {
			const { view } = makeView(`${x}\n${url}\n${cjk}`);
			assertLinesExact(view.render(width), width, `width ${width}`);
			const rows = readAll(view, width);
			for (const row of rows) assert.ok(visibleWidth(row) <= width - 4, `width ${width}: ${JSON.stringify(row)}`);
			assert.equal(rows.join(""), `${x}${url}${cjk}`, `width ${width} keeps every character`);
			const before = view.render(width);
			view.handleInput(KEY.left);
			view.handleInput(KEY.right);
			assert.deepEqual(view.render(width), before);
		}
	});

	it("renders exactly the granted width at every width and height (SP-06)", () => {
		const prompt = `${numbered(60)}\n${"y".repeat(300)}\n${"日本語".repeat(40)}\n\ttabbed\n`;
		for (const rows of [10, 12, 24, 40, 60]) {
			const { view } = makeView(prompt, rows);
			for (let width = 1; width <= 200; width++) {
				assertLinesExact(view.render(width), width, `rows=${rows} width=${width}`);
			}
		}
	});

	it("keeps the footer complete and inside the overlay's height at representative sizes (SP-05)", () => {
		const sizes = [[80, 24], [100, 40], [200, 60], [45, 30], [30, 12], [24, 16]] as const;
		assert.equal(SYSTEM_PROMPT_PANEL_WIDTH, 120);
		for (const [columns, rows] of sizes) {
			const width = Math.min(SYSTEM_PROMPT_PANEL_WIDTH, columns - 4);
			const { view } = makeView(numbered(300), rows);
			for (const position of ["top", "middle", "bottom"]) {
				if (position === "middle") for (let i = 0; i < 3; i++) view.handleInput(KEY.pageDown);
				if (position === "bottom") for (let i = 0; i < 500; i++) view.handleInput(KEY.pageDown);
				const lines = view.render(width);
				const label = `${columns}x${rows} ${position}`;
				assert.ok(lines.length <= rows - 2, `${label}: ${lines.length} rows exceed ${rows - 2}`);
				assert.equal(squash(parts(lines).hint.join(" ")), squash(HINT), `${label}: hint is complete`);
			}
		}
	});

	it("strips control bytes and expands tabs (SP-03)", () => {
		const { view } = makeView("a\tb\x1b[31mred\x1b[0m\x07");
		const lines = view.render(90);
		assert.deepEqual(parts(lines).body, ["a   bred"]);
		assert.ok(lines.every((line) => !line.includes("\x1b[31m")));
	});

	it("shows an empty state for blank prompts and ignores navigation (SP-07)", () => {
		for (const prompt of ["", "  \n "]) {
			const { view, closes } = makeView(prompt);
			const lines = view.render(90);
			assert.deepEqual(parts(lines).body, ["No system prompt available"]);
			assert.equal(parts(lines).hint.join(" "), HINT);
			for (const key of [KEY.up, KEY.down, KEY.pageUp, KEY.pageDown]) view.handleInput(key);
			assert.deepEqual(view.render(90), lines);
			view.handleInput(KEY.esc);
			assert.equal(closes(), 1);
		}
	});

	it("stays valid and full-page when the terminal is resized (SP-04)", () => {
		const { view, tui } = makeView(numbered(200), 40);
		for (let i = 0; i < 40; i++) view.handleInput(KEY.pageDown);
		view.render(76);
		for (let i = 0; i < 40; i++) view.handleInput(KEY.pageDown);
		assert.equal(parts(view.render(76)).body.at(-1), "line 200");
		tui.resizeRows(60);
		const taller = parts(view.render(76));
		assert.equal(taller.body.at(-1), "line 200");
		assert.equal(taller.indicator, "150-200 of 200", "growing the terminal clamps instead of leaving blank rows");
		tui.resizeRows(12);
		const lines = view.render(76);
		assert.ok(lines.length <= 10);
		assert.equal(parts(lines).hint.join(" "), HINT);

		const wide = makeView(Array.from({ length: 30 }, (_, i) => `entry ${i} ${"word ".repeat(18)}`.trimEnd()).join("\n"), 24);
		wide.view.render(30);
		for (let i = 0; i < 200; i++) wide.view.handleInput(KEY.pageDown);
		const narrowEnd = /(\d+)-(\d+) of (\d+)/.exec(parts(wide.view.render(30)).indicator!)!;
		assert.equal(narrowEnd[2], narrowEnd[3]);
		const widened = parts(wide.view.render(90));
		const widenedEnd = /(\d+)-(\d+) of (\d+)/.exec(widened.indicator!)!;
		assert.equal(widenedEnd[2], widenedEnd[3], "a wider overlay re-wraps and stays pinned to the end");
		assert.equal(widened.body.length, 15, "no blank overscroll after re-wrapping");
		assert.ok(widened.body.every((row) => row !== ""));
	});

	it("closes only on Escape and ignores every other key (SP-08)", () => {
		const { view, closes } = makeView(numbered(100), 24);
		const before = view.render(76);
		for (const key of ["q", "p", "s", KEY.enter, KEY.tab, KEY.left, KEY.right, "hello", "\x1b[200~pasted\x1b[201~", "\x1b[<0;10;10M"]) {
			view.handleInput(key);
		}
		assert.equal(closes(), 0);
		assert.deepEqual(view.render(76), before);
		view.handleInput(KEY.esc);
		assert.equal(closes(), 1);
	});
});

describe("showSystemPrompt (SP-01, SP-02)", () => {
	function makeCtx(systemPrompt: string | (() => string)) {
		const tui = createFakeTui({ rows: 40 });
		return createFakeCtx({ cwd: "/tmp", theme: makeTheme(), tui: tui.tui, systemPrompt });
	}

	/** Opens the view; `closed()` reports whether the opener's promise has resolved, without ever hanging. */
	function open(ctx: ReturnType<typeof makeCtx>): { closed: () => Promise<boolean> } {
		let resolved = false;
		void showSystemPrompt(ctx.ctx).then(() => { resolved = true; });
		return { closed: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); return resolved; } };
	}

	it("reads the prompt once per open and opens a capturing overlay (SP-01, SP-02)", async () => {
		let reads = 0;
		const ctx = makeCtx(() => { reads++; return "base prompt"; });
		const opened = open(ctx);
		assert.equal(reads, 1);
		const view = ctx.customComponents[0]!;
		view.render(90);
		view.handleInput?.(KEY.down);
		view.render(60);
		assert.equal(reads, 1, "rendering and scrolling never re-read the prompt");
		assert.deepEqual(ctx.customOptions[0], {
			overlay: true,
			overlayOptions: { width: SYSTEM_PROMPT_PANEL_WIDTH, maxHeight: "100%", margin: { top: 1, bottom: 1, left: 2, right: 2 } },
		});
		assert.equal(await opened.closed(), false, "the promise stays pending while the view is open");
		view.handleInput?.(KEY.esc);
		assert.equal(await opened.closed(), true, "Escape resolves the promise");
	});

	it("shows the empty state when the prompt cannot be read (SP-01)", async () => {
		const ctx = makeCtx(() => { throw new Error("boom"); });
		const opened = open(ctx);
		assert.deepEqual(parts(ctx.customComponents[0]!.render(90)).body, ["No system prompt available"]);
		assert.deepEqual(ctx.notifications, []);
		ctx.customComponents[0]!.handleInput?.(KEY.esc);
		assert.equal(await opened.closed(), true);
	});
});
