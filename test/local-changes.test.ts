import assert from "node:assert/strict";
import { setImmediate as waitTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
import piStartupGreeter from "../index.ts";
import { layoutChangesSection, startSummaryStream, stopSummaryStream, summaryStream } from "../src/changes-summary.ts";
import { panelBg, RESET, sgrBg } from "../src/color.ts";
import {
	LOCAL_CHANGES_COMMAND,
	LOCAL_CHANGES_ENTRY_TYPE,
	LOCAL_CHANGES_FILE_ROWS_MAX,
	isLocalChangesEntryData,
	renderLocalChangesEntry,
	type LocalChangesEntryData,
} from "../src/local-changes.ts";
import { writePreferences } from "../src/preferences.ts";
import { buildHeaderParts, PANEL_MAX_WIDTH } from "../src/splash.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { setEnv, tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { deferred } from "./helpers/deferred.ts";
import { createFakeCtx, makeAssistantMessage, makeModel, type FakeCtxHarness } from "./helpers/fake-ctx.ts";
import { createFakePi, type FakePiBag, type FakePiHarness } from "./helpers/fake-api.ts";
import { createFakeTui, type FakeTuiHarness } from "./helpers/fake-tui.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { bootstrapGlobalTheme, makeTheme } from "./helpers/theme.ts";
import { assertLinesExact } from "./helpers/width.ts";
import { until } from "./helpers/wait.ts";

bootstrapGlobalTheme();

let env: TempAgentEnv;
let restoreGateEnv: () => void;
beforeEach(() => {
	env = tempAgentDir();
	restoreGateEnv = setEnv("PI_SPLASH_GATE_DONE", undefined);
	resetModuleState();
});
afterEach(() => {
	resetModuleState();
	restoreGateEnv();
	env.restore();
});

interface Harness {
	pi: FakePiHarness;
	ctx: FakeCtxHarness;
	tui: FakeTuiHarness;
}

function makeGitHandler(status: string | null, numstat = "1\t1\tchanged.ts\0"): FakePiBag["execHandler"] {
	return (_command, args) => {
		if (args.includes("rev-parse")) return status === null
			? { stdout: "", stderr: "not a repository", code: 128, killed: false }
			: { stdout: `${env.cwd}\n`, stderr: "", code: 0, killed: false };
		if (args.includes("status")) return { stdout: status ?? "", stderr: "", code: 0, killed: false };
		if (args.includes("--numstat")) return { stdout: numstat, stderr: "", code: 0, killed: false };
		if (args.includes("changed.ts")) return { stdout: "@@\n+changed\n", stderr: "", code: 0, killed: false };
		return { stdout: "", stderr: "", code: 0, killed: false };
	};
}

function makeHarness(options: {
	status?: string | null;
	numstat?: string;
	execHandler?: FakePiBag["execHandler"];
	mode?: string;
	hasUI?: boolean;
	projectTrusted?: boolean;
	model?: ReturnType<typeof makeModel> | null;
	models?: ReturnType<typeof makeModel>[];
	streamSimple?: NonNullable<Parameters<typeof createFakeCtx>[0]["streamSimple"]>;
} = {}): Harness {
	const tui = createFakeTui({ rows: 40, columns: 100 });
	const model = options.model === null ? undefined : options.model ?? makeModel("session", "model-a");
	const ctx = createFakeCtx({
		cwd: env.cwd,
		theme: makeTheme(),
		tui: tui.tui,
		model,
		models: options.models ?? (model ? [model] : []),
		streamSimple: options.streamSimple,
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		projectTrusted: options.projectTrusted ?? true,
	});
	const pi = createFakePi({
		execHandler: options.execHandler ?? makeGitHandler(options.status === undefined ? " M changed.ts\0" : options.status, options.numstat),
	});
	piStartupGreeter(pi.pi);
	return { pi, ctx, tui };
}

async function callLocalChanges(harness: Harness, args = ""): Promise<void> {
	await harness.pi.commands.get(LOCAL_CHANGES_COMMAND)!.handler(args, harness.ctx.ctx as never);
}

function fixtureData(summary = "A short model summary."): Extract<LocalChangesEntryData, { kind: "changes" }> {
	return {
		kind: "changes",
		entries: [
			{ path: "src/changed.ts", kind: "changed", untracked: false, stat: { added: 12, deleted: 3, binary: false } },
			{ path: "src/new.ts", kind: "added", untracked: true },
		],
		summary: { status: "done", text: summary },
	};
}

function getEntryData(harness: Harness): LocalChangesEntryData {
	const appended = harness.pi.appendedEntries[0];
	assert.ok(appended, "one custom entry must be appended");
	assert.equal(appended.customType, LOCAL_CHANGES_ENTRY_TYPE);
	assert.ok(isLocalChangesEntryData(appended.data), "entry data must pass the validator");
	return appended.data;
}

function renderRegisteredEntry(harness: Harness, data: unknown, width = 100): string[] | undefined {
	const renderer = harness.pi.entryRenderers.get(LOCAL_CHANGES_ENTRY_TYPE);
	assert.ok(renderer, "the entry renderer must be registered");
	const entry: CustomEntry<unknown> = {
		type: "custom",
		id: "entry-id",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: LOCAL_CHANGES_ENTRY_TYPE,
		data,
	};
	const component = renderer(entry, {} as never, harness.ctx.bag.theme);
	return component?.render(width);
}

function rendered(lines: string[]): string {
	return lines.map(sanitizeTuiText).join("\n");
}

function subcommands(harness: Harness): string[] {
	return harness.pi.execCalls.map((call) => call.args[3] ?? "");
}

describe("/local-changes contracts", () => {
	it("LC-01 registers the command and renderer with the display-only description", () => {
		const harness = makeHarness();
		const command = harness.pi.commands.get(LOCAL_CHANGES_COMMAND);
		assert.ok(command);
		assert.match(command.description ?? "", /never sent to the model/);
		assert.ok(harness.pi.entryRenderers.has(LOCAL_CHANGES_ENTRY_TYPE));
	});

	it("LC-02 appends a settled dirty-tree entry after the background summary", async () => {
		const response = deferred<ReturnType<typeof makeAssistantMessage>>();
		const harness = makeHarness({
			status: " M changed.ts\0?? new.ts\0D  deleted.ts\0",
			streamSimple: async () => response.promise,
		});
		const handler = callLocalChanges(harness);
		await handler;
		await until(() => harness.ctx.streamCalls.length === 1);
		assert.equal(harness.pi.appendedEntries.length, 0, "the handler returns before the detached summary finishes");
		response.resolve(makeAssistantMessage("SUMMARY-SENTINEL: changed.ts gained one line."));
		await until(() => harness.pi.appendedEntries.length === 1);

		const data = getEntryData(harness);
		assert.equal(data.kind, "changes");
		if (data.kind !== "changes") return;
		assert.equal(data.entries.length, 3);
		assert.equal(data.entries.find((entry) => entry.path === "changed.ts")?.stat?.added, 1);
		assert.equal(data.summary.status, "done");
		const text = rendered(renderRegisteredEntry(harness, data)!);
		assert.match(text, /\[local changes\] \+1, ~1, -1/);
		assert.match(text, /changed\.ts/);
		assert.match(text, /new\.ts/);
		assert.match(text, /deleted\.ts/);
		assert.match(text, /▇/);
		assert.match(text, /\+1 -1/);
		assert.match(text, /new/);
		assert.match(text, /SUMMARY-SENTINEL: changed\.ts gained one line\./);
		assert.deepEqual(harness.pi.sentMessages, []);
	});

	it("LC-03 reports both pending statuses and clears the footer status", async () => {
		const response = deferred<ReturnType<typeof makeAssistantMessage>>();
		const harness = makeHarness({ streamSimple: async () => response.promise });
		await callLocalChanges(harness);
		await until(() => harness.ctx.streamCalls.length === 1);
		assert.equal(harness.ctx.statusCalls[0]?.text, "collecting local changes…");
		assert.ok(harness.ctx.statusCalls.some((call) => call.text === "summarizing local changes with session/model-a…"));
		assert.equal(harness.pi.appendedEntries.length, 0);
		response.resolve(makeAssistantMessage("Summary complete."));
		await until(() => harness.pi.appendedEntries.length === 1);
		assert.deepEqual(harness.ctx.statusCalls.at(-1), { key: "pi-topping-splash:local-changes", text: undefined });
	});

	it("LC-04 appends a clean entry without summary or diff calls", async () => {
		const harness = makeHarness({ status: "" });
		await callLocalChanges(harness);
		await until(() => harness.pi.appendedEntries.length === 1);
		assert.deepEqual(getEntryData(harness), { kind: "clean" });
		assert.match(rendered(renderRegisteredEntry(harness, { kind: "clean" })!), /\[local changes\][\s\S]*none/);
		assert.equal(harness.ctx.streamCalls.length, 0);
		assert.equal(harness.pi.execCalls.length, 2);
		assert.equal(subcommands(harness).filter((subcommand) => subcommand === "diff").length, 0);
		assert.equal(harness.pi.execCalls.filter((call) => call.args.includes("--numstat")).length, 0);
		assert.equal(subcommands(harness).filter((subcommand) => subcommand === "status").length, 1);
		assert.equal(harness.ctx.statusCalls.at(-1)?.text, undefined);
	});

	it("LC-05 appends an unavailable entry after one failed rev-parse", async () => {
		const harness = makeHarness({ status: null });
		await callLocalChanges(harness);
		await until(() => harness.pi.appendedEntries.length === 1);
		assert.deepEqual(getEntryData(harness), { kind: "unavailable" });
		assert.match(rendered(renderRegisteredEntry(harness, { kind: "unavailable" })!), /not a git repository, or git is unavailable/);
		assert.equal(harness.ctx.streamCalls.length, 0);
		assert.equal(harness.pi.execCalls.length, 1);
		assert.deepEqual(subcommands(harness), ["rev-parse"]);
	});

	it("LC-06 reports failures and retries empty answers with the shared summary flow", async () => {
		const thrown = makeHarness({ streamSimple: async () => { throw new Error("provider failed"); } });
		await callLocalChanges(thrown);
		await until(() => thrown.pi.appendedEntries.length === 1);
		const thrownData = getEntryData(thrown);
		assert.equal(thrownData.kind, "changes");
		if (thrownData.kind === "changes") {
			assert.deepEqual(thrownData.summary, { status: "failed", reason: "provider failed" });
			assert.equal(thrownData.entries.length, 1);
		}

		const errorStop = makeHarness({ streamSimple: async () => makeAssistantMessage("", "error", "provider refused") });
		await callLocalChanges(errorStop);
		await until(() => errorStop.pi.appendedEntries.length === 1);
		const errorData = getEntryData(errorStop);
		assert.equal(errorData.kind, "changes");
		if (errorData.kind === "changes") assert.deepEqual(errorData.summary, { status: "failed", reason: "provider refused" });
		assert.equal(errorStop.ctx.streamCalls.length, 1);

		let emptyCalls = 0;
		const empty = makeHarness({ streamSimple: async () => {
			emptyCalls++;
			return makeAssistantMessage("");
		} });
		await callLocalChanges(empty);
		await until(() => empty.pi.appendedEntries.length === 1);
		const emptyData = getEntryData(empty);
		assert.equal(empty.ctx.streamCalls.length, 4);
		assert.equal(emptyCalls, 4);
		assert.equal(emptyData.kind, "changes");
		if (emptyData.kind === "changes") {
			assert.deepEqual(emptyData.summary, { status: "failed", reason: "empty response" });
			assert.equal(emptyData.entries.length, 1);
		}

		let retryCalls = 0;
		const retry = makeHarness({ streamSimple: async () => {
			retryCalls++;
			return retryCalls === 1 ? makeAssistantMessage("") : makeAssistantMessage("Recovered summary.");
		} });
		await callLocalChanges(retry);
		await until(() => retry.pi.appendedEntries.length === 1);
		const retryData = getEntryData(retry);
		assert.equal(retry.ctx.streamCalls.length, 2);
		assert.equal(retryData.kind, "changes");
		if (retryData.kind === "changes") {
			assert.deepEqual(retryData.summary, { status: "done", text: "Recovered summary." });
			assert.equal(retryData.entries.length, 1);
		}
	});

	it("LC-07 uses the configured model even when startup summaries are off", async () => {
		const sessionModel = makeModel("session", "model-a");
		const configuredModel = makeModel("configured", "model-b");
		writePreferences({
			menuGate: "off",
			taglineReveal: "off",
			backgroundColor: "rainbow",
			gradientAnimation: "off",
			changesSummary: "off",
			changesSummaryModel: { provider: "configured", id: "model-b" },
		});
		const configured = makeHarness({
			model: sessionModel,
			models: [sessionModel, configuredModel],
			streamSimple: async () => makeAssistantMessage("Configured model summary."),
		});
		await callLocalChanges(configured);
		await until(() => configured.pi.appendedEntries.length === 1);
		assert.equal(configured.ctx.streamCalls.length, 1);
		assert.equal(configured.ctx.streamCalls[0]?.model, configuredModel);
		const configuredData = getEntryData(configured);
		assert.equal(configuredData.kind, "changes");
		if (configuredData.kind === "changes") assert.deepEqual(configuredData.summary, { status: "done", text: "Configured model summary." });

		const fallback = makeHarness({
			model: sessionModel,
			models: [sessionModel],
			streamSimple: async () => makeAssistantMessage("Session model summary."),
		});
		await callLocalChanges(fallback);
		await until(() => fallback.pi.appendedEntries.length === 1);
		assert.equal(fallback.ctx.streamCalls.length, 1);
		assert.equal(fallback.ctx.streamCalls[0]?.model, sessionModel);

		const noModel = makeHarness({ model: null });
		await callLocalChanges(noModel);
		await until(() => noModel.pi.appendedEntries.length === 1);
		assert.equal(noModel.ctx.streamCalls.length, 0);
		const noModelData = getEntryData(noModel);
		assert.equal(noModelData.kind, "changes");
		if (noModelData.kind === "changes") assert.deepEqual(noModelData.summary, { status: "failed", reason: "no model selected" });
	});

	it("LC-08 ignores arguments and applies mode, trust, single-flight, and shutdown guards", async () => {
		const withArgs = makeHarness({ status: "" });
		await callLocalChanges(withArgs, "ignored arguments");
		await until(() => withArgs.pi.appendedEntries.length === 1);
		assert.deepEqual(getEntryData(withArgs), { kind: "clean" });

		const noTui = makeHarness({ mode: "rpc", hasUI: false });
		await callLocalChanges(noTui);
		assert.equal(noTui.ctx.notifications[0]?.type, "error");
		assert.equal(noTui.pi.execCalls.length, 0);
		assert.equal(noTui.pi.appendedEntries.length, 0);

		const untrusted = makeHarness({ projectTrusted: false });
		await callLocalChanges(untrusted);
		assert.equal(untrusted.ctx.notifications[0]?.type, "warning");
		assert.equal(untrusted.pi.execCalls.length, 0);
		assert.equal(untrusted.pi.appendedEntries.length, 0);

		const pending = deferred<Awaited<ReturnType<FakePiBag["execHandler"]>>>();
		const duplicate = makeHarness({ execHandler: () => pending.promise });
		await callLocalChanges(duplicate);
		await until(() => duplicate.pi.execCalls.length === 1);
		await callLocalChanges(duplicate);
		assert.equal(duplicate.ctx.notifications.at(-1)?.type, "info");
		assert.equal(duplicate.pi.execCalls.length, 1);
		pending.resolve({ stdout: "", stderr: "not a repository", code: 128, killed: false });
		await until(() => duplicate.pi.appendedEntries.length === 1);

		const afterShutdown = deferred<Awaited<ReturnType<FakePiBag["execHandler"]>>>();
		const shuttingDown = makeHarness({ execHandler: () => afterShutdown.promise });
		await callLocalChanges(shuttingDown);
		await until(() => shuttingDown.pi.execCalls.length === 1);
		await shuttingDown.pi.emit("session_shutdown", { type: "session_shutdown" }, shuttingDown.ctx.ctx);
		assert.equal(shuttingDown.ctx.statusCalls.at(-1)?.text, undefined);
		afterShutdown.resolve({ stdout: `${env.cwd}\n`, stderr: "", code: 0, killed: false });
		await waitTurn();
		assert.deepEqual(shuttingDown.pi.appendedEntries, []);
	});

	it("LC-09 uses only read-only git subcommands with the required prefix", async () => {
		const harness = makeHarness({
			status: " M changed.ts\0?? new.ts\0D  deleted.ts\0",
			streamSimple: async () => makeAssistantMessage("Read-only summary."),
		});
		await callLocalChanges(harness);
		await until(() => harness.pi.appendedEntries.length === 1);
		assert.ok(harness.pi.execCalls.length > 0);
		for (const call of harness.pi.execCalls) {
			assert.equal(call.command, "git");
			assert.deepEqual(call.args.slice(0, 3), ["--no-optional-locks", "-c", "core.fsmonitor=false"]);
			assert.ok(["rev-parse", "status", "diff"].includes(call.args[3] ?? ""));
		}
	});

	it("LC-10 excludes custom entries from context after append, compaction, and JSON reload", () => {
		const data = fixtureData("SUMMARY-SENTINEL");
		const session = SessionManager.inMemory(env.cwd);
		const before: UserMessage = { role: "user", content: "USER-PROMPT-BEFORE", timestamp: Date.now() };
		session.appendMessage(before);
		session.appendMessage(makeAssistantMessage("ASSISTANT-CONTEXT-REPLY"));
		const customId = session.appendCustomEntry(LOCAL_CHANGES_ENTRY_TYPE, data);
		session.appendMessage({ role: "user", content: "USER-PROMPT-AFTER", timestamp: Date.now() });
		const contextText = JSON.stringify(session.buildSessionContext().messages);
		assert.ok(contextText.includes("USER-PROMPT-BEFORE"));
		assert.ok(contextText.includes("USER-PROMPT-AFTER"));
		assert.ok(contextText.includes("ASSISTANT-CONTEXT-REPLY"));
		assert.equal(contextText.includes("SUMMARY-SENTINEL"), false);
		assert.equal(contextText.includes("changed.ts"), false);
		assert.equal(contextText.includes("[local changes]"), false);
		assert.ok(session.getEntries().some((entry) => entry.type === "custom" && entry.id === customId));

		const compacted = SessionManager.inMemory(env.cwd);
		compacted.appendMessage({ role: "user", content: "BEFORE-COMPACTION-PROMPT", timestamp: Date.now() });
		const compactedId = compacted.appendCustomEntry(LOCAL_CHANGES_ENTRY_TYPE, data);
		compacted.appendCompaction("COMPACTION-SUMMARY", compactedId, 0);
		compacted.appendMessage({ role: "user", content: "AFTER-COMPACTION-PROMPT", timestamp: Date.now() });
		const compactedText = JSON.stringify(compacted.buildSessionContext().messages);
		assert.equal(compactedText.includes("SUMMARY-SENTINEL"), false);
		assert.equal(compactedText.includes("changed.ts"), false);

		const contrast = SessionManager.inMemory(env.cwd);
		contrast.appendCustomMessageEntry("test:message", "CUSTOM-MESSAGE-SENTINEL", true);
		assert.ok(JSON.stringify(contrast.buildSessionContext().messages).includes("CUSTOM-MESSAGE-SENTINEL"));

		const saved = JSON.parse(JSON.stringify(session.getEntries())) as SessionEntry[];
		const savedText = JSON.stringify(buildSessionContext(saved).messages);
		assert.equal(savedText.includes("SUMMARY-SENTINEL"), false);
		assert.equal(savedText.includes("changed.ts"), false);
		const savedEntry = saved.find((entry): entry is CustomEntry<unknown> => entry.type === "custom" && entry.customType === LOCAL_CHANGES_ENTRY_TYPE);
		assert.ok(savedEntry);
		assert.ok(isLocalChangesEntryData(savedEntry.data));
		assert.deepEqual(renderLocalChangesEntry(makeTheme(), data, 120), renderLocalChangesEntry(makeTheme(), savedEntry.data, 120));
	});

	it("LC-11 paints each transcript row verbatim inside the splash panel", () => {
		const theme = makeTheme();
		const data = fixtureData();
		const entryRows = renderLocalChangesEntry(theme, data, 120).slice(1, -1);
		const parts = buildHeaderParts(220, 80, theme, [], [], [], undefined, undefined, "rainbow", "off", 0, [], [], (band) => {
			assert.equal(band.width, 96);
			return layoutChangesSection(theme, { entries: data.entries, summary: data.summary, version: 0 }, band.width, Number.POSITIVE_INFINITY);
		});
		let previous = -1;
		for (const entryRow of entryRows) {
			const index = parts.lines.findIndex((line, row) => row > previous && line.includes(entryRow));
			assert.ok(index > previous, "entry rows remain in splash order with the same SGR");
			previous = index;
		}
	});

	it("LC-12 fits widths 1 to 200 on both plates and drops bars before counts", () => {
		for (const theme of [makeTheme(), makeTheme({ text: "#202020" })]) {
			const prefix = sgrBg(panelBg(theme));
			for (let width = 1; width <= 200; width++) {
				const lines = renderLocalChangesEntry(theme, fixtureData(), width);
				assertLinesExact(lines, Math.min(width, PANEL_MAX_WIDTH), `entry at width ${width}`);
				for (const line of lines) {
					assert.ok(line.startsWith(prefix));
					assert.ok(line.endsWith(RESET));
					assert.doesNotMatch(line.slice(prefix.length, -RESET.length), /\x1b\[(?:0|49|48;[0-9;]*)m/);
				}
			}
		}
		const theme = makeTheme();
		const presentation = { entries: fixtureData().entries, summary: fixtureData().summary, version: 0 };
		const wide = rendered(layoutChangesSection(theme, presentation, 80, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY));
		const narrow = rendered(layoutChangesSection(theme, presentation, 26, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY));
		assert.match(wide, /▇/);
		assert.doesNotMatch(narrow, /▇/);
		assert.match(narrow, /\+12/);
	});

	it("LC-13 shows the stored summary whole while the splash keeps streaming", () => {
		const theme = makeTheme();
		const fullSummary = "STREAM-SENTINEL-" + "x".repeat(50);
		const data = fixtureData(fullSummary);
		startSummaryStream("splash-stream-" + "x".repeat(50));
		assert.equal(summaryStream.shown, 0);
		assert.ok(rendered(renderLocalChangesEntry(theme, data, 100)).includes(fullSummary));
		const splash = rendered(layoutChangesSection(theme, { entries: data.entries, summary: data.summary, version: 0 }, 96, Number.POSITIVE_INFINITY));
		assert.equal(splash.includes("STREAM-SENTINEL"), false);
		stopSummaryStream();
	});

	it("LC-14 shows up to 20 paths, an extra overflow row, 6 summary rows, and 31 plate rows", () => {
		const entries = Array.from({ length: 25 }, (_, index) => ({ path: `src/file-${index}.ts`, kind: "changed" as const, untracked: false }));
		const summary = Array.from({ length: 20 }, (_, index) => `SUMMARY-${String(index).padStart(2, "0")}`).join("\n");
		const data: Extract<LocalChangesEntryData, { kind: "changes" }> = { kind: "changes", entries, summary: { status: "done", text: summary } };
		const section = layoutChangesSection(
			makeTheme(),
			{ entries, summary: data.summary, version: 0 },
			96,
			Number.POSITIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			LOCAL_CHANGES_FILE_ROWS_MAX,
			false,
		);
		const lines = rendered(section).split("\n");
		assert.equal(lines.filter((line) => /^[+~-] /.test(line)).length, LOCAL_CHANGES_FILE_ROWS_MAX);
		assert.match(lines[1] ?? "", /\[local changes\] ~25/);
		assert.ok(lines.some((line) => line.trim() === "… 5 more"));
		assert.equal(lines.filter((line) => line.startsWith("SUMMARY-")).length, 6);
		const plate = renderLocalChangesEntry(makeTheme(), data, 120);
		assert.equal(plate.length, 31);
		assert.match(rendered(plate), /… 5 more/);

		const boundaryLines = (count: number) => rendered(renderLocalChangesEntry(
			makeTheme(),
			{ ...data, entries: entries.slice(0, count) },
			120,
		)).split("\n");
		const exactlyTwenty = boundaryLines(LOCAL_CHANGES_FILE_ROWS_MAX);
		assert.equal(exactlyTwenty.filter((line) => /^[+~-] /.test(line.trimStart())).length, LOCAL_CHANGES_FILE_ROWS_MAX);
		assert.equal(exactlyTwenty.some((line) => line.trim() === "… 0 more"), false);
		const twentyOne = boundaryLines(LOCAL_CHANGES_FILE_ROWS_MAX + 1);
		assert.equal(twentyOne.filter((line) => /^[+~-] /.test(line.trimStart())).length, LOCAL_CHANGES_FILE_ROWS_MAX);
		assert.ok(twentyOne.some((line) => line.trim() === "… 1 more"));
	});

	it("LC-15 rejects malformed stored data and accepts a valid JSON round trip", () => {
		const harness = makeHarness();
		const malformed: unknown[] = [
			null,
			"not data",
			{ kind: "unknown" },
			{ kind: "changes", entries: [{ path: 4, kind: "changed", untracked: false }], summary: { status: "done", text: "x" } },
			{ kind: "changes", entries: [{ path: "x", kind: "changed", untracked: false }], summary: { status: "pending", modelLabel: "model" } },
			{ kind: "changes", entries: [{ path: "x", kind: "changed", untracked: false }] },
		];
		for (const data of malformed) {
			assert.doesNotThrow(() => renderRegisteredEntry(harness, data));
			assert.equal(renderRegisteredEntry(harness, data), undefined);
			assert.equal(isLocalChangesEntryData(data), false);
		}
		const valid = JSON.parse(JSON.stringify(fixtureData())) as unknown;
		assert.equal(isLocalChangesEntryData(valid), true);
		assert.ok(renderRegisteredEntry(harness, valid));
	});
});
