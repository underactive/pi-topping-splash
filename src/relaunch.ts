import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "./model-picker.ts";
import { sanitizeTuiText } from "./text.ts";

/** Env guard set on relaunch children so the gate never re-triggers (prevents loops). */
export const GATE_DONE_ENV = "PI_SPLASH_GATE_DONE";

/** Overrides applied when rebuilding the CLI args for an in-place pi relaunch. */
export interface RelaunchOverrides {
	/** Resume this specific session file. */
	session?: string;
	/** Force this model/provider (used to preserve an in-gate model change). */
	model?: { id: string; provider: string };
	/** Force this thinking level (used to preserve an in-gate thinking change). */
	thinking?: ThinkingLevel;
}

/**
 * Rebuild the process argv for a relaunch, stripping flags that would conflict with the
 * gate's chosen overrides while preserving unrelated startup arguments (including any
 * `--skill`/`--extension` selection, which the relaunched session inherits as-is).
 */
export function buildRelaunchArgs(overrides: RelaunchOverrides): string[] {
	// Flags that take a following value (so we must also drop that value when stripping).
	const valueFlags = new Set(["--session", "--model", "--provider", "--session-dir", "--models", "--thinking"]);
	// All flags to strip before applying overrides (includes value-less resume/continue toggles).
	const removeFlags = new Set([
		"--session", "-r", "--resume", "-c", "--continue", "--model", "--provider",
		"--session-dir", "--models", "--thinking",
	]);

	const original = process.argv.slice(2);
	const kept: string[] = [];
	for (let i = 0; i < original.length; i++) {
		const arg = original[i];
		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const name = eq !== -1 ? arg.slice(0, eq) : arg;
		if (removeFlags.has(name)) {
			// "--flag value" form: also skip the value. "--flag=value" form carries its own value.
			if (eq === -1 && valueFlags.has(name) && i + 1 < original.length) i++;
			continue;
		}
		kept.push(arg);
	}

	const args = [...kept];
	if (overrides.session) args.push("--session", overrides.session);
	if (overrides.model) args.push("--model", `${overrides.model.provider}/${overrides.model.id}`);
	if (overrides.thinking) args.push("--thinking", overrides.thinking);
	return args;
}

/**
 * Relaunch pi in-place: stop the TUI to release the terminal, run a fresh pi process with the
 * rebuilt args (inheriting stdio so the child fully owns the terminal), then shut down this
 * parent only after the child exits cleanly. The `GATE_DONE_ENV` guard stops the child from
 * re-showing the gate, so it lands directly in the session.
 */
export function relaunchPi(tui: TUI, ctx: ExtensionContext, overrides: RelaunchOverrides): void {
	const args = buildRelaunchArgs(overrides);
	const entry = process.argv[1];
	if (!entry) {
		ctx.ui.notify("Cannot relaunch: pi entry point not found", "error");
		return;
	}
	tui.stop();
	// Clear screen, home the cursor, and wipe scrollback so the child session starts at the
	// top of a clean terminal with no splash left behind in history.
	process.stdout.write("\x1b[2J\x1b[H\x1b[3J");
	const env = { ...process.env, [GATE_DONE_ENV]: "1" };
	const result = spawnSync(process.execPath, [entry, ...args], { stdio: "inherit", env });
	if (result.error || result.status !== 0 || result.signal) {
		const reason = result.error?.message ?? (result.signal ? `terminated by ${result.signal}` : `exited with code ${result.status ?? "unknown"}`);
		ctx.ui.notify(`Cannot relaunch pi: ${sanitizeTuiText(reason)}`, "error");
		ctx.shutdown();
		return;
	}
	ctx.shutdown();
}
