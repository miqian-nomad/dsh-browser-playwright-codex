# Changelog

Bilingual by intent: the version headings and the summary of each release are given in both
languages, the individual entries follow the language the surrounding code and docs use.

一句话摘要：**改名为 `dsh-browser-playwright-codex`、补上中文插件元数据、加入可选的 aria 快照引擎与增量 diff** ——
并且查出并修掉了第一版 aria 引擎"测试全绿、真实页面全废"的真实缺陷（层级与链接全丢却仍报成功），同时把 CDP 白名单收紧成逐方法列举。

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
