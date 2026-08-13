import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLoadedExtensionLabels } from "./extensions.ts";
import { normalizeSkillName, uniqueSorted } from "./text.ts";

/** True when the process was started with --no-context-files/-nc: pi then loads no context files. */
export function cliContextFilesDisabled(): boolean {
	const argv = process.argv.slice(2);
	return argv.includes("--no-context-files") || argv.includes("-nc");
}

/**
 * Parse this process's argv for `--system-prompt` and `--append-system-prompt` values
 * (space and `=` forms). These override the discovered SYSTEM.md/APPEND_SYSTEM.md files.
 */
export function cliSystemPromptSources(): { systemPrompt: string | undefined; appendSystemPrompt: string[] } {
	const argv = process.argv.slice(2);
	let systemPrompt: string | undefined;
	const appendSystemPrompt: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--system-prompt") {
			if (i + 1 < argv.length) systemPrompt = argv[++i];
			continue;
		}
		if (arg.startsWith("--system-prompt=")) {
			systemPrompt = arg.slice("--system-prompt=".length);
			continue;
		}
		if (arg === "--append-system-prompt") {
			if (i + 1 < argv.length) appendSystemPrompt.push(argv[++i]);
			continue;
		}
		if (arg.startsWith("--append-system-prompt=")) {
			appendSystemPrompt.push(arg.slice("--append-system-prompt=".length));
			continue;
		}
	}
	return { systemPrompt, appendSystemPrompt };
}

/**
 * The discovered SYSTEM.md source, mirroring pi's resource loader: the project's
 * `<cwd>/.pi/SYSTEM.md` when the project is trusted and the file exists, else the
 * agent dir's SYSTEM.md when it exists.
 */
export function discoverSystemPromptFile(cwd: string, agentDir: string, projectTrusted: boolean): string | undefined {
	const projectPath = join(cwd, CONFIG_DIR_NAME, "SYSTEM.md");
	if (projectTrusted && existsSync(projectPath)) return projectPath;
	const globalPath = join(agentDir, "SYSTEM.md");
	return existsSync(globalPath) ? globalPath : undefined;
}

/** Same shape as discoverSystemPromptFile, for APPEND_SYSTEM.md. */
export function discoverAppendSystemPromptFile(cwd: string, agentDir: string, projectTrusted: boolean): string | undefined {
	const projectPath = join(cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
	if (projectTrusted && existsSync(projectPath)) return projectPath;
	const globalPath = join(agentDir, "APPEND_SYSTEM.md");
	return existsSync(globalPath) ? globalPath : undefined;
}

/**
 * The system-prompt source files pi loads, mirroring its /loaded Context section: the
 * `--system-prompt` value when given (and it names an existing file), else the discovered
 * SYSTEM.md; then the `--append-system-prompt` values that name existing files, else the
 * discovered APPEND_SYSTEM.md.
 */
export function getSystemPromptSources(cwd: string, agentDir: string, projectTrusted: boolean): string[] {
	const cli = cliSystemPromptSources();
	const systemPromptSource = cli.systemPrompt ?? discoverSystemPromptFile(cwd, agentDir, projectTrusted);
	const appendSource = discoverAppendSystemPromptFile(cwd, agentDir, projectTrusted);
	const appendSources = cli.appendSystemPrompt.length > 0 ? cli.appendSystemPrompt : (appendSource ? [appendSource] : []);
	return [
		...(systemPromptSource && existsSync(systemPromptSource) ? [systemPromptSource] : []),
		...appendSources.filter((source) => existsSync(source)),
	];
}

/**
 * Display form of a context file path, mirroring pi's own /loaded Context listing:
 * relative to the session cwd when inside it, else `~`-shortened under the home dir,
 * else the absolute path.
 */
export function formatContextPath(p: string, cwd: string): string {
	const absolute = resolve(p);
	const rel = relative(cwd, absolute);
	const insideCwd = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (insideCwd) return rel === "" ? "." : rel;
	const home = homedir();
	return absolute === home || absolute.startsWith(`${home}${sep}`) ? `~${absolute.slice(home.length)}` : absolute;
}

/**
 * The context files pi loads for this launch — SYSTEM.md/APPEND_SYSTEM.md system-prompt
 * sources, then the AGENTS.md/CLAUDE.md files from the agent dir and every ancestor of
 * cwd — via the same loaders pi's own resource loader calls. Honors --no-context-files.
 * Display names follow formatContextPath, in pi's /loaded order: system prompt source,
 * append sources, then agents files (global first, outermost to innermost).
 */
export function getLoadedContextFiles(cwd: string, projectTrusted: boolean): string[] {
	if (cliContextFilesDisabled()) return [];
	const agentDir = getAgentDir();
	return [
		...getSystemPromptSources(cwd, agentDir, projectTrusted),
		...loadProjectContextFiles({ cwd, agentDir }).map((file) => file.path),
	].map((path) => formatContextPath(path, cwd));
}

/**
 * Names of every currently loaded skill and extension, plus the loaded context files, for the
 * splash info panel. Skills come from the `skill:`-prefixed commands pi registers per loaded
 * skill (its `skill.name`); extensions are discovered with pi's own package-manager logic and
 * labeled with its startup-screen compact labels; context comes from loadProjectContextFiles
 * with `cwd` as the session's working directory.
 */
export function getLoadedHeaderItems(pi: ExtensionAPI, cwd: string, projectTrusted: boolean): { skills: string[]; extensions: string[]; context: string[] } {
	const commands = pi.getCommands();

	const skills = commands
		.filter((command) => command.source === "skill")
		.map((command) => normalizeSkillName(command.name));

	return {
		skills: uniqueSorted(skills),
		extensions: getLoadedExtensionLabels(cwd, getAgentDir(), projectTrusted),
		context: getLoadedContextFiles(cwd, projectTrusted),
	};
}
