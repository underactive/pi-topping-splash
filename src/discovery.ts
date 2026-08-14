import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, keyText, loadProjectContextFiles, parseArgs } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Keybinding } from "@earendil-works/pi-tui";

import { getLoadedExtensionLabels } from "./extensions.ts";
import { normalizeSkillName, sanitizeTuiText, uniqueSorted } from "./text.ts";

/** True when the process was started with --no-context-files/-nc: pi then loads no context files. */
export function cliContextFilesDisabled(): boolean {
	return parseArgs(process.argv.slice(2)).noContextFiles === true;
}

/**
 * Parse this process's argv for `--system-prompt` and `--append-system-prompt` values.
 * These override the discovered SYSTEM.md/APPEND_SYSTEM.md files.
 */
export function cliSystemPromptSources(): { systemPrompt: string | undefined; appendSystemPrompt: string[] } {
	const parsed = parseArgs(process.argv.slice(2));
	return { systemPrompt: parsed.systemPrompt, appendSystemPrompt: parsed.appendSystemPrompt ?? [] };
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
 * discovered APPEND_SYSTEM.md. Non-existent CLI values are dropped (they may be inline
 * text and a fallback would misreport what pi actually loaded).
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

/** A compact startup shortcut hint: an effective keybinding plus its description. */
export interface ShortcutHint {
	key: string;
	description: string;
}

/**
 * Prompt template commands discovered from pi, formatted as `/name`.
 * Filters `pi.getCommands()` for `source === "prompt"`, prefixes names with `/`,
 * then sanitizes, deduplicates, and sorts through `uniqueSorted`.
 */
export function getLoadedPrompts(pi: ExtensionAPI, commands: ReturnType<ExtensionAPI["getCommands"]> = pi.getCommands()): string[] {
	const prompts = commands
		.filter((command) => command.source === "prompt")
		.map((command) => `/${command.name}`);
	return uniqueSorted(prompts);
}

/**
 * The five compact startup shortcut hints, using pi's exported `keyText()` to resolve
 * the effective, user-customized keybindings rather than copied defaults.
 */
export function getShortcutHints(): ShortcutHint[] {
	const keyFor = (binding: Keybinding, fallback: string): string => {
		try {
			const formatted = keyText(binding);
			if (formatted) return sanitizeTuiText(formatted);
		} catch {
			// Binding not registered — fall back to literal.
		}
		return fallback;
	};

	return [
		{ key: keyFor("app.interrupt", "Ctrl+C"), description: "interrupt" },
		{ key: `${keyFor("app.clear", "Ctrl+L")}/${keyFor("app.exit", "Ctrl+Q")}`, description: "clear/exit" },
		{ key: "/", description: "commands" },
		{ key: "!", description: "bash" },
		{ key: keyFor("app.tools.expand", "Ctrl+T"), description: "more" },
	];
}

/**
 * Names of every currently loaded skill and extension, plus the loaded context files, for the
 * splash info panel. Skills come from the `skill:`-prefixed commands pi registers per loaded
 * skill (its `skill.name`); extensions are discovered with pi's own package-manager logic and
 * labeled with its startup-screen compact labels; context comes from loadProjectContextFiles
 * with `cwd` as the session's working directory.
 */
export function getLoadedHeaderItems(pi: ExtensionAPI, cwd: string, projectTrusted: boolean): { skills: string[]; extensions: string[]; context: string[]; prompts: string[]; shortcuts: ShortcutHint[] } {
	const commands = pi.getCommands();

	const skills = commands
		.filter((command) => command.source === "skill")
		.map((command) => normalizeSkillName(command.name));

	return {
		skills: uniqueSorted(skills),
		extensions: getLoadedExtensionLabels(cwd, getAgentDir(), projectTrusted),
		context: getLoadedContextFiles(cwd, projectTrusted),
		prompts: getLoadedPrompts(pi, commands),
		shortcuts: getShortcutHints(),
	};
}
