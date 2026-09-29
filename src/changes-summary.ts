import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildSummaryPrompt, collectChangeDetails, collectChanges, collectLineStats } from "./changes.ts";
import type { ChangeEntry, ChangeKind, LineStat } from "./changes.ts";
import { PANEL_BG_LIGHT, panelBg, rgbFromHex, sgrFg } from "./color.ts";
import type { Rgb } from "./color.ts";
import { modelRefLabel } from "./model-picker.ts";
import type { ModelRef } from "./model-picker.ts";
import { readPreferences } from "./preferences.ts";
import { changesRenderState, state } from "./state.ts";
import { ELLIPSIS, padRight, sanitizeTuiText } from "./text.ts";
import { SPLASH_MARGIN_X } from "./splash.ts";

/** Rows reserved below a splash when no startup gate is consuming the space. */
export const EDITOR_RESERVED_ROWS = 6;
export const SUMMARY_ROWS_MAX = 6;
export const FILE_ROWS_MAX = 10;
export const SUMMARY_TIMEOUT_MS = 60_000;
/** Cells in a churn bar: the width of pi-topping-statusline's context bar. */
export const BAR_CELLS = 20;
/** Narrower than this and the bars are dropped rather than squeezed. */
export const BAR_MIN_CELLS = 5;
/** Path columns kept before the line counts give up their space. */
export const PATH_MIN_WIDTH = 12;
/** Paths up to this many columns stay whole before the bars get any room. */
export const PATH_WHOLE_MAX = 32;
/** Top-border title of the boxed listing. */
export const BOX_TITLE = " uncommitted ";
/** The box needs both borders, one file row, and one summary row; shorter budgets use a single line. */
export const BOX_MIN_ROWS = 4;
/** How much of each statusline git color survives the dim; the rest is the backdrop showing through. */
export const GIT_COLOR_STRENGTH = 0.6;

/**
 * pi-topping-statusline's git colors, carried here because Pi's Theme has no such roles:
 * `statusLineStaged` (xterm 70) and `statusLineDirty` (xterm 178). Its git segment has no
 * deletion color, so `-` takes that palette's `error`.
 */
const GIT_COLORS: Record<ChangeKind, Rgb> = {
	added: rgbFromHex("#5faf00"),
	changed: rgbFromHex("#d7af00"),
	deleted: rgbFromHex("#fc3a4b"),
};
/** Dim target on dark themes: pi-topping-statusline's bar background. Light themes use the paper plate. */
const GIT_DIM_TARGET_DARK = rgbFromHex("#121212");
const MARKER: Record<ChangeKind, string> = { added: "+", changed: "~", deleted: "-" };
const BAR_FILL = "▇";
const BAR_TROUGH = "·";

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

			// Line counts fill in once the listing is already on screen; without them the rows carry no bars.
			const stats = await collectLineStats(pi, snapshot.root, signal);
			if (signal.aborted || state.changes !== presentation) return;
			if (stats && stats.size > 0) {
				presentation.entries = presentation.entries.map((entry) => {
					const stat = stats.get(entry.path);
					return stat ? { ...entry, stat } : entry;
				});
				presentation.version += 1;
				requestChangesRender();
			}
			if ("reason" in resolved) return;

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

function paint(sgr: string, text: string): string {
	return `${sgr}${text}\x1b[39m`;
}

/** The statusline git colors dimmed toward the theme's backdrop, as a foreground SGR per change kind. */
function changeColors(theme: Theme): Record<ChangeKind, string> {
	const target = (panelBg(theme) === PANEL_BG_LIGHT ? PANEL_BG_LIGHT : GIT_DIM_TARGET_DARK).split(";").map(Number);
	const dim = (color: Rgb): string => sgrFg(color
		.split(";")
		.map((channel, index) => Math.round(Number(channel) * GIT_COLOR_STRENGTH + target[index] * (1 - GIT_COLOR_STRENGTH)))
		.join(";"));
	return { added: dim(GIT_COLORS.added), changed: dim(GIT_COLORS.changed), deleted: dim(GIT_COLORS.deleted) };
}

