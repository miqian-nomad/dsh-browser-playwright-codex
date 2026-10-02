# Changelog

Bilingual by intent: the version headings and the summary of each release are given in both
languages, the individual entries follow the language the surrounding code and docs use.

一句话摘要：**把「看着危险」变成「说得清楚」** —— 新增 `SECURITY.md`，把 dsh.so 扫描报的 **2 Critical / 5 Warning / 26 Info** 逐条对上：那 2 个 Critical 就是 `browser_evaluate` 的实现，而**包里默认关闭**（关着时工具根本不注册）。README 第一屏重写（中文一句话 + 一条命令安装 + 五条差异点 + 安全入口），并又清掉两处「出厂开启闸门」的过期说法。

## 0.4.10

一句话摘要（0.4.9）：**文档对齐 + 指向配套件** —— README 里那句「出厂 patch 把两个闸门打开」在 0.4.7 之后已经过期（现在包里保持关闭），改成事实；同时指向新的配套仓库 `dsh-browser-toggle`（设置页卡片，那两个开关就在上面）。

### Added

- **`SECURITY.md`.** The scanner's output is the first thing a cautious user reads, and it said
  "2 Critical · dynamic code execution" with no context. The file now maps every finding to what it
  actually is and to the gate that decides whether it is reachable at all: both Criticals *are* the
  body of `browser_evaluate`, a tool this package ships switched off, so it is not registered until a
  deployment opts in. It also states plainly what the plugin can and cannot do with your logins (URL
  policy and its limits, dialog parking, the CDP allow-list, where it writes, no telemetry, and that
  the agent never types passwords or 2FA codes), plus how to re-check all of it yourself
  (`npm test` / `npm run verify` / `npm run doctor` / CI / the sandbox records).
  - It says the honest thing twice: the finding count **will not go to zero** (a scanner reads code,
    not runtime gates), and we did not try to hide or suppress it.

### Changed

- **README first screen rewritten.** It used to open with one 90-word sentence that only a maintainer
  would finish. Now: a one-line "what it does for you" in Chinese and English, the single install
  command, five concrete differences (login reuse, watchable window that does not steal focus,
  stopping for logins/captchas/dialogs, honest stale-ref failure, power tools off), then a pointer to
  `SECURITY.md`. The technical detail is all still below the fold.

### Fixed

- **Two more stale "the shipped layer enables the gates" claims** (README's tool section and its
  mirror `PLUGIN-README.md`) — the third and fourth appearance of that sentence, both now stating
  that the package ships `allowEvaluate: false` / `allowCdp: false` and pointing at `SECURITY.md` §1.

## 0.4.9

一句话摘要（0.4.8）：**设置页能如实显示并可切换两个强力工具** —— 工具族在注册时发布自己真正使用的闸门值，设置页显示的就是事实；配套卡片把用户的选择写进部署自己的配置层。

### Fixed

- **The READMEs no longer claim the shipped layer enables the gates.** They said the packaged
  `cordis.patch.yml` turns `allowEvaluate`/`allowCdp` **on** ("user choice, 2026-09-04") and even
  flagged the contradiction with the sample above it. 0.4.7 removed that, so the sentence described
  a state that no longer exists — exactly the kind of stale claim a third-party reader would take at
  face value. Both files now state what the package does: keeps them off, because the file travels
  inside the package and anything it enabled would be enabled for every installer.

### Added

