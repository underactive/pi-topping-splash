import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import {
	formatSessionDate,
	runStartupGate,
	sessionPreview,
	StartupGate,
	type GateResolution,
	type SessionListItem,
} from "../src/gate.ts";
import { state } from "../src/state.ts";
import { stopTaglineReveal } from "../src/reveal.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { setArgv, tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { createFakeCtx, makeModel, type FakeCtxHarness } from "./helpers/fake-ctx.ts";
import { createFakePi, type FakePiHarness } from "./helpers/fake-api.ts";
import { createFakeTui, type FakeTuiHarness } from "./helpers/fake-tui.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { bootstrapGlobalTheme, makeTheme } from "./helpers/theme.ts";
import { KEY } from "./helpers/keys.ts";
import { seedSession } from "./helpers/sessions.ts";
import { until } from "./helpers/wait.ts";
import { assertLinesAtMost, assertLinesExact } from "./helpers/width.ts";

bootstrapGlobalTheme();

let env: TempAgentEnv;
let restoreArgv: () => void;
beforeEach(() => {
	env = tempAgentDir();
	// Safety rail: a falsy argv[1] makes relaunchPi refuse before spawnSync can ever
	// re-execute this test file over the terminal.
	restoreArgv = setArgv([], "");
	resetModuleState();
});
afterEach(() => {
	stopTaglineReveal();
	restoreArgv();
	env.restore();
});

function session(overrides: Partial<Record<string, unknown>>): SessionListItem {
	return {
		path: "/tmp/s.jsonl",
		id: "s",
		cwd: "/tmp",
		created: new Date(2026, 0, 1),
		modified: new Date(2026, 0, 2),
		messageCount: 3,
		firstMessage: "hello",
		allMessagesText: "hello",
		...overrides,
	} as unknown as SessionListItem;
}

describe("sessionPreview (GA-01, GA-02)", () => {
	it("a user-set name wins", () => {
		assert.equal(sessionPreview(session({ name: "My Session", firstMessage: "ignored" })), "My Session");
	});
	it("reduces a skill envelope to its invocation", () => {
		const envelope = '<skill name="commit" location="/x/SKILL.md">Entire SKILL.md body here.</skill>';
		const preview = sessionPreview(session({ firstMessage: envelope }));
		assert.ok(preview.includes("commit"), `got ${JSON.stringify(preview)}`);
		assert.equal(preview.includes("<skill"), false);
		assert.equal(preview.includes("SKILL.md body"), false, "the injected instruction text is not what the user typed");
	});
	it('renders the "(no messages)" sentinel as untitled (commit 8329d39)', () => {
		assert.equal(sessionPreview(session({ firstMessage: "(no messages)" })), "(untitled session)");
	});
	it("flattens markup and never emits tags", () => {
		const preview = sessionPreview(
			session({ firstMessage: "<system-reminder>internal</system-reminder>real question" }),
		);
		assert.equal(preview.includes("<"), false, `got ${JSON.stringify(preview)}`);
		assert.ok(preview.includes("real question"));
	});
	it("collapses whitespace and strips ANSI", () => {
		assert.equal(sessionPreview(session({ firstMessage: "a\n\n   b" })), "a b");
		assert.equal(sessionPreview(session({ firstMessage: "\x1b[31mhi\x1b[0m there" })), "hi there");
	});
	it("UNSPECIFIED (GA-02): an empty first message yields a human-readable placeholder", () => {
		const preview = sessionPreview(session({ firstMessage: "" }));
		assert.ok(preview.length > 0);
	});
});

describe("formatSessionDate (GA-03)", () => {
	it("formats local YYYY-MM-DD HH:MM", () => {
		assert.equal(formatSessionDate(new Date(2026, 6, 27, 9, 5)), "2026-07-27 09:05");
		assert.equal(formatSessionDate(new Date(2026, 11, 3, 23, 59)), "2026-12-03 23:59");
	});
	it("tolerates bad input", () => {
		assert.equal(formatSessionDate(undefined), "");
		assert.equal(formatSessionDate(new Date("not a date")), "");
	});
});

interface GateHarness {
	gate: StartupGate;
	tui: FakeTuiHarness;
	ctx: FakeCtxHarness;
	pi: FakePiHarness;
	results: GateResolution[];
}

