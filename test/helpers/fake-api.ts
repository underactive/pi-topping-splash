import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

export interface FakePiBag {
	thinkingLevel: string;
	setModelResult: boolean;
	commandsInfo: unknown[];
	toolsInfo: unknown[];
}

export interface FakePiHarness {
	pi: ExtensionAPI;
	bag: FakePiBag;
	registeredFlags: { name: string; options: unknown }[];
	commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }>;
	handlers: Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>;
	setModelCalls: Model<any>[];
	setThinkingCalls: string[];
	/** Run every registered handler for `event` in order, awaiting each. */
	emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<void>;
}

export function createFakePi(initial: Partial<FakePiBag> = {}): FakePiHarness {
	const bag: FakePiBag = {
		thinkingLevel: initial.thinkingLevel ?? "medium",
		setModelResult: initial.setModelResult ?? true,
		commandsInfo: initial.commandsInfo ?? [],
		toolsInfo: initial.toolsInfo ?? [],
	};
	const registeredFlags: { name: string; options: unknown }[] = [];
	const commands = new Map<
		string,
		{ description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }
	>();
	const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	const setModelCalls: Model<any>[] = [];
	const setThinkingCalls: string[] = [];

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
	};

	return {
		pi: pi as unknown as ExtensionAPI,
		bag,
		registeredFlags,
		commands,
		handlers,
		setModelCalls,
		setThinkingCalls,
		async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
}
