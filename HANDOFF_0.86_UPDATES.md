# Handoff: pi 0.86.0 updates for pi-topping-splash

Audit date: 2026-09-19. Host: pi 0.86.0 (global install). Extension devDependencies pinned to 0.82.1.

## Verdict

NEEDS ATTENTION. No 0.86.0 breaking change applies. One changed item does: fullscreen mode no longer reserves a blank row for the zero-row footer the startup gate installs, so the gate menu's vertical centering is off by one row in fullscreen. Cosmetic, fullscreen only.

Verified: `tsc --noEmit` passes with all three pi packages resolved at 0.86.0; test suite passes on the 0.86.0 runtime (331 pass, 0 fail, 1 pre-existing todo). At runtime pi aliases every `@earendil-works/*` import to its bundled copies, so the 0.82.1 packages in node_modules are never loaded.

Changelog: https://pi.dev/news/releases/0.86.0

## Findings

### 1. Zero-row footer no longer reserves a row in fullscreen

Changelog item: "Fixed fullscreen mode reserving a blank row for custom footers that render zero rows" (#8919).

Where: `src/gate.ts:624` installs a footer that renders no rows while the gate is up. The menu centering at `src/gate.ts:426-431` subtracts one row it attributes to that footer:

```ts
// src/gate.ts:426-431
// ... One of the rows below the menu is the footer's; ...
const free = this.tui.terminal.rows - state.splashRows - block.length;
if (state.splashRows > 0 && free > 1) {
    const below = free - Math.floor(free / 2) - 1;
```

In 0.86.0 the fullscreen dock gives the footer slot `minSize: 0` (`dist/modes/interactive/chat-viewport.js:18`), so the zero-row footer occupies nothing and the menu sits lower than centered.

| free rows | above / below, pre-0.86.0 fullscreen | above / below, 0.86.0 |
|---|---|---|
| 9 | 4 / 5 | 5 / 4 |
| 8 | 4 / 4 | 5 / 3 |

Scope: fullscreen only. `getTuiMode` defaults to regular, where the trailing rows are just blank lines.

Fix (preferred): drop the `- 1` and update the comment. The test at `test/gate.test.ts:195-200` then expects 5 trailing blanks instead of 4.

```ts
// src/gate.ts:430
const below = free - Math.floor(free / 2);
```

Alternative, if older fullscreen hosts must keep identical geometry: make the gate footer at `src/gate.ts:624` return `[""]` instead of `[]` and leave the math and test alone. Costs one blank line under the menu in regular mode. Do not do both.

### 2. Discovery port drift (informational, display parity only)

`src/extensions.ts` mirrors pi internals for the splash extension list.
- The compact-label helpers in 0.86.0 interactive mode are byte-identical to 0.82.1, so labels still match.
- pi's manifest reader moved to `core/pi-manifest.js` and now strips a UTF-8 byte order mark before parsing. The port does not, so a package.json starting with a BOM would load in pi but be missing from the splash list. Fix: strip a leading `\uFEFF` before `JSON.parse`.
- Manifest glob expansion now uses Node's built-in `globSync` with a dot-segment filter and sorted output. Equivalent for listing.

## Housekeeping

- Bump `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui` devDependencies from 0.82.1 to 0.86.0. Typecheck already passes against 0.86.0, so this should be a clean bump.
- CHANGELOG entry under `## [Unreleased]` / `### Fixed` for finding 1.

## Checked and not applicable

Breaking changes:
- TranscriptContext: no provider registration or stream handler.
- JSON-only tool arguments/details: no tools registered, no tool_call/tool_result/message/turn handlers. The only message construction is test-only in `test/helpers/sessions.ts`.
- `user_bash` fail-closed: no handler.

Changed items:
- Spinners in the editor border: the extension never calls `setEditorComponent`. The gate replaces the editor container's contents through `ui.custom`, which 0.86.0 still mounts by swapping children. No working/retry/compaction/branch spinner can run while the gate shows because no agent turn has started. The settings menu is an overlay.
- Native clipboard: unused.
- Constrained sampling, schema-less tool rejection: no tools.
- `before_agent_start`: the handler at `index.ts:28-40` returns nothing and only reads `event.systemPrompt`, still a readonly string.
- `pi.on()` unsubscribe: additive, ignored at `index.ts:13,28,42`.
- Extension compiler deferral: filesystem TypeScript extension, loads the compiler as before. Explicit `.ts` import extensions are fine under jiti.
- Click toggling for branch/compaction/skill entries: no entry or message renderers.
- `cache_warming_decision`, `modelRegistry.stream`: unused.

Declaration drift 0.82.1 to 0.86.0, all unaffected: `TUI` is now an interface (used as a type only); session listing gained an optional abort signal; `model_select` gained a `source` field; `Theme` gained optional color keys with constructor defaults, so the test helper theme still constructs; thinking-level types unchanged.

## Verification recipe

```sh
G=$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works
rm -rf /tmp/splash-086 && mkdir -p /tmp/splash-086 && cp -R index.ts src test package.json tsconfig.json /tmp/splash-086/
mkdir -p /tmp/splash-086/node_modules/@earendil-works
for p in pi-coding-agent pi-ai pi-tui pi-agent-core; do
  src=$(npm root -g)/@earendil-works/pi-coding-agent; [ "$p" != pi-coding-agent ] && src=$G/$p
  ln -s "$src" /tmp/splash-086/node_modules/@earendil-works/$p
done
cd /tmp/splash-086 && npx tsc --noEmit -p tsconfig.json && npm test
```

Baseline before changes: tsc 0 errors, 331 pass / 0 fail / 1 todo.

Manual check: launch pi 0.86.0 with `--tui-mode fullscreen` and confirm the gate menu is vertically centered between the splash and the bottom of the terminal.
