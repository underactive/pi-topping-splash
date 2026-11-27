# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The settings dialog, the model picker, the theme picker and the system prompt viewer can be used with the mouse in fullscreen mode. A click on a button, a section, a row, a thinking level or a pane does what the keys do there, and the wheel moves the list or scrolls the text under the pointer. The viewer's text stays selectable, so a click on it does nothing. The keyboard works as before, regular mode has no mouse, and the dialogs look the same. This needs the mouse support of `@underactive/pi-topping-opentui` and `@underactive/pi-topping-opentui-tools`, which is not published yet: both dependencies still name `0.14.4` and are to be raised when it is.

## [0.7.0] - 2026-11-25

### Added

- The published package now includes `CHANGELOG.md`, so Pi 1.5.0 and later can show this extension's release notes under "Extension Updates" after it updates. Notices start with the release after the first one that includes the changelog; the first install only records the version.
- The startup gate and the settings dialog report blocked questions via OSC 7501, the gate on
  Pi 1.5.0+ and the dialog on 1.5.1+. Each reports its own name, and closing one restores the status
  beneath it; the read-only system prompt view relies on the gate's status. Tests pin the options;
  live Pi 1.5.2 capture confirmed the transitions with settings opened from the gate and standalone,
  with and without the model picker, which was then a separate overlay and is now part of the
  dialog. Reload cleanup was not tested live.

- `/topping-splash-settings` opens a redesigned settings dialog: a section list beside the selected section's settings, the focused setting's description below, and an Apply / Cancel bar, with the Summary model picker, model list and thinking pane, taking its place while it is open; the thinking pane draws the selected level's bar (`▰▰▱▱`) in pi's theme color for that thinking level. It is 84 columns wide where the terminal has them and shrinks to 80 columns by 24 rows; at that size the picker lists the thinking levels one to a row and shows the highlighted level's description in the hint area. A terminal smaller than 80x24 clips it. The dialog is designed in the `pi-topping-mockups` repository and converted to `src/ui/generated/` by `pi-topping-opentui` (`npm run port:ui`; `npm run port:check` and `npm run parity:ui` verify it against the mockups' recorded frames).
- New dependency `@underactive/pi-topping-opentui` `0.14.4`, the small React renderer that draws the converted dialog through Pi's TUI; `@underactive/pi-topping-opentui-tools` `0.14.4` and `@types/react` are development-only.

### Changed

- The dialog replaces the settings menu built on `showMenu`; there is no fallback layout. If the dialog fails to run, the failure is reported and nothing is changed.
- The startup gate's Theme picker and View system prompt window are now OpenTUI dialogs with
  the same design language as the settings dialog and model picker, replacing the legacy
  pi-tui popup and overlay. They are designed as mockups in `pi-topping-mockups`, converted by
  `pi-topping-opentui` into `src/ui/generated/`, and opened through hand-written adapters
  (`src/ui/theme-picker-dialog.ts`, `src/ui/system-prompt-view-dialog.ts`) that preserve the
  live theme preview and prompt paging behavior. Each dialog reports its own blocked question
  while open. New parity cases pin both dialogs at full and 80x24 sizes.
- The startup gate's **Model** entry (hotkey `m`) opens the same OpenTUI model picker as the settings dialog's Summary model row, as a dialog above the gate, in place of the picker it drew in its own popup: `/` opens the filter, Enter on a model steps into its thinking pane, Enter again selects. Select applies the model and thinking level and returns to the menu. A model Pi refuses now reports the error and returns to the menu as well, where before the picker stayed open.
- In the Summary model picker, only Backspace resets the row to the session model; Delete no longer does. With no models available the picker opens empty instead of warning "No models available".
- Development and CI now typecheck and test against Pi 1.5.2; the
  `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` devDependencies moved from 1.5.0.
  The dependency bump itself required no source changes. Reload overlay cleanup, the
  session-directory prompt, and real providers have not been tested live.
- Depend on `@underactive/pi-topping-primitives` exactly `0.13.0` (was `^0.12.1`). No code changes were needed.

## [0.6.1] - 2026-11-02

### Changed

- Development and CI now typecheck and test against Pi 1.5.0; the
  `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` devDependencies moved from 1.4.0.
  No source changes were required. Pi 1.5.0 makes `ExecResult.truncated` a required field, so
  only the test suite's fake `pi.exec()` results changed. Git collection already discards any
  result that pi killed or that exited nonzero, and Pi 1.5.0 reports output over its buffer
  cap as both, so an oversized `git status` still falls back instead of listing a partial
  tree. Pi 1.5.0's startup notice, trust, and package-loading changes are in pi's host, so the
  unit tests, which use a fake context, do not exercise them.

