import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface TempAgentEnv {
	agentDir: string;
	cwd: string;
	restore(): void;
}

/**
 * Redirect every pi filesystem side effect (settings.json, sessions, extension discovery)
 * into fresh temp dirs. The getAgentDir() self-check turns an upstream rename of the env
 * var into a loud failure instead of a silent write to the user's real ~/.pi/agent.
 */
export function tempAgentDir(): TempAgentEnv {
	const base = realpathSync(tmpdir());
	const agentDir = mkdtempSync(join(base, "pi-splash-agent-"));
	const cwd = mkdtempSync(join(base, "pi-splash-cwd-"));
	const savedAgent = process.env.PI_CODING_AGENT_DIR;
	const savedSession = process.env.PI_CODING_AGENT_SESSION_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
	assert.equal(
		getAgentDir(),
		agentDir,
		"PI_CODING_AGENT_DIR no longer redirects getAgentDir() — refusing to run tests against the real ~/.pi/agent",
	);
	return {
		agentDir,
		cwd,
		restore() {
			if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedAgent;
			if (savedSession === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
			else process.env.PI_CODING_AGENT_SESSION_DIR = savedSession;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

/** Replace process.argv[2..] (and optionally argv[1]); returns a restore function. */
export function setArgv(args: string[], entry?: string): () => void {
	const saved = process.argv;
	process.argv = [saved[0] ?? "node", entry ?? saved[1] ?? "", ...args];
	return () => {
		process.argv = saved;
	};
}

export function setEnv(key: string, value: string | undefined): () => void {
	const saved = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
	return () => {
		if (saved === undefined) delete process.env[key];
		else process.env[key] = saved;
	};
}
