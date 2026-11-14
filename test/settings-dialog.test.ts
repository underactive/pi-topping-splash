import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";
import { mountOpenTui } from "@underactive/pi-topping-opentui/host";
import { MOCKUP_PALETTE } from "@underactive/pi-topping-opentui/theme";
import { MenuComponent } from "@underactive/pi-topping-primitives/menu";
import { createElement, type ReactNode } from "react";
import { BACKGROUND_COLOR_OPTIONS, GRADIENT_ANIMATION_OPTIONS } from "../src/color.ts";
import { LOGO_STYLE_OPTIONS } from "../src/logo.ts";
import { readPreferences, writePreferences, type SplashPreferences } from "../src/preferences.ts";
import { showSplashSettings } from "../src/settings.ts";
import { state } from "../src/state.ts";
import { dialogFits, DIALOG_MAX_HEIGHT, MIN_SIZE_PROBE_HOST_VERSION, readTerminalSize, SETTINGS_DIALOG_SIZE, type TerminalSize } from "../src/ui/dialog-fit.ts";
import { BACKGROUND_COLORS, GRADIENT_ANIMATIONS, LOGO_STYLES, PREFS_DEFAULTS } from "../src/ui/generated/splash/data.ts";
import { SplashSettings } from "../src/ui/generated/splash/settings-dialog.ts";
import { fromDialogPrefs, SETTINGS_DIALOG_TITLE, toDialogModels, toDialogPrefs } from "../src/ui/settings-dialog.ts";
import { setArgv, tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { createFakeCtx, makeModel, type FakeCtxHarness } from "./helpers/fake-ctx.ts";
import { createFakeTui } from "./helpers/fake-tui.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { bootstrapGlobalTheme, makeTheme } from "./helpers/theme.ts";
import { until } from "./helpers/wait.ts";

bootstrapGlobalTheme();

let env: TempAgentEnv;
let restoreArgv: () => void;
beforeEach(() => {
	env = tempAgentDir();
	restoreArgv = setArgv([], "");
	resetModuleState();
});
afterEach(() => {
	restoreArgv();
	env.restore();
});

/** The bytes pi-tui hands a component for each key. */
const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	esc: "\x1b",
	space: " ",
	tab: "\t",
	backspace: "\x7f",
	ctrlS: "\x13",
} as const;

interface Shown {
	render(width: number): string[];
	handleInput?(data: string): void;
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const screen = (component: Shown, width = SETTINGS_DIALOG_SIZE.columns): string => component.render(width).map(stripAnsi).join("\n");

/** A key handler only sets state and React commits a moment later: wait until the frame holds still. */
async function settle(component: Shown): Promise<void> {
	let previous = component.render(SETTINGS_DIALOG_SIZE.columns).join("\n");
	for (let quiet = 0; quiet < 2;) {
		await turn();
		const current = component.render(SETTINGS_DIALOG_SIZE.columns).join("\n");
		quiet = current === previous ? quiet + 1 : 0;
		previous = current;
	}
}

async function press(component: Shown, ...keys: string[]): Promise<void> {
	for (const key of keys) {
		component.handleInput?.(key);
		await settle(component);
	}
}

const CLAUDE = makeModel("anthropic", "claude-opus-4");
const GPT = makeModel("openai", "gpt-4o");

interface Session {
	ctx: FakeCtxHarness;
	/** The command's own promise. */
	done: Promise<void>;
}

const ROOMY: TerminalSize = { columns: 120, rows: 40 };

function makeCtx(terminal: TerminalSize = ROOMY): FakeCtxHarness {
	const tui = createFakeTui({ rows: terminal.rows, columns: terminal.columns });
	return createFakeCtx({ cwd: env.cwd, theme: makeTheme(), tui: tui.tui, models: [CLAUDE, GPT], model: CLAUDE });
}

/** Run `/topping-splash-settings` on `ctx` and wait for its dialog to be on screen. */
async function openSettings(ctx: FakeCtxHarness): Promise<Session & { dialog: Shown }> {
	const done = showSplashSettings(ctx.ctx);
	await until(() => ctx.customComponents.length > 0);
	assert.ok(ctx.customComponents.length > 0, "a dialog is shown");
	const dialog = ctx.customComponents.at(-1) as Shown;
	await settle(dialog);
	return { ctx, done, dialog };
}

/** Fails the test when anything reaches the console: under pi it would land in the middle of the screen. */
function watchConsole(t: TestContext): () => void {
	const error = t.mock.method(console, "error", () => {});
	const warn = t.mock.method(console, "warn", () => {});
	const log = t.mock.method(console, "log", () => {});
	return () => {
		assert.deepEqual(error.mock.calls.map((call) => call.arguments), [], "console.error");
		assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [], "console.warn");
		assert.deepEqual(log.mock.calls.map((call) => call.arguments), [], "console.log");
	};
}

