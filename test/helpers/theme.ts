import { initTheme, Theme } from "@earendil-works/pi-coding-agent";

type FgColors = ConstructorParameters<typeof Theme>[0];
type BgColors = ConstructorParameters<typeof Theme>[1];

// Theme's constructor eagerly precomputes ANSI for every ThemeColor key, so the record
// must be complete. Colors the extension reads get distinct values; the rest a filler.
const FG_COLOR_NAMES = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
	"muted", "dim", "text", "thinkingText", "userMessageText", "customMessageText",
	"customMessageLabel", "toolTitle", "toolOutput", "mdHeading", "mdLink", "mdLinkUrl",
	"mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr",
	"mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment",
	"syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber",
	"syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff", "thinkingMinimal",
	"thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax",
	"bashMode",
] as const;

const FG_COLORS: Record<string, string> = Object.fromEntries(
	FG_COLOR_NAMES.map((name) => [name, "#777777"]),
);
Object.assign(FG_COLORS, {
	text: "#e8e8e8",
	dim: "#808080",
	accent: "#d070d0",
	border: "#5050a0",
	warning: "#e0c060",
	muted: "#909090",
	success: "#60c080",
	error: "#e06060",
});

const BG_COLORS = {
	selectedBg: "#303050",
	userMessageBg: "#202030",
	customMessageBg: "#202030",
	toolPendingBg: "#202030",
	toolSuccessBg: "#203020",
	toolErrorBg: "#302020",
};

export interface MakeThemeOptions {
	mode?: "truecolor" | "256color";
	/** Override the body-text color (drives panelBg's luminance decision). */
	text?: string;
	dim?: string;
	name?: string;
}

export function makeTheme(options: MakeThemeOptions = {}): Theme {
	const fg = { ...FG_COLORS };
	if (options.text !== undefined) fg.text = options.text;
	if (options.dim !== undefined) fg.dim = options.dim;
	return new Theme(
		fg as unknown as FgColors,
		BG_COLORS as unknown as BgColors,
		options.mode ?? "truecolor",
		{ name: options.name ?? "test-theme" },
	);
}

let bootstrapped = false;

/** SelectList (model picker, gate lists) reads a global theme that throws until initTheme runs. */
export function bootstrapGlobalTheme(): void {
	if (bootstrapped) return;
	initTheme("dark");
	bootstrapped = true;
}
