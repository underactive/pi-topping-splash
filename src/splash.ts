import { VERSION } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundSampler, RESET, panelBg, sgrBg, sgrFg, swatchColor } from "./color.ts";
import type { BackgroundColor, GradientAnimation, Rgb, SwatchSampler } from "./color.ts";
import { LOGO_INK, LOGO_LINES, LOGO_SHADOW, LOGO_SHADOW_OFFSET, LOGO_WIDTH } from "./logo.ts";
import { fitCell, formatPromptSize, joinParts, padCenter, padRight, pickFitting, sanitizeTuiText, truncateVisible, visibleLength, wrapCommaDelimited } from "./text.ts";
import { renderTagline } from "./reveal.ts";

/**
 * Upper half block: every splash cell carries two vertical color samples (fg = top half,
 * bg = bottom half), doubling the backdrop's vertical resolution.
 */
export const SWATCH_CELL = "▀";

/** Columns kept clear of content at both edges of the splash. */
export const SPLASH_MARGIN_X = 3;
/** Columns between the logo and the info panel when they sit side by side. */
export const LOGO_GAP = 4;
export const PANEL_PADDING_X = 2;
export const PANEL_MAX_WIDTH = 72;
/** Narrower than this and the panel drops below the logo instead of sitting beside it. */
export const PANEL_MIN_WIDTH = 34;
/** Rows of bare swatch above and below the panel, so the rainbow reads as an unbroken band there. */
export const PANEL_MARGIN_Y = 1;
/**
 * Ceiling on how much of the terminal the splash may occupy, so the startup gate below it still
 * fits. Past this the two lists collapse to a counts line.
 */
export const MAX_SPLASH_ROW_SHARE = 0.6;

/** A heading row, then the items wrapped as a block beneath it across the panel's full width. */
export function buildLabeledWrappedSection(theme: Theme, label: string, items: string[], width: number, count?: number, itemWidths?: number[]): string[] {
	const safeItems = items.map(sanitizeTuiText).filter((item): item is string => item.length > 0);
	const wrapped = wrapCommaDelimited(safeItems.length > 0 ? safeItems : ["none"], width, itemWidths);
	// Items carry an explicit color: on the panel plate there is no default foreground to fall
	// back on, only whatever the swatch cell to the left of the panel happened to set.
	const heading = count === undefined ? theme.fg("warning", label) : `${theme.fg("warning", label)} ${theme.fg("text", String(count))}`;
	return [heading, ...wrapped.map((line) => theme.fg("text", line))];
}

/** All three lists collapsed to `[context] 2 · [skills] 22 · [extensions] 33`, for panels too small to spell them out. */
export function buildCountsLine(theme: Theme, context: string[], skills: string[], extensions: string[], width: number): string {
	const count = (label: string, items: string[]) => `${theme.fg("warning", label)} ${theme.fg("text", String(items.length))}`;
	const line = `${count("[context]", context)}${theme.fg("dim", " · ")}${count("[skills]", skills)}${theme.fg("dim", " · ")}${count("[extensions]", extensions)}`;
	return padCenter(fitCell(line, width), width);
}

/** The settled tagline (model + prompt size) the panel centers; "" when there is nothing to show. The reveal wraps it in "- " / " -", so it must fit `innerWidth - 4`. */
function buildTaglineText(innerWidth: number, model?: { id: string; provider: string }, systemPromptSize?: number): string {
	const prompt = systemPromptSize === undefined ? "" : formatPromptSize(systemPromptSize);
	return pickFitting(
		[
			joinParts([model && `${model.id} (${model.provider})`, prompt]),
			joinParts([model?.id, prompt]),
			joinParts([model?.id]),
		],
		innerWidth - 4,
	);
}

/**
 * Interior lines of the info panel, mirroring the splash's rule/tagline/body rhythm: the pi
 * version as a titled rule, the active model as a centered tagline, then `body` (the loaded
 * context, skills, and extensions, either listed in full or collapsed to counts).
 */
export function buildPanelLines(theme: Theme, innerWidth: number, body: string[], model?: { id: string; provider: string }, systemPromptSize?: number): string[] {
	const title = `pi v${VERSION}`;
	const rule = Math.max(0, innerWidth - title.length - 2);
	const leftRule = Math.floor(rule / 2);
	const heading = `${theme.fg("border", "─".repeat(leftRule))} ${theme.fg("accent", title)} ${theme.fg("border", "─".repeat(rule - leftRule))}`;
	const tagline = buildTaglineText(innerWidth, model, systemPromptSize);
	return [
		heading,
		...(tagline ? [padCenter(renderTagline(theme, tagline), innerWidth)] : []),
		"",
		...body,
	];
}

/** A logo cell painted over the swatch backdrop. */
export interface Ink {
	ch: string;
	color: Rgb;
	/** What shows through the glyph's unpainted half; the swatch when absent. */
	backdrop?: Rgb;
}

