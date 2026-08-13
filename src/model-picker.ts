import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SelectItem } from "@earendil-works/pi-tui";
import { sanitizeTuiText } from "./text.ts";
import { GATE_LIST_HEIGHT, fuzzyRanked, isPrintableInput } from "./gate-ui.ts";

/**
 * pi's thinking-level vocabulary, kept structurally identical to agent-core's `ThinkingLevel`
 * so picker selections feed `pi.setThinkingLevel()` and `--thinking` without a cast.
 */
export const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Offered when the registry does not advertise a model's supported range. */
export const COMMON_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];

export const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVEL_SET.has(value);
}

export interface ModelRef {
	provider: string;
	id: string;
}

export function modelRefLabel(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

/** Every registry model as a provider/id pair, sorted by the label the picker displays. */
export function availableModelRefs(ctx: ExtensionContext): ModelRef[] {
	return ctx.modelRegistry
		.getAvailable()
		.map((model) => ({ provider: model.provider, id: model.id }))
		.sort((a, b) => modelRefLabel(a).localeCompare(modelRefLabel(b)));
}

/** Normalize a model's offered levels into `THINKING_LEVELS` order, whatever order they arrive in. */
export function thinkingOptionsForModel(registryLevels?: ThinkingLevel[]): ThinkingLevel[] {
	const choices = new Set<ThinkingLevel>(registryLevels ?? COMMON_THINKING_LEVELS);
	return THINKING_LEVELS.filter((level) => choices.has(level));
}

/** Preselect the session's current level when the model offers it, else a sensible middle. */
export function defaultThinkingForModel(options: ThinkingLevel[], currentLevel: ThinkingLevel): ThinkingLevel {
	if (options.includes(currentLevel)) return currentLevel;
	if (options.includes("medium")) return "medium";
	return options[0] ?? "medium";
}

/**
 * Two-pane selector: models on the left, the selected model's thinking levels on the right,
 * above a Select/Cancel action bar. Typed text narrows the model filter while the model pane is
 * active, so tab and the arrow keys (not letters) move focus between the panes and the buttons,
 * and the buttons only handle arrows/Enter. Ported from
 * pi-moa-plan's picker of the same name so both extensions select models identically.
 *
 * Render-pure: mutations never request a render, because every entry point runs inside
 * `StartupGate.handleInput`, which re-renders once after dispatching.
 */
export class TwoPaneModelThinking {
	private modelList!: SelectList;
	private levelList!: SelectList;
	private filter = "";
	private activePane: "model" | "level" | "buttons" = "model";
	private activeButton = 0;
	private readonly modelItems: SelectItem[];

	private readonly theme: Theme;
	private readonly ctx: ExtensionContext;
	private readonly currentThinking: ThinkingLevel;

	constructor(
		theme: Theme,
		ctx: ExtensionContext,
		availableRefs: ModelRef[],
		currentThinking: ThinkingLevel,
		defaultRef?: ModelRef,
	) {
		this.theme = theme;
		this.ctx = ctx;
		this.currentThinking = currentThinking;
		this.modelItems = availableRefs.map((ref) => {
			const value = modelRefLabel(ref);
			return { value, label: sanitizeTuiText(value) || "(invalid model)" };
		});
		this.rebuildModelList();
		if (defaultRef) {
			const index = this.modelItems.findIndex((item) => item.value === modelRefLabel(defaultRef));
			if (index >= 0) this.modelList.setSelectedIndex(index);
		}
		this.modelList.onSelectionChange = () => this.rebuildThinkingList();
		this.rebuildThinkingList();
	}

	private rebuildModelList(): void {
		const items = this.filter.trim() ? fuzzyRanked(this.modelItems, this.filter, (item) => item.label) : this.modelItems;
		this.modelList = new SelectList(items, Math.min(Math.max(items.length, 1), GATE_LIST_HEIGHT), getSelectListTheme());
	}

	private rebuildThinkingList(): void {
		const key = this.modelList.getSelectedItem()?.value;
		const levels = key ? thinkingOptionsForModel(this.registryLevelsForKey(key)) : [];
		const items = levels.map((level) => ({ value: level, label: level }));
		this.levelList = new SelectList(items, Math.min(Math.max(items.length, 1), GATE_LIST_HEIGHT), getSelectListTheme());
		const preferred = levels.indexOf(defaultThinkingForModel(levels, this.currentThinking));
		if (preferred >= 0) this.levelList.setSelectedIndex(preferred);
	}

	/** The levels the registry advertises for `provider/id`, or undefined when it knows none. */
	private registryLevelsForKey(key: string): ThinkingLevel[] | undefined {
		const [provider, ...rest] = key.split("/");
		const id = rest.join("/");
		if (!provider || !id) return undefined;
		const model = this.ctx.modelRegistry.find(provider, id);
		if (!model) return undefined;
		const levels = getSupportedThinkingLevels(model).filter(isThinkingLevel);
		return levels.length > 0 ? levels : undefined;
	}

	handleInput(data: string): "confirm" | "back" | undefined {
		if (matchesKey(data, "escape")) return "back";
		if (matchesKey(data, "tab")) {
			this.activePane = this.activePane === "model" ? "level" : this.activePane === "level" ? "buttons" : "model";
			return undefined;
		}
		if (this.activePane === "buttons") {
			if (matchesKey(data, "left") || matchesKey(data, "right")) {
				this.activeButton = this.activeButton === 0 ? 1 : 0;
				return undefined;
			}
			if (matchesKey(data, "return")) {
				return this.activeButton === 0 && this.hasSelection() ? "confirm" : "back";
			}
			return undefined;
		}
		if (matchesKey(data, "return")) return this.hasSelection() ? "confirm" : undefined;
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			this.activePane = this.activePane === "model" ? "level" : "model";
			return undefined;
		}
		// Editing the filter re-targets the model pane: the level list is about to be rebuilt.
		if (matchesKey(data, "backspace")) {
			this.activePane = "model";
			if (this.filter.length > 0) {
				this.filter = this.filter.slice(0, -1);
				this.rebuildModelList();
				this.rebuildThinkingList();
			}
			return undefined;
		}
		if (isPrintableInput(data)) {
			this.activePane = "model";
			this.filter += data;
			this.rebuildModelList();
			this.rebuildThinkingList();
			return undefined;
		}
		(this.activePane === "model" ? this.modelList : this.levelList).handleInput(data);
		return undefined;
	}

	private hasSelection(): boolean {
		return this.modelList.getSelectedItem() !== null && this.levelList.getSelectedItem() !== null;
	}

	/** Only valid after `handleInput` returns "confirm". */
	getSelected(): { ref: ModelRef; thinking: ThinkingLevel } {
		const model = this.modelList.getSelectedItem();
		const level = this.levelList.getSelectedItem();
		if (!model || !level || !isThinkingLevel(level.value)) {
			throw new Error("Cannot confirm an empty model or thinking-level selection");
		}
		const separator = model.value.indexOf("/");
		return {
			ref: { provider: model.value.slice(0, separator), id: model.value.slice(separator + 1) },
			thinking: level.value,
		};
	}

	/** Emits rows exactly `bodyWidth` columns wide: `left` + a 1-column divider + `right`. */
	render(bodyWidth: number): string[] {
		const leftWidth = Math.max(1, Math.floor((bodyWidth - 1) / 2));
		const rightWidth = Math.max(0, bodyWidth - leftWidth - 1);
		const column = (text: string, width: number) => truncateToWidth(text, width, "", true);
		const divider = this.theme.fg("border", "│");
		const paneTitle = (label: string, pane: string) =>
			this.activePane === pane ? this.theme.bold(this.theme.fg("accent", label)) : this.theme.bold(label);
		const lines = [
			...(this.filter ? [column(this.theme.fg("muted", `filter: ${this.filter}`), bodyWidth)] : []),
			column(paneTitle("Models", "model"), leftWidth) + divider + column(` ${paneTitle("Thinking", "level")}`, rightWidth),
		];
		const modelLines = this.modelList.render(leftWidth);
		const levelLines = this.levelList.render(rightWidth);
		for (let index = 0; index < Math.max(modelLines.length, levelLines.length); index++) {
			lines.push(column(modelLines[index] ?? "", leftWidth) + divider + column(` ${levelLines[index] ?? ""}`, rightWidth));
		}
		return lines;
	}

	/** Rule, right-aligned action buttons, rule, then the keyboard hints. */
	renderFooter(bodyWidth: number, hints: string): string[] {
		const button = (label: string, index: number) => {
			const isActive = this.activeButton === index;
			const text = isActive ? `[ ${label} ]` : `‹ ${label} ›`;
			return isActive && this.activePane === "buttons"
				? this.theme.bold(this.theme.fg("accent", text))
				: this.theme.fg("muted", text);
		};
		const actions = `${button("Select", 0)}    ${button("Cancel", 1)}`;
		const rule = this.theme.fg("border", "─".repeat(bodyWidth));
		// Clamp the variable-width rows: on a very narrow popup the buttons and hints would
		// otherwise outrun bodyWidth and trip the renderer's line-width guard.
		const actionsRow = `${" ".repeat(Math.max(0, bodyWidth - visibleWidth(actions) - 2))}${actions}  `;
		return [
			rule,
			truncateToWidth(actionsRow, bodyWidth, ""),
			rule,
			truncateToWidth(this.theme.fg("dim", hints), bodyWidth, ""),
		];
	}

	invalidate(): void {
		this.modelList.invalidate();
		this.levelList.invalidate();
	}
}
