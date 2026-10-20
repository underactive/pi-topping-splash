import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as shared from "@underactive/pi-topping-primitives/text";
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

describe("layout helpers are the shared primitives (T-04, T-05, T-08, T-09, T-10, T-11, T-14, T-15 moved to @underactive/pi-topping-primitives/text)", () => {
	it("re-exports each helper unchanged", () => {
		assert.equal(ELLIPSIS, shared.ELLIPSIS);
		assert.equal(fitCell, shared.fitCell);
		assert.equal(joinParts, shared.joinParts);
		assert.equal(padCenter, shared.padCenter);
		assert.equal(padRight, shared.padRight);
		assert.equal(pickFitting, shared.pickFitting);
		assert.equal(truncateVisible, shared.truncateVisible);
		assert.equal(wrapCommaDelimited, shared.wrapCommaDelimited);
	});
	it("pickFitting of no candidates is an empty string", () => {
		assert.equal(pickFitting([], 5), "");
	});
});
