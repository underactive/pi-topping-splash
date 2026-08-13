import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeyId, OverlayHandle, SizeValue, TUI } from "@earendil-works/pi-tui";
import { headerRenderState, state } from "./state.ts";
import { ELLIPSIS, sanitizeTuiText } from "./text.ts";
import { relaunchPi } from "./relaunch.ts";
import { showSplashSettings } from "./settings.ts";
import { TwoPaneModelThinking, availableModelRefs, modelRefLabel } from "./model-picker.ts";
import type { ModelRef, ThinkingLevel } from "./model-picker.ts";
import { GATE_LIST_HEIGHT, GATE_PANEL_MAX_WIDTH, RESUME_PANEL_WIDTH, SHORT_TERMINAL_ROWS, fuzzyRanked, isPrintableInput, listWindow, renderPopupBox } from "./gate-ui.ts";

/** A theme entry as returned by `ctx.ui.getAllThemes()`. */
export type ThemeListItem = ReturnType<ExtensionContext["ui"]["getAllThemes"]>[number];
/** Session metadata as returned by `SessionManager.list()`. */
export type SessionListItem = Awaited<ReturnType<typeof SessionManager.list>>[number];

/** How the gate resolved when it did not relaunch the process. */
export type GateResolution = "proceed" | "quit";

export type MenuAction = "new" | "resume" | "model" | "theme" | "skills-extensions" | "settings" | "quit";
export type GateView = "menu" | "resume" | "model" | "theme" | "skills-extensions";

/**
 * The blocking startup gate component. The main menu renders inline under the splash; the
 * Resume/Theme/Model drill-in views render in a bordered popup overlay centered (vertically
 * and horizontally) in the terminal. The overlay is non-capturing, so this component keeps
 * keyboard focus and handles input for every view.
 */
export class StartupGate {
	private view: GateView = "menu";
	private menuIndex = 0;
	/** Icons are Nerd Font glyphs (all width 1) so the label column stays aligned across rows. */
	private readonly menu: { label: string; action: MenuAction; icon: string; hotkey: KeyId }[] = [
		{ label: "New session", action: "new", icon: "", hotkey: "n" }, // nf-fa-file
		{ label: "Resume session", action: "resume", icon: "", hotkey: "r" }, // nf-fa-history
		{ label: "Model", action: "model", icon: "\u{f1719}", hotkey: "m" }, // nf-md-robot_happy
		{ label: "Skills and Extensions", action: "skills-extensions", icon: "\u{f0431}", hotkey: "x" }, // nf-md-puzzle
		{ label: "Theme", action: "theme", icon: "", hotkey: "t" }, // nf-fa-paint_brush
		{ label: "Settings", action: "settings", icon: "", hotkey: "s" }, // nf-fa-cog
		{ label: "Quit", action: "quit", icon: "\u{f0a48}", hotkey: "q" }, // nf-md-exit_run
	];

	private sessions: SessionListItem[] | null = null;
	private sessionsLoading = false;
	private sessionIndex = 0;
	private precomputedDisplay: { preview: string; count: string; date: string }[] = [];

	/** Two-pane model + thinking picker, rebuilt each time the Model view opens. */
	private modelPicker: TwoPaneModelThinking | null = null;

	private themes: ThemeListItem[] = [];
	private themeIndex = 0;
	/** Theme name active when the popup opened: the ● marker and the restore point on escape. */
	private savedThemeName: string | undefined;
	/** True once navigation has live-previewed a theme, so escape knows to restore. */
	private themePreviewActive = false;

	/** Read-only inventory view: cursor and filter per pane, each preserved across pane switches. */
	private inventoryPane: "skills" | "extensions" = "skills";
	private readonly inventory = {
		skills: { index: 0, filter: "" },
		extensions: { index: 0, filter: "" },
	};

	/** Set when the user changes model in the gate, so relaunches preserve the choice. */
	private selectedModel: { id: string; provider: string } | undefined;
	/** Set alongside `selectedModel`; without it a relaunch would keep the model but drop the level. */
	private selectedThinking: ThinkingLevel | undefined;

