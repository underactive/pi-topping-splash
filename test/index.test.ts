import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import piStartupGreeter from "../index.ts";
import { gradientAnimation, stopGradientAnimation } from "../src/animate.ts";
import { BOX_MIN_ROWS, EDITOR_RESERVED_ROWS, summarizeChanges } from "../src/changes-summary.ts";
import { readPreferences, writePreferences, type SplashPreferences } from "../src/preferences.ts";
import { stopTaglineReveal, taglineReveal } from "../src/reveal.ts";
import { headerRenderState, state } from "../src/state.ts";
import { buildHeader } from "../src/splash.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { setArgv, setEnv, tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { createFakeCtx, makeAssistantMessage, makeModel, type FakeCtxHarness } from "./helpers/fake-ctx.ts";
import { createFakePi, type FakePiBag, type FakePiHarness } from "./helpers/fake-api.ts";
import { createFakeTui, type FakeTuiHarness } from "./helpers/fake-tui.ts";
import { KEY } from "./helpers/keys.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { bootstrapGlobalTheme, makeTheme } from "./helpers/theme.ts";
import { deferred } from "./helpers/deferred.ts";
import { initRepo } from "./helpers/git.ts";
import { until } from "./helpers/wait.ts";
import { assertLinesExact } from "./helpers/width.ts";

bootstrapGlobalTheme();

let env: TempAgentEnv;
let restoreArgv: () => void;
let restoreGateEnv: () => void;
beforeEach(() => {
	env = tempAgentDir();
	restoreArgv = setArgv([], "");
	restoreGateEnv = setEnv("PI_SPLASH_GATE_DONE", undefined);
	resetModuleState();
});
afterEach(() => {
	stopTaglineReveal();
	stopGradientAnimation();
	restoreGateEnv();
	restoreArgv();
	env.restore();
});

interface Wired {
	pi: FakePiHarness;
	ctx: FakeCtxHarness;
	tui: FakeTuiHarness;
}

type TestModel = ReturnType<typeof makeModel>;
type SummaryResponder = NonNullable<Parameters<typeof createFakeCtx>[0]["streamSimple"]>;

interface WireOptions {
	mode?: string;
	hasUI?: boolean;
	projectTrusted?: boolean;
	cwd?: string;
	rows?: number;
	model?: TestModel | null;
	models?: TestModel[];
	streamSimple?: SummaryResponder;
	execHandler?: FakePiBag["execHandler"];
}

function wire(options: WireOptions = {}): Wired {
	const tui = createFakeTui({ rows: options.rows ?? 40, columns: 100 });
	const model = options.model === null ? undefined : options.model ?? makeModel("anthropic", "claude-opus-4");
	const models = options.models ?? (model ? [model] : []);
	const ctx = createFakeCtx({
		cwd: options.cwd ?? env.cwd,
		theme: makeTheme(),
		tui: tui.tui,
		model,
		models,
		streamSimple: options.streamSimple,
		systemPrompt: "p".repeat(2000),
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		projectTrusted: options.projectTrusted ?? false,
	});
	const pi = createFakePi({ thinkingLevel: "medium", execHandler: options.execHandler });
	piStartupGreeter(pi.pi);
	return { pi, ctx, tui };
}

const DIRTY_STATUS = "?? added.ts\0 M changed.ts\0 D deleted.ts\0";

function scriptedGit(root: string, status: string | null): FakePiBag["execHandler"] {
	return (_command, args) => {
		if (args.includes("rev-parse")) {
			return status === null
				? { stdout: "", stderr: "not a repository", code: 128, killed: false }
				: { stdout: `${root}\n`, stderr: "", code: 0, killed: false };
		}
		if (args.includes("status")) return { stdout: status ?? "", stderr: "", code: 0, killed: false };
		if (args.includes("--numstat")) return { stdout: "1\t1\tchanged.ts\0", stderr: "", code: 0, killed: false };
		if (args.includes("changed.ts")) return { stdout: "@@\n+changed\n", stderr: "", code: 0, killed: false };
		return { stdout: "", stderr: "", code: 0, killed: false };
	};
}

function mountedHeader(wired: Wired, index = 0): { render(width: number): string[] } {
	const factory = wired.ctx.setHeaderCalls[index] as (tui: unknown, theme: unknown) => { render(width: number): string[] };
	return factory(wired.tui.tui, makeTheme());
}

async function waitForSummary(wired: Wired): Promise<void> {
	await until(() => state.changes !== null);
	await until(() => wired.ctx.streamCalls.length > 0 || state.changes?.summary.status === "failed");
	assert.ok(state.changes, "dirty status must publish a presentation");
}

function startup(wired: Wired, reason = "startup"): Promise<void> {
	return wired.pi.emit("session_start", { type: "session_start", reason }, wired.ctx.ctx);
}

/** Focus the settings action bar and fire its primary Apply button. */
function pressApply(menu: { handleInput(data: string): void }): void {
	menu.handleInput(KEY.tab);
	menu.handleInput(KEY.enter);
}

/**
 * Persist preference choices through the real settings command, into this test's temp agent dir.
 * Drives the menu component synchronously before awaiting the handler, since the fake ui.custom
 * only resolves once the component calls `done` — awaiting first would deadlock.
 * Menu rows in cursor order: menuGate (0), taglineReveal (1).
 */
async function persist(target: Partial<SplashPreferences>): Promise<void> {
	const wired = wire();
	const current = readPreferences();
	const handlerPromise = wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never);
	const component = wired.ctx.customComponents[0] as { handleInput(data: string): void };
	if (target.menuGate !== undefined && target.menuGate !== current.menuGate) component.handleInput(KEY.space);
	component.handleInput(KEY.down);
	if (target.taglineReveal !== undefined && target.taglineReveal !== current.taglineReveal) component.handleInput(KEY.space);
	pressApply(component);
	await handlerPromise;
	resetModuleState();
}

describe("registration (I-01)", () => {
	it("registers no flags, four handlers and the topping-splash-settings command", () => {
		const { pi } = wire();
		assert.deepEqual(pi.registeredFlags, [], "the slash command is the only toggle — no CLI flags");
		for (const event of ["model_select", "before_agent_start", "session_shutdown", "session_start"]) {
			assert.ok(pi.handlers.has(event), `handler for ${event}`);
		}
		assert.ok(pi.commands.has("topping-splash-settings"));
		assert.ok(!pi.commands.has("topping-splash"), "old command name is gone");
	});
});

