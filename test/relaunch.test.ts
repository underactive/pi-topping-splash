import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildRelaunchArgs, GATE_DONE_ENV, relaunchPi } from "../src/relaunch.ts";
import { setArgv } from "./helpers/env.ts";
import { createFakeCtx } from "./helpers/fake-ctx.ts";
import { createFakeTui } from "./helpers/fake-tui.ts";
import { makeTheme } from "./helpers/theme.ts";

let restoreArgv: (() => void) | undefined;
afterEach(() => {
	restoreArgv?.();
	restoreArgv = undefined;
});

describe("constants (X-01)", () => {
	it("match the README-documented env guard", () => {
		assert.equal(GATE_DONE_ENV, "PI_SPLASH_GATE_DONE");
	});
});

describe("buildRelaunchArgs (X-02, X-03, X-04)", () => {
	it("strips conflicting value flags together with their values", () => {
		restoreArgv = setArgv([
			"--model", "old-model",
			"--provider", "old-provider",
			"--session", "/old.jsonl",
			"--session-dir", "/old-dir",
			"--thinking", "low",
			"--skill", "my-skill",
			"--verbose",
		]);
		const args = buildRelaunchArgs({ session: "/new.jsonl" });
		for (const leaked of ["old-model", "old-provider", "/old.jsonl", "/old-dir", "low", "--provider", "--session-dir", "--thinking"]) {
			assert.equal(args.includes(leaked), false, `leaked ${leaked}: ${JSON.stringify(args)}`);
		}
		assert.deepEqual(
			args.filter((a) => ["--skill", "my-skill", "--verbose"].includes(a)),
			["--skill", "my-skill", "--verbose"],
			"unrelated args preserved in order",
		);
		const sessionIndex = args.indexOf("--session");
		assert.ok(sessionIndex >= 0);
		assert.equal(args[sessionIndex + 1], "/new.jsonl");
		assert.equal(args.filter((a) => a === "--session").length, 1);
	});

	it("strips = forms and value-less toggles without eating neighbors", () => {
		restoreArgv = setArgv([
			"positional prompt",
			"--model=old-model",
			"-r",
			"--resume",
			"-c",
			"--continue",
			"--models", "m1,m2",
			"--no-extensions",
		]);
		const args = buildRelaunchArgs({});
		for (const leaked of ["--model=old-model", "-r", "--resume", "-c", "--continue", "--models", "m1,m2"]) {
			assert.equal(args.includes(leaked), false, `leaked ${leaked}: ${JSON.stringify(args)}`);
		}
		assert.ok(args.includes("positional prompt"), `positional lost: ${JSON.stringify(args)}`);
		assert.ok(args.includes("--no-extensions"), `--no-extensions lost: ${JSON.stringify(args)}`);
	});

	it("preserves the README-named skill/extension selection unchanged", () => {
		restoreArgv = setArgv([
			"--skill", "alpha",
			"--extension", "/e.ts",
			"--no-skills",
			"--no-extensions",
		]);
		const args = buildRelaunchArgs({});
		assert.deepEqual(args, ["--skill", "alpha", "--extension", "/e.ts", "--no-skills", "--no-extensions"]);
	});

	it("appends gate overrides (model shape INFERRED as provider/id)", () => {
		restoreArgv = setArgv(["--verbose"]);
		const args = buildRelaunchArgs({
			session: "/pick.jsonl",
			model: { id: "claude-opus-4", provider: "anthropic" },
			thinking: "high",
		});
		assert.ok(args.includes("--verbose"));
		assert.equal(args[args.indexOf("--session") + 1], "/pick.jsonl");
		assert.ok(args.includes("--thinking"));
		assert.equal(args[args.indexOf("--thinking") + 1], "high");
		const modelIndex = args.indexOf("--model");
		assert.ok(modelIndex >= 0, `no --model: ${JSON.stringify(args)}`);
		const modelValue = args[modelIndex + 1] ?? "";
		assert.ok(modelValue.includes("anthropic"), `model value: ${modelValue}`);
		assert.ok(modelValue.includes("claude-opus-4"), `model value: ${modelValue}`);
	});

	it("no override appends nothing beyond the preserved args", () => {
		restoreArgv = setArgv(["--verbose"]);
		assert.deepEqual(buildRelaunchArgs({}), ["--verbose"]);
	});
});

describe("relaunchPi guard (X-05)", () => {
	it("with no entry point: notifies an error and touches nothing", () => {
		restoreArgv = setArgv(["--verbose"], "");
		const tui = createFakeTui();
		const ctx = createFakeCtx({ cwd: "/tmp", theme: makeTheme(), tui: tui.tui });
		relaunchPi(tui.tui, ctx.ctx, { session: "/x.jsonl" });
		assert.equal(ctx.notifications.length, 1);
		assert.equal(ctx.notifications[0]?.type, "error");
		assert.equal(tui.stopCount, 0, "TUI must not be stopped when the relaunch is refused");
		assert.equal(ctx.shutdownCount, 0, "pi must not be shut down when the relaunch is refused");
	});
});
