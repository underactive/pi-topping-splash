import { execFileSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	env.GIT_CONFIG_SYSTEM = "/dev/null";
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_AUTHOR_NAME = "Test";
	env.GIT_AUTHOR_EMAIL = "test@example.com";
	env.GIT_COMMITTER_NAME = "Test";
	env.GIT_COMMITTER_EMAIL = "test@example.com";
	return env;
}

/** Run git without inheriting repository, config, identity, or hook state. */
export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		env: gitEnv(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** Initialize a clean repository containing the supplied baseline files. */
export function initRepo(cwd: string, files: Record<string, string>): void {
	mkdirSync(cwd, { recursive: true });
	git(cwd, "-c", "init.defaultBranch=main", "init");
	for (const [path, contents] of Object.entries(files)) {
		const file = join(cwd, path);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, contents);
	}
	if (Object.keys(files).length > 0) {
		git(cwd, "add", "--all");
		git(cwd, "commit", "-m", "baseline");
	}
}

/** Create staged, unstaged, deleted, and untracked changes in an existing repo. */
export function mixedChanges(cwd: string): void {
	const tracked = join(cwd, "tracked.txt");
	const deleted = join(cwd, "deleted.txt");
	writeFileSync(tracked, "base\n");
	writeFileSync(deleted, "delete me\n");
	git(cwd, "add", "tracked.txt", "deleted.txt");
	git(cwd, "commit", "-m", "mixed changes baseline");

	writeFileSync(join(cwd, "staged.txt"), "staged\n");
	git(cwd, "add", "staged.txt");
	writeFileSync(tracked, "base\nunstaged\n");
	unlinkSync(deleted);
	writeFileSync(join(cwd, "untracked.txt"), "untracked\n");
}