describe("session_start gating (I-02, I-03, I-10)", () => {
	it("shows header and gate on a genuine TUI startup; Esc proceeds", async () => {
		const wired = wire();
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		assert.ok(wired.ctx.setHeaderCalls.length >= 1, "splash header installed");
		assert.equal(wired.ctx.customComponents.length, 1, "gate shown");
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("\x1b");
		await emitted;
		assert.equal(wired.ctx.shutdownCount, 0, "proceed must not shut down");
		assert.equal(state.quietStartupEnsured, true, "quietStartup ensured once per process (I-10)");
	});

	it("Quit in the gate shuts pi down (I-04)", async () => {
		const wired = wire();
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("q");
		await emitted;
		assert.equal(wired.ctx.shutdownCount, 1);
	});

	it("no UI: no gate", async () => {
		const wired = wire({ hasUI: false, mode: "print" });
		await startup(wired);
		assert.equal(wired.ctx.customComponents.length, 0);
	});

	it("non-TUI mode with UI: no gate", async () => {
		const wired = wire({ mode: "rpc" });
		await startup(wired);
		assert.equal(wired.ctx.customComponents.length, 0);
	});

	it("non-startup reasons: no gate", async () => {
		for (const reason of ["reload", "new", "resume", "fork"]) {
			const wired = wire();
			await startup(wired, reason);
			assert.equal(wired.ctx.customComponents.length, 0, `reason=${reason}`);
		}
	});

	// Source comment: "Non-gated sessions start clean, without the splash."
	// README wording is looser — flagged as F-8 in the report.
	it("PI_SPLASH_GATE_DONE=1 starts clean: no gate, no splash", async () => {
		restoreGateEnv();
		restoreGateEnv = setEnv("PI_SPLASH_GATE_DONE", "1");
		const wired = wire();
		await startup(wired);
		assert.equal(wired.ctx.customComponents.length, 0, "gate skipped");
		assert.equal(wired.ctx.setHeaderCalls.length, 0, "non-gated sessions start without the splash");
	});

	it("proceed tears the splash down for a clean session start", async () => {
		const wired = wire();
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("\x1b");
		await emitted;
		assert.equal(wired.ctx.setHeaderCalls.length, 2, "splash header swapped for an empty one");
		const emptyFactory = wired.ctx.setHeaderCalls[1] as (tui: unknown, theme: unknown) => { render(width: number): string[] };
		assert.deepEqual(emptyFactory(wired.tui.tui, makeTheme()).render(100), []);
		assert.equal(headerRenderState.requestRender, null, "render callbacks released");
		assert.equal(headerRenderState.invalidate, null);
	});
});

describe("splash without the gate menu (I-11, I-12)", () => {
	it("menuGate:off keeps the splash and mounts no gate", async () => {
		await persist({ menuGate: "off" });
		const wired = wire();
		await startup(wired);
		assert.equal(wired.ctx.setHeaderCalls.length, 1, "splash installed and never swapped out");
		assert.equal(wired.ctx.customComponents.length, 0, "no gate menu");
		assert.equal(wired.ctx.shutdownCount, 0);
		// Mount the still-installed factory the way the TUI would; teardown would have nulled these.
		const factory = wired.ctx.setHeaderCalls[0] as (tui: unknown, theme: unknown) => unknown;
		factory(wired.tui.tui, makeTheme());
		assert.equal(typeof headerRenderState.requestRender, "function", "header callbacks stay wired");
		assert.equal(typeof headerRenderState.invalidate, "function");
	});

	it("PI_SPLASH_GATE_DONE=1 wins: relaunched children get no splash (I-12)", async () => {
		await persist({ menuGate: "off" });
		restoreGateEnv();
		restoreGateEnv = setEnv("PI_SPLASH_GATE_DONE", "1");
		const wired = wire();
		await startup(wired);
		assert.equal(wired.ctx.setHeaderCalls.length, 0, "no splash");
		assert.equal(wired.ctx.customComponents.length, 0, "no gate");
	});

	it("reason=reload still shows nothing (I-12)", async () => {
		await persist({ menuGate: "off" });
		const wired = wire();
		await startup(wired, "reload");
		assert.equal(wired.ctx.setHeaderCalls.length, 0, "no splash");
		assert.equal(wired.ctx.customComponents.length, 0, "no gate");
	});
});

describe("model_select (I-08) and before_agent_start (I-09)", () => {
	/** Splash-only mode leaves the header installed and its callbacks wired, unlike the gate's proceed path. */
	async function wireWithHeader(): Promise<Wired> {
		await persist({ menuGate: "off" });
		const wired = wire();
		await startup(wired);
		const factory = wired.ctx.setHeaderCalls.at(-1) as (tui: unknown, theme: unknown) => unknown;
		factory(wired.tui.tui, makeTheme());
		assert.equal(typeof headerRenderState.requestRender, "function");
		return wired;
	}

	it("updates the prompt size and requests a header refresh", async () => {
		const wired = await wireWithHeader();
		wired.ctx.bag.systemPrompt = "z".repeat(3333);
		const before = wired.tui.renderRequests.length;
		await wired.pi.emit("model_select", { type: "model_select" }, wired.ctx.ctx);
		assert.equal(state.systemPromptSize, 3333);
		assert.ok(wired.tui.renderRequests.length > before, "header refresh requested");
	});

	it("a throwing getSystemPrompt preserves the previous size and does not crash", async () => {
		const wired = await wireWithHeader();
		const initial = state.systemPromptSize;
		assert.equal(initial, 2000);
		wired.ctx.bag.systemPrompt = () => {
			throw new Error("not available");
		};
		await wired.pi.emit("model_select", { type: "model_select" }, wired.ctx.ctx);
		assert.equal(state.systemPromptSize, 2000, "previous size preserved");
	});

	it("before_agent_start records the prompt byte size", async () => {
		const wired = wire();
		await wired.pi.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "y".repeat(1234) }, wired.ctx.ctx);
		assert.equal(state.systemPromptSize, 1234);
	});
});

