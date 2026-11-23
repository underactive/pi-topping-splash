import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { showSystemPromptDialog } from "../src/ui/system-prompt-view-dialog.ts";
import { createFakeCtx } from "./helpers/fake-ctx.ts";
import { createFakeTui } from "./helpers/fake-tui.ts";
import { press, screen, settle, type Shown } from "./helpers/dialog.ts";
import { KEY } from "./helpers/keys.ts";
import { makeTheme } from "./helpers/theme.ts";

const VIEWER_WIDTH = 110;

function makeCtx(systemPrompt: string | (() => string)) {
	const tui = createFakeTui({ rows: 40 });
	return createFakeCtx({ cwd: "/tmp", theme: makeTheme(), tui: tui.tui, systemPrompt });
}

/** Opens the view; `closed()` reports whether the opener's promise has resolved, without ever hanging. */
function open(ctx: ReturnType<typeof makeCtx>): { closed: () => Promise<boolean> } {
	let resolved = false;
	void showSystemPromptDialog(ctx.ctx).then(() => { resolved = true; });
	return { closed: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); return resolved; } };
}

describe("showSystemPromptDialog (SP-01..SP-08)", () => {
	it("reads the prompt once per open and opens a capturing OpenTUI dialog (SP-01, SP-02)", async () => {
		let reads = 0;
		const ctx = makeCtx(() => { reads++; return "base prompt\nsecond line"; });
		const opened = open(ctx);
		assert.equal(reads, 1);
		const view = ctx.customComponents[0]! as Shown;
		await settle(view, VIEWER_WIDTH);
		const text = screen(view, VIEWER_WIDTH);
		assert.match(text, /SYSTEM PROMPT/);
		assert.ok(text.includes("base prompt") && text.includes("second line"));
		assert.equal(reads, 1, "rendering and scrolling never re-read the prompt");
		// Capturing overlay reporting the dialog's own question.
		const options = ctx.customOptions[0] as { overlay?: boolean; blocked?: unknown };
		assert.equal(options.overlay, true);
		assert.deepEqual(options.blocked, { kind: "question", message: "System Prompt" });
		assert.equal(await opened.closed(), false, "the promise stays pending while the view is open");
		await press(view, KEY.esc);
		assert.equal(await opened.closed(), true, "Escape resolves the promise");
		assert.equal(reads, 1, "closing never re-reads");
	});

	it("scrolls one row with arrows and pages with PgUp/PgDn, clamped at both ends (SP-03, SP-04)", async () => {
		const lines = Array.from({ length: 120 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`);
		const ctx = makeCtx(lines.join("\n"));
		const opened = open(ctx);
		const view = ctx.customComponents[0]! as Shown;
		await settle(view, VIEWER_WIDTH);
		const first = screen(view, VIEWER_WIDTH);
		assert.ok(first.includes("line 001"));
		assert.match(first, /1–\d+ of 120/);
		await press(view, KEY.down);
		assert.ok(screen(view, VIEWER_WIDTH).includes("line 002"));
		await press(view, KEY.pageUp);
		assert.ok(screen(view, VIEWER_WIDTH).includes("line 001"), "Up at the top does nothing");
		for (let i = 0; i < 200; i++) await press(view, KEY.pageDown);
		const bottom = screen(view, VIEWER_WIDTH);
		assert.ok(bottom.includes("line 120"));
		assert.match(bottom, /\d+–120 of 120/);
		await press(view, KEY.down);
		assert.equal(screen(view, VIEWER_WIDTH), bottom, "nothing scrolls past the end");
		await press(view, KEY.esc);
		assert.equal(await opened.closed(), true);
	});

	it("shows the empty state when the prompt cannot be read (SP-01, SP-07)", async () => {
		const ctx = makeCtx(() => { throw new Error("boom"); });
		const opened = open(ctx);
		const view = ctx.customComponents[0]! as Shown;
		await settle(view, VIEWER_WIDTH);
		assert.ok(screen(view, VIEWER_WIDTH).includes("No system prompt available"));
		assert.deepEqual(ctx.notifications, []);
		await press(view, KEY.esc);
		assert.equal(await opened.closed(), true);
	});

	it("Enter closes too, and every other key does nothing (SP-08)", async () => {
		const ctx = makeCtx("prompt");
		const opened = open(ctx);
		const view = ctx.customComponents[0]! as Shown;
		await settle(view, VIEWER_WIDTH);
		for (const key of ["q", "p", "s", KEY.tab, KEY.left, KEY.right, "hello"]) await press(view, key);
		assert.equal(await opened.closed(), false);
		await press(view, KEY.enter);
		assert.equal(await opened.closed(), true, "Enter closes the view");
	});
});
