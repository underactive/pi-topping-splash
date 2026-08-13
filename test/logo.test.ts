import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOGO, LOGO_INK, LOGO_LINES, LOGO_SHADOW, LOGO_SHADOW_OFFSET, LOGO_WIDTH } from "../src/logo.ts";

describe("logo geometry (L-01)", () => {
	it("LOGO_WIDTH is the widest line", () => {
		assert.ok(LOGO_LINES.length >= 1);
		for (const line of LOGO_LINES) {
			assert.ok(line.length <= LOGO_WIDTH);
		}
		assert.equal(Math.max(...LOGO_LINES.map((l) => l.length)), LOGO_WIDTH);
	});
	it("carries visible art", () => {
		assert.ok(LOGO_LINES.some((l) => l.trim().length > 0));
	});
});

describe("logo encoding (L-02, Bun String.raw corruption guard)", () => {
	it("contains real block/powerline glyphs, not escape text", () => {
		assert.ok(/[^\x00-\x7f]/.test(LOGO), "logo must contain non-ASCII art glyphs");
		assert.ok(/[\u2580-\u259f\ue0b0-\ue0bf]/.test(LOGO), "logo must contain block-element or powerline glyphs");
		assert.equal(LOGO.includes("\\u"), false, "literal \\uXXXX text means a transpiler ASCII-escaped String.raw");
	});
});

describe("logo colors (L-03, L-04)", () => {
	it("ink and shadow are the documented hex values as triplets", () => {
		assert.equal(LOGO_INK, "242;242;242");
		assert.equal(LOGO_SHADOW, "21;15;40");
	});
	it("shadow offset is one cell", () => {
		assert.equal(LOGO_SHADOW_OFFSET, 1);
	});
});
