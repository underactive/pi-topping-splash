import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	cliContextFilesDisabled,
	cliSystemPromptSources,
	discoverAppendSystemPromptFile,
	discoverSystemPromptFile,
	formatContextPath,
	getLoadedContextFiles,
	getLoadedHeaderItems,
	getSystemPromptSources,
} from "../src/discovery.ts";
import { cliExtensionArgs } from "../src/extensions.ts";
import { setArgv, tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { createFakePi } from "./helpers/fake-api.ts";

let env: TempAgentEnv;
let restoreArgv: () => void;

beforeEach(() => {
	env = tempAgentDir();
	restoreArgv = setArgv([]);
});
afterEach(() => {
	restoreArgv();
	env.restore();
});

describe("cliExtensionArgs (D-02)", () => {
	it("defaults to extensions enabled with no explicit sources", () => {
		const { noExtensions, explicit } = cliExtensionArgs();
		assert.equal(noExtensions, false);
		assert.equal(explicit.size, 0);
	});
	it("parses --no-extensions", () => {
		restoreArgv();
		restoreArgv = setArgv(["--no-extensions"]);
		assert.equal(cliExtensionArgs().noExtensions, true);
	});
	it("collects --extension and -e sources", () => {
		restoreArgv();
		restoreArgv = setArgv(["-e", "/a.ts", "--extension", "/b.ts", "--other", "x"]);
		const { explicit } = cliExtensionArgs();
		assert.ok(explicit.has("/a.ts"));
		assert.ok(explicit.has("/b.ts"));
		assert.equal(explicit.has("x"), false);
	});
});

describe("cliContextFilesDisabled (D-10)", () => {
	it("false by default, true under --no-context-files or -nc", () => {
		assert.equal(cliContextFilesDisabled(), false);
		restoreArgv();
		restoreArgv = setArgv(["--no-context-files"]);
		assert.equal(cliContextFilesDisabled(), true);
		restoreArgv();
		restoreArgv = setArgv(["-nc"]);
		assert.equal(cliContextFilesDisabled(), true);
	});
});

describe("formatContextPath (D-11)", () => {
	it("paths inside cwd are shown relative, outside are ~-shortened or absolute", () => {
		assert.equal(formatContextPath(join(env.cwd, "AGENTS.md"), env.cwd), "AGENTS.md");
		assert.equal(formatContextPath(join(env.cwd, "docs", "CLAUDE.md"), env.cwd), join("docs", "CLAUDE.md"));
		// A parent dir is outside cwd (".." does not count as inside, mirroring pi), so it
		// falls back to the absolute/~ form rather than "../...".
		const parent = formatContextPath(join(env.cwd, "..", "sibling", "AGENTS.md"), env.cwd);
		assert.notEqual(parent, join("..", "sibling", "AGENTS.md"));
		assert.match(parent, /^(\/|~|[A-Za-z]:)/, `absolute or ~-shortened expected, got ${parent}`);
	});
	it("paths under the home dir are ~-shortened", () => {
		assert.equal(formatContextPath(join(homedir(), "agent", "AGENTS.md"), env.cwd), join("~", "agent", "AGENTS.md"));
	});
});

describe("cliSystemPromptSources (D-12)", () => {
	it("empty by default", () => {
		assert.deepEqual(cliSystemPromptSources(), { systemPrompt: undefined, appendSystemPrompt: [] });
	});
	it("parses --system-prompt and --append-system-prompt in space and = forms", () => {
		restoreArgv();
		restoreArgv = setArgv([
			"--system-prompt",
			"/sp.md",
			"--append-system-prompt=/a1.md",
			"--append-system-prompt",
			"/a2.md",
			"--other",
			"--system-prompt",
		]);
		assert.deepEqual(cliSystemPromptSources(), {
			systemPrompt: "/sp.md",
			appendSystemPrompt: ["/a1.md", "/a2.md"],
		});
	});
});

describe("discoverSystemPromptFile / discoverAppendSystemPromptFile (D-13)", () => {
	it("trusted project file wins over the agent file", () => {
		mkdirSync(join(env.cwd, ".pi"), { recursive: true });
		writeFileSync(join(env.cwd, ".pi", "SYSTEM.md"), "project");
		writeFileSync(join(env.agentDir, "SYSTEM.md"), "global");
		assert.equal(discoverSystemPromptFile(env.cwd, env.agentDir, true), join(env.cwd, ".pi", "SYSTEM.md"));
	});
	it("untrusted project file is skipped, agent file used instead", () => {
		mkdirSync(join(env.cwd, ".pi"), { recursive: true });
		writeFileSync(join(env.cwd, ".pi", "SYSTEM.md"), "project");
		writeFileSync(join(env.agentDir, "SYSTEM.md"), "global");
		assert.equal(discoverSystemPromptFile(env.cwd, env.agentDir, false), join(env.agentDir, "SYSTEM.md"));
	});
	it("undefined when neither exists", () => {
		assert.equal(discoverSystemPromptFile(env.cwd, env.agentDir, true), undefined);
		assert.equal(discoverAppendSystemPromptFile(env.cwd, env.agentDir, false), undefined);
	});
	it("APPEND_SYSTEM.md follows the same rules", () => {
		mkdirSync(join(env.cwd, ".pi"), { recursive: true });
		writeFileSync(join(env.cwd, ".pi", "APPEND_SYSTEM.md"), "project");
		assert.equal(discoverAppendSystemPromptFile(env.cwd, env.agentDir, true), join(env.cwd, ".pi", "APPEND_SYSTEM.md"));
		assert.equal(discoverAppendSystemPromptFile(env.cwd, env.agentDir, false), undefined);
	});
});

describe("getSystemPromptSources (D-14)", () => {
	function seedProjectFiles(): void {
		mkdirSync(join(env.cwd, ".pi"), { recursive: true });
		writeFileSync(join(env.cwd, ".pi", "SYSTEM.md"), "project-system");
		writeFileSync(join(env.cwd, ".pi", "APPEND_SYSTEM.md"), "project-append");
	}

	it("discovered system prompt before append source", () => {
		seedProjectFiles();
		assert.deepEqual(getSystemPromptSources(env.cwd, env.agentDir, true), [
			join(env.cwd, ".pi", "SYSTEM.md"),
			join(env.cwd, ".pi", "APPEND_SYSTEM.md"),
		]);
	});
	it("CLI sources override discovery entirely", () => {
		seedProjectFiles();
		const cliSp = join(env.cwd, "cli-sp.md");
		const cliAp = join(env.cwd, "cli-ap.md");
		writeFileSync(cliSp, "cli-system");
		writeFileSync(cliAp, "cli-append");
		restoreArgv();
		restoreArgv = setArgv(["--system-prompt", cliSp, "--append-system-prompt", cliAp]);
		assert.deepEqual(getSystemPromptSources(env.cwd, env.agentDir, true), [cliSp, cliAp]);
	});
	it("CLI values that are not existing files are dropped", () => {
		restoreArgv();
		restoreArgv = setArgv(["--system-prompt", "plain text override", "--append-system-prompt", "more text"]);
		assert.deepEqual(getSystemPromptSources(env.cwd, env.agentDir, true), []);
	});
	it("untrusted project: agent-dir files only", () => {
		seedProjectFiles();
		writeFileSync(join(env.agentDir, "SYSTEM.md"), "agent-system");
		assert.deepEqual(getSystemPromptSources(env.cwd, env.agentDir, false), [join(env.agentDir, "SYSTEM.md")]);
	});
});

describe("getLoadedContextFiles (D-09)", () => {
	function seedContext(): string {
		// Deeper project cwd so env.cwd acts as a real ancestor with its own context file.
		const project = join(env.cwd, "project");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(env.agentDir, "AGENTS.md"), "global");
		writeFileSync(join(env.cwd, "CLAUDE.md"), "parent");
		writeFileSync(join(project, "AGENTS.md"), "project");
		return project;
	}

	it("lists global then ancestor context files in load order", () => {
		const project = seedContext();
		const files = getLoadedContextFiles(project, false);
		// The temp dir names identify each file's owner across absolute/~ display forms.
		const globalShown = files.filter((f) => f.includes("pi-splash-agent"));
		assert.equal(globalShown.length, 1, `global file listed once: ${JSON.stringify(files)}`);
		assert.ok(globalShown[0]!.endsWith("AGENTS.md"), "global AGENTS.md wins over CLAUDE.md");
		const parentShown = files.filter((f) => f.includes("pi-splash-cwd"));
		assert.equal(parentShown.length, 1, `parent file listed once: ${JSON.stringify(files)}`);
		assert.ok(parentShown[0]!.endsWith("CLAUDE.md"), "parent CLAUDE.md picked when it has no AGENTS.md");
		assert.equal(files[files.length - 1], "AGENTS.md", "project (innermost) file listed last");
		assert.ok(files.indexOf(globalShown[0]!) < files.indexOf("AGENTS.md"), "global listed before project");
		assert.ok(files.indexOf(parentShown[0]!) < files.indexOf("AGENTS.md"), "outer ancestors listed before inner");
	});

	it("system prompt sources come before the agents files", () => {
		const project = seedContext();
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi", "SYSTEM.md"), "project-system");
		writeFileSync(join(project, ".pi", "APPEND_SYSTEM.md"), "project-append");
		const files = getLoadedContextFiles(project, true);
		assert.ok(files[0] === ".pi/SYSTEM.md" || files[0] === join(".pi", "SYSTEM.md"), JSON.stringify(files));
		assert.ok(files[1] === ".pi/APPEND_SYSTEM.md" || files[1] === join(".pi", "APPEND_SYSTEM.md"), JSON.stringify(files));
		assert.equal(files[files.length - 1], "AGENTS.md", "agents files last");
	});

	it("AGENTS.md takes precedence over CLAUDE.md in the same dir", () => {
		writeFileSync(join(env.agentDir, "AGENTS.md"), "global");
		writeFileSync(join(env.agentDir, "CLAUDE.md"), "global-claude");
		const files = getLoadedContextFiles(env.cwd, false);
		const globalFiles = files.filter((f) => f.includes("pi-splash-agent"));
		assert.equal(globalFiles.length, 1, `got ${JSON.stringify(files)}`);
		assert.ok(globalFiles[0]!.endsWith("AGENTS.md"), "AGENTS.md must shadow CLAUDE.md");
	});

	it("CLAUDE.md is picked when AGENTS.md is absent", () => {
		writeFileSync(join(env.cwd, "CLAUDE.md"), "project-claude");
		const files = getLoadedContextFiles(env.cwd, false);
		assert.ok(files.includes("CLAUDE.md"), `cwd file shows bare (cwd-relative): ${JSON.stringify(files)}`);
		assert.equal(files.filter((f) => f.endsWith("CLAUDE.md")).length, 1, `got ${JSON.stringify(files)}`);
	});

	it("empty when --no-context-files is passed", () => {
		seedContext();
		restoreArgv();
		restoreArgv = setArgv(["--no-context-files"]);
		assert.deepEqual(getLoadedContextFiles(env.cwd, true), []);
	});
});

