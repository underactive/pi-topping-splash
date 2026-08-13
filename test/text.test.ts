import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ELLIPSIS,
	fitCell,
	formatPromptSize,
	joinParts,
	normalizeSkillName,
	padCenter,
	padRight,
	pickFitting,
	sanitizeTuiText,
	truncateVisible,
	uniqueSorted,
	visibleLength,
	wrapCommaDelimited,
} from "../src/text.ts";

const SGR_RED = "\x1b[38;2;200;0;0m";
const OSC_LINK = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
const OSC_LINK_ST = "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\";

// No escape sequence may be split: every ESC must begin a complete SGR or OSC-8 sequence.
function hasBrokenEscape(text: string): boolean {
	return /\x1b(?!\[[0-9;]*m|\]8;;[^\x07]*\x07)/.test(text);
}

describe("visibleLength (T-03)", () => {
	it("counts plain text", () => {
		assert.equal(visibleLength(""), 0);
		assert.equal(visibleLength("hello"), 5);
	});
	it("ignores SGR sequences", () => {
		assert.equal(visibleLength(`${SGR_RED}red\x1b[0m`), 3);
	});
	it("ignores OSC-8 hyperlink envelopes", () => {
		assert.equal(visibleLength(OSC_LINK), 4);
	});
	it("mixed escapes and text", () => {
		assert.equal(visibleLength(`a${SGR_RED}b\x1b[0m${OSC_LINK}c`), 7);
	});
	it("ignores ST-terminated OSC-8 envelopes", () => {
		assert.equal(visibleLength(OSC_LINK_ST), 4);
	});
	it("counts wide characters by their terminal columns", () => {
		assert.equal(visibleLength("日本語"), 6);
		assert.equal(visibleLength("🚀"), 2);
	});
});

describe("formatPromptSize (T-01)", () => {
	it("doc example: 2048 bytes ≈ 512 tokens", () => {
		assert.equal(formatPromptSize(2048), "~512 tokens");
	});
	it("doc example: 42000 bytes ≈ 10.5k tokens", () => {
		assert.equal(formatPromptSize(42000), "~10.5k tokens");
	});
	it("zero bytes", () => {
		assert.equal(formatPromptSize(0), "~0 tokens");
	});
	it("999 tokens stays in token form; 1000 switches to k form", () => {
		assert.equal(formatPromptSize(3996), "~999 tokens");
		assert.equal(formatPromptSize(4000), "~1.0k tokens");
	});
	it("shape holds across the domain (exact-token inputs)", () => {
		for (let bytes = 0; bytes <= 3996; bytes += 4) {
			const tokens = bytes / 4;
			assert.equal(formatPromptSize(bytes), `~${tokens} tokens`, `bytes=${bytes}`);
		}
		for (let bytes = 4000; bytes <= 80000; bytes += 400) {
			const expected = `~${(bytes / 4 / 1000).toFixed(1)}k tokens`;
			assert.equal(formatPromptSize(bytes), expected, `bytes=${bytes}`);
		}
	});
	it("rounding boundaries (T-13): shape and monotonicity for non-exact-token inputs", () => {
		let previous = 0;
		for (let bytes = 1; bytes <= 12000; bytes += 7) {
			const result = formatPromptSize(bytes);
			assert.match(result, /^~(\d+|\d+\.\dk) tokens$/, `bytes=${bytes}`);
			const value = result.endsWith("k tokens")
				? Number.parseFloat(result.slice(1, -" tokens".length)) * 1000
				: Number.parseInt(result.slice(1), 10);
			assert.ok(value >= previous, `bytes=${bytes}: ${result} fell below the previous value`);
			previous = value;
		}
	});
	it("UNSPECIFIED (T-02): non-finite input does not throw and is deterministic", () => {
		for (const bytes of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const first = formatPromptSize(bytes);
			assert.equal(typeof first, "string");
			assert.equal(formatPromptSize(bytes), first);
		}
	});
});

describe("padRight / padCenter (T-04)", () => {
	const texts = ["", "a", "hello", `${SGR_RED}hi\x1b[0m`];
	it("pads to the requested visible width, never truncates", () => {
		for (const text of texts) {
			const len = visibleLength(text);
			for (let width = 0; width <= 60; width++) {
				const expected = Math.max(width, len);
				assert.equal(visibleLength(padRight(text, width)), expected, `padRight(${JSON.stringify(text)}, ${width})`);
				assert.equal(visibleLength(padCenter(text, width)), expected, `padCenter(${JSON.stringify(text)}, ${width})`);
			}
		}
	});
	it("padRight left-aligns", () => {
		assert.equal(padRight("ab", 5), "ab   ");
	});
	it("padCenter balances padding within one column", () => {
		for (let width = 0; width <= 40; width++) {
			const result = padCenter("abc", width);
			const left = result.length - result.trimStart().length;
			const right = result.length - result.trimEnd().length;
			assert.ok(Math.abs(left - right) <= 1, `width=${width}: left=${left} right=${right}`);
		}
	});
});

