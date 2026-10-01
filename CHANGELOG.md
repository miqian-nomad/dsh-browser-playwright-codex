# Changelog

Bilingual by intent: the version headings and the summary of each release are given in both
languages, the individual entries follow the language the surrounding code and docs use.

一句话摘要：**把 GitHub 上独有的文档/补丁/分析脚本收回本仓库，并把 `lib/` 正式入库** ——
同时修掉一个会让"全绿"变"全红"的测试缺陷：测试与验收会去读设置页那份真实用户状态，
用户把「页面识别方式」拨到智能模式后，同一份未改动的代码会整片假失败。

## 0.4.1

Adopted as the single canonical tree for this repository: the assets that only existed on the
GitHub side (docs, patches, analysis scripts, license/notice) are now here, `lib/` is committed
because this repository is the distribution channel, and the tests/verify no longer read the real
user settings file.

### Added

- **`patches/`** — `upstream-window-activation.patch` plus its README: the minimized-window
  focus-stealing fix as a patch against upstream, so the diagnosis is reusable outside this fork.
- **`scripts/analysis/`** — four probes (`repro-minimize`, `hl-compare`, `live-handoff-probe`,
  `needs-human-probe`) used to produce the measured claims in `FOCUS-STEALING.md` and
  `MODE-TRADE-OFFS.md`.
- **Docs** — `FOCUS-STEALING.md`, `MODE-TRADE-OFFS.md`, `PLUGIN-README.md`, `中文说明.md`,
  `对比与优势.md`; **`LICENSE-DOCS`** and **`NOTICE.md`** (the docs' license and the provenance
  statement). They sit at the repository root, next to the docs this tree already had, and their
  cross-links were rewritten for that move.
- **`scripts/check-doc-links.py`** — dependency-free checker for every relative markdown link
  (21 checked, 0 broken as of this release). It exists because moving a doc silently breaks
  `../` links; run it after touching docs.

### Changed

- **`lib/` is committed again** (`.gitignore` now ignores only `lib/*.bak-*`). Reason: this
  repository *is* the distribution channel — `dsh plugin add github:…` clones it, and a clone with
  no build output has no `main` to load.
- **The `prepare` hook is gone** from `package.json#scripts`. pnpm 11 refuses to run a git
  dependency's build scripts (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`), so keeping `prepare`
  guarantees a one-command install fails on a clean machine. `npm run build` stays.
- **`lib/` was rebuilt from this tree's `src/`**, not taken from the GitHub side's older artifacts.
- The three docs that exist on both sides (`codex-rules.md`, `DIALOG-POLICY.md`,
  `SNAPSHOT-RULES.md`) keep **this tree's** version: it already carries the `-codex` name and the
  corrected paths, while the GitHub copies still said `dsh-browser-playwright`.

### Fixed

- **Tests and the acceptance script no longer read the real user settings file**
  (`~/.dsh/dsh-browser-playwright.state.json`). Their expectations are written against the
  `legacy` engine, so a user who picks 智能模式 (aria) on the settings page turned the suite red
  while the code was untouched — measured 2026-10-01: reading the real state = 10 failures;
  isolated = 0 failures. Both now point `DSH_BROWSER_STATE_FILE` at a non-existent temp path, the
  override `src/runtime-state.ts` already provides for exactly this.
