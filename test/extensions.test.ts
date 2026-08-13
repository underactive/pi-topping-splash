import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cliExtensionArgs, discoverLoadedExtensions, getExtensionLabels, getLoadedExtensionLabels } from "../src/extensions.ts";
import { setArgv, tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";

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

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

function writeSettings(settings: unknown): void {
	writeJson(join(env.agentDir, "settings.json"), settings);
}

function writeExtension(pkgName: string, entry: string): string {
	const pkgRoot = join(env.agentDir, "extensions", pkgName);
	writeJson(join(pkgRoot, "package.json"), { name: pkgName, pi: { extensions: [entry] } });
	const entryPath = join(pkgRoot, entry);
	mkdirSync(join(entryPath, ".."), { recursive: true });
	writeFileSync(entryPath, "");
	return entryPath;
}

function labels(): string[] {
	return getLoadedExtensionLabels(env.cwd, env.agentDir, false);
}

describe("discoverLoadedExtensions: agent extensions dir (E-01)", () => {
	it("package.json pi.extensions entries win over index.*", () => {
		const entry = writeExtension("ext-one", "src/index.ts");
		const discovered = discoverLoadedExtensions(env.cwd, env.agentDir, false);
		assert.deepEqual(discovered.map((e) => e.path), [entry]);
		assert.deepEqual(discovered.map((e) => e.source), ["auto"]);
		assert.equal(discovered[0]!.scope, "user");
		assert.equal(discovered[0]!.baseDir, env.agentDir);
	});
	it("dirs without a pi manifest fall back to index.ts/index.js", () => {
		const plain = join(env.agentDir, "extensions", "plain-ext");
		mkdirSync(plain, { recursive: true });
		writeFileSync(join(plain, "index.ts"), "");
		const single = join(env.agentDir, "extensions", "single.ts");
		writeFileSync(single, "");
		const labels = getExtensionLabels(discoverLoadedExtensions(env.cwd, env.agentDir, false));
		assert.ok(labels.includes("plain-ext"), `got ${JSON.stringify(labels)}`);
		assert.ok(labels.includes("single.ts"), `got ${JSON.stringify(labels)}`);
	});
	it("a dir without any entry file is not reported (pi skips it)", () => {
		mkdirSync(join(env.agentDir, "extensions", "bare-dir"), { recursive: true });
		const discovered = discoverLoadedExtensions(env.cwd, env.agentDir, false);
		assert.equal(discovered.some((e) => e.path.includes("bare-dir")), false);
	});
	it("dotfiles and node_modules are skipped", () => {
		mkdirSync(join(env.agentDir, "extensions"), { recursive: true });
		writeFileSync(join(env.agentDir, "extensions", ".hidden.ts"), "");
		writeExtension("ext-one", "index.ts");
		const discovered = discoverLoadedExtensions(env.cwd, env.agentDir, false);
		assert.equal(discovered.some((e) => e.path.includes("hidden")), false);
		assert.equal(discovered.some((e) => e.path.includes("node_modules")), false);
	});
	it("ignore files exclude entries; negation re-includes", () => {
		mkdirSync(join(env.agentDir, "extensions"), { recursive: true });
		writeFileSync(join(env.agentDir, "extensions", "ignored.ts"), "");
		writeFileSync(join(env.agentDir, "extensions", "kept.ts"), "");
		writeFileSync(join(env.agentDir, "extensions", ".gitignore"), "ignored.ts\n!kept.ts\n");
		const discovered = discoverLoadedExtensions(env.cwd, env.agentDir, false);
		const paths = discovered.map((e) => e.path);
		assert.equal(paths.some((p) => p.endsWith("ignored.ts")), false, JSON.stringify(paths));
		assert.ok(paths.some((p) => p.endsWith("kept.ts")), JSON.stringify(paths));
	});
	it("ignore files exclude whole directories", () => {
		writeExtension("skip-dir", "index.ts");
		writeFileSync(join(env.agentDir, "extensions", ".gitignore"), "skip-dir/\n");
		const discovered = discoverLoadedExtensions(env.cwd, env.agentDir, false);
		assert.equal(discovered.some((e) => e.path.includes("skip-dir")), false);
	});
});

describe("discoverLoadedExtensions: settings overrides (E-02)", () => {
	it("a -extensions/<rel> entry disables an auto-discovered extension", () => {
		writeExtension("off-ext", "index.ts");
		writeExtension("on-ext", "index.ts");
		writeSettings({ extensions: ["-extensions/off-ext/index.ts"] });
		const discovered = discoverLoadedExtensions(env.cwd, env.agentDir, false);
		const paths = discovered.map((e) => e.path);
		assert.equal(paths.some((p) => p.includes("off-ext")), false, JSON.stringify(paths));
		assert.ok(paths.some((p) => p.includes("on-ext")), JSON.stringify(paths));
	});
	it("a +extensions/<rel> entry force-includes through a ! glob exclude", () => {
		writeExtension("keep-ext", "index.ts");
		writeExtension("drop-ext", "index.ts");
		writeSettings({ extensions: ["!extensions/**", "+extensions/keep-ext/index.ts"] });
		const discovered = discoverLoadedExtensions(env.cwd, env.agentDir, false);
		const paths = discovered.map((e) => e.path);
		assert.ok(paths.some((p) => p.includes("keep-ext")), JSON.stringify(paths));
		assert.equal(paths.some((p) => p.includes("drop-ext")), false, JSON.stringify(paths));
	});
	it("a plain settings extensions entry loads a specific file", () => {
		const entry = writeExtension("specified-ext", "index.ts");
		writeSettings({ extensions: ["extensions/specified-ext/index.ts"] });
		const discovered = discoverLoadedExtensions(env.cwd, env.agentDir, false);
		assert.deepEqual(discovered.map((e) => e.path), [entry]);
	});
});

describe("discoverLoadedExtensions: npm packages (E-03)", () => {
	function seedNpmPackage(spec: string, manifest: unknown): string {
		const installPath = join(env.agentDir, "npm", "node_modules", spec);
		writeJson(join(installPath, "package.json"), { name: spec, pi: manifest });
		return installPath;
	}

	it("only settings `packages` are loaded — npm/package.json dependencies are not (pi ignores them)", () => {
		writeSettings({ packages: ["npm:ext-one"] });
		seedNpmPackage("ext-one", { extensions: ["./index.ts"] });
		writeFileSync(join(env.agentDir, "npm", "node_modules", "ext-one", "index.ts"), "");
		writeFileSync(join(seedNpmPackage("not-configured", { extensions: ["./index.ts"] }), "index.ts"), "");
		// The decoy also appears as a direct dependency of the npm manifest.
		writeJson(join(env.agentDir, "npm", "package.json"), { dependencies: { "not-configured": "1.0.0" } });
		const discovered = discoverLoadedExtensions(env.cwd, env.agentDir, false);
		const paths = discovered.map((e) => e.path);
		assert.ok(paths.some((p) => p.endsWith("ext-one/index.ts")), JSON.stringify(paths));
		assert.equal(paths.some((p) => p.includes("not-configured")), false, JSON.stringify(paths));
	});
	it("root index entry labels as the bare package name", () => {
		writeSettings({ packages: ["npm:ext-one"] });
		seedNpmPackage("ext-one", { extensions: ["./index.ts"] });
		writeFileSync(join(env.agentDir, "npm", "node_modules", "ext-one", "index.ts"), "");
		assert.deepEqual(labels(), ["ext-one"]);
	});
	it("nested entry labels as pkg:path relative to the package root", () => {
		writeSettings({ packages: ["npm:ext-one"] });
		seedNpmPackage("ext-one", { extensions: ["./src/index.ts"] });
		mkdirSync(join(env.agentDir, "npm", "node_modules", "ext-one", "src"), { recursive: true });
		writeFileSync(join(env.agentDir, "npm", "node_modules", "ext-one", "src", "index.ts"), "");
		assert.deepEqual(labels(), ["ext-one:src"]);
	});
	it("a directory entry expands to its files, labeled pkg:file", () => {
		writeSettings({ packages: ["npm:ext-one"] });
		seedNpmPackage("ext-one", { extensions: ["./extensions"] });
		mkdirSync(join(env.agentDir, "npm", "node_modules", "ext-one", "extensions"), { recursive: true });
		writeFileSync(join(env.agentDir, "npm", "node_modules", "ext-one", "extensions", "atlassian.ts"), "");
		assert.deepEqual(labels(), ["ext-one:atlassian.ts"]);
	});
	it("scoped packages label with their scope", () => {
		writeSettings({ packages: ["npm:@scope/ext-two"] });
		seedNpmPackage("@scope/ext-two", { extensions: ["./src/index.ts"] });
		mkdirSync(join(env.agentDir, "npm", "node_modules", "@scope", "ext-two", "src"), { recursive: true });
		writeFileSync(join(env.agentDir, "npm", "node_modules", "@scope", "ext-two", "src", "index.ts"), "");
		assert.deepEqual(labels(), ["@scope/ext-two:src"]);
	});
	it("a package that is not installed is skipped", () => {
		writeSettings({ packages: ["npm:missing-pkg"] });
		assert.deepEqual(discoverLoadedExtensions(env.cwd, env.agentDir, false), []);
	});
});

describe("discoverLoadedExtensions: package entry filters (E-10)", () => {
	function seedNpmPackage(spec: string, entries: string[]): void {
		const installPath = join(env.agentDir, "npm", "node_modules", spec);
		writeJson(join(installPath, "package.json"), { name: spec, pi: { extensions: entries } });
		for (const entry of entries) {
			const entryPath = join(installPath, entry);
			mkdirSync(join(entryPath, ".."), { recursive: true });
			writeFileSync(entryPath, "");
		}
	}

	it("a -<entry> pattern disables that extension but leaves the rest of the package", () => {
		seedNpmPackage("multi-ext", ["./a.ts", "./b.ts"]);
		writeSettings({ packages: [{ source: "npm:multi-ext", extensions: ["-a.ts"] }] });
		assert.deepEqual(labels(), ["multi-ext:b.ts"]);
	});
	it("an empty extensions array disables the whole package", () => {
		seedNpmPackage("multi-ext", ["./a.ts", "./b.ts"]);
		writeSettings({ packages: [{ source: "npm:multi-ext", extensions: [] }] });
		assert.deepEqual(labels(), []);
	});
	it("a plain pattern selects only the entries it names", () => {
		seedNpmPackage("multi-ext", ["./a.ts", "./b.ts"]);
		writeSettings({ packages: [{ source: "npm:multi-ext", extensions: ["a.ts"] }] });
		assert.deepEqual(labels(), ["multi-ext:a.ts"]);
	});
	it("an object entry without extensions loads the package's manifest entries", () => {
		seedNpmPackage("multi-ext", ["./a.ts", "./b.ts"]);
		writeSettings({ packages: [{ source: "npm:multi-ext" }] });
		assert.deepEqual(labels(), ["multi-ext:a.ts", "multi-ext:b.ts"]);
	});
	it("a project autoload:false entry deltas the user-scope install", () => {
		seedNpmPackage("multi-ext", ["./a.ts", "./b.ts"]);
		writeSettings({ packages: ["npm:multi-ext"] });
		writeJson(join(env.cwd, ".pi", "settings.json"), {
			packages: [{ source: "npm:multi-ext", autoload: false, extensions: ["-b.ts"] }],
		});
		assert.deepEqual(getLoadedExtensionLabels(env.cwd, env.agentDir, true), ["multi-ext:a.ts"]);
	});
	it("a project entry replaces the user entry for the same package identity", () => {
		seedNpmPackage("multi-ext", ["./a.ts", "./b.ts"]);
		const projectInstall = join(env.cwd, ".pi", "npm", "node_modules", "multi-ext");
		writeJson(join(projectInstall, "package.json"), { name: "multi-ext", pi: { extensions: ["./a.ts"] } });
		writeFileSync(join(projectInstall, "a.ts"), "");
		writeSettings({ packages: ["npm:multi-ext"] });
		writeJson(join(env.cwd, ".pi", "settings.json"), { packages: ["npm:multi-ext@2.0.0"] });
		// Identity ignores the version when deduping, but pi's label keeps the spec verbatim.
		assert.deepEqual(getLoadedExtensionLabels(env.cwd, env.agentDir, true), ["multi-ext@2.0.0:a.ts"]);
	});
});

describe("discoverLoadedExtensions: local path packages (E-04)", () => {
	it("a settings packages entry that is a path resolves relative to the agent dir", () => {
		const pkgRoot = join(env.agentDir, "local-pkg");
		writeJson(join(pkgRoot, "package.json"), { name: "local-pkg", pi: { extensions: ["./index.ts"] } });
		writeFileSync(join(pkgRoot, "index.ts"), "");
		writeSettings({ packages: ["local-pkg"] });
		const discovered = discoverLoadedExtensions(env.cwd, env.agentDir, false);
		assert.deepEqual(discovered.map((e) => e.path), [join(pkgRoot, "index.ts")]);
		assert.equal(discovered[0]!.source, "local-pkg");
		assert.equal(discovered[0]!.baseDir, pkgRoot);
	});
	it("a path package without a manifest or extensions dir is the dir itself", () => {
		const pkgRoot = join(env.agentDir, "bare-pkg");
		mkdirSync(pkgRoot, { recursive: true });
		writeSettings({ packages: ["bare-pkg"] });
		const discovered = discoverLoadedExtensions(env.cwd, env.agentDir, false);
		assert.deepEqual(discovered.map((e) => e.path), [pkgRoot]);
	});
});

describe("discoverLoadedExtensions: project extensions (E-05)", () => {
	function seedProjectExtension(): string {
		const path = join(env.cwd, ".pi", "extensions", "proj-ext.ts");
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "");
		return path;
	}

	it("project .pi/extensions load when the project is trusted", () => {
		const path = seedProjectExtension();
		const discovered = discoverLoadedExtensions(env.cwd, env.agentDir, true);
		assert.deepEqual(discovered.map((e) => e.path), [path]);
		assert.equal(discovered[0]!.scope, "project");
	});
	it("project .pi/extensions are skipped when untrusted", () => {
		seedProjectExtension();
		assert.deepEqual(discoverLoadedExtensions(env.cwd, env.agentDir, false), []);
	});
	it("project settings packages load only when trusted", () => {
		const pkgRoot = join(env.cwd, ".pi", "npm", "node_modules", "proj-pkg");
		writeJson(join(pkgRoot, "package.json"), { name: "proj-pkg", pi: { extensions: ["./index.ts"] } });
		writeFileSync(join(pkgRoot, "index.ts"), "");
		writeJson(join(env.cwd, ".pi", "settings.json"), { packages: ["npm:proj-pkg"] });
		const trusted = discoverLoadedExtensions(env.cwd, env.agentDir, true);
		assert.equal(trusted.some((e) => e.path.includes("proj-pkg")), true);
		assert.equal(discoverLoadedExtensions(env.cwd, env.agentDir, false).some((e) => e.path.includes("proj-pkg")), false);
	});
});