	/** Centered popup overlay hosting the drill-in views; created lazily on first drill-in. */
	private popupHandle: OverlayHandle | null = null;
	/** Width the live overlay was created at, so a view needing another width forces a rebuild. */
	private popupWidth: SizeValue | null = null;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly ctx: ExtensionContext;
	private readonly pi: ExtensionAPI;
	private readonly done: (result: GateResolution) => void;

	constructor(
		tui: TUI,
		theme: Theme,
		ctx: ExtensionContext,
		pi: ExtensionAPI,
		done: (result: GateResolution) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.ctx = ctx;
		this.pi = pi;
		this.done = done;
	}

	handleInput(data: string): void {
		switch (this.view) {
			case "menu": this.handleMenu(data); break;
			case "resume": this.handleResume(data); break;
			case "model": this.handleModel(data); break;
			case "theme": this.handleTheme(data); break;
			case "skills-extensions": this.handleSkillsExtensions(data); break;
		}
		this.tui.requestRender();
	}

	/** Ensure the popup overlay exists, is visible, and is sized for the active view. */
	private ensurePopupVisible(): void {
		const width = this.view === "resume" ? RESUME_PANEL_WIDTH : GATE_PANEL_MAX_WIDTH;
		// Overlay options are fixed at creation — OverlayHandle can only hide, show and focus — so
		// a view that wants a different width needs a fresh overlay rather than a resize.
		if (this.popupHandle && this.popupWidth !== width) {
			this.popupHandle.hide();
			this.popupHandle = null;
		}
		if (this.popupHandle) {
			this.popupHandle.setHidden(false);
			return;
		}
		// The TUI centers the overlay on both axes (anchor defaults to "center") and clamps
		// the width to the terminal minus the margins; the gate keeps focus (nonCapturing).
		this.popupWidth = width;
		this.popupHandle = this.tui.showOverlay(
			{ render: (w: number) => this.renderPopup(w), invalidate: () => this.modelPicker?.invalidate() },
			{
				width,
				maxHeight: "100%",
				margin: { top: 1, bottom: 1, left: 2, right: 2 },
				nonCapturing: true,
			},
		);
	}

	/** Switch views, toggling the centered popup overlay that hosts the drill-in views. */
	private setView(view: GateView): void {
		this.view = view;
		if (view === "menu") this.popupHandle?.setHidden(true);
		else this.ensurePopupVisible();
	}

	/** Resolve the gate, removing the popup overlay first. */
	private finish(result: GateResolution): void {
		this.popupHandle?.hide();
		this.popupHandle = null;
		this.done(result);
	}

	private handleMenu(data: string): void {
		const menu = this.menu;
		if (matchesKey(data, "escape")) { this.finish("proceed"); return; }
		if (matchesKey(data, "up")) { this.menuIndex = Math.max(0, this.menuIndex - 1); return; }
		if (matchesKey(data, "down")) { this.menuIndex = Math.min(menu.length - 1, this.menuIndex + 1); return; }
		if (matchesKey(data, "return")) { this.activate(menu[this.menuIndex]!.action); return; }
		// Hotkeys: move the selection to the item and activate it immediately.
		const hotkeyIndex = menu.findIndex((entry) => matchesKey(data, entry.hotkey));
		if (hotkeyIndex !== -1) {
			this.menuIndex = hotkeyIndex;
			this.activate(menu[hotkeyIndex]!.action);
		}
	}

	private activate(action: MenuAction): void {
		switch (action) {
			case "new": this.finish("proceed"); break;
			case "quit": this.finish("quit"); break;
			case "resume": this.setView("resume"); this.loadSessions(); break;
			case "model": this.openModel(); break;
			case "theme": this.openTheme(); break;
			case "skills-extensions": this.setView("skills-extensions"); break;
			case "settings": this.openSettings(); break;
		}
	}

	/**
	 * Open the shared settings menu. `ctx.ui.custom` pushes a capturing overlay above the gate's
	 * own (nonCapturing, possibly hidden) popup, so the gate keeps rendering beneath while the
	 * settings menu takes input; closing it restores focus to the gate without resolving it.
	 */
	private openSettings(): void {
		void (async () => {
			await showSplashSettings(this.ctx);
			this.tui.requestRender();
		})();
	}

