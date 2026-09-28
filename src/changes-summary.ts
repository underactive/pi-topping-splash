import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildSummaryPrompt, collectChangeDetails, collectChanges } from "./changes.ts";
import type { ChangeEntry } from "./changes.ts";
import { modelRefLabel } from "./model-picker.ts";
import type { ModelRef } from "./model-picker.ts";
import { readPreferences } from "./preferences.ts";
import { changesRenderState, state } from "./state.ts";
import { ELLIPSIS, sanitizeTuiText } from "./text.ts";
import { SPLASH_MARGIN_X } from "./splash.ts";

/** Rows reserved below a splash when no startup gate is consuming the space. */
export const EDITOR_RESERVED_ROWS = 6;
export const SUMMARY_ROWS_MAX = 6;
export const FILE_ROWS_MAX = 10;
export const SUMMARY_TIMEOUT_MS = 60_000;

export type SummaryState =
	| { status: "pending"; modelLabel: string }
	| { status: "done"; text: string }
	| { status: "failed"; reason: string };

export interface ChangesPresentation {
	entries: ChangeEntry[];
	summary: SummaryState;
	version: number;
}

type SummaryModel = NonNullable<ExtensionContext["model"]>;

function modelLabel(model: SummaryModel): string {
	return modelRefLabel({ provider: model.provider, id: model.id });
}

/** Resolve a configured summary model, falling back to the active session model when needed. */
export function resolveSummaryModel(
	ctx: ExtensionContext,
	ref?: ModelRef,
): { model: SummaryModel; label: string } | { reason: string } {
	if (ref) {
		const configured = ctx.modelRegistry.find(ref.provider, ref.id);
		if (configured) return { model: configured, label: modelRefLabel(ref) };
	}
	if (ctx.model) return { model: ctx.model, label: modelLabel(ctx.model) };
	return { reason: "no model selected" };
}

function errorReason(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const firstLine = sanitizeTuiText(raw).split(/\r?\n/, 1)[0]?.trim() ?? "";
	return firstLine ? truncateToWidth(firstLine, 80, ELLIPSIS) : "request failed";
}

function responseText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text"
				&& typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("")
		.trim();
}

/** Make the bounded, thinking-off provider request and turn every failure into display state. */
export async function summarizeChanges(
	ctx: ExtensionContext,
	model: SummaryModel,
	prompt: { systemPrompt: string; text: string },
	signal: AbortSignal,
): Promise<SummaryState> {
	const timeoutSignal = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
	const requestSignal = AbortSignal.any([signal, timeoutSignal]);
	if (signal.aborted) return { status: "failed", reason: "cancelled" };
	try {
		const response = await ctx.modelRegistry
			.streamSimple(
				model,
				{
					systemPrompt: prompt.systemPrompt,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: prompt.text }],
							timestamp: Date.now(),
						},
					],
				},
				{ signal: requestSignal, maxTokens: 400 },
			)
			.result();
		if (timeoutSignal.aborted) return { status: "failed", reason: "timed out" };
		if (signal.aborted) return { status: "failed", reason: "cancelled" };
		if (response.stopReason === "aborted") {
			return { status: "failed", reason: timeoutSignal.aborted ? "timed out" : "cancelled" };
		}
		if (response.stopReason === "error") {
			return { status: "failed", reason: errorReason(response.errorMessage ?? "request failed") };
		}
		const text = responseText(response.content);
		return text ? { status: "done", text } : { status: "failed", reason: "empty response" };
	} catch (error) {
		if (timeoutSignal.aborted) return { status: "failed", reason: "timed out" };
		if (signal.aborted) return { status: "failed", reason: "cancelled" };
		return { status: "failed", reason: errorReason(error) };
	}
}

let changesController: AbortController | null = null;

function requestChangesRender(): void {
	changesRenderState.requestRender?.();
}

/**
 * Start one detached collection/summarization run. The collector is deliberately started by the
 * session-start handler before the gate-mode early return, so splash-only mode gets the same data.
 */
export function startChangesSummary(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (state.changesStarted) return;
	const prefs = readPreferences();
	if (prefs.changesSummary !== "on" || !ctx.isProjectTrusted()) return;
	state.changesStarted = true;
	const controller = new AbortController();
	changesController = controller;
	const signal = controller.signal;

	void (async () => {
		try {
			const snapshot = await collectChanges(pi, ctx.cwd, signal);
			if (!snapshot || snapshot.entries.length === 0 || signal.aborted) return;

			const resolved = resolveSummaryModel(ctx, prefs.changesSummaryModel);
			const presentation: ChangesPresentation = {
				entries: snapshot.entries,
				summary: "reason" in resolved
					? { status: "failed", reason: resolved.reason }
					: { status: "pending", modelLabel: resolved.label },
				version: 1,
			};
			state.changes = presentation;
			requestChangesRender();
			if ("reason" in resolved || signal.aborted) return;

			try {
				const details = await collectChangeDetails(pi, snapshot, signal);
				if (signal.aborted || state.changes !== presentation) return;
				const prompt = buildSummaryPrompt(snapshot, details);
				const summary = await summarizeChanges(ctx, resolved.model, prompt, signal);
				if (state.changes !== presentation || signal.aborted) return;
				presentation.summary = summary;
				presentation.version += 1;
				requestChangesRender();
			} catch (error) {
				if (signal.aborted || state.changes !== presentation) return;
				presentation.summary = { status: "failed", reason: errorReason(error) };
				presentation.version += 1;
				requestChangesRender();
			}
		} catch {
			// Git discovery is display-only. Non-repositories, missing git, and aborted runs are silent.
		} finally {
			if (changesController === controller) changesController = null;
		}
	})();
}

