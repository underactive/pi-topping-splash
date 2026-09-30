import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, type KeybindingDefinitions } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { gradientAnimation, stopGradientAnimation } from "../src/animate.ts";
import { ensureQuietStartup, installHeader, withSettings } from "../src/header.ts";
import { installChangesHeader, summaryStream } from "../src/changes-summary.ts";
import type { ChangesPresentation } from "../src/changes-summary.ts";
import { readPreferences, writePreferences } from "../src/preferences.ts";
import { gateMenuRows } from "../src/gate.ts";
import { stopTaglineReveal, TAGLINE_PLACEHOLDER, taglineReveal } from "../src/reveal.ts";
import { changesRenderState, headerRenderState, state } from "../src/state.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { createFakeCtx, makeModel, type FakeCtxHarness } from "./helpers/fake-ctx.ts";
import { createFakePi } from "./helpers/fake-api.ts";
import { createFakeTui, type FakeTuiHarness } from "./helpers/fake-tui.ts";
import type { FakePiBag } from "./helpers/fake-api.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { makeTheme } from "./helpers/theme.ts";
import { assertLinesExact } from "./helpers/width.ts";

/** App keybindings merged with TUI base, since KEYBINDINGS is not exported from the main package. */
const APP_KEYBINDINGS_HEADER = {
	"app.interrupt": { defaultKeys: "ctrl+c", description: "Interrupt" },
	"app.clear": { defaultKeys: "ctrl+l", description: "Clear screen" },
	"app.exit": { defaultKeys: "ctrl+q", description: "Exit" },
	"app.tools.expand": { defaultKeys: "ctrl+t", description: "Expand tools" },
} as KeybindingDefinitions;
const ALL_KEYBINDINGS_HEADER = { ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS_HEADER };

let env: TempAgentEnv;
beforeEach(() => {
	env = tempAgentDir();
	resetModuleState();
});
afterEach(() => {
	stopTaglineReveal();
	stopGradientAnimation();
	env.restore();
});

describe("withSettings (H-01)", () => {
	it("runs the callback with a settings manager", () => {
		let ran = false;
		withSettings(env.cwd, () => {
			ran = true;
		});
		assert.equal(ran, true);
	});
	it("swallows callback errors", () => {
		withSettings(env.cwd, () => {
			throw new Error("boom");
		});
	});
});