	private loadSessions(): void {
		this.sessionsLoading = true;
		this.sessions = null;
		this.sessionIndex = 0;
		this.precomputedDisplay = [];
		void (async () => {
			try {
				this.sessions = await SessionManager.list(this.ctx.cwd);
				this.precomputedDisplay = this.sessions.map((s) => ({
					preview: sessionPreview(s),
					count: `${s.messageCount} msg${s.messageCount === 1 ? "" : "s"}`,
					date: formatSessionDate(s.modified),
				}));
			} catch (e) {
				this.sessions = [];
				this.precomputedDisplay = [];
				this.ctx.ui.notify(sanitizeTuiText(e instanceof Error ? e.message : "Failed to load sessions"), "error");
			}
			this.sessionsLoading = false;
			this.tui.requestRender();
		})();
	}

	private handleResume(data: string): void {
		if (matchesKey(data, "escape")) { this.setView("menu"); return; }
		const sessions = this.sessions;
		if (!sessions || sessions.length === 0) return;
		if (matchesKey(data, "up")) { this.sessionIndex = Math.max(0, this.sessionIndex - 1); return; }
		if (matchesKey(data, "down")) { this.sessionIndex = Math.min(sessions.length - 1, this.sessionIndex + 1); return; }
		if (matchesKey(data, "return")) {
			const target = sessions[this.sessionIndex];
			if (target) relaunchPi(this.tui, this.ctx, { session: target.path, model: this.selectedModel, thinking: this.selectedThinking });
		}
	}

	private openModel(): void {
		let refs: ModelRef[];
		try {
			refs = availableModelRefs(this.ctx);
		} catch {
			refs = [];
		}
		const current = this.ctx.model ? { provider: this.ctx.model.provider, id: this.ctx.model.id } : undefined;
		this.modelPicker = new TwoPaneModelThinking(this.theme, this.ctx, refs, this.pi.getThinkingLevel(), current);
		this.setView("model");
	}

	private handleModel(data: string): void {
		const picker = this.modelPicker;
		if (!picker) return;
		const action = picker.handleInput(data);
		if (action === "back") this.setView("menu");
		else if (action === "confirm") this.applySelection(picker.getSelected());
	}

	/** Apply the picked model then its thinking level, staying in the picker if the model is refused. */
	private applySelection(selection: { ref: ModelRef; thinking: ThinkingLevel }): void {
		void (async () => {
			try {
				const model = this.ctx.modelRegistry.find(selection.ref.provider, selection.ref.id);
				// setModel resolves false when the provider has no API key configured.
				if (!model || !(await this.pi.setModel(model))) {
					this.ctx.ui.notify(`Could not switch to ${sanitizeTuiText(modelRefLabel(selection.ref)) || "(invalid model)"}`, "error");
					this.tui.requestRender();
					return;
				}
				this.pi.setThinkingLevel(selection.thinking);
				this.selectedModel = { id: selection.ref.id, provider: selection.ref.provider };
				this.selectedThinking = selection.thinking;
				// Refresh the persistent splash header so the new model line shows immediately.
				headerRenderState.invalidate?.();
				headerRenderState.requestRender?.();
				this.setView("menu");
				this.tui.requestRender();
			} catch {
				this.ctx.ui.notify("Model change failed", "error");
			}
		})();
	}

	private openTheme(): void {
		try {
			this.themes = this.ctx.ui.getAllThemes();
		} catch {
			this.themes = [];
		}
		// `ctx.ui.theme` is a live proxy to the global theme, so `.name` is the effective
		// current theme even when the user never persisted one in settings.
		this.savedThemeName = this.ctx.ui.theme.name;
		this.themePreviewActive = false;
		const currentIdx = this.savedThemeName
			? this.themes.findIndex((entry) => entry.name === this.savedThemeName)
			: -1;
		this.themeIndex = currentIdx >= 0 ? currentIdx : 0;
		this.setView("theme");
	}

	/**
	 * Live-preview a theme while navigating: `setTheme` with a Theme *instance* switches the
	 * global theme in memory without persisting to settings (the string form persists).
	 * Skipped when the popup opened on an unnamed theme, since escape could not restore it.
	 */
	private previewTheme(name: string): void {
		if (!this.savedThemeName) return;
		try {
			const loaded = this.ctx.ui.getTheme(name);
			if (loaded) {
				this.ctx.ui.setTheme(loaded);
				this.themePreviewActive = true;
				headerRenderState.invalidate?.();
			}
		} catch { /* keep the current theme */ }
	}