describe("commands (I-06, I-07)", () => {
	it("applying the toggle persists the flipped value and notifies success", async () => {
		const wired = wire();
		assert.equal(readPreferences().menuGate, "on", "starts at the default");
		const handlerPromise = wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never);
		const component = wired.ctx.customComponents[0] as { handleInput(data: string): void };
		component.handleInput(KEY.space);
		pressApply(component);
		await handlerPromise;
		assert.equal(readPreferences().menuGate, "off", "choice written to disk");
		assert.equal(readPreferences().taglineReveal, "on", "untouched toggle keeps its value");
		assert.equal(wired.ctx.setHeaderCalls.length, 0, "header untouched — the gate is decided at startup");
		assert.ok(
			wired.ctx.notifications.some((n) => n.type === "info"),
			"user notified of success",
		);
	});

	it("toggling the tagline animation persists taglineReveal and leaves menuGate alone", async () => {
		const wired = wire();
		const handlerPromise = wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never);
		const component = wired.ctx.customComponents[0] as { handleInput(data: string): void };
		component.handleInput(KEY.down);
		component.handleInput(KEY.space);
		pressApply(component);
		await handlerPromise;
		const prefs = readPreferences();
		assert.equal(prefs.taglineReveal, "off", "choice written to disk");
		assert.equal(prefs.menuGate, "on", "gate preference untouched");
	});

	it("escape cancels without writing or notifying success", async () => {
		const wired = wire();
		const handlerPromise = wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never);
		const component = wired.ctx.customComponents[0] as { handleInput(data: string): void };
		component.handleInput(KEY.space);
		component.handleInput(KEY.esc);
		await handlerPromise;
		assert.equal(readPreferences().menuGate, "on", "preference untouched");
		assert.equal(existsSync(join(env.agentDir, "pi-topping-splash.json")), false, "no file written");
		assert.ok(!wired.ctx.notifications.some((n) => n.type === "info"), "no success notification");
	});

	it("a failing preference write notifies an error instead of success (I-06, I-07)", async () => {
		const wired = wire();
		const blocker = join(env.agentDir, "not-a-dir");
		writeFileSync(blocker, "occupied");
		const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", blocker);
		try {
			const handlerPromise = wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never);
			const component = wired.ctx.customComponents[0] as { handleInput(data: string): void };
			component.handleInput(KEY.space);
			pressApply(component);
			await handlerPromise;
		} finally {
			restoreAgentDir();
		}
		assert.ok(wired.ctx.notifications.some((n) => n.type === "error"), "failure reported to the user");
		assert.ok(!wired.ctx.notifications.some((n) => n.type === "info"), "no false success notification");
		assert.equal(readPreferences().menuGate, "on", "preference unchanged after the failed write");
	});

	it("non-TUI mode notifies an error and shows no menu", async () => {
		const wired = wire({ mode: "rpc" });
		await wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never);
		assert.ok(wired.ctx.notifications.some((n) => n.type === "error"), "user notified TUI is required");
		assert.equal(wired.ctx.customComponents.length, 0, "no menu shown");
		assert.equal(existsSync(join(env.agentDir, "pi-topping-splash.json")), false, "no file written");
	});
});