- **The README install command actually works now.** It said
  `dsh plugin --profile <name> add dsh-browser-playwright-codex`, but this package is not on npm
  (registry returns 404), so that one-liner could never have installed anything. It now shows the
  GitHub specifier this repository is actually distributed by, plus the `link:` form for a local
  checkout, and states that a fresh clone needs no build. The dsh.so install-verification badge is
  back at the top of the README, pointing at [the artifact page](https://www.dsh.so/zh/artifact/dsh-browser-playwright-codex/)
  (its recorded verification is still the older `v0.3.1`, so the badge does not claim 0.4.1).

### Notes

- Local verification output (`test_*.txt`, `*_alone.txt`, `verify_clean.txt`) is now gitignored:
  it is scratch from a run, not repository content.

## 0.4.0

Renamed to `dsh-browser-playwright-codex`, localized (Chinese plugin metadata), and given an
opt-in accessibility-tree snapshot engine plus incremental snapshot diffs — including the first
version's real defect, found, fixed, and guarded.

### Changed

- **Package renamed** `dsh-browser-playwright` → `dsh-browser-playwright-codex`. A rename is a
  cross-file operation, so everything that carries the name moved with it: the three `name:`
  specifiers in this package's `cordis.patch.yml`, the `dsh-browser-toggle` host import
  (`…/runtime-state`) together with its `node_modules` link, and the profile link. Miss any one and
  the plugin stops loading with `MODULE_NOT_FOUND` — measured: the old specifier no longer resolves
  in either profile while the new one does.
- **The persisted switch file keeps its pre-rename name** (`~/.dsh/dsh-browser-playwright.state.json`)
  on purpose: it is user state, and renaming it would silently reset the Settings toggle.

### Added

- **A settings-page switch for how pages are read** (`dsh-browser-toggle` card, right under
  the existing on/off switch): 兼容模式 (the plugin's own DOM walk) ↔ 智能模式 (the browser's
  official accessibility tree). It is persisted next to the enable flag and applies from the
  next operation — no restart, no config edit. The card shows the mode actually in effect and
  whether it is the user's pick or the deployment default, and the choice is rendered as radio
  rows (the pattern the search-provider card uses for a pick-one setting) rather than a switch.
- **Plugin metadata localization** (`locale/en.json`, `locale/zh.json`), plus the
  `"./locale/*.json"` export and a `locale` entry in `files` — without the export the harness'
  `require.resolve` fails and the metadata silently falls back to English.
- **`snapshot.engine: 'aria'`** (default `'legacy'`) — a semantic tree from Playwright's official
  `locator.ariaSnapshot({ mode: 'ai' })`, re-aligned onto the project's stable `data-dsh-ref`
  scheme so refs, `REF_PATTERN` and `refLocator` keep working unchanged.
- **`snapshot.diff`** (default `false`) — incremental `+ / - / ~` deltas keyed by stable ref, with a
  navigation-reset marker when the ref nonce changes, and full-snapshot degradation when the tree
  was truncated.

### Fixed

- **The first aria engine was broken on real pages while its tests were green.** The parser assumed
  a hand-written dialect (`- role "name" [flags] -> href`, nothing after the flags); real output ends
  every container line with `:`, carries hrefs on a deeper `- /url:` child line, and writes text as
  `- text: …`. On a 16-node page the parser produced 5 nodes: all structure and **every link** were
  dropped, and the capture still reported success, so nothing fell back. Measured before/after with a
  live `captureAriaSnapshot` probe.
- **Format drift is now loud.** Unreadable lines are collected (`parseAriaSnapshotWithStats`) and
  refuse the capture (`missing: true`), and `captureAria` falls back to the legacy DOM walker instead
  of handing the model an empty tree.
- The aria tests now parse **real captured YAML** (playwright-core 1.62, 2026-09-30) rather than a
  fixture written in the parser's own dialect.

### Security

- **The CDP allow-list is method-explicit.** The family-wide `Input.` prefix is gone in favour of
  `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.dispatchTouchEvent` /
  `Input.insertText`, so `Input.setIgnoreInputEvents`, `Input.synthesizeScrollGesture`,
  `Input.dispatchDragEvent` and future `Input.*` mutations are denied by default; a widening-guard
  test now asserts that **no** entry may end in `.` (the previous guard allowed exactly one).

## 0.3.0

### Added

- **A real source tree** (`src/`, 12 modules) with the compiled `lib/` produced from it
  (`tsconfig.json` is `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`;
  `lib/` is gitignored and rebuilt by `npm run build` / the `prepare` hook).
- **A test suite** (71 tests: contract/tool-schema, provider, scenario journeys, CDP policy,
  dialog policy, click/tab URL policy, snapshot rendering, descriptions) and a self-contained
  acceptance script `npm run verify` (52 checks) that needs no DSH and no network.
- **`npm run doctor`** — checks that the harness packages this plugin actually imports still
  export what it uses, plus where `playwright-core` resolves from at deploy time.
- **`npm run cost`** — resident prompt cost of the tool surface per configuration layer,
  so a change that silently taxes every turn is visible.
- **`src/contract.ts`** — tool suffixes and failure codes in one place, with a **load-time
  guard**: a tool the contract lists but the code never registers fails loudly at load instead
  of vanishing from the model's view.
- **`src/compat.ts`** — the boundary adapter for borrowed harness identifiers (the harness
  renames fast; `CallId` became `ToolCallId`).
- **Two model-facing diagnostics tools**: `browser_console_messages` and
  `browser_network_requests`, with bounded ring buffers (200 entries, explicit dropped count,
  truncated text/URL) and honest notes about what they do not capture.

### Fixed

- **`browser_cdp` was completely dead.** `CDPSession.send` was pulled off the session into a
  bare function and called unbound, so every call died on `this._channel` and surfaced as a
  misleading `CDP_ERROR: CDP command X failed`. It is bound now, and two gates keep it bound:
  a tool-level round-trip test (`DOM.getDocument`) and a `verify` group that exercises
  `session.cdp()` directly.
- **Non-persistent mode wrote the login-state export into the process working directory.**
  `stateFile` was `''` while every reader/writer guarded on `undefined`, so `'' + '.tmp'`
  landed in `<cwd>/.tmp` holding plaintext cookies and localStorage — and because the rename
  always threw, the 1-second throttle never engaged and it ran on every tool call. The field
  is `string | undefined` again (regression-tested, and the `.gitignore` line that had
  legitimised the artifact is gone).
- **`allowedDomains` could be bypassed by `browser_click_at`** — both ref mode and raw
  coordinates delivered the click without asking the policy, while `browser_click` refused it.
  All click paths now share one rule (`assertClickTargetAllowed`).
- **`javascript:` links were unclickable through `browser_click`.** The policy is about which
  hosts may be visited, but it was applied to every non-http(s) scheme, so ordinary
  `<a href="javascript:void(0)">` links were refused on the guarded path while the unguarded
  `click_at` path clicked them fine. `javascript:` is now exempt (it runs in-page and
  navigates nowhere); `file:` / `data:` / `mailto:` / `tel:` / custom schemes stay refused.
- **A tab a page opened itself bypassed the allow-list.** `target="_blank"` / `window.open`
  navigations never pass through the plugin, so `browser_switch_tab` now applies the host
  policy before moving: a tab outside the allow-list stays open (the user may be using it) but
  the agent refuses to drive it, and the session stays on the tab it was already on.
- **`extract.maxInputChars` now actually bounds the page data** handed to the auxiliary model
  (it was read from config and then ignored), with the truncation marked in the payload.
- Prompt/doc corrections where the text promised behaviour the code did not have: the dialog
  tool's "every other tool returns the pending dialog" (they fail with `DIALOG_PENDING`),
  `browser_click_at`'s landing-note claims, `browser_fill` pointing at tools that may not be
  registered, and persistent-mode `browser_close`.

### Changed

- Description budgets are pinned by tests (single description ≤ 1650 characters, whole surface
  ≤ 11,500) and the click family states each rule once; the wording fixes above added 211
  characters back on purpose — the old text was cheaper because it was wrong.
- `browser_close` and `browser_switch_tab` semantics in persistent mode are now documented as
  what they are (one shared window; the window closes with the last session).

### Compatibility

- No API changes: same tool names, same config keys, same failure codes.
- Two deliberate behaviour changes, both guard tightenings: `javascript:` links are clickable
  again, and `switch_tab` refuses hosts outside `allowedDomains`.

## 0.2.0

- Codex-inspired layer merged onto upstream `dsh-browser-playwright` v0.1.1: geometric click
  (`browser_click_at`) with landing-element reporting, the CDP policy layer, the persistent
  profile with login-state export, parked native dialogs, snapshot/safety rules.
- Distributed as compiled output only; the source of that build was not on the machine.
