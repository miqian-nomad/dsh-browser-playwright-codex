# dsh-browser-playwright-codex

Playwright-powered browser capability for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the agent drives a **visible, profile-backed browser window** through accessibility snapshots with stable element refs — no CSS-selector guessing, no full-DOM dumps. Login state survives window close and harness restarts (Codex-style personal browser), tabs, screenshots as durable image attachments, structured extraction, gated JavaScript evaluation, and Codex-inspired reliability guards (bounded render-stability waits, post-action verification, fast-fail actionability checks, crash auto-recovery) and native-dialog handling (alert/confirm/prompt/beforeunload are parked as a pending state, reported to the model, and answered only by an explicit `browser_dialog` call — never auto-accepted; see [DIALOG-POLICY.md](DIALOG-POLICY.md)).

## Install

```sh
dsh plugin --profile <name> add dsh-browser-playwright-codex
```

The bundle mounts three rows: the `ctx.browser` seam (`service`), the Playwright provider (`playwright`), and the model-facing tool family (`tool`).

### Browser binary

The provider probes `chromium` → `chrome` → `msedge` → `edge` channels automatically; any installed Chromium-family browser works with **zero download**. To use Playwright-managed Chromium instead:

```sh
npx playwright-core install chromium
# Restricted networks (e.g. mainland China):
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright-core install chromium
```

Or pin a binary: `launch.executablePath` / `launch.channel` in the plugin config.

## Tools

The default `toolPrefix` is `browser_`. Every action returns a fresh snapshot, so refs always come from the latest result. The registered set is capability-gated: `browser_evaluate`, `browser_cdp` and `browser_extract` appear only when their capability is switched on (their schemas are resident in the system prompt on every turn, so a tool that could only answer "disabled" would be pure prompt cost). Count the live surface with `npm run cost` — this package ships `cordis.patch.yml` with `allowEvaluate: true` and `allowCdp: true`, so a profile mounting this bundle sees 22 tools (23 once `extract` is configured).

| Tool | Purpose |
|---|---|
| `browser_navigate` | Open a URL (http/https only) and return the snapshot |
| `browser_snapshot` | Snapshot the current page: URL, title, visible elements with `ref=` ids |
| `browser_click` | Click the element with a `ref` — or a visible label the snapshot gave no ref, e.g. `{ text: "搜索设置" }` — from the latest snapshot; a dialog raised by a click stays pending — answer it with `browser_dialog` |
| `browser_hover` | Rest the pointer on a `ref` — or on a visible label the snapshot gave no ref, e.g. `{ text: "设置" }` — so hover-revealed content appears (submenus, tooltips, previews, player controls); the returned snapshot names the target and notes whether the actionable ref count grew |
| `browser_fill` | Replace an input's value; selects match by option label |
| `browser_press` | Press a key (Enter, Tab, Escape, ArrowDown, …) on an element |
| `browser_scroll` | Scroll the page or bring a ref into view |
| `browser_back` / `browser_forward` | History navigation |
| `browser_wait` | Wait a bounded duration for lazy content |
| `browser_tabs` / `browser_open_tab` / `browser_switch_tab` / `browser_close_tab` | Tab management; `browser_tabs` marks the `[active]` tab the other tools act on |
| `browser_screenshot` | PNG capture stored as a durable image attachment the model can view |
| `browser_extract` | Structured extraction: natural-language instruction → one parsed JSON value | **Only registered when enabled.**
| `browser_evaluate` | Run one JavaScript expression in the page (disabled by default) | **Only registered when enabled.**
| `browser_dialog` | Answer the native dialog blocking the page: `{ accept: true }` confirms, `false` cancels; errors with `NO_DIALOG` when nothing is pending |
| `browser_click_at` | Precise native click: ref mode (geometric centre, Codex-style) or raw x/y mode; reports the actual landing element |
| `browser_cdp` | Send one raw CDP command (DOM inspection / Input simulation allow-list only; disabled by default) | **Only registered when enabled.**
| `browser_close` | Close the session's browser window; the profile keeps login state, so the next call reopens signed in |
| `browser_console_messages` | Read the page console messages captured for the current page (levels, text, source) |
| `browser_network_requests` | Read the network requests captured for the current page (method, URL, status, resource type) |