describe("startup changes settings (I-18)", () => {
	type Input = { handleInput(data: string): void };
	type Rendered = Input & { render(width: number): string[] };

	const rendered = (component: Rendered, width = 80): string => component.render(width).map(sanitizeTuiText).join("\n");

	/** Run the settings command, moving the cursor `rowsDown` rows; 5 lands on the Summary model row. */
	function openSettings(wired: Wired, rowsDown = 5): { menu: Rendered; finished: Promise<void> } {
		const finished = Promise.resolve(wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never));
		const menu = wired.ctx.customComponents[0] as Rendered;
		for (let index = 0; index < rowsDown; index++) menu.handleInput(KEY.down);
		return { menu, finished };
	}

	/** The overlay `ui.custom` mounts once `count` are already open. */
	async function overlayAfter(wired: Wired, count: number): Promise<Rendered> {
		await until(() => wired.ctx.customComponents.length > count);
		return wired.ctx.customComponents.at(-1) as Rendered;
	}

	function seedPreferences(changesSummaryModel: SplashPreferences["changesSummaryModel"]): void {
		writePreferences({ menuGate: "on", taglineReveal: "on", backgroundColor: "rainbow", gradientAnimation: "off", changesSummary: "on", changesSummaryModel });
	}

	it("renders an Apply/Cancel action bar between two rules, above the hints", async () => {
		const wired = wire();
		const { menu, finished } = openSettings(wired, 0);
		const lines = menu.render(100).map(sanitizeTuiText);
		const bar = lines.findIndex((line) => line.includes("[ Apply ]"));
		assert.ok(bar > 0, lines.join("\n"));
		assert.match(lines[bar]!, /\[ Apply \]\s+‹ Cancel ›  ║$/, "buttons are right-aligned");
		assert.match(lines[bar - 1]!, /^╟─+╢$/, "rule above the bar");
		assert.match(lines[bar + 1]!, /^╟─+╢$/, "rule below the bar");
		assert.ok(lines[bar + 2]!.includes("⇥ actions"), lines[bar + 2]);
		assertLinesExact(lines, visibleWidth(lines[0]!), "settings menu rows share one width");
		menu.handleInput(KEY.esc);
		await finished;
	});

	it("Enter on a toggle or cycle row does nothing; only the action bar applies", async () => {
		const wired = wire();
		let settled = false;
		const { menu, finished } = openSettings(wired, 0);
		void finished.then(() => {
			settled = true;
		});
		menu.handleInput(KEY.space);
		menu.handleInput(KEY.enter);
		menu.handleInput(KEY.down);
		menu.handleInput(KEY.down);
		menu.handleInput(KEY.enter);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(settled, false, "Enter on ordinary rows must not close the menu");
		assert.equal(existsSync(join(env.agentDir, "pi-topping-splash.json")), false, "nothing written yet");
		pressApply(menu);
		await finished;
		assert.equal(readPreferences().menuGate, "off", "the staged toggle survived the stray Enters");
	});

	it("Tab hands the arrow keys to the action bar and back to the rows", async () => {
		const wired = wire();
		const { menu, finished } = openSettings(wired, 2);
		menu.handleInput(KEY.tab);
		menu.handleInput(KEY.right);
		menu.handleInput(KEY.left);
		menu.handleInput(KEY.tab);
		menu.handleInput(KEY.right);
		pressApply(menu);
		await finished;
		assert.equal(readPreferences().backgroundColor, "accent", "only the post-Tab arrow cycled the row");
	});

	it("the Cancel button closes without writing or notifying success", async () => {
		const wired = wire();
		const { menu, finished } = openSettings(wired, 0);
		menu.handleInput(KEY.space);
		menu.handleInput(KEY.tab);
		menu.handleInput(KEY.right);
		menu.handleInput(KEY.enter);
		await finished;
		assert.equal(readPreferences().menuGate, "on", "staged change discarded");
		assert.equal(existsSync(join(env.agentDir, "pi-topping-splash.json")), false, "no file written");
		assert.ok(!wired.ctx.notifications.some((n) => n.type === "info"), "no success notification");
	});

	it("toggles the feature at cursor 4 and persists a summary model picked with Enter", async () => {
		const wired = wire();
		wired.ctx.bag.models.push(makeModel("provider", "fast"));
		const { menu, finished } = openSettings(wired, 4);
		menu.handleInput(KEY.space);
		menu.handleInput(KEY.down);
		menu.handleInput(KEY.enter);
		const picker = await overlayAfter(wired, 1);
		for (const character of "provider/fast") picker.handleInput(character);
		picker.handleInput(KEY.enter);
		const reopened = await overlayAfter(wired, 2);
		assert.ok(rendered(reopened).includes("provider/fast"));
		pressApply(reopened);
		await finished;
		const prefs = readPreferences();
		assert.equal(prefs.changesSummary, "on");
		assert.deepEqual(prefs.changesSummaryModel, { provider: "provider", id: "fast" }, "the thinking pane's choice is never stored");
	});

	it("Space on the Summary model row still opens the picker", async () => {
		const wired = wire();
		const { menu, finished } = openSettings(wired);
		menu.handleInput(KEY.space);
		const picker = await overlayAfter(wired, 1);
		assert.ok(rendered(picker).includes("Summary Model"));
		picker.handleInput(KEY.esc);
		(await overlayAfter(wired, 2)).handleInput(KEY.esc);
		await finished;
	});

	it("opens the gate's two-pane model picker in a titled popup that fits every width", async () => {
		const wired = wire();
		const { menu, finished } = openSettings(wired);
		menu.handleInput(KEY.enter);
		const picker = await overlayAfter(wired, 1);
		const text = rendered(picker, 90);
		for (const expected of ["Summary Model", "Summarizes uncommitted changes", "Models", "Thinking", "anthropic/claude-opus-4", "Select", "Cancel", "type to filter"]) {
			assert.ok(text.includes(expected), `${expected}\n${text}`);
		}
		for (const width of [20, 40, 60, 90]) assertLinesExact(picker.render(width), width, `picker at ${width}`);
		picker.handleInput(KEY.esc);
		(await overlayAfter(wired, 2)).handleInput(KEY.esc);
		await finished;
	});

	it("starts the picker on the pinned model, else on the session model", async () => {
		const early = makeModel("alpha", "early");
		const late = makeModel("zeta", "late");
		const cases: { label: string; pinned: SplashPreferences["changesSummaryModel"]; expected: { provider: string; id: string } }[] = [
			{ label: "nothing pinned", pinned: undefined, expected: { provider: "zeta", id: "late" } },
			{ label: "a pinned model", pinned: { provider: "alpha", id: "early" }, expected: { provider: "alpha", id: "early" } },
		];
		for (const [index, testCase] of cases.entries()) {
			if (index > 0) resetModuleState();
			seedPreferences(testCase.pinned);
			const wired = wire({ model: late, models: [early, late] });
			const { menu, finished } = openSettings(wired);
			menu.handleInput(KEY.enter);
			const picker = await overlayAfter(wired, 1);
			picker.handleInput(KEY.enter);
			pressApply(await overlayAfter(wired, 2));
			await finished;
			assert.deepEqual(readPreferences().changesSummaryModel, testCase.expected, testCase.label);
		}
	});

	it("picker Escape keeps the prior value and menu Escape writes nothing", async () => {
		seedPreferences({ provider: "provider", id: "fast" });
		const wired = wire();
		const { menu, finished } = openSettings(wired);
		menu.handleInput(KEY.enter);
		const picker = await overlayAfter(wired, 1);
		picker.handleInput(KEY.esc);
		const reopened = await overlayAfter(wired, 2);
		assert.ok(rendered(reopened).includes("provider/fast"), "prior value still shown");
		reopened.handleInput(KEY.esc);
		await finished;
		assert.deepEqual(readPreferences().changesSummaryModel, { provider: "provider", id: "fast" });
	});

	it("Backspace or Delete resets the Summary model row to the session model", async () => {
		for (const [index, clearKey] of [KEY.backspace, KEY.delete].entries()) {
			if (index > 0) resetModuleState();
			seedPreferences({ provider: "provider", id: "fast" });
			const wired = wire({ models: [makeModel("provider", "fast")] });
			const { menu, finished } = openSettings(wired);
			assert.ok(rendered(menu).includes("provider/fast"));
			menu.handleInput(clearKey);
			assert.ok(rendered(menu).includes("session model"), "row reads as deliberately unset");
			pressApply(menu);
			await finished;
			assert.equal(readPreferences().changesSummaryModel, undefined, `key ${index}`);
		}
	});

	it("a cleared Summary model stays cleared when the picker is then cancelled", async () => {
		seedPreferences({ provider: "provider", id: "fast" });
		const wired = wire({ models: [makeModel("provider", "fast")] });
		const { menu, finished } = openSettings(wired);
		menu.handleInput(KEY.backspace);
		menu.handleInput(KEY.enter);
		(await overlayAfter(wired, 1)).handleInput(KEY.esc);
		const reopened = await overlayAfter(wired, 2);
		assert.ok(rendered(reopened).includes("session model"));
		pressApply(reopened);
		await finished;
		assert.equal(readPreferences().changesSummaryModel, undefined, "the pinned ref must not outlive the clear");
	});

	it("Backspace and Delete leave rows without a clear value alone", async () => {
		const wired = wire();
		const { menu, finished } = openSettings(wired, 0);
		menu.handleInput(KEY.backspace);
		menu.handleInput(KEY.down);
		menu.handleInput(KEY.down);
		menu.handleInput(KEY.delete);
		pressApply(menu);
		await finished;
		const prefs = readPreferences();
		assert.equal(prefs.menuGate, "on");
		assert.equal(prefs.backgroundColor, "rainbow");
	});

	it("warns instead of opening a picker with no models to offer", async () => {
		const wired = wire({ model: null, models: [] });
		const { menu, finished } = openSettings(wired);
		menu.handleInput(KEY.enter);
		const reopened = await overlayAfter(wired, 1);
		assert.ok(wired.ctx.notifications.some((n) => n.type === "warning" && n.message.includes("No models")));
		assert.ok(rendered(reopened).includes("Pi Topping Splash: Settings"), "back on the menu, no picker mounted");
		assert.equal(wired.ctx.customComponents.length, 2);
		reopened.handleInput(KEY.esc);
		await finished;
	});
});