/** `+a ~c -d` across every entry, omitting kinds with no paths. */
function kindCounts(entries: ChangeEntry[], colors: Record<ChangeKind, string>, separator = " "): { text: string; width: number } {
	const parts = (["added", "changed", "deleted"] as const)
		.map((kind) => ({ kind, count: entries.filter((entry) => entry.kind === kind).length }))
		.filter((part) => part.count > 0)
		.map((part) => ({ text: `${MARKER[part.kind]}${part.count}`, color: colors[part.kind] }));
	return {
		text: parts.map((part) => paint(part.color, part.text)).join(separator),
		width: parts.reduce((sum, part) => sum + part.text.length, Math.max(0, parts.length - 1) * visibleWidth(separator)),
	};
}

/** A row's line counts: `+a -d` versus HEAD, `bin` for binary diffs, `new` for files git has not counted. */
function statCell(theme: Theme, entry: ChangeEntry): { text: string; width: number } {
	const { stat } = entry;
	if (stat?.binary) return { text: theme.fg("dim", "bin"), width: 3 };
	if (stat) {
		const added = `+${stat.added}`;
		const deleted = `-${stat.deleted}`;
		// Counts borrow the theme's `text`; only a zero half drops to `dim`, the way a nonzero one lifts off it.
		const addedText = stat.added > 0 ? theme.fg("text", added) : theme.fg("dim", added);
		const deletedText = stat.deleted > 0 ? theme.fg("text", deleted) : theme.fg("dim", deleted);
		return { text: `${addedText} ${deletedText}`, width: added.length + 1 + deleted.length };
	}
	if (entry.untracked || entry.kind === "added") return { text: theme.fg("dim", "new"), width: 3 };
	return { text: "", width: 0 };
}

