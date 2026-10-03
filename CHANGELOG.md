# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Dynamic** splash backdrop (`/topping-splash-settings` → Background color → `dynamic`, last in
  the cycle): shows the last theme color you applied as the background at a brightness set by the
  local time of day — full strength in early afternoon, dimmed overnight — as a time-aware
  light/dark mode. The tint is stored as `dynamicTint` in `pi-topping-splash.json` and is
  `accent` until a theme color has been applied. Brightness is recomputed on each splash repaint;
  gradient animations still apply on top.

### Changed

- **Summarize uncommitted changes** now defaults to on when `changesSummary` is missing from
  `pi-topping-splash.json` (fresh installs and files written before the key existed). In trusted,
  dirty git repositories, the `[local changes]` section and its model summary now appear without
  opting in, so bounded file lists and redacted diff excerpts go to the summary model's provider.
  An explicit `"changesSummary": "off"` is still honored, while an unrecognized value now resolves
  to on like the gate and reveal toggles. Turn it off with `/topping-splash-settings`.
- Development and CI now typecheck and test against Pi 1.0.0; the
  `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` devDependencies moved from 0.99.2.
  Pi 1.0.0 removes no public export, and none of the 46 symbols this extension imports changed
  signature, so it needs no code changes.
- The startup gate's vertical centering depends on the extension continuing to write
  `quietStartup: true`. Pi 1.0.0's `quietStartup: "header"` would wrap the header in blank rows
  that `state.splashRows` does not count, shifting the gate menu one row low. A `"header"` value
  you set yourself is left as is.
- Pi 1.0.0 makes the fullscreen TUI the default, so the gate menu's row arithmetic now runs under
  the fullscreen layout for every user, not only those who opted in. The arithmetic already
  targeted that layout and is unchanged.

## [0.4.1] - 2026-09-30

### Added

- A **view system prompt** entry in the startup gate menu (hotkey `p`; `s` still opens
  Settings). It opens a read-only overlay, up to 120 columns wide, of the base system prompt as Pi
  built it at startup, without the sections extensions add before each prompt. Lines wrap to the
  overlay, ↑/↓ scroll a row, PgUp/PgDn scroll a page, and Esc returns to the menu. The menu is one
  entry taller, so on short terminals the `[local changes]` section has correspondingly fewer rows.

### Changed

- Development and CI now typecheck and test against Pi 0.99.2; the
  `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` devDependencies moved from 0.99.1.
  Pi 0.99.2's changes are confined to MCP, codemode and tool search, none of which this extension
  uses, so it needs no code changes; extension discovery and the compact startup labels were
  re-verified against Pi's own resolution and labeling, both unchanged.
- The prompt-size figure reflects the system prompt as built at startup, so it excludes the
  sections extensions add per prompt. Pi 0.99.2 moved MCP server summaries out of the codemode
  description into a new `mcp_servers` section rebuilt before each prompt: with MCP servers set to
  codemode or deferred exposure, the figure shown at startup is now smaller than the prompt actually
  sent. It catches up at the first prompt, once the splash has scrolled away.
- The startup gate menu keeps its blank row between items even when the `[local changes]` summary
  is showing. Since the startup summary landed, a dirty repository compacted the menu to
  back-to-back rows; the menu's spacing is a function of terminal height alone again, and the
  changes section gives up the rows instead — a short listing falls back to its one-line preview
  sooner rather than the menu losing its spacing. `gateMenuRows` drops its `changesShown`
  argument to match.

### Removed

- The **Skills and Extensions** entry (hotkey `x`) from the startup gate menu, along with the
  two-pane skills/extensions view it opened. The view was a read-only inventory that repeated what
  the splash info panel already lists, so it went away with the row. Skills and extensions remain
  visible on the splash panel.

## [0.4.0] - 2026-09-29

### Added

