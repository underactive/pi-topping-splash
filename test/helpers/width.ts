import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Every line must fill exactly `width` columns (full-bleed surfaces). */
export function assertLinesExact(lines: string[], width: number, label: string): void {
	for (let i = 0; i < lines.length; i++) {
		const w = visibleWidth(lines[i] ?? "");
		assert.equal(w, width, `${label}: line ${i} is ${w} cols, expected exactly ${width}`);
	}
}

/** No line may exceed `width` columns (interior/unpadded surfaces). */
export function assertLinesAtMost(lines: string[], width: number, label: string): void {
	for (let i = 0; i < lines.length; i++) {
		const w = visibleWidth(lines[i] ?? "");
		assert.ok(w <= width, `${label}: line ${i} is ${w} cols, exceeds ${width}`);
	}
}