describe("discoverLoadedExtensions: CLI sources (E-06)", () => {
	it("--extension paths are always loaded and labeled by their path suffix", () => {
		const cliExt = join(env.cwd, "cli-ext.ts");
		writeFileSync(cliExt, "");
		restoreArgv();
		restoreArgv = setArgv(["--extension", cliExt]);
		assert.deepEqual(labels(), ["cli-ext.ts"]);
	});
	it("<inline:...> CLI sources are hidden built-ins and never listed", () => {
		restoreArgv();
		restoreArgv = setArgv(["--extension", "<inline:llama.cpp>"]);
		assert.deepEqual(labels(), []);
	});
	it("under --no-extensions only CLI sources are reported", () => {
		writeExtension("on-disk", "index.ts");
		const cliExt = join(env.cwd, "cli-ext.ts");
		writeFileSync(cliExt, "");
		restoreArgv();
		restoreArgv = setArgv(["--no-extensions", "--extension", cliExt]);
		assert.deepEqual(labels(), ["cli-ext.ts"]);
		restoreArgv();
		restoreArgv = setArgv(["--no-extensions"]);
		assert.deepEqual(labels(), []);
	});
});

describe("getExtensionLabels: pi's compact labels (E-07)", () => {
	it("shortest unique path suffix, index.* stripped", () => {
		writeExtension("a-ext", "src/index.ts");
		writeExtension("b-ext", "src/index.ts");
		writeExtension("c-ext", "index.ts");
		writeExtension("d-ext", "extensions/d-ext.js");
		assert.deepEqual(labels(), ["a-ext/src", "b-ext/src", "c-ext", "d-ext.js"]);
	});
	it("a label shared by two paths grows until unique", () => {
		writeExtension("one", "src/index.ts");
		writeExtension("two", "src/index.ts");
		// Both would be `*/src`; the unique suffixes disambiguate by dir name.
		assert.deepEqual(labels(), ["one/src", "two/src"]);
	});
});

describe("getExtensionLabels: canonical dedupe (E-08)", () => {
	it("a symlinked extension dir resolves to one entry", () => {
		writeExtension("real-ext", "index.ts");
		symlinkSync(join(env.agentDir, "extensions", "real-ext"), join(env.agentDir, "extensions", "link-ext"));
		const discovered = discoverLoadedExtensions(env.cwd, env.agentDir, false);
		assert.equal(discovered.length, 1, JSON.stringify(discovered));
	});
});

describe("cliExtensionArgs (E-09)", () => {
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