	private handleTheme(data: string): void {
		if (matchesKey(data, "escape")) {
			// Abandon any preview: restore the theme that was active when the popup opened.
			// Settings still hold that name, so the string form won't rewrite them.
			if (this.themePreviewActive && this.savedThemeName) {
				this.ctx.ui.setTheme(this.savedThemeName);
				headerRenderState.invalidate?.();
			}
			this.themePreviewActive = false;
			this.setView("menu");
			return;
		}
		if (this.themes.length === 0) return;
		const moveTo = (index: number) => {
			this.themeIndex = index;
			const entry = this.themes[index];
			if (entry) this.previewTheme(entry.name);
		};
		if (matchesKey(data, "up")) { moveTo(Math.max(0, this.themeIndex - 1)); return; }
		if (matchesKey(data, "down")) { moveTo(Math.min(this.themes.length - 1, this.themeIndex + 1)); return; }
		if (matchesKey(data, "return")) {
			const entry = this.themes[this.themeIndex];
			if (entry) {
				// String form: switches the theme and persists the choice to settings.
				this.ctx.ui.setTheme(entry.name);
				this.themePreviewActive = false;
				headerRenderState.invalidate?.();
				this.setView("menu");
			}
		}
	}

	/** Loaded names for one pane, narrowed by that pane's own filter. */
	private filteredItems(pane: "skills" | "extensions"): string[] {
		const items = pane === "skills" ? state.loadedSkills : state.loadedExtensions;
		return fuzzyRanked(items, this.inventory[pane].filter, (item) => item);
	}

	private handleSkillsExtensions(data: string): void {
		const pane = this.inventory[this.inventoryPane];
		if (matchesKey(data, "escape")) {
			// First escape clears an active filter; a second (or filterless) escape goes back.
			if (pane.filter) { pane.filter = ""; pane.index = 0; return; }
			this.setView("menu");
			return;
		}
		if (matchesKey(data, "left")) { this.inventoryPane = "skills"; return; }
		if (matchesKey(data, "right")) { this.inventoryPane = "extensions"; return; }
		if (matchesKey(data, "tab")) { this.inventoryPane = this.inventoryPane === "skills" ? "extensions" : "skills"; return; }
		if (matchesKey(data, "backspace")) {
			if (pane.filter) { pane.filter = pane.filter.slice(0, -1); pane.index = 0; }
			return;
		}
		if (matchesKey(data, "up")) { pane.index = Math.max(0, pane.index - 1); return; }
		if (matchesKey(data, "down")) {
			pane.index = Math.min(Math.max(0, this.filteredItems(this.inventoryPane).length - 1), pane.index + 1);
			return;
		}
		if (isPrintableInput(data)) { pane.filter += data; pane.index = 0; }
	}

	render(width: number): string[] {
		// Drill-in views live in the centered popup overlay; the base layer always shows the menu.
		return this.renderMenu(width);
	}

	/** Render the active drill-in view as a bordered popup (invoked by the overlay component). */
	private renderPopup(width: number): string[] {
		switch (this.view) {
			case "resume": return renderPopupBox(this.theme, width, "Resume Session", this.buildResumeBody(width));
			case "model": return renderPopupBox(this.theme, width, "Select Model", this.buildModelBody(width));
			case "theme": return renderPopupBox(this.theme, width, "Select Theme", this.buildThemeBody());
			case "skills-extensions": return renderPopupBox(this.theme, width, "Skills and Extensions", this.buildSkillsExtensionsBody(width));
			default: return [];
		}
	}

	private hint(text: string): string {
		return this.theme.fg("dim", text);
	}

	private isCompact(): boolean {
		const rows = this.tui.terminal.rows;
		return rows > 0 && rows <= SHORT_TERMINAL_ROWS;
	}

	/** Columns between the widest `❯ icon label` cell and the right-aligned hotkey. */
	private static readonly MENU_HOTKEY_GAP = 8;

