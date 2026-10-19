> **说明**：本文件是本插件的**英文自述**（中文对应版是 [中文说明.md](中文说明.md)），仓库首页那份是 [README.md](README.md)。
> （它在仓库早期曾叫 `README.md`，改名后留作插件市场的英文条目来源；包名自 0.4.0 起是 `dsh-browser-playwright-codex`。）

# dsh-browser-playwright-codex

Playwright-powered browser capability for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the agent drives a **visible, profile-backed browser window** through accessibility snapshots with stable element refs — no CSS-selector guessing, no full-DOM dumps. Login state survives window close and harness restarts (Codex-style personal browser), tabs, screenshots as durable image attachments, structured extraction, gated JavaScript evaluation, and Codex-inspired reliability guards (bounded render-stability waits, post-action verification, fast-fail actionability checks, crash auto-recovery) and native-dialog handling (alert/confirm/prompt/beforeunload are parked as a pending state, reported to the model, and answered only by an explicit `browser_dialog` call — never auto-accepted; see [DIALOG-POLICY.md](DIALOG-POLICY.md)).

## Install

```sh
dsh plugin --profile <name> add dsh-browser-playwright-codex
```

The bundle mounts three rows: the `ctx.browser` seam (`service`), the Playwright provider (`playwright`), and the model-facing tool family (`tool`).

**Compatibility.** Built and tested against DSH `0.2.0-rc.1`. The dependency ranges are **floors, not
wildcards**: peers `@deepseek-ai/cordis` `>=4.0.4`, `@deepseek-ai/dsh-llm` `>=0.2.0-rc.1`,
`@deepseek-ai/dsh-tools` `>=0.2.0-rc.1`, and the direct dependency `@deepseek-ai/schemastery` `^3.18.4`. The
floors stop an empty project from resolving a very old `0.0.1-rc.*` build while still letting a newer harness
install; a prerelease whose `[major, minor, patch]` tuple differs from `0.2.0` (for example `0.2.1-rc.*`) is
outside a `>=0.2.0-rc.1` range and may draw a **peer warning** — a warning, not an install failure (pnpm does
not enforce peer ranges strictly by default). `npm run doctor` re-checks the harness exports after an upgrade.

### Your first task

Install it and ask for something that leaves a visible result — there is nothing else to configure:

> Open `https://news.ycombinator.com` and list the titles of the first five stories with their links.

> Go to my orders page on `<site>` and tell me the delivery address on the most recent order.

> Fill in this contact form, but stop and show me the filled form before you submit it.

What you should see: a real browser window on your desktop doing the clicking, and the page coming back to
the model as a `ref`-numbered list. The first time it meets a sign-in, a 2FA prompt or a verification page
it **reports the page back to you** — take the window over by hand and it continues from where it left off.
Native dialogs are the exception that is enforced: they are parked and never auto-accepted.

### Browser binary

The provider probes `chromium` → `chrome` → `msedge` → `edge` channels automatically; any installed Chromium-family browser works with **zero download**. To use Playwright-managed Chromium instead:

```sh
npx playwright-core install chromium
# Restricted networks (e.g. mainland China):
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright-core install chromium
```

Or pin a binary: `launch.executablePath` / `launch.channel` in the plugin config.

## Tools

