# Contract table

Expectations for the test suite, derived **before reading any implementation body**.

Allowed sources: `README.md`, doc comments on exports, exported constants/signatures,
commit `8329d39` message body, and collaborator packages'
`.d.ts`/behavior (`@earendil-works/pi-tui`, `@earendil-works/pi-coding-agent` — these are
dependencies, not the code under test). Rows marked `UNSPECIFIED` have no such source;
for them tests may assert only safety invariants (width bounds, no-throw, determinism),
never invented literals.

Cross-cutting invariant **W** (project memory, motivates every width sweep): the pi TUI
kills the process when a rendered line exceeds the terminal width. Oracle:
`visibleWidth` from `@earendil-works/pi-tui` (the renderer's own measuring function —
a collaborator, never the code under test). `===` where the surface promises exact
fill, `<=` for interior/unpadded lines.

Timer strategy (decided by smoke test, step 3): _recorded after the smoke test — see
"Timer decision" at the bottom._

## text.ts

| # | Symbol | Claim | Source |
|---|--------|-------|--------|
| T-01 | `formatPromptSize` | ~4 bytes/token; `<1000` tokens → `~N tokens` (integer); `>=1000` → `~N.Nk tokens` (one decimal) | doc comment |
| T-02 | `formatPromptSize` | UNSPECIFIED: non-finite input (NaN/±Infinity) — the doc comment covers only finite byte counts. Assert no-throw + determinism only; observed literal recorded in the gap pass | — |
| T-03 | `visibleLength` | terminal-column width via pi-tui `visibleWidth` (the renderer's own ruler): escapes (SGR, OSC with BEL or ST terminator) count 0, wide chars count 2 | doc comment; amended 2026-07-28 (slop-audit finding 2: delegated to the collaborator ruler; was code-unit counting that stripped only SGR + BEL-terminated OSC-8) |
| T-04 | `padRight`/`padCenter` | pad to `width` visible columns; text wider than `width` is not truncated → `visibleLength(result) === max(width, visibleLength(text))`; padRight left-aligns (starts with text); padCenter centers (left pad <= right pad diff <= 1) | signature + name; safety property |
| T-05 | `wrapCommaDelimited` | every line `<= width` (when every item fits); trailing comma on line breaks; `[]` for empty items; joining lines back (trim, split on ",") reconstructs the item sequence in order | doc comment |
| T-06 | `sanitizeTuiText` | strips `\x1b[...m` and OSC (`\x1b]...` with BEL **or** ST terminator) entirely; plain text unchanged | doc comment; amended 2026-07-28 (ST terminator added while closing slop-audit finding 3) |
| T-07 | `uniqueSorted` | result is sorted, duplicate-free, and a subset of (and covers) the input values | name + signature (safety property) |
| T-08 | `truncateVisible` | `visibleLength(result) === min(maxWidth, visibleLength(text))` for single-width text; a wide char straddling the cut is dropped (result may fall one column short); escapes never count and are never split; for escape-free text, result is a prefix of the input | doc comment; amended 2026-07-28 (delegated to pi-tui `sliceByColumn` — strict mode; `truncateToWidth` was rejected because it appends `\x1b[0m`, which T-09 forbids) |
| T-09 | `fitCell` | fits `width` visible columns; when truncation occurs, marks with `ELLIPSIS` ("..."), closes any open color span with a **foreground-only** reset (`\x1b[39m` per SGR spec — collaborator knowledge), so surrounding bg survives; `visibleLength(fitCell(text,width)) <= width` | doc comment |
| T-10 | `joinParts` | joins truthy parts with `" · "` default separator; falsy (undefined/null/false/"") entries dropped, no dangling separator | doc comment + signature default |
| T-11 | `pickFitting` | first candidate with `visibleLength <= width`; if none fit, the **last** candidate truncated to fit | doc comment |
| T-12 | `normalizeSkillName` | UNSPECIFIED: what normalization? (test only: deterministic, no-throw, non-empty for a plain name) | — |
| T-13 | `formatPromptSize` | UNSPECIFIED: rounding mode at boundaries (e.g. exactly 999.5 tokens, 4000 bytes → 1.0k?); asserted only via shape regex + monotonicity, plus the doc's own example `~10.5k tokens` shape | doc gives examples, not rounding rules; amended 2026-07-28 (slop-audit F-12: the promised sweep did not exist — a non-multiple-of-4 byte sweep asserting shape + monotonicity was added) |
| T-14 | `wrapCommaDelimited` | UNSPECIFIED: single item longer than `width` (cannot fit) — assert only: item not lost, no throw | — |
| T-15 | `fitCell` | `width < ELLIPSIS.length`: no throw, `visibleLength <= max(width,0)`, no full reset leaked — the ellipsis is dropped when it cannot fit | was UNSPECIFIED; asserted 2026-08-13 once F-2 was fixed |

## color.ts

| # | Symbol | Claim | Source |
|---|--------|-------|--------|
| C-01 | `rgbFromHex` | `"#RRGGBB"` → `"r;g;b"` decimal triplet (e.g. `#101830` → `16;24;48`) | doc on `Rgb` type ("r;g;b triplet") + hex arithmetic |
| C-02 | `sgrFg`/`sgrBg` | wrap a triplet into truecolor SGR: `\x1b[38;2;r;g;bm` / `\x1b[48;2;r;g;bm` | `Rgb` doc ("ready to splice into a truecolor SGR") + ECMA-48/collaborator knowledge of 38;2/48;2 |
| C-03 | `hsvRgb` | hue in degrees 0–360, sat/val in 0–1 → valid `r;g;b` with channels 0..255 integers; `sat=0` → grey (r=g=b); `val=0` → `0;0;0`; `hsvRgb(0,1,1)` = pure red `255;0;0` (HSV definition — standard math, not implementation) | doc comment + HSV definition |
| C-04 | `hsvRgb` | UNSPECIFIED: hue outside 0–360 (e.g. 320 + full sweep) — assert only: no throw, valid triplet | doc gives domain, not out-of-domain behavior |
| C-05 | `panelBg` | light body text (per WCAG relative luminance vs threshold 140) → `PANEL_BG_DARK` (navy); dark body text → `PANEL_BG_LIGHT` (paper); 256-color themes (no rgb triplet available) → assumed dark terminal → `PANEL_BG_DARK`. Greyscale probe: for grey text `#vvvvvv`, WCAG luminance == v, so flip occurs at v vs 140 | doc comment + `PANEL_LUMINANCE_THRESHOLD` export + WCAG (coefficients sum to 1) |
| C-06 | `swatchColor` | hue sweeps a **full turn** (360°) across `width` starting at `SWATCH_HUE_START` (x=0); `level` 1=top → full value, fading to black as level→0; `level<=0` → `0;0;0` | doc comment + `SWATCH_HUE_START` doc |
| C-07 | `swatchColor` | UNSPECIFIED: exact fade curve (linear?) and saturation profile — assert only: valid triplet, monotonically darker as level decreases (sum of channels non-increasing), x=0 hue ≈ hue of `hsvRgb(SWATCH_HUE_START, SWATCH_SATURATION, SWATCH_VALUE·level-ish)` only at level=1 | — |
| C-08 | `RESET` | `"\x1b[0m"` | exported literal |
| C-09 | `BACKGROUND_COLOR_OPTIONS` | `["rainbow", "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning"]`, in that order | exported literal + menu cycle order |
| C-10 | `backgroundSampler` | `"rainbow"` returns `swatchColor` itself; a theme color returns a sampler that ignores `x` (horizontally constant) and returns the theme's resolved RGB at level 1, black at level<=0 | plan decisions (immediate refresh, RGB approximation) |
| C-11 | `backgroundSampler` | resolves both truecolor (`38;2;r;g;bm`) and indexed (`38;5;Nm`, all 256 xterm indexes via the 16-color palette, 6x6x6 cube, and grayscale ramp) theme output; falls back to `swatchColor` only when the theme's ANSI cannot be parsed as either | plan step 2 |

## logo.ts

| # | Symbol | Claim | Source |
|---|--------|-------|--------|
| L-01 | `LOGO_LINES`/`LOGO_WIDTH` | `LOGO_WIDTH === max(line.length)`; every line `<= LOGO_WIDTH`; at least one line; no line is empty-only art (non-blank content exists) | exported definition (`Math.max(...map(length))` visible in signature extraction) |
| L-02 | `LOGO` | contains real block-drawing characters (U+2588 █ family) and does **not** contain the literal text `\u2588` (Bun `String.raw` transpiler corruption regression guard) | project memory (Bun gotcha) + `String.raw` in source |
| L-03 | `LOGO_INK`/`LOGO_SHADOW` | valid `r;g;b` triplets (from `rgbFromHex("#f2f2f2")`/`("#150f28")` → `242;242;242`/`21;15;40`) | exported definitions |
| L-04 | `LOGO_SHADOW_OFFSET` | `1` (cells down-right) | exported literal + doc |

## gate-ui.ts

| # | Symbol | Claim | Source |
|---|--------|-------|--------|
| G-01 | `isPrintableInput` | true iff `data` is non-empty, contains no control chars (C0, incl. `\x1b` — so all escape sequences rejected) and no DEL (`\x7f`) | doc comment |
| G-02 | `listWindow` | returns `[start,end)` with: `0 <= start`, `end <= total`, `end-start === min(total,height)`, and `start <= selected < end` whenever `0 <= selected < total` | doc comment ("keeps selected visible within height rows") |
| G-03 | `fuzzyRanked` | empty query → original order (same array contents, same order); literal-substring matches (case?) stably partitioned to front; non-matching items dropped (it filters — "fuzzy **matches** ranked"); delegates tokenization to pi-tui `fuzzyFilter` (whitespace/slash split) | doc comment + README ("anth opus", literal substring first) |
| G-04 | `fuzzyRanked` | UNSPECIFIED: case sensitivity of the literal-substring partition — probe with same-case first; mixed-case behavior recorded as finding if surprising | — |
| G-05 | `renderPopupBox` | every line exactly `width` visible columns; `bodyLines.length + 4` rows (top border, blank, body…, blank, bottom border); title embedded in top border (`╭─ title ───╮` rounded corners); body lines truncated to interior width; right border aligned | doc comment |
| G-06 | constants | `GATE_PANEL_MAX_WIDTH === 90`, `RESUME_PANEL_WIDTH === "100%"`, `GATE_LIST_HEIGHT === 10`, `SHORT_TERMINAL_ROWS === 24` | exported literals (anchors for other modules' behavior; changing them should be a conscious act) |

## reveal.ts

| # | Symbol | Claim | Source |
|---|--------|-------|--------|
| R-01 | constants | `TAGLINE_PLACEHOLDER === "model · system prompt"`, `REVEAL_HOLD_MS === 500`, `REVEAL_MS_PER_CHAR === 20 === REVEAL_TICK_MS`, `REVEAL_BAND_HALF === 5`, `REVEAL_PEAK_ALPHA === 0.9` | exported literals + README (500ms hold) |
| R-02 | `taglineReveal.pos` initial | starts a full band off the left edge: `pos === -REVEAL_BAND_HALF` before any tick... (doc: "Starts a full band off the left edge") | doc comment on the `pos` field |
| R-03 | `revealPos()` | wipe's leading edge while revealing; `undefined` once settled (never started, stopped, or finished) | doc comment |
| R-04 | `startTaglineReveal` | begins the one-shot reveal: ticker advances `pos` ~1 cell per `REVEAL_TICK_MS` tick **after** `REVEAL_HOLD_MS` of hold; bumps `tick` (repaint key) and calls `headerRenderState.requestRender` on ticks | doc comments (`REVEAL_MS_PER_CHAR`, `taglineReveal`) + README |
| R-05 | pause-not-skip | a tick arriving after a long event-loop block (e.g. 2000ms late) advances the wipe by a **capped** amount (~1 cell), not by elapsed/`REVEAL_MS_PER_CHAR` cells — reveal must not teleport to its end state | README ("pauses rather than skipping ahead") + project memory (measured 1815ms startup blocks) |
| R-06 | one-shot | once `pos` passes `fieldWidth` (+ band), the ticker stops itself; `revealPos()` → `undefined`; never loops | README ("runs once, never loops") + `taglineReveal` doc ("the ticker needs fieldWidth to know when to stop") |
| R-07 | `stopTaglineReveal` | stops the ticker; idempotent; subsequent `revealPos()` → `undefined` | signature + R-03 |
| R-08 | `sgrChannels` | truecolor SGR (`\x1b[38;2;r;g;bm`) → `[r,g,b]`; 256-color SGR / garbage → `null` | doc comment |
| R-09 | `shimmerPalette` | needs the theme's `dim` + `text` colors as truecolor; 256-color theme → `null` (shimmer disabled) | doc comment + R-08 doc |
| R-10 | `shimmerCell` | one cell: crest blend inside band (`dist <= REVEAL_BAND_HALF`), base ink outside; visible width of output === visible width of `ch` | doc comment ("raised-cosine crest fading to base ink outside the band") |
| R-11 | `renderTagline` settled form | wrapped in `- … -` (dashes hug content); contains the tagline text | explorer signature note ("wrapped in \"- … -\"") + README (placeholder `- model · system prompt -`) |
| R-12 | `renderTagline` fallbacks | returns settled line immediately when: no active reveal; 256-color theme; tagline carries escapes; tagline contains surrogate pairs; tagline shorter than `TAGLINE_PLACEHOLDER` | doc comment (all five conditions listed) |
| R-13 | mid-reveal width | during the reveal the row holds the placeholder's width until the wipe outgrows it, then widens toward the finished tagline: `visibleLength(renderTagline(...))` is between placeholder+2 and tagline+2 (the `- -` wrap) | doc comment |

## splash.ts

| # | Symbol | Claim | Source |
|---|--------|-------|--------|
| S-01 | constants | `SWATCH_CELL === "▀"`, `SPLASH_MARGIN_X === 3`, `LOGO_GAP === 4`, `PANEL_PADDING_X === 2`, `PANEL_MAX_WIDTH === 72`, `PANEL_MIN_WIDTH === 34`, `PANEL_MARGIN_Y === 1`, `MAX_SPLASH_ROW_SHARE === 0.6` | exported literals + README (60%) |
| S-02 | `buildLabeledWrappedSection` | heading row (`[label]`) then items comma-wrapped beneath, every line `<= width` visible columns | doc comment + T-05 |
| S-03 | `buildCountsLine` | contains `[context] N`, `[skills] M` and `[extensions] K` with the actual counts, `·`-joined in that order; `<= width` | doc comment (amended 2026-08-01: context added, was `[skills] 22 · [extensions] 33`) |
| S-04 | `buildPanelLines` | interior lines `<= innerWidth`; includes pi version (`pi v${VERSION}` — VERSION imported from pi-coding-agent as oracle); model rendered when given; body included | doc comment ("pi version as a titled rule, active model as centered tagline, then body") |
| S-05 | `paintPanelRow`/`paintRow`/`paintSplash` | each row paints **exactly** `width` visible columns (full-bleed swatch) | W + doc ("full-bleed"), `SWATCH_CELL` doc (every cell carries two samples) |
| S-06 | `buildHeader` | every line exactly `width` visible columns, for all width 1..200 × termRows × item sets | W + "full-bleed rainbow swatch" README |
| S-07 | `buildHeader` collapse | when panel would exceed `MAX_SPLASH_ROW_SHARE` of termRows **or** the longest context/skill/extension name would not fit → the lists collapse to one counts line; otherwise names appear inline, context section first | README; amended 2026-07-29 (F-16: the `state.skillsExtensionsListed` half was dropped with the flag — the branch is now asserted on rendered output); amended 2026-08-01 (context participates in the fit check and comes first) |
| S-08 | `buildHeader` stacking | terminals too narrow for logo+gap+min-panel side by side → panel stacks **under** the logo | `PANEL_MIN_WIDTH` doc ("Narrower than this and the panel drops below the logo") + buildHeader doc |
| S-09 | `buildHeader` shadow row | every layout keeps a spare row below the logo for the drop shadow | buildHeader doc; amended 2026-07-28 (slop-audit F-13: previously uncovered — glyph-row-span assertions added for both layouts) |
| S-10 | `stampLogo` | writes logo + shadow into the ink map within bounds `width×height`; shadow offset `LOGO_SHADOW_OFFSET` down-right; ink colors are `LOGO_INK`/`LOGO_SHADOW` | doc comment |
| S-11 | `paintRow`/`paintSplash`/`buildHeader` sampler | an optional trailing `SwatchSampler`/`BackgroundColor` parameter drives the backdrop in place of the rainbow default; existing call sites without it are unaffected; every mode stays exact-width per S-06 | plan step 5 |

## extensions.ts

| # | Symbol | Claim | Source |
|---|--------|-------|--------|
| E-01 | `discoverLoadedExtensions` agent dir | auto-discovery of `<agentDir>/extensions/`: a directory's package.json `pi.extensions` entries (paths that exist, resolved against the dir) win over `index.ts`/`index.js`; single `.ts`/`.js` files are extensions; a dir with no entry is **not** reported; dotfiles and `node_modules` skipped; `.gitignore`/`.ignore`/`.fdignore` honored with `!` negation and dir patterns | collaborator `collectAutoExtensionEntries`/`resolveExtensionEntries`/`addIgnoreRules` in package-manager.js (ported verbatim) |
| E-02 | `discoverLoadedExtensions` settings overrides | settings `extensions` entries: `-<path>` force-excludes an auto-discovered entry (exact match vs the base-relative/absolute/basename path); `+<path>` force-includes through `!` glob excludes; plain entries load specific files/globs; project `.pi/settings.json` entries apply to project discovery, agent settings to user | collaborator `isEnabledByOverrides`/`applyPatterns`/`matchesAnyExactPattern`/`resolveLocalEntries` |
| E-03 | `discoverLoadedExtensions` npm packages | only settings `packages` entries are loaded (`npm:` spec → `<baseDir>/npm/node_modules/<name>`; `<baseDir>` = agent dir for user scope, `.pi/` for project); the npm manifest's `dependencies` are **not** consulted; a package's `pi.extensions` list may name files or dirs (dirs expand via auto-discovery); packages not installed are skipped | collaborator `resolvePackageSources`/`collectPackageResources`/`addManifestEntries`/`collectFilesFromManifestEntries` + `getNpmInstallPath`; observed behavior: `@juicesharp/rpiv-*` were direct deps of `<agentDir>/npm/package.json` but absent from pi's `[Extensions]` (settings `packages` listed only 5) |
| E-04 | `discoverLoadedExtensions` local packages | a settings `packages` entry that is a path resolves against `<baseDir>` (agent dir / `.pi`); a file is the extension, a dir is a package (manifest → convention `extensions/` dir → the dir itself) | collaborator `resolveLocalExtensionSource`/`collectPackageResources` |
| E-05 | `discoverLoadedExtensions` project scope | project `.pi/extensions/` and project settings apply only when the project is trusted | collaborator `addAutoDiscoveredResources` + `assertProjectTrustedForScope` |
| E-06 | `discoverLoadedExtensions` CLI | `--extension`/`-e` sources are always loaded (temporary scope) and are the **only** sources under `--no-extensions`; `<inline:…>` sources are pi's hidden built-ins and never listed | collaborator `resolveExtensionSources` + `extension.hidden` filter in the startup listing; `<inline:llama.cpp>` observed hidden in the collaborator's `builtInExtensions` |
| E-07 | `getExtensionLabels` | pi's compact labels: package sources (npm:/git:) → package name + entry path relative to the package root, `extensions/` prefix stripped, `index.*` at package root → bare name (`pkg:src`, `pkg:atlassian.ts`, `pkg`); non-package sources → shortest unique suffix of the `~`-shortened path with trailing `index.ts`/`index.js` stripped; sorted + deduped | collaborator `getCompactExtensionLabels`/`getShortPath`/`getCompactNonPackageExtensionLabel` in interactive-mode.js (ported verbatim); verified 18/18 against a live pi 0.83.0 resolve() on 2026-08-01 |
| E-08 | canonical dedupe | two discovered paths that `realpath` to the same file collapse to one entry; precedence when they disagree: project local < project auto < user local < user auto < package; a disabled entry shadows a lower-precedence enabled one for the same file | collaborator `mapToResolved` (canonicalizePath dedupe) + `resourcePrecedenceRank` |
| E-09 | `cliExtensionArgs` | parses this process's argv: `--no-extensions` flag; explicit `--extension`/`-e` values (space and `=` forms — `=` form per common CLI convention, mark `=`-form INFERRED) | doc comment; re-exported from discovery.ts |
| E-10 | `discoverLoadedExtensions` package entry filters | the object form of a settings `packages` entry (`{source, autoload?, extensions?}`) filters what that package loads: `extensions` patterns select from the package's manifest files (`[]` disables all, `-<entry>`/`!<glob>` exclude, `+<entry>` force-includes), an absent `extensions` key loads the package's defaults; under `autoload: false` the entry is a **delta** — only files a pattern names change state — and a project-scope delta resolves its files from the same package's user-scope install. Package identity for dedupe is version-agnostic (`npm:<name>`, `git:<host>/<path>`, resolved local path): a project entry replaces a user entry for the same identity, except an `autoload: false` delta, which keeps both (delta first). pi's compact label still shows the source spec verbatim, so `npm:pkg@2.0.0` labels as `pkg@2.0.0:…` | collaborator `resolvePackageSources` (`filter`)/`collectPackageResources`/`applyPackageFilter`/`applyPackageDeltaFilter`/`applyAutoloadDisabledPatterns`/`collectManifestFiles`/`collectDefaultResources`/`dedupePackages`/`findAutoloadDeltaBase`/`getPackageIdentity`; added 2026-08-01 (F-8) |

## discovery.ts

| # | Symbol | Claim | Source |
|---|--------|-------|--------|
| D-02 | `cliExtensionArgs` | see E-09 (re-exported) | — |
| D-07 | `getLoadedHeaderItems` | skills: commands with `source === "skill"` (pi names them `skill:<name>`), normalized; extensions: `getLoadedExtensionLabels(cwd, agentDir, projectTrusted)` — pi's own discovery (E-01..E-06) and labels (E-07), **not** derived from commands/tools; context: `getLoadedContextFiles(cwd)` (D-09) | doc comment; amended 2026-08-01 (context added, cwd param); amended 2026-08-01 (extensions rewritten to mirror pi's package manager — the previous command/tool/filesystem union over-reported: it listed all npm-manifest dependencies, disabled extensions and hidden `<inline:…>` built-ins, and mislabeled package entries) |
| D-09 | `getLoadedContextFiles` | the context sources pi loads for `cwd` — system-prompt sources (D-14) then the AGENTS.md/CLAUDE.md files from the agent dir and every ancestor of cwd — via the collaborator's own `loadProjectContextFiles`; display per D-11; order mirrors the collaborator's /loaded Context section (system prompt source, append sources, then agents files: global first, outermost to innermost); `--no-context-files`/`-nc` → `[]` | doc comment + collaborator `loadProjectContextFiles` (agent dir first, then root→cwd ancestors) + `--no-context-files` help text ("Disable AGENTS.md and CLAUDE.md discovery and loading") + collaborator /loaded `contextFiles` assembly |
| D-10 | `cliContextFilesDisabled` | false by default; true when argv contains `--no-context-files` or `-nc` | mirrors D-02 pattern; collaborator CLI help |
| D-11 | `formatContextPath` | path inside cwd → cwd-relative; a parent/outside path is NOT relative (".." does not count, mirroring collaborator `getCwdRelativePath`); under home → `~`-shortened; else absolute | collaborator `formatContextPath`/`getCwdRelativePath`/`formatDisplayPath` in interactive-mode |
| D-12 | `cliSystemPromptSources` | parses `--system-prompt` (single) and `--append-system-prompt` (repeatable) in space and `=` forms; both absent → `{ undefined, [] }` | doc comment + collaborator CLI args (`--system-prompt <text>`, `--append-system-prompt <text>`, repeatable) |
| D-13 | `discoverSystemPromptFile`/`discoverAppendSystemPromptFile` | project `<cwd>/.pi/SYSTEM.md` (resp. APPEND_SYSTEM.md) when the project is trusted and the file exists, else the agent dir file; undefined when neither exists | collaborator `discoverSystemPromptFile`/`discoverAppendSystemPromptFile` in resource-loader |
| D-14 | `getSystemPromptSources` | system prompt source then append sources: CLI value when given and it names an existing file, else the discovered file; CLI append sources replace discovery entirely (per collaborator `if (!appendSources)`); non-existent values dropped | collaborator `getSystemPromptSource`/`getAppendSystemPromptSources` (path set only for existing files) + `reload()` source selection |

## relaunch.ts

| # | Symbol | Claim | Source |
|---|--------|-------|--------|
| X-01 | constants | `GATE_DONE_ENV === "PI_SPLASH_GATE_DONE"` | exported literals + README; amended 2026-07-28 (the `SKIP_GATE_FLAG` clause dropped with the `--skip-splash-gate` flag — `/topping-splash-settings` is the only toggle); amended (`/topping-splash menuGate:on\|off` replaced by the `/topping-splash-settings` menu) |
| X-02 | `buildRelaunchArgs` strip | conflicting flags stripped: `--session`, `-r`/`--resume`, `-c`/`--continue`, `--model`, `--provider`, `--session-dir`, `--models`, `--thinking` (list INFERRED from README "conflicting flags... stripped and replaced by the gate's choices" + pi's own CLI vocabulary; value-carrying flags consume their value in `--flag value` form; `--flag=value` single-token form also removed) | README + relaunch.ts module comment; per-flag rows INFERRED |
| X-03 | `buildRelaunchArgs` preserve | unrelated args preserved **in order** — explicitly `--skill`, `--extension`, `--no-skills`, `--no-extensions` (with values) | README (names all four) + doc comment |
| X-04 | `buildRelaunchArgs` overrides | gate choices appended: `--session <path>` when `overrides.session`; model override as provider/id (`--model provider/id` — shape INFERRED from README "relaunches Pi with --session <path>" + `--models` strip; exact model arg shape recorded in gap pass if different); `--thinking <level>` when set | README + `RelaunchOverrides` docs |
| X-05 | `relaunchPi` guard | when `process.argv[1]` is missing/empty: does **not** stop the TUI, does not spawn, does not shut down; notifies an error (structural fact from moa-plan scan; treated as the only safely-testable branch) | structural scan (documented in plan §4.9) |
| X-06 | `relaunchPi` env | child gets `GATE_DONE_ENV=1` so the gate never re-triggers | doc comment + README — **not tested** (would require reaching spawn); verified indirectly by X-05 + index gating tests |

## model-picker.ts

| # | Symbol | Claim | Source |
|---|--------|-------|--------|
| M-01 | constants | `THINKING_LEVELS === ["off","minimal","low","medium","high","xhigh","max"]`; `COMMON_THINKING_LEVELS === ["off","low","medium","high"]` | exported literals; amended 2026-07-28 (slop-audit finding 5: the `THINKING_LEVEL_SET` clause was a tautology — the set is built from `THINKING_LEVELS` one line above in source; membership is still exercised behaviorally via `isThinkingLevel` in M-02) |
| M-02 | `isThinkingLevel` | true exactly for the seven levels; false for anything else (junk, "", case variants) | signature + M-01 |
| M-03 | `modelRefLabel` | UNSPECIFIED exact format; must contain both provider and id (it's "the label the picker displays" and models are provider/id pairs) | availableModelRefs doc |
| M-04 | `availableModelRefs` | every registry model as provider/id pair, sorted by display label | doc comment |
| M-05 | `thinkingOptionsForModel` | normalizes offered levels into `THINKING_LEVELS` order regardless of arrival order; `undefined`/empty registry knowledge → `COMMON_THINKING_LEVELS` | doc comments (incl. COMMON doc "Offered when the registry does not advertise") |
| M-06 | `defaultThinkingForModel` | current level when offered; else `medium`; ("or a sensible middle" — `medium` per README "preselecting the session's current level, or medium when the model does not offer it"); if `medium` itself not offered → UNSPECIFIED (assert: result ∈ options) | README + doc |
| M-07 | `TwoPaneModelThinking.handleInput` | Tab cycles Models → Thinking → buttons (→ Models); `←`/`→` switch panes; typing always narrows the model filter (and re-targets... typing "always narrows the **model** filter" — even from other panes); Backspace edits filter; Esc → returns "back" directly (does not clear filter first); Enter on Select/selection → "confirm"; Cancel button → "back" | README model-selection bullets + class doc |
| M-08 | key encodings | esc=`"\x1b"`, tab=`"\t"`, enter=`"\r"`, backspace=`"\x7f"`, arrows=`"\x1b[A"/"\x1b[B"/"\x1b[C"/"\x1b[D"` | collaborator pi-tui `matchesKey` |
| M-09 | `getSelected` | valid `{ref, thinking}` after "confirm": ref matches the highlighted model, thinking the highlighted level | doc ("Only valid after handleInput returns confirm") — pre-confirm behavior UNSPECIFIED, not tested |
| M-10 | `render(bodyWidth)` | rows **exactly** `bodyWidth` columns: left pane + 1-column divider + right pane | doc comment |
| M-11 | `renderFooter` | rule, right-aligned Select/Cancel buttons, rule, keyboard hints; rows `<= bodyWidth` (alignment promise: right-aligned ⇒ exact-width rule lines plausible but UNSPECIFIED; assert `<=` and rule rows `===`) | doc comment |
| M-12 | fuzzy filter | typing filters models: whitespace/slash tokens, literal substring matches ranked first (delegates G-03) | README |

## header.ts

| # | Symbol | Claim | Source |
|---|--------|-------|--------|
| H-01 | `withSettings` | runs fn with a SettingsManager for cwd; **swallows** errors (console silence to protect TUI) | doc comment |
| H-02 | `ensureQuietStartup` | idempotent per process (`state.quietStartupEnsured` guard — one settings write per process); enables `quietStartup` in settings; returns whether this call did the work → first call true, second false (return meaning INFERRED from name+guard doc; verify semantics in gap pass if test fails) | state.ts doc ("guards the settings write so it only runs once per process") + README ("sets quietStartup: true on first load") |
| H-03 | `ensureQuietStartup` persistence | after the call, `SettingsManager.create(cwd).getQuietStartup() === true`, persisted under the temp agent dir | README + collaborator SettingsManager API |
| H-04 | `installHeader` | replaces the header via `ctx.ui.setHeader`; wires `headerRenderState.{invalidate,requestRender,forceRedraw}` (forceRedraw clears screen+scrollback then repaints → requests a **forced** render); populates `state.loadedSkills/loadedExtensions/systemPromptSize`; starts the tagline reveal | state.ts doc + README ("replaces the default startup header") + headerRenderState docs; amended 2026-08-07 (the reveal starts only when the `taglineReveal` preference is on — off leaves the ticker unstarted, so the tagline settles on the first frame, see I-15) |
| H-05 | header component render | full-bleed splash lines exactly `width` columns (delegates S-06); re-render after a model change reflects the new model (commit 1a88a1c "re-render header on model selection change") | W + commit log |
| H-06 | `installHeader` background seeding | reads `readPreferences().backgroundColor` once and assigns it to `state.backgroundColor` before installing the header; the render cache key includes `state.backgroundColor`, and `invalidate()` resets it, so a later state change is not served from stale cached lines | plan steps 4, 6 |

## gate.ts

| # | Symbol | Claim | Source |
|---|--------|-------|--------|
| GA-01 | `sessionPreview` | session `name` wins when present; `<skill name="x" location="y">…envelope…` reduced to the invocation (`/x`); remaining markup flattened; `"(no messages)"` sentinel → `"(untitled session)"`; ANSI sanitized; whitespace collapsed | commit 8329d39 body + doc comment |
| GA-02 | `sessionPreview` empty | UNSPECIFIED: truly empty firstMessage → explorer noted "(empty session)"; assert only non-empty human-readable output, record literal in gap pass | — |
| GA-03 | `formatSessionDate` | `YYYY-MM-DD HH:MM` (zero-padded, local time); `undefined`/Invalid Date → `""` | doc comment |
| GA-04 | menu layout | items in order: New session, Resume, Model, Skills and Extensions, Theme, Quit; hotkeys n/r/m/s/t/q **jump and activate**; ↑↓ move with clamping (UNSPECIFIED wrap vs clamp — assert selection stays in range and reaches both ends); Enter activates | README (menu table + navigation line) |
| GA-05 | Esc on menu | resolves gate as "proceed" (same as New session) | README |
| GA-06 | Quit | resolves "quit" | README |
| GA-07 | ~~`skillsInline`~~ | ~~when true, the Skills and Extensions row is hidden (redundant with splash listing) and its hotkey inert~~ **withdrawn 2026-07-29 (F-16): the flag was always false in production, so the row is now always shown** | — |
| GA-08 | `render(width)` | menu lines `<= width` for widths 1..200; terminals `<= SHORT_TERMINAL_ROWS` rows drop the spacer above the menu | W + SHORT_TERMINAL_ROWS doc |
| GA-09 | drill-in popup | opens overlay via `tui.showOverlay` lazily on first drill-in; hidden (`setHidden(true)`) not destroyed when returning to menu; **rebuilt** (hide + new showOverlay) when the next view needs a different width (resume=100% vs others=fixed) | popupHandle/popupWidth doc comments + commit 8329d39 body ("switching views now rebuilds the overlay when the requested width differs") |
| GA-10 | theme view | list from `ctx.ui.getAllThemes()`; moving selection live-previews via `setTheme(Theme instance)` (in-memory only); Enter persists via `setTheme(name string)` and returns to menu; Esc restores the theme active when the popup opened (only if a preview happened); preview skipped when opened on unnamed theme | README + previewTheme doc comment |
| GA-11 | skills/extensions view | two panes (skills left, extensions right) from `state.loadedSkills/loadedExtensions`; independent cursor+filter per pane preserved across switches; `←→`/Tab switch panes; typing fuzzy-filters active pane; Backspace edits; **Esc clears the filter first, then backs out** (two-stage); nothing selectable | README (gate table) + inventory doc comment |
| GA-12 | model view | picker from `availableModelRefs` + current thinking from `pi.getThinkingLevel()`; confirm → `pi.setModel(model)` then `pi.setThinkingLevel(level)`, refreshes header, back to menu; `setModel` refused (resolves false) → error notification, picker **stays open**; choices carried onto later Resume relaunch (`selectedModel`/`selectedThinking` docs) | README model-selection + applySelection doc |
| GA-13 | resume view | scrollable list of `SessionManager.list(cwd)` sessions; fixed metadata columns (right-aligned message count, `YYYY-MM-DD HH:MM` date) reserved **before** preview layout; columns shed entirely (not stub-truncated) when narrow; full terminal width | README + commit 8329d39 body |
| GA-14 | `runStartupGate` | installs the gate below the splash via `ctx.ui.custom`; resolves "proceed"/"quit" from the component; relaunch never resolves; footer suppressed during the gate and restored after (structural: setFooter(...) then setFooter(undefined) in finally — INFERRED from moa-plan scan) | doc comment + scan |
| GA-15 | popup box chrome | drill-in bodies rendered through `renderPopupBox` → G-05 width guarantees apply at every width | README ("bordered popup") + G-05 |

## index.ts

| # | Symbol | Claim | Source |
|---|--------|-------|--------|
| I-01 | registration | default export registers **no** CLI flags; command `topping-splash-settings`; handlers for `model_select`, `before_agent_start`, `session_start`; command requires TUI mode (`ctx.mode !== "tui"` notifies an error and returns without opening the menu) | README (Commands, Troubleshooting) + explorer signature scan; amended 2026-07-28 (`--skip-splash-gate` removed — the slash command is the only toggle); amended (`/topping-splash` replaced by `/topping-splash-settings`, a TUI settings menu; the old option-argument command is gone) |
| I-02 | gate conditions | gate shown **only** when: TUI mode with UI (`--no-tui` disables), `session_start` reason `=== "startup"` (not reload/new/resume/…), `PI_SPLASH_GATE_DONE !== "1"`. Each condition alone suppresses the gate | README (Troubleshooting) |
| I-03 | splash on startup | on a genuine startup the custom header is installed (splash visible) before/with the gate | README ("On first launch the splash header appears, followed by the startup gate menu") |
| I-04 | quit path | choosing Quit in the gate → clean shutdown (`ctx.shutdown()`) | README ("shuts Pi down cleanly") |
| I-05 | proceed path | New session/Esc → gate dismissed, normal TUI continues (no shutdown) | README |
| I-06 | `/topping-splash-settings` apply | opening the settings menu shows the "Startup gate menu" and "Model + prompt size reveal animation" toggles seeded from `readPreferences()`; toggling and applying (Enter) persists both values in one write and notifies success; an untouched toggle keeps its stored value; no header/settings side effects (both preferences are read at startup); a failed preference write notifies an error, never success | README Commands; amended 2026-07-28 (slop-audit F-11: failure path added); amended (`menuGate:on\|off` argument replaced by the settings-menu toggle); amended 2026-08-07 (second toggle `taglineReveal` added; `readMenuGate`/`writeMenuGate` became `readPreferences`/`writePreferences` — one atomic write for the whole menu) |
| I-07 | `/topping-splash-settings` cancel | Escape (or Ctrl+C) cancels the menu: no write, no success notification, preference unchanged | README Commands; amended (replaces the unrecognized-argument case, which no longer applies — the command takes no arguments) |
| I-08 | `model_select` | re-renders the header on model selection change (header refresh via headerRenderState); a throwing `getSystemPrompt` must not crash the handler (system prompt size is best-effort display data) — crash-safety INFERRED: display-only feature must not break the host | commit 1a88a1c + e1f3fda/a11f7ee intent |
| I-09 | `before_agent_start` | system prompt size (bytes of `event.systemPrompt`) reflected in state/header | commit e1f3fda/a11f7ee ("display system prompt size as estimated token count") + splash panel README |
| I-10 | quietStartup write | happens on first `session_start` (once per process — `state.quietStartupEnsured`) | README ("sets quietStartup: true on first load") + state doc |
| I-11 | splash-only mode | the persisted `menuGate:off` on a genuine TUI startup → splash header installed, **no** gate component mounted, handler resolves without shutdown; header callbacks stay wired so the model/prompt-size line keeps refreshing. The slash command is the only activator — no CLI flag, no env var | README ("Splash without the gate menu") |
| I-12 | splash-only precedence | `PI_SPLASH_GATE_DONE=1` (the internal relaunch guard) wins over the mode: no gate **and** no splash. Non-`startup` reasons and non-TUI still suppress everything | README ("Splash without the gate menu") + I-02 |
| I-14 | menuGate persistence | the choice is stored in `pi-topping-splash.json` under the agent dir and re-read on every `session_start`: `off` suppresses the gate (splash kept) on all later launches; `on` (also the default when the file is missing or corrupt) restores it. The quietStartup write is unaffected either way. The `/topping-splash-settings` menu is the only surface that writes this file | README (Commands, Splash without the gate menu); amended 2026-08-07 (the file now carries both `menuGate` and `taglineReveal`; each key independently defaults to `on` when missing or unrecognized) |
| I-15 | taglineReveal preference | `taglineReveal:off` on a genuine TUI startup installs the splash (and the gate, when on) but never starts the reveal ticker — the model · prompt-size tagline renders settled from the first frame (`revealPos()` stays `undefined`, R-03/R-12). Default (missing file/key, corrupt file) is `on`: the reveal runs. The `/topping-splash-settings` menu is the only writer | README Settings; added 2026-08-07 |
| I-16 | `backgroundColor` preference | menu item cycles `BACKGROUND_COLOR_OPTIONS` with left/right, seeded from `readPreferences().backgroundColor`; applying persists it in the same atomic write as the two toggles, then sets `state.backgroundColor`, calls `headerRenderState.invalidate?.()` and `headerRenderState.requestRender?.()` so a visible splash updates immediately — but only after a successful write; a failed write or a cancelled menu leaves `state.backgroundColor` and the persisted value unchanged. Missing/corrupt/unrecognized values default to `"rainbow"` | plan steps 3, 7 |

## Deliberately not tested

| What | Why |
|------|-----|
| Actual `spawnSync` relaunch (X-06 child env, in-place exec) | would re-execute the test file over the terminal (`stdio: "inherit"`); guarded to never reach spawn |
| Visual appearance (colors look right, shimmer aesthetics) | requires human/screenshot verification (see project memory: tmux → ANSI→HTML pipeline); tests cover geometry + escape structure only |
| `theme.bold`/chalk styling passthrough | chalk's level depends on TTY detection under the test runner; asserting escape bytes would be environment-dependent |
| pi-tui internals (`fuzzyFilter` scoring, `visibleWidth` correctness, SelectList rendering details) | collaborators, not code under test |
| Live tmux/pi integration (real startup, event-loop blocks) | out of scope for unit suite; covered by the manual pipeline in project memory |

## Findings (report-don't-reconcile: F-3 is an `it.todo` test — failures reported, suite exit stays green)

| # | Where | Divergence | Judgment |
|---|-------|-----------|----------|
| F-1 | `wrapCommaDelimited([])` | ~~doc promises `[""]`, code returns `[]`~~ fixed: the doc comment now says `[]` and the test asserts the actual behavior | resolved (was a stale doc; callers short-circuit empty lists — splash renders `none`) |
| F-2 | `fitCell(text, width < 3)` | ~~emits the full 3-col ellipsis, exceeding the requested width~~ fixed: below the ellipsis width `fitCell` truncates without it, still closing the fg span; T-15 now asserts the bound | resolved (2026-08-13) |
| F-3 | `renderPopupBox` widths 1–4 | doc promises exactly-`width` lines; chrome minimum is 5 cols | edge bug; unreachable at sane terminal sizes |
| F-4 | `renderTagline` + SGR tagline | doc lists escape-carrying taglines as a settled-fallback; code sanitizes and reveals instead | doc imprecision — the safety purpose (never split escapes) holds via stripping |
| F-5 | splash section headings | ~~README writes `[skills]`; full-list headings render the bare label (brackets only on the counts line)~~ fixed: `buildHeader` now passes `[skills] N`/`[extensions] N` as the label, so the count stays visible in the full-list view too | resolved |
| F-6 | `renderFooter` bodyWidth < ~26 | ~~Select/Cancel row is never truncated below its natural width~~ fixed: the button and hints rows are clamped with `truncateToWidth`; M-11 now asserts bodyWidth 20 | resolved (2026-08-13) |
| F-7 | `discoverExtensionNamesFromFilesystem` | a dir without any entry file is still reported (`bare-dir`) | resolved (2026-08-01): the discovery rewrite (E-01..E-09) mirrors pi's package manager, which skips entry-less dirs — now asserted by the E-01 test; the old over-reporting was part of the mismatch that showed 34 extensions vs pi's 18 |
| F-8 | `discoverLoadedExtensions` | the object form of a settings `packages` entry was reduced to its `source` string, dropping the per-package `extensions`/`autoload` filter — every extension of a package disabled that way was still listed (observed: 8 `@juicesharp/rpiv-*` entries, splash 27 vs pi's 19) | resolved (2026-08-01): filters, `autoload: false` deltas and identity dedupe ported (E-10); re-verified against the live agent dir — splash and pi both list the same 19 |
| F-8 | gate-skip launches | ~~README implies the splash persists on all future launches; env/flag-skipped sessions deliberately start with no header (source comment says so)~~ fixed: the troubleshooting bullet now says both the splash and the gate are skipped under `PI_SPLASH_GATE_DONE=1` | resolved (2026-07-28 slop audit; the "flag" half of the old wording left with `--skip-splash-gate`) |
| F-9 | `panelBg` doc | ~~says "WCAG relative luminance"; code uses Rec.601 luma coefficients~~ fixed: the `PANEL_LUMINANCE_THRESHOLD` comment now says Rec.601 luma (the coefficients are the right choice for perceived plate brightness — the doc was wrong, not the code) | resolved (2026-07-29) |
| F-10 | `package.json` `files` | `pi.image` declares `./media/pi-splash.png` but no `files` glob shipped `media/` — the published tarball would lack the declared asset | resolved (2026-07-28 slop audit: `media/` added to `files`; inert in host 0.82.1, which never reads `pi.image`) |
| F-11 | `/topping-splash menuGate:*` (now `/topping-splash-settings`) | `writeMenuGate` swallowed write failures while the command handler notified success unconditionally — a failed write was reported as persisted | resolved (2026-07-28 slop audit: `writeMenuGate` returns a boolean, mirroring `ensureQuietStartup`; failure now notifies an error, covered by an I-06/I-07 test); command surface amended to the settings menu, same failure contract |
| F-12 | contract T-13 | promised a shape + monotonicity sweep for rounding boundaries; the suite only exercised exact-token inputs (byte counts divisible by 4) | resolved (2026-07-28 slop audit: sweep added) |
| F-13 | contract S-09 | the spare-shadow-row claim had zero coverage — a shadow-clipping regression would pass silently | resolved (2026-07-28 slop audit: glyph-row-span assertions added for side-by-side and stacked layouts) |
| F-14 | README 256-color bullet | claimed the backdrop "falls back gracefully"; only the shimmer (`sgrChannels` → null) and panel plate degrade — the backdrop emits truecolor SGR unconditionally | resolved (2026-07-28 slop audit: README scopes the fallback to shimmer/panel and leaves the backdrop to the terminal) |
| F-15 | README `--verbose` bullet | named a literal `[Extensions]` heading with no static match in the pinned host's dist | resolved (2026-07-28 slop audit: softened to "a section listing every extension that loaded") |
| F-16 | `StartupGate` `skillsInline` | the "hide the redundant drill-in row" path was **unreachable**: `index.ts` calls `installHeader()` then `forceRedraw()` (which defers `doRender` to `process.nextTick`), then `runStartupGate()` — with no `await` between, and `showExtensionCustom` invoking the component factory *synchronously* inside its Promise executor. So `state.skillsExtensionsListed` was read in the same tick it was initialized, always `false` | resolved (2026-07-29 audit re-evaluation: `skillsInline`, `activeMenu()`, the state flag and its `splash.ts` assignment deleted; the drill-in offers filtering and scrolling the inline list does not, so always showing it is also the better behavior) |

Gap-pass amendments (observed-tagged tests, body-derived after the contract freeze):
`normalizeSkillName` strips a `skill:` prefix; `uniqueSorted` drops falsy entries and
sanitizes ANSI; the `fuzzyRanked` substring partition is case-insensitive; a throwing
`getAllThemes` is survivable. Observed-only literals (not asserted): `formatPromptSize`
non-finite → `"unknown"`; empty `sessionPreview` → `"(empty session)"`;
`defaultThinkingForModel([], …)` → `"medium"`; `pickFitting([], …)` throws.

## Timer decision

`t.mock.timers.enable({ apis: ["setInterval", "Date"] })` — smoke-tested: the mocked
interval object tolerates `.unref()`, the mocked `Date.now` drives `lastTickAt`, and
`tick(600)` already exhibited the capped hold decrement (500 → 460, not 500 → 0),
consistent with R-05. All reveal tests use mock.timers; normal cadence is simulated by
looping `tick(REVEAL_TICK_MS)`, an event-loop block by one large `tick(2000)`.
