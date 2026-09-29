import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";

export interface FakeOverlay {
	component: Component;
	options: OverlayOptions | undefined;
	hidden: boolean;
	removed: boolean;
	setHiddenCalls: boolean[];
}

export interface FakeTuiHarness {
	tui: TUI;
	overlays: FakeOverlay[];
	/** Arguments of every requestRender call (undefined = no force flag). */
	renderRequests: (boolean | undefined)[];
	stopCount: number;
	/** Simulate a terminal resize without changing the readonly TUI terminal type. */
	resizeRows(rows: number): void;
	/** Newest overlay that has not been permanently hidden. */
	live(): FakeOverlay | undefined;
}

/**
 * Implements only the TUI surface the extension touches; anything else fails loudly.
 * Cast is unavoidable: the fake implements only part of the TUI surface.
 */
export function createFakeTui(options: { rows?: number; columns?: number } = {}): FakeTuiHarness {
	const overlays: FakeOverlay[] = [];
	const renderRequests: (boolean | undefined)[] = [];
	const terminal = { rows: options.rows ?? 40, columns: options.columns ?? 100 };
	const harness: FakeTuiHarness = {
		tui: undefined as unknown as TUI,
		overlays,
		renderRequests,
		stopCount: 0,
		resizeRows: (rows) => { terminal.rows = rows; },
		live: () => [...overlays].reverse().find((o) => !o.removed),
	};
	const fake = {
		terminal,
		requestRender(force?: boolean): void {
			renderRequests.push(force);
		},
		showOverlay(component: Component, overlayOptions?: OverlayOptions): OverlayHandle {
			const entry: FakeOverlay = {
				component,
				options: overlayOptions,
				hidden: false,
				removed: false,
				setHiddenCalls: [],
			};
			overlays.push(entry);
			const handle = {
				hide: () => {
					entry.removed = true;
				},
				setHidden: (hidden: boolean) => {
					entry.hidden = hidden;
					entry.setHiddenCalls.push(hidden);
				},
				isHidden: () => entry.hidden,
				focus: () => {},
			};
			return handle as unknown as OverlayHandle;
		},
		stop(): void {
			harness.stopCount++;
		},
	};
	harness.tui = fake as unknown as TUI;
	return harness;
}
