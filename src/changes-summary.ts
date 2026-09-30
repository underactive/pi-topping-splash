import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildSummaryPrompt, collectChangeDetails, collectChanges, collectLineStats } from "./changes.ts";
import type { ChangeEntry, ChangeKind, LineStat } from "./changes.ts";
import { PANEL_BG_LIGHT, panelBg, rgbFromHex, sgrFg } from "./color.ts";
import type { Rgb } from "./color.ts";
import { modelRefLabel } from "./model-picker.ts";
import type { ModelRef } from "./model-picker.ts";
import type { SplashPreferences } from "./preferences.ts";
import { REVEAL_MS_PER_CHAR, REVEAL_TICK_MS } from "./reveal.ts";
import { changesRenderState, state } from "./state.ts";
import { ELLIPSIS, fitCell, padRight, sanitizeTuiText, truncateVisible } from "./text.ts";
import { SPLASH_MARGIN_X } from "./splash.ts";

/** Rows reserved below a splash when no startup gate is consuming the space. */
export const EDITOR_RESERVED_ROWS = 6;
const SUMMARY_ROWS_MAX = 6;
const FILE_ROWS_MAX = 10;
const SUMMARY_TIMEOUT_MS = 60_000;
/** Cells in a churn bar: the width of pi-topping-statusline's context bar. */
export const BAR_CELLS = 20;
/** Narrower than this and the bars are dropped rather than squeezed. */
export const BAR_MIN_CELLS = 5;
/** Path columns kept before the line counts give up their space. */
export const PATH_MIN_WIDTH = 12;
/** Paths up to this many columns stay whole before the bars get any room. */
const PATH_WHOLE_MAX = 32;
/** The slim changes-only header stops here however wide the terminal is; narrower terminals still fill their own. */
export const CHANGES_MAX_WIDTH = 100;
/** Wall-clock cost of one streamed summary character: twice the tagline reveal's pace, on the same tick, so a tick prints two. */
export const SUMMARY_MS_PER_CHAR = REVEAL_MS_PER_CHAR / 2;
/** Rows the listing needs below its gap: the heading, one file row, the blank row above the summary, and one summary row. Shorter budgets use a single line. */
export const LISTING_MIN_ROWS = 4;
/** The section heading, bracketed like the info panel's other headings. */
const HEADING = "[local changes]";
/** How much of each statusline git color survives the dim; the rest is the backdrop showing through. */
const GIT_COLOR_STRENGTH = 0.6;

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

/** Resolve a configured summary model, falling back to the active session model when needed. */
export function resolveSummaryModel(
	ctx: ExtensionContext,
	ref?: ModelRef,
): { model: SummaryModel; label: string } | { reason: string } {
	if (ref) {
		const configured = ctx.modelRegistry.find(ref.provider, ref.id);
		if (configured) return { model: configured, label: modelRefLabel(ref) };
	}
	if (ctx.model) return { model: ctx.model, label: modelRefLabel(ctx.model) };
	return { reason: "no model selected" };
}

function errorReason(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const firstLine = sanitizeTuiText(raw).split(/\r?\n/, 1)[0]?.trim() ?? "";
	return firstLine ? truncateToWidth(firstLine, 80, ELLIPSIS) : "request failed";
}

function responseText(content: AssistantMessage["content"]): string {
	return content
		.filter((part): part is TextContent => part.type === "text")
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
	let response: AssistantMessage | undefined;
	let thrown: unknown;
	try {
		response = await ctx.modelRegistry
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
	} catch (error) {
		thrown = error;
	}
	if (timeoutSignal.aborted) return { status: "failed", reason: "timed out" };
	if (signal.aborted) return { status: "failed", reason: "cancelled" };
	if (!response) return { status: "failed", reason: errorReason(thrown) };
	if (response.stopReason === "aborted") return { status: "failed", reason: "cancelled" };
	if (response.stopReason === "error") {
		return { status: "failed", reason: errorReason(response.errorMessage ?? "request failed") };
	}
	const text = responseText(response.content);
	return text ? { status: "done", text } : { status: "failed", reason: "empty response" };
}

let changesController: AbortController | null = null;

function requestChangesRender(): void {
	changesRenderState.requestRender?.();
}

/**
 * Start one detached collection/summarization run. The collector is deliberately started by the
 * session-start handler before the gate-mode early return, so splash-only mode gets the same data.
 */
