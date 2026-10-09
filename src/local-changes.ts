import type { CustomEntry, ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { ChangeEntry } from "./changes.ts";
import {
	CHANGES_HEADING,
	errorReason,
	layoutChangesSection,
	runChangesPipeline,
	summaryText,
	type SummaryState,
} from "./changes-summary.ts";
import { panelBg } from "./color.ts";
import { readPreferences } from "./preferences.ts";
import {
	PANEL_MAX_WIDTH,
	PANEL_PADDING_X,
	paintPanelRow,
	type PanelPlacement,
} from "./splash.ts";
import { fitCell } from "./text.ts";

export const LOCAL_CHANGES_COMMAND = "local-changes";
export const LOCAL_CHANGES_ENTRY_TYPE = "pi-topping-splash:local-changes";
/** Maximum paths shown by the transcript entry before its overflow row. */
export const LOCAL_CHANGES_FILE_ROWS_MAX = 20;
const STATUS_KEY = "pi-topping-splash:local-changes";

export type LocalChangesEntryData =
	| { kind: "changes"; entries: ChangeEntry[]; summary: SummaryState }
	| { kind: "clean" }
	| { kind: "unavailable" };

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

/** Check data from a session file before the entry renderer reads it. */
export function isLocalChangesEntryData(value: unknown): value is LocalChangesEntryData {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const data = value as Record<string, unknown>;
	if (data.kind === "clean" || data.kind === "unavailable") return hasOnlyKeys(data, ["kind"]);
	if (data.kind !== "changes" || !hasOnlyKeys(data, ["kind", "entries", "summary"]) || !Array.isArray(data.entries) || data.entries.length === 0) return false;
	const entriesValid = data.entries.every((entry) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
		const candidate = entry as Record<string, unknown>;
		if (!hasOnlyKeys(candidate, ["path", "kind", "untracked", "stat"]) || typeof candidate.path !== "string"
			|| (candidate.kind !== "added" && candidate.kind !== "changed" && candidate.kind !== "deleted")
			|| typeof candidate.untracked !== "boolean") return false;
		if (candidate.stat === undefined) return true;
		if (typeof candidate.stat !== "object" || candidate.stat === null || Array.isArray(candidate.stat)) return false;
		const stat = candidate.stat as Record<string, unknown>;
		return hasOnlyKeys(stat, ["added", "deleted", "binary"])
			&& typeof stat.added === "number" && Number.isSafeInteger(stat.added) && stat.added >= 0
			&& typeof stat.deleted === "number" && Number.isSafeInteger(stat.deleted) && stat.deleted >= 0
			&& typeof stat.binary === "boolean";
	});
	if (!entriesValid || typeof data.summary !== "object" || data.summary === null || Array.isArray(data.summary)) return false;
	const summary = data.summary as Record<string, unknown>;
	return (summary.status === "done" && hasOnlyKeys(summary, ["status", "text"]) && typeof summary.text === "string")
		|| (summary.status === "failed" && hasOnlyKeys(summary, ["status", "reason"]) && typeof summary.reason === "string");
}

/** Paint the settled local-changes section on the same plate as the splash info panel. */
export function renderLocalChangesEntry(theme: Theme, data: LocalChangesEntryData, width: number): string[] {
	if (width < 1) return [];
	const plate = Math.min(width, PANEL_MAX_WIDTH);
	const inner = Math.max(1, plate - PANEL_PADDING_X * 2);
	let body: string[];
	if (data.kind === "changes") {
		// The plate's top padding takes the place of the section's gap row; a settled entry prints its whole summary whatever the startup stream is doing.
		body = layoutChangesSection(
			theme,
			{ entries: data.entries, summary: data.summary, version: 0 },
			inner,
			Number.POSITIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			LOCAL_CHANGES_FILE_ROWS_MAX,
			false,
		).slice(1);
	} else if (data.kind === "clean") {
		body = [fitCell(theme.fg("warning", CHANGES_HEADING), inner), fitCell(theme.fg("text", "none"), inner)];
	} else {
		body = [
			fitCell(theme.fg("warning", CHANGES_HEADING), inner),
			fitCell(theme.fg("dim", "not a git repository, or git is unavailable"), inner),
		];
	}
	const panel: PanelPlacement = { x: 0, y: 0, width: plate, bg: panelBg(theme), lines: ["", ...body, ""] };
	return panel.lines.map((_, y) => paintPanelRow(panel, y));
}

let localChangesRun: { controller: AbortController; clearStatus: () => void } | null = null;

/** Called from session_shutdown, before pi tears the session's UI down; an aborted run appends nothing. */
export function abortLocalChanges(): void {
	const run = localChangesRun;
	if (!run) return;
	run.controller.abort();
	run.clearStatus();
	localChangesRun = null;
}

export function registerLocalChanges(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<unknown>(LOCAL_CHANGES_ENTRY_TYPE, (entry, _options, theme) => {
		if (!isLocalChangesEntryData(entry.data)) return undefined;
		const data = entry.data;
		let cachedWidth = -1;
		let cachedLines: string[] = [];
		const component: Component = {
			render(width: number): string[] {
				if (width !== cachedWidth) {
					cachedWidth = width;
					cachedLines = renderLocalChangesEntry(theme, data, width);
				}
				return cachedLines;
			},
			invalidate(): void {
				cachedWidth = -1;
				cachedLines = [];
			},
		};
		return component;
	});

	pi.registerCommand(LOCAL_CHANGES_COMMAND, {
		description: "Show uncommitted changes, a churn graph, and a model summary in the transcript (never sent to the model).",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/local-changes requires TUI mode", "error");
				return;
			}
			if (localChangesRun) {
				ctx.ui.notify("/local-changes is already running", "info");
				return;
			}
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("/local-changes needs a trusted project: git filters can run during status and diff", "warning");
				return;
			}

			const controller = new AbortController();
			const run = { controller, clearStatus: () => ctx.ui.setStatus(STATUS_KEY, undefined) };
			localChangesRun = run;
			ctx.ui.setStatus(STATUS_KEY, "collecting local changes…");

			void (async () => {
				try {
					const outcome = await runChangesPipeline(pi, ctx, readPreferences().changesSummaryModel, controller.signal, {
						publish: (presentation) => {
							if (presentation.summary.status === "pending") ctx.ui.setStatus(STATUS_KEY, summaryText(presentation.summary));
						},
						isCurrent: () => true,
					});
					if (!outcome || controller.signal.aborted) return;
					const data: LocalChangesEntryData = outcome.kind === "changes"
						? {
							kind: "changes",
							entries: outcome.presentation.entries,
							summary: outcome.presentation.summary,
						}
						: { kind: outcome.kind };
					pi.appendEntry<LocalChangesEntryData>(LOCAL_CHANGES_ENTRY_TYPE, data);
				} catch (error) {
					if (!controller.signal.aborted) ctx.ui.notify(`/local-changes failed: ${errorReason(error)}`, "error");
				} finally {
					if (localChangesRun === run) {
						localChangesRun = null;
						run.clearStatus();
					}
				}
			})();
		},
	});
}