describe("wrapCommaDelimited (T-05, T-14)", () => {
	it("returns [] for empty items (F-1 reconciled: the doc comment was stale)", () => {
		assert.deepEqual(wrapCommaDelimited([], 20), []);
	});
	it("single short item on one line, no trailing comma", () => {
		const lines = wrapCommaDelimited(["alpha"], 20);
		assert.equal(lines.length, 1);
		assert.equal(lines[0]?.trimEnd().endsWith(","), false);
		assert.ok(lines[0]?.includes("alpha"));
	});
	it("keeps every line within width and marks breaks with a trailing comma", () => {
		const itemSets = [
			["alpha", "beta", "gamma", "delta", "epsilon"],
			["a", "b", "c", "d", "e", "f", "g", "h"],
			["one", "two", "three", "four", "five", "six", "seven"],
		];
		for (const items of itemSets) {
			const longest = Math.max(...items.map((s) => s.length));
			for (let width = longest + 2; width <= 60; width++) {
				const lines = wrapCommaDelimited(items, width);
				for (const [i, line] of lines.entries()) {
					assert.ok(
						visibleLength(line) <= width,
						`items=${items.join("/")} width=${width} line ${i} too wide: ${JSON.stringify(line)}`,
					);
					const trimmed = line.trimEnd();
					if (i < lines.length - 1) {
						assert.ok(trimmed.endsWith(","), `width=${width} line ${i} lacks break comma: ${JSON.stringify(line)}`);
					} else {
						assert.equal(trimmed.endsWith(","), false, `width=${width} last line has dangling comma`);
					}
				}
				const reconstructed = lines
					.join(",")
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s.length > 0);
				assert.deepEqual(reconstructed, items, `width=${width} loses or reorders items`);
			}
		}
	});
	it("measures wide characters in columns when wrapping", () => {
		const lines = wrapCommaDelimited(["日本語", "中文", "한국어"], 10);
		for (const line of lines) {
			assert.ok(visibleLength(line) <= 10, JSON.stringify(line));
		}
		assert.ok(lines.length > 1, "wide items must wrap where code units alone would seem to fit");
	});
	it("UNSPECIFIED (T-14): an item wider than the width is not lost", () => {
		const lines = wrapCommaDelimited(["tiny", "averylongitemthatcannotfit"], 10);
		const joined = lines.join("\n");
		assert.ok(joined.includes("averylongitemthatcannotfit"));
		assert.ok(joined.includes("tiny"));
	});
});

describe("sanitizeTuiText (T-06)", () => {
	it("passes plain text through", () => {
		assert.equal(sanitizeTuiText("plain text"), "plain text");
	});
	it("strips SGR sequences", () => {
		assert.equal(sanitizeTuiText(`${SGR_RED}red\x1b[0m`), "red");
	});
	it("strips CSI control sequences", () => {
		assert.equal(sanitizeTuiText("\x1b[2J\x1b[Hhello"), "hello");
	});
	it("strips OSC-8 hyperlink envelopes", () => {
		assert.equal(sanitizeTuiText(OSC_LINK), "link");
	});
	it("strips mixed escapes", () => {
		assert.equal(sanitizeTuiText(`a${SGR_RED}b\x1b[0m${OSC_LINK}c`), "ablinkc");
	});
	it("strips ST-terminated OSC envelopes", () => {
		assert.equal(sanitizeTuiText(OSC_LINK_ST), "link");
	});
});

describe("uniqueSorted (T-07)", () => {
	it("sorts and dedupes", () => {
		assert.deepEqual(uniqueSorted(["b", "a", "b", "c", "a"]), ["a", "b", "c"]);
	});
	it("empty input", () => {
		assert.deepEqual(uniqueSorted([]), []);
	});
	it("gap pass (observed): drops empty entries and strips ANSI before deduping", () => {
		assert.deepEqual(uniqueSorted(["b", "", "\x1b[31ma\x1b[0m", "a"]), ["a", "b"]);
	});
});

