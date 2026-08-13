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
	/** Newest overlay that has not been permanently hidden. */
	live(): FakeOverlay | undefined;
}

/**
 * Implements only the TUI surface the extension touches; anything else fails loudly.
 * Cast is unavoidable: TUI is a class with private fields.
 */
export function createFakeTui(options: { rows?: number; columns?: number } = {}): FakeTuiHarness {
	const overlays: FakeOverlay[] = [];
	const renderRequests: (boolean | undefined)[] = [];
	const harness: FakeTuiHarness = {
		tui: undefined as unknown as TUI,
		overlays,
		renderRequests,
		stopCount: 0,
		live: () => [...overlays].reverse().find((o) => !o.removed),
	};
	const fake = {
		terminal: { rows: options.rows ?? 40, columns: options.columns ?? 100 },
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
