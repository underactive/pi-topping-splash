import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import {
	formatSessionDate,
	runStartupGate,
	sessionPreview,
	StartupGate,
	gateMenuRows,
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
import { press, screen, settle, type Shown } from "./helpers/dialog.ts";
import { MODEL_PICKER_WIDTH } from "../src/ui/dialog-size.ts";
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
	it('renders the "(no messages)" sentinel as untitled', () => {
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

function makeGate(options: { rows?: number; setModelResult?: boolean; systemPrompt?: string | (() => string) } = {}): GateHarness {
	const tui = createFakeTui({ rows: options.rows ?? 40, columns: 100 });
	const models = [makeModel("anthropic", "claude-opus-4"), makeModel("openai", "gpt-4o")];
	const ctx = createFakeCtx({
		cwd: env.cwd,
		theme: makeTheme(),
		tui: tui.tui,
		models,
		model: models[0],
		systemPrompt: options.systemPrompt,
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
	it("gateMenuRows matches rendered height and stays spacious beside a changes block", () => {
		for (const rows of [20, 24, 29, 30, 40]) {
			state.changes = null;
			const harness = makeGate({ rows });
			assert.equal(gateMenuRows(rows), harness.gate.render(90).length, `rows=${rows}`);
		}
		state.changes = { entries: [{ path: "file.ts", kind: "changed", untracked: false }], summary: { status: "pending", modelLabel: "p/m" }, version: 1 };
		const spaced = makeGate({ rows: 40 });
		assert.equal(gateMenuRows(40), spaced.gate.render(90).length);
		assert.equal(gateMenuRows(40), 16, "the changes section gives up rows, not the menu's spacing");
		const lines = spaced.gate.render(90).map((line) => sanitizeTuiText(line));
		// Spacer, seven items each preceded by a gap, a gap above the hint, then the hint itself.
		for (let row = 0; row <= 14; row++) {
			const text = lines[row]?.trim();
			if (row % 2 === 0) assert.equal(text, "", `row ${row} is a gap`);
			else assert.notEqual(text, "", `row ${row} is an item`);
		}
	});

	it("lists the README menu items", () => {
		const harness = makeGate();
		const text = menuText(harness);
		for (const item of ["New session", "Resume", "Model", "Theme", "View system prompt", "Settings", "Quit"]) {
			assert.ok(text.includes(item), `menu missing ${item}`);
		}
		assert.equal(/skills|extensions/i.test(text), false, "the Skills and Extensions entry stays removed");
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
	it("Settings opens the settings dialog without resolving the gate", async () => {
		const harness = makeGate();
		harness.gate.handleInput("s");
		await until(() => harness.ctx.customComponents.length > 0);
		assert.equal(harness.ctx.customComponents.length, 1, "settings dialog mounted via ui.custom");
		assert.deepEqual(harness.results, [], "gate stays unresolved");
		(harness.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput(KEY.esc);
		harness.gate.handleInput("q");
		assert.deepEqual(harness.results, ["quit"]);
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
		// free rows = 40 - 15 splash - 16 menu = 9; the gate's zero-row footer claims no row,
		// so 9 - floor(9/2) = 5 trailing blanks push the menu up into the middle.
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

describe("View system prompt entry (GA-04)", () => {
	function mountedView(harness: GateHarness, index = 0): Shown {
		const component = harness.ctx.customComponents[index];
		assert.ok(component, "expected a mounted dialog component");
		return component as Shown;
	}

	it("shows the label with p, keeps Settings on s, and leaves x inert", () => {
		const harness = makeGate();
		const rows = menuText(harness).split("\n").map((line) => line.trimEnd());
		assert.ok(rows.find((line) => line.includes("View system prompt"))?.endsWith("p"), "hotkey column shows p");
		assert.ok(rows.find((line) => line.includes("Settings"))?.endsWith("s"), "Settings keeps s");
		harness.gate.handleInput("x");
		assert.deepEqual(harness.results, []);
		assert.equal(harness.ctx.customComponents.length, 0);
		assert.equal(harness.tui.overlays.length, 0);
	});

	it("p opens the viewer and s opens Settings, in legacy and Kitty encodings", async () => {
		for (const [key, opensPrompt] of [["p", true], ["\x1b[112u", true], ["s", false], ["\x1b[115u", false]] as const) {
			const harness = makeGate();
			harness.gate.handleInput(key);
			await until(() => harness.ctx.customComponents.length > 0);
			assert.equal(harness.ctx.customComponents.length, 1, `${JSON.stringify(key)} mounts one overlay`);
			if (opensPrompt) {
				const text = screen(mountedView(harness), 110);
				assert.match(text, /SYSTEM PROMPT/);
				const options = harness.ctx.customOptions[0] as { blocked?: unknown };
				assert.deepEqual(options.blocked, { kind: "question", message: "System Prompt" });
			}
			assert.deepEqual(harness.results, [], "the gate stays unresolved");
		}
	});

	it("the former Shift+S binding does nothing", () => {
		for (const key of ["S", "\x1b[115;2u"]) {
			const harness = makeGate();
			harness.gate.handleInput(key);
			assert.equal(harness.ctx.customComponents.length, 0, `${JSON.stringify(key)} mounts nothing`);
			assert.equal(harness.tui.overlays.length, 0);
			assert.deepEqual(harness.results, []);
		}
	});

	it("Enter on the row opens the same view", async () => {
		const harness = makeGate({ systemPrompt: "base prompt text" });
		for (let i = 0; i < 4; i++) harness.gate.handleInput(KEY.down);
		harness.gate.handleInput(KEY.enter);
		await until(() => harness.ctx.customComponents.length > 0);
		assert.ok(screen(mountedView(harness), 110).includes("base prompt text"));
		assert.deepEqual(harness.results, []);
	});

	it("shows only the static base prompt, read once, and starts nothing", async () => {
		const lines = Array.from({ length: 80 }, (_, i) => `static line ${i}`);
		lines[0] = "STATIC_BASE_A";
		lines[79] = "STATIC_BASE_B";
		let reads = 0;
		const harness = makeGate({ rows: 30, systemPrompt: () => { reads++; return lines.join("\n"); } });
		seedSession(env.cwd, "DYN_SESSION_MARKER");
		state.changes = { entries: [{ path: "DYN_CHANGES_PATH.ts", kind: "changed", untracked: false }], summary: { status: "done", text: "DYN_CHANGES_MARKER" }, version: 1 };
		state.loadedSkills = ["DYN_SKILL"];
		state.loadedExtensions = ["DYN_EXTENSION"];
		state.loadedContext = ["DYN_CONTEXT"];
		assert.equal(reads, 0, "nothing reads the prompt before the view opens");
		harness.gate.handleInput("p");
		await until(() => harness.ctx.customComponents.length > 0);
		const view = mountedView(harness);
		const seen: string[] = [];
		for (let page = 0; page < 60; page++) {
			const text = screen(view, 110);
			if (seen.at(-1) === text) break;
			seen.push(text);
			await press(view, KEY.pageDown);
		}
		const text = seen.join("\n");
		assert.equal(reads, 1, "read exactly once per open, however much the view renders or scrolls");
		assert.ok(text.includes("STATIC_BASE_A") && text.includes("STATIC_BASE_B"), "paging reaches both ends of the prompt");
		assert.equal(/DYN_|dyn-model/.test(text), false, "no session, summary, skill or extension data leaks in");
		assert.deepEqual(harness.results, []);
		assert.equal(harness.pi.setModelCalls.length, 0);
		assert.equal(harness.tui.stopCount, 0, "no relaunch");
		assert.deepEqual(harness.ctx.notifications, []);
	});

	it("is modal: the gate's hotkeys do nothing while the view is open", async () => {
		const harness = makeGate();
		harness.gate.handleInput("p");
		const view = mountedView(harness);
		await settle(view, 110);
		// pi-tui routes input to the focused overlay, so these reach the view and never the
		// gate. Enter/Esc are left out: they belong to the view and would close it.
		for (const key of ["q", "n", "r", "t", "m", "s", "p", KEY.left, KEY.right]) await press(view, key);
		assert.deepEqual(harness.results, []);
		assert.equal(harness.ctx.customComponents.length, 1);
		assert.equal(harness.ctx.mountedComponents.length, 1, "nothing closed the view");
		assert.equal(harness.tui.overlays.length, 0, "no drill-in popup opened beneath");
		const chevron = menuText(harness).split("\n").find((line) => line.includes("View system prompt"));
		assert.ok(chevron?.includes("❯"), "the gate keeps its selection on the row beneath the view");
	});

	it("Esc returns to an interactive menu that can reopen the view", async () => {
		let reads = 0;
		const harness = makeGate({ systemPrompt: () => { reads++; return "prompt"; } });
		harness.gate.handleInput("p");
		const view = mountedView(harness);
		await settle(view, 110);
		const before = harness.tui.renderRequests.length;
		await press(view, KEY.esc);
		await until(() => harness.ctx.mountedComponents.length === 0);
		assert.ok(harness.tui.renderRequests.length > before, "the gate repaints after the view closes");
		assert.deepEqual(harness.results, [], "closing the view does not resolve the gate");
		harness.gate.handleInput("p");
		await until(() => harness.ctx.mountedComponents.length > 0);
		assert.equal(harness.ctx.customComponents.length, 2, "each open mounts one dialog");
		assert.equal(harness.ctx.mountedComponents.length, 1);
		assert.equal(reads, 2, "each open reads the prompt again");
		await press(mountedView(harness), KEY.esc);
		await until(() => harness.ctx.mountedComponents.length === 0);
		harness.gate.handleInput("q");
		assert.deepEqual(harness.results, ["quit"]);
	});
});
describe("overlay lifecycle (GA-09)", () => {
	it("Resume creates the popup lazily, menu return hides it, reuse unhides it", () => {
		const harness = makeGate();
		assert.equal(harness.tui.overlays.length, 0);
		harness.gate.handleInput("r");
		assert.equal(harness.tui.overlays.length, 1);
		harness.gate.handleInput(KEY.esc);
		const overlay = harness.tui.overlays[0]!;
		assert.equal(overlay.removed, false, "returning to the menu must hide, not destroy");
		assert.ok(overlay.setHiddenCalls.includes(true));
		harness.gate.handleInput("r");
		assert.equal(harness.tui.overlays.length, 1, "same-width views reuse the overlay");
		assert.equal(overlay.hidden, false);
	});
	it("Theme opens a capturing dialog instead of the popup overlay", async () => {
		const harness = makeGate();
		assert.equal(harness.tui.overlays.length, 0);
		harness.gate.handleInput("t");
		await until(() => harness.ctx.mountedComponents.length > 0);
		assert.equal(harness.tui.overlays.length, 0, "no drill-in popup for Theme");
		const options = harness.ctx.customOptions[0] as { overlay?: boolean; blocked?: unknown };
		assert.equal(options.overlay, true);
		assert.deepEqual(options.blocked, { kind: "question", message: "Select Theme" });
		const text = screen(harness.ctx.mountedComponents[0] as Shown, 56);
		assert.match(text, /SELECT THEME/);
		await press(harness.ctx.mountedComponents[0] as Shown, KEY.esc);
		await until(() => harness.ctx.mountedComponents.length === 0);
	});
	it("popup renders exactly the width the overlay grants", () => {
		const harness = makeGate();
		harness.gate.handleInput("r");
		const overlay = harness.tui.live();
		assert.ok(overlay);
		for (const width of [40, 60, 80]) {
			assertLinesExact(overlay.component.render(width), width, `popup render(width=${width})`);
		}
	});
});
describe("theme view (GA-10)", () => {
	const THEME_PICKER_WIDTH = 56;

	async function openTheme(harness: GateHarness): Promise<Shown> {
		harness.gate.handleInput("t");
		await until(() => harness.ctx.mountedComponents.length > 0);
		const picker = harness.ctx.mountedComponents[0] as Shown;
		await settle(picker, THEME_PICKER_WIDTH);
		return picker;
	}

	it("navigation live-previews with Theme instances; Esc restores by name", async () => {
		const harness = makeGate();
		const picker = await openTheme(harness);
		assert.equal(harness.ctx.setThemeCalls.length, 0);
		await press(picker, KEY.down);
		assert.ok(harness.ctx.setThemeCalls.length >= 1, "moving the selection must live-preview");
		const preview = harness.ctx.setThemeCalls.at(-1);
		assert.ok(preview instanceof Theme, "preview must pass a Theme instance (in-memory only)");
		await press(picker, KEY.esc);
		await until(() => harness.ctx.mountedComponents.length === 0);
		const restore = harness.ctx.setThemeCalls.at(-1);
		assert.equal(typeof restore, "string", "escape must restore by name (persisting string form)");
		assert.equal(restore, "test-theme", "restore target is the theme active when the picker opened");
	});
	it("Esc without any preview restores nothing", async () => {
		const harness = makeGate();
		await openTheme(harness);
		assert.equal(harness.ctx.setThemeCalls.length, 0);
		await press(harness.ctx.mountedComponents[0] as Shown, KEY.esc);
		await until(() => harness.ctx.mountedComponents.length === 0);
		assert.equal(harness.ctx.setThemeCalls.length, 0);
	});
	it("gap pass: a throwing getAllThemes is survivable (no-crash safety)", async () => {
		const harness = makeGate();
		harness.ctx.bag.themes = undefined as never;
		Object.defineProperty(harness.ctx.bag, "themes", {
			get() {
				throw new Error("theme store unavailable");
			},
		});
		const picker = await openTheme(harness);
		const text = screen(picker, THEME_PICKER_WIDTH);
		assert.ok(text.includes("No themes available"));
		assert.deepEqual(harness.results, [], "gate must survive and stay interactive");
		await press(picker, KEY.esc);
		await until(() => harness.ctx.mountedComponents.length === 0);
		assert.deepEqual(harness.results, []);
	});
	it("Enter persists the selected theme by name and returns to the menu", async () => {
		const harness = makeGate();
		const picker = await openTheme(harness);
		await press(picker, KEY.down);
		await press(picker, KEY.enter);
		await until(() => harness.ctx.mountedComponents.length === 0);
		const applied = harness.ctx.setThemeCalls.at(-1);
		assert.equal(typeof applied, "string");
		assert.ok(["dark", "light", "solarized"].includes(applied as string), `applied ${String(applied)}`);
		assert.equal(harness.tui.overlays.length, 0, "back on the menu, no drill-in popup");
		harness.gate.handleInput("q");
		assert.deepEqual(harness.results, ["quit"], "the menu is interactive again");
	});
});
describe("model view (GA-12)", () => {
	/** Press m and wait for the OpenTUI picker to mount through ui.custom. */
	async function openPicker(harness: GateHarness): Promise<Shown> {
		harness.gate.handleInput("m");
		await until(() => harness.ctx.customComponents.length > 0);
		const picker = harness.ctx.customComponents[0] as Shown;
		await settle(picker, MODEL_PICKER_WIDTH);
		return picker;
	}
	/** The picker mounts on the current model; Enter steps into its thinking pane, Enter again selects. */
	async function confirmDefault(harness: GateHarness): Promise<void> {
		const picker = await openPicker(harness);
		await press(picker, KEY.enter, KEY.enter);
		await until(() => harness.pi.setModelCalls.length > 0 || harness.ctx.notifications.length > 0);
		await new Promise((resolve) => setImmediate(resolve));
	}
	it("opens the OpenTUI picker as a capturing dialog, not in the gate's popup", async () => {
		const harness = makeGate();
		const picker = await openPicker(harness);
		assert.equal(harness.tui.overlays.length, 0, "no drill-in popup");
		const options = harness.ctx.customOptions[0] as { blocked?: unknown; overlay?: boolean };
		assert.equal(options.overlay, true);
		assert.deepEqual(options.blocked, { kind: "question", message: "Select Model" });
		const text = screen(picker, MODEL_PICKER_WIDTH);
		assert.match(text, /SELECT MODEL/);
		assert.match(text, /╭─ Thinking ─+╮/, "the thinking pane is drawn");
		assert.match(text, /claude-opus-4/);
		assert.match(text, /▸ claude-opus-4\s+✦\s+●/, "the session model is highlighted and marked current");
		assert.deepEqual(harness.results, [], "the gate stays unresolved");
	});
	it("confirm applies model then thinking and returns to the menu", async () => {
		const harness = makeGate();
		await confirmDefault(harness);
		assert.equal(harness.pi.setModelCalls.length, 1);
		assert.equal(harness.pi.setModelCalls[0]?.id, "claude-opus-4");
		assert.equal(harness.pi.setThinkingCalls.length, 1);
		assert.equal(harness.ctx.mountedComponents.length, 0, "the picker closed");
		harness.gate.handleInput("q");
		assert.deepEqual(harness.results, ["quit"], "the menu is interactive again");
	});
	it("Esc cancels: nothing is applied and the menu is back", async () => {
		const harness = makeGate();
		const picker = await openPicker(harness);
		await press(picker, KEY.esc);
		await until(() => harness.ctx.mountedComponents.length === 0);
		assert.equal(harness.pi.setModelCalls.length, 0);
		assert.equal(harness.pi.setThinkingCalls.length, 0);
		assert.deepEqual(harness.ctx.notifications, []);
		harness.gate.handleInput("q");
		assert.deepEqual(harness.results, ["quit"]);
	});
	it("a refused model notifies an error and returns to the menu", async () => {
		const harness = makeGate({ setModelResult: false });
		await confirmDefault(harness);
		assert.equal(harness.pi.setModelCalls.length, 1);
		assert.equal(harness.pi.setThinkingCalls.length, 0, "thinking must not be applied after a refusal");
		assert.ok(harness.ctx.notifications.some((n) => n.type === "error"));
		assert.equal(harness.ctx.mountedComponents.length, 0, "the picker closed");
		harness.gate.handleInput("q");
		assert.deepEqual(harness.results, ["quit"]);
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
	it("reports a blocked question while mounted inline", async () => {
		const tui = createFakeTui();
		const ctx = createFakeCtx({ cwd: env.cwd, theme: makeTheme(), tui: tui.tui, models: [] });
		const pi = createFakePi();
		const promise = runStartupGate(pi.pi, ctx.ctx);
		await until(() => ctx.customComponents.length > 0);
		assert.deepEqual(ctx.customOptions[0], { blocked: { kind: "question", message: "Startup gate" } });
		(ctx.customComponents[0] as StartupGate).handleInput(KEY.esc);
		assert.equal(await promise, "proceed");
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