/** A `cells`-wide bar of added then deleted lines, scaled to the largest churn on screen, over a dotted trough. */
function churnBar(theme: Theme, stat: LineStat | undefined, maxChurn: number, cells: number): string {
	let added = 0;
	let deleted = 0;
	if (stat && !stat.binary) {
		// Any nonzero count keeps a cell, so a one-line edit still shows beside a large rewrite.
		added = stat.added > 0 ? Math.max(1, Math.round((stat.added / maxChurn) * cells)) : 0;
		deleted = stat.deleted > 0 ? Math.max(1, Math.round((stat.deleted / maxChurn) * cells)) : 0;
		// Both halves rounding up can overshoot by a cell; take it back from the larger half.
		const over = added + deleted - cells;
		if (over > 0 && added >= deleted) added -= over;
		else if (over > 0) deleted -= over;
	}
	const trough = cells - added - deleted;
	return [
		added > 0 ? theme.fg("text", BAR_FILL.repeat(added)) : "",
		deleted > 0 ? theme.fg("error", BAR_FILL.repeat(deleted)) : "",
		trough > 0 ? theme.fg("dim", BAR_TROUGH.repeat(trough)) : "",
	].join("");
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

/** One row for a budget too short for the box: count, kinds, most changed path, and summary preview. */
function compactChangesLine(theme: Theme, presentation: ChangesPresentation, width: number, colors: Record<ChangeKind, string>): string {
	const { entries, summary } = presentation;
	let line = `${" ".repeat(SPLASH_MARGIN_X)}${theme.fg("warning", "●")} ${theme.fg("text", `${entries.length} uncommitted`)}`;
	const counts = kindCounts(entries, colors, theme.fg("dim", " · "));
	const bracketed = ` ${theme.fg("dim", "[")}${counts.text}${theme.fg("dim", "]")}`;
	if (counts.width > 0 && visibleWidth(line) + counts.width + 3 <= width) line += bracketed;

	// Prefer the path with the most counted churn, retaining git's order on ties or before stats land.
	const featured = entries.reduce<ChangeEntry | undefined>((best, entry) => {
		if (!best) return entry;
		const churn = (candidate: ChangeEntry) => candidate.stat?.binary ? 0 : (candidate.stat?.added ?? 0) + (candidate.stat?.deleted ?? 0);
		return churn(entry) > churn(best) ? entry : best;
	}, undefined);
	if (featured) {
		const lead = ` ${paint(colors[featured.kind], MARKER[featured.kind])} `;
		const room = width - visibleWidth(line) - visibleWidth(lead);
		if (room > 0) {
			const stat = featured.stat;
			// The compact mockup omits zero halves (`+12`); boxed rows still show both via statCell.
			const statText = stat?.binary ? theme.fg("dim", "bin") : stat
				? [stat.added > 0 ? theme.fg("text", `+${stat.added}`) : "", stat.deleted > 0 ? theme.fg("text", `-${stat.deleted}`) : ""].filter(Boolean).join(" ")
				: featured.untracked ? theme.fg("dim", "new") : "";
			const statSegment = statText ? ` ${statText}` : "";
			const path = sanitizeTuiText(featured.path);
			const includeStat = Boolean(statSegment) && room >= Math.min(PATH_MIN_WIDTH, visibleWidth(path)) + visibleWidth(statSegment);
			const pathWidth = Math.min(PATH_WHOLE_MAX, room - (includeStat ? visibleWidth(statSegment) : 0));
			line += `${lead}${theme.fg("text", startTruncated(path, pathWidth))}${includeStat ? statSegment : ""}`;
		}
	}

	const preview = summary.status === "done" ? summary.text : summary.status === "pending"
		? `summarizing with ${summary.modelLabel}…` : `summary unavailable: ${summary.reason}`;
	const singleLine = sanitizeTuiText(preview.replace(/\s+/g, " ")).trim();
	const remaining = width - visibleWidth(line) - 3;
	if (singleLine && remaining >= 4) {
		line += `${theme.fg("dim", " · ")}${theme.fg("dim", truncateToWidth(singleLine, remaining, ELLIPSIS))}`;
	}
	return truncateToWidth(line, width, ELLIPSIS, true);
}

/**
 * Render the uncommitted listing as a box beneath the splash, then the variable summary below it,
 * within the available row budget. The top border carries the title and per-kind counts, a key row
 * gives the file count and bar legend, and each path row ends in a churn bar and its line counts.
 * Budgets under BOX_MIN_ROWS use a single preview line; narrow widths with enough rows keep the
 * existing unboxed listing.
 */
export function renderChangesBlock(theme: Theme, presentation: ChangesPresentation | null, width: number, maxRows: number): string[] {
	const rowsAvailable = Math.floor(maxRows);
	if (!presentation || rowsAvailable < 1 || width < 1) return [];

	const { entries } = presentation;
	const colors = changeColors(theme);
	const border = (text: string) => theme.fg("border", text);
	const indent = " ".repeat(SPLASH_MARGIN_X);
	if (rowsAvailable < BOX_MIN_ROWS) return [compactChangesLine(theme, presentation, width, colors)];
	// Columns between the box's verticals, with the splash margin kept clear on both sides.
	const boxInner = width - SPLASH_MARGIN_X * 2 - 2;
	const titleWidth = visibleWidth(BOX_TITLE);
	const boxed = rowsAvailable >= BOX_MIN_ROWS && boxInner >= titleWidth + 2;
	const contentWidth = Math.max(1, boxed ? boxInner - 2 : width - SPLASH_MARGIN_X);

	// Rows are claimed in priority order from the budget and the entry count alone, so the listing
	// never moves when the summary lands: one file row and one summary row, the gap under the
	// splash, the remaining files, the key row, then more summary.
	let spare = rowsAvailable - (boxed ? 2 : 1);
	const claim = (wanted: number): number => {
		const granted = Math.max(0, Math.min(wanted, spare));
		spare -= granted;
		return granted;
	};
	const wantedFiles = Math.min(FILE_ROWS_MAX, entries.length);
	let fileRows = claim(Math.min(1, wantedFiles));
	let summaryRows = claim(1);
	const leading = boxed ? claim(1) : 0;
	fileRows += claim(wantedFiles - fileRows);
	const legend = boxed ? claim(1) : 0;
	summaryRows += claim(SUMMARY_ROWS_MAX - summaryRows);

	const overflow = entries.length > fileRows;
	const visible = entries.slice(0, overflow ? Math.max(0, fileRows - 1) : fileRows);
	const cells = visible.map((entry) => statCell(theme, entry));
	const statWidth = Math.max(0, ...cells.map((cell) => cell.width));
	// After the marker and its space, the line counts take room down to PATH_MIN_WIDTH path columns;
	// the bars only get what is left once the longest visible path, up to PATH_WHOLE_MAX, fits whole.
	let pathWidth = contentWidth - 2;
	const showStats = statWidth > 0 && pathWidth - statWidth - 1 >= PATH_MIN_WIDTH;
	if (showStats) pathWidth -= statWidth + 1;
	const churn = visible.map((entry) => (entry.stat && !entry.stat.binary ? entry.stat.added + entry.stat.deleted : 0));
	const counted = visible.some((entry) => entry.stat && !entry.stat.binary);
	const longestPath = Math.max(0, ...visible.map((entry) => visibleWidth(sanitizeTuiText(entry.path))));
	const barRoom = pathWidth - Math.max(PATH_MIN_WIDTH, Math.min(longestPath, PATH_WHOLE_MAX)) - 1;
	const barCells = showStats && counted && barRoom >= BAR_MIN_CELLS ? Math.min(BAR_CELLS, barRoom) : 0;
	if (barCells > 0) pathWidth -= barCells + 1;
	const maxChurn = Math.max(1, ...churn);

	const frame = (content: string): string => boxed
		? `${indent}${border("│")} ${padRight(truncateToWidth(content, contentWidth, ELLIPSIS), contentWidth)} ${border("│")}`
		: `${indent}${content}`;
	const rows: string[] = [];
	if (leading > 0) rows.push("");
	const counts = kindCounts(entries, colors);
	if (boxed) {
		const withCounts = counts.width > 0 && boxInner - 1 - titleWidth - (counts.width + 1) >= 1;
		const fill = boxInner - 1 - titleWidth - (withCounts ? counts.width + 1 : 0);
		rows.push(`${indent}${border("┌─")}${theme.fg("warning", BOX_TITLE)}${border("─".repeat(fill))}${withCounts ? `${counts.text} ` : ""}${border("┐")}`);
	} else {
		rows.push(`${indent}${theme.fg("warning", "uncommitted")}${counts.width > 0 ? ` ${counts.text}` : ""}`);
	}
	if (legend > 0) {
		const files = theme.fg("dim", `${entries.length} ${entries.length === 1 ? "file" : "files"}`);
		const key = `${theme.fg("text", "▌")} ${theme.fg("dim", "added")}  ${theme.fg("error", "▌")} ${theme.fg("dim", "removed")}`;
		const gap = contentWidth - visibleWidth(files) - visibleWidth(key);
		rows.push(frame(barCells > 0 && gap >= 1 ? `${files}${" ".repeat(gap)}${key}` : files));
	}
	visible.forEach((entry, index) => {
		let row = `${paint(colors[entry.kind], MARKER[entry.kind])} ${padRight(theme.fg("text", startTruncated(entry.path, pathWidth)), pathWidth)}`;
		if (barCells > 0) row += ` ${churnBar(theme, entry.stat, maxChurn, barCells)}`;
		if (showStats) row += ` ${" ".repeat(statWidth - cells[index].width)}${cells[index].text}`;
		rows.push(frame(row));
	});
	if (overflow && fileRows > 0) rows.push(frame(theme.fg("dim", `… ${entries.length - visible.length} more`)));
	if (boxed) rows.push(`${indent}${border(`└${"─".repeat(boxInner)}┘`)}`);

	// The summary sits under the box, aligned with the text inside it.
	const rendered = summaryLines(theme, presentation.summary, contentWidth);
	const shown = rendered.slice(0, summaryRows);
	if (shown.length > 0 && rendered.length > shown.length) {
		shown[shown.length - 1] = truncateToWidth(shown[shown.length - 1], contentWidth, ELLIPSIS);
	}
	const summaryIndent = boxed ? `${indent}  ` : indent;
	rows.push(...shown.map((line) => `${summaryIndent}${line}`));

	return rows.slice(0, rowsAvailable).map((row) => truncateToWidth(row, width, ELLIPSIS, true));
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

