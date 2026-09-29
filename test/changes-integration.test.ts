import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import piStartupGreeter from "../index.ts";
import { renderChangesBlock, resolveSummaryModel, stopSummaryStream, summaryStream } from "../src/changes-summary.ts";
import { writePreferences } from "../src/preferences.ts";
import { state } from "../src/state.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { deferred } from "./helpers/deferred.ts";
import { createFakeCtx, makeAssistantMessage, makeModel, type FakeCtxHarness } from "./helpers/fake-ctx.ts";
import { createFakePi, type FakePiHarness } from "./helpers/fake-api.ts";
import { createFakeTui, type FakeTuiHarness } from "./helpers/fake-tui.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { bootstrapGlobalTheme, makeTheme } from "./helpers/theme.ts";
import { until } from "./helpers/wait.ts";

bootstrapGlobalTheme();

let env: TempAgentEnv;
beforeEach(() => {
	env = tempAgentDir();
	resetModuleState();
});
afterEach(() => {
	resetModuleState();
	env.restore();
});

interface Harness {
	pi: FakePiHarness;
	ctx: FakeCtxHarness;
	tui: FakeTuiHarness;
}

function makeHarness(options: {
	changesSummary?: "on" | "off";
	taglineReveal?: "on" | "off";
	projectTrusted?: boolean;
	model?: ReturnType<typeof makeModel>;
	models?: ReturnType<typeof makeModel>[];
	streamSimple?: NonNullable<Parameters<typeof createFakeCtx>[0]["streamSimple"]>;
} = {}): Harness {
	writePreferences({
		menuGate: "off",
		taglineReveal: options.taglineReveal ?? "off",
		backgroundColor: "rainbow",
		gradientAnimation: "off",
		changesSummary: options.changesSummary ?? "off",
	});
	const tui = createFakeTui({ rows: 40, columns: 100 });
	const model = options.model ?? makeModel("session", "model-a");
	const ctx = createFakeCtx({
		cwd: env.cwd,
		theme: makeTheme(),
		tui: tui.tui,
		model,
		models: options.models ?? [model],
		projectTrusted: options.projectTrusted ?? false,
		streamSimple: options.streamSimple,
	});
	const pi = createFakePi({
		execHandler: (_command, args) => {
			if (args.includes("rev-parse")) return { stdout: `${env.cwd}\n`, stderr: "", code: 0, killed: false };
			if (args.includes("status")) return { stdout: " M changed.ts\0?? new.ts\0D  deleted.ts\0", stderr: "", code: 0, killed: false };
			if (args.includes("--numstat")) return { stdout: "1\t1\tchanged.ts\0", stderr: "", code: 0, killed: false };
			if (args.includes("changed.ts")) return { stdout: "@@\n+changed\n", stderr: "", code: 0, killed: false };
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	});
	piStartupGreeter(pi.pi);
	return { pi, ctx, tui };
}

async function startup(harness: Harness): Promise<void> {
	await harness.pi.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx.ctx);
}

function mountedHeader(harness: Harness): Component {
	const factory = harness.ctx.setHeaderCalls[0] as (tui: unknown, theme: unknown) => Component;
	return factory(harness.tui.tui, makeTheme());
}

describe("startup changes lifecycle", () => {
	it("does not run git or the model when disabled or untrusted", async () => {
		const disabled = makeHarness({ changesSummary: "off", projectTrusted: true });
		await startup(disabled);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(disabled.pi.execCalls.length, 0);
		assert.equal(disabled.ctx.streamCalls.length, 0);
		assert.equal(state.changes, null);

		resetModuleState();
		const untrusted = makeHarness({ changesSummary: "on", projectTrusted: false });
		await startup(untrusted);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(untrusted.pi.execCalls.length, 0);
		assert.equal(untrusted.ctx.streamCalls.length, 0);
		assert.equal(state.changes, null);
	});

	it("publishes the listing before the deferred summary and keeps it after completion", async () => {
		const response = deferred<ReturnType<typeof makeAssistantMessage>>();
		const harness = makeHarness({
			changesSummary: "on",
			taglineReveal: "on",
			projectTrusted: true,
			streamSimple: async () => response.promise,
		});
		await startup(harness);
		const header = mountedHeader(harness);
		await until(() => state.changes !== null);
		await until(() => harness.ctx.streamCalls.length === 1);
		assert.ok(state.changes);
		const pendingText = header.render(100).map(sanitizeTuiText).join("\n");
		assert.match(pendingText, /\[local changes\] \+/);
		assert.match(pendingText, /\+|~/);
		assert.match(pendingText, /summarizing local changes with session\/model-a/);
		assert.equal(harness.ctx.streamCalls[0]?.options?.reasoning, undefined);
		assert.equal(harness.ctx.streamCalls[0]?.options?.maxTokens, 400);

		response.resolve(makeAssistantMessage("Added a new path and changed the existing implementation."));
		await until(() => state.changes?.summary.status === "done");
		assert.notEqual(summaryStream.timer, null, "the summary streams rather than landing whole");
		assert.equal(header.render(100).map(sanitizeTuiText).join("\n").includes("Added a new path"), false);
		stopSummaryStream();
		const doneText = header.render(100).map(sanitizeTuiText).join("\n");
		assert.equal((doneText.match(/\[local changes\]/g) ?? []).length, 1);
		assert.ok(doneText.includes("Added a new path"));
		assert.ok(doneText.includes("changed.ts"));
	});

	it("falls back from a missing configured model to the session model", () => {
		const model = makeModel("session", "model-a");
		const tui = createFakeTui();
		const ctx = createFakeCtx({ cwd: env.cwd, theme: makeTheme(), tui: tui.tui, model, models: [model] });
		const resolved = resolveSummaryModel(ctx.ctx, { provider: "missing", id: "model-b" });
		assert.equal("reason" in resolved, false);
		if (!("reason" in resolved)) {
			assert.equal(resolved.model, model);
			assert.equal(resolved.label, "session/model-a");
		}
	});
});

describe("changes-only header", () => {
	it("renders nothing for a clean state and exact-width rows for a presentation", () => {
		const presentation = {
			entries: [{ path: "src/file.ts", kind: "changed" as const, untracked: false }],
			summary: { status: "failed" as const, reason: "request failed" },
			version: 1,
		};
		assert.deepEqual(renderChangesBlock(makeTheme(), null, 80, 20), []);
		assert.ok(renderChangesBlock(makeTheme(), presentation, 80, 20).every((line) => line.length > 0));
	});
});