- Depend on `@underactive/pi-topping-primitives` `^0.12.1` (was `^0.11.0`).

- Depend on `@underactive/pi-topping-primitives` `^0.11.0` (was `^0.10.0`). No imports changed; only primitives 0.11.0 glyphs were added, with no visible behavior change.

## [0.6.0] - 2026-10-21

### Changed

- Depend on `@underactive/pi-topping-primitives` `^0.10.0` (was `^0.8.0`). Nothing it imports changed in between: 0.9.0 added `./env` and `./abort`, which it does not use, and 0.10.0 removed only the `pi-topping-compact` entry names from `./contracts`, which it never referenced. Every topping now asks for the same range, so an install of several shares one copy of the library. No visible change.
- The pi that a relaunch starts is now found by `@underactive/pi-topping-primitives` 0.8.0 (`./process`): the running entry script under the running runtime, or a compiled or Bun pi's own executable. Before, a relaunch always passed `process.argv[1]` to `process.execPath` as a script, including the `/$bunfs/root/` virtual path a Bun-compiled pi reports; that case now runs the executable on its own (checked with injected process facts, not on a real compiled binary). The relaunch is still refused, before the TUI stops, whenever the only option left is `pi` on PATH, since that may not be the pi hosting this session.
- Text layout helpers (`padRight`, `padCenter`, `truncateVisible`, `fitCell`, `joinParts`, `pickFitting`, `wrapCommaDelimited`, `ELLIPSIS`) and the tagline reveal's shimmer cell now come from `@underactive/pi-topping-primitives` 0.6.0 (`./text`, `./color`); `src/text.ts` re-exports the layout helpers so importers are unchanged. `pickFitting` of an empty candidate list now returns an empty string instead of throwing.
- Model pickers now use `@underactive/pi-topping-primitives` 0.5.0 models: asymmetric panes give model labels more room, with one-column insets and smart truncation. Filtering preserves the selected model, accepts kitty printable input and pasted text from any pane (including the buttons), and empty Select is inert. The total-body cap reserves header/filter/scroll rows separately to keep ten model rows. Footer hints now wrap inside the local rule sandwich. The model list and thinking ranges are still read from the registry each time a picker opens, so logins and registry refreshes show up without a restart; empty or unknown thinking ranges use the common four levels.
- Preferences are read and written by the shared `@underactive/pi-topping-primitives` 0.2.0 settings store. The file name and format are unchanged; the file is now created 0600, and on a fresh install the agent directory is created 0700. A failed write still returns `false` and leaves no temp file.
- Use the shared `splashLocalChanges` entry name from `@underactive/pi-topping-primitives` while keeping the local-changes payload validator in splash.
- The `/topping-splash-settings` menu is now the shared `@underactive/pi-topping-primitives` 0.4.0 menu (`./menu`) instead of a vendored copy. What changes on screen:
  - Enter or Space on **Summary model** opens the picker over the still-open menu and returns to it with the cursor on that row; the menu used to close and reopen around the picker.
  - The menu is 90% of the terminal wide (it was fixed at 76 columns) and at most 85% high (it was 100%).
  - Up and Down stop at the first and last rows instead of wrapping around, and PgUp/PgDn move one screenful.
  - Shift+Tab also moves focus between the rows and the Apply/Cancel bar, and Left/Right on the bar stop at its ends instead of wrapping.
  - The menu's keys can be remapped in pi's keybindings file under the `pi-topping.menu.*` ids (`up`, `down`, `pageUp`, `pageDown`, `left`, `right`, `toggle`, `apply`, `cancel`, `focusButtons`, `clear`, `editCommit`, `editCancel`, `editBackspace`).
  - The **Summary model** row renders as `value ›` without the `[■]` checkbox.
  - Escape and Ctrl+C return the menu's draft values with `applied: false`; the command still writes nothing on cancel.
- Development and CI now typecheck and test against Pi 1.4.0; the
  `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` devDependencies moved from 1.3.0.
  No source changes were required: Pi 1.4.0 removes no imported public API. Its fix for
  concurrent extension dialogs and inline `custom()` components applies to the gate's stacked
  overlays (settings and the Summary model picker over the gate); that fix is in pi's host, so
  the unit tests, which use a fake context, do not exercise it. The remaining 1.4.0 changes
  (provider attribution headers, summary `reserveTokens`, codemode workers) are not used here.

### Added

- **Logo style** setting for the splash banner with `random`, `symbol`, and `logo` options. The `random` option (the default) randomly selects between `symbol` and `logo` on startup. The `logo` option plays the 21-frame animation
  transcribed from `https://pi.dev/install.sh` at one scale derived from all source frames, drawn at twice the glyph-slot fit in its own slot beside the info panel, and holds the final frame after one-shot playback. Side by side, that held mark, not the animation's full box, is what sits centered on the panel, so the drop-in frames fall from the top edge when the panel is shorter than the animation. It falls back to the glyph art when truecolor is unavailable or the terminal is unsupported.