const PINNED = { provider: "openai", id: "gpt-4o" };

function storedPreferences(): SplashPreferences {
	return readPreferences();
}

describe("the dialog's data matches the extension's", () => {
	it("offers the same background colors, gradient animations and logo styles, in the same order", () => {
		assert.deepEqual([...BACKGROUND_COLORS], [...BACKGROUND_COLOR_OPTIONS]);
		assert.deepEqual([...GRADIENT_ANIMATIONS], [...GRADIENT_ANIMATION_OPTIONS]);
		assert.deepEqual([...LOGO_STYLES], [...LOGO_STYLE_OPTIONS]);
	});

	it("starts from the extension's defaults", () => {
		assert.deepEqual(toDialogPrefs(readPreferences()), PREFS_DEFAULTS);
	});

	it("has a row for every setting the menu has, under the same label", async () => {
		const titles = ["Startup Gate", "Splash Banner", "Info Panel"];
		const labels = ["Startup gate menu", "Background color", "Animate gradient", "Logo style", "Model + prompt size reveal animation", "Summarize uncommitted changes", "Summary model"];

		// What the showMenu fallback offers, read from the menu itself on a terminal too small for the dialog.
		const { dialog: menu, done } = await openSettings(makeCtx({ columns: 80, rows: 24 }));
		const menuText = screen(menu, 90);
		await press(menu, KEY.esc);
		await done;
		for (const text of [...titles, ...labels]) assert.ok(menuText.includes(text), `the menu has "${text}"`);

		// Each section on its own mount: the sidebar lists the titles, the pane the rows.
		const seen: string[] = [];
		for (let section = 0; section < titles.length; section++) {
			const mounted = mountOpenTui(createElement(SplashSettings, { initial: PREFS_DEFAULTS, onDone: () => {} }), {
				width: 120, height: 60, theme: MOCKUP_PALETTE, fitContent: true,
			});
			try {
				for (let i = 0; i < section; i++) {
					mounted.input(KEY.down);
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				seen.push(mounted.charFrame());
			} finally {
				mounted.unmount();
			}
		}
		const text = seen.join("\n");
		for (const title of titles) assert.ok(text.includes(title), `the dialog has the section "${title}"`);
		for (const label of labels) assert.ok(text.includes(label), `the dialog has a row labelled "${label}"`);
	});
});

describe("the adapter", () => {
	const prefs: SplashPreferences = {
		menuGate: "on",
		taglineReveal: "off",
		backgroundColor: "success",
		dynamicTint: "success",
		gradientAnimation: "wave",
		logoStyle: "symbol",
		changesSummary: "off",
		changesSummaryModel: PINNED,
	};

	it("turns the extension's preferences into the dialog's values and back", () => {
		const dialog = toDialogPrefs(prefs);
		assert.deepEqual(dialog, {
			menuGate: true,
			taglineReveal: false,
			backgroundColor: "success",
			gradientAnimation: "wave",
			logoStyle: "symbol",
			changesSummary: false,
			changesSummaryModel: "openai/gpt-4o",
		});
		assert.deepEqual(fromDialogPrefs(dialog, [{ provider: "openai", id: "gpt-4o" }]), {
			menuGate: true,
			taglineReveal: false,
			backgroundColor: "success",
			gradientAnimation: "wave",
			logoStyle: "symbol",
			changesSummary: false,
			changesSummaryModel: PINNED,
		});
	});

	it("shows a missing logo style as random and no pinned model as none", () => {
		const { logoStyle: _omitted, changesSummaryModel: _none, ...rest } = prefs;
		const dialog = toDialogPrefs(rest);
		assert.equal(dialog.logoStyle, "random");
		assert.equal(dialog.changesSummaryModel, null);
		assert.equal(fromDialogPrefs(dialog, []).changesSummaryModel, undefined, "the session model");
	});

	it("tells two providers' models with the same id apart", () => {
		const refs = [{ provider: "openai", id: "shared" }, { provider: "azure", id: "shared" }];
		const models = toDialogModels(refs);
		assert.equal(new Set(models.map((model) => model.id)).size, 2);
		assert.deepEqual(models.map((model) => [model.name, model.provider]), [["shared", "openai"], ["shared", "azure"]]);
		const picked = fromDialogPrefs({ ...toDialogPrefs(prefs), changesSummaryModel: models[1]!.id }, refs);
		assert.deepEqual(picked.changesSummaryModel, { provider: "azure", id: "shared" });
	});

	it("keeps a pinned model pi no longer offers, once, so its row still names it", () => {
		const gone = { provider: "retired", id: "old-model" };
		const models = toDialogModels([{ provider: "openai", id: "gpt-4o" }], gone);
		assert.deepEqual(models.map((model) => model.id), ["openai/gpt-4o", "retired/old-model"]);
		assert.equal(toDialogModels([gone], gone).length, 1, "not listed twice when pi still offers it");
		assert.deepEqual(fromDialogPrefs({ ...toDialogPrefs({ ...prefs, changesSummaryModel: gone }) }, [], gone).changesSummaryModel, gone);
	});

	it("does not invent a model for a key it was never given", () => {
		assert.equal(fromDialogPrefs({ ...toDialogPrefs(prefs), changesSummaryModel: "nobody/nothing" }, []).changesSummaryModel, undefined);
	});

	it("a model pi lists gets the thinking levels the registry reports, in pi's order, with a default", () => {
		const refs = [{ provider: "anthropic", id: "claude" }, { provider: "openai", id: "plain" }, { provider: "x", id: "unlisted" }];
		const levels: Record<string, string[] | undefined> = { "anthropic/claude": ["off", "high", "low", "medium", "max"], "openai/plain": ["off"] };
		const [claude, plain, unlisted] = toDialogModels(refs, undefined, (ref) => levels[`${ref.provider}/${ref.id}`]);
		assert.deepEqual(claude!.levels!.map((level) => level.id), ["off", "low", "medium", "high", "max"]);
		assert.equal(claude!.defaultLevel, "off", "off while it is offered, which is where a summary always runs");
		assert.ok(claude!.levels!.every((level) => level.label !== "" && level.desc !== ""), "every level can be described");
		assert.deepEqual(plain!.levels!.map((level) => level.id), ["off"]);
		assert.equal(unlisted!.levels, null, "a model pi does not list has no thinking control to show");
	});

	it("starts a model that cannot turn thinking off on a level it offers", () => {
		const [model] = toDialogModels([{ provider: "o", id: "reasoner" }], undefined, () => ["low", "medium", "high"]);
		assert.equal(model!.defaultLevel, "medium");
		const [only] = toDialogModels([{ provider: "o", id: "fixed" }], undefined, () => ["high"]);
		assert.equal(only!.defaultLevel, "high");
	});

	it("falls back to the common levels when the registry reports none it knows", () => {
		const [model] = toDialogModels([{ provider: "o", id: "odd" }], undefined, () => ["turbo"]);
		assert.deepEqual(model!.levels!.map((level) => level.id), ["off", "low", "medium", "high"]);
	});
});

describe("the size of the generated dialog", () => {
	/** The dialog's own size: mounted with room to spare and left to take the rows its content needs. */
	function measure(frame: TerminalSize = { columns: 160, rows: 80 }, keys: string[] = []): { size: TerminalSize; rows: string[] } {
		const element: ReactNode = createElement(SplashSettings, { initial: PREFS_DEFAULTS, onDone: () => {} });
		const mounted = mountOpenTui(element, { width: frame.columns, height: frame.rows, theme: MOCKUP_PALETTE, fitContent: true });
		try {
			for (const key of keys) mounted.input(key);
			const rows = mounted.charFrame().split("\n");
			return { size: { columns: Math.max(...rows.map((row) => [...row.trimEnd()].length)), rows: rows.length }, rows };
		} finally {
			mounted.unmount();
		}
	}

	/** Down to Info Panel, into its list, down to Summary model, Enter: the picker opens. */
	const OPEN_PICKER = [KEY.down, KEY.down, KEY.right, KEY.down, KEY.down, KEY.enter];

	async function measureWithPicker(frame: TerminalSize): Promise<string[]> {
		const element: ReactNode = createElement(SplashSettings, { initial: PREFS_DEFAULTS, onDone: () => {} });
		const mounted = mountOpenTui(element, { width: frame.columns, height: frame.rows, theme: MOCKUP_PALETTE, fitContent: true });
		try {
			for (const key of OPEN_PICKER) {
				mounted.input(key);
				await turn();
			}
			return mounted.charFrame().split("\n");
		} finally {
			mounted.unmount();
		}
	}

	it("dialogFits needs every column and every row of the dialog", () => {
		const dialog = SETTINGS_DIALOG_SIZE;
		assert.equal(dialogFits(dialog, dialog), true, "a terminal exactly the dialog's size fits it");
		assert.equal(dialogFits({ columns: dialog.columns + 60, rows: dialog.rows + 30 }, dialog), true);
		assert.equal(dialogFits({ columns: dialog.columns - 1, rows: dialog.rows + 30 }, dialog), false, "one column short");
		assert.equal(dialogFits({ columns: dialog.columns + 60, rows: dialog.rows - 1 }, dialog), false, "one row short");
		assert.equal(dialogFits(undefined, dialog), false, "an unknown size counts as too small");
	});

	it("dialogFits at common terminal sizes", () => {
		assert.equal(dialogFits({ columns: 80, rows: 24 }, SETTINGS_DIALOG_SIZE), false, "a default 80x24 window is too small");
		assert.equal(dialogFits({ columns: 100, rows: 24 }, SETTINGS_DIALOG_SIZE), false, "100x24 has the columns but not the rows the picker needs");
		assert.equal(dialogFits({ columns: 100, rows: 27 }, SETTINGS_DIALOG_SIZE), false, "one row short at 100 columns");
		assert.equal(dialogFits({ columns: 100, rows: 28 }, SETTINGS_DIALOG_SIZE), true);
		assert.equal(dialogFits({ columns: 83, rows: 40 }, SETTINGS_DIALOG_SIZE), false, "one column short");
		assert.equal(dialogFits({ columns: 120, rows: 40 }, SETTINGS_DIALOG_SIZE), true);
	});

	it("the size threshold is the tallest view's own content", async () => {
		const settings = measure().size;
		// The panel is 84 columns wide, and its last two are padding that no character sits in.
		assert.equal(settings.columns, SETTINGS_DIALOG_SIZE.columns - 2);
		const picker = await measureWithPicker({ columns: 160, rows: 80 });
		assert.deepEqual(
			{ columns: Math.max(...picker.map((row) => [...row.trimEnd()].length)), rows: picker.length },
			{ columns: SETTINGS_DIALOG_SIZE.columns - 2, rows: SETTINGS_DIALOG_SIZE.rows },
			"the picker is as wide as the dialog and fixes the rows",
		);
		assert.ok(settings.rows < SETTINGS_DIALOG_SIZE.rows, "the settings view is shorter than the picker");
		// The fit rule compares rows directly, which holds only while a dialog may use every row.
		assert.equal(DIALOG_MAX_HEIGHT, 1);
	});

	it("the settings view has no blank rows below its key hints", () => {
		const rows = measure().rows;
		assert.equal(rows.at(-1)!.trimEnd(), "▌", "the last row is the bar's closing row");
		assert.match(rows.at(-2)!, /esc cancel/, "the key hints are the row above it");
	});

	it("the picker takes the dialog's place whole, with its thinking pane, and the dialog returns when it closes", async () => {
		const picker = await measureWithPicker(SETTINGS_DIALOG_SIZE);
		assert.equal(picker.length, SETTINGS_DIALOG_SIZE.rows);
		const text = picker.join("\n");
		assert.match(text, /PICK SUMMARY MODEL/, "the picker's title is not cut off at the top");
		assert.match(text, /╭─ Thinking ─+╮/, "the thinking pane is drawn");
		assert.match(text, /Select\s+Cancel/, "the picker's buttons are drawn");
		assert.match(text, /esc back/, "the picker's last legend row is not cut off at the bottom");
		assert.doesNotMatch(text, /Sections/, "the settings panes are not drawn behind it");
	});

	it("the picker scrolls: the last of many models is still on screen when highlighted", async () => {
		const models = Array.from({ length: 30 }, (_, index) => ({ id: `p/m${index}`, name: `model-${index}`, provider: "p", tags: [], levels: null }));
		const element: ReactNode = createElement(SplashSettings, { initial: PREFS_DEFAULTS, models, sessionModelId: "p/m0", onDone: () => {} });
		const mounted = mountOpenTui(element, { width: 160, height: 80, theme: MOCKUP_PALETTE, fitContent: true });
		try {
			for (const key of [...OPEN_PICKER, ...Array.from({ length: 29 }, () => KEY.down)]) {
				mounted.input(key);
				await new Promise((resolve) => setTimeout(resolve, 15));
			}
			const rows = mounted.charFrame().split("\n");
			assert.equal(rows.length, SETTINGS_DIALOG_SIZE.rows, "scrolling does not change the height");
			assert.ok(rows.some((row) => /▸ model-29\b/.test(row)), "the highlighted last model is visible");
			assert.ok(rows.every((row) => !/\bmodel-0\b/.test(row)), "the top of the list has scrolled out");
		} finally {
			mounted.unmount();
		}
	});

	it("a frame with too few rows cuts the view being shown", async () => {
		const settingsRows = measure().rows.length;
		const cutSettings = measure({ columns: SETTINGS_DIALOG_SIZE.columns, rows: settingsRows - 1 }).rows;
		assert.equal(cutSettings.length, settingsRows - 1, "one row less loses the closing row of the bar");
		assert.match(cutSettings.at(-1)!, /esc cancel/, "so the key hints are now last");

		const cutPicker = await measureWithPicker({ columns: SETTINGS_DIALOG_SIZE.columns, rows: SETTINGS_DIALOG_SIZE.rows - 1 });
		assert.equal(cutPicker.length, SETTINGS_DIALOG_SIZE.rows - 1);
		assert.match(cutPicker.at(-1)!, /esc back/, "one row less loses the picker's closing row, leaving its legend last");
		const cutMore = await measureWithPicker({ columns: SETTINGS_DIALOG_SIZE.columns, rows: 20 });
		assert.ok(cutMore.every((row) => !/Select\s+Cancel/.test(row)), "a frame of 20 rows loses the picker's buttons");
	});

	it("a frame narrower than the dialog loses the panels' right corners", () => {
		const narrow = measure({ columns: SETTINGS_DIALOG_SIZE.columns - 6, rows: SETTINGS_DIALOG_SIZE.rows }).rows;
		assert.ok(narrow.every((row) => !/[╮╯]$/.test(row.trimEnd())));
	});
});

describe("readTerminalSize", () => {
	it("reads the TUI's terminal without showing anything", async () => {
		const ctx = makeCtx({ columns: 132, rows: 43 });
		assert.deepEqual(await readTerminalSize(ctx.ctx), { columns: 132, rows: 43 });
		assert.deepEqual(ctx.customComponents, [], "the probe finishes inside its factory, so pi never shows it");
		assert.deepEqual(ctx.customOptions, [], "and nothing is mounted for it");
		assert.deepEqual(ctx.notifications, []);
	});

	it("asks nothing of a pi that would close another extension's overlay", async () => {
		const calls: unknown[] = [];
		const ctx = { ui: { custom: () => { calls.push(1); return Promise.resolve(undefined); } } };
		assert.equal(await readTerminalSize(ctx as never, "1.2.0"), undefined);
		assert.deepEqual(calls, [], "ctx.ui.custom is not called at all");
		assert.equal(MIN_SIZE_PROBE_HOST_VERSION, "1.3.0");
		for (const version of ["1.3.0", "1.4.0", "1.5.2", "2.0.0"]) {
			assert.deepEqual(await readTerminalSize(makeCtx({ columns: 132, rows: 43 }).ctx, version), { columns: 132, rows: 43 }, version);
		}
	});

	it("reports an unknown size when the terminal cannot be read or pi rejects the probe", async () => {
		const withTerminal = (terminal: unknown) => ({
			ui: { custom: (factory: (tui: unknown, ...rest: unknown[]) => unknown) => new Promise((resolve) => { factory({ terminal }, undefined, undefined, resolve); }) },
		});
		assert.equal(await readTerminalSize(withTerminal(undefined) as never), undefined, "a TUI with no terminal");
		for (const terminal of [{ columns: 0, rows: 40 }, { columns: 120, rows: Number.NaN }, { columns: 120.5, rows: 40 }, { columns: "120", rows: "40" }]) {
			assert.equal(await readTerminalSize(withTerminal(terminal) as never), undefined, JSON.stringify(terminal));
		}
		assert.equal(await readTerminalSize({ ui: { custom: () => Promise.reject(new Error("no ui")) } } as never), undefined);
	});
});

describe("/topping-splash-settings with the generated dialog", () => {
	it("opens it on a terminal with room, as a titled overlay the size the dialog needs", async (t) => {
		const noConsole = watchConsole(t);
		const { ctx, done, dialog } = await openSettings(makeCtx());
		assert.ok(!(dialog instanceof MenuComponent), "not the showMenu fallback");
		assert.equal(ctx.customComponents.length, 1, "the size probe is not a second dialog");
		assert.match(screen(dialog), /PI TOPPING SPLASH: SETTINGS/);
		assert.match(screen(dialog), /Startup gate menu/);
		const options = ctx.customOptions[0] as { overlay?: boolean; overlayOptions?: { width?: unknown }; blocked?: { kind?: string; message?: string } };
		assert.equal(options.overlay, true);
		assert.equal(options.overlayOptions?.width, SETTINGS_DIALOG_SIZE.columns);
		assert.deepEqual(options.blocked, { kind: "question", message: SETTINGS_DIALOG_TITLE });
		for (const line of dialog.render(SETTINGS_DIALOG_SIZE.columns)) assert.equal([...stripAnsi(line)].length, SETTINGS_DIALOG_SIZE.columns, "every line is exactly the overlay's width");
		await press(dialog, KEY.esc);
		await done;
		noConsole();
	});

	it("applies the choices: preferences are written and the summary model is the picked ref", async (t) => {
		const noConsole = watchConsole(t);
		const { ctx, done, dialog } = await openSettings(makeCtx());
		await press(dialog, KEY.down, KEY.down, KEY.right, KEY.space); // Info Panel: reveal off
		await press(dialog, KEY.down, KEY.down, KEY.enter); // the Summary model picker
		assert.match(screen(dialog), /PICK SUMMARY MODEL/);
		await press(dialog, KEY.down, KEY.enter, KEY.enter); // the second model; Enter first moves into its thinking pane
		assert.match(screen(dialog), /gpt-4o\s+›/, "the row names the pick");
		await press(dialog, KEY.esc, KEY.up, KEY.right, KEY.right); // Splash Banner: background accent
		await press(dialog, KEY.ctrlS);
		await done;
		const stored = storedPreferences();
		assert.equal(stored.taglineReveal, "off");
		assert.equal(stored.backgroundColor, "accent");
		assert.equal(stored.menuGate, "off", "untouched settings keep their value");
		assert.deepEqual(stored.changesSummaryModel, PINNED);
		assert.equal(state.backgroundColor, "accent", "applied to the running splash at once");
		assert.ok(ctx.notifications.some((n) => n.type === "info"), "user notified of success");
		noConsole();
	});

	it("starts the model picker on the session's model while none is pinned, and on the pinned one after", async () => {
		const first = await openSettings(makeCtx());
		await press(first.dialog, KEY.down, KEY.down, KEY.right, KEY.down, KEY.down, KEY.enter);
		assert.match(screen(first.dialog), /▸ claude-opus-4\s+✦\s+●/, "the session model");
		await press(first.dialog, KEY.esc, KEY.esc, KEY.esc);
		await first.done;

		writePreferences({ ...storedPreferences(), changesSummaryModel: PINNED });
		const second = await openSettings(makeCtx());
		await press(second.dialog, KEY.down, KEY.down, KEY.right, KEY.down, KEY.down, KEY.enter);
		assert.match(screen(second.dialog), /▸ gpt-4o\s+✦\s+●/, "the pinned model");
		await press(second.dialog, KEY.esc, KEY.esc, KEY.esc);
		await second.done;
	});

	it("clears a pinned model with Backspace: the summary goes back to the session model", async () => {
		writePreferences({ ...storedPreferences(), changesSummaryModel: PINNED });
		const { done, dialog } = await openSettings(makeCtx());
		assert.equal(storedPreferences().changesSummaryModel?.id, "gpt-4o");
		await press(dialog, KEY.down, KEY.down, KEY.right, KEY.down, KEY.down, KEY.backspace);
		assert.match(screen(dialog), /session model\s+›/);
		await press(dialog, KEY.ctrlS);
		await done;
		assert.equal(storedPreferences().changesSummaryModel, undefined);
	});

	it("keeps naming a pinned model pi no longer offers", async () => {
		writePreferences({ ...storedPreferences(), changesSummaryModel: { provider: "retired", id: "old-model" } });
		const { done, dialog } = await openSettings(makeCtx());
		await press(dialog, KEY.down, KEY.down, KEY.right, KEY.down, KEY.down);
		assert.match(screen(dialog), /old-model\s+›/);
		await press(dialog, KEY.ctrlS);
		await done;
		assert.deepEqual(storedPreferences().changesSummaryModel, { provider: "retired", id: "old-model" }, "applying another change does not drop it");
	});

	it("cancelling writes nothing; with unsaved changes the first esc only asks", async (t) => {
		const noConsole = watchConsole(t);
		const { ctx, done, dialog } = await openSettings(makeCtx());
		await press(dialog, KEY.down, KEY.right, KEY.right); // Splash Banner: background accent
		await press(dialog, KEY.esc, KEY.esc);
		assert.match(screen(dialog), /Press esc again to discard/, "the first esc asks");
		await press(dialog, KEY.esc);
		await done;
		assert.equal(existsSync(join(env.agentDir, "pi-topping-splash.json")), false, "no file written");
		assert.equal(ctx.notifications.some((n) => n.type === "info"), false, "no success notification");
		noConsole();
	});

	it("keeps the showMenu dialog on a terminal too narrow or too short for the generated one", async () => {
		for (const terminal of [
			{ columns: SETTINGS_DIALOG_SIZE.columns - 1, rows: 60 },
			{ columns: 200, rows: SETTINGS_DIALOG_SIZE.rows - 1 },
			{ columns: 80, rows: 24 },
		]) {
			const { dialog, done } = await openSettings(makeCtx(terminal));
			assert.ok(dialog instanceof MenuComponent, `${terminal.columns}x${terminal.rows} opens the showMenu dialog`);
			await press(dialog, KEY.esc);
			await done;
		}
	});

	it("opens the generated dialog at exactly its own size", async () => {
		const { dialog, done } = await openSettings(makeCtx({ columns: SETTINGS_DIALOG_SIZE.columns, rows: SETTINGS_DIALOG_SIZE.rows }));
		assert.ok(!(dialog instanceof MenuComponent));
		await press(dialog, KEY.esc);
		await done;
	});

	it("reports a failing dialog and opens the showMenu dialog, so the settings stay reachable", async () => {
		const ctx = makeCtx();
		const custom = ctx.ctx.ui.custom.bind(ctx.ctx.ui);
		let calls = 0;
		// The first call is the size probe; the second is the generated dialog.
		(ctx.ctx.ui as { custom: unknown }).custom = ((factory: never, options: never) => {
			calls += 1;
			return calls === 2 ? Promise.reject(new Error("boom")) : custom(factory, options);
		}) as typeof ctx.ctx.ui.custom;
		const { dialog, done } = await openSettings(ctx);
		assert.ok(dialog instanceof MenuComponent, "the fallback menu is shown");
		assert.ok(ctx.notifications.some((n) => n.type === "error" && /boom/.test(n.message)), "the failure is reported");
		await press(dialog, KEY.esc);
		await done;
		assert.equal(storedPreferences().menuGate, "off");
	});

	it("opens with an empty model registry; the picker is empty and nothing throws", async (t) => {
		const noConsole = watchConsole(t);
		const tui = createFakeTui({ rows: ROOMY.rows, columns: ROOMY.columns });
		const ctx = createFakeCtx({ cwd: env.cwd, theme: makeTheme(), tui: tui.tui, models: [] });
		const { done, dialog } = await openSettings(ctx);
		await press(dialog, KEY.down, KEY.down, KEY.right, KEY.down, KEY.down, KEY.enter);
		assert.match(screen(dialog), /PICK SUMMARY MODEL/);
		await press(dialog, KEY.enter); // nothing to pick
		assert.match(screen(dialog), /PICK SUMMARY MODEL/, "Enter with no model does nothing");
		await press(dialog, KEY.esc, KEY.esc, KEY.esc);
		await done;
		noConsole();
	});
});

describe("the runtime", () => {
	it("loads one copy of react for the generated dialogs, the runtime and its reconciler", () => {
		// The generated files import react themselves. A second copy next to the runtime's makes every
		// hook call fail, so a split install must fail here and not on the first dialog a user opens.
		const fromGenerated = createRequire(new URL("../src/ui/generated/ui.ts", import.meta.url));
		const fromRuntime = createRequire(import.meta.resolve("@underactive/pi-topping-opentui/host"));
		const fromReconciler = createRequire(fromRuntime.resolve("react-reconciler"));
		const react = fromGenerated.resolve("react");
		assert.equal(fromRuntime.resolve("react"), react, "the runtime resolves another react than the generated files");
		assert.equal(fromReconciler.resolve("react"), react, "react-reconciler resolves another react than the generated files");
	});
});