/** Abort the in-flight git/model run without changing the last published presentation. */
export function abortChangesSummary(): void {
	changesController?.abort();
	changesController = null;
}

function startTruncated(text: string, width: number): string {
	const safe = sanitizeTuiText(text);
	if (width <= 0) return "";
	if (visibleWidth(safe) <= width) return safe;
	if (width <= ELLIPSIS.length) return truncateToWidth(safe, width, "", true);
	const tail = sliceByColumn(safe, Math.max(0, visibleWidth(safe) - (width - ELLIPSIS.length)), width - ELLIPSIS.length, true);
	return `${ELLIPSIS}${tail}`;
}

function counts(entries: ChangeEntry[]): string {
	const values = (["added", "changed", "deleted"] as const)
		.map((kind) => {
			const count = entries.filter((entry) => entry.kind === kind).length;
			return count > 0 ? `${count} ${kind}` : "";
		})
		.filter(Boolean);
	return values.length > 0 ? ` · ${values.join(" · ")}` : "";
}

function summaryLines(theme: Theme, summary: SummaryState, width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (summary.status === "pending") return [theme.fg("dim", `summarizing with ${sanitizeTuiText(summary.modelLabel)}…`)];
	if (summary.status === "failed") return [theme.fg("dim", `summary unavailable: ${sanitizeTuiText(summary.reason)}`)];
	const lines: string[] = [];
	for (const rawLine of summary.text.split(/\r?\n/)) {
		const line = sanitizeTuiText(rawLine);
		const wrapped = line ? wrapTextWithAnsi(line, safeWidth) : [""];
		lines.push(...(wrapped.length > 0 ? wrapped : [""]));
	}
	return lines.map((line) => theme.fg("text", line));
}

/** Render the fixed-width listing and the variable summary within the available row budget. */
export function renderChangesBlock(theme: Theme, presentation: ChangesPresentation | null, width: number, maxRows: number): string[] {
	const rowsAvailable = Math.floor(maxRows);
	if (!presentation || rowsAvailable < 1 || width < 1) return [];

	const leading = rowsAvailable >= 4 ? 1 : 0;
	const headingRows = 1;
	const fileBudget = Math.min(FILE_ROWS_MAX, Math.max(0, rowsAvailable - headingRows - leading - 2));
	const rows: string[] = [];
	const indent = " ".repeat(SPLASH_MARGIN_X);
	if (leading > 0) rows.push("");
	rows.push(`${indent}${theme.fg("warning", "[uncommitted]")} ${presentation.entries.length}${theme.fg("dim", counts(presentation.entries))}`);

	const more = Math.max(0, presentation.entries.length - fileBudget);
	const visibleEntries = more > 0 ? presentation.entries.slice(0, Math.max(0, fileBudget - 1)) : presentation.entries.slice(0, fileBudget);
	const marker: Record<ChangeEntry["kind"], string> = { added: "+", changed: "~", deleted: "-" };
	const color: Record<ChangeEntry["kind"], "success" | "warning" | "error"> = { added: "success", changed: "warning", deleted: "error" };
	const pathWidth = Math.max(1, width - SPLASH_MARGIN_X - 2);
	for (const entry of visibleEntries) {
		const path = startTruncated(entry.path, pathWidth);
		rows.push(`${" ".repeat(SPLASH_MARGIN_X)}${theme.fg(color[entry.kind], marker[entry.kind])} ${theme.fg("text", path)}`);
	}
	if (more > 0 && fileBudget > 0) rows.push(`${" ".repeat(SPLASH_MARGIN_X)}${theme.fg("dim", `… ${more} more`)}`);

	const availableAfterFiles = rowsAvailable - rows.length;
	if (availableAfterFiles >= 2) rows.push("");
	const summaryCapacity = rowsAvailable - rows.length;
	if (summaryCapacity > 0) {
		const renderedSummary = summaryLines(theme, presentation.summary, Math.max(1, width - SPLASH_MARGIN_X));
		const visibleSummary = renderedSummary.slice(0, Math.min(SUMMARY_ROWS_MAX, summaryCapacity));
		if (visibleSummary.length > 0) {
			const wasCut = renderedSummary.length > visibleSummary.length;
			if (wasCut) {
				const last = visibleSummary.length - 1;
				visibleSummary[last] = truncateToWidth(visibleSummary[last]!, Math.max(1, width - SPLASH_MARGIN_X), ELLIPSIS);
			}
			rows.push(...visibleSummary.map((line) => `${indent}${line}`));
		}
	}

	return rows.slice(0, rowsAvailable).map((row) => {
		return truncateToWidth(row, width, ELLIPSIS, true);
	});
}

/** Install the post-gate changes-only header without rewiring the splash's render-state signal. */
export function installChangesHeader(ctx: ExtensionContext): void {
	ctx.ui.setHeader((tui, theme) => {
		changesRenderState.requestRender = () => tui.requestRender();
		let cachedKey = "";
		let cachedLines: string[] = [];
		const component = {
			render(width: number): string[] {
				const rows = tui.terminal.rows;
				const version = state.changes?.version ?? -1;
				const key = `${width}:${rows}:${version}`;
				if (key !== cachedKey) {
					cachedKey = key;
					cachedLines = renderChangesBlock(theme, state.changes, width, rows - EDITOR_RESERVED_ROWS);
					state.splashRows = cachedLines.length;
				}
				return cachedLines;
			},
			invalidate(): void {
				cachedKey = "";
				cachedLines = [];
			},
		};
		return component;
	});
}

