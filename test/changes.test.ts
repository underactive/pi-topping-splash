import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
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
	CHANGES_MAX_WIDTH,
	LISTING_MIN_ROWS,
	PATH_MIN_WIDTH,
	SUMMARY_MS_PER_CHAR,
	layoutChangesSection,
	renderChangesBlock,
	startSummaryStream,
	stopSummaryStream,
	summaryStream,
	type ChangesPresentation,
	type SummaryState,
} from "../src/changes-summary.ts";
import { SPLASH_MARGIN_X } from "../src/splash.ts";
import { REVEAL_MS_PER_CHAR, REVEAL_TICK_MS } from "../src/reveal.ts";
import { changesRenderState } from "../src/state.ts";
import { createFakePi } from "./helpers/fake-api.ts";
import { initRepo, mixedChanges, git } from "./helpers/git.ts";
import { bootstrapGlobalTheme, makeTheme } from "./helpers/theme.ts";
import { enableTimers } from "./helpers/timers.ts";
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
		for (const path of [".env", ".env.local", "id_ed25519", "server.pem", ".npmrc", "credentials.json", "client-secret.txt", "secrets/app.yaml", ".ssh/config", "infra/terraform.tfstate", "infra/prod.tfvars"]) {
			assert.equal(isSensitivePath(path), true, path);
		}
		assert.equal(isSensitivePath("src/config.ts"), false);
		const redacted = redactSecrets("api_key=abc secret: xyz AKIA1234567890ABCDEF ghp_abcdefghijklmnopqrstuv sk-abcdefghijklmnopqrst xoxb-secret");
		assert.equal(redacted.includes("abc"), false);
		assert.equal(redacted.includes("xyz"), false);
		assert.equal(redacted.includes("AKIA"), false);
		assert.equal(redacted.includes("ghp_"), false);
		const suffixed = redactSecrets(
			"SECRET_KEY = 'django insecure abc def'\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG\nstripe=sk_live_abcdefghijklmnopqrstuv",
		);
		assert.equal(suffixed.includes("insecure"), false);
		assert.equal(suffixed.includes("def"), false);
		assert.equal(suffixed.includes("wJalr"), false);
		assert.equal(suffixed.includes("sk_live"), false);
	});

	it("redacts a private key whose END marker was truncated", () => {
		const redacted = redactSecrets("+-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAbase64body\nQWxhZGRpbjpvcGVu");
		assert.equal(redacted.includes("MIIEow"), false);
		assert.equal(redacted.includes("QWxhZGRpbjpvcGVu"), false);
	});

	it("leaves a long unbroken word-character run unchanged without backtracking blowup", () => {
		const blob = "Ab1_-".repeat(600);
		assert.equal(redactSecrets(blob), blob);
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
				if (args.includes("changed.txt")) return { stdout: `diff\n${"x".repeat(PER_FILE_DETAIL_BYTES + 100)}\nOVERSIZED_RECOGNIZABLE_SUFFIX`, stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
				},
			});
			const details = await collectChangeDetails(pi.pi, snapshot);
			assert.ok(Buffer.byteLength(details) <= DETAIL_BUDGET_BYTES);
			assert.ok(details.includes("new file: new.txt"));
			assert.equal(details.includes(".env"), false, "sensitive contents are omitted");
			const diffTargets = pi.bag.execCalls
				.filter(({ args }) => args.includes("--unified=1"))
				.map(({ args }) => args[args.length - 1]);
			assert.deepEqual(diffTargets, ["changed.txt", "changed.txt"]);
			assert.equal(diffTargets.includes("binary.bin"), false, "binary files do not receive per-path diffs");
			assert.equal(diffTargets.includes("too-large.txt"), false, "large files do not receive per-path diffs");
			const boundedExcerpt = `diff\n${"x".repeat(PER_FILE_DETAIL_BYTES - Buffer.byteLength("diff\n"))}\n… (truncated)`;
			assert.ok(details.includes(boundedExcerpt), "changed.txt excerpt is truncated at the per-file byte limit");
			assert.equal(details.includes("OVERSIZED_RECOGNIZABLE_SUFFIX"), false, "oversized diff suffix is omitted");

			const manyFiles = Array.from({ length: MAX_DIFF_FILES }, (_, index) => `1\t1\tfile-${index}.txt`).join("\0") + "\0";
			const totalLimitPi = createFakePi({
				execHandler: (_command, args) => args.includes("--numstat")
					? { stdout: manyFiles, stderr: "", code: 0, killed: false }
					: { stdout: "x".repeat(PER_FILE_DETAIL_BYTES), stderr: "", code: 0, killed: false },
			});
			const totalLimitedDetails = await collectChangeDetails(totalLimitPi.pi, { root, entries: [] });
			assert.equal(Buffer.byteLength(totalLimitedDetails), DETAIL_BUDGET_BYTES, "multiple excerpts are clipped at the total byte limit");
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