describe("getLoadedHeaderItems (D-07)", () => {
	it("lists skill commands and pi-style discovered extensions, sorted", () => {
		const extDir = join(env.agentDir, "extensions");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "fs-ext.ts"), "");
		writeFileSync(join(env.agentDir, "AGENTS.md"), "global");
		writeFileSync(join(env.cwd, "AGENTS.md"), "project");
		const sourceInfo = (path: string) => ({ path, source: "extension", scope: "user", origin: "top-level" });
		const harness = createFakePi({
			commandsInfo: [
				{ name: "my-skill", source: "skill", sourceInfo: sourceInfo("/skills/my-skill/SKILL.md") },
				{ name: "some-cmd", source: "extension", sourceInfo: sourceInfo("/exts/cmd-ext/index.ts") },
			],
			toolsInfo: [{ name: "a-tool", sourceInfo: sourceInfo("/exts/node_modules/@scope/tool-pkg/dist/index.js") }],
		});
		const { skills, extensions, context } = getLoadedHeaderItems(harness.pi, env.cwd, false);
		assert.ok(skills.includes("my-skill"), `skills: ${JSON.stringify(skills)}`);
		// Extensions come from pi-style discovery only: the on-disk file is listed (labeled by
		// path suffix), while command/tool sources add nothing — pi filters hidden inline
		// extensions from its display and lists what it actually loaded.
		assert.deepEqual(extensions, ["fs-ext.ts"], `extensions: ${JSON.stringify(extensions)}`);
		assert.deepEqual(skills, [...skills].sort());
		assert.ok(context.includes("AGENTS.md"), `context: ${JSON.stringify(context)}`);
	});
});