/** The plate and its pre-styled interior lines, positioned within the splash. */
export interface PanelPlacement {
	x: number;
	y: number;
	width: number;
	bg: Rgb;
	lines: string[];
	/** Row offset of the tagline within `lines`, or -1 when there is no tagline. */
	taglineRow?: number;
}

/**
 * Writes the logo into `ink` (keyed by row-major cell index) as two whole layers: the shadow
 * offset down-right, then the logo over it. The art's Powerline glyphs paint only half their
 * cell, so each layer keeps whatever sits beneath it as its backdrop — shadow under the logo's
 * angled edges, swatch everywhere else. Compositing per layer rather than per glyph is what
 * keeps the diagonals smooth instead of stepping through the shadow color.
 */
export function stampLogo(ink: Map<number, Ink>, width: number, height: number, originX: number, originY: number): void {
	const place = (dx: number, dy: number): Map<number, string> => {
		const layer = new Map<number, string>();
		LOGO_LINES.forEach((line, row) => {
			for (let col = 0; col < line.length; col++) {
				const ch = line[col];
				if (ch === " ") continue;
				const x = originX + col + dx;
				const y = originY + row + dy;
				if (x >= 0 && x < width && y >= 0 && y < height) layer.set(y * width + x, ch);
			}
		});
		return layer;
	};

	const shadow = place(LOGO_SHADOW_OFFSET, LOGO_SHADOW_OFFSET);
	const logo = place(0, 0);
	for (const [index, ch] of shadow) ink.set(index, { ch, color: LOGO_SHADOW });
	for (const [index, ch] of logo) {
		ink.set(index, { ch, color: LOGO_INK, backdrop: shadow.has(index) ? LOGO_SHADOW : undefined });
	}
}

/** Renders the panel's slice of row `y`: one padded interior line on the plate. */
export function paintPanelRow(panel: PanelPlacement, y: number): string {
	const text = `${" ".repeat(PANEL_PADDING_X)}${panel.lines[y - panel.y] ?? ""}`;
	return `${sgrBg(panel.bg)}${padRight(truncateVisible(text, panel.width), panel.width)}${RESET}`;
}

/**
 * Paints one splash row: the swatch backdrop with logo ink and the panel composited on top.
 * Color codes are emitted only where a cell actually changes color.
 */
export function paintRow(y: number, width: number, height: number, ink: Map<number, Ink>, panel: PanelPlacement, sample: SwatchSampler = swatchColor): string {
	let row = "";
	let currentFg = "";
	let currentBg = "";
	const levelFg = (height - y) / height;
	const levelBg = (height - y - 0.5) / height;
	for (let x = 0; x < width; x++) {
		if (x === panel.x && y >= panel.y && y < panel.y + panel.lines.length) {
			row += paintPanelRow(panel, y);
			currentFg = "";
			currentBg = "";
			x += panel.width - 1;
			continue;
		}
		const cell = ink.get(y * width + x);
		const cellFg = cell ? cell.color : sample(x, width, levelFg);
		const cellBg = cell?.backdrop ?? sample(x, width, levelBg);
		if (cellFg !== currentFg) {
			row += sgrFg(cellFg);
			currentFg = cellFg;
		}
		if (cellBg !== currentBg) {
			row += sgrBg(cellBg);
			currentBg = cellBg;
		}
		row += cell ? cell.ch : SWATCH_CELL;
	}
	return `${row}${RESET}`;
}

/** Paints the whole splash: the swatch, the logo stamped into it, and the panel on top. */
export function paintSplash(width: number, height: number, logoX: number, logoY: number, panel: PanelPlacement, sample: SwatchSampler = swatchColor): string[] {
	const ink = new Map<number, Ink>();
	stampLogo(ink, width, height, logoX, logoY);
	return Array.from({ length: height }, (_, y) => paintRow(y, width, height, ink, panel, sample));
}

/** The painted splash, plus a hook to repaint only the tagline row for the current reveal state. */
export interface HeaderParts {
	lines: string[];
	/** Repaints just the tagline row; undefined when the panel has no tagline (nothing to reveal). */
	repaintTagline?: () => { row: number; line: string };
	/** Repaints every row with the backdrop advanced to `timeMs`; undefined when the backdrop is static. */
	repaintBackdrop?: (timeMs: number) => string[];
}

/**
 * Builds the splash: a full-bleed rainbow swatch carrying the pi logo on the left and the dark
 * info panel beside it. Terminals too narrow for both stack the panel under the logo. The splash
 * grows to whatever height the panel needs so every entry is listed in full; when that would
 * either overrun the row budget or cut off the longest name, the lists collapse to counts.
 *
 * The info panel lists the loaded context files (AGENTS.md/CLAUDE.md), skills and extensions,
 * each under a `[context] N`/`[skills] N`/`[extensions] N` heading, mirroring pi's /loaded
 * ordering. Every layout keeps a spare row below the logo, where its drop shadow lands.
 *
 * Returns a `repaintTagline` hook so the reveal ticker can restyle just the tagline row instead
 * of rebuilding the whole O(W×H) splash on every 20ms tick, and a `repaintBackdrop` hook so the
 * gradient animation ticker can repaint the rows without redoing this layout work.
 */