describe("ensureQuietStartup (H-02, H-03)", () => {
	it("enables quietStartup and persists it (write is queued asynchronously)", async () => {
		// The once-per-process guard lives at the caller (state.quietStartupEnsured, tested
		// via index.ts); this function reports whether it changed the setting.
		assert.equal(ensureQuietStartup(env.cwd), true, "first call changes the setting");
		const deadline = Date.now() + 2000;
		while (!SettingsManager.create(env.cwd).getQuietStartup() && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(SettingsManager.create(env.cwd).getQuietStartup(), true, "queued write must land");
		assert.ok(existsSync(join(env.agentDir, "settings.json")), "must persist under the temp agent dir");
	});
});

describe("installHeader (H-04, H-05)", () => {
	function install(options: { projectTrusted?: boolean; piOverrides?: Partial<FakePiBag> } = {}): { tui: FakeTuiHarness; ctx: FakeCtxHarness; component: Component } {
		// A project context file so the splash has something to list under [context].
		writeFileSync(join(env.cwd, "AGENTS.md"), "# project context");
		const tui = createFakeTui({ rows: 40, columns: 120 });
		const ctx = createFakeCtx({
			cwd: env.cwd,
			theme: makeTheme(),
			tui: tui.tui,
			model: makeModel("anthropic", "claude-opus-4"),
			systemPrompt: "x".repeat(4000),
			projectTrusted: options.projectTrusted ?? false,
		});
		const piDefaults = {
			commandsInfo: [
				{
					name: "my-skill",
					source: "skill",
					sourceInfo: { path: "/skills/my-skill/SKILL.md", source: "skill", scope: "user", origin: "top-level" },
				},
			],
		};
		const pi = createFakePi({ ...piDefaults, ...options.piOverrides });
		installHeader(pi.pi, ctx.ctx, readPreferences());
		assert.equal(ctx.setHeaderCalls.length, 1, "must install a header factory");
		const factory = ctx.setHeaderCalls[0] as (tui: TUI, theme: Theme) => Component;
		const component = factory(tui.tui, makeTheme());
		return { tui, ctx, component };
	}

	it("wires render callbacks, populates state and starts the reveal", () => {
		const { tui, component } = install();
		assert.equal(state.systemPromptSize, 4000);
		assert.ok(state.loadedSkills.includes("my-skill"), JSON.stringify(state.loadedSkills));
		assert.ok(state.loadedContext.includes("AGENTS.md"), JSON.stringify(state.loadedContext));
		assert.notEqual(taglineReveal.timer, null, "tagline reveal should be running");
		assert.equal(typeof headerRenderState.requestRender, "function");
		assert.equal(typeof headerRenderState.invalidate, "function");
		const before = tui.renderRequests.length;
		headerRenderState.requestRender?.();
		assert.equal(tui.renderRequests.length, before + 1);
		assert.ok(component, "factory must build a component");
	});

	it("taglineReveal:off never starts the reveal and settles the tagline on frame one (I-15)", () => {
		writePreferences({ menuGate: "on", taglineReveal: "off", backgroundColor: "rainbow", gradientAnimation: "off", changesSummary: "off" });
		const { component } = install();
		assert.equal(taglineReveal.timer, null, "reveal must not start");
		const text = component.render(120).map(sanitizeTuiText).join("\n");
		assert.ok(text.includes("claude-opus-4"), "final model shown immediately");
		assert.ok(text.includes("~1.0k tokens"), "final prompt size shown immediately");
		assert.ok(!text.includes(TAGLINE_PLACEHOLDER), "no placeholder frame");
	});

	it("renders full-bleed splash lines at every width", () => {
		const { component } = install();
		for (let width = 1; width <= 200; width += 3) {
			assertLinesExact(component.render(width), width, `header render(width=${width})`);
		}
	});

	it("renders the loaded context file under a [context] heading", () => {
		const { component } = install();
		stopTaglineReveal();
		const text = component.render(120).map(sanitizeTuiText).join("\n");
		assert.ok(text.includes("[context] 1"), text);
		assert.ok(text.includes("AGENTS.md"), text);
		assert.ok(text.indexOf("[context]") < text.indexOf("[skills]"), "context section precedes skills");
	});

	it("counts trusted-project system prompt sources in the context list", () => {
		mkdirSync(join(env.cwd, ".pi"), { recursive: true });
		writeFileSync(join(env.cwd, ".pi", "SYSTEM.md"), "# system prompt");
		writeFileSync(join(env.cwd, ".pi", "APPEND_SYSTEM.md"), "# appended");
		const { component } = install({ projectTrusted: true });
		stopTaglineReveal();
		const text = component.render(120).map(sanitizeTuiText).join("\n");
		assert.ok(text.includes("[context] 3"), text);
		assert.ok(text.includes(".pi/SYSTEM.md"), text);
		assert.ok(text.includes(".pi/APPEND_SYSTEM.md"), text);
		assert.ok(text.includes("AGENTS.md"), text);
	});

	it("a model change is reflected after invalidation (commit 1a88a1c)", () => {
		const { ctx, component } = install();
		// Mid-reveal the tagline shows the placeholder, not the model — settle it first.
		stopTaglineReveal();
		assert.ok(component.render(120).map(sanitizeTuiText).join("\n").includes("claude-opus-4"));
		ctx.bag.model = makeModel("other", "different-model");
		headerRenderState.invalidate?.();
		const text = component.render(120).map(sanitizeTuiText).join("\n");
		assert.ok(text.includes("different-model"), "fresh render must show the new model");
	});

	it("a reveal tick repaints only the tagline row and holds the width invariant", () => {
		const { component } = install();
		const first = component.render(120);
		assertLinesExact(first, 120, "initial reveal frame");
		// Advance the wipe and bump the repaint key: the memo should splice one row, not rebuild.
		taglineReveal.pos = 3;
		taglineReveal.tick += 1;
		const second = component.render(120);
		assertLinesExact(second, 120, "after reveal tick");
		const changed = second.filter((line, i) => line !== first[i]).length;
		assert.ok(changed <= 1, `tick-only render touched ${changed} rows, expected at most 1`);
	});

	it("an animated background preference seeds state and starts the gradient ticker (H-07)", () => {
		writePreferences({ menuGate: "on", taglineReveal: "off", backgroundColor: "accent", gradientAnimation: "breathe", changesSummary: "off" });
		install();
		assert.equal(state.gradientAnimation, "breathe", "state seeded from preferences");
		assert.notEqual(gradientAnimation.timer, null, "gradient ticker running");
	});

	it("an animated rainbow also starts the ticker; animation off never does (H-07)", () => {
		writePreferences({ menuGate: "on", taglineReveal: "off", backgroundColor: "rainbow", gradientAnimation: "breathe", changesSummary: "off" });
		install();
		assert.notEqual(gradientAnimation.timer, null, "rainbow animates too");
		resetModuleState();
		writePreferences({ menuGate: "on", taglineReveal: "off", backgroundColor: "accent", gradientAnimation: "off", changesSummary: "off" });
		install();
		assert.equal(gradientAnimation.timer, null, "off stays static");
	});

	it("an animation tick repaints the backdrop rows and holds the width invariant (H-07)", () => {
		writePreferences({ menuGate: "on", taglineReveal: "off", backgroundColor: "accent", gradientAnimation: "breathe", changesSummary: "off" });
		const { component } = install();
		const first = component.render(120);
		assertLinesExact(first, 120, "initial animated frame");
		gradientAnimation.timeMs = 2000;
		gradientAnimation.tick += 1;
		const second = component.render(120);
		assertLinesExact(second, 120, "after animation tick");
		assert.equal(second.length, first.length, "row count stable across ticks");
		assert.notDeepEqual(second, first, "the backdrop must move");
	});

	const changesPresentation = (summary: ChangesPresentation["summary"] = { status: "pending", modelLabel: "provider/model" }, version = 1): ChangesPresentation => ({
		entries: [
			{ path: "added.ts", kind: "added", untracked: false },
			{ path: "changed.ts", kind: "changed", untracked: false },
			{ path: "deleted.ts", kind: "deleted", untracked: false },
		],
		summary,
		version,
	});
	const setRows = (tui: FakeTuiHarness, rows: number): void => {
		(tui.tui.terminal as { rows: number }).rows = rows;
	};

	it("folds the changes section into the info panel after [extensions], tracks total splash rows, and survives animation ticks", () => {
		writePreferences({ menuGate: "on", taglineReveal: "off", backgroundColor: "accent", gradientAnimation: "breathe", changesSummary: "on" });
		const { tui, component } = install();
		setRows(tui, 60);
		const band = component.render(120);
		state.changes = changesPresentation();
		const first = component.render(120);
		// The swatch runs beside the grown panel too, so the whole header stays full-bleed.
		assertLinesExact(first, 120, "splash + changes section");
		assert.ok(first.length > band.length, "the section grows the panel");
		assert.equal(state.splashRows, first.length);
		// The logo re-centers against the taller panel, so compare the panel's columns only. The section's
		// gap takes the row where the panel's closing padding was; every panel row above keeps its glyphs.
		const column = sanitizeTuiText(band.find((line) => line.includes("[extensions]"))!).indexOf("[extensions]");
		const panelText = (lines: string[]) => lines.slice(0, band.length - 2).map((line) => sanitizeTuiText(line).slice(column));
		assert.deepEqual(panelText(first), panelText(band), "the panel rows above the section keep their glyphs");
		const text = first.map(sanitizeTuiText).join("\n");
		assert.ok(text.indexOf("[extensions]") < text.indexOf("[local changes] +1, ~1, -1"), "the section follows the extension list");
		assert.ok(text.includes("changed.ts"));
		gradientAnimation.timeMs = 2000;
		gradientAnimation.tick += 1;
		const second = component.render(120);
		assertLinesExact(second, 120, "animated splash + changes section");
		assert.equal(second.length, first.length);
		assert.equal(second.map(sanitizeTuiText).join("\n").split("changed.ts").length - 1, 1);
		assert.notDeepEqual(second, first, "the backdrop around the panel must move");
	});

	it("lines the section's heading up with the panel's other headings at every width", () => {
		writePreferences({ menuGate: "on", taglineReveal: "off", backgroundColor: "accent", gradientAnimation: "off", changesSummary: "on" });
		const { tui, component } = install();
		setRows(tui, 60);
		state.changes = changesPresentation();
		for (const width of [60, 100, 120, 140, 200]) {
			const lines = component.render(width);
			assertLinesExact(lines, width, `section at width ${width}`);
			const text = lines.map(sanitizeTuiText);
			const heading = text.find((line) => line.includes("[local changes]"))!;
			const extensions = text.find((line) => line.includes("[extensions]"))!;
			assert.equal(heading.indexOf("[local changes]"), extensions.indexOf("[extensions]"), `width ${width}`);
			assert.equal(text.some((line) => /[┌┐└┘│]/.test(line)), false, `width ${width}: no box`);
		}
	});

	it("rebuilds the section when the changes are republished", () => {
		writePreferences({ menuGate: "on", taglineReveal: "off", backgroundColor: "accent", gradientAnimation: "off", changesSummary: "on" });
		const { tui, component } = install();
		setRows(tui, 60);
		state.changes = changesPresentation();
		const pending = component.render(120).map(sanitizeTuiText).join("\n");
		assert.ok(pending.includes("summarizing local changes with provider/model"));
		assert.equal(component.render(120).map(sanitizeTuiText).join("\n"), pending, "an unchanged version is served from the cache");
		state.changes = changesPresentation({ status: "done", text: "All three files moved." }, 2);
		const done = component.render(120).map(sanitizeTuiText).join("\n");
		assert.ok(done.includes("All three files moved."));
		assert.equal(done.includes("summarizing local changes with"), false);
	});

	it("repaints only the summary row a stream tick touched, holding the row count", () => {
		writePreferences({ menuGate: "on", taglineReveal: "off", backgroundColor: "accent", gradientAnimation: "off", changesSummary: "on" });
		const { tui, component } = install();
		setRows(tui, 60);
		// Drive the stream by hand: nothing printed, then the first word, then settled.
		summaryStream.shown = 0;
		summaryStream.tick++;
		state.changes = changesPresentation({ status: "done", text: "Streamed summary text." }, 2);
		const blank = component.render(120);
		assert.equal(blank.map(sanitizeTuiText).join("\n").includes("Streamed"), false);
		summaryStream.shown = "Streamed".length;
		summaryStream.tick++;
		const partial = component.render(120);
		assertLinesExact(partial, 120, "mid-stream frame");
		assert.equal(partial.length, blank.length, "streaming never adds rows");
		const changed = partial.flatMap((line, index) => (line === blank[index] ? [] : [index]));
		assert.equal(changed.length, 1, `a stream tick touched ${changed.length} rows`);
		assert.match(sanitizeTuiText(partial[changed[0]]), /  Streamed +▀/);
		summaryStream.shown = Number.POSITIVE_INFINITY;
		summaryStream.tick++;
		assert.ok(component.render(120).map(sanitizeTuiText).join("\n").includes("Streamed summary text."));
	});

	it("reserves gate rows for the changes block and keeps the changes-only header separate", () => {
		const { tui, ctx } = install();
		state.changes = {
			entries: [{ path: "file.ts", kind: "changed", untracked: false }],
			summary: { status: "failed", reason: "request failed" },
			version: 1,
		};
		for (const rows of [24, 40]) {
			(tui.tui.terminal as { rows: number }).rows = rows;
			const factory = ctx.setHeaderCalls[0] as (tui: TUI, theme: Theme) => Component;
			const component = factory(tui.tui, makeTheme());
			const rendered = component.render(100);
			assert.ok(rendered.length <= rows);
			assert.equal(state.splashRows, rendered.length);
			assert.ok(gateMenuRows(rows) >= 1);
		}
		const beforeHeader = headerRenderState.requestRender;
		installChangesHeader(ctx.ctx);
		const slimFactory = ctx.setHeaderCalls.at(-1) as (tui: TUI, theme: Theme) => Component;
		slimFactory(tui.tui, makeTheme());
		assert.equal(headerRenderState.requestRender, beforeHeader);
		assert.notEqual(changesRenderState.requestRender, null);
	});

	it("seeds prompts and shortcuts in state, renders them in order (H-08)", () => {
		const kb = new KeybindingsManager(ALL_KEYBINDINGS_HEADER, {});
		setKeybindings(kb);
		const { component } = install({
			piOverrides: {
				commandsInfo: [
					{
						name: "my-skill",
						source: "skill",
						sourceInfo: { path: "/skills/my-skill/SKILL.md", source: "skill", scope: "user", origin: "top-level" },
					},
					{
						name: "rewrite",
						source: "prompt",
						sourceInfo: { path: "/prompts/rewrite", source: "prompt", scope: "user", origin: "top-level" },
					},
				],
			},
		});
		stopTaglineReveal();
		assert.ok(state.loadedPrompts.includes("/rewrite"), `prompts: ${JSON.stringify(state.loadedPrompts)}`);
		assert.equal(state.loadedShortcuts.length, 5, `shortcuts: ${JSON.stringify(state.loadedShortcuts)}`);
		const text = component.render(120).map(sanitizeTuiText).join("\n");
		assert.ok(text.includes("[shortcuts] 5"), `shortcuts heading: ${text.slice(0, 200)}`);
		assert.ok(text.includes("[prompts] 1"), `prompts heading: ${text.slice(0, 200)}`);
		assert.ok(text.indexOf("[shortcuts]") < text.indexOf("[context]"), "shortcuts precedes context");
		assert.ok(text.indexOf("[context]") < text.indexOf("[skills]"), "context precedes skills");
		assert.ok(text.indexOf("[skills]") < text.indexOf("[prompts]"), "skills precedes prompts");
		assert.ok(text.indexOf("[prompts]") < text.indexOf("[extensions]"), "prompts precedes extensions");
	});
});
