import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The category assigned to an uncommitted path. */
export type ChangeKind = "added" | "changed" | "deleted";

/** Line counts for one path from `git diff --numstat`; binary diffs report no counts, so both stay 0. */
export interface LineStat {
	added: number;
	deleted: number;
	binary: boolean;
}

/** A categorized path from git status. */
export interface ChangeEntry {
	path: string;
	kind: ChangeKind;
	untracked: boolean;
	/** Lines changed versus HEAD; absent for untracked paths, before the counts land, or when git cannot count. */
	stat?: LineStat;
}

/** The repository root and its uncommitted paths. */
export interface ChangeSnapshot {
	root: string;
	entries: ChangeEntry[];
}

/** Maximum time allowed for each git invocation. */
export const GIT_TIMEOUT_MS = 5_000;
/** Maximum total size of diff and untracked-file excerpts. */
export const DETAIL_BUDGET_BYTES = 24_000;
/** Maximum size of an individual diff excerpt. */
export const PER_FILE_DETAIL_BYTES = 3_000;
/** Maximum number of files considered for diff excerpts. */
export const MAX_DIFF_FILES = 8;
/** Maximum changed-line count for a file to be considered for details. */
export const MAX_DIFF_LINES_PER_FILE = 400;
/** Maximum bytes read from the head of an untracked file. */
export const UNTRACKED_HEAD_BYTES = 1_500;
/** Maximum number of untracked file heads considered for details. */
export const MAX_UNTRACKED_HEADS = 20;
/** Maximum number of paths included in the summary prompt. */
export const MAX_PROMPT_PATHS = 200;

const STATUS_MAX_BYTES = 1_000_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CHANGE_KIND_ORDER: Record<ChangeKind, number> = { added: 0, changed: 1, deleted: 2 };

async function runGit(pi: ExtensionAPI, args: string[], cwd: string, signal?: AbortSignal): Promise<ExecResult | undefined> {
	try {
		return await pi.exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			signal,
		});
	} catch {
		return undefined;
	}
}

function isFailed(result: ExecResult | undefined): result is undefined {
	return result === undefined || result.code !== 0 || result.killed;
}

/** Clip NUL-delimited git output to whole records within the status byte bound. */
function boundedRecords(stdout: string): string {
	const bytes = Buffer.from(stdout, "utf8");
	if (bytes.byteLength <= STATUS_MAX_BYTES) return stdout;
	const end = bytes.lastIndexOf(0, STATUS_MAX_BYTES - 1);
	return end < 0 ? "" : bytes.subarray(0, end + 1).toString("utf8");
}