- **A pointer to the companion package** [`dsh-browser-toggle`](https://github.com/miqian-nomad/dsh-browser-toggle),
  with the reason the card cannot live in this package: `dsh-client-modules` rejects a package mounted
  from multiple loader entries, and this one is mounted as three (`service`, `playwright`, `tool`),
  while a Settings card needs a client module. The card writes the gates into the deployment's
  home-level `cordis.patch.yml`, so what you download is never the thing that decided to enable them.

## 0.4.8

一句话摘要（0.4.7）：**智能模式原来几乎从未真正生效** —— 解析器把 `/placeholder:` 这类属性行当成「格式漂移」，于是**任何带输入框提示语的页面都静默退回兼容模式**；同时「先 flags 后跟冒号」的内联文字被丢掉，导致段落文字整条消失。两个都修了，并给智能模式补上端到端验收与「已回退」明示。另外：**包里不再默认打开 `browser_evaluate` / `browser_cdp`**（那是发给每个安装者的后门），本机授权改由 profile 配置承担。

### Added

- **`runtime-state.publishGates` / `getGates`.** The tool family publishes the gates it actually
  applied, so a Settings UI can show what is in effect instead of guessing at the package default —
  the value may come from the bundle patch, a profile patch or a home-level patch. Published from the
  same set that decides which tools register, so the two can never disagree. Purely additive: no
  behaviour change on its own (99 tests / 96 pass, verify 57/57, CI green on both runners).

## 0.4.7

一句话摘要（0.4.6）：**日志不再跨标签页混流** —— `browser_console_messages` / `browser_network_requests` 承诺给的是「当前这个标签页」的日志，实际给的是整个会话里所有标签页混在一起的大锅；现在只报当前页，并明确写出「另有 N 条来自其它标签页、已排除」。顺带修掉新开标签页**第一段导航完全没有日志采集**的问题。

### Fixed

- **Smart mode almost never actually ran, and said nothing.** The aria parser treated any
  attribute line other than `/url:` as format drift; an input with a `placeholder` produces
  `- /placeholder: …`, so the capture layer refused the whole tree and fell back to the legacy
  engine — silently, on most real pages (measured 2026-10-02: the Settings switch said
  "smart mode" while the engine never got to run). Attribute lines carry no tree structure, so
  they are now parsed (`/placeholder` names the input the same way the legacy walker does) and
  unknown ones are ignored instead of refused.
- **Inline text after flags was dropped, so paragraphs lost their text.** `- paragraph [ref=e5]: (未点)`
  parsed to a nameless, childless node — and nameless childless nodes are pruned, so in smart mode
  every paragraph rendered without its content. The text after the last `]` is now the node's name.
- **The fallback is no longer silent.** When the configured reader cannot read a page, the snapshot
  carries a `[page reader]` line saying the tree came from the compatible engine (and that refs below
  belong to it). A user who explicitly picked smart mode now sees when it is not what they are reading.
- **The package no longer ships the power gates on.** `cordis.patch.yml` travels inside the package, so
  the `allowEvaluate: true` / `allowCdp: true` it used to carry (one machine's 2026-09-04 choice) was
  handed to **every installer** — arbitrary page JavaScript plus raw CDP, on by default. Both gates now
  ship `false` (matching the code defaults and this README's own example), and per-deployment opt-in
  lives in that deployment's profile patch. This is also what a third-party scanner reads as
  "dynamic code execution, critical": their finding was right about the capability, and the packaging
  was what made it everyone's default.

### Added

- **Smart-mode end-to-end acceptance** (`npm run verify`, phase `[8]`): a page with hidden actionable
  elements *before* the form — the exact shape that used to shift every ref — is read with the aria
  engine, then the ref from that snapshot must click the element it names (and must not touch the
  hidden element ahead of it). The acceptance suite is now 57 checks and covers both engines.
- Guard tests for both parser bugs, plus the earlier ref-alignment guards.

## 0.4.6

一句话摘要（0.4.5）：**修掉智能模式下的 ref 指错元素** —— 它按「位置」把 DOM 里所有可交互元素（含隐藏的）贴到 aria 树里只有可见的节点上，页面上一有隐藏副本就整体错位；模型照着快照里的 ref 操作，可能命中另一个元素。

### Fixed

- **The diagnostics tools served every tab's entries as if they belonged to the driven tab.** Both
  rings live on the session (deliberately: chronology and eviction stay honest across a tab switch),
  but neither reader scoped its output to the page it was reporting on, while the tool descriptions
  promise "the tab this session is driving". Measured 2026-10-02: sitting on a GitHub OAuth page,
  `browser_console_messages` offered 抖音 CORS errors, B站 warnings and dsh.so failed loads — a
  misdiagnosis one step away for exactly the tool whose job is to answer "the action looked
  successful but nothing changed — was it the page or the request?".
  - Every entry now carries the page that produced it, the readers filter to the page the session is
    driving, and the rendered output discloses the excluded count
    (`[N matching entries from other tabs of the same window not shown …]`). An empty result now says
    "this tab is quiet" instead of implying the whole window is.
  - **Second gap found while testing the first:** `browser_open_tab` never called `trackPage`, so a tab
    opened through the tool had no console/network listeners during its first navigation — its own
    load was invisible. Capture is now wired before that first `goto`.
  - Guarded by a test that drives two tabs, makes each request a URL the other never uses, and asserts
    that the driven tab is reported, the other tab is not, and the exclusion is disclosed rather than
    silent.

## 0.4.5

一句话摘要（0.4.4）：**撤回 0.4.3 加的 SPDX 行** —— 实测它反而让 dsh.so 的「许可证」字段从 `MIT` 变成 `NOASSERTION`（他们的匹配器是整文模板比对，多一行就失配）。`LICENSE` 恢复原样，许可条款从未改变。

### Fixed

- **Smart mode could hand the model a ref that names one element and resolves to another.** The aria
  engine paired two independently produced lists **by position**: the DOM walk mints a ref for every
  actionable element in document order, while the accessibility tree contains only what a screen
  reader can reach. A single element the tree cannot see (a hidden menu copy, a 0×0 leftover from a
  re-render) shifts every later ref onto a different element — and a click on such a ref can land on
  another element **with no error at all**, which is precisely what this plugin promises never
  happens ("a stale ref can never silently match a different element").
  - Measured 2026-10-02 on `dsh-plugin.market/submit` (a React page): 7 hidden copies of the header
    nav sat ahead of the form, so the tree reported the search box as `…411` while `…411` was an
    invisible 0×0 link and the real input held `…423`. Both symptoms that started this investigation
    — "the element is not visible" and "could not find an unobstructed click point" — were this bug,
    not occlusion.
  - **Fix, part 1 — stop minting refs for elements the tree cannot see.** The DOM-side ref walk now
    skips the hidden attribute, `aria-hidden="true"`, `display:none`/`visibility:hidden` and
    zero-size elements (`display:contents` keeps its slot, because its children lay out normally).
    On the page above that turns 24 minted refs into the 17 the tree actually has, and the two
    sequences line up exactly (verified live, including the textbox landing at slot 11).
  - **Fix, part 2 — verify identity instead of assuming order.** Each consumed ref now carries the
    walker's role and must match the node's role (with aliases for `textarea`→`textbox`,
    `summary`/`image`→`button`), and leftover ref slots are refused when the tree was not truncated.
    Any mismatch discards the capture (`missing`), so the provider falls back to the legacy engine —
    which mints refs while it walks and therefore cannot drift. A ref is never guessed; the worst
    case is an honest fallback.
  - Guarded by four new tests: an aligned list passes, a shifted list is refused, leftover slots are
    refused, and deliberate truncation is **not** mistaken for drift.

## 0.4.4

Reverted the SPDX line added in 0.4.3. Measured against dsh.so's submission checker it made the
license field *worse* while leaving the format note untouched, so `LICENSE` is back to the exact
0.4.2 bytes. No code change, and the license terms never changed at any point.

### Fixed

- **Reverted the SPDX line added in 0.4.3.** Measured against dsh.so's submission checker on a `v0.4.3` freeze: the license field changed from `MIT` to `NOASSERTION`, while the format note `找到许可证文件，但无法确定 SPDX 标识` stayed exactly as before. Their matcher compares the whole file against known license templates, so one extra leading line makes identification fail. `LICENSE` is byte-identical to the 0.4.2 version again — verified with `git diff v0.4.2 -- LICENSE` (empty).
- The remaining format note is a quirk of that checker, not a licensing problem: `package.json` declares `"license": "MIT"` and the file is the standard MIT text. It is a warning, not a blocker — the submission was accepted with it in place.

## 0.4.3

一句话摘要（0.4.3）：**给 `LICENSE` 加上 SPDX 标识行** —— dsh.so 的提交检查读许可证文件时报「找到许可证文件，但无法确定 SPDX 标识」；MIT 正文本身是标准的、`package.json` 也写了 `"license": "MIT"`，但那一步要求标识出现在文件里。许可条款没有任何改动。

### Fixed

- **`LICENSE` now opens with `SPDX-License-Identifier: MIT`.** dsh.so's submission checker reads the
  license file and reported `找到许可证文件，但无法确定 SPDX 标识` while scanning `v0.4.2`; the MIT
  text was already standard and `package.json` already declared `"license": "MIT"`, but its detector
  wants the identifier inside the file. Everything below that line is byte-identical to the previous
  LICENSE.

## 0.4.2

一句话摘要（0.4.2）：**最后一个已知缺陷查清并修掉了** —— 每次操作后的登录态导出会为「访问过但标签已关」的站点临时开一个标签去读 localStorage，而那个标签不带 `background`，于是把用户最小化的窗口拽回桌面。

Root cause of the last known defect, found in playwright-core's source and fixed in-plugin: the
post-operation login-state export used `context.storageState()`, which opens a temporary page for
every visited origin whose page is gone — a page created without `background`, which activates the
window.

### Fixed

- **A minimized window is no longer dragged back onto the screen by the login-state export.**
  `context.storageState()` is not a pure read: for every origin the context has visited whose page is
  since gone, it opens a **temporary page**, navigates it to that origin, reads its storage and closes
  it (`playwright-core@1.62.1 lib/coreBundle.js:51663-51683`). The origin set is accumulated by
  `addVisitedOrigin` on every navigation (`:22352` → `:51634`) and is only ever reset by
  `setStorageState` (`:51737`), so a long-lived context always has leftovers. That page is created
  through `Target.createTarget` **without `background: true`** (`:38340-38342`), and Chromium
  activates the window on every tab creation — the same root as the earlier "tab creation raises the
  window" fix, with a trigger nobody had suspected: Playwright's own storage bookkeeping, running
  after every tool call.
  - **Why the earlier minimal reproduction could not see it:** in a fresh process every visited origin
    is still covered by an open page, so the temporary-page branch is never entered — `storageState()`
    is genuinely safe there. It needs a long-lived context that has navigated away from sites it no
    longer keeps open.
  - **The fix:** when the window is minimized — or its state cannot be read — export **cookies only**
    (`context.cookies()`; cookies never open a page, `:51639`). The full `context.storageState()` is
    used only when the window is positively visible, where a temporary page disturbs nobody.
  - This is strictly better than the mitigation it replaces: the old gate *skipped* the export while
    minimized, so the session-cookie fallback had a hole exactly for the user most likely to close the
    window by hand. The state file is a snapshot, and we no longer write origins we did not read —
    which also removes a subtler hazard: the old gate left the *previous* origins list sitting in the
    file, and `restoreState` re-applies that list with `addInitScript` on the next launch, overwriting
    whatever the profile had stored since. No durable loss either way: localStorage lives in the
    persistent profile.
- **Guards:** `tests/login-state.test.ts` drives that decision with a fake browser context (no
  browser, no network), pinning which playwright API is used per window state. Measured against the
  previous code it fails 3 of its 4 cases (it catches `storageState()` being reached while minimized,
  and the throttled export being skipped); it passes 4/4 now.

### Docs

- `FOCUS-STEALING.md` Cause 3 is no longer "only half understood": the four-link mechanism is written
  out with source lines, the "the A/B may have been confounded" alternative is withdrawn, and the
  method table explains why `storageState()` measured *safe* in a fresh process and still raised the
  window on a long-lived instance.

## 0.4.1

Adopted as the single canonical tree for this repository: the assets that only existed on the
GitHub side (docs, patches, analysis scripts, license/notice) are now here, `lib/` is committed
because this repository is the distribution channel, and the tests/verify no longer read the real
user settings file.

### Added

- **A settings-page switch for how pages are read** (`dsh-browser-toggle` card, right under
  the existing on/off switch): 兼容模式 (the plugin's own DOM walk) ↔ 智能模式 (the browser's
  official accessibility tree). It is persisted next to the enable flag and applies from the
  next operation — no restart, no config edit. The card shows the mode actually in effect and
  whether it is the user's pick or the deployment default, and the choice is rendered as radio
  rows (the pattern the search-provider card uses for a pick-one setting) rather than a switch.
  Landed after the 0.4.0 tag (`81d8769`), which is why it is listed here and not under 0.4.0.
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
  back at the top of the README, pointing at [the artifact page](https://www.dsh.so/zh/artifact/dsh-browser-playwright-codex/).
  The version inside that badge URL is the **dsh** version it was verified against, not the plugin
  version — corrected on 2026-10-02, when the badge was moved from `0.1.7-rc.2` to `0.2.0-rc.1`
  (dsh.so's newest verified row, 2026-09-30) and the risk badge was added. dsh.so's L4/L5
  *install* verification artifact is still `v0.3.1` while its security scan already reads `0.4.1`;
  both of those are theirs to refresh.

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
