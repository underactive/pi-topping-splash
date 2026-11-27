import { SETTINGS_DIALOG_WIDTH } from "../../src/ui/dialog-size.ts";

/** What pi-tui holds of a component a dialog mounted through `ui.custom`. */
export interface Shown {
	render(width: number): readonly string[];
	handleInput?(data: string): void;
}

/** Columns and rows of a terminal. */
export interface Terminal {
	columns: number;
	rows: number;
}

export const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/** The dialog as the user sees it, without styling. */
export const screen = (component: Shown, width = SETTINGS_DIALOG_WIDTH): string => component.render(width).map(stripAnsi).join("\n");

/** A key handler only sets state and React commits a moment later: wait until the frame holds still. */
export async function settle(component: Shown, width = SETTINGS_DIALOG_WIDTH): Promise<void> {
	let previous = component.render(width).join("\n");
	for (let quiet = 0; quiet < 2;) {
		await turn();
		const current = component.render(width).join("\n");
		quiet = current === previous ? quiet + 1 : 0;
		previous = current;
	}
}

/** One key at a time, each given the time to commit: two together would see a stale render. */
export async function press(component: Shown, ...keys: string[]): Promise<void> {
	for (const key of keys) {
		component.handleInput?.(key);
		await settle(component);
	}
}