- Optional startup summary of uncommitted changes, closing the splash's info panel as a `[local changes]` section after `[extensions]`: an immediate listing of added/changed/deleted paths under a heading carrying the per-kind counts, with per-file line counts and churn bars against `HEAD` filling in just after and the model summary streaming in beneath them a character at a time, at twice the tagline's pace (or landing whole when the reveal animation setting is off); short terminals show a one-line heading, featured file and summary preview instead. Includes an asynchronous model summary, an off-by-default settings toggle, and a summary-model picker.
  The heading reads `[local changes] +a, ~c, -d` in the other headings' colors and the summary sits a
  blank row below the file rows. The panel and the gradient grow downward as the section fills in, the
  lists above stay put, and the logo stays centered beside the taller panel. Per-file line counts (and
  the `+lines` in the single-line fallback) take their churn-bar half's color, the theme's `text` for
  added and its `error` for removed, with a zero half dropping to `dim`. The slim changes-only header
  after **New session** uses the same layout, left-aligned and stopped at 100 columns.
- The **Summary model** settings row opens the startup gate's two-pane model picker with Enter or Space
  (its thinking pane is ignored, since summaries always run with thinking off). Backspace or Delete on
  the row resets it to the session model.

### Changed

- Startup reads the preferences file once per session start instead of three times, and change
  listing sorts with a single reused `Intl.Collator` instead of resolving a locale per comparison.
- Development and CI now typecheck and test against Pi 0.99.1; the
  `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` devDependencies moved from 0.86.0.
- The info panel beside the logo now grows up to 100 columns wide instead of 72, reaching it on
  terminals 138 columns or wider, so long lists wrap onto fewer rows. A panel stacked under the logo on
  narrow terminals is unchanged.
- The `/topping-splash-settings` menu is regrouped into three sections: **Startup Gate** (the gate
  toggle), **Splash Banner** (background color, gradient animation), and **Info Panel** (the model +
  prompt size reveal animation, the changes summary toggle, and the summary model).
- The `/topping-splash-settings` menu now ends in an action bar: **Apply** saves and closes, **Cancel**
  discards. Tab focuses the bar, ←/→ pick a button and Enter fires it. Enter on a toggle or cycle row no
  longer applies the menu; Esc still cancels.

### Fixed

- Pi 0.99 `builtin:<name>` CLI extension sources (for example `-e builtin:mcp`) are skipped when
  discovering extensions, like the `<inline:…>` built-ins of earlier Pi versions, instead of being
  resolved as paths relative to the working directory.
- The gate's popup box no longer returns lines wider than the width it was given on terminals below
  five columns, where the rounded chrome's own minimum is wider; the overflow could widen the gate's
  layout instead of being clipped.

### Security

- The changes summary withholds sensitive files by path, not just by file name: every segment of a
  path is tested, so anything under `.ssh`, `.aws`, `.gnupg`, `.kube` or a `secret`/`secrets`
  directory is dropped, and Terraform state and variable files (`*.tfstate`, `*.tfvars`) join the
  sensitive extensions. Their diffs and untracked heads no longer reach the summary prompt.
- Redaction catches more shapes and no longer leaks a half-written key: private-key blocks are
  blanked even when the closing `-----END …-----` marker is missing, identifiers merely containing a
  secret keyword or ending in `_key` are redacted along with their whole quoted value, and AWS,
  GitHub, GitLab, npm, Google, Stripe, Slack and JWT tokens are matched. The name match is anchored
  and length-bounded, so a long non-secret string cannot stall redaction.

## [0.3.2] - 2026-09-20

### Changed

- Gate menu layout now caches its fixed block width instead of recomputing it on every render.
- Extension discovery caches parsed Pi manifests by resolved directory, avoiding repeated file reads
  and JSON parsing during a process run.
- Development and CI now typecheck and test against Pi 0.86.0; the
  `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` devDependencies moved from 0.82.1.
  Runtime peer dependencies remain unrestricted.

### Fixed

- Gate menu centering no longer reserves a row for the gate's own zero-row footer. Pi's
  fullscreen input dock gives a footer that renders nothing no space at all, so the menu sat
  one row below center; the menu is centered between the splash and the bottom again.
- `package.json` manifests written with a UTF-8 byte order mark are parsed when discovering
  extensions, matching Pi's own manifest reader — a BOM previously dropped the package from
  the splash's `[extensions]` list even though Pi loaded it.