> **使用铁律**: 状态检查 / 无效不盲试 / 页面内容不可信 / 登录红线 / 风控分类等 Codex 文档纪律,
> 见 [`codex-rules.md`](codex-rules.md)（A 层已内嵌进各工具 description; B 层供粘贴进 DSH profile / 系统提示）。

### Snapshot example

```text
URL: https://example.com/
Title: Example Domain
Refs: 12

- navigation "Main"
  - link "Home" [ref=e1] -> /
  - button "Go" [ref=e2]
- heading "Welcome" [level=1]
- textbox "Search" [ref=e3]
```

The model then calls `browser_click` with `ref: e2`. Invisible content is excluded, node and text caps bound the token cost, and truncation is flagged in the result.

An actionable element with no text of its own is named from its descendants — `<a href="/set"><span>搜索设置</span></a>` renders as `link "搜索设置" [ref=e7]`, and `<a href="/b"><img alt="图标链接"></a>` as `link "图标链接" [ref=e8]` — so a visible label and the ref that carries it always appear on the same line. A non-actionable child that merely repeats an ancestor name is folded away, so each label appears once, on the line that carries the ref; container roles are never named from their content (a `<select>` shows its chosen option, the way a text input shows its value).

## Configuration

All tunables are patchable through the profile's `cordis.patch.yml` (later layers win per row).

```yaml
- id: browser
  config:
    provider: playwright                # explicit provider selection

- id: browser-playwright
  config:
    launch:
      channel: chrome                   # or chromium / msedge / edge
      headless: false                   # visible window you can watch and rescue
      persistent: true                  # profile-backed window, login survives close
      # profileDir: ~/.dsh/browser-profiles/playwright by default
      viewport: { width: 1280, height: 800 }
      navigationTimeoutMs: 30000
      ignoreHTTPSErrors: false
    allowedDomains: []                  # e.g. ['github.com'] restricts navigation
    idleTimeoutMs: 600000               # close idle windows after 10 min; 0 = never
    maxSessions: 8                      # LRU eviction (persistent mode: one window)
    snapshot:
      maxNodes: 500                     # token budget per snapshot tree
      maxNameLength: 120
      maxTextLength: 300

- id: browser-tool
  config:
    toolPrefix: browser_                # model-facing tool name prefix
    allowEvaluate: false                # browser_evaluate gate
    allowCdp: false                     # browser_cdp gate (DOM inspection / Input simulation allow-list)
    registerDisabledTools: false        # register evaluate/cdp/extract even while off (discoverability vs resident prompt cost)
    maxWaitMs: 60000                    # browser_wait bound
    extract:
      provider: deepseek-official       # optional: enables browser_extract
      model: deepseek-v4-flash
      maxInputChars: 20000             # caps the page text handed to that model
      maxOutputTokens: 2000
```

`browser_extract` needs an auxiliary LLM route (`extract.provider` + `extract.model`); without one it fails with an actionable error. With a route configured, `extract.maxInputChars` bounds the page text in that prompt, and the prompt names the cap when it truncates. A gated tool is **not registered at all** while its capability is off, so its schema never reaches the system prompt; set `registerDisabledTools: true` to keep the whole surface discoverable (the tool then answers with the error naming the switch). Note the shipped layer in [`cordis.patch.yml`](cordis.patch.yml) turns `allowEvaluate` and `allowCdp` **on** (user choice, 2026-09-04), which contradicts the `false` shown in the sample above — the sample documents the schema defaults, the shipped patch documents this deployment. `browser_evaluate` stays off until `allowEvaluate: true` because it executes arbitrary page JavaScript. `browser_cdp` stays off until `allowCdp: true`; even then only the allow-list in `lib/cdp-policy.js` passes — network, storage, cookie, security and arbitrary-JS (`Runtime.evaluate`) commands are rejected with `CDP_DENIED`.

## Architecture

A swappable capability seam, one package:

