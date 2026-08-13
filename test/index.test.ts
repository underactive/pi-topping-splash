import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import piStartupGreeter from "../index.ts";
import { gradientAnimation, stopGradientAnimation } from "../src/animate.ts";
import { readPreferences, writePreferences, type SplashPreferences } from "../src/preferences.ts";
import { stopTaglineReveal, taglineReveal } from "../src/reveal.ts";
import { headerRenderState, state } from "../src/state.ts";
import { setArgv, setEnv, tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { createFakeCtx, makeModel, type FakeCtxHarness } from "./helpers/fake-ctx.ts";
import { createFakePi, type FakePiHarness } from "./helpers/fake-api.ts";
import { createFakeTui, type FakeTuiHarness } from "./helpers/fake-tui.ts";
import { KEY } from "./helpers/keys.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { bootstrapGlobalTheme, makeTheme } from "./helpers/theme.ts";
import { until } from "./helpers/wait.ts";

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

function wire(options: { mode?: string; hasUI?: boolean } = {}): Wired {
	const tui = createFakeTui({ rows: 40, columns: 100 });
	const ctx = createFakeCtx({
		cwd: env.cwd,
		theme: makeTheme(),
		tui: tui.tui,
		model: makeModel("anthropic", "claude-opus-4"),
		systemPrompt: "p".repeat(2000),
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
	});
	const pi = createFakePi({ thinkingLevel: "medium" });
	piStartupGreeter(pi.pi);
	return { pi, ctx, tui };
}

function startup(wired: Wired, reason = "startup"): Promise<void> {
	return wired.pi.emit("session_start", { type: "session_start", reason }, wired.ctx.ctx);
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
	component.handleInput(KEY.enter);
	await handlerPromise;
	resetModuleState();
}

describe("registration (I-01)", () => {
	it("registers no flags, three handlers and the topping-splash-settings command", () => {
		const { pi } = wire();
		assert.deepEqual(pi.registeredFlags, [], "the slash command is the only toggle — no CLI flags");
		for (const event of ["model_select", "before_agent_start", "session_start"]) {
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
		component.handleInput(KEY.enter);
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
		component.handleInput(KEY.enter);
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
			component.handleInput(KEY.enter);
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
		component.handleInput(KEY.enter);
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
		component.handleInput(KEY.enter);
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
		applyComponent.handleInput(KEY.enter);
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
			component.handleInput(KEY.enter);
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
		component.handleInput(KEY.enter);
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
		component.handleInput(KEY.enter);
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
		writePreferences({ menuGate: "off", taglineReveal: "on", backgroundColor: "accent", gradientAnimation: "flow" });
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
		writePreferences({ menuGate: "on", taglineReveal: "on", backgroundColor: "accent", gradientAnimation: "flow" });
		const wired = wire();
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		assert.notEqual(gradientAnimation.timer, null, "ticker running during the gate");
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("\x1b");
		await emitted;
		assert.equal(gradientAnimation.timer, null, "teardown stopped the ticker");
	});
});
