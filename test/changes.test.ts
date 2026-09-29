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
	collectLineStats,
	isSensitivePath,
	parseNumstatZ,
	parseStatusZ,
	redactSecrets,
	type ChangeSnapshot,
} from "../src/changes.ts";
import {
	BAR_CELLS,
	BAR_MIN_CELLS,
	BOX_MIN_ROWS,
	BOX_TITLE,
	CHANGES_MAX_WIDTH,
	PATH_MIN_WIDTH,
	renderChangesBlock,
	type ChangesPresentation,
	type SummaryState,
} from "../src/changes-summary.ts";
import { SPLASH_MARGIN_X } from "../src/splash.ts";
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

/** A fake pi whose exec runs real git, reporting a failed exit instead of throwing. */
function realGit(): ReturnType<typeof createFakePi> {
	return createFakePi({
		execHandler: (_command, args, options) => {
			try {
				return { stdout: git(options?.cwd ?? process.cwd(), ...args), stderr: "", code: 0, killed: false };
			} catch {
				return { stdout: "", stderr: "", code: 128, killed: false };
			}
		},
	});
}

describe("line counts", () => {
	it("parses text and binary numstat records and skips malformed ones", () => {
		const stats = parseNumstatZ("3\t1\tsrc/a.ts\0-\t-\timage.png\u00001\t0\tweird\tname\nnext\0x\t1\tbad.ts\0\t\tblank.ts\0no tabs\0");
		assert.deepEqual(Object.fromEntries(stats), {
			"src/a.ts": { added: 3, deleted: 1, binary: false },
			"image.png": { added: 0, deleted: 0, binary: true },
			"weird\tname\nnext": { added: 1, deleted: 0, binary: false },
		});
	});

	it("counts staged, unstaged, deleted, and binary paths against HEAD and leaves untracked paths out", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-splash-numstat-"));
		try {
			initRepo(root, { "tracked.txt": "base\n", "deleted.txt": "delete\n", "image.bin": "\u0000\u0001" });
			mixedChanges(root);
			writeFileSync(join(root, "image.bin"), Buffer.from([0, 2, 3]));
			const pi = realGit();
			const stats = await collectLineStats(pi.pi, root);
			assert.deepEqual(Object.fromEntries(stats ?? []), {
				"deleted.txt": { added: 0, deleted: 1, binary: false },
				"image.bin": { added: 0, deleted: 0, binary: true },
				"staged.txt": { added: 1, deleted: 0, binary: false },
				"tracked.txt": { added: 1, deleted: 0, binary: false },
			});
			assert.deepEqual(pi.bag.execCalls.map((call) => call.args.slice(3)), [
				["diff", "HEAD", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-renames"],
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("stays undefined for an unborn HEAD, killed git, and an aborted run", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-splash-unborn-"));
		try {
			initRepo(root, {});
			writeFileSync(join(root, "first.txt"), "first\n");
			git(root, "add", "first.txt");
			assert.equal(await collectLineStats(realGit().pi, root), undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
		const killed = createFakePi({ execHandler: () => ({ stdout: "1\t0\ta.ts\0", stderr: "", code: 0, killed: true }) });
		assert.equal(await collectLineStats(killed.pi, "/repo"), undefined);
		const aborted = createFakePi({});
		const controller = new AbortController();
		controller.abort();
		assert.equal(await collectLineStats(aborted.pi, "/repo", controller.signal), undefined);
		assert.equal(aborted.bag.execCalls.length, 0);
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
			const blockWidth = Math.min(width, CHANGES_MAX_WIDTH);
			assertLinesExact(pendingLines, blockWidth, `pending width ${width}`);
			assertLinesExact(doneLines, blockWidth, `done width ${width}`);
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

describe("boxed listing", () => {
	const theme = makeTheme();
	const pending: SummaryState = { status: "pending", modelLabel: "provider/model" };
	function counted(summary: SummaryState = pending): ChangesPresentation {
		return {
			entries: [
				{ path: "new.ts", kind: "added", untracked: true },
				{ path: "image.png", kind: "changed", untracked: false, stat: { added: 0, deleted: 0, binary: true } },
				{ path: "src/big.ts", kind: "changed", untracked: false, stat: { added: 30, deleted: 10, binary: false } },
				{ path: "src/small.ts", kind: "changed", untracked: false, stat: { added: 1, deleted: 0, binary: false } },
				{ path: "gone.ts", kind: "deleted", untracked: false, stat: { added: 0, deleted: 4, binary: false } },
			],
			summary,
			version: 1,
		};
	}
	const plain = (lines: string[]) => lines.map(sanitizeTuiText);
	const rowFor = (lines: string[], path: string) => lines.find((line) => sanitizeTuiText(line).includes(` ${path} `)) ?? "";
	const fills = (row: string) => (sanitizeTuiText(row).match(/▇/g) ?? []).length;
	/** Narrowest width whose box interior still fits the title between two rule stubs. */
	const boxFrom = SPLASH_MARGIN_X * 2 + 2 + BOX_TITLE.length + 2;

	it("stops the listing and its summary at CHANGES_MAX_WIDTH on a wider terminal", () => {
		const long = counted({ status: "done", text: "One sentence about the change. ".repeat(20) });
		const clamped = renderChangesBlock(theme, long, CHANGES_MAX_WIDTH, 20);
		for (const width of [CHANGES_MAX_WIDTH, CHANGES_MAX_WIDTH + 1, 140, 200]) {
			const lines = renderChangesBlock(theme, long, width, 20);
			assertLinesExact(lines, CHANGES_MAX_WIDTH, `clamped width ${width}`);
			assert.deepEqual(lines, clamped, `width ${width} must render the clamped block`);
		}
		// The box's right edge stops at the clamp, not the terminal's own right margin.
		const right = CHANGES_MAX_WIDTH - SPLASH_MARGIN_X - 1;
		const box = plain(renderChangesBlock(theme, counted(), 200, 20)).filter((line) => "┌│└".includes(line[SPLASH_MARGIN_X] ?? " "));
		assert.equal(box[0][right], "┐", box[0]);
		assert.equal(box.at(-1)![right], "┘", box.at(-1)!);
		// The summary wraps at the clamp too, so no line runs past it however wide the terminal is.
		const summary = plain(renderChangesBlock(theme, long, 200, 20)).filter((line) => !/[┌│└]/.test(line));
		assert.ok(summary.every((line) => visibleWidth(line) <= CHANGES_MAX_WIDTH));
		assert.ok(summary.some((line) => line.trim().length > 0), "summary rows survive the clamp");
	});

	it("draws the title, counts, key, and borders on one right edge at every width that fits the title", () => {
		for (let width = boxFrom; width <= 200; width++) {
			const lines = plain(renderChangesBlock(theme, counted(), width, 20));
			const right = Math.min(width, CHANGES_MAX_WIDTH) - SPLASH_MARGIN_X - 1;
			const box = lines.filter((line) => "┌│└".includes(line[SPLASH_MARGIN_X] ?? " "));
			assert.ok(box.length >= 3, `width ${width}`);
			assert.ok(box[0].startsWith(`${" ".repeat(SPLASH_MARGIN_X)}┌─${BOX_TITLE}─`), `width ${width}: ${box[0]}`);
			assert.equal(box[0][right], "┐", `width ${width}: ${box[0]}`);
			assert.equal(box.at(-1)![SPLASH_MARGIN_X], "└", `width ${width}`);
			assert.equal(box.at(-1)![right], "┘", `width ${width}`);
			for (const line of box.slice(1, -1)) {
				assert.equal(line[SPLASH_MARGIN_X], "│", `width ${width}: ${line}`);
				assert.equal(line[right], "│", `width ${width}: ${line}`);
			}
		}
		assert.equal(plain(renderChangesBlock(theme, counted(), boxFrom - 1, 20)).some((line) => line.includes("┌")), false);
		const wide = plain(renderChangesBlock(theme, counted(), 100, 20));
		assert.ok(wide.some((line) => line.includes("─+1 ~3 -1 ┐")), wide.join("\n"));
		assert.ok(wide.some((line) => /│ 5 files +▌ added {2}▌ removed │/.test(line)), wide.join("\n"));
	});

	it("scales bars to the largest churn on screen and labels rows git has not counted", () => {
		const lines = renderChangesBlock(theme, counted(), 100, 20);
		assert.equal(fills(rowFor(lines, "src/big.ts")), BAR_CELLS);
		assert.equal(fills(rowFor(lines, "src/small.ts")), 1, "a one-line edit keeps a cell");
		assert.equal(fills(rowFor(lines, "gone.ts")), 2);
		assert.equal(fills(rowFor(lines, "image.png")), 0);
		assert.equal(fills(rowFor(lines, "new.ts")), 0);
		assert.match(sanitizeTuiText(rowFor(lines, "src/big.ts")), /\+30 -10 │/);
		assert.match(sanitizeTuiText(rowFor(lines, "src/small.ts")), / {2}\+1 -0 │/);
		assert.match(sanitizeTuiText(rowFor(lines, "gone.ts")), / {2}\+0 -4 │/);
		assert.match(sanitizeTuiText(rowFor(lines, "image.png")), / {4}bin │/);
		assert.match(sanitizeTuiText(rowFor(lines, "new.ts")), / {4}new │/);
	});

	it("paints counts and markers in the dimmed statusline git colors, and the line counts in the theme's text", () => {
		const dark = renderChangesBlock(makeTheme(), counted(), 100, 20);
		assert.ok(dark.some((line) => line.includes("\x1b[38;2;64;112;7m+1") && line.includes("\x1b[38;2;136;112;7m~3") && line.includes("\x1b[38;2;158;42;52m-1")));
		const big = rowFor(dark, "src/big.ts");
		assert.ok(big.includes("\x1b[38;2;136;112;7m~"), "changed marker");
		assert.ok(big.includes("\x1b[38;2;232;232;232m+30") && big.includes("\x1b[38;2;232;232;232m-10"), "line counts");
		assert.ok(big.includes("\x1b[38;2;232;232;232m▇") && big.includes("\x1b[38;2;224;96;96m▇"), "bars use the theme's text/error");
		// Light themes dim toward the paper plate instead of the statusline's near-black bar.
		const light = renderChangesBlock(makeTheme({ text: "#202020" }), counted(), 100, 20);
		assert.ok(light.some((line) => line.includes("\x1b[38;2;152;201;99m+1") && line.includes("\x1b[38;2;224;201;99m~3") && line.includes("\x1b[38;2;246;131;144m-1")));
	});

	it("keeps every listing row in place when the line counts or the summary land", () => {
		const bare: ChangesPresentation = {
			...counted(),
			entries: counted().entries.map((entry) => ({ path: entry.path, kind: entry.kind, untracked: entry.untracked })),
		};
		const done = counted({ status: "done", text: "One sentence about the change. ".repeat(20) });
		const bottom = (lines: string[]) => plain(lines).findIndex((line) => line.includes("└"));
		for (const maxRows of [BOX_MIN_ROWS, 6, 9, 12, 20]) {
			const before = renderChangesBlock(theme, bare, 100, maxRows);
			const after = renderChangesBlock(theme, counted(), 100, maxRows);
			const summarized = renderChangesBlock(theme, done, 100, maxRows);
			assert.ok(bottom(after) > 0, `maxRows ${maxRows}`);
			assert.equal(bottom(before), bottom(after), `maxRows ${maxRows}`);
			assert.deepEqual(summarized.slice(0, bottom(after) + 1), after.slice(0, bottom(after) + 1), `maxRows ${maxRows}`);
			assert.ok(summarized.length <= maxRows, `maxRows ${maxRows}`);
		}
	});

	it("gives up the bars, then the line counts, then the box as the width shrinks", () => {
		// Margins, verticals, and gutters; then the marker, the kept path columns, and the widest count.
		const statsFrom = SPLASH_MARGIN_X * 2 + 4 + 2 + PATH_MIN_WIDTH + "+30 -10".length + 1;
		const barsFrom = statsFrom + BAR_MIN_CELLS + 1;
		const at = (width: number) => renderChangesBlock(theme, counted(), width, 20);
		assert.equal(plain(at(statsFrom - 1)).join("\n").includes("+30 -10"), false);
		assert.ok(plain(at(statsFrom)).join("\n").includes("+30 -10"));
		assert.equal(fills(rowFor(at(barsFrom - 1), "src/big.ts")), 0);
		assert.equal(fills(rowFor(at(barsFrom), "src/big.ts")), BAR_MIN_CELLS);
		assert.equal(fills(rowFor(at(statsFrom + BAR_CELLS + 1), "src/big.ts")), BAR_CELLS);
		const unboxed = plain(at(boxFrom - 1)).join("\n");
		assert.equal(/[┌│└]/.test(unboxed), false);
		assert.ok(unboxed.includes("uncommitted"));
	});

	it("keeps visible paths whole before the bars take any room", () => {
		const path = "src/deeply/nested/module.ts";
		const long: ChangesPresentation = {
			...counted(),
			entries: [...counted().entries, { path, kind: "changed", untracked: false, stat: { added: 2, deleted: 1, binary: false } }],
		};
		for (let width = boxFrom; width <= 120; width++) {
			const text = plain(renderChangesBlock(theme, long, width, 20)).join("\n");
			if (text.includes("▇")) assert.ok(text.includes(` ${path} `), `width ${width}: bars truncated the path`);
		}
		// Margins, verticals, and gutters; the marker; the whole path; the narrowest bar; the widest count.
		const barsFrom = SPLASH_MARGIN_X * 2 + 4 + 2 + path.length + 1 + BAR_MIN_CELLS + 1 + "+30 -10".length;
		assert.equal(plain(renderChangesBlock(theme, long, barsFrom - 1, 20)).join("\n").includes("▇"), false);
		assert.ok(fills(rowFor(renderChangesBlock(theme, long, barsFrom, 20), path)) > 0);
	});

	it("uses a single preview line when the smallest box will not fit, without changing the four-row box", () => {
		const presentation = counted({ status: "done", text: "Refactors the uncommitted block into\na compact summary." });
		for (let maxRows = 1; maxRows < BOX_MIN_ROWS; maxRows++) {
			const lines = renderChangesBlock(theme, presentation, 120, maxRows);
			assert.equal(lines.length, 1, `budget ${maxRows}`);
			// 120 columns clamps to CHANGES_MAX_WIDTH, so the preview takes only what the clamp leaves.
			assert.match(plain(lines)[0], /^ {3}● 5 uncommitted \[\+1 · ~3 · -1\] ~ src\/big\.ts \+30 -10 · Refactors the uncommitted block into a c\.\.\.$/);
			assert.equal(/[┌│└]|more/.test(plain(lines)[0]), false);
			assertLinesExact(lines, CHANGES_MAX_WIDTH, `compact budget ${maxRows}`);
		}
		assert.deepEqual(renderChangesBlock(theme, presentation, 120, 0), []);
		const minimal = plain(renderChangesBlock(theme, counted(), 100, BOX_MIN_ROWS));
		assert.equal(minimal.length, BOX_MIN_ROWS);
		assert.match(minimal[0], /┌─ uncommitted ─/);
		assert.match(minimal[1], /│ … 5 more +│/);
		assert.match(minimal[2], /└─+┘/);
		assert.match(minimal[3], /summarizing with provider\/model…/);
	});

	it("mirrors the one-line mockup with bracketed colored counts, a featured file, and a dim summary", () => {
		const presentation = counted({ status: "done", text: "Refactors the uncommitted block into a compact layout." });
		presentation.entries = [
			{ path: "other-new.ts", kind: "added", untracked: true },
			{ path: "second-new.ts", kind: "added", untracked: true },
			{ path: "third-new.ts", kind: "added", untracked: true },
			{ path: "src/changes-summary.ts", kind: "changed", untracked: false, stat: { added: 12, deleted: 0, binary: false } },
			{ path: "smaller.ts", kind: "changed", untracked: false, stat: { added: 2, deleted: 1, binary: false } },
			{ path: "another.ts", kind: "changed", untracked: false },
			{ path: "image.png", kind: "changed", untracked: false, stat: { added: 0, deleted: 0, binary: true } },
			{ path: "old-a.ts", kind: "deleted", untracked: false },
			{ path: "old-b.ts", kind: "deleted", untracked: false },
			{ path: "old-c.ts", kind: "deleted", untracked: false },
		];
		const line = renderChangesBlock(theme, presentation, 140, 1)[0];
		assert.match(sanitizeTuiText(line), /^ {3}● 10 uncommitted \[\+3 · ~4 · -3\] ~ src\/changes-summary\.ts \+12 · Refactors the uncommitted block\.\.\.$/);
		assert.ok(line.includes("\x1b[38;2;64;112;7m+3") && line.includes("\x1b[38;2;136;112;7m~4") && line.includes("\x1b[38;2;158;42;52m-3"));
		assert.ok(line.includes("\x1b[38;2;232;232;232m+12"));
		assert.ok(line.includes(theme.fg("dim", " · ")));
		// The clamp cuts the preview mid-sentence, so only its head survives; the dim role's opening
		// SGR still precedes it, with the truncation's own reset wrapping the ellipsis that follows.
		const dimSgr = theme.fg("dim", "x").slice(0, -"\x1b[39mx".length);
		assert.ok(line.includes(`${dimSgr}Refactors the uncommitted block`), "the summary preview is dim");
		assertLinesExact([line], CHANGES_MAX_WIDTH, "mockup line");
	});

	it("keeps the compact line bounded and safe as stats and summary states change", () => {
		const bare: ChangesPresentation = {
			...counted(),
			entries: counted().entries.map(({ path, kind, untracked }) => ({ path, kind, untracked })),
		};
		const failed = counted({ status: "failed", reason: "broken\nprovider \u001b[31msecret" });
		const done = counted({ status: "done", text: "A very long summary ".repeat(12) });
		for (const presentation of [bare, counted(), failed, done]) {
			for (let width = 1; width <= 200; width++) {
				for (let maxRows = 1; maxRows < BOX_MIN_ROWS; maxRows++) {
					const lines = renderChangesBlock(theme, presentation, width, maxRows);
					assert.equal(lines.length, 1);
					assertLinesExact(lines, Math.min(width, CHANGES_MAX_WIDTH), `compact width ${width}, rows ${maxRows}`);
					assert.equal(lines[0].includes("\n") || lines[0].includes("\u001b[31m"), false);
				}
			}
		}
		const pending = plain(renderChangesBlock(theme, bare, 100, 2))[0];
		assert.ok(pending.includes("+ new.ts new · summarizing with provider/model…"), pending);
		assert.ok(plain(renderChangesBlock(theme, counted(), 100, 2))[0].includes("~ src/big.ts +30 -10"));
		assert.ok(plain(renderChangesBlock(theme, failed, 100, 2))[0].includes("summary unavailable: broken provider secret"));
		assert.ok(plain(renderChangesBlock(theme, done, 100, 2))[0].includes("A very long summary"));

		const prefixAndCounts = "   ● 5 uncommitted [+1 · ~3 · -1]";
		const fitsCounts = plain(renderChangesBlock(theme, done, visibleWidth(prefixAndCounts), 1))[0];
		assert.equal(fitsCounts, prefixAndCounts, "the whole bracket takes priority over the file and preview");
		const noCounts = plain(renderChangesBlock(theme, done, visibleWidth(prefixAndCounts) - 1, 1))[0];
		assert.equal(noCounts.includes("[") || noCounts.includes("]"), false, "never cut the bracket in half");
	});
});