const pending: SummaryState = { status: "pending", modelLabel: "provider/model" };
/** Five entries across all three kinds, with line counts, a binary file, and an untracked file. */
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

describe("listing", () => {
	const theme = makeTheme();
	const plain = (lines: string[]) => lines.map(sanitizeTuiText);
	const rowFor = (lines: string[], path: string) => lines.find((line) => sanitizeTuiText(line).includes(` ${path} `)) ?? "";
	const fills = (row: string) => (sanitizeTuiText(row).match(/▇/g) ?? []).length;
	/** The summary's first row, which follows the last file row directly. */
	const summaryIndex = (lines: string[], head = "summarizing local changes with") => plain(lines).findIndex((line) => line.trimStart().startsWith(head));
	/** Narrowest width whose rows hold the whole `[local changes] +1, ~3, -1` heading between the margins. */
	const headingFrom = SPLASH_MARGIN_X * 2 + "[local changes] +1, ~3, -1".length;

	it("stops the listing and its summary at CHANGES_MAX_WIDTH on a wider terminal", () => {
		const long = counted({ status: "done", text: "One sentence about the change. ".repeat(20) });
		const clamped = renderChangesBlock(theme, long, CHANGES_MAX_WIDTH, 20);
		for (const width of [CHANGES_MAX_WIDTH, CHANGES_MAX_WIDTH + 1, 140, 200]) {
			const lines = renderChangesBlock(theme, long, width, 20);
			assertLinesExact(lines, CHANGES_MAX_WIDTH, `clamped width ${width}`);
			assert.deepEqual(lines, clamped, `width ${width} must render the clamped block`);
		}
		// The line counts end at the clamp's right margin, not the terminal's.
		const big = sanitizeTuiText(rowFor(renderChangesBlock(theme, counted(), 200, 20), "src/big.ts"));
		assert.equal(big.trimEnd().length, CHANGES_MAX_WIDTH - SPLASH_MARGIN_X, big);
		// The summary wraps at the clamp too, so no line runs past it however wide the terminal is.
		const summary = plain(renderChangesBlock(theme, long, 200, 20)).slice(summaryIndex(clamped, "One sentence"));
		assert.ok(summary.every((line) => visibleWidth(line.trimEnd()) <= CHANGES_MAX_WIDTH - SPLASH_MARGIN_X));
		assert.ok(summary.some((line) => line.trim().length > 0), "summary rows survive the clamp");
	});

	it("opens with a gap and a bracketed heading, and right-aligns the line counts, without a box, at every width", () => {
		for (let width = headingFrom; width <= 200; width++) {
			const lines = plain(renderChangesBlock(theme, counted(), width, 20));
			const blockWidth = Math.min(width, CHANGES_MAX_WIDTH);
			assert.equal(lines[0].trim(), "", `width ${width}: the gap`);
			assert.equal(lines[1].trimEnd(), `${" ".repeat(SPLASH_MARGIN_X)}[local changes] +1, ~3, -1`, `width ${width}`);
			assert.equal(lines.some((line) => /[┌┐└┘│]/.test(line)), false, `width ${width}: no box`);
			assert.equal(lines.some((line) => /▌|files/.test(line)), false, `width ${width}: no key row`);
			const big = rowFor(lines, "src/big.ts");
			if (big.includes("+30 -10")) assert.equal(big.trimEnd().length, blockWidth - SPLASH_MARGIN_X, `width ${width}: ${big}`);
		}
	});

	it("parts the last file row from the summary with a blank row, and no rule", () => {
		for (const width of [40, 60, 99, 100, 140]) {
			const lines = plain(renderChangesBlock(theme, counted(), width, 20));
			const index = summaryIndex(lines);
			assert.equal(lines[index - 1].trim(), "", `width ${width}: a blank row above the summary`);
			assert.ok(lines[index - 2].trim().startsWith("- gone.ts"), `width ${width}: under the last file row`);
			assert.equal(lines.some((line) => line.includes("─")), false, `width ${width}: no rule`);
		}
	});

	it("scales bars to the largest churn on screen and labels rows git has not counted", () => {
		const lines = renderChangesBlock(theme, counted(), 100, 20);
		assert.equal(fills(rowFor(lines, "src/big.ts")), BAR_CELLS);
		assert.equal(fills(rowFor(lines, "src/small.ts")), 1, "a one-line edit keeps a cell");
		assert.equal(fills(rowFor(lines, "gone.ts")), 2);
		assert.equal(fills(rowFor(lines, "image.png")), 0);
		assert.equal(fills(rowFor(lines, "new.ts")), 0);
		assert.match(sanitizeTuiText(rowFor(lines, "src/big.ts")), /\+30 -10 *$/);
		assert.match(sanitizeTuiText(rowFor(lines, "src/small.ts")), / {2}\+1 -0 *$/);
		assert.match(sanitizeTuiText(rowFor(lines, "gone.ts")), / {2}\+0 -4 *$/);
		assert.match(sanitizeTuiText(rowFor(lines, "image.png")), / {4}bin *$/);
		assert.match(sanitizeTuiText(rowFor(lines, "new.ts")), / {4}new *$/);
	});

	it("heads the listing like the panel's sections, and paints markers in the dimmed statusline git colors and line counts in text/error", () => {
		const dark = renderChangesBlock(makeTheme(), counted(), 100, 20);
		assert.ok(dark[1].includes(`${theme.fg("warning", "[local changes]")} ${theme.fg("text", "+1, ~3, -1")}`), "heading in warning, counts in text");
		assert.ok(rowFor(dark, "new.ts").includes("\x1b[38;2;64;112;7m+"), "added marker");
		assert.ok(rowFor(dark, "gone.ts").includes("\x1b[38;2;158;42;52m-"), "deleted marker");
		const big = rowFor(dark, "src/big.ts");
		assert.ok(big.includes("\x1b[38;2;136;112;7m~"), "changed marker");
		assert.ok(big.includes("\x1b[38;2;232;232;232m+30") && big.includes("\x1b[38;2;224;96;96m-10"), "line counts match the bar halves");
		assert.ok(big.includes("\x1b[38;2;232;232;232m▇") && big.includes("\x1b[38;2;224;96;96m▇"), "bars use the theme's text/error");
		// Light themes dim the markers toward the paper plate instead of the statusline's near-black bar.
		const light = renderChangesBlock(makeTheme({ text: "#202020" }), counted(), 100, 20);
		assert.ok(rowFor(light, "new.ts").includes("\x1b[38;2;152;201;99m+"));
		assert.ok(rowFor(light, "src/big.ts").includes("\x1b[38;2;224;201;99m~"));
		assert.ok(rowFor(light, "gone.ts").includes("\x1b[38;2;246;131;144m-"));
	});

	it("keeps every listing row in place when the line counts or the summary land", () => {
		const bare: ChangesPresentation = {
			...counted(),
			entries: counted().entries.map((entry) => ({ path: entry.path, kind: entry.kind, untracked: entry.untracked })),
		};
		const done = counted({ status: "done", text: "One sentence about the change. ".repeat(20) });
		for (const maxRows of [LISTING_MIN_ROWS + 1, 6, 9, 12, 20]) {
			const before = renderChangesBlock(theme, bare, 100, maxRows);
			const after = renderChangesBlock(theme, counted(), 100, maxRows);
			const summarized = renderChangesBlock(theme, done, 100, maxRows);
			const index = summaryIndex(after);
			assert.ok(index > 0, `maxRows ${maxRows}`);
			assert.equal(summaryIndex(before), index, `maxRows ${maxRows}`);
			assert.equal(summaryIndex(summarized, "One sentence"), index, `maxRows ${maxRows}`);
			assert.deepEqual(summarized.slice(0, index), after.slice(0, index), `maxRows ${maxRows}`);
			assert.ok(summarized.length <= maxRows, `maxRows ${maxRows}`);
		}
	});

	it("gives up the bars, then the line counts, as the width shrinks", () => {
		// Both margins; then the marker, the kept path columns, and the widest count.
		const statsFrom = SPLASH_MARGIN_X * 2 + 2 + PATH_MIN_WIDTH + "+30 -10".length + 1;
		const barsFrom = statsFrom + BAR_MIN_CELLS + 1;
		const at = (width: number) => renderChangesBlock(theme, counted(), width, 20);
		assert.equal(plain(at(statsFrom - 1)).join("\n").includes("+30 -10"), false);
		assert.ok(plain(at(statsFrom)).join("\n").includes("+30 -10"));
		assert.equal(fills(rowFor(at(barsFrom - 1), "src/big.ts")), 0);
		assert.equal(fills(rowFor(at(barsFrom), "src/big.ts")), BAR_MIN_CELLS);
		assert.equal(fills(rowFor(at(statsFrom + BAR_CELLS + 1), "src/big.ts")), BAR_CELLS);
		const narrow = plain(at(statsFrom - 1)).join("\n");
		assert.ok(narrow.includes("[local changes]") && narrow.includes("src/big.ts"), "the heading and paths outlast the counts");
	});

	it("keeps visible paths whole before the bars take any room", () => {
		const path = "src/deeply/nested/module.ts";
		const long: ChangesPresentation = {
			...counted(),
			entries: [...counted().entries, { path, kind: "changed", untracked: false, stat: { added: 2, deleted: 1, binary: false } }],
		};
		for (let width = headingFrom; width <= 120; width++) {
			const text = plain(renderChangesBlock(theme, long, width, 20)).join("\n");
			if (text.includes("▇")) assert.ok(text.includes(` ${path} `), `width ${width}: bars truncated the path`);
		}
		// Both margins; the marker; the whole path; the narrowest bar; the widest count.
		const barsFrom = SPLASH_MARGIN_X * 2 + 2 + path.length + 1 + BAR_MIN_CELLS + 1 + "+30 -10".length;
		assert.equal(plain(renderChangesBlock(theme, long, barsFrom - 1, 20)).join("\n").includes("▇"), false);
		assert.ok(fills(rowFor(renderChangesBlock(theme, long, barsFrom, 20), path)) > 0);
	});

	it("uses a single preview line, under the gap when a row allows, when the listing will not fit", () => {
		const presentation = counted({ status: "done", text: "Refactors the uncommitted block into\na compact summary." });
		for (let maxRows = 1; maxRows <= LISTING_MIN_ROWS; maxRows++) {
			const lines = renderChangesBlock(theme, presentation, 120, maxRows);
			assert.equal(lines.length, maxRows > 1 ? 2 : 1, `budget ${maxRows}`);
			if (maxRows > 1) assert.equal(plain(lines)[0].trim(), "", `budget ${maxRows}: the gap`);
			// 120 columns clamps to CHANGES_MAX_WIDTH, so the preview takes only what the clamp leaves.
			assert.equal(plain(lines).at(-1), "   [local changes] +1, ~3, -1 · ~ src/big.ts +30 -10 · Refactors the uncommitted block into a com...");
			assertLinesExact(lines, CHANGES_MAX_WIDTH, `compact budget ${maxRows}`);
		}
		assert.deepEqual(renderChangesBlock(theme, presentation, 120, 0), []);
		const minimal = plain(renderChangesBlock(theme, counted(), 100, LISTING_MIN_ROWS + 1)).map((line) => line.trimEnd());
		assert.deepEqual(minimal, [
			"",
			"   [local changes] +1, ~3, -1",
			"   … 5 more",
			"",
			"   summarizing local changes with provider/model…",
		]);
	});

	it("mirrors the one-line mockup with the heading, its counts, a featured file, and a dim summary", () => {
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
		assert.equal(sanitizeTuiText(line), "   [local changes] +3, ~4, -3 · ~ src/changes-summary.ts +12 · Refactors the uncommitted block in...");
		assert.ok(line.includes(`${theme.fg("warning", "[local changes]")} ${theme.fg("text", "+3, ~4, -3")}`));
		assert.ok(line.includes("\x1b[38;2;136;112;7m~"), "the featured marker keeps its git color");
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
				for (let maxRows = 1; maxRows <= LISTING_MIN_ROWS; maxRows++) {
					const lines = renderChangesBlock(theme, presentation, width, maxRows);
					assert.equal(lines.length, maxRows > 1 ? 2 : 1);
					assertLinesExact(lines, Math.min(width, CHANGES_MAX_WIDTH), `compact width ${width}, rows ${maxRows}`);
					assert.equal(lines.some((line) => line.includes("\n") || line.includes("\u001b[31m")), false);
				}
			}
		}
		const pending = plain(renderChangesBlock(theme, bare, 100, 1))[0];
		assert.ok(pending.includes(" · + new.ts new · summarizing local changes with provider/model…"), pending);
		const compact = renderChangesBlock(theme, counted(), 100, 1)[0];
		assert.ok(plain([compact])[0].includes(" · ~ src/big.ts +30 -10"));
		assert.ok(compact.includes("\x1b[38;2;232;232;232m+30") && compact.includes("\x1b[38;2;224;96;96m-10"), "compact line counts match the bar halves");
		assert.ok(plain(renderChangesBlock(theme, failed, 100, 1))[0].includes("summary unavailable: broken provider secret"));
		assert.ok(plain(renderChangesBlock(theme, done, 100, 1))[0].includes("A very long summary"));

		const headingAndCounts = "   [local changes] +1, ~3, -1";
		assert.equal(plain(renderChangesBlock(theme, done, headingAndCounts.length, 1))[0], headingAndCounts, "the whole counts take priority over the file and preview");
		const noCounts = plain(renderChangesBlock(theme, done, headingAndCounts.length - 1, 1))[0];
		assert.ok(noCounts.startsWith("   [local changes] · "), `never cut the counts in half: ${noCounts}`);
	});
});