function makeGate(options: { rows?: number; setModelResult?: boolean } = {}): GateHarness {
	const tui = createFakeTui({ rows: options.rows ?? 40, columns: 100 });
	const models = [makeModel("anthropic", "claude-opus-4"), makeModel("openai", "gpt-4o")];
	const ctx = createFakeCtx({
		cwd: env.cwd,
		theme: makeTheme(),
		tui: tui.tui,
		models,
		model: models[0],
		themes: [
			{ name: "dark", path: undefined },
			{ name: "light", path: undefined },
			{ name: "solarized", path: undefined },
		],
		themeByName: (name) => makeTheme({ name }),
	});
	const pi = createFakePi({ thinkingLevel: "medium", setModelResult: options.setModelResult ?? true });
	const results: GateResolution[] = [];
	const gate = new StartupGate(tui.tui, makeTheme(), ctx.ctx, pi.pi, (r) => results.push(r));
	return { gate, tui, ctx, pi, results };
}

function menuText(harness: GateHarness, width = 90): string {
	return harness.gate.render(width).map(sanitizeTuiText).join("\n");
}

function popupText(harness: GateHarness, width = 80): string {
	const overlay = harness.tui.live();
	assert.ok(overlay, "expected a live overlay");
	return overlay.component.render(width).map(sanitizeTuiText).join("\n");
}

describe("menu (GA-04..GA-08)", () => {
	it("lists the README menu items", () => {
		const harness = makeGate();
		const text = menuText(harness);
		for (const item of ["New session", "Resume", "Model", "Skills and Extensions", "Theme", "Quit"]) {
			assert.ok(text.includes(item), `menu missing ${item}`);
		}
	});
	it("Enter on the initial selection proceeds (New session first)", () => {
		const harness = makeGate();
		harness.gate.handleInput(KEY.enter);
		assert.deepEqual(harness.results, ["proceed"]);
	});
	it("Esc on the menu proceeds", () => {
		const harness = makeGate();
		harness.gate.handleInput(KEY.esc);
		assert.deepEqual(harness.results, ["proceed"]);
	});
	it("hotkeys jump and activate: q quits, n proceeds", () => {
		const q = makeGate();
		q.gate.handleInput("q");
		assert.deepEqual(q.results, ["quit"]);
		const n = makeGate();
		n.gate.handleInput("n");
		assert.deepEqual(n.results, ["proceed"]);
	});
	it("arrow keys clamp at both ends", () => {
		const bottom = makeGate();
		for (let i = 0; i < 20; i++) bottom.gate.handleInput(KEY.down);
		bottom.gate.handleInput(KEY.enter);
		assert.deepEqual(bottom.results, ["quit"], "clamped at the last item (Quit)");
		const top = makeGate();
		top.gate.handleInput(KEY.down);
		for (let i = 0; i < 20; i++) top.gate.handleInput(KEY.up);
		top.gate.handleInput(KEY.enter);
		assert.deepEqual(top.results, ["proceed"], "clamped at the first item (New session)");
	});
	it("render stays within width for widths 1..200 (GA-08)", () => {
		const harness = makeGate();
		for (let width = 1; width <= 200; width++) {
			assertLinesAtMost(harness.gate.render(width), width, `menu render(width=${width})`);
		}
	});
	it("pads trailing blanks to center the menu below the splash (GA-08)", () => {
		state.splashRows = 15;
		const harness = makeGate({ rows: 40 });
		const lines = harness.gate.render(90);
		// free rows = 40 - 15 splash - 14 menu = 11; one below-row is the footer's,
		// so ceil(11/2) - 1 = 5 trailing blanks push the menu up into the middle.
		let lastVisible = lines.length - 1;
		while (lastVisible >= 0 && lines[lastVisible] === "") lastVisible--;
		const trailing = lines.length - 1 - lastVisible;
		assert.equal(trailing, 5);
		assert.ok(sanitizeTuiText(lines[lines.length - trailing - 1] ?? "").includes("↑↓ move"), "hint stays the last visible row");
	});
	it("no centering padding without a splash or without free rows", () => {
		const noSplash = makeGate({ rows: 40 });
		assert.notEqual(noSplash.gate.render(90).at(-1), "", "splashRows=0 must not pad");
		state.splashRows = 15;
		const short = makeGate({ rows: 24 });
		assert.notEqual(short.gate.render(90).at(-1), "", "compact terminals have no free rows to pad");
	});
	it("short terminals drop the spacer above the menu (GA-08)", () => {
		const tall = makeGate({ rows: 40 });
		const short = makeGate({ rows: 20 });
		const tallFirst = sanitizeTuiText(tall.gate.render(90)[0] ?? "").trim();
		const shortFirst = sanitizeTuiText(short.gate.render(90)[0] ?? "").trim();
		assert.equal(tallFirst, "", "tall terminals lead with a spacer row");
		assert.notEqual(shortFirst, "", "short terminals must not waste the row");
	});
});

