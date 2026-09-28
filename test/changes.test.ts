import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	DETAIL_BUDGET_BYTES,
	MAX_DIFF_FILES,
	MAX_PROMPT_PATHS,
	PER_FILE_DETAIL_BYTES,
	buildSummaryPrompt,
	collectChangeDetails,
	collectChanges,
	isSensitivePath,
	parseStatusZ,
	redactSecrets,
	type ChangeSnapshot,
} from "../src/changes.ts";
import { renderChangesBlock, type ChangesPresentation } from "../src/changes-summary.ts";
import { createFakePi } from "./helpers/fake-api.ts";
import { initRepo, mixedChanges, git } from "./helpers/git.ts";
import { bootstrapGlobalTheme, makeTheme } from "./helpers/theme.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { assertLinesExact } from "./helpers/width.ts";

bootstrapGlobalTheme();

describe("parseStatusZ", () => {
	it("categorizes porcelain records and sorts by kind then path", () => {
		const stdout = [
			"?? untracked.txt", "A  added.txt", "AM added-modified.txt", " M changed-worktree.txt", "M  staged-modified.txt",
			"MM both.txt", " D deleted-worktree.txt", "D  staged-deleted.txt", "AD add-delete.txt", "UU conflict.txt",
			"AA add-add.txt", "DD delete-delete.txt", " T type-change.txt",
		].join("\0") + "\0";
		const entries = parseStatusZ(stdout);
		assert.deepEqual(new Map(entries.map((entry) => [entry.path, [entry.kind, entry.untracked]])), new Map([
			["added.txt", ["added", false]],
			["added-modified.txt", ["added", false]],
			["untracked.txt", ["added", true]],
			["add-add.txt", ["changed", false]],
			["add-delete.txt", ["added", false]],
			["both.txt", ["changed", false]],
			["changed-worktree.txt", ["changed", false]],
			["conflict.txt", ["changed", false]],
			["delete-delete.txt", ["changed", false]],
			["staged-modified.txt", ["changed", false]],
			["type-change.txt", ["changed", false]],
			["deleted-worktree.txt", ["deleted", false]],
			["staged-deleted.txt", ["deleted", false]],
		]));
		assert.deepEqual(entries.map((entry) => entry.kind), ["added", "added", "added", "added", "changed", "changed", "changed", "changed", "changed", "changed", "changed", "deleted", "deleted"]);
	});

	it("merges staged delete plus an untracked recreation and preserves unusual paths", () => {
		const entries = parseStatusZ("D  same.txt\0?? same.txt\0 M spaced name-λ\nnext\0");
		assert.deepEqual(new Map(entries.map((entry) => [entry.path, [entry.kind, entry.untracked]])), new Map([
			["spaced name-λ\nnext", ["changed", false]],
			["same.txt", ["changed", true]],
		]));
	});
});

