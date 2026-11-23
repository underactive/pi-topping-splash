# Handoff: Pi 1.6.0 compatibility and dependency pin

## Goal for /mf-plan

Plan the smallest safe update to develop and test this extension against Pi **1.6.0**. Required: pin the three Pi devDependencies exactly to 1.6.0, fix the verified test-suite type break, regenerate the lockfile, and verify. Do not execute a release, commit, tag, push, or publish as part of this handoff. Feature ideas below are optional and should not expand the minimum scope without a decision.

## Current state and evidence

- `package.json` pins `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` devDependencies to **1.5.2**. `package-lock.json` and the installed top-level packages also resolve to 1.5.2. Pi peerDependencies are `*`: consumers use their host Pi, and the dev pin does not restrict that host.
- Pi 1.6.0 (released 2026-11-20) is the complete release delta after 1.5.2; npm confirms 1.6.0 is latest for all three packages.
- In an isolated `/tmp` copy of the repository, bumped the three dev pins to 1.6.0 with `npm install --save-dev --save-exact`, then ran `npm run typecheck` and `npm test`. **`npm run typecheck` FAILED with 25 errors in 6 files** — all caused by the 1.6.0 breaking change (`Component.render()` now returns `readonly string[]`). All errors are in the test suite; `src/` compiled cleanly. Tests could not run until the type fixes land (the `set -e` script stopped at typecheck, as designed). npm warned that two transitive install scripts were not approved (`@google/genai` preinstall, `protobufjs` postinstall); the checks still ran. `npm test` uses `node -C compiled`, which is necessary for this project's TypeScript dependencies.
- This is strong automated compatibility evidence, **not proof that all host, provider, terminal, or runtime scenarios work**. No live TUI or authenticated provider request was tested.

## Release changes checked against this repo

