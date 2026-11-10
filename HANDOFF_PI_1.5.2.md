# Handoff: Pi 1.5.2 compatibility and dependency pin

## Goal for /mf-plan

Plan the smallest safe update to develop and test this extension against Pi **1.5.2**. Required: pin the three Pi devDependencies exactly to 1.5.2, regenerate the lockfile, and verify. Do not execute a release, commit, tag, push, or publish as part of this handoff. Feature ideas below are optional and should not expand the minimum scope without a decision.

## Current state and evidence

- `package.json` pins `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` devDependencies to **1.5.0**. `package-lock.json` and the installed top-level packages also resolve to 1.5.0. Pi peerDependencies are `*`: consumers use their host Pi, and the dev pin does not restrict that host.
- Pi 1.5.1 and 1.5.2 are the complete release delta after 1.5.0. Pi's changelog identifies 1.5.2 as the latest at the time of this investigation.
- In an isolated `/tmp` copy of the repository, installed all three packages at 1.5.2 with `npm install --save-dev --save-exact`, then ran `npm run typecheck` and `npm test`: both exited 0 on Node v24.22.1/npm 11.19.1. The repository's dependency files and installed packages were not changed. npm warned that two transitive install scripts were not approved; the checks still passed. `npm test` uses `node -C compiled`, which is necessary for this project's TypeScript dependencies.
- This is strong automated compatibility evidence, **not proof that all host, provider, terminal, or runtime scenarios work**. No live TUI or authenticated provider request was tested. No direct source break was identified in the review.

## Release changes checked against this repo

| Change | Assessment |
| --- | --- |
| 1.5.1: `GrepOperations.readFile` no longer supplies grep context lines | No custom grep operations or grep tool override found; no migration identified. |
| 1.5.1: OpenAI-compatible requests omit `tools: []` after tool history when all tools are disabled | No provider adapter or tool-history request construction in this repo. `src/changes-summary.ts` uses `ctx.modelRegistry.streamSimple` for a separate, tool-free summary, so the specified history condition does not match that call. Host sessions using older proxies may need `compat.requiresToolsWithToolHistory: true` in `models.json`; this is host configuration, not a repository fix. |
| 1.5.1: Anthropic message threads; default idle cache warming; new default models | Host/provider behavior changes automatically. `src/model-picker.ts` reads the available registry dynamically, while `src/changes-summary.ts` selects a configured model or the session model. Summary calls pass the session ID with their own prompt; don't assume thread/cache isolation or lack of impact without a real-provider test. Idle warming may incur cost; `cacheWarming: "streaming"` restores the prior host setting. |
| 1.5.1: `ctx.ui.custom()` overlays honor `blocked`; cleanup now removes all extension overlays on reload/session switch | `src/gate.ts` mounts an inline gate and uses `tui.showOverlay` for non-capturing drill-ins; `src/settings.ts` and `src/system-prompt-view.ts` use custom capturing overlays, with the settings menu supplied by primitives. Neither local custom overlay requests `blocked`; the inline gate also does not request it. Cleanup is a host fix, not a reason to change overlay behavior blindly. Test nested focus and cleanup in a real host. |
| 1.5.1: model-catalog, model-switch, paste, rendering, package update and symlink fixes; auth CLI, Mermaid and classifier additions | Mostly host-level benefits or unrelated to this extension; no direct implementation required. The picker uses a live registry and its own UI, not Pi's built-in model selector. |
| 1.5.2: missing original session directory offers Continue/Fork/Cancel; `/import` duplicate cleanup | `src/gate.ts` lists `SessionManager.list(ctx.cwd)` and `relaunch.ts` launches a child with `--session`; it does not call `ctx.switchSession()`. Pi owns the new prompt on the child/startup path if such a session is selected or supplied by CLI. Do not claim the gate now discovers moved-directory sessions: its listing remains scoped to the current cwd. Fork gives a new session ID. No extension change is established as necessary. |
| 1.5.2: Anthropic OAuth version fix | Host/provider fix; no repo change identified. |

Full upstream notes contain additional fixes beyond those summarized above: [1.5.1](https://pi.dev/changelog/releases/1.5.1), [1.5.2](https://pi.dev/changelog/releases/1.5.2), [changelog index](https://pi.dev/changelog).

## Minimum implementation and acceptance

1. Run in the repository:

   ```sh
   npm install --save-dev --save-exact \
     @earendil-works/pi-coding-agent@1.5.2 \
     @earendil-works/pi-ai@1.5.2 \
     @earendil-works/pi-tui@1.5.2
   npm run typecheck
   npm test
   npm ls @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui
   ```

   Confirm exact dev pins and coherent lockfile resolution. Keep the existing `*` peer ranges and Node engine unchanged. Do not assume every transitive dependency is unchanged.
2. Update the Compatibility statement in `README.md` from 1.5.0 to 1.5.2 after verification. Add an accurate entry under `## [Unreleased]` / existing `### Changed` in `CHANGELOG.md`; do not edit released sections. Report test results honestly and do not assert untested scenarios are proven.
3. Acceptance: the three exact pins and lockfile match 1.5.2; typecheck and full test suite pass; compatibility documentation and unreleased changelog describe the verified state; no unrelated changes or release actions.

## Recommended manual verification (not yet performed)

- Launch a real Pi 1.5.2 with this extension and gate enabled. Check fresh startup, New and Resume, model/theme selection, Settings → Summary model → back, system prompt scrolling/back, and `/reload` or session switch with nested overlays. Confirm focus, no stranded overlays, and continued input.
- If practical, use a disposable session whose original cwd was removed: exercise a real `--session` launch and Continue/Fork/Cancel. Check fork has a new ID and later resume, without assuming the cwd-scoped gate picker lists it.
- With explicitly authorized credentials and a dirty disposable Git repository, check the startup summary and `/local-changes` on an available provider, especially Anthropic if used; watch for request failure, cross-contamination with the session and unexpected billing. Do not require credentials or a paid request for baseline CI.

## Optional feature evaluation

- Consider `blocked: true` for genuinely input-blocking custom dialogs so OSC 7501 dashboards show waiting status. The 1.5.1 overlay support makes this viable for the local capturing overlays; the gate is inline and `showMenu` is owned by `@underactive/pi-topping-primitives`, so inspect that package and test nested open/close, hiding, abort, reload, and the resulting status lifetime before proposing changes. A read-only viewer or picker may not merit blocked status; make this a product choice, not a mandatory upgrade.
- No other 1.5.1–1.5.2 feature clearly warrants new extension code. Do not duplicate Pi's session fork UI, authentication, cache policy, model catalog, update summaries, Mermaid renderer, or classifiers in the minimum bump.
