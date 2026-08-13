import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ensureQuietStartup, installHeader, withSettings } from "../src/header.ts";
import { writePreferences } from "../src/preferences.ts";
import { stopTaglineReveal, TAGLINE_PLACEHOLDER, taglineReveal } from "../src/reveal.ts";
import { headerRenderState, state } from "../src/state.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { createFakeCtx, makeModel, type FakeCtxHarness } from "./helpers/fake-ctx.ts";
import { createFakePi } from "./helpers/fake-api.ts";
import { createFakeTui, type FakeTuiHarness } from "./helpers/fake-tui.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { makeTheme } from "./helpers/theme.ts";
import { assertLinesExact } from "./helpers/width.ts";

let env: TempAgentEnv;
beforeEach(() => {
	env = tempAgentDir();
	resetModuleState();
});
afterEach(() => {
	stopTaglineReveal();
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
	function install(options: { projectTrusted?: boolean } = {}): { tui: FakeTuiHarness; ctx: FakeCtxHarness; component: Component } {
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
		const pi = createFakePi({
			commandsInfo: [
				{
					name: "my-skill",
					source: "skill",
					sourceInfo: { path: "/skills/my-skill/SKILL.md", source: "skill", scope: "user", origin: "top-level" },
				},
			],
		});
		installHeader(pi.pi, ctx.ctx);
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
		writePreferences({ menuGate: "on", taglineReveal: "off", backgroundColor: "rainbow" });
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
});