The default `toolPrefix` is `browser_`. Every action returns a fresh snapshot, so refs always come from the latest result. The registered set is capability-gated: `browser_evaluate`, `browser_cdp` and `browser_extract` appear only when their capability is switched on (their schemas are resident in the system prompt on every turn, so a tool that could only answer "disabled" would be pure prompt cost). Count the live surface with `npm run cost` — the shipped `cordis.patch.yml` keeps **both power gates off** (since 0.4.7), so a profile mounting this bundle sees **16 tools**; 17 or 18 once your deployment opts into `evaluate` / `cdp`, 19 with `diagnostics: true`, 21 once `extract` is configured. How to opt in: the snippet under “Known Limitations and Deferred Work” below, or the Settings card in [`dsh-browser-toggle`](https://github.com/miqian-nomad/dsh-browser-toggle).

| Tool | Purpose |
|---|---|
| `browser_navigate` | Open a URL (http/https only) and return the snapshot |
| `browser_snapshot` | Snapshot the current page: URL, title, visible elements with `ref=` ids |
| `browser_click` | Click the target from the latest snapshot — a `ref`, a visible label the snapshot gave no ref (e.g. `{ text: "搜索设置" }`), or raw `x`/`y` viewport pixels as a last resort — or rest the pointer on it without activating anything with `mode: "hover"` (submenus, tooltips, previews, player controls); `precise: true` takes a ref click down the geometric-centre path. The returned snapshot opens with a landing note naming what received the click, and a dialog raised by a click stays pending — answer it with `browser_dialog` |
| `browser_fill` | Replace an input's value; selects match by option label |
| `browser_press` | Press a key (Enter, Tab, Escape, ArrowDown, …) on an element |
| `browser_scroll` | Scroll the page or bring a ref into view |
| `browser_back` / `browser_forward` | History navigation |
| `browser_wait` | Wait a bounded duration for lazy content |
| `browser_tabs` / `browser_open_tab` / `browser_switch_tab` / `browser_close_tab` | Tab management; `browser_tabs` marks the `[active]` tab the other tools act on |
| `browser_screenshot` | PNG capture stored as a durable image attachment the model can view |
| `browser_extract` | Structured extraction: natural-language instruction → one parsed JSON value; **only registered when its capability is enabled** |
| `browser_evaluate` | Run one JavaScript expression in the page (disabled by default); **only registered when its capability is enabled** |
| `browser_dialog` | Answer the native dialog blocking the page: `{ accept: true }` confirms, `false` cancels; errors with `NO_DIALOG` when nothing is pending |
| `browser_cdp` | Send one raw CDP command (DOM inspection / Input simulation allow-list only; disabled by default); **only registered when its capability is enabled** |
| `browser_close` | Close the session's browser window; the profile keeps login state, so the next call reopens signed in |
| `browser_console_messages` | Read the page console messages captured for the current page (levels, text, source) |
| `browser_network_requests` | Read the network requests captured for the current page (method, URL, status, resource type) |

### Parameter signatures

Every registered tool, with the parameters its schema actually declares (`*` = required, `?` = optional).
Hand-maintained and pinned by `tests/tool-schema.test.ts` in both directions: a missing tool, a renamed
parameter or a wrong required flag fails the test, so it cannot drift from the code.

- `browser_back` — _none_
- `browser_cdp` — `method`*, `params`? _(gated: registered only when enabled)_
- `browser_click` — `ref`?, `text`?, `x`?, `y`?, `mode`?, `precise`?
- `browser_close` — _none_
- `browser_close_tab` — `index`*
- `browser_console_messages` — `level`?, `limit`?
- `browser_dialog` — `accept`*, `promptText`?
- `browser_evaluate` — `expression`* _(gated: registered only when enabled)_
- `browser_extract` — `instruction`* _(gated: registered only when enabled)_
- `browser_fill` — `ref`*, `text`?, `value`?
- `browser_forward` — _none_
- `browser_navigate` — `url`*, `waitFor`?
- `browser_network_requests` — `urlContains`?, `failedOnly`?, `limit`?
- `browser_open_tab` — `url`*, `waitFor`?
- `browser_press` — `ref`*, `key`*
- `browser_screenshot` — `fullPage`?, `ref`?
- `browser_scroll` — `direction`*, `amount`?, `ref`?
- `browser_snapshot` — `interactiveOnly`?
- `browser_switch_tab` — `index`*
- `browser_tabs` — _none_
- `browser_wait` — `ms`*

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

The model then calls `browser_click` with `ref: e2`. Invisible content is excluded, node and text caps bound the token cost, and truncation is flagged in the result. A result can open with one or more notes before the tree: `[human verification]` (a challenge page was recognised; the note tells the agent to hand it back to you, it does not block anything), `[http NNN]` (the main document answered a non-2xx status and no challenge was identified), `[nothing here]` (nothing to click and almost no text), `[no visible change]` (the action left the page identical — worded as a guess). A landing note, a parked-dialog note and an engine-fallback note can also appear.

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
    idleTimeoutMs: 0                    # shipped value: never auto-close (schema default 600000 = 10 min)
    maxSessions: 8                      # LRU eviction (persistent mode: one window)
    snapshot:
      engine: legacy                    # 'legacy' (default) or 'aria' (Playwright ariaSnapshot, refs aligned back)
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

`snapshot.engine` picks the page-reading engine: `'legacy'` (the default) walks the injected DOM,
`'aria'` uses Playwright's official `ariaSnapshot({ mode: 'ai' })` and aligns the result back onto the
same `ref` ids; an aria tree that cannot be parsed falls back to legacy rather than handing the model an
empty tree.

`browser_extract` needs an auxiliary LLM route (`extract.provider` + `extract.model`); without one it fails with an actionable error. With a route configured, `extract.maxInputChars` bounds the page text in that prompt, and the prompt names the cap when it truncates. A gated tool is **not registered at all** while its capability is off, so its schema never reaches the system prompt; set `registerDisabledTools: true` to keep the whole surface discoverable (the tool then answers with the error naming the switch). The shipped layer in [`cordis.patch.yml`](cordis.patch.yml) keeps `allowEvaluate` and `allowCdp` **off**, matching the sample above: that file travels inside the package, so anything it enabled would be enabled for everyone who installs it. Opt in per deployment, in that deployment's own patch layer — or use the Settings card in [`dsh-browser-toggle`](https://github.com/miqian-nomad/dsh-browser-toggle). `browser_cdp` stays off until `allowCdp: true`; even then only the allow-list in `lib/cdp-policy.js` passes — network, storage, cookie, security and arbitrary-JS (`Runtime.evaluate`) commands are rejected with `CDP_DENIED`.

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
npm run verify     # naming/folding + click/hover/dialog acceptance; self-contained, prints its own count
                   # (57 in a checkout; from an npm install it prints 56 + "1 skipped", because the
                   #  `lib/`-vs-`src/` check has no `src/` to compare against)
npm run verify:live  # same, plus a live sample of a real page (needs network)
npm run doctor     # does the installed harness still export everything this plugin imports?
npm run cost       # resident prompt cost of the tool schemas, per surface
npm run build      # tsc → lib/
```

Two of those scripts ship with the package and work against an installed copy, because they need nothing
but `lib/` and the harness: `node scripts/dsh-browser-verify.mjs` (the acceptance suite) and
`node scripts/doctor.mjs` (re-checks the harness exports after an upgrade). The rest are repository-only
and run from a checkout — `measure-prompt-cost.mjs` reads `src/`, so it cannot work from a tarball.

One package-manager note: `package.json` declares `packageManager: pnpm@10.31.0`, while the commands above
(and CI) use **npm** with the committed `package-lock.json` (`npm ci`). Pick one and stay in it — mixing the
two in a checkout gives you two lockfiles and an ambiguous install.

### Test suites

| Suite | Command | What it covers |
|---|---|---|
| Unit + engine integration | `npm test` (included) | Snapshot rendering, schema assembly, URL policy, provider actions on real Chrome |
| Realistic scenarios | `npm run test:scenarios` | Scripted-agent journeys over a realistic local store fixture: guest checkout with coupon and validation, login/session persistence, multi-tab research, lazy content, infinite scroll, modal dialogs, popups, screenshots, policy, owner isolation, idle disposal, snapshot budgets — at both the `BrowserSession` level and the model-facing `ctx.tools.execute` level (with fake attachments/LLM services) |
| Regression verify | `npm run verify` | The executable spec of snapshot naming/folding plus ref/text click-hover, the pending-dialog protocol and the tool surface (expected names derived from `contract.ts`) |
| Live smoke | `npm run test:live` | Opt-in checks against the real internet (example.com, Wikipedia REST). Skipped unless `DSH_BROWSER_LIVE=1`; not part of CI |

The scenario suites are the plugin's most realistic tests: they drive the browser the way an agent does — snapshot, find a `ref`, act, re-snapshot — and therefore double as executable documentation of the model experience.

From a DeepSeek Harness source checkout, the bundle layer to load is this repository's
[`cordis.patch.yml`](cordis.patch.yml) — the same file the package ships. Register the checkout through your
profile with `dsh plugin --profile <name> add link:<absolute path to this directory>` (above); this repository
carries no separate dev patch file.

## Model Experience

### Tool schemas

The tool schemas join the system-prompt assembly through `ctx.tools.register()`; each carries a one-line task-oriented description. The registered set is derived from `src/contract.ts` and checked against it at plugin load, so a renamed or forgotten tool fails loudly instead of silently vanishing from the model's view. Snapshot results are bounded: at most `maxNodes` nodes, names capped at `maxNameLength`, and the truncation flag is explicit.

#### Token effect

One tool schema block per tool (small, fixed), plus per-call result text proportional to the visible page, capped by ``snapshot.maxNodes`` and name/text limits. Actions return a fresh snapshot, so interactive flows cost roughly one snapshot per step.

Measured with ``npm run cost`` (per-turn, resident in the system prompt):

| Surface | Tools | Schema characters | ≈ tokens/turn |
|---|---|---|---|
| Schema defaults (`Config({})`, no patch layer) | 16 | 11,179 | ≈ 3,105 |
| Shipped bundle layer (this package's `cordis.patch.yml`: both power gates off) | 16 | 11,179 | ≈ 3,105 |
| Everything registered (`registerDisabledTools: true`, plus `extract`) | 21 | 15,782 | ≈ 4,384 |

This paragraph describes the 0.6.0 change; the table above is today's measurement. Three things changed
there, and only one of them was about size. (1) The click family was rewritten so each rule is stated once
instead of three times: -390 characters, with every rule, example and rationale pinned by
`tests/tool-descriptions.test.ts`, so a trim that eats one fails the build. (2) A gated tool is registered only
while its capability is live: `browser_extract`'s schema alone is about 456 characters (≈ 127 tokens/turn),
which a deployment that leaves `extract` unconfigured does not pay — a separate comparison, so it is not part
of the net below. (3) Four descriptions were corrected to match the code they describe (dialog blocking, the
gated diagnostics `browser_fill` points at, persistent-mode `browser_close`, and the click family’s landing
note), which added 211 characters back because the old wording promised behaviour the implementation did not
have. Net for that release: 18,065 → 17,886 characters with everything registered. The shipped layer's total
is identical to the schema-defaults row above, because it keeps both power gates off — those schemas are not
registered at all and cost nothing. What is left is per-tool prose rather than repetition, so a further cut
trades away real guidance.

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
- **The package ships both power gates OFF, and that is deliberate** — `cordis.patch.yml` is part of the package, so anything it enables is enabled for *everyone who installs this*. It therefore sets `allowEvaluate: false` and `allowCdp: false` (the code defaults), and each deployment opts in through its **own profile patch** (`~/.dsh/profiles/<name>/cordis.patch.yml`). A package that shipped them on would be handing every installer a backdoor they never asked for. Snippet:
  ```yaml
  # dsh replaces an entry's config object wholesale — list every key you rely on.
  - id: browser-tool
    config:
      toolPrefix: 'browser_'
      allowEvaluate: true    # registers browser_evaluate
      allowCdp: true         # registers browser_cdp (needs a full DSH restart)
      registerDisabledTools: false
      maxWaitMs: 60000
  ```
- **Chromium family only** — Firefox/WebKit channels are not probed; providers are swappable if another engine is needed.
- **Extract needs a dedicated model route** — it does not reuse the main request's route; misconfiguration fails loudly at call time.
- **JS-driven navigations are not statically checkable** — `allowedDomains` covers `browser_navigate`, `browser_open_tab`, every navigating click (`browser_click`: `ref`, `text`, `precise` and raw-coordinate modes) and `browser_switch_tab`; `mode: "hover"` reveals content without activating anything, so it is not checked against the URL policy. A button whose handler runs `location.href = …` can still leave the allowed hosts, and so can a `<form>` whose `action` points at another host (pressing its submit button is a navigation this check does not statically see), and a tab that is already sitting on a disallowed host stays open (the agent simply refuses to drive it); deploy an external network guard for hard isolation.
- **Stability waits are bounded by design** — a perpetually animating element falls back to a forced click on its current rect rather than stalling; a page that never settles is snapshotted after the cap. This is intentional: the agent must never hang.
- **Challenge detection reads the responses it has actually seen** — the response-header tier applies to a document response this session observed after it attached to the tab. A tab that was already sitting on a challenge page when the session took it over falls through to the widget and wording tiers and, failing those, to the no-progress backstop: it reports a *possible* wall instead of guessing the vendor.

### Ref and lifecycle safety (fixed)

The scenario suites originally surfaced four hazards, now fixed and regression-tested:

- **Stale refs fail fast** — refs carry a per-snapshot nonce, so after a client-side re-render a stale ref matches nothing and `browser_click` fails with `REF_NOT_FOUND` instead of silently acting on a different element.
- **Link clicks respect `allowedDomains`** — every click path is checked before any input is delivered: `browser_click` — ref mode (the element's `href`), `precise` ref mode, and raw-coordinate mode (the enclosing link found at the point). A disallowed host is rejected with `URL_NOT_ALLOWED`. `javascript:` links are exempt because they run in-page and navigate nowhere; other non-http(s) schemes stay refused.
- **A page-opened tab outside `allowedDomains` cannot be driven** — a page can open a tab itself (`target="_blank"`, `window.open`) and the plugin never sees that navigation, so the policy is applied where it can be: `browser_switch_tab` refuses to enter such a tab (the current tab is kept, the tab itself stays open for the user).
- **Idle disposal defers during operations** — a navigation slower than `idleTimeoutMs` completes normally; disposal only fires when the session is truly idle.
- **Mid-navigation snapshots settle** — a `browser_snapshot` racing a JS navigation waits for the new document and retries instead of surfacing a raw "Execution context was destroyed" error.

## License

MIT
