import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { availableModelRefs, modelRefLabel } from "../src/model-picker.ts";
import { createFakeCtx, makeModel } from "./helpers/fake-ctx.ts";
import { createFakeTui } from "./helpers/fake-tui.ts";
import { bootstrapGlobalTheme, makeTheme } from "./helpers/theme.ts";

bootstrapGlobalTheme();

describe("availableModelRefs (M-04)", () => {
	it("availableModelRefs sorts by display label", () => {
		const tui = createFakeTui();
		const ctx = createFakeCtx({
			cwd: "/tmp",
			theme: makeTheme(),
			tui: tui.tui,
			models: [makeModel("zeta", "m-late"), makeModel("alpha", "m-early"), makeModel("mid", "m-mid")],
		});
		const refs = availableModelRefs(ctx.ctx);
		const labels = refs.map(modelRefLabel);
		assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b)));
		assert.equal(refs.length, 3);
	});
});