	private renderMenu(width: number): string[] {
		const menu = this.menu;
		// Terminals 30 rows or taller get a blank row between items for a more relaxed layout.
		const spacious = this.tui.terminal.rows >= 30;
		// Every row is laid out to the same block width (icon + label column, hotkey right-
		// aligned), so centering each row keeps the block's internal columns aligned.
		// Two spaces between icon and label: wide Nerd Font artwork (e.g. the Material Design
		// glyphs in non-Mono font variants) advances one cell but paints into the next, so a
		// single space would be swallowed and the label would sit flush against the icon.
		const widestLeft = Math.max(...menu.map((entry) => visibleWidth(`❯ ${entry.icon}  ${entry.label}`)));
		const blockWidth = widestLeft + StartupGate.MENU_HOTKEY_GAP + 1;
		const lines: string[] = [];
		menu.forEach((entry, i) => {
			if (spacious && i > 0) lines.push("");
			const selected = i === this.menuIndex;
			const chevron = selected ? this.theme.fg("accent", "❯") : " ";
			const label = selected ? this.theme.fg("accent", entry.label) : this.theme.fg("text", entry.label);
			const left = `${chevron} ${entry.icon}  ${label}`;
			const gap = " ".repeat(Math.max(1, blockWidth - visibleWidth(left) - 1));
			lines.push(`${left}${gap}${this.theme.fg("warning", entry.hotkey)}`);
		});
		lines.push("", this.hint("↑↓ move · enter select · hotkey jump · esc = new session"));
		// Center each row in the full terminal width (left-pad only; no trailing spaces).
		const centered = lines.map((line) => {
			if (!line) return line;
			const fitted = truncateToWidth(line, width);
			return `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2)))}${fitted}`;
		});
		const block = this.isCompact() ? centered : ["", ...centered];
		// pi's fullscreen layout pins the editor region (hosting this menu) to the screen bottom
		// and stretches the transcript above it, so the menu would hug the terminal's bottom edge.
		// Trailing blank rows grow this region upward, vertically centering the visible menu in
		// the space between the splash and the bottom. One of the rows below the menu is the
		// footer's; splashRows === 0 means no splash is installed, so there is nothing to center in.
		const free = this.tui.terminal.rows - state.splashRows - block.length;
		if (state.splashRows > 0 && free > 1) {
			const below = free - Math.floor(free / 2) - 1;
			for (let i = 0; i < below; i++) block.push("");
		}
		return block;
	}

	private buildResumeBody(width: number): string[] {
		const body: string[] = [];
		if (this.sessionsLoading || this.sessions === null) {
			body.push(this.theme.fg("muted", "Loading sessions…"));
		} else if (this.sessions.length === 0) {
			body.push(this.theme.fg("muted", "No sessions found in this directory"));
		} else {
			// Reserve the right-hand columns up front. Appending the date after the preview lets a
			// long preview push it past the box edge, where truncation eats it — which is why dates
			// only showed up on short rows before. For the same reason a column that no longer fits
			// is dropped outright rather than left to be clipped into a stub; the count goes first.
			const inner = Math.max(1, width - 4);
			const showDate = inner >= MARKER_W + MIN_PREVIEW_W + COLUMN_GAP + DATE_W;
			const showCount = inner >= MARKER_W + MIN_PREVIEW_W + (COLUMN_GAP + COUNT_W) + (COLUMN_GAP + DATE_W);
			const metaW = (showCount ? COLUMN_GAP + COUNT_W : 0) + (showDate ? COLUMN_GAP + DATE_W : 0);
			const previewW = Math.max(MIN_PREVIEW_W, inner - MARKER_W - metaW);
			const { start, end } = listWindow(this.sessions.length, GATE_LIST_HEIGHT, this.sessionIndex);
			const gap = " ".repeat(COLUMN_GAP);
			for (let idx = start; idx < end; idx++) {
				const selected = idx === this.sessionIndex;
				const display = this.precomputedDisplay[idx]!;
				const preview = truncateToWidth(display.preview, previewW, "…", true);
				const count = display.count.padStart(COUNT_W);
				const date = display.date.padStart(DATE_W);
				body.push(
					`${selected ? this.theme.fg("accent", "▶") : " "} ` +
						`${this.theme.fg(selected ? "accent" : "text", preview)}` +
						`${showCount ? gap + this.theme.fg(selected ? "accent" : "muted", count) : ""}` +
						`${showDate ? gap + this.theme.fg(selected ? "accent" : "dim", date) : ""}`,
				);
			}
			if (this.sessions.length > GATE_LIST_HEIGHT) {
				body.push("", this.theme.fg("dim", `  ${this.sessionIndex + 1} of ${this.sessions.length}`));
			}
		}
		body.push("", this.hint("↑↓ move · enter resume · esc back"));
		return body;
	}