## [0.5.3] - 2026-10-16

### Changed

- The startup gate menu now defaults to off when `menuGate` is missing from preferences (new installs
  and unreadable files). Turn it on with `/topping-splash-settings` if you want the gate on launch.
- Development and CI now typecheck and test against Pi 1.3.0; the
  `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` devDependencies moved from 1.1.0.
  No source changes were required: Pi 1.3.0 removes no imported public API, and
  `before_agent_start` is now a `messageType` union, but its `systemPrompt` remains on the shared
  base type, so the handler also covers custom `triggerTurn` runs. Pi 1.3.0 also makes an overlay's
  `done()` close only its own overlay. Pi's per-key OpenRouter model availability flows into the
  existing Summary model picker.

### Fixed

- Local-changes summaries now send the Pi session id with the model request, so OpenCode Zen and
  OpenCode Go models no longer fail with `400 MissingSessionID`.

## [0.5.2] - 2026-10-12

### Added

- **`/local-changes`** summarizes uncommitted changes on demand in a trusted TUI project, even when
  the startup summary is off. It appends the settled file list, churn bars, line counts, and model
  summary as a display-only transcript entry that Pi keeps out of model context after reload and
  compaction; a clean tree shows `none`, and a git failure shows that git is unavailable. It ignores
  arguments and allows one active run. Like the startup summary, it sends bounded, redacted diff
  excerpts to the Summary model's provider.

### Changed

- Development and CI now typecheck and test against Pi 1.1.0; the
  `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` devDependencies moved from 1.0.3.
  Pi 1.0.4–1.1.0 remove no public export, and of the 52 Pi symbols the extension and its test suite
  import (35 in shipped code) only `AssistantMessage` changed (optional `durationMs`), so it needs no
  code changes. Claude
  Haiku 5.5 (`anthropic/claude-haiku-5-5`) can now appear in the Summary model picker when
  Anthropic credentials are available.

### Fixed

- **Retrying a changes summary cut off by the token limit.** The 0.5.1 retry did not tell an empty
  answer caused by the provider's output token limit from a genuinely empty answer. It repeated the
  cut-off request up to three more times and then settled on `summary unavailable: empty response`,
  which named no cause. An empty answer with stop reason `length` now settles on the first attempt
  as `summary unavailable: token limit reached`. A genuinely empty answer with a stop reason other
  than `length`, `aborted`, or `error` still retries up to three times. This covers the startup
  `[local changes]` summary and `/local-changes`, which share one collection and summary run.

## [0.5.1] - 2026-10-05

### Changed

- Development and CI now typecheck and test against Pi 1.0.3; the
  `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` devDependencies moved from 1.0.0.
  Pi 1.0.1–1.0.3 remove no public export and change none of the symbols this extension imports,
  so it needs no code changes. The 1.0.3 Home/End keybinding change does not reach the startup
  gate, model picker, or settings menus.

### Fixed

- **Retrying an empty changes summary.** The startup `[local changes]` summary sometimes came back
  with no text at all, leaving the section on `summary unavailable: empty response` for the rest of
  the session. An empty answer is now requested again, up to three retries, and the first attempt to
  return text becomes the summary; only an empty final attempt still reports the failure. Each
  attempt carries its own timeout, and session shutdown stops the retries. Cancelled, timed out,
  thrown, and error-stopped requests are not retried, and the pending line stays up through the
  retries, so the path listing never changes shape or flickers.
- Change-summary cells with no additions or deletions now have zero width instead of a negative
  width.

## [0.5.0] - 2026-10-02

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

### Fixed

- The **View system prompt** gate row is capitalized, matching the menu's other entries.
- Preferences are now written atomically — to a temporary file in the same directory, then
  renamed over `pi-topping-splash.json` — so an interrupted or full-disk save can no longer
  truncate the file, and a failed save leaves the previously saved settings intact.
- `session_shutdown` stops the gradient animation and tagline reveal timers alongside the
  changes-summary abort. Ending a session before the first agent turn previously left both
  timers running.
- A changes summary that resolves after the conversation has started is rendered whole instead
  of restarting the streaming timer, which no one was left to watch.
- Theme colors resolve through Pi's `colorToRgb` instead of a local ANSI parser. A color that
  resolves through the terminal's defaults, or an indexed color, now renders as that color
  rather than silently falling back to the rainbow sweep, and the info panel's plate is picked
  from the resolved text color's luminance on every theme. The tagline shimmer still requires a
  truecolor theme.

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