describe("panel section (CS-05)", () => {
	const theme = makeTheme();
	const plain = (lines: string[]) => lines.map(sanitizeTuiText);
	/** The summary's first row, which follows the last file row directly. */
	const summaryIndex = (lines: string[], head = "summarizing local changes with") => plain(lines).findIndex((line) => line.trimStart().startsWith(head));
	const bare: ChangesPresentation = {
		...counted(),
		entries: counted().entries.map(({ path, kind, untracked }) => ({ path, kind, untracked })),
	};
	const failed = counted({ status: "failed", reason: "broken\nprovider \u001b[31msecret" });
	const long = counted({ status: "done", text: "One sentence about the change. ".repeat(20) });
	const crowded: ChangesPresentation = {
		...counted(),
		entries: Array.from({ length: 30 }, (_, index) => ({ path: `src/deeply/nested/module-${index}.ts`, kind: "changed" as const, untracked: false, stat: { added: index, deleted: 1, binary: false } })),
	};

	it("yields nothing without a presentation, a row, or a column", () => {
		assert.deepEqual(layoutChangesSection(theme, null, 68, 20), []);
		assert.deepEqual(layoutChangesSection(theme, counted(), 68, 0), []);
		assert.deepEqual(layoutChangesSection(theme, counted(), 0, 20), []);
	});

	it("lays out a gap, the heading, file rows, and the summary flush with the panel's text", () => {
		const lines = plain(layoutChangesSection(theme, counted(), 68, 20));
		lines.forEach((line, index) => assert.equal(visibleWidth(line), 68, `row ${index}: ${line}`));
		assert.deepEqual(lines.map((line) => line.trimEnd()).filter((line, index) => index < 2 || index > 6), [
			"",
			"[local changes] +1, ~3, -1",
			"",
			"summarizing local changes with provider/model…",
		]);
		assert.match(lines[2], /^\+ new\.ts +[·]+ +new$/);
		assert.match(lines[4], /^~ src\/big\.ts +▇+ \+30 -10$/);
		assert.match(lines[6], /^- gone\.ts +▇▇·+ +\+0 -4$/);
	});

	it("spends a row budget on the gap first, then the listing once LISTING_MIN_ROWS fit below it", () => {
		const shape = (rows: number) => {
			const lines = plain(layoutChangesSection(theme, counted(), 68, rows));
			return { rows: lines.length, gap: lines.length > 1 && lines[0].trim() === "", listed: lines.some((line) => line.trimEnd() === "[local changes] +1, ~3, -1") };
		};
		assert.deepEqual(shape(1), { rows: 1, gap: false, listed: false });
		for (let rows = 2; rows <= LISTING_MIN_ROWS; rows++) assert.deepEqual(shape(rows), { rows: 2, gap: true, listed: false }, `rows ${rows}`);
		assert.deepEqual(shape(LISTING_MIN_ROWS + 1), { rows: LISTING_MIN_ROWS + 1, gap: true, listed: true });
		assert.equal(plain(layoutChangesSection(theme, counted(), 68, 1))[0], "[local changes] +1, ~3, -1 · ~ src/big.ts +30 -10 · summarizing l...");
	});

	it("never spends more rows than it is given", () => {
		for (let rows = 1; rows <= 40; rows++) {
			assert.ok(layoutChangesSection(theme, crowded, 68, rows).length <= rows, `rows ${rows}`);
		}
	});

	it("keeps every listing row in place when the line counts or the summary land", () => {
		for (const rows of [LISTING_MIN_ROWS + 1, 7, 9, 12, 20]) {
			const before = layoutChangesSection(theme, bare, 68, rows);
			const after = layoutChangesSection(theme, counted(), 68, rows);
			const summarized = layoutChangesSection(theme, long, 68, rows);
			const index = summaryIndex(after);
			assert.ok(index > 0, `rows ${rows}`);
			assert.equal(summaryIndex(before), index, `rows ${rows}`);
			assert.equal(summaryIndex(summarized, "One sentence"), index, `rows ${rows}`);
			assert.deepEqual(summarized.slice(0, index), after.slice(0, index), `rows ${rows}`);
			assert.ok(summarized.length <= rows, `rows ${rows}`);
		}
	});

	it("never resets the plate's background, and fills the width at every width and budget", () => {
		// Any reset, default-background, or background color would punch a hole in the plate mid-row.
		const clobbersPlate = /\x1b\[(?:0?|49|48[;0-9]*)m/;
		for (const presentation of [bare, counted(), failed, long, crowded]) {
			for (const rows of [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 20]) {
				for (let width = 1; width <= 200; width++) {
					layoutChangesSection(theme, presentation, width, rows).forEach((line, index) => {
						assert.equal(clobbersPlate.test(line), false, `rows ${rows}, width ${width}, line ${index}: ${JSON.stringify(line)}`);
						assert.equal(visibleWidth(line), width, `rows ${rows}, width ${width}, line ${index}`);
					});
				}
			}
		}
	});
});

describe("summary stream (CS-06)", () => {
	const theme = makeTheme();
	const plain = (lines: string[]) => lines.map(sanitizeTuiText);
	const text = "Streams the summary one character at a time, like a chat reply.";
	const done = () => counted({ status: "done", text });
	/** The summary rows of the panel section: everything after the gap, the heading, the five file rows, and the blank row. */
	const summaryRows = (width = 68) => plain(layoutChangesSection(theme, done(), width, 20)).slice(8).map((line) => line.trimEnd());
	afterEach(() => {
		stopSummaryStream();
		changesRenderState.requestRender = null;
	});

	it("streams twice as fast as the tagline reveal, on the reveal's tick", () => {
		assert.equal(SUMMARY_MS_PER_CHAR, REVEAL_MS_PER_CHAR / 2);
	});

	it("is settled until a summary lands, so a done summary renders whole", () => {
		assert.equal(summaryStream.timer, null);
		assert.equal(summaryStream.shown, Number.POSITIVE_INFINITY);
		assert.equal(summaryRows()[0], text);
	});

	it("prints nothing as the summary lands, then one character per SUMMARY_MS_PER_CHAR, settling on the whole text", (t) => {
		const timers = enableTimers(t);
		startSummaryStream(text);
		assert.equal(summaryRows().join(""), "");
		for (let i = 0; i < 10; i++) timers.tick(REVEAL_TICK_MS);
		assert.equal(summaryRows()[0], text.slice(0, (10 * REVEAL_TICK_MS) / SUMMARY_MS_PER_CHAR).trimEnd());
		for (let i = 0; i < text.length; i++) timers.tick(REVEAL_TICK_MS);
		assert.equal(summaryStream.timer, null, "the stream stops itself once the text is out");
		assert.equal(summaryStream.shown, Number.POSITIVE_INFINITY);
		assert.equal(summaryRows()[0], text);
	});

	it("keeps the section's rows fixed while the text streams in, wrapped as the whole text", (t) => {
		const timers = enableTimers(t);
		const settledRows = summaryRows(30);
		const settledLength = layoutChangesSection(theme, done(), 30, 20).length;
		assert.ok(settledRows.length > 1, "the text wraps at 30 columns");
		startSummaryStream(text);
		while (summaryStream.timer) {
			assert.equal(layoutChangesSection(theme, done(), 30, 20).length, settledLength, `shown ${summaryStream.shown}`);
			summaryRows(30).forEach((row, index) => assert.ok(settledRows[index].startsWith(row), `shown ${summaryStream.shown}, row ${index}: ${row}`));
			timers.tick(REVEAL_TICK_MS);
		}
		assert.deepEqual(summaryRows(30), settledRows);
	});

	it("pauses across an event-loop block instead of printing the rest at once", (t) => {
		const timers = enableTimers(t);
		startSummaryStream(text);
		for (let i = 0; i < 5; i++) timers.tick(REVEAL_TICK_MS);
		const before = summaryStream.shown;
		timers.tick(2000);
		assert.notEqual(summaryStream.timer, null, "a block pauses the stream, not finishes it");
		assert.ok(summaryStream.shown - before <= 4, `a 2000ms block printed ${summaryStream.shown - before} characters`);
	});

	it("bumps the tick and requests a repaint on every tick, and once more when it settles", (t) => {
		const timers = enableTimers(t);
		let renders = 0;
		changesRenderState.requestRender = () => {
			renders++;
		};
		// Two characters a tick: six take three ticks, the last of which settles.
		startSummaryStream("abcdef");
		const tick = summaryStream.tick;
		timers.tick(REVEAL_TICK_MS);
		timers.tick(REVEAL_TICK_MS);
		assert.equal(summaryStream.tick, tick + 2);
		assert.equal(renders, 2);
		timers.tick(REVEAL_TICK_MS);
		assert.equal(summaryStream.timer, null);
		assert.equal(summaryStream.tick, tick + 3, "settling bumps the tick for the final repaint");
		assert.equal(renders, 3);
	});

	it("settles at once on stopSummaryStream, idempotently", (t) => {
		enableTimers(t);
		startSummaryStream(text);
		stopSummaryStream();
		assert.equal(summaryStream.timer, null);
		assert.equal(summaryRows()[0], text);
		const tick = summaryStream.tick;
		stopSummaryStream();
		assert.equal(summaryStream.tick, tick, "a second stop does nothing");
	});

	it("streams the one-line preview too, leaving the heading and featured file whole", (t) => {
		const timers = enableTimers(t);
		startSummaryStream(text);
		const preview = () => plain(renderChangesBlock(theme, done(), 100, 1))[0].trimEnd();
		assert.equal(preview(), "   [local changes] +1, ~3, -1 · ~ src/big.ts +30 -10");
		for (let i = 0; i < 4; i++) timers.tick(REVEAL_TICK_MS);
		assert.equal(preview(), "   [local changes] +1, ~3, -1 · ~ src/big.ts +30 -10 · Streams");
	});

	it("leaves pending and failed lines alone while a stream runs", (t) => {
		enableTimers(t);
		startSummaryStream(text);
		const lines = (summary: SummaryState) => plain(layoutChangesSection(theme, counted(summary), 68, 20)).slice(8).map((line) => line.trimEnd());
		assert.deepEqual(lines({ status: "pending", modelLabel: "provider/model" }), ["summarizing local changes with provider/model…"]);
		assert.deepEqual(lines({ status: "failed", reason: "timed out" }), ["summary unavailable: timed out"]);
	});
});