describe("git collection", () => {
	it("matches real git porcelain output for a mixed repository", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-splash-git-"));
		try {
			initRepo(root, { "tracked.txt": "base\n", "deleted.txt": "delete\n" });
			mixedChanges(root);
			const status = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames");
			const entries = parseStatusZ(status);
			assert.deepEqual(entries.map((entry) => [entry.path, entry.kind]), [
				["staged.txt", "added"],
				["untracked.txt", "added"],
				["tracked.txt", "changed"],
				["deleted.txt", "deleted"],
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("discovers the repository root from a subdirectory and stays silent on failures", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-splash-collector-"));
		try {
			const subdir = join(root, "nested");
			initRepo(root, { "tracked.txt": "base\n" });
			writeFileSync(join(root, "changed.txt"), "new\n");
			const pi = createFakePi({
				execHandler: (_command, args) => {
					if (args.includes("rev-parse")) return { stdout: `${root}\n`, stderr: "", code: 0, killed: false };
					return { stdout: "?? changed.txt\0", stderr: "", code: 0, killed: false };
				},
			});
			const snapshot = await collectChanges(pi.pi, subdir);
			assert.deepEqual(snapshot, { root, entries: [{ path: "changed.txt", kind: "added", untracked: true }] });
			assert.deepEqual(pi.bag.execCalls.map((call) => call.args.slice(-1)[0]), ["--show-toplevel", "--no-renames"]);

			const clean = createFakePi({
				execHandler: (_command, args) => args.includes("rev-parse")
					? { stdout: `${root}\n`, stderr: "", code: 0, killed: false }
					: { stdout: "", stderr: "", code: 0, killed: false },
			});
			assert.deepEqual(await collectChanges(clean.pi, root), { root, entries: [] });

			const failed = createFakePi({ execHandler: () => ({ stdout: "", stderr: "", code: 128, killed: false }) });
			assert.equal(await collectChanges(failed.pi, root), undefined);
			const killed = createFakePi({ execHandler: () => ({ stdout: "", stderr: "", code: 0, killed: true }) });
			assert.equal(await collectChanges(killed.pi, root), undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("sensitive paths and bounded details", () => {
	it("recognizes credential-like basenames and redacts common secrets", () => {
		for (const path of [".env", ".env.local", "id_ed25519", "server.pem", ".npmrc", "credentials.json", "client-secret.txt"]) {
			assert.equal(isSensitivePath(path), true, path);
		}
		assert.equal(isSensitivePath("src/config.ts"), false);
		const redacted = redactSecrets("api_key=abc secret: xyz AKIA1234567890ABCDEF ghp_abcdefghijklmnopqrstuv sk-abcdefghijklmnopqrst xoxb-secret");
		assert.equal(redacted.includes("abc"), false);
		assert.equal(redacted.includes("xyz"), false);
		assert.equal(redacted.includes("AKIA"), false);
		assert.equal(redacted.includes("ghp_"), false);
	});

	it("skips binary/huge candidates and bounds per-file and total excerpts", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-splash-details-"));
		try {
			writeFileSync(join(root, "new.txt"), "plain untracked head\n");
			const snapshot: ChangeSnapshot = {
				root,
				entries: [
					{ path: "changed.txt", kind: "changed", untracked: false },
					{ path: "new.txt", kind: "added", untracked: true },
					{ path: ".env", kind: "added", untracked: true },
				],
			};
			const pi = createFakePi({
				execHandler: (_command, args) => {
					if (args.includes("--numstat")) return {
						stdout: `5\t5\tchanged.txt\0-\t-\tbinary.bin\u0000500\t0\ttoo-large.txt\0`, stderr: "", code: 0, killed: false,
					};
				if (args.includes("changed.txt")) return { stdout: `diff\n${"x".repeat(PER_FILE_DETAIL_BYTES + 100)}\napi_key=hidden`, stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
				},
			});
			const details = await collectChangeDetails(pi.pi, snapshot);
			assert.ok(Buffer.byteLength(details) <= DETAIL_BUDGET_BYTES);
			assert.ok(details.includes("new file: new.txt"));
			assert.equal(details.includes(".env"), false, "sensitive contents are omitted");
			assert.ok(pi.bag.execCalls.length <= 2 + MAX_DIFF_FILES + MAX_DIFF_FILES, "bounded command count");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("summary prompt and rendering", () => {
	it("includes categorized paths, excerpts, and a bounded path list", () => {
		const entries = Array.from({ length: MAX_PROMPT_PATHS + 3 }, (_, index) => ({
			path: `file-${index}.ts`, kind: "changed" as const, untracked: false,
		}));
		const prompt = buildSummaryPrompt({ root: "/tmp/repo", entries }, "diff excerpt");
		assert.ok(prompt.systemPrompt.includes("3 sentences"));
		assert.ok(prompt.text.includes("<files>"));
		assert.ok(prompt.text.includes("diff excerpt"));
		assert.ok(prompt.text.includes("… and 3 more"));
		assert.equal(prompt.text.split("\n").filter((line) => line.startsWith("changed: ")).length, MAX_PROMPT_PATHS);
	});

	it("keeps file rows stable as the summary changes and fills every width", () => {
		const base = {
			entries: [
				{ path: "added.ts", kind: "added" as const, untracked: false },
				{ path: "src/changed.ts", kind: "changed" as const, untracked: false },
				{ path: "deleted.ts", kind: "deleted" as const, untracked: false },
			],
			version: 1,
		};
		const pending: ChangesPresentation = { ...base, summary: { status: "pending", modelLabel: "provider/model" } };
		const done: ChangesPresentation = { ...base, summary: { status: "done", text: "The change summary is deliberately long enough to wrap across rows." } };
		const pendingText = pending.entries.map((entry) => entry.path);
		const pendingLinesAtWidth = (presentation: ChangesPresentation, width: number) =>
			renderChangesBlock(makeTheme(), presentation, width, 20).map(sanitizeTuiText).join("\n");
		for (let width = 1; width <= 200; width++) {
			const pendingLines = renderChangesBlock(makeTheme(), pending, width, 20);
			const doneLines = renderChangesBlock(makeTheme(), done, width, 20);
			assertLinesExact(pendingLines, width, `pending width ${width}`);
			assertLinesExact(doneLines, width, `done width ${width}`);
			assert.ok(pendingLines.length <= 20);
			assert.ok(doneLines.length <= 20);
		}
		for (const path of pendingText) {
			const pendingTextRendered = pendingLinesAtWidth(pending, 80);
			const doneTextRendered = pendingLinesAtWidth(done, 80);
			assert.equal(pendingTextRendered.includes(path), true);
			assert.equal(doneTextRendered.includes(path), true);
		}
		const overflow: ChangesPresentation = {
			...pending,
			entries: Array.from({ length: 20 }, (_, index) => ({ path: `file-${index}`, kind: "changed" as const, untracked: false })),
		};
		assert.ok(renderChangesBlock(makeTheme(), overflow, 80, 12).map(sanitizeTuiText).join("\n").includes("more"));
	});

	it("sanitizes escape and control characters in paths", () => {
		const presentation: ChangesPresentation = {
			entries: [{ path: "bad\u001b[31mpath\u0007\u0001\tname\nnext", kind: "added", untracked: true }],
			summary: { status: "pending", modelLabel: "provider/model" },
			version: 1,
		};
		const rendered = renderChangesBlock(makeTheme(), presentation, 80, 20);
		assertLinesExact(rendered, 80, "sanitized path");
		assert.equal(rendered.some((line) => line.includes("\u001b[31m") || line.includes("\u0007") || line.includes("\u0001") || line.includes("\t")), false);
		assert.equal(rendered.length, renderChangesBlock(makeTheme(), { ...presentation, entries: [{ ...presentation.entries[0], path: "badpathnamenext" }] }, 80, 20).length);
		assert.equal(sanitizeTuiText(rendered.join("\n")).includes("badpathnamenext"), true);
	});

	it("never exceeds the requested maxRows", () => {
		const pending: ChangesPresentation = {
			entries: Array.from({ length: 20 }, (_, index) => ({ path: `file-${index}`, kind: "changed" as const, untracked: false })),
			summary: { status: "pending", modelLabel: "provider/model" },
			version: 1,
		};
		const done: ChangesPresentation = { ...pending, summary: { status: "done", text: "A long summary that wraps across rows." } };
		for (let maxRows = 0; maxRows <= 20; maxRows++) {
			for (const presentation of [pending, done]) {
				const lines = renderChangesBlock(makeTheme(), presentation, 80, maxRows);
				assert.ok(lines.length <= maxRows, `maxRows ${maxRows} produced ${lines.length} lines`);
				assertLinesExact(lines, 80, `maxRows ${maxRows}`);
			}
		}
		assert.deepEqual(renderChangesBlock(makeTheme(), null, 80, 0), []);
	});
});
