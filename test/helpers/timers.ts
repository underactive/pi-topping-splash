type TimerCtx = { mock: { timers: { enable(opts: { apis: string[] }): void; tick(ms: number): void } } };

// Single cast site for @types/node's untyped t.mock.timers; returns the handle so tests can tick.
export function enableTimers(t: unknown): TimerCtx["mock"]["timers"] {
	const timers = (t as TimerCtx).mock.timers;
	timers.enable({ apis: ["setInterval", "Date"] });
	return timers;
}
