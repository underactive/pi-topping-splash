/** pi-tui `matchesKey` encodings (contract M-08). */
export const KEY = {
	esc: "\x1b",
	tab: "\t",
	enter: "\r",
	space: " ",
	backspace: "\x7f",
	delete: "\x1b[3~",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
} as const;