| Change | Assessment |
| --- | --- |
| 1.6.0 breaking: extension component `render()` returns `readonly string[]`; `Container` returns the same cached array while children are unchanged; extensions that modify render output in place (including `super.render()` in a Container subclass or embedded component output) must copy first (#9549) | **Affects this repo's test suite only.** No `Container` subclass, no `super.render()`, and no in-place mutation of a render result exists in `src/` (audited all `render()` implementations: `src/gate.ts`, `src/changes-summary.ts`, `src/local-changes.ts`, `src/system-prompt-view.ts`, `src/model-picker.ts` — every one builds or returns fresh arrays). The 25 type errors are all readonly-typing mismatches in test helpers. See "Minimum implementation" for the exact targets. |
| 1.6.0: GPT-6.2 Astra / GPT-6.2 Sol added; default model for `openai`/`azure`/`openai-codex` is now GPT-6.2 Sol; both reject thinking `off` | Host/provider behavior. `src/model-picker.ts` lists the registry dynamically, so new models appear automatically; `src/changes-summary.ts` uses a configured model or the session model. Nothing to change in this repo. |
| 1.6.0: Qwen Token Plan provider/gateway changes, per-plan key variables, removed retired deepseek models | Host/provider configuration. Not repository code. |
| 1.6.0: find tool path patterns are now relative to the search directory (`src/*.ts` no longer matches `pkg/src/a.ts`) | This repo does not build find-tool patterns or call the find tool from extension code. No impact. |
| 1.6.0: llama.cpp extension default port 9931 | Host/llama.cpp extension behavior. Not this repo. |
| 1.6.0: Anthropic message threads now on by default for any provider whose baseUrl is on api.anthropic.com | Host/provider behavior. `src/changes-summary.ts` runs its own summary stream via `ctx.modelRegistry.streamSimple`; a real-provider test of that path is recommended (as with the 1.5.1 assessment) but no code change is established. |
| 1.6.0: undici updated to 8.12.4 for security advisories | Host-side dependency fix; improves the host, not this extension. |
| 1.6.0: fix list (read/grep/abort, find `./` patterns, session picker, MCP tool_search drop, `/share` crash, fullscreen scrolling CPU saturation, search-field highlight, terminal exit output flush, etc.) | Host-level fixes; no repository change identified. The fullscreen scrolling fix (#9549) is the same issue that motivated the render-array change. |
| 1.6.0: new models and prompt/providers additions (GPT-6.2, qwen4-max-preview, deepseek-v4.1-flash, reasoning-drop transcript notice) | Not applicable to this extension's surface. |

Full upstream notes: [1.6.0](https://pi.dev/changelog/releases/1.6.0), [changelog index](https://pi.dev/changelog).

## Minimum implementation and acceptance

1. Run in the repository:

   ```sh
   npm install --save-dev --save-exact \
     @earendil-works/pi-coding-agent@1.6.0 \
     @earendil-works/pi-ai@1.6.0 \
     @earendil-works/pi-tui@1.6.0
   ```

   Confirm exact dev pins and coherent lockfile resolution (all three packages deduped at 1.6.0 through `pi-topping-opentui`/`-tools`/`primitives`). Keep the existing `*` peer ranges and Node engine unchanged. Do not assume every transitive dependency is unchanged.

2. Fix the verified test-suite type break (`readonly string[]` from pi 1.6.0). Verified error inventory (typecheck against 1.6.0): `test/header.test.ts` (18), `test/gate.test.ts` (3), `test/index.test.ts:128` (1), `test/local-changes.test.ts:132` (1), `test/settings-dialog.test.ts:62` (1), `test/system-prompt-view.test.ts:250` (1). Mechanical targets:

   - `test/helpers/width.ts`: `assertLinesExact(lines: string[], ...)` and `assertLinesAtMost(lines: string[], ...)` accept `readonly string[]` (they only read lines).
   - `test/helpers/dialog.ts`: `Shown.render(width: number): string[]` becomes `readonly string[]` (fixes the `as Shown` cast errors in `test/index.test.ts` and `test/settings-dialog.test.ts`; `screen`/`settle`/`press` keep working unchanged).
   - `test/local-changes.test.ts`: `renderRegisteredEntry(...): string[] | undefined` becomes `readonly string[] | undefined` (line 132).
   - `test/system-prompt-view.test.ts`: `function parts(lines: string[])` becomes `readonly string[]` (line 29).
   - `test/header.test.ts` / `test/gate.test.ts`: broaden any locally-typed helpers that receive `component.render(...)` output to `readonly string[]` (e.g. `panelText` in header tests). Do not change `src/`.

3. Run `npm run typecheck` then `npm test`; both must exit 0. Then `npm ls @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui` shows 1.6.0 everywhere.

4. Update the Compatibility statement in `README.md` from 1.5.2 to 1.6.0 after verification. Add an accurate entry under `## [Unreleased]` / existing `### Changed` in `CHANGELOG.md`; do not edit released sections. Report test results honestly and do not assert untested scenarios are proven.

5. Acceptance: the three exact pins and lockfile match 1.6.0; typecheck and full test suite pass after the readonly test fixes; compatibility documentation and unreleased changelog describe the verified state; no unrelated changes or release actions.

## Live smoke verification results (performed 2026-11-23)

Ran a real Pi **1.6.0** host (host CLI `pi --version` → 1.6.0) with this extension loaded from the isolated 1.6.0 copy (`/tmp/pi-splash-160-check/index.ts`) in `/tmp/splash-smoke-project` (git repo with uncommitted changes), inside tmux with `COLORTERM=truecolor PI_TRUE_COLOR=1`. Everything below passed with no crash, no stranded overlay, and clean exits (`/quit` → status 0, twice). The host loaded the extension's 1.6.0 `node_modules` and the sibling topping packages compiled and painted against it, confirming the new cached-array `render()` behavior does not affect the dialog painting path.

- **Splash**: edge-to-edge gradient backdrop and info panel rendered at startup; counts row (`[shortcuts] 5 · [context] 1 · [skills] 8 · [prompts] 6 · [extensions] 29`) shown.
- **Settings dialog** (`/topping-splash-settings`): sections list + settings pane + hint bar rendered; toggle **Startup gate menu** off→on with Space, applied with Ctrl+S; persisted to `pi-topping-splash.json` (`menuGate: "on"`).
- **Gate**: appeared on the following launch (gate only triggers on genuine startup). All items listed with hotkeys and hint line. **Note:** letter hotkeys (`n`/`p`/`t`/`m`) did not invoke actions when sent via tmux `send-keys` in this setup (pi warned `tmux extended-keys-format is xterm`; it prefers `csi-u`); Enter on the highlighted row worked. Re-check hotkey jump in a real terminal before claiming it.
- **View system prompt**: bordered popup, wrapped content, scroll worked (rows `4-10 of 375`), Esc back to gate.
- **Theme preview**: popup list (`system`/`dark`/`light`/`neon-pi`), selection marker moved, active theme marked, Esc back.
- **Model picker**: two-pane Models/Thinking rendered with the live registry (`1522/1540` rows), current model marked, Esc back.
- **Startup changes summary**: ran end-to-end — git scan, `[local changes] +2, ~1` headings with path rows and churn bars, then a streamed model summary (real provider request succeeded).
- **`/local-changes`**: entry rendered with file rows + summary; ran again **after `/reload`** with a fresh summary.
- **`/reload`**: printed `Reloaded keybindings, extensions, skills, prompts, themes, and context files`; session stayed usable, no stranded overlay, entry renderer survived.

Gaps (not exercised): Resume-session gate item; the settings-dialog Summary-model picker specifically (the gate picker was opened instead); OSC 7501 blocked status (tmux does not forward it); an overlay open during `/reload`.

Future merges should fold these findings into the compatibility section as the pin lands.

## Optional feature evaluation

- No 1.6.0 feature clearly warrants new extension code. The provider/model additions, find-tool semantics, llama.cpp port, and transcript notices are host surfaces. Do not duplicate them in this extension.
- The `readonly string[]` contract is the only change touching this repo. If future work adds cached render state, the cache must be copied before mutation; today's code already satisfies this.