export function buildHeaderParts(width: number, termRows: number, theme: Theme, context: string[], skills: string[], extensions: string[], model?: { id: string; provider: string }, systemPromptSize?: number, background: BackgroundColor = "rainbow", animation: GradientAnimation = "off", timeMs = 0): HeaderParts {
	let sample = backgroundSampler(background, theme, animation, timeMs);
	const logoRows = LOGO_LINES.length;
	const roomBesideLogo = width - SPLASH_MARGIN_X * 2 - LOGO_WIDTH - LOGO_GAP;
	const sideBySide = roomBesideLogo >= PANEL_MIN_WIDTH;
	const panelWidth = sideBySide
		? Math.min(PANEL_MAX_WIDTH, roomBesideLogo)
		: Math.min(width, Math.max(PANEL_PADDING_X * 2 + 1, width - SPLASH_MARGIN_X * 2));
	const innerWidth = Math.max(1, panelWidth - PANEL_PADDING_X * 2);

	const frame = (body: string[]) => ["", ...buildPanelLines(theme, innerWidth, body, model, systemPromptSize), ""];
	const splashHeight = (panelLines: string[]) => {
		const band = panelLines.length + PANEL_MARGIN_Y * 2;
		return sideBySide ? Math.max(logoRows + 2, band) : logoRows + 1 + band;
	};

	// The budget never drops below what the logo alone needs, since nothing can shrink past that.
	const rowBudget = Math.max(logoRows + 2, Math.floor(termRows * MAX_SPLASH_ROW_SHARE));
	const allItems = [...context, ...skills, ...extensions];
	const allWidths = allItems.map(visibleLength);
	const widestItem = allWidths.reduce((max, w) => Math.max(max, w), 0);
	let offset = 0;
	const contextWidths = allWidths.slice(offset, offset += context.length);
	const skillsWidths = allWidths.slice(offset, offset += skills.length);
	const extensionsWidths = allWidths.slice(offset, offset += extensions.length);
	const listed = widestItem <= innerWidth
		? frame([
			...buildLabeledWrappedSection(theme, "[context]", context, innerWidth, context.length, contextWidths),
			"",
			...buildLabeledWrappedSection(theme, "[skills]", skills, innerWidth, skills.length, skillsWidths),
			"",
			...buildLabeledWrappedSection(theme, "[extensions]", extensions, innerWidth, extensions.length, extensionsWidths),
		])
		: undefined;
	const lines = listed && splashHeight(listed) <= rowBudget
		? listed
		: frame([buildCountsLine(theme, context, skills, extensions, innerWidth)]);
	const height = splashHeight(lines);
	const panelX = sideBySide ? width - SPLASH_MARGIN_X - panelWidth : Math.max(0, Math.floor((width - panelWidth) / 2));
	const logoX = sideBySide ? Math.max(SPLASH_MARGIN_X, Math.floor((panelX - LOGO_WIDTH) / 2)) : Math.max(0, Math.floor((width - LOGO_WIDTH) / 2));
	const logoY = sideBySide ? Math.floor((height - logoRows) / 2) : 0;
	const panelY = sideBySide ? Math.floor((height - lines.length) / 2) : logoRows + 1 + PANEL_MARGIN_Y;
	const taglineText = buildTaglineText(innerWidth, model, systemPromptSize);
	const taglineRow = taglineText !== "" ? 2 : -1;
	const panel: PanelPlacement = { x: panelX, y: panelY, width: panelWidth, bg: panelBg(theme), lines, taglineRow };
	const ink = new Map<number, Ink>();
	stampLogo(ink, width, height, logoX, logoY);
	const painted = Array.from({ length: height }, (_, y) => paintRow(y, width, height, ink, panel, sample));

	const repaintTagline = taglineRow === -1
		? undefined
		: () => {
			panel.lines[taglineRow] = padCenter(renderTagline(theme, taglineText), innerWidth);
			const row = panel.y + taglineRow;
			return { row, line: paintRow(row, width, height, ink, panel, sample) };
		};
	const repaintBackdrop = animation !== "off"
		? (nowMs: number) => {
			// Reassigned rather than shadowed so a later tagline repaint paints over the same frame.
			sample = backgroundSampler(background, theme, animation, nowMs);
			return Array.from({ length: height }, (_, y) => paintRow(y, width, height, ink, panel, sample));
		}
		: undefined;
	return { lines: painted, repaintTagline, repaintBackdrop };
}

/** The splash as flat lines. Use `buildHeaderParts` when you also need the tick-only repaint hooks. */
export function buildHeader(width: number, termRows: number, theme: Theme, context: string[], skills: string[], extensions: string[], model?: { id: string; provider: string }, systemPromptSize?: number, background: BackgroundColor = "rainbow", animation: GradientAnimation = "off", timeMs = 0): string[] {
	return buildHeaderParts(width, termRows, theme, context, skills, extensions, model, systemPromptSize, background, animation, timeMs).lines;
}
