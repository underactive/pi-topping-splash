import { VERSION } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundSampler, DEFAULT_DYNAMIC_TINT, RESET, panelBg, sgrBg, sgrFg, swatchColor } from "./color.ts";
import type { BackgroundColor, DynamicTint, GradientAnimation, Rgb, SwatchSampler } from "./color.ts";
import type { ShortcutHint } from "./discovery.ts";
import { LOGO_INK, LOGO_LINES, LOGO_ROWS, LOGO_SHADOW, LOGO_SHADOW_OFFSET, LOGO_WIDTH } from "./logo.ts";
import type { ConcreteLogoStyle } from "./logo.ts";
import { INSTALLER_LOGO_ANIMATION_BOUNDS, INSTALLER_LOGO_FRAMES, INSTALLER_LOGO_LAST_FRAME, INSTALLER_LOGO_PALETTE } from "./installer-logo.ts";
import { formatPromptSize, joinParts, padCenter, padRight, pickFitting, sanitizeTuiText, truncateVisible, visibleLength, wrapCommaDelimited } from "./text.ts";
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
/** Widest the panel grows beside the logo, padding included; a panel stacked under the logo spans the terminal instead. */
export const PANEL_MAX_WIDTH = 100;
/** Narrower than this and the panel drops below the logo instead of sitting beside it. */
export const PANEL_MIN_WIDTH = 34;
/** Rows of bare swatch above and below the panel, so the rainbow reads as an unbroken band there. */
export const PANEL_MARGIN_Y = 1;
/**
 * Rows the installer logo sits above the splash's exact vertical center, so the brand mark reads
 * as optically balanced instead of slightly low against the taller info panel beside it. Clamped
 * at the top edge, so a splash no taller than the logo cannot lift the mark off the first row.
 * The pi glyph (the default `symbol` style) stays exactly centered — it does not need the lift.
 */
export const LOGO_LIFT_ROWS = 4;
/**
 * Ceiling on how much of the terminal the splash may occupy, so the startup gate below it still
 * fits. Past this the lists collapse to a wrapped counts summary.
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

/**
 * Shortcut hints rendered as a single line: `key1` dim `· description1 · key2` dim `· description2` …
 * Keys are dimmed, descriptions are text; hints join with ` · `, wrapping only between complete hints.
 */
export function buildShortcutSection(theme: Theme, hints: ShortcutHint[], width: number, count?: number): string[] {
	if (hints.length === 0) return [];
	const safe = hints.map((h) => ({ key: sanitizeTuiText(h.key), description: sanitizeTuiText(h.description) }));
	const hintStrings = safe.map((h) => `${theme.fg("dim", h.key)} ${theme.fg("text", h.description)}`);
	const hintWidths = safe.map((h) => visibleLength(h.key) + 1 + visibleLength(h.description));
	const wrapped = wrapCommaDelimited(hintStrings, width, hintWidths);
	const label = count === undefined ? "[shortcuts]" : `[shortcuts] ${count}`;
	return [theme.fg("warning", label), ...wrapped];
}

/**
 * All five lists collapsed to their counts — `[shortcuts] 5 · [context] 2 · [skills] 22 · [prompts] N · [extensions] 33` —
 * for panels too small to spell them out. Wraps across as many centered lines as the width needs, breaking only between
 * whole `[label] N` counts, so a narrow panel stacks the counts instead of truncating the last ones to an ellipsis.
 */