describe("overlay lifecycle (GA-09)", () => {
	it("drill-in creates the popup lazily, menu return hides it, reuse unhides it", () => {
		const harness = makeGate();
		assert.equal(harness.tui.overlays.length, 0);
		harness.gate.handleInput("t");
		assert.equal(harness.tui.overlays.length, 1);
		harness.gate.handleInput(KEY.esc);
		const overlay = harness.tui.overlays[0]!;
		assert.equal(overlay.removed, false, "returning to the menu must hide, not destroy");
		assert.ok(overlay.setHiddenCalls.includes(true));
		harness.gate.handleInput("t");
		assert.equal(harness.tui.overlays.length, 1, "same-width views reuse the overlay");
		assert.equal(overlay.hidden, false);
	});
	it("a view needing a different width rebuilds the overlay (commit 8329d39)", () => {
		const harness = makeGate();
		harness.gate.handleInput("r");
		assert.equal(harness.tui.overlays.length, 1);
		assert.equal(harness.tui.overlays[0]?.options?.width, "100%", "resume takes the full terminal width");
		harness.gate.handleInput(KEY.esc);
		harness.gate.handleInput("t");
		assert.equal(harness.tui.overlays.length, 2, "width change must force a rebuild");
		assert.equal(harness.tui.overlays[0]?.removed, true, "the old overlay is destroyed");
		assert.notEqual(harness.tui.overlays[1]?.options?.width, "100%");
	});
	it("popup renders exactly the width the overlay grants", () => {
		const harness = makeGate();
		harness.gate.handleInput("t");
		const overlay = harness.tui.live();
		assert.ok(overlay);
		for (const width of [40, 60, 80]) {
			assertLinesExact(overlay.component.render(width), width, `popup render(width=${width})`);
		}
	});
});

describe("theme view (GA-10)", () => {
	it("navigation live-previews with Theme instances; Esc restores by name", () => {
		const harness = makeGate();
		harness.gate.handleInput("t");
		assert.equal(harness.ctx.setThemeCalls.length, 0);
		harness.gate.handleInput(KEY.down);
		assert.ok(harness.ctx.setThemeCalls.length >= 1, "moving the selection must live-preview");
		const preview = harness.ctx.setThemeCalls.at(-1);
		assert.ok(preview instanceof Theme, "preview must pass a Theme instance (in-memory only)");
		harness.gate.handleInput(KEY.esc);
		const restore = harness.ctx.setThemeCalls.at(-1);
		assert.equal(typeof restore, "string", "escape must restore by name (persisting string form)");
		assert.equal(restore, "test-theme", "restore target is the theme active when the popup opened");
	});
	it("Esc without any preview restores nothing", () => {
		const harness = makeGate();
		harness.gate.handleInput("t");
		harness.gate.handleInput(KEY.esc);
		assert.equal(harness.ctx.setThemeCalls.length, 0);
	});
	it("gap pass: a throwing getAllThemes is survivable (no-crash safety)", () => {
		const harness = makeGate();
		harness.ctx.bag.themes = undefined as never;
		Object.defineProperty(harness.ctx.bag, "themes", {
			get() {
				throw new Error("theme store unavailable");
			},
		});
		harness.gate.handleInput("t");
		harness.gate.handleInput(KEY.esc);
		assert.deepEqual(harness.results, [], "gate must survive and stay interactive");
	});
	it("Enter persists the selected theme by name and returns to the menu", () => {
		const harness = makeGate();
		harness.gate.handleInput("t");
		harness.gate.handleInput(KEY.down);
		harness.gate.handleInput(KEY.enter);
		const applied = harness.ctx.setThemeCalls.at(-1);
		assert.equal(typeof applied, "string");
		assert.ok(["dark", "light", "solarized"].includes(applied as string), `applied ${String(applied)}`);
		assert.equal(harness.tui.overlays[0]?.hidden, true, "back on the menu");
	});
});

describe("skills and extensions view (GA-11)", () => {
	function openInventory(): GateHarness {
		state.loadedSkills = ["alpha-skill", "beta-skill"];
		state.loadedExtensions = ["gamma-ext"];
		const harness = makeGate();
		harness.gate.handleInput("s");
		return harness;
	}
	it("lists both panes from shared state", () => {
		const harness = openInventory();
		const text = popupText(harness);
		for (const name of ["alpha-skill", "beta-skill", "gamma-ext"]) {
			assert.ok(text.includes(name), `${name} missing from ${JSON.stringify(text)}`);
		}
	});
	it("typing filters only the active pane; two-stage Esc clears then backs out", () => {
		const harness = openInventory();
		for (const ch of "alp") harness.gate.handleInput(ch);
		let text = popupText(harness);
		assert.equal(text.includes("beta-skill"), false, "left pane filtered");
		assert.ok(text.includes("gamma-ext"), "right pane untouched");
		harness.gate.handleInput(KEY.esc);
		text = popupText(harness);
		assert.ok(text.includes("beta-skill"), "first Esc clears the filter");
		assert.equal(harness.tui.overlays[0]?.hidden, false, "still in the view");
		harness.gate.handleInput(KEY.esc);
		assert.equal(harness.tui.overlays[0]?.hidden, true, "second Esc backs out");
		assert.deepEqual(harness.results, [], "backing out must not resolve the gate");
	});
});