describe("truncateVisible (T-08)", () => {
	const corpus = [
		"The quick brown fox",
		`pre${SGR_RED}mid\x1b[0mpost`,
		`a${OSC_LINK}z`,
	];
	it("hits min(maxWidth, visibleLength) exactly and never splits escapes", () => {
		for (const text of corpus) {
			const len = visibleLength(text);
			for (let maxWidth = 0; maxWidth <= len + 5; maxWidth++) {
				const result = truncateVisible(text, maxWidth);
				assert.equal(
					visibleLength(result),
					Math.min(maxWidth, len),
					`text=${JSON.stringify(text)} maxWidth=${maxWidth}`,
				);
				assert.equal(hasBrokenEscape(result), false, `broken escape in ${JSON.stringify(result)}`);
			}
		}
	});
	it("is a prefix for escape-free text", () => {
		const text = "The quick brown fox";
		for (let maxWidth = 0; maxWidth <= text.length + 3; maxWidth++) {
			assert.equal(truncateVisible(text, maxWidth), text.slice(0, Math.min(maxWidth, text.length)));
		}
	});
	it("drops a wide character straddling the cut instead of overflowing", () => {
		assert.equal(truncateVisible("日本", 3), "日");
		assert.equal(truncateVisible("日本語", 4), "日本");
	});
});

describe("fitCell (T-09, T-15)", () => {
	it("leaves fitting text unchanged", () => {
		for (const text of ["", "abc", `${SGR_RED}ab\x1b[0m`]) {
			assert.equal(fitCell(text, 10), text);
		}
	});
	it("truncates plain text to width with an ellipsis", () => {
		// Byte-level output may carry an unconditional ESC[39m fg-close (observed); the
		// contract governs visible content, so compare after stripping escapes.
		const text = "abcdefghijklmnop";
		for (let width = ELLIPSIS.length; width < text.length; width++) {
			const result = fitCell(text, width);
			const expected = text.slice(0, width - ELLIPSIS.length) + ELLIPSIS;
			assert.equal(sanitizeTuiText(result), expected, `width=${width}`);
			assert.equal(visibleLength(result), width, `width=${width}`);
			assert.equal(result.includes("\x1b[0m"), false, `width=${width}: full reset leaks`);
		}
	});
	it("closes an open color span with a foreground-only reset", () => {
		const result = fitCell(`${SGR_RED}averylongcoloredvalue`, 8);
		assert.ok(visibleLength(result) <= 8);
		assert.ok(result.includes("\x1b[39m"), "must close fg span with ESC[39m");
		assert.equal(result.includes("\x1b[0m"), false, "full reset would destroy the surrounding bg");
		assert.ok(sanitizeTuiText(result).endsWith(ELLIPSIS));
	});
	it("width below the ellipsis truncates without overflowing (F-2, T-15)", () => {
		// Too narrow for the 3-col ellipsis: fitCell drops it rather than overflow width.
		const text = "abcdef";
		for (let width = 0; width < ELLIPSIS.length; width++) {
			const result = fitCell(text, width);
			assert.ok(
				visibleLength(result) <= Math.max(width, 0),
				`width=${width} produced ${JSON.stringify(result)} (${visibleLength(result)} cols)`,
			);
			assert.equal(result.includes("\x1b[0m"), false, `width=${width}: full reset leaks`);
		}
	});
});

describe("joinParts (T-10)", () => {
	it("drops falsy parts and joins with the default separator", () => {
		assert.equal(joinParts(["a", undefined, "b", false, null, "", "c"]), "a · b · c");
	});
	it("supports a custom separator", () => {
		assert.equal(joinParts(["a", "b"], "-"), "a-b");
	});
	it("all falsy yields empty string", () => {
		assert.equal(joinParts([undefined, null, false, ""]), "");
	});
});

describe("pickFitting (T-11)", () => {
	it("returns the first candidate that fits", () => {
		const candidates = ["a fairly long option", "shorter one", "tiny"];
		assert.equal(pickFitting(candidates, 30), "a fairly long option");
		assert.equal(pickFitting(candidates, 15), "shorter one");
		assert.equal(pickFitting(candidates, 5), "tiny");
	});
	it("force-fits the last candidate when none fit", () => {
		const candidates = ["aaaaaaaaaa", "bbbbbbbb", "cccccc"];
		const result = pickFitting(candidates, 5);
		assert.ok(visibleLength(result) <= 5, `got ${JSON.stringify(result)}`);
		assert.ok(sanitizeTuiText(result).startsWith("c"), "must derive from the last candidate");
	});
});

describe("normalizeSkillName (T-12)", () => {
	it("is deterministic and non-empty for a plain name", () => {
		const first = normalizeSkillName("my-skill");
		assert.equal(typeof first, "string");
		assert.ok(first.length > 0);
		assert.equal(normalizeSkillName("my-skill"), first);
	});
	it("gap pass (observed): strips the skill: command prefix", () => {
		assert.equal(normalizeSkillName("skill:commit"), "commit");
		assert.equal(normalizeSkillName("plain"), "plain");
	});
});