export function buildCountsLine(theme: Theme, context: string[], skills: string[], extensions: string[], shortcuts: ShortcutHint[], prompts: string[], width: number): string[] {
	const counts: [string, unknown[]][] = [
		["[shortcuts]", shortcuts],
		["[context]", context],
		["[skills]", skills],
		["[prompts]", prompts],
		["[extensions]", extensions],
	];
	const segments = counts.map(([label, items]) => {
		const value = String(items.length);
		return { text: `${theme.fg("warning", label)} ${theme.fg("text", value)}`, width: label.length + 1 + value.length };
	});
	const separator = theme.fg("dim", " · ");
	const separatorWidth = 3;
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const segment of segments) {
		const added = current ? separatorWidth + segment.width : segment.width;
		if (current && currentWidth + added > width) {
			lines.push(current);
			current = segment.text;
			currentWidth = segment.width;
			continue;
		}
		current += current ? `${separator}${segment.text}` : segment.text;
		currentWidth += added;
	}
	if (current) lines.push(current);
	return lines.map((line) => padCenter(line, width));
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
export function buildPanelLines(theme: Theme, innerWidth: number, body: string[], model?: { id: string; provider: string }, systemPromptSize?: number): { lines: string[]; taglineIndex: number } {
	const title = `pi v${VERSION}`;
	const rule = Math.max(0, innerWidth - title.length - 2);
	const leftRule = Math.floor(rule / 2);
	const heading = `${theme.fg("border", "─".repeat(leftRule))} ${theme.fg("accent", title)} ${theme.fg("border", "─".repeat(rule - leftRule))}`;
	const tagline = buildTaglineText(innerWidth, model, systemPromptSize);
	const taglineIndex = tagline ? 1 : -1;
	return {
		lines: [
			heading,
			...(tagline ? [padCenter(renderTagline(theme, tagline), innerWidth)] : []),
			"",
			...body,
		],
		taglineIndex,
	};
}