export function startChangesSummary(pi: ExtensionAPI, ctx: ExtensionContext, prefs: SplashPreferences): void {
	if (state.changesStarted) return;
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
				// With the reveal animation on, a summary streams in rather than landing whole; a failure
				// reason always shows at once.
				if (summary.status === "done" && prefs.taglineReveal === "on") startSummaryStream(summary.text);
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

/** Abort the in-flight git/model run and settle a streaming summary, without changing the last published presentation. */
export function abortChangesSummary(): void {
	changesController?.abort();
	changesController = null;
	stopSummaryStream();
}

/**
 * Prints a landed summary a character at a time, twice as fast as the tagline reveal, the way a
 * chat harness streams a model's reply; the `taglineReveal` preference gates both. `shown` counts
 * the characters printed so far and is Infinity once settled (never started, finished, or
 * stopped); `tick` is part of both headers' memo keys, so bumping it is what makes a frame repaint.
 */
export const summaryStream = {
	timer: null as ReturnType<typeof setInterval> | null,
	lastTickAt: 0,
	shown: Number.POSITIVE_INFINITY,
	total: 0,
	tick: 0,
};

/** Streams `text` from its first character, replacing any stream still running. */
export function startSummaryStream(text: string): void {
	if (summaryStream.timer) clearInterval(summaryStream.timer);
	summaryStream.shown = 0;
	summaryStream.total = [...text].length;
	summaryStream.lastTickAt = Date.now();
	summaryStream.tick++;
	summaryStream.timer = setInterval(() => {
		const now = Date.now();
		// Capped like the reveal's step, so an event-loop block pauses the stream instead of dumping the rest at once.
		const step = Math.min(now - summaryStream.lastTickAt, REVEAL_TICK_MS * 2);
		summaryStream.lastTickAt = now;
		summaryStream.shown += step / SUMMARY_MS_PER_CHAR;
		if (summaryStream.shown >= summaryStream.total) {
			stopSummaryStream();
			return;
		}
		summaryStream.tick++;
		changesRenderState.requestRender?.();
	}, REVEAL_TICK_MS);
	// Never hold the process open for a decoration.
	summaryStream.timer.unref();
}

/** Settles the stream on the whole text and repaints it. Idempotent. */
export function stopSummaryStream(): void {
	if (!summaryStream.timer) return;
	clearInterval(summaryStream.timer);
	summaryStream.timer = null;
	summaryStream.shown = Number.POSITIVE_INFINITY;
	summaryStream.tick++;
	changesRenderState.requestRender?.();
}

/** The part of `text` the stream has printed so far; all of it once the stream has settled. */
function streamedPrefix(text: string): string {
	return [...text].slice(0, Math.floor(summaryStream.shown)).join("");
}

function startTruncated(text: string, width: number): string {
	const safe = sanitizeTuiText(text);
	if (width <= 0) return "";
	if (visibleWidth(safe) <= width) return safe;
	if (width <= ELLIPSIS.length) return padRight(truncateVisible(safe, width), width);
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

/** `+a, ~c, -d` across every entry, omitting kinds with no paths; the heading paints it like the other sections' counts. */
function kindCounts(entries: ChangeEntry[]): string {
	return (["added", "changed", "deleted"] as const)
		.map((kind) => ({ kind, count: entries.filter((entry) => entry.kind === kind).length }))
		.filter((part) => part.count > 0)
		.map((part) => `${MARKER[part.kind]}${part.count}`)
		.join(", ");
}

/** A row's line counts: `+a -d` versus HEAD, `bin` for binary diffs, `new` for files git has not counted. */
function statCell(theme: Theme, entry: ChangeEntry, omitZero: boolean): { text: string; width: number } {
	const { stat } = entry;
	if (stat?.binary) return { text: theme.fg("dim", "bin"), width: 3 };
	if (stat) {
		const added = `+${stat.added}`;
		const deleted = `-${stat.deleted}`;
		if (omitZero) {
			const halves = [
				...(stat.added > 0 ? [{ text: theme.fg("text", added), width: added.length }] : []),
				...(stat.deleted > 0 ? [{ text: theme.fg("error", deleted), width: deleted.length }] : []),
			];
			return { text: halves.map((half) => half.text).join(" "), width: halves.reduce((sum, half) => sum + half.width + 1, -1) };
		}
		// Each half takes its churn-bar half's color, `text` added and `error` removed; a zero half drops to `dim`.
		const addedText = stat.added > 0 ? theme.fg("text", added) : theme.fg("dim", added);
		const deletedText = stat.deleted > 0 ? theme.fg("error", deleted) : theme.fg("dim", deleted);
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

function summaryText(summary: SummaryState): string {
	if (summary.status === "done") return summary.text;
	return summary.status === "pending" ? `summarizing local changes with ${summary.modelLabel}…` : `summary unavailable: ${summary.reason}`;
}

function summaryLines(theme: Theme, summary: SummaryState, width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (summary.status !== "done") return [theme.fg("dim", sanitizeTuiText(summaryText(summary)))];
	const lines: string[] = [];
	for (const rawLine of summaryText(summary).split(/\r?\n/)) {
		const line = sanitizeTuiText(rawLine);
		const wrapped = line ? wrapTextWithAnsi(line, safeWidth) : [""];
		lines.push(...(wrapped.length > 0 ? wrapped : [""]));
	}
	// Wrapped as the whole text, so the stream fills rows already laid out instead of reflowing them.
	let left = summaryStream.shown;
	return lines.map((line) => {
		const chars = [...line];
		const printed = chars.slice(0, Math.max(0, Math.floor(left))).join("");
		left -= chars.length;
		return theme.fg("text", printed);
	});
}

/** One row for a budget too short for the listing: the heading and its counts, the most changed path, and a summary preview. */
function compactChangesLine(theme: Theme, presentation: ChangesPresentation, width: number, margin: number, colors: Record<ChangeKind, string>): string {
	const { entries, summary } = presentation;
	let line = `${" ".repeat(margin)}${theme.fg("warning", HEADING)}`;
	const counts = kindCounts(entries);
	// The counts come whole or not at all.
	if (counts && visibleWidth(line) + 1 + counts.length <= width) line += ` ${theme.fg("text", counts)}`;
	const separator = theme.fg("dim", " · ");

	// Prefer the path with the most counted churn, retaining git's order on ties or before stats land.
	const featured = entries.reduce<ChangeEntry | undefined>((best, entry) => {
		if (!best) return entry;
		const churn = (candidate: ChangeEntry) => candidate.stat?.binary ? 0 : (candidate.stat?.added ?? 0) + (candidate.stat?.deleted ?? 0);
		return churn(entry) > churn(best) ? entry : best;
	}, undefined);
	if (featured) {
		const lead = `${separator}${paint(colors[featured.kind], MARKER[featured.kind])} `;
		const room = width - visibleWidth(line) - visibleWidth(lead);
		if (room > 0) {
			// The compact mockup omits zero halves (`+12`); listing rows still show both.
			const statText = statCell(theme, featured, true).text;
			const statSegment = statText ? ` ${statText}` : "";
			const path = sanitizeTuiText(featured.path);
			const includeStat = Boolean(statSegment) && room >= Math.min(PATH_MIN_WIDTH, visibleWidth(path)) + visibleWidth(statSegment);
			const pathWidth = Math.min(PATH_WHOLE_MAX, room - (includeStat ? visibleWidth(statSegment) : 0));
			line += `${lead}${theme.fg("text", startTruncated(path, pathWidth))}${includeStat ? statSegment : ""}`;
		}
	}

	const normalized = sanitizeTuiText(summaryText(summary).replace(/\s+/g, " ")).trim();
	const singleLine = summary.status === "done" ? streamedPrefix(normalized) : normalized;
	const remaining = width - visibleWidth(line) - 3;
	if (singleLine && remaining >= 4) {
		// Cut the plain text so the ellipsis stays inside the dim span.
		const shown = visibleWidth(singleLine) <= remaining ? singleLine : `${truncateVisible(singleLine, remaining - ELLIPSIS.length)}${ELLIPSIS}`;
		line += `${separator}${theme.fg("dim", shown)}`;
	}
	return padRight(fitCell(line, width), width);
}

/** What a listing is laid out to; every row it yields spans exactly `width` columns. */
interface ChangesLayout {
	width: number;
	/** Columns kept clear on the left, and again on the right of the listing's rows. */
	margin: number;
}

/**
 * The uncommitted listing as a section in the style of the info panel's lists, within the row
 * budget: a blank row parting it from whatever sits above, the `[local changes]` heading with its
 * per-kind counts, one row per path ending in a churn bar and its line counts, then a blank row and
 * the variable summary. Fewer than LISTING_MIN_ROWS rows below the gap get the single preview line
 * instead.
 * Nothing here resets the background, so the rows sit safely on a plate.
 */
function layoutChangesRows(theme: Theme, presentation: ChangesPresentation, layout: ChangesLayout, rowsAvailable: number): string[] {
	const { width, margin } = layout;
	const { entries } = presentation;
	const colors = changeColors(theme);
	const indent = " ".repeat(margin);
	// The gap is claimed first, so the section never butts against the rows above it.
	const rows: string[] = rowsAvailable > 1 ? [""] : [];
	const budget = rowsAvailable - rows.length;
	if (budget < LISTING_MIN_ROWS) {
		rows.push(compactChangesLine(theme, presentation, width, margin, colors));
		return rows.map((row) => padRight(fitCell(row, width), width));
	}
	const contentWidth = Math.max(1, width - margin * 2);

	// Rows are claimed in priority order from the budget and the entry count alone, so the listing
	// never moves when the summary lands: after the minimal listing, the remaining files, then more
	// summary.
	let spare = budget - LISTING_MIN_ROWS;
	const claim = (wanted: number): number => {
		const granted = Math.max(0, Math.min(wanted, spare));
		spare -= granted;
		return granted;
	};
	const fileRows = 1 + claim(Math.min(FILE_ROWS_MAX, entries.length) - 1);
	const summaryRows = 1 + claim(SUMMARY_ROWS_MAX - 1);

	const overflow = entries.length > fileRows;
	const visible = entries.slice(0, overflow ? fileRows - 1 : fileRows);
	const cells = visible.map((entry) => statCell(theme, entry, false));
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

	const frame = (content: string): string => `${indent}${fitCell(content, contentWidth)}`;
	const counts = kindCounts(entries);
	rows.push(frame(`${theme.fg("warning", HEADING)}${counts ? ` ${theme.fg("text", counts)}` : ""}`));
	visible.forEach((entry, index) => {
		let row = `${paint(colors[entry.kind], MARKER[entry.kind])} ${padRight(theme.fg("text", startTruncated(entry.path, pathWidth)), pathWidth)}`;
		if (barCells > 0) row += ` ${churnBar(theme, entry.stat, maxChurn, barCells)}`;
		if (showStats) row += ` ${" ".repeat(statWidth - cells[index].width)}${cells[index].text}`;
		rows.push(frame(row));
	});
	if (overflow) rows.push(frame(theme.fg("dim", `… ${entries.length - visible.length} more`)));

	// Blank in every state, so the file rows keep their places when the summary lands.
	rows.push("");
	const rendered = summaryLines(theme, presentation.summary, contentWidth);
	const shown = rendered.slice(0, summaryRows);
	if (shown.length > 0 && rendered.length > shown.length) {
		shown[shown.length - 1] = fitCell(shown[shown.length - 1], contentWidth);
	}
	rows.push(...shown.map((line) => `${indent}${line}`));

	return rows.slice(0, rowsAvailable).map((row) => padRight(fitCell(row, width), width));
}

/**
 * The listing for the slim changes-only header, left-aligned at the splash margin and never wider
 * than CHANGES_MAX_WIDTH, so a wide terminal keeps the paths and the summary at a readable length.
 */
export function renderChangesBlock(theme: Theme, presentation: ChangesPresentation | null, width: number, maxRows: number): string[] {
	const rowsAvailable = Math.floor(maxRows);
	if (!presentation || rowsAvailable < 1 || width < 1) return [];
	return layoutChangesRows(theme, presentation, { width: Math.min(width, CHANGES_MAX_WIDTH), margin: SPLASH_MARGIN_X }, rowsAvailable);
}

/**
 * The listing as the info panel's closing section, after `[extensions]`: `width` is the panel's
 * text width, and the rows start flush with its other sections, in at most `maxRows` rows.
 */
export function layoutChangesSection(theme: Theme, presentation: ChangesPresentation | null, width: number, maxRows: number): string[] {
	const rowsAvailable = Math.floor(maxRows);
	if (!presentation || rowsAvailable < 1 || width < 1) return [];
	return layoutChangesRows(theme, presentation, { width, margin: 0 }, rowsAvailable);
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
				const key = `${width}:${rows}:${version}:${summaryStream.tick}`;
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

