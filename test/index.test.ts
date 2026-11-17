import assert from "node:assert/strict";
import { ENTRY_TYPES } from "@underactive/pi-topping-primitives/contracts";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import piStartupGreeter from "../index.ts";
import { gradientAnimation, logoAnimation, startLogoAnimation, stopGradientAnimation, stopLogoAnimation } from "../src/animate.ts";
import { INSTALLER_LOGO_LAST_FRAME } from "../src/installer-logo.ts";
import { EDITOR_RESERVED_ROWS, startSummaryStream, stopSummaryStream, summarizeChanges, summaryStream } from "../src/changes-summary.ts";
import { LOCAL_CHANGES_COMMAND } from "../src/local-changes.ts";
import { readPreferences, writePreferences, type SplashPreferences } from "../src/preferences.ts";
import { stopTaglineReveal, taglineReveal } from "../src/reveal.ts";
import { headerRenderState, state } from "../src/state.ts";
import { buildHeaderParts } from "../src/splash.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { SETTINGS_DIALOG_WIDTH } from "../src/ui/dialog-size.ts";
import { setArgv, setEnv, tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { createFakeCtx, FAKE_SESSION_ID, makeAssistantMessage, makeModel, type FakeCtxHarness } from "./helpers/fake-ctx.ts";
import { press, screen, type Shown } from "./helpers/dialog.ts";
import { createFakePi, type FakePiBag, type FakePiHarness } from "./helpers/fake-api.ts";
import { createFakeTui, type FakeTuiHarness } from "./helpers/fake-tui.ts";
import { KEY } from "./helpers/keys.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { bootstrapGlobalTheme, makeTheme } from "./helpers/theme.ts";
import { deferred } from "./helpers/deferred.ts";
import { initRepo } from "./helpers/git.ts";
import { until } from "./helpers/wait.ts";
import { assertLinesExact } from "./helpers/width.ts";
import { enableTimers } from "./helpers/timers.ts";

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
	stopLogoAnimation();
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

/** Each setting's place in the dialog: its section in the sidebar, then its row in that section's list. */
const SETTING_ROWS = {
	menuGate: { section: 0, row: 0 },
	backgroundColor: { section: 1, row: 0 },
	gradientAnimation: { section: 1, row: 1 },
	logoStyle: { section: 1, row: 2 },
	taglineReveal: { section: 2, row: 0 },
	changesSummary: { section: 2, row: 1 },
	changesSummaryModel: { section: 2, row: 2 },
} as const;
type SettingId = keyof typeof SETTING_ROWS;

/** The generated settings dialog, opened through the real command, and a user's way around it. */
interface SettingsRun {
	/** The command's own promise. */
	handlerPromise: Promise<void>;
	dialog: Shown;
	/** Put the cursor on `id`'s row the way a user does: down the sections, into the list, down to the row. */
	to(id: SettingId): Promise<void>;
	/** Keys one at a time, each given the time to commit. */
	press(...keys: string[]): Promise<void>;
	/** Ctrl+S. */
	apply(): Promise<void>;
	/** Escape until the dialog is gone without applying. With unsaved changes it asks first. */
	cancel(): Promise<void>;
}

/** Run the settings command and wait until its dialog is on screen. */
async function runSettings(wired: Wired): Promise<SettingsRun> {
	const mounted = wired.ctx.customComponents.length;
	const handlerPromise = Promise.resolve(wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never));
	await until(() => wired.ctx.customComponents.length > mounted);
	const dialog = wired.ctx.customComponents.at(-1) as Shown;
	await press(dialog);
	let closed = false;
	void handlerPromise.then(() => { closed = true; });
	// What the dialog's own cursors are, so `to` only presses the keys that are needed.
	let section = 0;
	let inList = false;
	const rows = [0, 0, 0];
	return {
		handlerPromise,
		dialog,
		press: (...keys) => press(dialog, ...keys),
		async to(id) {
			const target = SETTING_ROWS[id];
			if (inList && section !== target.section) {
				await press(dialog, KEY.esc);
				inList = false;
			}
			if (!inList) {
				const steps = target.section - section;
				await press(dialog, ...Array.from({ length: Math.abs(steps) }, () => (steps > 0 ? KEY.down : KEY.up)), KEY.right);
				section = target.section;
				inList = true;
			}
			const down = target.row - rows[section]!;
			await press(dialog, ...Array.from({ length: Math.abs(down) }, () => (down > 0 ? KEY.down : KEY.up)));
			rows[section] = target.row;
		},
		apply: () => press(dialog, KEY.ctrlS),
		async cancel() {
			for (let attempt = 0; attempt < 5 && !closed; attempt++) await press(dialog, KEY.esc);
			assert.ok(closed, "escape closes the dialog");
		},
	};
}

/** Open the dialog, make `edits` (a setting, then the keys that change it), and apply. */
async function applySettings(wired: Wired, ...edits: [SettingId, ...string[]][]): Promise<void> {
	const settings = await runSettings(wired);
	for (const [id, ...keys] of edits) {
		await settings.to(id);
		await settings.press(...keys);
	}
	await settings.apply();
	await settings.handlerPromise;
}

const DIRTY_STATUS = "?? added.ts\0 M changed.ts\0 D deleted.ts\0";

