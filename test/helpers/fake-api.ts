import type { EntryRenderer, ExtensionAPI, ExtensionContext, ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

export interface FakePiBag {
	thinkingLevel: string;
	setModelResult: boolean;
	commandsInfo: unknown[];
	toolsInfo: unknown[];
	execCalls: { command: string; args: string[]; options?: ExecOptions }[];
	execHandler: (command: string, args: string[], options?: ExecOptions) => ExecResult | Promise<ExecResult>;
}

export interface FakePiHarness {
	pi: ExtensionAPI;
	bag: FakePiBag;
	registeredFlags: { name: string; options: unknown }[];
	commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }>;
	handlers: Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>;
	setModelCalls: Model<any>[];
	setThinkingCalls: string[];
	execCalls: { command: string; args: string[]; options?: ExecOptions }[];
	appendedEntries: { customType: string; data: unknown }[];
	entryRenderers: Map<string, EntryRenderer>;
	sentMessages: unknown[];
	/** Run every registered handler for `event` in order, awaiting each. */
	emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<void>;
}

export function createFakePi(initial: Partial<FakePiBag> = {}): FakePiHarness {
	const bag: FakePiBag = {
		thinkingLevel: initial.thinkingLevel ?? "medium",
		setModelResult: initial.setModelResult ?? true,
		commandsInfo: initial.commandsInfo ?? [],
		toolsInfo: initial.toolsInfo ?? [],
		execCalls: initial.execCalls ?? [],
		execHandler: initial.execHandler ?? (() => ({ stdout: "", stderr: "", code: 0, killed: false })),
	};
	const registeredFlags: { name: string; options: unknown }[] = [];
	const commands = new Map<
		string,
		{ description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }
	>();
	const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	const setModelCalls: Model<any>[] = [];
	const setThinkingCalls: string[] = [];
	const appendedEntries: { customType: string; data: unknown }[] = [];
	const entryRenderers = new Map<string, EntryRenderer>();
	const sentMessages: unknown[] = [];

	const pi = {
		registerFlag(name: string, options: unknown): void {
			registeredFlags.push({ name, options });
		},
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(
			name: string,
			options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void },
		): void {
			commands.set(name, options);
		},
		registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void {
			entryRenderers.set(customType, renderer as EntryRenderer);
		},
		appendEntry<T = unknown>(customType: string, data?: T): void {
			appendedEntries.push({ customType, data });
		},
		sendMessage(message: unknown): void {
			sentMessages.push(message);
		},
		sendUserMessage(content: unknown): void {
			sentMessages.push(content);
		},
		getCommands(): unknown[] {
			return bag.commandsInfo;
		},
		getAllTools(): unknown[] {
			return bag.toolsInfo;
		},
		async setModel(model: Model<any>): Promise<boolean> {
			setModelCalls.push(model);
			return bag.setModelResult;
		},
		getThinkingLevel(): string {
			return bag.thinkingLevel;
		},
		setThinkingLevel(level: string): void {
			setThinkingCalls.push(level);
		},
		exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
			bag.execCalls.push({ command, args: [...args], options });
			return Promise.resolve(bag.execHandler(command, args, options));
		},
	};

	return {
		pi: pi as unknown as ExtensionAPI,
		bag,
		registeredFlags,
		commands,
		handlers,
		setModelCalls,
		setThinkingCalls,
		execCalls: bag.execCalls,
		appendedEntries,
		entryRenderers,
		sentMessages,
		async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
}