/** Collect the repository root and its current uncommitted paths. */
export async function collectChanges(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<ChangeSnapshot | undefined> {
	if (signal?.aborted) return undefined;
	const rootResult = await runGit(pi, ["rev-parse", "--show-toplevel"], cwd, signal);
	if (isFailed(rootResult)) return undefined;
	const root = rootResult.stdout.replace(/[\r\n]+$/, "");
	if (!root) return undefined;

	if (signal?.aborted) return undefined;
	const statusResult = await runGit(
		pi,
		["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
		root,
		signal,
	);
	if (isFailed(statusResult)) return undefined;
	return { root, entries: parseStatusZ(boundedRecords(statusResult.stdout)) };
}

/**
 * Line counts for every tracked path that differs from HEAD. Undefined when git cannot say: an
 * unborn HEAD, a timeout, or any other failure leaves the listing without counts.
 */
export async function collectLineStats(pi: ExtensionAPI, root: string, signal?: AbortSignal): Promise<Map<string, LineStat> | undefined> {
	if (signal?.aborted) return undefined;
	const result = await runGit(pi, ["diff", "HEAD", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-renames"], root, signal);
	if (isFailed(result)) return undefined;
	return parseNumstatZ(boundedRecords(result.stdout));
}

/** Parse git porcelain-v1 NUL-delimited status records into sorted, merged entries. */
export function parseStatusZ(stdout: string): ChangeEntry[] {
	const entries = new Map<string, ChangeEntry>();
	for (const record of stdout.split("\0")) {
		if (record.length < 4 || record[2] !== " ") continue;
		const x = record[0]!;
		const y = record[1]!;
		const path = record.slice(3);
		if (!path) continue;

		let kind: ChangeKind;
		let untracked = false;
		if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
			kind = "changed";
		} else if (x === "?" && y === "?") {
			kind = "added";
			untracked = true;
		} else if (x === "A") {
			kind = "added";
		} else if (x === "D" || y === "D") {
			kind = "deleted";
		} else {
			kind = "changed";
		}

		const previous = entries.get(path);
		if (!previous) {
			entries.set(path, { path, kind, untracked });
		} else {
			entries.set(path, {
				path,
				kind: previous.kind === kind ? kind : "changed",
				untracked: previous.untracked || untracked,
			});
		}
	}

	return [...entries.values()].sort((a, b) => CHANGE_KIND_ORDER[a.kind] - CHANGE_KIND_ORDER[b.kind] || a.path.localeCompare(b.path));
}

/** Return true when a basename is likely to contain credentials or private key material. */
export function isSensitivePath(path: string): boolean {
	const basename = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
	return (
		basename.startsWith(".env") ||
		/\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/.test(basename) ||
		/^id_(rsa|dsa|ecdsa|ed25519)/.test(basename) ||
		/^\.?(npmrc|netrc|pypirc)$/.test(basename) ||
		/(credential|secret)/.test(basename)
	);
}

/** Replace private keys, credential assignments, and common provider tokens with a marker. */
export function redactSecrets(text: string): string {
	let redacted = text.replace(/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/gi, "[redacted]");
	redacted = redacted.replace(
		/(["']?(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[:=]\s*)\S+/gi,
		"$1[redacted]",
	);
	return redacted.replace(/AKIA[0-9A-Z]{16}|gh[pousr]_\w{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-\S+/g, "[redacted]");
}

function parseNumstatRecord(record: string): { path: string; stat: LineStat } | undefined {
	const firstTab = record.indexOf("\t");
	if (firstTab < 0) return undefined;
	const secondTab = record.indexOf("\t", firstTab + 1);
	if (secondTab < 0) return undefined;
	const addedText = record.slice(0, firstTab);
	const deletedText = record.slice(firstTab + 1, secondTab);
	const path = record.slice(secondTab + 1);
	if (!path) return undefined;
	if (addedText === "-" && deletedText === "-") return { path, stat: { added: 0, deleted: 0, binary: true } };
	const added = Number(addedText);
	const deleted = Number(deletedText);
	if (!addedText || !deletedText || !Number.isSafeInteger(added) || !Number.isSafeInteger(deleted)) return undefined;
	return { path, stat: { added, deleted, binary: false } };
}

/** Parse NUL-delimited `git diff --numstat -z` records (renames disabled) into per-path line counts. */
export function parseNumstatZ(stdout: string): Map<string, LineStat> {
	const stats = new Map<string, LineStat>();
	for (const record of stdout.split("\0")) {
		const parsed = parseNumstatRecord(record);
		if (parsed) stats.set(parsed.path, parsed.stat);
	}
	return stats;
}

function utf8Prefix(bytes: Buffer, limit: number): string {
	let end = Math.min(Math.max(0, limit), bytes.byteLength);
	while (end > 0) {
		try {
			return UTF8_DECODER.decode(bytes.subarray(0, end));
		} catch {
			end--;
		}
	}
	return "";
}

function appendWithinBudget(parts: string[], text: string, used: number): { used: number; complete: boolean } {
	const remaining = DETAIL_BUDGET_BYTES - used;
	if (remaining <= 0) return { used, complete: false };
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= remaining) {
		parts.push(text);
		return { used: used + bytes.byteLength, complete: true };
	}
	const clipped = utf8Prefix(bytes, remaining);
	if (clipped) parts.push(clipped);
	return { used: used + Buffer.byteLength(clipped, "utf8"), complete: false };
}

function excerptWithinLimit(stdout: string, limit: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(stdout, "utf8");
	if (bytes.byteLength <= limit) return { text: stdout, truncated: false };
	return { text: utf8Prefix(bytes, limit), truncated: true };
}

/** Collect bounded, redacted diff excerpts and heads of untracked regular files. */
export async function collectChangeDetails(pi: ExtensionAPI, snapshot: ChangeSnapshot, signal?: AbortSignal): Promise<string> {
	const parts: string[] = [];
	let used = 0;
	const candidates: { path: string; cached: boolean }[] = [];
	const seenCandidates = new Set<string>();

	for (const cached of [true, false]) {
		if (signal?.aborted || candidates.length >= MAX_DIFF_FILES) break;
		const args = cached ? ["diff", "--cached", "--numstat", "-z", "--no-renames"] : ["diff", "--numstat", "-z", "--no-renames"];
		const result = await runGit(pi, args, snapshot.root, signal);
		if (isFailed(result)) continue;
		for (const record of result.stdout.split("\0")) {
			if (candidates.length >= MAX_DIFF_FILES) break;
			const numstat = parseNumstatRecord(record);
			if (!numstat || numstat.stat.binary || numstat.stat.added + numstat.stat.deleted > MAX_DIFF_LINES_PER_FILE || isSensitivePath(numstat.path)) continue;
			const candidateKey = `${cached ? "cached" : "worktree"}\0${numstat.path}`;
			if (seenCandidates.has(candidateKey)) continue;
			seenCandidates.add(candidateKey);
			candidates.push({ path: numstat.path, cached });
		}
	}

	let omittedDiffs = 0;
	for (const candidate of candidates) {
		if (signal?.aborted || used >= DETAIL_BUDGET_BYTES) {
			omittedDiffs++;
			continue;
		}
		const args = [
			"diff",
			...(candidate.cached ? ["--cached"] : []),
			"--unified=1",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"--no-renames",
			"--",
			candidate.path,
		];
		const result = await runGit(pi, args, snapshot.root, signal);
		if (isFailed(result)) continue;
		const excerpt = excerptWithinLimit(result.stdout, PER_FILE_DETAIL_BYTES);
		const label = `${candidate.cached ? "staged" : "worktree"}: ${candidate.path}\n`;
		const content = redactSecrets(`${label}${excerpt.text}${excerpt.truncated ? "\n… (truncated)" : ""}`);
		const appended = appendWithinBudget(parts, content, used);
		used = appended.used;
		if (!appended.complete) {
			omittedDiffs++;
			break;
		}
	}
	if (omittedDiffs > 0 && used < DETAIL_BUDGET_BYTES) {
		const omitted = `… ${omittedDiffs} diff excerpt${omittedDiffs === 1 ? "" : "s"} omitted\n`;
		const appended = appendWithinBudget(parts, omitted, used);
		used = appended.used;
	}

	let untrackedHeads = 0;
	for (const entry of snapshot.entries) {
		if (signal?.aborted || used >= DETAIL_BUDGET_BYTES || untrackedHeads >= MAX_UNTRACKED_HEADS) break;
		if (!entry.untracked || isSensitivePath(entry.path)) continue;
		untrackedHeads++;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const stats = await lstat(join(snapshot.root, entry.path));
			if (!stats.isFile()) continue;
			handle = await open(join(snapshot.root, entry.path), "r");
			const buffer = Buffer.alloc(UNTRACKED_HEAD_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const head = buffer.subarray(0, bytesRead);
			const content = head.includes(0) ? `${entry.path} (binary)\n` : `${entry.path}\n${redactSecrets(head.toString("utf8"))}`;
			const appended = appendWithinBudget(parts, `new file: ${content}`, used);
			used = appended.used;
		} catch {
			// A file can disappear or become unreadable while startup is collecting changes.
		} finally {
			if (handle) await handle.close().catch(() => undefined);
		}
	}

	return parts.join("");
}

/** Build the bounded system and user prompts used to summarize a change snapshot. */
export function buildSummaryPrompt(snapshot: ChangeSnapshot, details: string): { systemPrompt: string; text: string } {
	const systemPrompt = "Describe what was added, changed, or deleted and the apparent purpose. Reply in plain text using no more than 3 sentences and 60 words.";
	const paths = snapshot.entries.slice(0, MAX_PROMPT_PATHS).map((entry) => `${entry.kind}: ${entry.path}`);
	const remaining = snapshot.entries.length - paths.length;
	if (remaining > 0) paths.push(`… and ${remaining} more`);
	const text = [
		"<files>",
		...paths,
		"</files>",
		"<diff-excerpts>",
		details,
		"</diff-excerpts>",
		"Sensitive-file contents were withheld, and secrets in included excerpts were redacted.",
	].join("\n");
	return { systemPrompt, text };
}
