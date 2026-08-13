import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";

export interface FakeCtxBag {
	theme: Theme;
	model: Model<any> | undefined;
	models: Model<any>[];
	themes: { name: string; path: string | undefined }[];
	themeByName: (name: string) => Theme | undefined;
	systemPrompt: string | (() => string);
	mode: string;
	hasUI: boolean;
	projectTrusted: boolean;
}

export interface FakeCtxHarness {
	ctx: ExtensionContext;
	bag: FakeCtxBag;
	notifications: { message: string; type: string | undefined }[];
	setThemeCalls: (string | Theme)[];
	setHeaderCalls: unknown[];
	setFooterCalls: unknown[];
	/** Components created through ui.custom, in creation order. */
	customComponents: Component[];
	shutdownCount: number;
}

export interface FakeCtxOptions {
	cwd: string;
	theme: Theme;
	tui: TUI;
	model?: Model<any>;
	models?: Model<any>[];
	themes?: { name: string; path: string | undefined }[];
	themeByName?: (name: string) => Theme | undefined;
	systemPrompt?: string | (() => string);
	mode?: string;
	hasUI?: boolean;
	projectTrusted?: boolean;
}

/** Implements only the ExtensionContext surface the extension touches. */
export function createFakeCtx(options: FakeCtxOptions): FakeCtxHarness {
	const bag: FakeCtxBag = {
		theme: options.theme,
		model: options.model,
		models: options.models ?? (options.model ? [options.model] : []),
		themes: options.themes ?? [],
		themeByName: options.themeByName ?? (() => undefined),
		systemPrompt: options.systemPrompt ?? "test system prompt",
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		projectTrusted: options.projectTrusted ?? false,
	};
	const harness = {
		bag,
		notifications: [],
		setThemeCalls: [],
		setHeaderCalls: [],
		setFooterCalls: [],
		customComponents: [],
		shutdownCount: 0,
	} as unknown as FakeCtxHarness;

	const ui = {
		get theme() {
			return bag.theme;
		},
		notify(message: string, type?: "info" | "warning" | "error"): void {
			harness.notifications.push({ message, type });
		},
		setHeader(factory: unknown): void {
			harness.setHeaderCalls.push(factory);
		},
		setFooter(factory: unknown): void {
			harness.setFooterCalls.push(factory);
		},
		custom<T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: unknown,
				done: (result: T) => void,
			) => Component,
		): Promise<T> {
			return new Promise<T>((resolve) => {
				const component = factory(options.tui, bag.theme, {} as never, resolve);
				harness.customComponents.push(component);
			});
		},
		getAllThemes(): { name: string; path: string | undefined }[] {
			return bag.themes;
		},
		getTheme(name: string): Theme | undefined {
			return bag.themeByName(name);
		},
		setTheme(theme: string | Theme): { success: boolean; error?: string } {
			harness.setThemeCalls.push(theme);
			return { success: true };
		},
	};

	const ctx = {
		ui,
		get mode() {
			return bag.mode;
		},
		get hasUI() {
			return bag.hasUI;
		},
		cwd: options.cwd,
		modelRegistry: {
			getAvailable: () => bag.models,
			find: (provider: string, id: string) =>
				bag.models.find((m) => m.provider === provider && m.id === id),
		},
		get model() {
			return bag.model;
		},
		isProjectTrusted(): boolean {
			return bag.projectTrusted;
		},
		getSystemPrompt(): string {
			return typeof bag.systemPrompt === "function" ? bag.systemPrompt() : bag.systemPrompt;
		},
		shutdown(): void {
			harness.shutdownCount++;
		},
	};

	harness.ctx = ctx as unknown as ExtensionContext;
	return harness;
}

/** Minimal Model fixture; only the fields the picker/registry path reads. */
export function makeModel(provider: string, id: string): Model<any> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	} as unknown as Model<any>;
}