describe("startup changes integration (AC2-AC8)", () => {
	function changesPreferences(menuGate: "on" | "off" = "off", changesSummaryModel?: SplashPreferences["changesSummaryModel"]): void {
		writePreferences({
			menuGate,
			taglineReveal: "off",
			backgroundColor: "rainbow",
			gradientAnimation: "off",
			changesSummary: "on",
			changesSummaryModel,
		});
	}

	it("does not collect disabled dirty changes or render a block", async () => {
		writePreferences({ menuGate: "off", taglineReveal: "off", backgroundColor: "rainbow", gradientAnimation: "off", changesSummary: "off" });
		const wired = wire({ projectTrusted: true, execHandler: scriptedGit(env.cwd, DIRTY_STATUS) });
		await startup(wired);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(wired.pi.execCalls.length, 0, "disabled startup must not run git");
		assert.equal(wired.ctx.streamCalls.length, 0, "disabled startup must not call a model");
		const header = mountedHeader(wired);
		assert.equal(state.changes, null);
		assert.ok(!header.render(100).map(sanitizeTuiText).join("\n").includes("uncommitted"));
	});

	it("stays silent for clean, empty, non-repository, and untrusted projects", async () => {
		const cleanRoot = join(env.cwd, "clean-repository");
		const emptyRoot = join(env.cwd, "empty-repository");
		mkdirSync(cleanRoot, { recursive: true });
		mkdirSync(emptyRoot, { recursive: true });
		initRepo(cleanRoot, { "tracked.txt": "baseline\n" });
		initRepo(emptyRoot, {});
		const cases: { label: string; cwd: string; root: string; status: string | null; trusted: boolean; expectedGitCalls: number }[] = [
			{ label: "clean repository", cwd: cleanRoot, root: cleanRoot, status: "", trusted: true, expectedGitCalls: 2 },
			{ label: "empty repository", cwd: emptyRoot, root: emptyRoot, status: "", trusted: true, expectedGitCalls: 2 },
			{ label: "non-repository directory", cwd: join(env.cwd, "not-a-repository"), root: join(env.cwd, "not-a-repository"), status: null, trusted: true, expectedGitCalls: 1 },
			{ label: "untrusted project", cwd: env.cwd, root: env.cwd, status: DIRTY_STATUS, trusted: false, expectedGitCalls: 0 },
		];
		for (const [index, testCase] of cases.entries()) {
			if (index > 0) resetModuleState();
			changesPreferences();
			const wired = wire({ cwd: testCase.cwd, projectTrusted: testCase.trusted, execHandler: scriptedGit(testCase.root, testCase.status) });
			await startup(wired);
			await until(() => wired.pi.execCalls.length >= testCase.expectedGitCalls);
			const header = mountedHeader(wired);
			const first = header.render(100);
			const second = header.render(100);
			assert.deepEqual(second, first, testCase.label);
			assert.equal(state.changes, null, testCase.label);
			assert.equal(wired.ctx.streamCalls.length, 0, testCase.label);
			assert.ok(!first.map(sanitizeTuiText).join("\n").includes("uncommitted"), testCase.label);
		}
	});

	it("publishes dirty paths while the gate is open, then fills the same block", async () => {
		changesPreferences("on");
		const response = deferred<ReturnType<typeof makeAssistantMessage>>();
		const wired = wire({
			projectTrusted: true,
			execHandler: scriptedGit(env.cwd, DIRTY_STATUS),
			streamSimple: async () => response.promise,
		});
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		assert.equal(wired.ctx.customComponents.length, 1, "gate mounts without waiting for the model");
		await waitForSummary(wired);
		const header = mountedHeader(wired);
		const pendingText = header.render(100).map(sanitizeTuiText).join("\n");
		assert.ok(pendingText.includes("+ added.ts"), pendingText);
		assert.ok(pendingText.includes("~ changed.ts"), pendingText);
		assert.ok(pendingText.includes("- deleted.ts"), pendingText);
		assert.ok(pendingText.includes("summarizing with anthropic/claude-opus-4"), pendingText);
		response.resolve(makeAssistantMessage("The changes add, modify, and delete startup files."));
		await until(() => state.changes?.summary.status === "done");
		const doneText = header.render(100).map(sanitizeTuiText).join("\n");
		assert.ok(doneText.includes("The changes add, modify"), doneText);
		assert.equal((doneText.match(/uncommitted/g) ?? []).length, 1);
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput(KEY.esc);
		await emitted;
	});

	it("fills line counts into the listing after it is already on screen", async () => {
		changesPreferences();
		const numstat = deferred<ExecResult>();
		const response = deferred<ReturnType<typeof makeAssistantMessage>>();
		const scripted = scriptedGit(env.cwd, DIRTY_STATUS);
		const wired = wire({
			projectTrusted: true,
			execHandler: (command, args, options) => (args.includes("HEAD") ? numstat.promise : scripted(command, args, options)),
			streamSimple: async () => response.promise,
		});
		await startup(wired);
		await until(() => state.changes !== null);
		const header = mountedHeader(wired);
		const before = header.render(100).map(sanitizeTuiText);
		assert.ok(before.join("\n").includes("~ changed.ts"), before.join("\n"));
		assert.equal(before.join("\n").includes("▇"), false, "no bars before git has counted");
		const version = state.changes?.version ?? 0;
		numstat.resolve({ stdout: "3\t1\tchanged.ts\u00000\t2\tdeleted.ts\0", stderr: "", code: 0, killed: false });
		await until(() => (state.changes?.version ?? 0) > version);
		const after = header.render(100).map(sanitizeTuiText);
		assert.match(after.join("\n"), /~ changed\.ts .*▇.* \+3 -1 │/);
		assert.match(after.join("\n"), /- deleted\.ts .*▇.* \+0 -2 │/);
		assert.equal(after.length, before.length, "line counts never add rows");
		response.resolve(makeAssistantMessage("done"));
		await until(() => state.changes?.summary.status === "done");
	});

	it("renders a single compact preview when only one to three rows remain below the splash", async () => {
		changesPreferences();
		const response = deferred<ReturnType<typeof makeAssistantMessage>>();
		const wired = wire({ projectTrusted: true, execHandler: scriptedGit(env.cwd, DIRTY_STATUS), streamSimple: async () => response.promise });
		await startup(wired);
		await waitForSummary(wired);
		const header = mountedHeader(wired);
		let shortBudgets = 0;
		for (let rows = 15; rows <= 40; rows++) {
			wired.tui.resizeRows(rows);
			const model = wired.ctx.ctx.model;
			const splashRows = buildHeader(100, rows, makeTheme(), state.loadedContext, state.loadedSkills, state.loadedExtensions,
				model ? { provider: model.provider, id: model.id } : undefined, state.systemPromptSize,
				state.backgroundColor, state.gradientAnimation, 0, state.loadedPrompts, state.loadedShortcuts).length;
			const budget = Math.max(0, rows - splashRows - EDITOR_RESERVED_ROWS);
			const changes = header.render(100).slice(splashRows).map(sanitizeTuiText);
			if (budget >= 1 && budget < BOX_MIN_ROWS) {
				shortBudgets++;
				assert.equal(changes.length, 1, `terminal rows ${rows}`);
				assert.match(changes[0], /^   ● 3 uncommitted \[\+1 · ~1 · -1\]/);
				assert.ok(changes[0].includes("~ changed.ts +1 -1"));
				assert.ok(changes[0].includes("summarizing with anthropic/"));
				assert.equal(state.splashRows, splashRows + 1);
			} else if (budget === 0) {
				assert.deepEqual(changes, []);
			}
		}
		assert.ok(shortBudgets > 0, "the sweep must reach a short nonzero budget");
		response.resolve(makeAssistantMessage("Summary ready."));
		await until(() => state.changes?.summary.status === "done");
	});

	it("resolves configured, session, missing-configured, and no-model cases", async () => {
		const session = makeModel("provider", "session");
		const configured = makeModel("provider", "configured");
		const cases: {
			label: string;
			model: TestModel | null;
			models: TestModel[];
			configured?: SplashPreferences["changesSummaryModel"];
			expected?: TestModel;
		}[] = [
			{ label: "configured model", model: session, models: [session, configured], configured: { provider: "provider", id: "configured" }, expected: configured },
			{ label: "session model", model: session, models: [session], expected: session },
			{ label: "missing configured model falls back", model: session, models: [session], configured: { provider: "missing", id: "model" }, expected: session },
			{ label: "no models", model: null, models: [] },
		];
		for (const [index, testCase] of cases.entries()) {
			if (index > 0) resetModuleState();
			changesPreferences("off", testCase.configured);
			const wired = wire({
				projectTrusted: true,
				model: testCase.model,
				models: testCase.models,
				execHandler: scriptedGit(env.cwd, DIRTY_STATUS),
				streamSimple: async () => makeAssistantMessage("ok"),
			});
			await startup(wired);
			await until(() => wired.ctx.streamCalls.length > 0 || state.changes?.summary.status === "failed");
			assert.ok(state.changes, testCase.label);
			if (testCase.expected) {
				assert.equal(wired.ctx.streamCalls.length, 1, testCase.label);
				assert.equal(wired.ctx.streamCalls[0]?.model, testCase.expected, testCase.label);
			} else {
				assert.equal(wired.ctx.streamCalls.length, 0, testCase.label);
				assert.equal(state.changes?.summary.status, "failed", testCase.label);
				assert.ok(mountedHeader(wired).render(100).map(sanitizeTuiText).join("\n").includes("summary unavailable: no model selected"));
			}
		}
	});

	it("keeps headings and file rows idempotent across redraws and repeated starts", async () => {
		changesPreferences();
		const response = deferred<ReturnType<typeof makeAssistantMessage>>();
		const wired = wire({ projectTrusted: true, execHandler: scriptedGit(env.cwd, DIRTY_STATUS), streamSimple: async () => response.promise });
		await startup(wired);
		const header = mountedHeader(wired);
		await waitForSummary(wired);
		const assertStable = () => {
			const text = header.render(100).map(sanitizeTuiText).join("\n");
			assert.equal((text.match(/uncommitted/g) ?? []).length, 1);
			for (const path of ["added.ts", "changed.ts", "deleted.ts"]) {
				assert.equal((text.match(new RegExp(path, "g")) ?? []).length, 1, path);
			}
		};
		for (let index = 0; index < 20; index++) assertStable();
		response.resolve(makeAssistantMessage("Summary complete."));
		await until(() => state.changes?.summary.status === "done");
		for (let index = 0; index < 20; index++) assertStable();
		const gitCalls = wired.pi.execCalls.length;
		const streamCalls = wired.ctx.streamCalls.length;
		await startup(wired, "startup");
		await startup(wired, "reload");
		assert.equal(wired.pi.execCalls.length, gitCalls);
		assert.equal(wired.ctx.streamCalls.length, streamCalls);
	});

	it("keeps the listing on model failures and reports each failure reason", async () => {
		const cases: { label: string; streamSimple: SummaryResponder }[] = [
			{ label: "rejection", streamSimple: async () => { throw new Error("provider exploded"); } },
			{ label: "error stop", streamSimple: async () => makeAssistantMessage("", "error", "provider refused") },
			{ label: "aborted stop", streamSimple: async () => makeAssistantMessage("", "aborted") },
			{ label: "empty text", streamSimple: async () => makeAssistantMessage("") },
		];
		for (const [index, testCase] of cases.entries()) {
			if (index > 0) resetModuleState();
			changesPreferences();
			const wired = wire({ projectTrusted: true, execHandler: scriptedGit(env.cwd, DIRTY_STATUS), streamSimple: testCase.streamSimple });
			await startup(wired);
			await until(() => state.changes?.summary.status === "failed");
			const text = mountedHeader(wired).render(100).map(sanitizeTuiText).join("\n");
			assert.ok(text.includes("┌─ uncommitted ─"), testCase.label);
			assert.ok(text.includes("summary unavailable:"), testCase.label);
		}
	});

	it("maps an aborted request to cancellation and an aborted timeout to timeout", async () => {
		const model = makeModel("provider", "model");
		const ctx = createFakeCtx({ cwd: env.cwd, theme: makeTheme(), tui: createFakeTui().tui, model, models: [model], streamSimple: async () => makeAssistantMessage("", "aborted") });
		const prompt = { systemPrompt: "system", text: "text" };
		const cancelled = await summarizeChanges(ctx.ctx, model, prompt, new AbortController().signal);
		assert.deepEqual(cancelled, { status: "failed", reason: "cancelled" });

		const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
		assert.ok(originalTimeout, "AbortSignal.timeout must exist");
		try {
			Object.defineProperty(AbortSignal, "timeout", {
				configurable: true,
				value: () => {
					const controller = new AbortController();
					controller.abort();
					return controller.signal;
				},
			});
			const timedOut = await summarizeChanges(ctx.ctx, model, prompt, new AbortController().signal);
			assert.deepEqual(timedOut, { status: "failed", reason: "timed out" });
		} finally {
			Object.defineProperty(AbortSignal, "timeout", originalTimeout);
		}
	});

	it("aborts the provider signal on session shutdown", async () => {
		changesPreferences();
		const response = deferred<ReturnType<typeof makeAssistantMessage>>();
		let requestSignal: AbortSignal | undefined;
		const wired = wire({
			projectTrusted: true,
			execHandler: scriptedGit(env.cwd, DIRTY_STATUS),
			streamSimple: async (_model, _context, options?: SimpleStreamOptions) => {
				requestSignal = options?.signal;
				return response.promise;
			},
		});
		await startup(wired);
		await waitForSummary(wired);
		assert.ok(requestSignal);
		await wired.pi.emit("session_shutdown", { type: "session_shutdown" }, wired.ctx.ctx);
		assert.equal(requestSignal?.aborted, true);
		response.resolve(makeAssistantMessage("late result"));
		await new Promise((resolve) => setImmediate(resolve));
	});

	it("keeps the changes-only header after gate proceed", async () => {
		changesPreferences("on");
		const response = deferred<ReturnType<typeof makeAssistantMessage>>();
		const wired = wire({ projectTrusted: true, execHandler: scriptedGit(env.cwd, DIRTY_STATUS), streamSimple: async () => response.promise });
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		await waitForSummary(wired);
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput(KEY.esc);
		await emitted;
		assert.equal(wired.ctx.setHeaderCalls.length, 2);
		const slim = mountedHeader(wired, 1);
		assert.ok(slim.render(100).map(sanitizeTuiText).join("\n").includes("┌─ uncommitted ─"));
		wired.tui.resizeRows(EDITOR_RESERVED_ROWS + 2);
		assert.match(slim.render(100).map(sanitizeTuiText).join("\n"), /^   ● 3 uncommitted \[\+1 · ~1 · -1\]/);
		wired.tui.resizeRows(40);
		assert.equal(headerRenderState.requestRender, null, "slim header must not masquerade as splash wiring");
		response.resolve(makeAssistantMessage("post-gate summary"));
		await until(() => state.changes?.summary.status === "done");
		assert.ok(slim.render(100).map(sanitizeTuiText).join("\n").includes("post-gate summary"));
	});
});

