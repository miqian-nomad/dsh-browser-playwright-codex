# Changelog

Bilingual by intent: the version headings and the summary of each release are given in both
languages, the individual entries follow the language the surrounding code and docs use.

一句话摘要：**0.2.0 的"只有编译产物"状态结束了** —— 这一版把整个插件还原成带类型、带测试、带验收工具的源码树，
并修掉了三个真实缺陷（`browser_cdp` 整体失效、非持久模式把登录态明文写进工作目录、`allowedDomains` 可被绕过）。

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