- `service` — `ctx.browser`: the provider registry with configured-or-auto selection semantics (a configured id must exist; one usable provider auto-selects; several require an explicit choice).
- `playwright` — the provider. **Persistent mode (default)**: one shared `launchPersistentContext` window on an independent profile directory (`~/.dsh/browser-profiles/playwright`), reused by every calling session — Codex-style personal browser. Login lives in the profile (durable cookies, localStorage) **plus** an exported state file (`dsh-storage-state.json`) that re-injects session cookies on relaunch (the browser drops those on close). The window auto-relaunches after an external close or crash, login intact. Set `launch.persistent: false` for the legacy shared-browser/per-owner-context mode — that mode writes **no** state file at all (the export is skipped rather than pointed at an empty path, which would have dropped cookie JSON into the process working directory). URL policy, idle disposal, and the injected snapshot engine apply to both.
- `tool` — the consumer: `defineTool`-built tools whose canonical values are structured JSON and whose rendered text is the snapshot tree. Gated tools register only when their capability is on.
- `contract` — the wire contract in one place: tool suffixes (and which are gated) plus every failure code. Registration, the load-time guard, the tests and the verify script all read it, so a renamed tool or changed code cannot drift apart silently.
- `compat` — the boundary adapter for the harness packages: borrowed names (`ToolCallId`/`CallId` and friends, once per harness release) live here so a rename lands in one file instead of failing an import.

Other providers (remote browsers, Browserbase, Steel, …) can register into `ctx.browser`; the tool schemas stay unchanged. Browser sessions survive across tool calls; login state survives window close and harness restarts in persistent mode.

## Development

```sh
npm install
npm test           # full suite: engine/action integration on real Chrome, policy, rendering,
                   # schema assembly, plus the realistic scenario suites below
npm run verify     # the naming/folding + click/hover/dialog regression script (50 checks)
npm run verify:live  # same, plus a live sample of a real page (needs network)
npm run doctor     # does the installed harness still export everything this plugin imports?
npm run cost       # resident prompt cost of the tool schemas, per surface
npm run build      # tsc → lib/
```

`scripts/` is self-contained: `dsh-browser-verify.mjs`, `doctor.mjs` and `measure-prompt-cost.mjs` live inside the package and resolve their imports relatively, so copying this directory elsewhere keeps every check runnable. A thin forwarder at `D:\dsh-plugins\_deps\scripts\dsh-browser-verify.mjs` keeps the old command (and the toolbox panel entry) working.

### Test suites

| Suite | Command | What it covers |
|---|---|---|
| Unit + engine integration | `npm test` (included) | Snapshot rendering, schema assembly, URL policy, provider actions on real Chrome |
| Realistic scenarios | `npm run test:scenarios` | Scripted-agent journeys over a realistic local store fixture: guest checkout with coupon and validation, login/session persistence, multi-tab research, lazy content, infinite scroll, modal dialogs, popups, screenshots, policy, owner isolation, idle disposal, snapshot budgets — at both the `BrowserSession` level and the model-facing `ctx.tools.execute` level (with fake attachments/LLM services) |
| Regression verify | `npm run verify` | The executable spec of snapshot naming/folding plus ref/text click-hover, the pending-dialog protocol and the tool surface (expected names derived from `contract.ts`) |
| Live smoke | `npm test:live` | Opt-in checks against the real internet (example.com, Wikipedia REST). Skipped unless `DSH_BROWSER_LIVE=1`; not part of CI |

The scenario suites are the plugin's most realistic tests: they drive the browser the way an agent does — snapshot, find a `ref`, act, re-snapshot — and therefore double as executable documentation of the model experience.

From a DeepSeek Harness source checkout, load this plugin from TypeScript:

```sh
pnpm dsh web --patch ./browser-plugin/dev.cordis.yml
```

## Model Experience

### Tool schemas

The tool schemas join the system-prompt assembly through `ctx.tools.register()`; each carries a one-line task-oriented description. The registered set is derived from `src/contract.ts` and checked against it at plugin load, so a renamed or forgotten tool fails loudly instead of silently vanishing from the model's view. Snapshot results are bounded: at most `maxNodes` nodes, names capped at `maxNameLength`, and the truncation flag is explicit.

#### Token effect

One tool schema block per tool (small, fixed), plus per-call result text proportional to the visible page, capped by ``snapshot.maxNodes`` and name/text limits. Actions return a fresh snapshot, so interactive flows cost roughly one snapshot per step.

Measured with ``npm run cost`` (per-turn, resident in the system prompt):