describe("menuGate persistence (I-14)", () => {
	/** Re-run the extension the way a fresh pi process would, keeping the temp agent dir. */
	async function relaunch(): Promise<Wired> {
		resetModuleState();
		const wired = wire();
		await startup(wired);
		return wired;
	}

	it("defaults to on (gate shown) with no preference file written yet", () => {
		assert.equal(readPreferences().menuGate, "on");
		assert.equal(existsSync(join(env.agentDir, "pi-topping-splash.json")), false);
	});

	it("menuGate:off keeps the splash and drops the gate on every later launch", async () => {
		await persist({ menuGate: "off" });

		for (const attempt of [1, 2]) {
			const next = await relaunch();
			assert.equal(next.ctx.setHeaderCalls.length, 1, `launch ${attempt}: splash installed and never swapped out`);
			assert.equal(next.ctx.customComponents.length, 0, `launch ${attempt}: no gate`);
			assert.equal(next.ctx.shutdownCount, 0, `launch ${attempt}: no shutdown`);
		}
	});

	it("menuGate:off leaves the quietStartup write in place (I-10)", async () => {
		await persist({ menuGate: "off" });
		await relaunch();
		assert.equal(state.quietStartupEnsured, true);
	});

	it("menuGate:on brings the gate back on the next launch", async () => {
		await persist({ menuGate: "off" });
		await persist({ menuGate: "on" });

		const next = wire();
		const emitted = startup(next);
		await until(() => next.ctx.customComponents.length > 0);
		assert.equal(next.ctx.customComponents.length, 1, "gate restored");
		(next.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("\x1b");
		await emitted;
	});

	it("a corrupt preference file falls back to the gate instead of throwing", async () => {
		writeFileSync(join(env.agentDir, "pi-topping-splash.json"), "{not json", "utf8");
		assert.equal(readPreferences().menuGate, "on");
		const wired = wire();
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		assert.equal(wired.ctx.customComponents.length, 1, "gate still shown");
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("\x1b");
		await emitted;
	});
});

describe("tagline reveal preference (I-15)", () => {
	it("defaults to on: startup starts the reveal", async () => {
		const wired = wire();
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		assert.notEqual(taglineReveal.timer, null, "reveal ticker running");
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("\x1b");
		await emitted;
	});

	it("taglineReveal:off installs the splash without ever starting the reveal", async () => {
		await persist({ taglineReveal: "off" });
		const wired = wire();
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		assert.ok(wired.ctx.setHeaderCalls.length >= 1, "splash still installed");
		assert.equal(taglineReveal.timer, null, "reveal never started");
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("\x1b");
		await emitted;
	});

	it("taglineReveal:off combines with menuGate:off (splash-only, settled)", async () => {
		await persist({ menuGate: "off", taglineReveal: "off" });
		const wired = wire();
		await startup(wired);
		assert.equal(wired.ctx.setHeaderCalls.length, 1, "splash installed");
		assert.equal(wired.ctx.customComponents.length, 0, "no gate");
		assert.equal(taglineReveal.timer, null, "reveal never started");
	});
});

describe("background color setting (I-06 extension)", () => {
	it("defaults to rainbow and cycles right through the theme colors", async () => {
		const wired = wire();
		assert.equal(readPreferences().backgroundColor, "rainbow", "starts at the default");
		const handlerPromise = wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never);
		const component = wired.ctx.customComponents[0] as { handleInput(data: string): void };
		component.handleInput(KEY.down);
		component.handleInput(KEY.down);
		component.handleInput(KEY.right);
		pressApply(component);
		await handlerPromise;
		assert.equal(readPreferences().backgroundColor, "accent", "cycled one step right");
	});

	it("persists all three preferences atomically and leaves untouched toggles as-is", async () => {
		const wired = wire();
		const handlerPromise = wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never);
		const component = wired.ctx.customComponents[0] as { handleInput(data: string): void };
		component.handleInput(KEY.down);
		component.handleInput(KEY.down);
		component.handleInput(KEY.right);
		component.handleInput(KEY.right);
		pressApply(component);
		await handlerPromise;
		const prefs = readPreferences();
		assert.equal(prefs.backgroundColor, "border");
		assert.equal(prefs.menuGate, "on", "untouched toggle keeps its value");
		assert.equal(prefs.taglineReveal, "on", "untouched toggle keeps its value");
	});

	it("missing preference file defaults to rainbow", () => {
		assert.equal(readPreferences().backgroundColor, "rainbow");
	});

	it("a corrupt or invalid persisted value falls back to rainbow", () => {
		writeFileSync(join(env.agentDir, "pi-topping-splash.json"), JSON.stringify({ backgroundColor: "not-a-color" }), "utf8");
		assert.equal(readPreferences().backgroundColor, "rainbow");
	});

	it("cancellation leaves the stored background and the visible splash unchanged", async () => {
		const wired0 = wire();
		const applyPromise = wired0.pi.commands.get("topping-splash-settings")!.handler("", wired0.ctx.ctx as never);
		const applyComponent = wired0.ctx.customComponents[0] as { handleInput(data: string): void };
		applyComponent.handleInput(KEY.down);
		applyComponent.handleInput(KEY.down);
		applyComponent.handleInput(KEY.right);
		applyComponent.handleInput(KEY.right);
		applyComponent.handleInput(KEY.right);
		applyComponent.handleInput(KEY.right);
		applyComponent.handleInput(KEY.right);
		pressApply(applyComponent);
		await applyPromise;
		assert.equal(readPreferences().backgroundColor, "success");
		resetModuleState();
		const wired = wire();
		const handlerPromise = wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never);
		const component = wired.ctx.customComponents[0] as { handleInput(data: string): void };
		component.handleInput(KEY.down);
		component.handleInput(KEY.down);
		component.handleInput(KEY.right);
		component.handleInput(KEY.esc);
		await handlerPromise;
		assert.equal(readPreferences().backgroundColor, "success", "unchanged after cancel");
		assert.equal(state.backgroundColor, "rainbow", "shared state untouched by a cancelled menu");
	});

	it("a failed write leaves state.backgroundColor and the persisted value unchanged", async () => {
		const wired = wire();
		const blocker = join(env.agentDir, "not-a-dir");
		writeFileSync(blocker, "occupied");
		const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", blocker);
		try {
			const handlerPromise = wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never);
			const component = wired.ctx.customComponents[0] as { handleInput(data: string): void };
			component.handleInput(KEY.down);
			component.handleInput(KEY.down);
			component.handleInput(KEY.right);
			pressApply(component);
			await handlerPromise;
		} finally {
			restoreAgentDir();
		}
		assert.equal(state.backgroundColor, "rainbow", "state untouched on write failure");
	});

	it("applying a new background invalidates and requests a render of the visible splash", async () => {
		await persist({ menuGate: "off" });
		const wired = wire();
		await startup(wired);
		const factory = wired.ctx.setHeaderCalls.at(-1) as (tui: unknown, theme: unknown) => unknown;
		factory(wired.tui.tui, makeTheme());
		assert.equal(typeof headerRenderState.requestRender, "function");

		const before = wired.tui.renderRequests.length;
		const handlerPromise = wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never);
		const component = wired.ctx.customComponents[0] as { handleInput(data: string): void };
		component.handleInput(KEY.down);
		component.handleInput(KEY.down);
		component.handleInput(KEY.right);
		pressApply(component);
		await handlerPromise;
		assert.equal(state.backgroundColor, "accent");
		assert.ok(wired.tui.renderRequests.length > before, "a render must be requested after applying");
	});
});