## [0.3.1] - 2026-08-14

### Added

- Prompt templates listed in the splash panel under `[prompts] N`, discovered from Pi's
  registered prompt commands (`source === "prompt"`) and displayed as `/name`.
- Compact startup shortcuts listed first in the splash panel under `[shortcuts] 5`, with
  effective keybindings resolved via Pi's exported `keyText()` (so user-customized bindings
  are reflected). Five hints: interrupt, clear/exit, commands (`/`), bash (`!`), more.

### Changed

- Collapsed counts summary now wraps onto multiple lines, breaking only between whole
  `[label] N` counts and centering each line, so a narrow panel stacks the counts instead of
  truncating the last categories to an ellipsis.

### Fixed

- Header discovery is wrapped in try/catch so a display-only failure can no longer abort
  startup, and the tagline reveal now stops when the conversation begins. The gate's filtered
  inventory is cached and `loadSessions` re-entry is guarded, and `shimmerCell` emits the bold
  reset only when bold was applied.
- CLI flags (`--system-prompt`, `--append-system-prompt`, `--no-context-files`) are parsed via
  Pi's `parseArgs` instead of hand-rolled argv scanning, and `keyText()` output is sanitized
  before shortcut hints are rendered.
- `withSettings` failures are logged to stderr and the model-change failure notification now
  surfaces the sanitized error message, instead of being swallowed silently.
- The header no longer re-renders on every `model_select`; it invalidates and repaints only
  when the system prompt size actually changes.

## [0.3.0] - 2026-08-14

### Added

- Settings cycle "Animate gradient" to animate the splash backdrop — any background, `rainbow`
  included: `breathe` (the whole backdrop's brightness eases on a slow sine), `flow` (brightness
  bands roll down the fade), `sheen` (a diagonal highlight sweeps across every few seconds) or
  `wave` (the fade ripples sideways as a traveling wave). Off by default, applies immediately to
  a visible splash and persists across launches.
- Settings entry in the startup gate menu (hotkey `s`; Skills and Extensions moved to `x`), opening the same settings menu as
  `/topping-splash-settings`.

### Fixed

- Gradient animation now stops immediately in sessions where the gate is bypassed (reload,
  relaunched child process) — previously the timer kept running even when the splash was never
  shown. Also stops at the first agent turn in non-gated sessions where the splash was visible.
- Wave animation backdrop level was not clamped to `[0, 1]`; the sine term could push it
  negative, producing unexpected colors near the top of the swatch.
- `isPrintableInput` now rejects C1 control characters (U+0080–009F) in addition to C0 and DEL;
  pasting text containing C1 bytes could previously reach the filter query.
- Filter text displayed in the tab header is now sanitized before rendering; a filter string
  containing escape sequences could break terminal output.

## [0.2.0] - 2026-08-13

### Added

- Settings toggle "Model + prompt size reveal animation" to disable the tagline shimmer reveal;
  when off the settled model · prompt-size text renders immediately.
- Settings cycle "Background color" to switch the splash backdrop between the animated rainbow
  sweep and any of the seven active theme colors, each fading vertically from the theme color to
  black. Applies immediately to a visible splash and persists across launches.

### Changed

- `/topping-splash` replaced by `/topping-splash-settings`, a TUI settings widget matching
  pi-topping's settings menu, with a startup-gate toggle.

### Fixed

- Gate menu is now vertically centered between the bottom of the splash and the bottom of the
  terminal. pi's fullscreen layout pins the editor region (which hosts the menu) to the bottom
  edge, so the menu previously hugged the last rows of the screen.

## [0.1.0] - 2026-08-06

Soft fork of [pi-startup-splash](https://github.com/underactive/pi-startup-splash) 0.2.1
with no shared history.

### Changed

- Package renamed to `@underactive/pi-topping-splash`
- Command renamed from `/startup-splash` to `/topping-splash`
- Preference file renamed from `pi-startup-splash.json` to `pi-topping-splash.json`
