
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

export const ELLIPSIS = "...";

/** Visible terminal columns, measured with the renderer's own ruler (wide chars, graphemes, SGR/OSC). */
export function visibleLength(text: string): number {
	return visibleWidth(text);
}

/**
 * Formats a byte count as an estimated token count (~4 bytes per token).
 * - Under 1000 tokens: `~512 tokens`
 * - 1000 tokens and above: `~10.5k tokens` (one decimal place)
 *
 * ~4 bytes/token is a rough approximation — actual tokens vary by model tokenizer
 * (CJK/code content tokenizes differently), and this estimate should not be used
 * for cost-critical calculations.
 */
export function formatPromptSize(bytes: number): string {
	if (!Number.isFinite(bytes)) return "unknown";
	const tokens = bytes / 4;
	if (tokens < 1000) return `~${Math.round(tokens)} tokens`;
	return `~${(tokens / 1000).toFixed(1)}k tokens`;
}

export function padRight(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleLength(text)))}`;
}

export function padCenter(text: string, width: number): string {
	const total = Math.max(0, width - visibleLength(text));
	const leftPad = Math.floor(total / 2);
	return `${" ".repeat(leftPad)}${text}${" ".repeat(total - leftPad)}`;
}

/** Wrap items comma-separated to `width` visible columns. Adds a trailing comma on line breaks. Returns [] for empty items. */
export function wrapCommaDelimited(items: string[], width: number, itemWidths?: number[]): string[] {
	const safeWidth = Math.max(1, width);
	const widths = itemWidths ?? items.map((item) => visibleWidth(item));
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		const w = widths[i]! + (current ? 2 : 0);
		// Reserve one column for the trailing comma added when the line breaks.
		if (current && currentWidth + w + 1 > safeWidth) {
			lines.push(`${current},`);
			current = item;
			currentWidth = widths[i]!;
			continue;
		}
		current += current ? `, ${item}` : item;
		currentWidth += w;
	}
	if (current) lines.push(current);
	return lines;
}

export function normalizeSkillName(name: string): string {
	return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

function skipCsiSequence(text: string, index: number): number {
	let i = index;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code >= 0x40 && code <= 0x7e) return i + 1;
		if (code >= 0x20 && code <= 0x3f) {
			i++;
			continue;
		}
		break;
	}
	return i;
}

function skipStringTerminatedSequence(text: string, index: number): number {
	let i = index;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code === 0x07 || code === 0x9c) return i + 1;
		if (code === 0x1b && text.charCodeAt(i + 1) === 0x5c) return i + 2;
		i++;
	}
	return i;
}

function skipEscapeSequence(text: string, index: number): number {
	const introducer = text.charCodeAt(index);
	if (introducer === 0x5b) return skipCsiSequence(text, index + 1);
	if (introducer === 0x5d || introducer === 0x50 || introducer === 0x58 || introducer === 0x5e || introducer === 0x5f) {
		return skipStringTerminatedSequence(text, index + 1);
	}
	let i = index;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code >= 0x20 && code <= 0x2f) {
			i++;
			continue;
		}
		if (code >= 0x30 && code <= 0x7e) return i + 1;
		break;
	}
	return i;
}

/** Strip ANSI/control escape sequences and ASCII control chars to prevent terminal injection. */
export function sanitizeTuiText(text: string): string {
	let sanitized = "";
	for (let i = 0; i < text.length; ) {
		const code = text.charCodeAt(i);
		if (code === 0x1b) {
			i = skipEscapeSequence(text, i + 1);
			continue;
		}
		if (code === 0x9b) {
			i = skipCsiSequence(text, i + 1);
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
			i = skipStringTerminatedSequence(text, i + 1);
			continue;
		}
		if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			i++;
			continue;
		}
		sanitized += text[i++];
	}
	return sanitized;
}

export function uniqueSorted(values: string[]): string[] {
	return [...new Set(values.filter(Boolean).map(sanitizeTuiText))].sort((a, b) => a.localeCompare(b));
}

/**
 * Truncates `text` to at most `maxWidth` visible columns. Escape sequences never count
 * against the width budget and are never split mid-sequence; a wide character straddling
 * the cut is dropped rather than allowed to overflow it.
 */
export function truncateVisible(text: string, maxWidth: number): string {
	return sliceByColumn(text, 0, maxWidth, true);
}

/**
 * Truncates `text` to `width` visible columns, closing any color span the cut landed inside
 * (foreground only, so a surrounding panel background survives) and marking it with an ellipsis.
 */
export function fitCell(text: string, width: number): string {
	if (visibleLength(text) <= width) return text;
	// Too narrow for the ellipsis itself: truncate without it, still closing the fg span.
	if (width < ELLIPSIS.length) return `${truncateVisible(text, Math.max(0, width))}\x1b[39m`;
	return `${truncateVisible(text, width - ELLIPSIS.length)}\x1b[39m${ELLIPSIS}`;
}

/** Joins the parts that are actually present, so absent metadata leaves no dangling separator. */
export function joinParts(parts: (string | undefined | null | false)[], separator = " · "): string {
	return parts.filter((part): part is string => Boolean(part)).join(separator);
}

/** The first candidate that fits `width`, else the last one truncated to fit. */
export function pickFitting(candidates: string[], width: number): string {
	return candidates.find((candidate) => visibleLength(candidate) <= width) ?? fitCell(candidates[candidates.length - 1], width);
}
