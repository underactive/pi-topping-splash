import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";
import { mountOpenTui } from "@underactive/pi-topping-opentui/host";
import { MOCKUP_PALETTE } from "@underactive/pi-topping-opentui/theme";
import { createElement, type ReactNode } from "react";
import { BACKGROUND_COLOR_OPTIONS, GRADIENT_ANIMATION_OPTIONS } from "../src/color.ts";
import { LOGO_STYLE_OPTIONS } from "../src/logo.ts";
import { readPreferences, writePreferences, type SplashPreferences } from "../src/preferences.ts";
import { showSplashSettings } from "../src/settings.ts";
import { state } from "../src/state.ts";
import { DIALOG_MAX_HEIGHT, SETTINGS_DIALOG_WIDTH } from "../src/ui/dialog-size.ts";
import { BACKGROUND_COLORS, GRADIENT_ANIMATIONS, LOGO_STYLES, PREFS_DEFAULTS } from "../src/ui/generated/splash/data.ts";
import { SplashSettings } from "../src/ui/generated/splash/settings-dialog.ts";
import { fromDialogPrefs, SETTINGS_DIALOG_TITLE, toDialogModels, toDialogPrefs } from "../src/ui/settings-dialog.ts";
import { setArgv, tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { createFakeCtx, makeModel, type FakeCtxHarness } from "./helpers/fake-ctx.ts";
import { createFakeTui } from "./helpers/fake-tui.ts";
import { press, screen, settle, stripAnsi, turn, type Shown, type Terminal } from "./helpers/dialog.ts";
import { KEY } from "./helpers/keys.ts";
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

const CLAUDE = makeModel("anthropic", "claude-opus-4");
const GPT = makeModel("openai", "gpt-4o");

interface Session {
	ctx: FakeCtxHarness;
	/** The command's own promise. */
	done: Promise<void>;
}

const ROOMY: Terminal = { columns: 120, rows: 40 };

function makeCtx(terminal: Terminal = ROOMY): FakeCtxHarness {
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

	it("has a row for every setting, under its label", async () => {
		const titles = ["Startup Gate", "Splash Banner", "Info Panel"];
		const labels = ["Startup gate menu", "Background color", "Animate gradient", "Logo style", "Model + prompt size reveal animation", "Summarize uncommitted changes", "Summary model"];

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
	/** A terminal's frame: the dialog is mounted in it and takes the rows its content needs, up to the frame's. */
	function mountIn(frame: Terminal, keys: string[] = []): { rows: string[]; text: string } {
		const element: ReactNode = createElement(SplashSettings, { initial: PREFS_DEFAULTS, onDone: () => {} });
		const mounted = mountOpenTui(element, { width: frame.columns, height: frame.rows, theme: MOCKUP_PALETTE, fitContent: true });
		try {
			for (const key of keys) mounted.input(key);
			const rows = mounted.charFrame().split("\n");
			return { rows, text: rows.join("\n") };
		} finally {
			mounted.unmount();
		}
	}

	/** Down to Info Panel, into its list, down to Summary model, Enter: the picker opens. */
	const OPEN_PICKER = [KEY.down, KEY.down, KEY.right, KEY.down, KEY.down, KEY.enter];

	async function pickerIn(frame: Terminal, models?: unknown[], more: string[] = []): Promise<string[]> {
		const element: ReactNode = createElement(SplashSettings, { initial: PREFS_DEFAULTS, ...(models ? { models } : {}), onDone: () => {} } as never);
		const mounted = mountOpenTui(element, { width: frame.columns, height: frame.rows, theme: MOCKUP_PALETTE, fitContent: true });
		try {
			for (const key of [...OPEN_PICKER, ...more]) {
				mounted.input(key);
				await turn();
			}
			return mounted.charFrame().split("\n");
		} finally {
			mounted.unmount();
		}
	}

	/** Columns up to the last visible character, which leaves out the panel's two padding columns. */
	const widest = (rows: string[]): number => Math.max(...rows.map((row) => [...row.trimEnd()].length));

	const ROOM = { columns: 160, rows: 80 };
	const SMALLEST = { columns: 80, rows: 24 };

	it("with room to spare the dialog is its full width; the picker that replaces it is as wide", async () => {
		// The panel is SETTINGS_DIALOG_WIDTH columns wide, and its last two are padding that no character sits in.
		assert.equal(widest(mountIn(ROOM).rows), SETTINGS_DIALOG_WIDTH - 2);
		assert.equal(widest(await pickerIn(ROOM)), SETTINGS_DIALOG_WIDTH - 2);
	});

	it("the picker is taller than the settings view, and neither is cut at 80x24", async () => {
		const settings = mountIn(SMALLEST).rows;
		const picker = await pickerIn(SMALLEST);
		assert.ok(settings.length <= SMALLEST.rows, `the settings view is ${settings.length} rows`);
		assert.ok(picker.length <= SMALLEST.rows, `the picker is ${picker.length} rows`);
		assert.ok(widest(settings) <= SMALLEST.columns && widest(picker) <= SMALLEST.columns, "nothing is wider than 80 columns");
		assert.ok(picker.length > settings.length, "the picker is the taller view");
		assert.match(settings.at(-2)!, /esc cancel/, "the settings view's last legend row is drawn");
		assert.match(picker.at(-2)!, /esc back/, "the picker's last legend row is drawn");
		assert.match(picker.join("\n"), /Select\s+Cancel/, "the picker's buttons are drawn");
		assert.match(picker.join("\n"), /╭─ Thinking ─+╮/, "and its thinking pane");
		for (const frame of [settings, picker]) {
			assert.ok(frame.some((row) => /╮\s*$/.test(row)), "the right-hand panel corners are drawn");
		}
	});

	it("takes the room it is given between 80 columns and its full width", () => {
		for (const columns of [80, 81, 82, 83, SETTINGS_DIALOG_WIDTH, 100]) {
			const rows = mountIn({ columns, rows: 30 }).rows;
			assert.equal(widest(rows), Math.min(columns, SETTINGS_DIALOG_WIDTH) - 2, `${columns} columns`);
			assert.ok(rows.some((row) => /╮\s*$/.test(row)), `${columns} columns keeps the right-hand corners`);
		}
	});

	it("the picker fits the same widths", async () => {
		for (const columns of [80, 83, SETTINGS_DIALOG_WIDTH]) {
			const rows = await pickerIn({ columns, rows: 40 });
			assert.equal(widest(rows), Math.min(columns, SETTINGS_DIALOG_WIDTH) - 2, `${columns} columns`);
			assert.match(rows.join("\n"), /Select\s+Cancel/, `${columns} columns keeps the buttons`);
		}
	});

	it("a taller terminal does not stretch it, and the settings view has no blank rows below its key hints", () => {
		const roomy = mountIn(ROOM).rows;
		assert.equal(roomy.length, mountIn({ columns: 100, rows: 30 }).rows.length, "the rows are the content's own");
		assert.equal(roomy.at(-1)!.trimEnd(), "▌", "the last row is the bar's closing row");
		assert.match(roomy.at(-2)!, /esc cancel/, "the key hints are the row above it");
	});

	it("the picker takes the dialog's place whole, with its thinking pane", async () => {
		const picker = (await pickerIn(ROOM)).join("\n");
		assert.match(picker, /PICK SUMMARY MODEL/, "the picker's title is not cut off at the top");
		assert.match(picker, /╭─ Thinking ─+╮/, "the thinking pane is drawn");
		assert.match(picker, /Select\s+Cancel/, "the picker's buttons are drawn");
		assert.match(picker, /esc back/, "the picker's last legend row is not cut off at the bottom");
		assert.doesNotMatch(picker, /Sections/, "the settings panes are not drawn behind it");
	});

	/** A model that offers `ids` as thinking levels, each with a description the picker can show or leave to the hint area. */
	const leveled = (...ids: string[]) => [{
		id: "p/deep", name: "deep", provider: "p", tags: [],
		levels: ids.map((id, depth) => ({ id, label: id, depth: Math.min(depth, 4), desc: `${id} description` })),
	}];

	it("describes each thinking level under its row while every level fits that way, and on one row each when not", async () => {
		const five = leveled("off", "low", "medium", "high", "max");
		const roomy = (await pickerIn(ROOM, five)).join("\n");
		assert.match(roomy, /max description/, "with the rows to spare each level has its description");
		const small = (await pickerIn(SMALLEST, five)).join("\n");
		for (const level of ["off", "low", "medium", "high", "max"]) assert.match(small, new RegExp(`\\b${level}\\s+[▰▱]`), `${level} is listed at 80x24`);
		assert.doesNotMatch(small, /max description/, "at 80x24 the descriptions leave the pane; the hint area carries the focused one");
	});

	it("describes the focused thinking level in the hint area once the rows no longer do, and not before", async () => {
		const five = leveled("off", "low", "medium", "high", "max");
		const IN_THINKING_PANE = [KEY.right, KEY.down]; // the pane, then the second level
		const small = (await pickerIn(SMALLEST, five, IN_THINKING_PANE)).join("\n");
		assert.match(small, /┃ low: low description\./, "at 80x24 the hint area carries it");
		assert.doesNotMatch(small, /Summaries are always generated/, "ahead of the picker's own text, which would hide it");
		const roomy = (await pickerIn(ROOM, five, IN_THINKING_PANE)).join("\n");
		assert.match(roomy, /Summaries are always generated/, "with room, the picker's own text stays in the hint area");
		assert.match(roomy, /low description/, "and the level's description is under its row");
	});

	it("lists all seven levels of a model that offers them, at every size", async () => {
		const seven = leveled("off", "minimal", "low", "medium", "high", "xhigh", "max");
		for (const frame of [ROOM, SMALLEST]) {
			const text = (await pickerIn(frame, seven)).join("\n");
			for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) assert.match(text, new RegExp(`\\b${level}\\s+[▰▱]`), `${level} is listed at ${frame.columns}x${frame.rows}`);
		}
	});

	it("keeps the thinking pane inside the dialog when a model's id and tags are wider than it", async () => {
		const wide = [{
			id: "p/wide", name: "wide", provider: "p", tags: ["vision", "tools", "fast"],
			levels: [{ id: "off", label: "Off", depth: 0, desc: "no thinking" }],
		}, {
			id: "p/long-id", name: "long", provider: "p", tags: [],
			levels: [{ id: "off", label: "Off", depth: 0, desc: "no thinking" }],
		}];
		wide[0]!.id = "p/" + "a-very-long-model-identifier";
		wide[1]!.id = "p/" + "x".repeat(60);
		for (const columns of [80, SETTINGS_DIALOG_WIDTH]) {
			const rows = await pickerIn({ columns, rows: 30 }, wide);
			assert.equal(widest(rows), columns - 2, `${columns} columns: nothing draws into the panel's padding`);
			assert.ok(rows.some((row) => /╮\s*$/.test(row)), `${columns} columns: the pane's right corner is drawn`);
		}
	});

	it("the picker scrolls: the last of many models is still on screen when highlighted", async () => {
		const models = Array.from({ length: 30 }, (_, index) => ({ id: `p/m${index}`, name: `model-${index}`, provider: "p", tags: [], levels: null }));
		const element: ReactNode = createElement(SplashSettings, { initial: PREFS_DEFAULTS, models, sessionModelId: "p/m0", onDone: () => {} });
		for (const frame of [ROOM, SMALLEST]) {
			const mounted = mountOpenTui(element, { width: frame.columns, height: frame.rows, theme: MOCKUP_PALETTE, fitContent: true });
			try {
				for (const key of [...OPEN_PICKER, ...Array.from({ length: 29 }, () => KEY.down)]) {
					mounted.input(key);
					await new Promise((resolve) => setTimeout(resolve, 15));
				}
				const rows = mounted.charFrame().split("\n");
				assert.ok(rows.length <= frame.rows, `scrolling does not make it taller than ${frame.rows} rows`);
				assert.ok(rows.some((row) => /▸ model-29\b/.test(row)), `the highlighted last model is visible at ${frame.columns}x${frame.rows}`);
				assert.ok(rows.every((row) => !/\bmodel-0\b/.test(row)), "the top of the list has scrolled out");
			} finally {
				mounted.unmount();
			}
		}
	});

	it("a frame smaller than 80x24 clips the view being shown", async () => {
		const settings = mountIn(SMALLEST).rows;
		const cutSettings = mountIn({ columns: SMALLEST.columns, rows: settings.length - 1 }).rows;
		assert.equal(cutSettings.length, settings.length - 1, "one row less loses the closing row of the bar");
		assert.match(cutSettings.at(-1)!, /esc cancel/, "so the key hints are now last");

		const picker = await pickerIn(SMALLEST);
		const cutPicker = await pickerIn({ columns: SMALLEST.columns, rows: picker.length - 1 });
		assert.equal(cutPicker.length, picker.length - 1);
		assert.match(cutPicker.at(-1)!, /esc back/, "one row less loses the picker's closing row, leaving its legend last");
		const cutMore = await pickerIn({ columns: SMALLEST.columns, rows: 16 });
		assert.ok(cutMore.every((row) => !/Select\s+Cancel/.test(row)), "a frame of 16 rows loses the picker's buttons");
	});

	it("a frame narrower than 80 columns loses the panels' right corners", () => {
		const narrow = mountIn({ columns: SMALLEST.columns - 6, rows: SMALLEST.rows }).rows;
		assert.ok(narrow.every((row) => !/[╮╯]$/.test(row.trimEnd())));
	});

	it("asks pi for every row the terminal has", () => {
		// The dialog sizes itself to the rows the overlay is given, so the overlay must not be cut short of them.
		assert.equal(DIALOG_MAX_HEIGHT, 1);
	});
});

describe("/topping-splash-settings with the generated dialog", () => {
	it("opens it as a titled overlay that asks pi for the dialog's width and every row", async (t) => {
		const noConsole = watchConsole(t);
		const { ctx, done, dialog } = await openSettings(makeCtx());
		assert.equal(ctx.customComponents.length, 1, "one dialog and nothing else, such as a probe for the terminal's size");
		assert.match(screen(dialog), /PI TOPPING SPLASH: SETTINGS/);
		assert.match(screen(dialog), /Startup gate menu/);
		assert.deepEqual(ctx.customOptions[0], {
			overlay: true,
			blocked: { kind: "question", message: SETTINGS_DIALOG_TITLE },
			overlayOptions: { width: SETTINGS_DIALOG_WIDTH, maxHeight: "100%" },
		});
		for (const line of dialog.render(SETTINGS_DIALOG_WIDTH)) assert.equal([...stripAnsi(line)].length, SETTINGS_DIALOG_WIDTH, "every line is exactly the overlay's width");
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

	it("opens the same dialog on a default 80x24 terminal, with nothing cut", async () => {
		const { dialog, done } = await openSettings(makeCtx({ columns: 80, rows: 24 }));
		const settings = dialog.render(80).map(stripAnsi);
		assert.ok(settings.length <= 24, `${settings.length} rows`);
		assert.ok(settings.every((line) => [...line].length === 80), "every line is exactly the 80 columns pi gives the overlay");
		assert.match(settings.join("\n"), /PI TOPPING SPLASH: SETTINGS/);
		assert.match(settings.join("\n"), /Apply\s+Cancel/);
		assert.match(settings.join("\n"), /esc cancel/, "the key hints are not cut off");

		await press(dialog, KEY.down, KEY.down, KEY.right, KEY.down, KEY.down, KEY.enter);
		const picker = dialog.render(80).map(stripAnsi);
		assert.equal(picker.length, 24, "the picker takes all 24 rows");
		assert.ok(picker.every((line) => [...line].length === 80));
		assert.match(picker.join("\n"), /PICK SUMMARY MODEL/);
		assert.match(picker.join("\n"), /Select\s+Cancel/);
		assert.match(picker.join("\n"), /esc back/);
		await press(dialog, KEY.esc, KEY.esc, KEY.esc);
		await done;
	});

	it("still opens the dialog on a terminal smaller than 80x24; it is clipped, and nothing else is opened", async () => {
		for (const terminal of [{ columns: 60, rows: 30 }, { columns: 120, rows: 18 }, { columns: 50, rows: 12 }]) {
			const { ctx, dialog, done } = await openSettings(makeCtx(terminal));
			assert.equal(ctx.customComponents.length, 1, `${terminal.columns}x${terminal.rows}`);
			assert.match(screen(dialog, terminal.columns), /PI TOPPING SPLASH: SETTINGS/, `${terminal.columns}x${terminal.rows} shows the dialog`);
			for (const line of dialog.render(terminal.columns)) assert.equal([...stripAnsi(line)].length, terminal.columns, "every line is exactly the overlay's width");
			await press(dialog, KEY.esc);
			await done;
		}
	});

	it("reports a failing dialog and changes nothing", async () => {
		const ctx = makeCtx();
		(ctx.ctx.ui as { custom: unknown }).custom = (() => Promise.reject(new Error("boom"))) as typeof ctx.ctx.ui.custom;
		await showSplashSettings(ctx.ctx);
		assert.ok(ctx.notifications.some((n) => n.type === "error" && /boom/.test(n.message)), "the failure is reported");
		assert.equal(ctx.notifications.some((n) => n.type === "info"), false, "and nothing is announced as saved");
		assert.equal(existsSync(join(env.agentDir, "pi-topping-splash.json")), false, "no file written");
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
