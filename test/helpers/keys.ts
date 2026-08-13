/** pi-tui `matchesKey` encodings (contract M-08). */
export const KEY = {
	esc: "\x1b",
	tab: "\t",
	enter: "\r",
	space: " ",
	backspace: "\x7f",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
} as const;
