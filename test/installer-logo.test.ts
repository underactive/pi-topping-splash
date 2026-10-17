import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { LOGO_INK, LOGO_ROWS, LOGO_SHADOW_OFFSET, LOGO_STYLE_OPTIONS, LOGO_WIDTH } from "../src/logo.ts";
import {
	INSTALLER_LOGO_ANIMATION_BOUNDS,
	INSTALLER_LOGO_BRAND_FRAME,
	INSTALLER_LOGO_DURATION_MS,
	INSTALLER_LOGO_FRAMES,
	INSTALLER_LOGO_LAST_FRAME,
	INSTALLER_LOGO_LOOP,
	INSTALLER_LOGO_PALETTE,
	installerFrameIndex,
	resolveLogoStyle,
} from "../src/installer-logo.ts";
import { LOGO_TICK_MS } from "../src/animate.ts";

describe("installer logo transcription (IL-01..IL-04)", () => {
	it("transcribes the 21 installer frames and distinguishes the final flash from the brand mark", () => {
		assert.equal(INSTALLER_LOGO_FRAMES.length, 21);
		assert.equal(INSTALLER_LOGO_DURATION_MS, 2630);
		assert.deepEqual(INSTALLER_LOGO_FRAMES.map((frame) => frame.holdMs), [75, 75, 75, 75, 75, 75, 75, 75, 75, 75, 75, 75, 250, 80, 80, 80, 100, 450, 120, 120, 450]);
		assert.equal(createHash("sha256").update(JSON.stringify({ palette: INSTALLER_LOGO_PALETTE, frames: INSTALLER_LOGO_FRAMES })).digest("hex"), "f7769ccafedf7131c59e98cfb70445ab6816ec11c135c07976802735d8fe710d");
		assert.equal(INSTALLER_LOGO_LOOP, false);
		assert.equal(INSTALLER_LOGO_LAST_FRAME, INSTALLER_LOGO_FRAMES.length - 1);
		assert.equal(INSTALLER_LOGO_LAST_FRAME, 20, "the final source frame is the white hand-off flash");
		assert.equal(INSTALLER_LOGO_BRAND_FRAME, 19);
		assert.deepEqual(INSTALLER_LOGO_ANIMATION_BOUNDS, { x: 0, y: 0, width: 6, height: 7 });
		assert.deepEqual(
			[INSTALLER_LOGO_PALETTE.c, INSTALLER_LOGO_PALETTE.b, INSTALLER_LOGO_PALETTE.g, INSTALLER_LOGO_PALETTE.t, INSTALLER_LOGO_PALETTE.w, INSTALLER_LOGO_PALETTE.f],
			["240;144;130", "77;154;191", "241;190;88", "131;204;210", LOGO_INK, "255;255;255"],
		);
		const frame = INSTALLER_LOGO_FRAMES[INSTALLER_LOGO_BRAND_FRAME]!;
		assert.deepEqual(frame.pixels.slice(3, 7).map((row) => row.slice(1, 5)), ["ccc.", "b.c.", "bb.g", "b..g"]);
		// Normalize the final yellow column to the pi-logo.js row notation (`y`).
		assert.deepEqual(frame.pixels.slice(3, 7).map((row) => row.slice(1, 5).replaceAll("g", "y")), ["ccc.", "b.c.", "bb.y", "b..y"]);
		assert.deepEqual(INSTALLER_LOGO_FRAMES[INSTALLER_LOGO_LAST_FRAME]!.pixels.slice(3, 7).map((row) => row.slice(1, 5)), ["www.", "w.w.", "ww.w", "w..w"]);
	});

	it("keeps frames rectangular and proves the one animation-wide scale fits with the shadow", () => {
		const keys = new Set([...Object.keys(INSTALLER_LOGO_PALETTE), "."]);
		const scale = Math.floor(Math.min(LOGO_WIDTH / INSTALLER_LOGO_ANIMATION_BOUNDS.width, (2 * LOGO_ROWS) / INSTALLER_LOGO_ANIMATION_BOUNDS.height));
		let minHold = Number.POSITIVE_INFINITY;
		for (const [index, frame] of INSTALLER_LOGO_FRAMES.entries()) {
			assert.ok(frame.holdMs > 0, `frame ${index} hold`);
			minHold = Math.min(minHold, frame.holdMs);
			assert.ok(frame.pixels.length > 0, `frame ${index} rows`);
			for (const row of frame.pixels) {
				assert.equal(row.length, 8, `frame ${index} row width`);
				for (const pixel of row) assert.ok(keys.has(pixel), `frame ${index} has unknown pixel ${pixel}`);
			}
		}
		for (const color of Object.values(INSTALLER_LOGO_PALETTE)) assert.match(color, /^\d{1,3};\d{1,3};\d{1,3}$/);
		assert.equal(scale, 3, "all source frames use the scale from the 6x7 active union");
		const offsetX = Math.floor((LOGO_WIDTH - INSTALLER_LOGO_ANIMATION_BOUNDS.width * scale) / 2);
		const offsetYSub = Math.floor((2 * LOGO_ROWS - INSTALLER_LOGO_ANIMATION_BOUNDS.height * scale) / 4) * 2;
		assert.ok(offsetX + INSTALLER_LOGO_ANIMATION_BOUNDS.width * scale + LOGO_SHADOW_OFFSET <= LOGO_WIDTH, "shadow-inclusive width fits the fixed slot");
		assert.ok(offsetYSub + INSTALLER_LOGO_ANIMATION_BOUNDS.height * scale + 2 * LOGO_SHADOW_OFFSET <= 2 * LOGO_ROWS, "shadow-inclusive height fits the fixed slot");
		assert.ok(LOGO_TICK_MS <= minHold, "ticker cadence does not exceed the shortest source hold");
		assert.deepEqual(LOGO_STYLE_OPTIONS, ["random", "symbol", "logo"]);
	});

	it("selects each frame at its cumulative hold boundary and clamps to the final source frame", () => {
		let boundary = 0;
		for (const [index, frame] of INSTALLER_LOGO_FRAMES.entries()) {
			assert.equal(installerFrameIndex(boundary), index, `start of frame ${index}`);
			boundary += frame.holdMs;
			if (index < INSTALLER_LOGO_FRAMES.length - 1) {
				assert.equal(installerFrameIndex(boundary), index + 1, `end of frame ${index}`);
			}
		}
		assert.equal(boundary, INSTALLER_LOGO_DURATION_MS);
		assert.equal(installerFrameIndex(2180), 20, "the final white transition is part of playback");
		assert.equal(installerFrameIndex(INSTALLER_LOGO_DURATION_MS), INSTALLER_LOGO_LAST_FRAME, "clock includes the final white source frame");
		assert.equal(installerFrameIndex(INSTALLER_LOGO_DURATION_MS + 5000), INSTALLER_LOGO_LAST_FRAME);
		assert.equal(installerFrameIndex(-10), 0);
	});

	it("resolves the installer only with truecolor on supported terminals", () => {
		const previousTerm = process.env.TERM;
		const previousProgram = process.env.TERM_PROGRAM;
		try {
			process.env.TERM = "xterm-256color";
			delete process.env.TERM_PROGRAM;
			assert.equal(resolveLogoStyle("symbol", "truecolor"), "symbol");
			assert.equal(resolveLogoStyle("logo", "truecolor"), "logo");
			assert.equal(resolveLogoStyle("logo", "256color"), "symbol");
			process.env.TERM = "dumb";
			assert.equal(resolveLogoStyle("logo", "truecolor"), "symbol");
			if (process.platform === "darwin") {
				process.env.TERM = "xterm-256color";
				process.env.TERM_PROGRAM = "Apple_Terminal";
				assert.equal(resolveLogoStyle("logo", "truecolor"), "symbol");
			}
		} finally {
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
			if (previousProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = previousProgram;
		}
	});
});