function scriptedGit(root: string, status: string | null): FakePiBag["execHandler"] {
	return (_command, args) => {
		if (args.includes("rev-parse")) {
			return status === null
				? { stdout: "", stderr: "not a repository", code: 128, killed: false, truncated: false }
				: { stdout: `${root}\n`, stderr: "", code: 0, killed: false, truncated: false };
		}
		if (args.includes("status")) return { stdout: status ?? "", stderr: "", code: 0, killed: false, truncated: false };
		if (args.includes("--numstat")) return { stdout: "1\t1\tchanged.ts\0", stderr: "", code: 0, killed: false, truncated: false };
		if (args.includes("changed.ts")) return { stdout: "@@\n+changed\n", stderr: "", code: 0, killed: false, truncated: false };
		return { stdout: "", stderr: "", code: 0, killed: false, truncated: false };
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

/** Persist preference choices through the real settings command, into this test's temp agent dir. */
async function persist(target: Partial<SplashPreferences>): Promise<void> {
	const wired = wire();
	const current = readPreferences();
	const edits: [SettingId, ...string[]][] = [];
	if (target.menuGate !== undefined && target.menuGate !== current.menuGate) edits.push(["menuGate", KEY.space]);
	if (target.taglineReveal !== undefined && target.taglineReveal !== current.taglineReveal) edits.push(["taglineReveal", KEY.space]);
	await applySettings(wired, ...edits);
	resetModuleState();
}

describe("registration (I-01)", () => {
	it("registers no flags, four handlers, both commands, and the local-changes renderer", () => {
		const { pi } = wire();
		assert.deepEqual(pi.registeredFlags, [], "the slash command is the only toggle — no CLI flags");
		for (const event of ["model_select", "before_agent_start", "session_shutdown", "session_start"]) {
			assert.ok(pi.handlers.has(event), `handler for ${event}`);
		}
		assert.ok(pi.commands.has("topping-splash-settings"));
		assert.ok(pi.commands.has(LOCAL_CHANGES_COMMAND));
		assert.ok(pi.entryRenderers.has(ENTRY_TYPES.splashLocalChanges));
		assert.ok(!pi.commands.has("topping-splash"), "old command name is gone");
	});
});

describe("session_start gating (I-02, I-03, I-10)", () => {
	it("shows header and gate on a genuine TUI startup; Esc proceeds", async () => {
		writePreferences({ menuGate: "on", taglineReveal: "on", backgroundColor: "rainbow", gradientAnimation: "off", logoStyle: "symbol", changesSummary: "off" });
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
		writePreferences({ menuGate: "on", taglineReveal: "on", backgroundColor: "rainbow", gradientAnimation: "off", logoStyle: "symbol", changesSummary: "off" });
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
		writePreferences({ menuGate: "on", taglineReveal: "on", backgroundColor: "rainbow", gradientAnimation: "off", logoStyle: "symbol", changesSummary: "off" });
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
		assert.equal(readPreferences().menuGate, "off", "starts at the default");
		await applySettings(wired, ["menuGate", KEY.space]);
		assert.equal(readPreferences().menuGate, "on", "choice written to disk");
		assert.equal(readPreferences().taglineReveal, "on", "untouched toggle keeps its value");
		assert.equal(wired.ctx.setHeaderCalls.length, 0, "header untouched — the gate is decided at startup");
		assert.ok(
			wired.ctx.notifications.some((n) => n.type === "info"),
			"user notified of success",
		);
	});

	it("toggling the tagline animation persists taglineReveal and leaves menuGate alone", async () => {
		const wired = wire();
		await applySettings(wired, ["taglineReveal", KEY.space]);
		const prefs = readPreferences();
		assert.equal(prefs.taglineReveal, "off", "choice written to disk");
		assert.equal(prefs.menuGate, "off", "gate preference untouched");
	});

	it("escape cancels without writing or notifying success", async () => {
		const wired = wire();
		const settings = await runSettings(wired);
		await settings.to("menuGate");
		await settings.press(KEY.space);
		await settings.cancel();
		await settings.handlerPromise;
		assert.equal(readPreferences().menuGate, "off", "preference untouched");
		assert.equal(existsSync(join(env.agentDir, "pi-topping-splash.json")), false, "no file written");
		assert.ok(!wired.ctx.notifications.some((n) => n.type === "info"), "no success notification");
	});

	it("keeps saved preferences intact when atomic replacement fails", () => {
		const savedPreferences = { menuGate: "off", taglineReveal: "on", backgroundColor: "success", gradientAnimation: "off", changesSummary: "off" } as const;
		assert.equal(writePreferences(savedPreferences), true);
		const path = join(env.agentDir, "pi-topping-splash.json");
		const savedContents = readFileSync(path, "utf8");
		const originalRenameSync = fs.renameSync;
		fs.renameSync = () => { throw new Error("simulated rename failure"); };
		syncBuiltinESMExports();
		try {
			assert.equal(writePreferences({ ...savedPreferences, menuGate: "on" }), false);
		} finally {
			fs.renameSync = originalRenameSync;
			syncBuiltinESMExports();
		}
		assert.equal(readFileSync(path, "utf8"), savedContents);
		assert.deepEqual(readdirSync(env.agentDir).filter((name) => name.startsWith("pi-topping-splash.json.") && name.endsWith(".tmp")), []);
	});

	it("a failing preference write notifies an error instead of success (I-06, I-07)", async () => {
		const wired = wire();
		const blocker = join(env.agentDir, "not-a-dir");
		writeFileSync(blocker, "occupied");
		const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", blocker);
		try {
			await applySettings(wired, ["menuGate", KEY.space]);
		} finally {
			restoreAgentDir();
		}
		assert.ok(wired.ctx.notifications.some((n) => n.type === "error"), "failure reported to the user");
		assert.ok(!wired.ctx.notifications.some((n) => n.type === "info"), "no false success notification");
		assert.equal(readPreferences().menuGate, "off", "preference unchanged after the failed write");
	});

	it("non-TUI mode notifies an error and shows no dialog", async () => {
		const wired = wire({ mode: "rpc" });
		await wired.pi.commands.get("topping-splash-settings")!.handler("", wired.ctx.ctx as never);
		assert.ok(wired.ctx.notifications.some((n) => n.type === "error"), "user notified TUI is required");
		assert.equal(wired.ctx.customComponents.length, 0, "no dialog shown");
		assert.equal(existsSync(join(env.agentDir, "pi-topping-splash.json")), false, "no file written");
	});
});

describe("startup changes settings (I-18)", () => {
	/** The overlay the dialog opens in; the summary-model picker takes its place inside it instead of opening a second one. */
	const SETTINGS_DIALOG_OPTIONS = {
		overlay: true,
		blocked: { kind: "question", message: "Pi Topping Splash: Settings" },
		overlayOptions: { width: SETTINGS_DIALOG_WIDTH, maxHeight: "100%" },
	};

	function seedPreferences(changesSummaryModel: SplashPreferences["changesSummaryModel"]): void {
		writePreferences({ menuGate: "on", taglineReveal: "on", backgroundColor: "rainbow", gradientAnimation: "off", changesSummary: "on", changesSummaryModel });
	}

	/** Open the Summary model picker; it takes the dialog's place. */
	async function openPicker(settings: SettingsRun): Promise<void> {
		await settings.to("changesSummaryModel");
		await settings.press(KEY.enter);
		assert.match(screen(settings.dialog), /PICK SUMMARY MODEL/);
	}

	/** Pick what is highlighted: Enter moves into the thinking pane, which is ignored for a summary, and Enter again picks. */
	const confirmPick = (settings: SettingsRun): Promise<void> => settings.press(KEY.enter, KEY.enter);

	it("opens in one overlay that reports the settings question as blocked, and the picker takes its place there", async () => {
		const wired = wire();
		const settings = await runSettings(wired);
		assert.deepEqual(wired.ctx.customOptions, [SETTINGS_DIALOG_OPTIONS]);
		assert.match(screen(settings.dialog), /PI TOPPING SPLASH: SETTINGS/);

		await openPicker(settings);
		assert.equal(wired.ctx.customComponents.length, 1, "no second overlay is opened for the picker");
		assert.deepEqual(wired.ctx.customOptions, [SETTINGS_DIALOG_OPTIONS], "so no second question is reported as blocked");
		assert.doesNotMatch(screen(settings.dialog), /Sections/, "the settings panes give way to it");

		await settings.press(KEY.esc);
		assert.match(screen(settings.dialog), /PI TOPPING SPLASH: SETTINGS/, "the same dialog comes back when the picker closes");
		await settings.cancel();
	});

	it("Enter on a toggle or cycle row does nothing; only the action bar or Ctrl+S applies", async () => {
		const wired = wire();
		let settled = false;
		const settings = await runSettings(wired);
		void settings.handlerPromise.then(() => {
			settled = true;
		});
		await settings.to("menuGate");
		await settings.press(KEY.space, KEY.enter);
		await settings.to("backgroundColor");
		await settings.press(KEY.enter);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(settled, false, "Enter on ordinary rows must not close the dialog");
		assert.equal(existsSync(join(env.agentDir, "pi-topping-splash.json")), false, "nothing written yet");
		await settings.press(KEY.tab, KEY.enter); // the action bar, then its Apply button
		await settings.handlerPromise;
		assert.equal(readPreferences().menuGate, "on", "the staged toggle survived the stray Enters");
	});

	it("Tab hands the arrow keys to the action bar, and Shift+Tab hands them back to the rows", async () => {
		const wired = wire();
		const settings = await runSettings(wired);
		await settings.to("backgroundColor");
		await settings.press(KEY.tab, KEY.right, KEY.left, KEY.shiftTab, KEY.right);
		await settings.apply();
		await settings.handlerPromise;
		assert.equal(readPreferences().backgroundColor, "accent", "only the arrow after Shift+Tab cycled the row");
	});

	it("the Cancel button closes without writing or notifying success", async () => {
		const wired = wire();
		const settings = await runSettings(wired);
		await settings.to("menuGate");
		await settings.press(KEY.tab, KEY.right, KEY.enter);
		await settings.handlerPromise;
		assert.equal(readPreferences().menuGate, "off");
		assert.equal(existsSync(join(env.agentDir, "pi-topping-splash.json")), false, "no file written");
		assert.ok(!wired.ctx.notifications.some((n) => n.type === "info"), "no success notification");
	});

	it("toggles the feature and persists a summary model picked from the list", async () => {
		writePreferences({ menuGate: "on", taglineReveal: "on", backgroundColor: "rainbow", gradientAnimation: "off", changesSummary: "off" });
		const wired = wire();
		wired.ctx.bag.models.push(makeModel("provider", "fast"));
		const settings = await runSettings(wired);
		await settings.to("changesSummary");
		await settings.press(KEY.space);
		await openPicker(settings);
		await settings.press("/", ..."fast", KEY.enter); // filter the list down to it, then leave the filter
		await confirmPick(settings);
		assert.match(screen(settings.dialog), /fast\s+›/, "the row names the pick");
		await settings.apply();
		await settings.handlerPromise;
		const prefs = readPreferences();
		assert.equal(prefs.changesSummary, "on");
		assert.deepEqual(prefs.changesSummaryModel, { provider: "provider", id: "fast" }, "the thinking pane's choice is never stored");
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
			const settings = await runSettings(wired);
			await openPicker(settings);
			await confirmPick(settings);
			await settings.apply();
			await settings.handlerPromise;
			assert.deepEqual(readPreferences().changesSummaryModel, testCase.expected, testCase.label);
		}
	});

	it("picker Escape keeps the prior value and dialog Escape writes nothing", async () => {
		seedPreferences({ provider: "provider", id: "fast" });
		const wired = wire();
		const settings = await runSettings(wired);
		await openPicker(settings);
		await settings.press(KEY.esc);
		assert.match(screen(settings.dialog), /fast\s+›/, "prior value still shown");
		await settings.cancel();
		assert.deepEqual(readPreferences().changesSummaryModel, { provider: "provider", id: "fast" });
	});

	it("Backspace resets the Summary model row to the session model", async () => {
		seedPreferences({ provider: "provider", id: "fast" });
		const wired = wire({ models: [makeModel("provider", "fast")] });
		const settings = await runSettings(wired);
		await settings.to("changesSummaryModel");
		assert.match(screen(settings.dialog), /fast\s+›/);
		await settings.press(KEY.backspace);
		assert.match(screen(settings.dialog), /session model\s+›/, "row reads as deliberately unset");
		await settings.apply();
		await settings.handlerPromise;
		assert.equal(readPreferences().changesSummaryModel, undefined);
	});

	it("a cleared Summary model stays cleared when the picker is then cancelled", async () => {
		seedPreferences({ provider: "provider", id: "fast" });
		const wired = wire({ models: [makeModel("provider", "fast")] });
		const settings = await runSettings(wired);
		await settings.to("changesSummaryModel");
		await settings.press(KEY.backspace, KEY.enter);
		assert.match(screen(settings.dialog), /PICK SUMMARY MODEL/);
		await settings.press(KEY.esc);
		assert.match(screen(settings.dialog), /session model\s+›/);
		await settings.apply();
		await settings.handlerPromise;
		assert.equal(readPreferences().changesSummaryModel, undefined, "the pinned ref must not outlive the clear");
	});

	it("Backspace and Delete leave rows without a clear value alone", async () => {
		const wired = wire();
		const settings = await runSettings(wired);
		await settings.to("menuGate");
		await settings.press(KEY.backspace, KEY.delete);
		await settings.to("backgroundColor");
		await settings.press(KEY.backspace, KEY.delete);
		await settings.apply();
		await settings.handlerPromise;
		const prefs = readPreferences();
		assert.equal(prefs.menuGate, "off");
		assert.equal(prefs.backgroundColor, "rainbow");
	});
});

describe("startup changes integration (AC2-AC8)", () => {
	function changesPreferences(options: { menuGate?: "on" | "off"; taglineReveal?: "on" | "off"; changesSummaryModel?: SplashPreferences["changesSummaryModel"] } = {}): void {
		const { menuGate = "off", taglineReveal = "off", changesSummaryModel } = options;
		writePreferences({
			menuGate,
			taglineReveal,
			backgroundColor: "rainbow",
			gradientAnimation: "off",
			logoStyle: "symbol",
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
		assert.ok(!header.render(100).map(sanitizeTuiText).join("\n").includes("[local changes]"));
	});

	it("a preference file without the changesSummary key collects and summarizes dirty changes", async () => {
		writeFileSync(
			join(env.agentDir, "pi-topping-splash.json"),
			JSON.stringify({ menuGate: "off", taglineReveal: "off", backgroundColor: "rainbow", gradientAnimation: "off" }),
			"utf8",
		);
		const wired = wire({
			projectTrusted: true,
			execHandler: scriptedGit(env.cwd, DIRTY_STATUS),
			streamSimple: async () => makeAssistantMessage("Upgrade default summary."),
		});
		await startup(wired);
		await until(() => state.changes?.summary.status === "done");
		assert.equal(wired.ctx.streamCalls.length, 1);
		assert.ok(mountedHeader(wired).render(100).map(sanitizeTuiText).join("\n").includes("[local changes]"));
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
			assert.ok(!first.map(sanitizeTuiText).join("\n").includes("[local changes]"), testCase.label);
		}
	});

	it("publishes dirty paths while the gate is open, then fills the same block", async () => {
		changesPreferences({ menuGate: "on", taglineReveal: "on" });
		const response = deferred<ReturnType<typeof makeAssistantMessage>>();
		const wired = wire({
			rows: 50,
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
		assert.ok(pendingText.includes("summarizing local changes with anthropic/claude-opus-4"), pendingText);
		response.resolve(makeAssistantMessage("The changes add, modify, and delete startup files."));
		await until(() => state.changes?.summary.status === "done");
		// The summary streams in: nothing of it is printed as it lands, all of it once the stream settles.
		assert.notEqual(summaryStream.timer, null, "the summary streams rather than landing whole");
		assert.equal(header.render(100).map(sanitizeTuiText).join("\n").includes("The changes add, modify"), false);
		stopSummaryStream();
		const doneText = header.render(100).map(sanitizeTuiText).join("\n");
		assert.ok(doneText.includes("The changes add, modify"), doneText);
		assert.equal((doneText.match(/\[local changes\]/g) ?? []).length, 1);
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
		numstat.resolve({ stdout: "3\t1\tchanged.ts\u00000\t2\tdeleted.ts\0", stderr: "", code: 0, killed: false, truncated: false });
		await until(() => (state.changes?.version ?? 0) > version);
		const after = header.render(100).map(sanitizeTuiText);
		assert.match(after.join("\n"), /~ changed\.ts .*▇.* \+3 -1 /);
		assert.match(after.join("\n"), /- deleted\.ts .*▇.* \+0 -2 /);
		assert.equal(after.length, before.length, "line counts never add rows");
		response.resolve(makeAssistantMessage("done"));
		await until(() => state.changes?.summary.status === "done");
	});

	it("closes the panel with a one-line preview when the rows under it cannot fit the listing", async () => {
		changesPreferences();
		const response = deferred<ReturnType<typeof makeAssistantMessage>>();
		const wired = wire({ projectTrusted: true, execHandler: scriptedGit(env.cwd, DIRTY_STATUS), streamSimple: async () => response.promise });
		await startup(wired);
		await waitForSummary(wired);
		const header = mountedHeader(wired);
		let previews = 0;
		let listings = 0;
		for (let rows = 15; rows <= 60; rows++) {
			wired.tui.resizeRows(rows);
			const model = wired.ctx.ctx.model;
			const bandRows = buildHeaderParts(100, rows, makeTheme(), state.loadedContext, state.loadedSkills, state.loadedExtensions,
				model ? { provider: model.provider, id: model.id } : undefined, state.systemPromptSize,
				state.backgroundColor, state.gradientAnimation, 0, state.loadedPrompts, state.loadedShortcuts).lines.length;
			const rendered = header.render(100).map(sanitizeTuiText);
			assert.equal(state.splashRows, rendered.length, `terminal rows ${rows}`);
			// The section spends only rows the editor leaves free, or rows beside a taller logo.
			assert.ok(rendered.length <= Math.max(bandRows, rows - EDITOR_RESERVED_ROWS), `terminal rows ${rows}: ${rendered.length} rows`);
			const headings = rendered.filter((line) => line.includes("[local changes]"));
			if (headings.length === 0) continue;
			assert.equal(headings.length, 1, `terminal rows ${rows}`);
			if (!headings[0].includes(" · ")) {
				listings++;
				assert.match(headings[0], /\[local changes\] \+1, ~1, -1 +▀/, `terminal rows ${rows}: a listing heading carries no preview`);
			} else {
				previews++;
				assert.match(headings[0], /\[local changes\] \+1, ~1, -1 · ~ changed\.ts \+1 -1 · summa/, `terminal rows ${rows}`);
			}
		}
		assert.ok(previews > 0, "the sweep must reach a budget too short for the listing");
		assert.ok(listings > 0, "the sweep must reach a budget that fits it");
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
			changesPreferences({ changesSummaryModel: testCase.configured });
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
			assert.equal((text.match(/\[local changes\]/g) ?? []).length, 1);
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
		// Empty responses other than token-limit truncations are retried; other failures cost one request.
		const cases: { label: string; streamSimple: SummaryResponder; expected?: string }[] = [
			{ label: "rejection", streamSimple: async () => { throw new Error("provider exploded"); } },
			{ label: "error stop", streamSimple: async () => makeAssistantMessage("", "error", "provider refused") },
			{ label: "aborted stop", streamSimple: async () => makeAssistantMessage("", "aborted") },
			{ label: "token limit", streamSimple: async () => makeAssistantMessage("", "length"), expected: "summary unavailable: token limit reached" },
		];
		for (const [index, testCase] of cases.entries()) {
			if (index > 0) resetModuleState();
			changesPreferences();
			const wired = wire({ projectTrusted: true, execHandler: scriptedGit(env.cwd, DIRTY_STATUS), streamSimple: testCase.streamSimple });
			await startup(wired);
			await until(() => state.changes?.summary.status === "failed");
			const text = mountedHeader(wired).render(100).map(sanitizeTuiText).join("\n");
			assert.ok(text.includes("[local changes] +1, ~1, -1"), testCase.label);
			assert.ok(text.includes(testCase.expected ?? "summary unavailable:"), testCase.label);
			assert.equal(wired.ctx.streamCalls.length, 1, testCase.label);
		}
	});

	it("retries an empty summary and lands the answer a later attempt gives (CS-07)", async () => {
		changesPreferences();
		const responses = Array.from({ length: 4 }, () => deferred<ReturnType<typeof makeAssistantMessage>>());
		const wired = wire({
			projectTrusted: true,
			execHandler: scriptedGit(env.cwd, DIRTY_STATUS),
			streamSimple: async () => responses[wired.ctx.streamCalls.length - 1]!.promise,
		});
		await startup(wired);
		await until(() => wired.ctx.streamCalls.length === 1);
		assert.ok(state.changes);
		const version = state.changes.version;
		responses[0]!.resolve(makeAssistantMessage(""));
		await until(() => wired.ctx.streamCalls.length === 2);
		assert.equal(state.changes?.summary.status, "pending");
		assert.equal(state.changes?.version, version);
		responses[1]!.resolve(makeAssistantMessage(""));
		await until(() => wired.ctx.streamCalls.length === 3);
		responses[2]!.resolve(makeAssistantMessage(""));
		await until(() => wired.ctx.streamCalls.length === 4);
		responses[3]!.resolve(makeAssistantMessage("Recovered summary."));
		await until(() => state.changes?.summary.status === "done");
		assert.equal(wired.ctx.streamCalls.length, 4);
		assert.deepEqual(state.changes?.summary, { status: "done", text: "Recovered summary." });
		const text = mountedHeader(wired).render(100).map(sanitizeTuiText).join("\n");
		assert.ok(text.includes("[local changes] +1, ~1, -1"));
		assert.ok(!text.includes("summary unavailable:"), text);
	});

	it("gives up on an empty summary after three retries (CS-07)", async () => {
		changesPreferences();
		const wired = wire({ projectTrusted: true, execHandler: scriptedGit(env.cwd, DIRTY_STATUS), streamSimple: async () => makeAssistantMessage("") });
		await startup(wired);
		await until(() => state.changes?.summary.status === "failed");
		assert.equal(wired.ctx.streamCalls.length, 4);
		assert.deepEqual(state.changes?.summary, { status: "failed", reason: "empty response" });
		const text = mountedHeader(wired).render(100).map(sanitizeTuiText).join("\n");
		assert.ok(text.includes("[local changes] +1, ~1, -1"));
		assert.ok(text.includes("summary unavailable: empty response"));
	});

	it("sends the session id so OpenCode providers accept the request", async () => {
		const model = makeModel("opencode-go", "model");
		const harness = createFakeCtx({
			cwd: env.cwd,
			theme: makeTheme(),
			tui: createFakeTui().tui,
			model,
			models: [model],
			streamSimple: async () => makeAssistantMessage("Summary."),
		});
		await summarizeChanges(harness.ctx, model, { systemPrompt: "system", text: "text" }, new AbortController().signal);
		assert.equal(harness.streamCalls[0]?.options?.sessionId, FAKE_SESSION_ID);
	});

	it("stops retrying an empty summary once the run is aborted (CS-07)", async () => {
		const model = makeModel("provider", "model");
		const controller = new AbortController();
		const harness = createFakeCtx({
			cwd: env.cwd,
			theme: makeTheme(),
			tui: createFakeTui().tui,
			model,
			models: [model],
			// The first retry aborts the run, the way session shutdown does mid-chain.
			streamSimple: async () => {
				if (harness.streamCalls.length > 1) controller.abort();
				return makeAssistantMessage("");
			},
		});
		const aborted = await summarizeChanges(harness.ctx, model, { systemPrompt: "system", text: "text" }, controller.signal);
		assert.deepEqual(aborted, { status: "failed", reason: "cancelled" });
		assert.equal(harness.streamCalls.length, 2);
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

	it("prints a landed summary whole when the reveal animation is off", async () => {
		changesPreferences();
		const text = "A summary that lands whole with the reveal animation off.";
		const wired = wire({ projectTrusted: true, execHandler: scriptedGit(env.cwd, DIRTY_STATUS), streamSimple: async () => makeAssistantMessage(text) });
		await startup(wired);
		await until(() => state.changes?.summary.status === "done");
		assert.equal(summaryStream.timer, null, "no stream starts");
		assert.ok(mountedHeader(wired).render(100).map(sanitizeTuiText).join("\n").includes("A summary that lands whole"));
	});

	it("settles a streaming summary at the first agent turn and on session shutdown", async () => {
		changesPreferences({ taglineReveal: "on" });
		const text = "A summary long enough to still be streaming when the first prompt goes out.";
		const wired = wire({ projectTrusted: true, execHandler: scriptedGit(env.cwd, DIRTY_STATUS), streamSimple: async () => makeAssistantMessage(text) });
		await startup(wired);
		await until(() => state.changes?.summary.status === "done");
		assert.notEqual(summaryStream.timer, null, "the landed summary is streaming");
		await wired.pi.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "x" }, wired.ctx.ctx);
		assert.equal(summaryStream.timer, null, "the first agent turn stops the ticker");
		assert.ok(mountedHeader(wired).render(100).map(sanitizeTuiText).join("\n").includes("A summary long enough"), "and prints the whole text");
		startSummaryStream(text);
		await wired.pi.emit("session_shutdown", { type: "session_shutdown" }, wired.ctx.ctx);
		assert.equal(summaryStream.timer, null, "shutdown stops the ticker");
	});

	it("does not stream a summary that lands after the first agent turn", async () => {
		changesPreferences({ taglineReveal: "on" });
		const response = deferred<ReturnType<typeof makeAssistantMessage>>();
		const text = "Late response lands whole.";
		const wired = wire({
			projectTrusted: true,
			execHandler: scriptedGit(env.cwd, DIRTY_STATUS),
			streamSimple: async () => response.promise,
		});
		await startup(wired);
		await waitForSummary(wired);
		await wired.pi.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "x" }, wired.ctx.ctx);
		response.resolve(makeAssistantMessage(text));
		await until(() => state.changes?.summary.status === "done");
		assert.equal(summaryStream.timer, null, "the late summary does not restart the ticker");
		assert.ok(mountedHeader(wired).render(100).map(sanitizeTuiText).join("\n").includes(text));
	});

	it("keeps the changes-only header after gate proceed", async () => {
		changesPreferences({ menuGate: "on", taglineReveal: "on" });
		const response = deferred<ReturnType<typeof makeAssistantMessage>>();
		const wired = wire({ projectTrusted: true, execHandler: scriptedGit(env.cwd, DIRTY_STATUS), streamSimple: async () => response.promise });
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		await waitForSummary(wired);
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput(KEY.esc);
		await emitted;
		assert.equal(wired.ctx.setHeaderCalls.length, 2);
		const slim = mountedHeader(wired, 1);
		const full = slim.render(100).map(sanitizeTuiText);
		assert.equal(full[1].trimEnd(), "   [local changes] +1, ~1, -1");
		assert.equal(full.findIndex((line) => line.trimStart().startsWith("summarizing local changes with")), full.findIndex((line) => line.includes("- deleted.ts")) + 2, "the summary sits a blank row under the last file row");
		wired.tui.resizeRows(EDITOR_RESERVED_ROWS + 2);
		const compact = slim.render(100).map(sanitizeTuiText);
		assert.equal(compact.length, 2);
		assert.equal(compact[0].trim(), "");
		assert.match(compact[1], /^ {3}\[local changes\] \+1, ~1, -1 · ~ changed\.ts/);
		wired.tui.resizeRows(40);
		assert.equal(headerRenderState.requestRender, null, "slim header must not masquerade as splash wiring");
		response.resolve(makeAssistantMessage("post-gate summary"));
		await until(() => state.changes?.summary.status === "done");
		// The slim header streams the summary too, and prints all of it once the real ticker finishes.
		assert.notEqual(summaryStream.timer, null);
		await until(() => summaryStream.timer === null);
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

	it("defaults to off (splash-only) with no preference file written yet", () => {
		assert.equal(readPreferences().menuGate, "off");
		assert.equal(existsSync(join(env.agentDir, "pi-topping-splash.json")), false);
	});

	it("a fresh TUI startup with no preference file keeps the splash and mounts no gate", async () => {
		const wired = wire();
		await startup(wired);
		assert.equal(wired.ctx.setHeaderCalls.length, 1, "splash installed");
		assert.equal(wired.ctx.customComponents.length, 0, "no gate");
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

	it("a corrupt preference file falls back to splash-only instead of throwing", async () => {
		writeFileSync(join(env.agentDir, "pi-topping-splash.json"), "{not json", "utf8");
		assert.equal(readPreferences().menuGate, "off");
		const wired = wire();
		await startup(wired);
		assert.equal(wired.ctx.setHeaderCalls.length, 1, "splash still installed");
		assert.equal(wired.ctx.customComponents.length, 0, "no gate");
	});
});

describe("changesSummary default (I-14)", () => {
	it("defaults to on with no preference file", () => {
		assert.equal(readPreferences().changesSummary, "on");
		assert.equal(existsSync(join(env.agentDir, "pi-topping-splash.json")), false);
	});

	it("defaults to on for a keyless preference file", () => {
		writeFileSync(
			join(env.agentDir, "pi-topping-splash.json"),
			JSON.stringify({ menuGate: "on", taglineReveal: "on", backgroundColor: "rainbow", gradientAnimation: "off" }),
			"utf8",
		);
		assert.equal(readPreferences().changesSummary, "on");
	});

	it("defaults to on for corrupt and unrecognized values", () => {
		writeFileSync(join(env.agentDir, "pi-topping-splash.json"), "{not json", "utf8");
		assert.equal(readPreferences().changesSummary, "on", "corrupt file");
		writeFileSync(join(env.agentDir, "pi-topping-splash.json"), JSON.stringify({ changesSummary: "yes" }), "utf8");
		assert.equal(readPreferences().changesSummary, "on", "unrecognized value");
	});

	it("honors an explicit off value", () => {
		writePreferences({ menuGate: "on", taglineReveal: "on", backgroundColor: "rainbow", gradientAnimation: "off", changesSummary: "off" });
		assert.equal(readPreferences().changesSummary, "off");
	});
});

describe("tagline reveal preference (I-15)", () => {
	it("defaults to on: startup starts the reveal", async () => {
		const wired = wire();
		await startup(wired);
		await until(() => wired.ctx.setHeaderCalls.length > 0);
		assert.notEqual(taglineReveal.timer, null, "reveal ticker running");
	});

	it("taglineReveal:off installs the splash without ever starting the reveal", async () => {
		await persist({ taglineReveal: "off" });
		const wired = wire();
		await startup(wired);
		assert.ok(wired.ctx.setHeaderCalls.length >= 1, "splash still installed");
		assert.equal(taglineReveal.timer, null, "reveal never started");
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
		await applySettings(wired, ["backgroundColor", KEY.right]);
		assert.equal(readPreferences().backgroundColor, "accent", "cycled one step right");
	});

	it("left from rainbow wraps to dynamic and keeps the default tint", async () => {
		const wired = wire();
		await applySettings(wired, ["backgroundColor", KEY.left]);
		assert.equal(readPreferences().backgroundColor, "dynamic");
		assert.equal(readPreferences().dynamicTint, "accent");
		assert.equal(state.dynamicTint, "accent");
	});

	it("records an applied theme color and preserves it while selecting dynamic", async () => {
		const first = wire();
		await applySettings(first, ["backgroundColor", ...Array.from({ length: 5 }, () => KEY.right)]);
		assert.equal(readPreferences().backgroundColor, "success");
		assert.equal(readPreferences().dynamicTint, "success");

		resetModuleState();
		const second = wire();
		await applySettings(second, ["backgroundColor", ...Array.from({ length: 3 }, () => KEY.right)]);
		assert.equal(readPreferences().backgroundColor, "dynamic");
		assert.equal(readPreferences().dynamicTint, "success");
		assert.equal(state.dynamicTint, "success");
	});

	it("resolves the dynamic tint from the background, then the stored key, then accent", () => {
		const cases = [
			{ preferences: { backgroundColor: "warning" }, expected: "warning" },
			{ preferences: { backgroundColor: "dynamic" }, expected: "accent" },
			{ preferences: { backgroundColor: "dynamic", dynamicTint: "error" }, expected: "error" },
			{ preferences: { backgroundColor: "rainbow", dynamicTint: "rainbow" }, expected: "accent" },
			{ preferences: { backgroundColor: "success", dynamicTint: "error" }, expected: "success" },
		] as const;
		for (const { preferences, expected } of cases) {
			writeFileSync(join(env.agentDir, "pi-topping-splash.json"), JSON.stringify(preferences), "utf8");
			assert.equal(readPreferences().dynamicTint, expected, JSON.stringify(preferences));
		}
	});

	it("persists all three preferences atomically and leaves untouched toggles as-is", async () => {
		const wired = wire();
		await applySettings(wired, ["backgroundColor", KEY.right, KEY.right]);
		const prefs = readPreferences();
		assert.equal(prefs.backgroundColor, "border");
		assert.equal(prefs.menuGate, "off", "untouched toggle keeps its value");
		assert.equal(prefs.taglineReveal, "on", "untouched toggle keeps its value");
		assert.equal(prefs.changesSummary, "on", "untouched summary toggle keeps its default");
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
		await applySettings(wired0, ["backgroundColor", ...Array.from({ length: 5 }, () => KEY.right)]);
		assert.equal(readPreferences().backgroundColor, "success");
		resetModuleState();
		const wired = wire();
		const settings = await runSettings(wired);
		await settings.to("backgroundColor");
		await settings.press(KEY.right);
		await settings.cancel();
		await settings.handlerPromise;
		assert.equal(readPreferences().backgroundColor, "success", "unchanged after cancel");
		assert.equal(state.backgroundColor, "rainbow", "shared state untouched by a cancelled menu");
	});

	it("a failed write leaves state.backgroundColor and the persisted value unchanged", async () => {
		const wired = wire();
		const blocker = join(env.agentDir, "not-a-dir");
		writeFileSync(blocker, "occupied");
		const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", blocker);
		try {
			await applySettings(wired, ["backgroundColor", KEY.right]);
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
		await applySettings(wired, ["backgroundColor", KEY.right]);
		assert.equal(state.backgroundColor, "accent");
		assert.ok(wired.tui.renderRequests.length > before, "a render must be requested after applying");
	});
});

describe("gradient animation setting (I-17)", () => {
	it("defaults to off; cycling right persists breathe and leaves the rest alone", async () => {
		const wired = wire();
		assert.equal(readPreferences().gradientAnimation, "off", "starts at the default");
		await applySettings(wired, ["gradientAnimation", KEY.right]);
		const prefs = readPreferences();
		assert.equal(prefs.gradientAnimation, "breathe", "cycled one step right");
		assert.equal(prefs.backgroundColor, "rainbow", "untouched cycle keeps its value");
		assert.equal(prefs.menuGate, "off", "untouched toggle keeps its value");
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

		await applySettings(wired, ["backgroundColor", KEY.right], ["gradientAnimation", KEY.right]);
		assert.equal(state.backgroundColor, "accent");
		assert.equal(state.gradientAnimation, "breathe");
		assert.notEqual(gradientAnimation.timer, null, "ticker running on an animated backdrop");

		await applySettings(wired, ["gradientAnimation", KEY.left]);
		assert.equal(state.gradientAnimation, "off");
		assert.equal(gradientAnimation.timer, null, "ticker stopped once the animation is off");
	});

	it("applying an animation while the background stays rainbow also starts the ticker", async () => {
		await persist({ menuGate: "off" });
		const wired = wire();
		await startup(wired);
		const factory = wired.ctx.setHeaderCalls.at(-1) as (tui: unknown, theme: unknown) => unknown;
		factory(wired.tui.tui, makeTheme());

		await applySettings(wired, ["gradientAnimation", KEY.right]);
		assert.equal(state.backgroundColor, "rainbow", "background untouched");
		assert.equal(state.gradientAnimation, "breathe");
		assert.notEqual(gradientAnimation.timer, null, "the rainbow animates too");
	});

	it("applying an animation with no splash header wired leaves the ticker off", async () => {
		const wired = wire();
		await applySettings(wired, ["backgroundColor", KEY.right], ["gradientAnimation", KEY.right]);
		assert.equal(readPreferences().gradientAnimation, "breathe", "persisted for the next launch");
		assert.equal(gradientAnimation.timer, null, "nothing visible to animate");
	});

	it("the first agent turn stops the ticker; a later apply persists but cannot restart it", async () => {
		writePreferences({ menuGate: "off", taglineReveal: "on", backgroundColor: "accent", gradientAnimation: "flow", logoStyle: "symbol", changesSummary: "off" });
		const wired = wire();
		await startup(wired);
		const factory = wired.ctx.setHeaderCalls.at(-1) as (tui: unknown, theme: unknown) => unknown;
		factory(wired.tui.tui, makeTheme());
		assert.notEqual(gradientAnimation.timer, null, "ticker running in splash-only mode");

		await wired.pi.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "x" }, wired.ctx.ctx);
		assert.equal(gradientAnimation.timer, null, "first turn stopped the ticker");

		await applySettings(wired, ["gradientAnimation", KEY.right]);
		assert.equal(readPreferences().gradientAnimation, "sheen", "preference still persisted");
		assert.equal(gradientAnimation.timer, null, "mid-session apply must not restart an off-screen animation");
	});

	it("startup with an animated preference runs the ticker; the gate's proceed teardown stops it", async () => {
		writePreferences({ menuGate: "on", taglineReveal: "on", backgroundColor: "accent", gradientAnimation: "flow", logoStyle: "symbol", changesSummary: "off" });
		const wired = wire();
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		assert.notEqual(gradientAnimation.timer, null, "ticker running during the gate");
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("\x1b");
		await emitted;
		assert.equal(gradientAnimation.timer, null, "teardown stopped the ticker");
	});

	it("session shutdown stops both splash animations before the first turn", async () => {
		writePreferences({ menuGate: "off", taglineReveal: "on", backgroundColor: "accent", gradientAnimation: "flow", logoStyle: "symbol", changesSummary: "off" });
		const wired = wire();
		await startup(wired);
		assert.notEqual(gradientAnimation.timer, null, "gradient ticker running");
		assert.notEqual(taglineReveal.timer, null, "tagline ticker running");

		await wired.pi.emit("session_shutdown", { type: "session_shutdown" }, wired.ctx.ctx);
		assert.equal(gradientAnimation.timer, null, "shutdown stopped the gradient ticker");
		assert.equal(taglineReveal.timer, null, "shutdown stopped the tagline ticker");
		assert.equal(logoAnimation.timer, null, "shutdown stopped the logo ticker");
	});
});

describe("logo style setting (I-20)", () => {
	const applyLogoSetting = (wired: Wired, direction: string): Promise<void> => applySettings(wired, ["logoStyle", direction]);

	it("defaults missing and invalid logo styles to random", () => {
		assert.equal(readPreferences().logoStyle, "random");
		writeFileSync(join(env.agentDir, "pi-topping-splash.json"), JSON.stringify({ logoStyle: "animated" }), "utf8");
		assert.equal(readPreferences().logoStyle, "random");
		writeFileSync(join(env.agentDir, "pi-topping-splash.json"), JSON.stringify({ logoStyle: "logo" }), "utf8");
		assert.equal(readPreferences().logoStyle, "logo");
	});

	it("adds the final Splash Banner cycle row and persists it with the other settings", async () => {
		const wired = wire();
		assert.equal(readPreferences().logoStyle, "random");
		await applyLogoSetting(wired, KEY.right);
		assert.equal(readPreferences().logoStyle, "symbol");
		assert.equal(state.logoStyle, "symbol");
		assert.equal(logoAnimation.timer, null, "a saved preference does not animate without a visible header");
	});

	it("previews a changed installer style on a visible splash, does not replay on unrelated apply, and stops on glyph", async (t) => {
		enableTimers(t);
		const restoreTerm = setEnv("TERM", "xterm-256color");
		const restoreTermProgram = setEnv("TERM_PROGRAM", undefined);
		try {
			writePreferences({ menuGate: "off", taglineReveal: "on", backgroundColor: "rainbow", gradientAnimation: "off", logoStyle: "symbol", changesSummary: "off" });
			const wired = wire();
			await startup(wired);
			const factory = wired.ctx.setHeaderCalls.at(-1) as (tui: unknown, theme: unknown) => unknown;
			const header = factory(wired.tui.tui, makeTheme()) as { render(width: number): string[] };
			assert.equal(state.logoStyle, "symbol");
			await applyLogoSetting(wired, KEY.right);
			assert.equal(state.logoStyle, "logo");
			assert.notEqual(logoAnimation.timer, null, "changed installer choice previews immediately");
			assert.equal(logoAnimation.frame, 0);
			assert.ok(header.render(100).some((line) => line.includes("38;2;77;154;191")));
			const timer = logoAnimation.timer;
			logoAnimation.timeMs = 400;
			await applySettings(wired, ["backgroundColor", KEY.right]);
			assert.equal(logoAnimation.timer, timer, "unrelated settings keep the running clock");
			assert.equal(logoAnimation.timeMs, 400, "unrelated apply does not replay the one-shot");
			await applyLogoSetting(wired, KEY.left);
			assert.equal(state.logoStyle, "symbol");
			assert.equal(logoAnimation.timer, null, "switching away stops the clock");
			assert.equal(logoAnimation.frame, INSTALLER_LOGO_LAST_FRAME);
		} finally {
			restoreTermProgram();
			restoreTerm();
		}
	});

	it("keeps random installer playback running when unrelated settings are applied", async (t) => {
		enableTimers(t);
		const restoreTerm = setEnv("TERM", "xterm-256color");
		const restoreTermProgram = setEnv("TERM_PROGRAM", undefined);
		const random = Math.random;
		Math.random = () => 0.9;
		try {
			writePreferences({ menuGate: "off", taglineReveal: "on", backgroundColor: "rainbow", gradientAnimation: "off", logoStyle: "random", changesSummary: "off" });
			const wired = wire();
			await startup(wired);
			const factory = wired.ctx.setHeaderCalls.at(-1) as (tui: unknown, theme: unknown) => unknown;
			const header = factory(wired.tui.tui, makeTheme()) as { render(width: number): string[] };
			header.render(100);
			assert.equal(state.logoStyle, "random");
			const timer = logoAnimation.timer;
			assert.notEqual(timer, null, "random selection resolves to an installer logo");
			logoAnimation.timeMs = 400;

			await applySettings(wired, ["backgroundColor", KEY.right]);
			assert.equal(logoAnimation.timer, timer, "unrelated settings preserve the active ticker");
			assert.equal(logoAnimation.timeMs, 400, "unrelated apply does not restart playback");
		} finally {
			Math.random = random;
			restoreTermProgram();
			restoreTerm();
		}
	});

	it("a failed preference write leaves logo state and ticker untouched", async () => {
		const wired = wire();
		const blocker = join(env.agentDir, "not-a-dir");
		writeFileSync(blocker, "occupied");
		const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", blocker);
		try {
			await applyLogoSetting(wired, KEY.right);
		} finally {
			restoreAgentDir();
		}
		assert.equal(state.logoStyle, "random");
		assert.equal(logoAnimation.timer, null);
		assert.ok(wired.ctx.notifications.some((notification) => notification.type === "error"));
	});

	it("cancellation and a post-conversation apply do not start the ticker", async () => {
		const wired = wire();
		const settings = await runSettings(wired);
		await settings.to("logoStyle");
		await settings.press(KEY.right);
		await settings.cancel();
		await settings.handlerPromise;
		assert.equal(readPreferences().logoStyle, "random");
		assert.equal(state.logoStyle, "random");
		assert.equal(logoAnimation.timer, null);

		const wiredAfterTurn = wire();
		await startup(wiredAfterTurn);
		const factory = wiredAfterTurn.ctx.setHeaderCalls.at(-1) as (tui: unknown, theme: unknown) => unknown;
		factory(wiredAfterTurn.tui.tui, makeTheme());
		state.conversationStarted = true;
		await applyLogoSetting(wiredAfterTurn, KEY.left);
		assert.equal(readPreferences().logoStyle, "logo", "preference still saves");
		assert.equal(logoAnimation.timer, null, "off-screen splash is not started");
	});

	it("stops the logo clock on shutdown, first turn, gate bypass, and gate proceed", async () => {
		const configure = () => writePreferences({ menuGate: "off", taglineReveal: "off", backgroundColor: "rainbow", gradientAnimation: "off", logoStyle: "logo", changesSummary: "off" });
		configure();
		const shutdown = wire();
		await startup(shutdown);
		mountedHeader(shutdown).render(100);
		assert.notEqual(logoAnimation.timer, null);
		await shutdown.pi.emit("session_shutdown", { type: "session_shutdown" }, shutdown.ctx.ctx);
		assert.equal(logoAnimation.timer, null);

		resetModuleState();
		configure();
		const firstTurn = wire();
		await startup(firstTurn);
		mountedHeader(firstTurn).render(100);
		assert.notEqual(logoAnimation.timer, null);
		await firstTurn.pi.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "x" }, firstTurn.ctx.ctx);
		assert.equal(logoAnimation.timer, null);

		resetModuleState();
		startLogoAnimation();
		restoreGateEnv();
		restoreGateEnv = setEnv("PI_SPLASH_GATE_DONE", "1");
		const bypass = wire();
		await startup(bypass);
		assert.equal(logoAnimation.timer, null, "non-gated path stops any stray logo clock");

		restoreGateEnv();
		resetModuleState();
		writePreferences({ menuGate: "on", taglineReveal: "off", backgroundColor: "rainbow", gradientAnimation: "off", logoStyle: "logo", changesSummary: "off" });
		const gated = wire();
		const emitted = startup(gated);
		await until(() => gated.ctx.customComponents.length > 0);
		mountedHeader(gated).render(100);
		assert.notEqual(logoAnimation.timer, null);
		(gated.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput(KEY.esc);
		await emitted;
		assert.equal(logoAnimation.timer, null, "gate proceed tears down the splash clock");
	});
});
