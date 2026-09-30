# pi-topping-splash

Pi extension that replaces the default startup header with an edge-to-edge full-color splash and adds an interactive startup gate menu to the session launch flow.

![pi-splash](https://raw.githubusercontent.com/underactive/pi-topping-splash/main/media/pi-splash.png)


## Install

```bash
pi install npm:@underactive/pi-topping-splash
```

Restart Pi (or run `/reload`) to pick it up.

## Compatibility

Requires Node.js 22.19.0 or newer. The current release is developed and tested against Pi
0.99.1; Pi package peer dependency ranges remain unrestricted.

## Settings

Run `/topping-splash-settings` (TUI mode only) or pick **Settings** in the startup gate menu
to open a settings menu in three sections: the startup gate toggle, the splash banner's background
color and gradient animation, and the info panel's reveal animation and opt-in startup changes
summary:

```text
╔═[ Pi Topping Splash: Settings ]══════════════════════════════════════════╗
╟─ Startup Gate ───────────────────────────────────────────────────────────╢
║  ❯ [■] Startup gate menu                                             ON  ║
║                                                                          ║
╟─ Splash Banner ──────────────────────────────────────────────────────────╢
║    [■] Background color                                     ‹ rainbow ›  ║
║    [■] Animate gradient                                         ‹ off ›  ║
║                                                                          ║
╟─ Info Panel ─────────────────────────────────────────────────────────────╢
║    [■] Model + prompt size reveal animation                          ON  ║
║    [ ] Summarize uncommitted changes                                OFF  ║
║    [■] Summary model                                    session model ›  ║
║                                                                          ║
╟──────────────────────────────────────────────────────────────────────────╢
║                                                 [ Apply ]    ‹ Cancel ›  ║
╟──────────────────────────────────────────────────────────────────────────╢
║  ↑↓ move  ␣ toggle  ←→ cycle  ⏎ pick  ⌫ clear  ⇥ actions  esc cancel     ║
╚═══════════════════════════════════════════════════════════════════[ 1/6 ]╝
```

Move with ↑/↓, toggle with Space, and cycle with ←/→. Tab jumps to the action bar at the bottom,
where ←/→ choose **Apply** (save and close) or **Cancel** and Enter fires the highlighted button;
Esc also cancels. Enter on a toggle or cycle row does nothing; it only opens the **Summary model**
picker.

- **Startup gate menu** — show the startup gate menu below the splash on launch (ON by default)
- **Background color** — cycle with ←/→ through `rainbow` (a full-width hue sweep) and the
  seven active theme colors (`accent`, `border`, `borderAccent`, `borderMuted`, `success`,
  `error`, `warning`). A theme color fades vertically from the full color at the top of the
  splash to black at the bottom and stays constant horizontally, unlike the rainbow's left-right
  hue sweep. Indexed (256-color) theme colors are approximated as RGB and still require a
  truecolor-capable terminal to render the emitted backdrop.
- **Animate gradient** — cycle with ←/→ through `off` (the default) and four animations that
  work on any backdrop, `rainbow` included: `breathe` eases the whole backdrop's brightness on
  a slow sine, `flow` rolls brightness bands down the fade, `sheen` sweeps a diagonal highlight
  across every few seconds, and `wave` ripples the fade sideways as a traveling wave. On
  `rainbow` they modulate the sweep's brightness while the hue run stays put; on a theme color
  they modulate the vertical fade. The animation runs while the splash is on screen — during
  the gate, or with the gate off until the first agent turn — then stops for the rest of the
  session, since the splash scrolls away once the conversation grows.
- **Model + prompt size reveal animation** — shimmer-reveal the model · prompt-size tagline on
  the splash, and stream the changes summary in a character at a time; when OFF both render their
  final text immediately (ON by default)
- **Summarize uncommitted changes** — opt in to the info panel's `[local changes]` section (OFF by default).
- **Summary model** — Enter (or Space) opens the same two-pane model picker as the startup gate:
  type to filter, Tab or ←/→ to switch panes, Enter to select. The thinking pane belongs to that
  shared picker but is ignored here, since summaries always run with thinking off. It starts on the
  chosen model, or on the active model when none is chosen. Backspace or Delete resets the row to
  `session model`, which uses the active model.

The gate, reveal, changes-summary toggle, and summary-model choice are read during startup and take effect on the next launch; the background color and gradient animation also apply immediately to an already-visible splash. All six keys are stored together in `pi-topping-splash.json` inside pi's agent directory (`~/.pi/agent` unless `PI_CODING_AGENT_DIR` says otherwise); delete that file to return to the defaults (gate/reveal ON, changes summary OFF, session model, background `rainbow`, animation `off`).

## Splash Inventory

The info panel lists five categories of loaded resources in startup order:

1. **Shortcuts** — five compact Pi startup hints with effective keybindings (interrupt, clear/exit, commands `/`, bash `!`, more). Keys reflect user-customized bindings when Pi's global keybinding manager is initialized.
2. **Context** — loaded context files (`AGENTS.md`/`CLAUDE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`), displayed as cwd-relative or `~`-shortened paths.
3. **Skills** — names of every loaded skill, discovered from Pi's `skill:`-prefixed commands.
4. **Prompts** — registered prompt templates displayed as `/name`, discovered from Pi's commands with `source === "prompt"`.
5. **Extensions** — installed extensions with Pi's compact labels, discovered through Pi's own package-manager logic.

When the panel would exceed 60% of the terminal height or any name/hint is too wide to fit, the lists collapse to a compact counts summary: `[shortcuts] 5 · [context] N · [skills] N · [prompts] N · [extensions] N`. The summary wraps onto as many lines as the panel width needs, breaking only between whole `[label] N` counts, so no count is truncated to an ellipsis.

## Startup changes summary

When enabled, a genuine TUI startup with the splash and a trusted project closes the info panel
with a `[local changes]` section after `[extensions]`, styled like the panel's other sections. The
heading carries the per-kind path counts (`[local changes] +3, ~4, -3`: added, changed, deleted, zero
kinds omitted), and each row below it lists a path in pi-topping-statusline's git colors with a
churn bar and its line counts against `HEAD`, which fill in just after the listing appears, and the
summary sits a blank row below the last file row. Untracked files show `new` and binary files
`bin`; narrow panels drop the bars, then the line counts. The section spends only the rows the gate
or editor leaves free below the splash, growing the panel and the gradient around it downward while
the lists above stay put and the logo stays centered beside the taller panel. When those rows cannot
hold the listing, the section is one line instead: `[local changes] +3, ~4, -3 · ~ src/changes-summary.ts +12 ·
Refactors…` (counts, most changed file, and summary preview, as space permits). Added, changed, and
deleted paths appear before the model request finishes, and the summary streams in under the file
rows when room permits, a character at a time at twice the tagline's pace, the way a chat reply
prints. The first prompt settles it on the whole text, and turning off the reveal animation setting
prints it whole. Clean repositories, non-repository directories, disabled or untrusted projects
produce no section and no model request. The pending line is
`summarizing local changes with provider/id…`; failures remain visible as
`summary unavailable: <reason>` while the path listing stays on screen.

The section survives the startup gate's **New session** choice as a slim changes-only header, laid
out the same way at the splash margin, at most 100 columns wide, on the plain terminal background
since the splash is gone by then. The
summary uses the session model by default, or the configured picker choice, and always requests
with thinking off. Bounded file lists and diff excerpts are sent to the selected model provider.
Sensitive-looking file contents are withheld and common secrets are redacted best-effort; this is
not a guarantee, so enable the feature only when that privacy trade-off is acceptable. Pi's
project-trust setting is also required because Git filters can execute during status/diff.

## Troubleshooting

**Splash or gate not showing?**

- Ensure Pi is running in TUI mode (`--no-tui` disables the splash).
- Both the splash and the gate are skipped when the environment variable `PI_SPLASH_GATE_DONE=1` is set — an internal guard the extension sets on sessions it relaunches so the gate cannot re-trigger in a loop; relaunched sessions start on a clean screen.
- Splash shows but the gate does not? The startup gate menu toggle was turned off at some point — that choice persists across launches, so run `/topping-splash-settings` and turn it back on.
- On `reload` events the gate is intentionally skipped — only a genuine `startup` reason triggers it.
- Check that the package is installed under `~/.pi/agent/npm/node_modules/@underactive/pi-topping-splash` and that `pi --verbose` lists the loaded extension (it overrides `quietStartup`).
- Truecolor (24-bit color) support in your terminal is required for the rainbow swatch backdrop and shimmer effect. On non-truecolor themes the shimmer and panel styling fall back to a plain render; the backdrop's truecolor escapes are left to the terminal's own handling.