	private buildModelBody(width: number): string[] {
		const picker = this.modelPicker;
		if (!picker) return [];
		// `renderPopupBox` pads its interior to exactly `width - 4`, which is what the picker emits.
		const bodyWidth = Math.max(1, width - 4);
		const hints = "type to filter · ↑↓ move · tab/←→ switch pane · enter select · esc back";
		return [...picker.render(bodyWidth), ...picker.renderFooter(bodyWidth, hints)];
	}

	private buildThemeBody(): string[] {
		const body: string[] = [];
		if (this.themes.length === 0) {
			body.push(this.theme.fg("muted", "No themes available"));
		} else {
			const { start, end } = listWindow(this.themes.length, GATE_LIST_HEIGHT, this.themeIndex);
			for (let idx = start; idx < end; idx++) {
				const entry = this.themes[idx]!;
				const selected = idx === this.themeIndex;
				const isCurrent = entry.name === this.savedThemeName;
				const marker = isCurrent ? this.theme.fg("success", "●") : " ";
				const label = sanitizeTuiText(entry.name) || "(invalid theme)";
				const styled = selected ? this.theme.fg("accent", label) : this.theme.fg("text", label);
				body.push(`${selected ? "▶" : " "} ${marker} ${styled}`);
			}
			if (this.themes.length > GATE_LIST_HEIGHT) {
				body.push(this.theme.fg("dim", `  ${this.themeIndex + 1}/${this.themes.length}`));
			}
		}
		body.push("", this.hint("↑↓ preview · enter select · esc back"));
		return body;
	}

	/**
	 * Rows the two-pane list may occupy: the terminal less the popup box (4), the overlay's
	 * vertical margins (2) and the body's own header, filter, blank, position and hint rows (6).
	 * Capped at the longer list so short lists get a compact box instead of trailing blanks.
	 */
	private inventoryListHeight(longest: number): number {
		return Math.max(3, Math.min(longest, this.tui.terminal.rows - 12));
	}

	private buildSkillsExtensionsBody(width: number): string[] {
		const innerW = Math.max(1, width - 4);
		// " │ " between the panes, so leftW + 3 + rightW === innerW at any usable width.
		const leftW = Math.max(3, Math.floor((innerW - 3) / 2));
		const rightW = Math.max(3, innerW - 3 - leftW);
		const skills = this.filteredItems("skills");
		const extensions = this.filteredItems("extensions");
		const height = this.inventoryListHeight(Math.max(skills.length, extensions.length));
		// Emitted for both panes whenever either is filtered, so the two lists stay row-aligned.
		const showFilters = Boolean(this.inventory.skills.filter || this.inventory.extensions.filter);

		const pane = (name: "skills" | "extensions", items: string[], cellW: number): string[] => {
			const { index, filter } = this.inventory[name];
			const total = (name === "skills" ? state.loadedSkills : state.loadedExtensions).length;
			const active = this.inventoryPane === name;
			const count = filter ? `${items.length}/${total}` : String(total);
			const lines = [`${this.theme.fg(active ? "accent" : "warning", `[${name}]`)} ${this.theme.fg("dim", count)}`];
			if (showFilters) {
				lines.push(filter
					? `${this.theme.fg("dim", "filter: ")}${this.theme.fg("text", sanitizeTuiText(filter))}${active ? this.theme.fg("accent", "▌") : ""}`
					: "");
			}
			lines.push("");
			if (items.length === 0) {
				lines.push(this.theme.fg("muted", filter ? "no match" : "none"));
			} else {
				const { start, end } = listWindow(items.length, height, index);
				for (let idx = start; idx < end; idx++) {
					// Truncate the raw name before styling: cutting an already-styled string drops its
					// closing reset, bleeding color across the divider into the other pane.
					const label = truncateToWidth(items[idx]!, cellW - 2, ELLIPSIS);
					const selected = idx === index;
					const chevron = selected ? this.theme.fg(active ? "accent" : "dim", "▶") : " ";
					lines.push(`${chevron} ${selected && active ? this.theme.fg("accent", label) : this.theme.fg("text", label)}`);
				}
				if (items.length > height) lines.push(this.theme.fg("dim", `  ${index + 1}/${items.length}`));
			}
			return lines;
		};

		const left = pane("skills", skills, leftW);
		const right = pane("extensions", extensions, rightW);
		const divider = this.theme.fg("border", "│");
		// The panes differ in length: the shorter one yields blank cells while the divider runs on.
		const cell = (line: string | undefined, cellW: number) => truncateToWidth(line ?? "", cellW, ELLIPSIS, true);
		const rows = Array.from({ length: Math.max(left.length, right.length) }, (_, i) =>
			`${cell(left[i], leftW)} ${divider} ${cell(right[i], rightW)}`,
		);
		return [...rows, "", this.hint(this.inventory[this.inventoryPane].filter
			? "↑↓ scroll · backspace edit · ←→ switch pane · esc clear filter"
			: "type to filter · ↑↓ scroll · ←→/tab switch pane · esc back")];
	}

