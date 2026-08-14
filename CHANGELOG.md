# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