describe("gradient animation setting (I-17)", () => {
	/** Menu rows in cursor order: menuGate (0), taglineReveal (1), backgroundColor (2), gradientAnimation (3). */
	async function applyMenu(wired: Wired, inputs: string[]): Promise<void> {
		const handlerPromise = wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never);
		const component = wired.ctx.customComponents.at(-1) as { handleInput(data: string): void };
		for (const key of inputs) component.handleInput(key);
		pressApply(component);
		await handlerPromise;
	}

	it("defaults to off; cycling right persists breathe and leaves the rest alone", async () => {
		const wired = wire();
		assert.equal(readPreferences().gradientAnimation, "off", "starts at the default");
		await applyMenu(wired, [KEY.down, KEY.down, KEY.down, KEY.right]);
		const prefs = readPreferences();
		assert.equal(prefs.gradientAnimation, "breathe", "cycled one step right");
		assert.equal(prefs.backgroundColor, "rainbow", "untouched cycle keeps its value");
		assert.equal(prefs.menuGate, "on", "untouched toggle keeps its value");
	});

	it("an invalid persisted value falls back to off", () => {
		writeFileSync(join(env.agentDir, "pi-topping-splash.json"), JSON.stringify({ gradientAnimation: "sparkle" }), "utf8");
		assert.equal(readPreferences().gradientAnimation, "off");
	});

	it("applying an animated theme-color backdrop to a visible splash starts the ticker; off stops it", async () => {
		await persist({ menuGate: "off" });
		const wired = wire();
		await startup(wired);
		const factory = wired.ctx.setHeaderCalls.at(-1) as (tui: unknown, theme: unknown) => unknown;
		factory(wired.tui.tui, makeTheme());

		await applyMenu(wired, [KEY.down, KEY.down, KEY.right, KEY.down, KEY.right]);
		assert.equal(state.backgroundColor, "accent");
		assert.equal(state.gradientAnimation, "breathe");
		assert.notEqual(gradientAnimation.timer, null, "ticker running on an animated backdrop");

		await applyMenu(wired, [KEY.down, KEY.down, KEY.down, KEY.left]);
		assert.equal(state.gradientAnimation, "off");
		assert.equal(gradientAnimation.timer, null, "ticker stopped once the animation is off");
	});

	it("applying an animation while the background stays rainbow also starts the ticker", async () => {
		await persist({ menuGate: "off" });
		const wired = wire();
		await startup(wired);
		const factory = wired.ctx.setHeaderCalls.at(-1) as (tui: unknown, theme: unknown) => unknown;
		factory(wired.tui.tui, makeTheme());

		await applyMenu(wired, [KEY.down, KEY.down, KEY.down, KEY.right]);
		assert.equal(state.backgroundColor, "rainbow", "background untouched");
		assert.equal(state.gradientAnimation, "breathe");
		assert.notEqual(gradientAnimation.timer, null, "the rainbow animates too");
	});

	it("applying an animation with no splash header wired leaves the ticker off", async () => {
		const wired = wire();
		await applyMenu(wired, [KEY.down, KEY.down, KEY.right, KEY.down, KEY.right]);
		assert.equal(readPreferences().gradientAnimation, "breathe", "persisted for the next launch");
		assert.equal(gradientAnimation.timer, null, "nothing visible to animate");
	});

	it("the first agent turn stops the ticker; a later apply persists but cannot restart it", async () => {
		writePreferences({ menuGate: "off", taglineReveal: "on", backgroundColor: "accent", gradientAnimation: "flow", changesSummary: "off" });
		const wired = wire();
		await startup(wired);
		const factory = wired.ctx.setHeaderCalls.at(-1) as (tui: unknown, theme: unknown) => unknown;
		factory(wired.tui.tui, makeTheme());
		assert.notEqual(gradientAnimation.timer, null, "ticker running in splash-only mode");

		await wired.pi.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "x" }, wired.ctx.ctx);
		assert.equal(gradientAnimation.timer, null, "first turn stopped the ticker");

		await applyMenu(wired, [KEY.down, KEY.down, KEY.down, KEY.right]);
		assert.equal(readPreferences().gradientAnimation, "sheen", "preference still persisted");
		assert.equal(gradientAnimation.timer, null, "mid-session apply must not restart an off-screen animation");
	});

	it("startup with an animated preference runs the ticker; the gate's proceed teardown stops it", async () => {
		writePreferences({ menuGate: "on", taglineReveal: "on", backgroundColor: "accent", gradientAnimation: "flow", changesSummary: "off" });
		const wired = wire();
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		assert.notEqual(gradientAnimation.timer, null, "ticker running during the gate");
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("\x1b");
		await emitted;
		assert.equal(gradientAnimation.timer, null, "teardown stopped the ticker");
	});
});
