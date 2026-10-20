
import { visibleWidth } from "@earendil-works/pi-tui";

export {
	ELLIPSIS,
	fitCell,
	joinParts,
	padCenter,
	padRight,
	pickFitting,
	truncateVisible,
	wrapCommaDelimited,
} from "@underactive/pi-topping-primitives/text";

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