/** A logo cell painted over the swatch backdrop. */
export interface Ink {
	ch: string;
	/** The swatch's top-half sample when absent. */
	color?: Rgb;
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

/** What the splash tells a section joining the foot of its info panel. */
export interface SplashBand {
	/** The panel's text columns, inside its padding. */
	width: number;
	/**
	 * Splash rows spent down to the panel's closing padding and the backdrop row under it. Each
	 * section row adds at most one, and none while the panel still runs shorter than the logo beside it.
	 */
	rows: number;
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

/**
 * The installer mark is drawn this many times larger than the scale that fits the glyph slot.
 * The glyph fit stays the shared scale across frames; this only changes how big that raster is.
 */
export const INSTALLER_LOGO_DISPLAY_SCALE = 2;

/** Scale, reserved columns, and content rows for the installer mark, shadow excluded from the row count. */
export function installerLogoMetrics(): { scale: number; width: number; rows: number } {
	const { width: maxWidth, height: maxHeight } = INSTALLER_LOGO_ANIMATION_BOUNDS;
	const fitted = Math.max(1, Math.floor(Math.min(LOGO_WIDTH / maxWidth, (2 * LOGO_ROWS) / maxHeight)));
	const scale = fitted * INSTALLER_LOGO_DISPLAY_SCALE;
	const contentW = maxWidth * scale;
	const contentSub = maxHeight * scale;
	const width = contentW + LOGO_SHADOW_OFFSET;
	const rows = Math.ceil(contentSub / 2);
	return { scale, width, rows };
}

/** Stamps a source frame at the animation-wide scale, enlarged by `INSTALLER_LOGO_DISPLAY_SCALE`. */
export function stampInstallerLogo(ink: Map<number, Ink>, width: number, height: number, originX: number, originY: number, frame: number): void {
	const frameData = INSTALLER_LOGO_FRAMES[Math.max(0, Math.min(INSTALLER_LOGO_FRAMES.length - 1, frame))]!;
	const { x: cropX, y: cropY, width: maxWidth, height: maxHeight } = INSTALLER_LOGO_ANIMATION_BOUNDS;
	const { scale } = installerLogoMetrics();
	const subpixels = new Map<number, Rgb>();
	const touched = new Set<number>();
	const setPixel = (x: number, subY: number, color: Rgb): void => {
		if (x < 0 || x >= width || subY < 0 || subY >= 2 * height) return;
		subpixels.set(subY * width + x, color);
		touched.add(Math.floor(subY / 2) * width + x);
	};
	const place = (colorFor: (pixel: string) => Rgb | undefined, dx: number, dySub: number): void => {
		frameData.pixels.slice(cropY, cropY + maxHeight).forEach((row, pixelY) => {
			const markRow = row.slice(cropX, cropX + maxWidth);
			for (let pixelX = 0; pixelX < markRow.length; pixelX++) {
				const color = colorFor(markRow[pixelX]!);
				if (!color) continue;
				for (let sy = 0; sy < scale; sy++) {
					for (let sx = 0; sx < scale; sx++) {
						setPixel(
							originX + pixelX * scale + sx + dx,
							2 * originY + pixelY * scale + sy + dySub,
							color,
						);
					}
				}
			}
		});
	};
	place((pixel) => pixel === "." ? undefined : LOGO_SHADOW, LOGO_SHADOW_OFFSET, 2 * LOGO_SHADOW_OFFSET);
	place((pixel) => pixel === "." ? undefined : INSTALLER_LOGO_PALETTE[pixel], 0, 0);
	for (const index of touched) {
		const row = Math.floor(index / width);
		const x = index % width;
		const top = subpixels.get((row * 2) * width + x);
		const bottom = subpixels.get((row * 2 + 1) * width + x);
		ink.set(index, {
			ch: SWATCH_CELL,
			...(top === undefined ? {} : { color: top }),
			...(bottom === undefined ? {} : { backdrop: bottom }),
		});
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
		const cellFg = cell?.color ?? sample(x, width, levelFg);
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
	/** Repaints every row with the backdrop advanced to `timeMs` (and, for `dynamic`, the current local time); undefined when the backdrop is static. */
	repaintBackdrop?: (timeMs: number) => string[];
	/**
	 * Asks `section` for its rows again and repaints only the ones that changed; undefined when the
	 * panel has no section. Null when the section's row count moved, which only a rebuild can place.
	 */
	repaintSection?: () => { row: number; line: string }[] | null;
	/** Repaints the logo slot for a new installer animation frame. */
	repaintLogo?: (frame: number) => { row: number; line: string }[];
}

/**
 * Builds the splash: a full-bleed rainbow swatch carrying the pi logo on the left and the dark
 * info panel beside it. Terminals too narrow for both stack the panel under the logo. The splash
 * grows to whatever height the panel needs so every entry is listed in full; when that would
 * either overrun the row budget or cut off the longest name, the lists collapse to counts.
 *
 * The info panel lists five inventory categories in startup order: shortcut hints, loaded context
 * files (AGENTS.md/CLAUDE.md), skills, prompt templates, and extensions. Shortcut keys reflect
 * Pi's effective global keybindings via `keyText()`. Each under a `[shortcuts] N`/`[context] N`/
 * `[skills] N`/`[prompts] N`/`[extensions] N` heading, mirroring pi's /loaded ordering.
 * Every layout keeps a spare row below either logo style, where its drop shadow lands.
 *
 * `section` is asked, once the lists are laid out, for rows to close the panel with, after
 * `[extensions]`. They join the panel above its closing padding row and grow it, and the splash
 * with it; side by side, the logo stays centered against the taller panel, and the backdrop's fade
 * runs over the whole splash.
 *
 * Returns a `repaintTagline` hook so the reveal ticker can restyle just the tagline row instead
 * of rebuilding the whole O(W×H) splash on every 20ms tick, a `repaintBackdrop` hook so the
 * gradient animation ticker can repaint the rows without redoing this layout work. A `dynamic`
 * backdrop reads the local clock whenever its sampler is built, so each rebuild and each
 * `repaintBackdrop` frame reflects the current time. The `repaintSection` hook lets a section
 * that changes in place (a streaming summary) repaint only the rows it touched.
 */
export function buildHeaderParts(width: number, termRows: number, theme: Theme, context: string[], skills: string[], extensions: string[], model?: { id: string; provider: string }, systemPromptSize?: number, background: BackgroundColor = "rainbow", animation: GradientAnimation = "off", timeMs = 0, prompts: string[] = [], shortcuts: ShortcutHint[] = [], section?: (band: SplashBand) => string[], dynamicTint: DynamicTint = DEFAULT_DYNAMIC_TINT, logoStyle: ConcreteLogoStyle = "symbol", logoFrame = INSTALLER_LOGO_LAST_FRAME): HeaderParts {
	let sample = backgroundSampler(background, theme, animation, timeMs, dynamicTint);
	const installerSlot = logoStyle === "logo" ? installerLogoMetrics() : undefined;
	const logoWidth = installerSlot?.width ?? LOGO_WIDTH;
	const logoRows = installerSlot?.rows ?? LOGO_ROWS;
	const roomBesideLogo = width - SPLASH_MARGIN_X * 2 - logoWidth - LOGO_GAP;
	const sideBySide = roomBesideLogo >= PANEL_MIN_WIDTH;
	const panelWidth = sideBySide
		? Math.min(PANEL_MAX_WIDTH, roomBesideLogo)
		: Math.min(width, Math.max(PANEL_PADDING_X * 2 + 1, width - SPLASH_MARGIN_X * 2));
	const innerWidth = Math.max(1, panelWidth - PANEL_PADDING_X * 2);

	const frame = (body: string[]) => {
		const panel = buildPanelLines(theme, innerWidth, body, model, systemPromptSize);
		return { lines: ["", ...panel.lines, ""], taglineIndex: panel.taglineIndex === -1 ? -1 : panel.taglineIndex + 1 };
	};
	const splashHeight = (panelLines: string[]) => {
		const band = panelLines.length + PANEL_MARGIN_Y * 2;
		return sideBySide ? Math.max(logoRows + 2, band) : logoRows + 1 + band;
	};

	// The budget never drops below what the logo alone needs, since nothing can shrink past that.
	const rowBudget = Math.max(logoRows + 2, Math.floor(termRows * MAX_SPLASH_ROW_SHARE));
	const allItems = [...context, ...skills, ...extensions, ...prompts];
	const shortcutHintStrings = shortcuts.map((h) => `${h.key} ${h.description}`);
	const allWidths = [...allItems.map(visibleLength), ...shortcutHintStrings.map(visibleLength)];
	const widestItem = allWidths.reduce((max, w) => Math.max(max, w), 0);
	let offset = 0;
	let end = offset + context.length;
	const contextWidths = allWidths.slice(offset, end);
	offset = end;
	end = offset + skills.length;
	const skillsWidths = allWidths.slice(offset, end);
	offset = end;
	end = offset + extensions.length;
	const extensionsWidths = allWidths.slice(offset, end);
	offset = end;
	end = offset + prompts.length;
	const promptWidths = allWidths.slice(offset, end);
	const listed = widestItem <= innerWidth
		? frame([
			...buildShortcutSection(theme, shortcuts, innerWidth, shortcuts.length),
			...(shortcuts.length > 0 ? [""] : []),
			...buildLabeledWrappedSection(theme, "[context]", context, innerWidth, context.length, contextWidths),
			"",
			...buildLabeledWrappedSection(theme, "[skills]", skills, innerWidth, skills.length, skillsWidths),
			"",
			...buildLabeledWrappedSection(theme, "[prompts]", prompts, innerWidth, prompts.length, promptWidths),
			"",
			...buildLabeledWrappedSection(theme, "[extensions]", extensions, innerWidth, extensions.length, extensionsWidths),
		])
		: undefined;
	const countFrame = frame(buildCountsLine(theme, context, skills, extensions, shortcuts, prompts, innerWidth));
	const selected = listed && splashHeight(listed.lines) <= rowBudget ? listed : countFrame;
	const panelX = sideBySide ? width - SPLASH_MARGIN_X - panelWidth : Math.max(0, Math.floor((width - panelWidth) / 2));
	const logoX = sideBySide ? Math.max(SPLASH_MARGIN_X, Math.floor((panelX - logoWidth) / 2)) : Math.max(0, Math.floor((width - logoWidth) / 2));
	// The section's budget is measured against the lists alone. Centering the taller panel afterwards
	// never needs more rows than that budget allowed, since the lists' panel sits at least a margin down.
	const listsY = sideBySide ? Math.floor((splashHeight(selected.lines) - selected.lines.length) / 2) : logoRows + 1 + PANEL_MARGIN_Y;
	const band: SplashBand = { width: innerWidth, rows: listsY + selected.lines.length + PANEL_MARGIN_Y };
	const appended = section?.(band) ?? [];
	const lines = appended.length > 0 ? [...selected.lines.slice(0, -1), ...appended, ""] : selected.lines;
	const height = splashHeight(lines);
	// Side by side, the logo and the panel are both centered on the finished splash, section included.
	const logoLift = logoStyle === "logo" && sideBySide ? LOGO_LIFT_ROWS : 0;
	const logoY = sideBySide ? Math.max(0, Math.floor((height - logoRows) / 2) - logoLift) : 0;
	const panelY = sideBySide ? Math.floor((height - lines.length) / 2) : listsY;
	const taglineText = buildTaglineText(innerWidth, model, systemPromptSize);
	const taglineRow = selected.taglineIndex;
	const panel: PanelPlacement = { x: panelX, y: panelY, width: panelWidth, bg: panelBg(theme), lines, taglineRow: taglineRow === -1 ? undefined : taglineRow };
	const ink = new Map<number, Ink>();
	if (logoStyle === "logo") stampInstallerLogo(ink, width, height, logoX, logoY, logoFrame);
	else stampLogo(ink, width, height, logoX, logoY);
	const painted = Array.from({ length: height }, (_, y) => paintRow(y, width, height, ink, panel, sample));

	const taglineIdx = panel.taglineRow;
	const repaintTagline = taglineIdx === undefined
		? undefined
		: () => {
			panel.lines[taglineIdx] = padCenter(renderTagline(theme, taglineText), innerWidth);
			const row = panel.y + taglineIdx;
			return { row, line: paintRow(row, width, height, ink, panel, sample) };
		};
	const repaintBackdrop = animation !== "off"
		? (nowMs: number) => {
			// Reassigned rather than shadowed so a later tagline repaint paints over the same frame.
			sample = backgroundSampler(background, theme, animation, nowMs, dynamicTint);
			return Array.from({ length: height }, (_, y) => paintRow(y, width, height, ink, panel, sample));
		}
		: undefined;
	// The section's rows start where the lists' closing padding row was.
	const sectionStart = selected.lines.length - 1;
	const repaintLogo = logoStyle === "logo"
		? (nextFrame: number) => {
			ink.clear();
			stampInstallerLogo(ink, width, height, logoX, logoY, nextFrame);
			const repainted: { row: number; line: string }[] = [];
			for (let row = Math.max(0, logoY); row <= Math.min(height - 1, logoY + logoRows); row++) {
				repainted.push({ row, line: paintRow(row, width, height, ink, panel, sample) });
			}
			return repainted;
		}
		: undefined;
	const repaintSection = section && appended.length > 0
		? () => {
			const next = section(band);
			if (next.length !== appended.length) return null;
			const repainted: { row: number; line: string }[] = [];
			next.forEach((text, index) => {
				if (panel.lines[sectionStart + index] === text) return;
				panel.lines[sectionStart + index] = text;
				const row = panel.y + sectionStart + index;
				repainted.push({ row, line: paintRow(row, width, height, ink, panel, sample) });
			});
			return repainted;
		}
		: undefined;
	return { lines: painted, repaintTagline, repaintBackdrop, repaintSection, repaintLogo };
}
