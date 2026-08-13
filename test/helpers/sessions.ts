import { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Seed a real on-disk session through the collaborator's public API so fixtures land
 * exactly where SessionManager.list(cwd) reads them (inside the temp agent dir), without
 * replicating its cwd-encoding scheme.
 */
export function seedSession(cwd: string, firstMessage: string): string {
	const manager = SessionManager.create(cwd);
	manager.appendMessage({
		role: "user",
		content: firstMessage,
		timestamp: Date.now(),
	} as never);
	// SessionManager only flushes to disk once an assistant message exists (user-only
	// sessions are deliberately never persisted).
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		timestamp: Date.now(),
	} as never);
	const file = manager.getSessionFile();
	if (!file) throw new Error("seedSession: session was not persisted");
	return file;
}