| Surface | Tools | Schema characters | ≈ tokens/turn |
|---|---|---|---|
| Schema defaults (`Config({})`, no patch layer) | 20 | 15,033 | ≈ 4,176 |
| Shipped bundle layer (this package's `cordis.patch.yml`: evaluate + cdp on) | 22 | 17,430 | ≈ 4,842 |
| Everything registered (`registerDisabledTools: true`, plus `extract`) | 23 | 17,886 | ≈ 4,968 |

Three things changed here, and only one of them was about size. (1) The click family was rewritten so each rule is stated once instead of three times: -390 characters, with every rule, example and rationale pinned by `tests/tool-descriptions.test.ts`, so a trim that eats one fails the build. (2) A gated tool is registered only while its capability is live — `browser_extract` on this deployment: -456 characters ≈ 127 tokens/turn. (3) Four descriptions were corrected to match the code they describe (dialog blocking, the gated diagnostics `browser_fill` points at, persistent-mode `browser_close`, and `browser_click_at`'s landing note), which added 211 characters back because the old wording promised behaviour the implementation did not have. Net: 18,065 → 17,886 characters with everything registered, and 17,609 → 17,430 in this deployment's configuration. What is left is per-tool prose rather than repetition, so a further cut trades away real guidance.

#### KV Cache effect

Tool schemas are static per registration and keep the prompt prefix stable. Result content varies with the page, invalidating reuse after each browser tool call, as with any tool result.

### Browser state

The page state itself (DOM, cookies, storage) lives in the browser context and never enters the prompt except through snapshot or page-data results.

## Known Limitations and Deferred Work

- **Persistent mode is one shared window** — all calling sessions drive the same profile-backed window and share its login state and tabs. Ideal for a personal assistant; if you need hard per-session isolation (separate logins per conversation), set `launch.persistent: false` and manage per-owner contexts, or run separate DSH profiles.
- **Headless servers must opt in** — the bundle defaults to `headless: false`; on a headless/remote host set `launch.headless: true`.
- **Selector-free, not vision-free** — interaction is a11y-tree based; purely visual widgets (canvas, WebGL, custom-drawn controls) may expose no refs. `browser_screenshot` + an image-capable model is the fallback.
- **Cross-origin iframes** appear as leaf `(frame)` nodes without refs; same-origin frames are walked up to two levels deep.
- **Evaluate gate is config, not approval** — enabling `allowEvaluate` trusts the model with arbitrary page JavaScript; compose it with the harness approval/permission policy for stricter control.
- **Chromium family only** — Firefox/WebKit channels are not probed; providers are swappable if another engine is needed.
- **Extract needs a dedicated model route** — it does not reuse the main request's route; misconfiguration fails loudly at call time.
- **JS-driven navigations are not statically checkable** — `allowedDomains` covers `browser_navigate`, `browser_open_tab`, every click path (`browser_click`, `browser_click_at` in both ref and raw-coordinate mode) and `browser_switch_tab`, but a button whose handler runs `location.href = …` can still leave the allowed hosts, and a tab that is already sitting on a disallowed host stays open (the agent simply refuses to drive it); deploy an external network guard for hard isolation.
- **Stability waits are bounded by design** — a perpetually animating element falls back to a forced click on its current rect rather than stalling; a page that never settles is snapshotted after the cap. This is intentional: the agent must never hang.

### Ref and lifecycle safety (fixed)

The scenario suites originally surfaced four hazards, now fixed and regression-tested:

- **Stale refs fail fast** — refs carry a per-snapshot nonce, so after a client-side re-render a stale ref matches nothing and `browser_click` fails with `REF_NOT_FOUND` instead of silently acting on a different element.
- **Link clicks respect `allowedDomains`** — every click path is checked before any input is delivered: `browser_click`, and `browser_click_at` in ref mode (the element's `href`) and raw-coordinate mode (the enclosing link found at the point). A disallowed host is rejected with `URL_NOT_ALLOWED`. `javascript:` links are exempt because they run in-page and navigate nowhere; other non-http(s) schemes stay refused.
- **A page-opened tab outside `allowedDomains` cannot be driven** — a page can open a tab itself (`target="_blank"`, `window.open`) and the plugin never sees that navigation, so the policy is applied where it can be: `browser_switch_tab` refuses to enter such a tab (the current tab is kept, the tab itself stays open for the user).
- **Idle disposal defers during operations** — a navigation slower than `idleTimeoutMs` completes normally; disposal only fires when the session is truly idle.
- **Mid-navigation snapshots settle** — a `browser_snapshot` racing a JS navigation waits for the new document and retries instead of surfacing a raw "Execution context was destroyed" error.

## License

MIT


<!-- changelog:today -->
## 更新记录

### 0.4.0（2026-09-30）

- **设置页多了一组选择**：在「允许 AI 操作网页」开关下面，多了「页面识别方式」——**兼容模式**（插件自己找按钮输入框，用得最久）与**智能模式**（用浏览器官方的"页面说明书"，复杂页面通常更准；读不出来会自动退回兼容模式）。选完**下一步操作就生效，不用重启、不用改配置文件**；卡片底部写着"当前：X（你选的 / 默认）"。多选一用的是和"搜索提供方"卡片一样的单选行，不是开关，一眼看去是同一套。
- **改名为 `dsh-browser-playwright-codex`**：改名是跨文件操作 —— 本包 `cordis.patch.yml` 的三个 `name:`、`dsh-browser-toggle` 的 `import '…/runtime-state'` 与它的 `node_modules` 链接、以及 profile 链接，全都必须一起走。少改一处，插件加载就 `MODULE_NOT_FOUND`（已实测：旧名在两个 profile 均已解析失败，新名可解析）。
- **持久化开关文件名故意保持旧拼写**（`~/.dsh/dsh-browser-playwright.state.json`）：那是用户状态，改名会让设置页的开关被静默重置。
- **中文插件元数据**：新增 `locale/en.json` / `locale/zh.json`，并在 `exports` 加 `"./locale/*.json"`、在 `files` 加 `locale` —— 少了 exports 这一行，harness 的 `require.resolve` 会失败并静默回退英文。
- **新增可选 aria 快照引擎**（`snapshot.engine: 'aria'`，默认仍是 `'legacy'`）：用 Playwright 官方 `locator.ariaSnapshot({ mode: 'ai' })` 取语义树，再对齐回本项目稳定的 `data-dsh-ref`，所以 ref、`REF_PATTERN`、`refLocator` 全都不变。
- **新增增量快照 diff**（`snapshot.diff`，默认关）：按稳定 ref 输出 `+ / - / ~` 增量；ref nonce 变化即标注"导航重置"，树被截断时退回整棵树。
- **修掉第一版 aria 引擎的真实缺陷**：解析器按自造方言写（`- role "name" -> href`、行尾无其他内容），而真实输出每个容器行都以 `:` 结尾、href 走更深的 `- /url:` 子行、文本是 `- text: …`。16 个节点的页面只解析出 5 个 —— **层级与链接全丢，却仍报成功**（所以不会回退）。已用真实页面实测前后对比。
- **格式漂移现在会大声失败**：读不懂的行会被收集（`parseAriaSnapshotWithStats`）并让本次捕获返回 `missing: true`，`captureAria` 随即回退 legacy DOM 引擎，绝不把空树交给模型。
- **aria 测试改用真实抓取的 YAML**（2026-09-30 从 playwright-core 1.62 实抓），不再用解析器自己方言手写的 fixture。
- **CDP 白名单收紧为逐方法列举**：去掉 `Input.` 族前缀，只留 `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `dispatchTouchEvent` / `insertText`；`Input.setIgnoreInputEvents`、`synthesizeScrollGesture`、`dispatchDragEvent` 及未来的 `Input.*` 默认拒绝，并新增守卫测试断言**任何**条目都不得以 `.` 结尾（旧的守卫恰好允许了一条）。

### 0.3.0（2026-09-26）

- **源码化**：插件重新变成有源码的工程 —— `src/` 10 个 TypeScript 模块是唯一真源，`lib/` 由 `npm run build` 生成（10 个 .js + 10 个 .d.ts），不再手改产物。
- **代码规范**：引入 Prettier 配置（`.prettierrc.json`），`npm run format` / `npm run format:check` 统一格式；严格类型检查 0 错误。
- **新增两只诊断工具**：`browser_console_messages`（控制台报错）与 `browser_network_requests`（网络请求），用于"点了没反应"时快速定位原因。
- **接口与实现同步**：`BrowserSession` 补齐 9 个实现里已有的方法；`errors.ts` 补齐 12 个实际在用的错误码；`BrowserSnapshot` 补 `dialogNote` / `landingNote`；`TabInfo` 补 `active`；`runtime-state` / `cdp-policy` 新增类型声明。
- **依赖范围修正**：`devDependencies` 与 `peerDependencies` 对齐，可在当前 DSH 版本下安装。