	invalidate(): void {
		this.modelPicker?.invalidate();
	}
}

/** Widths of the resume list's fixed columns: `▶ `, right-aligned count, and `YYYY-MM-DD HH:MM`. */
const MARKER_W = 2;
const COUNT_W = 9;
const DATE_W = 16;
const COLUMN_GAP = 2;
/** Below this the preview stops being worth reading, so metadata columns are shed instead. */
const MIN_PREVIEW_W = 12;

/** SessionManager substitutes this when no user message contributed text. */
const NO_TEXT_PROMPT = "(no messages)";

/**
 * The one line a human would recognize a session by. `firstMessage` is the raw prompt the agent
 * received, so a session started from a skill or slash command opens with an injected
 * `<skill name="…" location="…">` envelope wrapping the skill's whole instruction file — none of
 * which the user typed. Reduce those to the invocation itself and flatten everything else.
 */
export function sessionPreview(session: SessionListItem): string {
	if (session.name) return sanitizeTuiText(session.name);
	const raw = (session.firstMessage ?? "").trim();
	// SessionManager's sentinel for "no user message carried plain text" (an image-only or
	// tool-only opener). The session still has messages, so echoing it beside a message count
	// reads as a contradiction.
	if (raw === NO_TEXT_PROMPT) return "(untitled session)";
	const skill = /^<skill\s[^>]*\bname="([^"]+)"/.exec(raw);
	if (skill) return `/${sanitizeTuiText(skill[1]!)}`;
	const cleaned = raw
		.replace(/<(system-reminder|user-prompt-submit-hook)\b[\s\S]*?<\/\1>/g, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return sanitizeTuiText(cleaned) || "(empty session)";
}

/** Format a session's modified date compactly (YYYY-MM-DD HH:MM), tolerant of bad input. */
export function formatSessionDate(value: Date | undefined): string {
	if (!value || Number.isNaN(value.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

/**
 * Show the blocking startup gate and await the user's choice. Returns the non-relaunch
 * resolution ("proceed" or "quit"); relaunch actions never resolve because the process is
 * replaced/shut down inside the component.
 */
export async function runStartupGate(pi: ExtensionAPI, ctx: ExtensionContext): Promise<GateResolution> {
	// Hide the built-in footer while the gate menu is up: swap in a zero-line component,
	// then restore the built-in footer once the gate resolves. Relaunch actions never
	// resolve the promise, but they replace the process, so no restore is needed there.
	ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
	try {
		return await ctx.ui.custom<GateResolution>((tui, theme, _keybindings, done) =>
			new StartupGate(tui, theme, ctx, pi, done),
		);
	} finally {
		ctx.ui.setFooter(undefined);
	}
}