describe("model view (GA-12)", () => {
	async function confirmDefault(harness: GateHarness): Promise<void> {
		harness.gate.handleInput("m");
		harness.gate.handleInput(KEY.tab);
		harness.gate.handleInput(KEY.tab);
		harness.gate.handleInput(KEY.enter);
		await until(() => harness.pi.setModelCalls.length > 0 || harness.ctx.notifications.length > 0);
		await new Promise((resolve) => setImmediate(resolve));
	}
	it("confirm applies model then thinking and returns to the menu", async () => {
		const harness = makeGate();
		await confirmDefault(harness);
		assert.equal(harness.pi.setModelCalls.length, 1);
		assert.equal(harness.pi.setModelCalls[0]?.id, "claude-opus-4");
		assert.equal(harness.pi.setThinkingCalls.length, 1);
		assert.equal(harness.tui.overlays[0]?.hidden, true, "back on the menu after applying");
	});
	it("a refused model keeps the picker open with an error (README)", async () => {
		const harness = makeGate({ setModelResult: false });
		await confirmDefault(harness);
		assert.equal(harness.pi.setModelCalls.length, 1);
		assert.equal(harness.pi.setThinkingCalls.length, 0, "thinking must not be applied after a refusal");
		assert.ok(harness.ctx.notifications.some((n) => n.type === "error"));
		assert.equal(harness.tui.overlays[0]?.hidden, false, "picker stays open");
	});
});

describe("resume view (GA-13)", () => {
	it("empty session dir shows an empty state without resolving the gate", async () => {
		const harness = makeGate();
		harness.gate.handleInput("r");
		await until(() => popupText(harness).length > 0);
		assert.deepEqual(harness.results, []);
		assertLinesExact(harness.tui.live()!.component.render(100), 100, "resume popup");
	});
	it("lists seeded sessions with preview, count and date columns", async () => {
		seedSession(env.cwd, "hello resumable world");
		const harness = makeGate();
		harness.gate.handleInput("r");
		await until(() => popupText(harness, 100).includes("hello resumable world"));
		const text = popupText(harness, 100);
		assert.ok(text.includes("hello resumable world"), `preview missing: ${JSON.stringify(text)}`);
		assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text), "date column expected");
		for (const width of [60, 100, 160]) {
			assertLinesExact(harness.tui.live()!.component.render(width), width, `resume render(${width})`);
		}
	});
	it("Enter on a session hits the guarded relaunch instead of spawning", async () => {
		seedSession(env.cwd, "target session");
		const harness = makeGate();
		harness.gate.handleInput("r");
		await until(() => popupText(harness, 100).includes("target session"));
		harness.gate.handleInput(KEY.enter);
		await until(() => harness.ctx.notifications.length > 0);
		assert.ok(harness.ctx.notifications.some((n) => n.type === "error"), "guard must refuse the relaunch");
		assert.equal(harness.tui.stopCount, 0);
		assert.deepEqual(harness.results, []);
	});
});

describe("runStartupGate (GA-14)", () => {
	it("suppresses the footer, resolves from the component, restores the footer", async () => {
		const tui = createFakeTui();
		const ctx = createFakeCtx({ cwd: env.cwd, theme: makeTheme(), tui: tui.tui, models: [] });
		const pi = createFakePi();
		const promise = runStartupGate(pi.pi, ctx.ctx);
		await until(() => ctx.customComponents.length > 0);
		assert.ok(ctx.setFooterCalls.length >= 1, "footer suppressed during the gate");
		assert.notEqual(ctx.setFooterCalls[0], undefined);
		const gate = ctx.customComponents[0] as StartupGate;
		gate.handleInput("q");
		assert.equal(await promise, "quit");
		assert.equal(ctx.setFooterCalls.at(-1), undefined, "footer restored after the gate");
	});
	it("Esc resolves proceed", async () => {
		const tui = createFakeTui();
		const ctx = createFakeCtx({ cwd: env.cwd, theme: makeTheme(), tui: tui.tui, models: [] });
		const pi = createFakePi();
		const promise = runStartupGate(pi.pi, ctx.ctx);
		await until(() => ctx.customComponents.length > 0);
		(ctx.customComponents[0] as StartupGate).handleInput(KEY.esc);
		assert.equal(await promise, "proceed");
	});
});
