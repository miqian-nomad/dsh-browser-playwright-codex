# dsh-browser-playwright-codex

> [![dsh.so 安装验证 · harness 0.2.0-rc.1](https://www.dsh.so/badge/install/dsh-browser-playwright-codex@0.2.0-rc.1.svg)](https://www.dsh.so/zh/artifact/dsh-browser-playwright-codex/) [![dsh.so 风险](https://www.dsh.so/badge/dsh-browser-playwright-codex.svg)](https://www.dsh.so/zh/artifact/dsh-browser-playwright-codex/)

**一句话**：让 AI 用你**已经登录的账号**在真实网页上干活 —— 填表、抓取列表、多标签查后台；浏览器窗口就在你桌面上、你随时看得见。原生弹框会被挂起、**绝不替你点「确定」**（机制级）；验证码/挑战页会被识别出来，并以提示要求模型停下交给你（**提示不是阻断**）。登录/二次验证**没有探测器**，靠模型从快照看出来并停下；密码、一次性验证码、卡号字段 `browser_fill` **直接拒绝**——这类字由你本人在窗口里输。

**In one line**: the agent drives a **visible, profile-backed browser window** with the logins you
already have — filling in forms, scraping lists and working across tabs in real pages — through
accessibility snapshots with stable element refs. Native dialogs are parked and reported instead of
auto-accepted. Challenge pages are detected and reported as a note that tells the agent to stop and hand
the page back — a note, not a block. There is **no sign-in detector**, and `browser_fill` refuses
password / one-time-code / card fields outright — you type those in the visible window. No
CSS-selector guessing, no full-DOM dumps.

```sh
# from npm
dsh plugin --profile <name> add dsh-browser-playwright-codex

# or straight from the repository
dsh plugin --profile <name> add github:miqian-nomad/dsh-browser-playwright-codex
```

**为什么值得装 / What makes it different**

- **登录一次，一直用** — a profile-backed window plus an exported session state, so a closed window or
  a restarted harness comes back logged in.
- **全程看得见，也不抢你的焦点** — a real window you can watch, minimise or take over; the provider
  keeps working while it is minimised ([FOCUS-STEALING.md](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/FOCUS-STEALING.md)).
- **遇事停下来叫人** — `alert` / `confirm` / `prompt` are parked and reported, answered only by an
  explicit `browser_dialog` call ([DIALOG-POLICY.md](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/DIALOG-POLICY.md)).
  A challenge page is recognised from the interceptor's own response headers first
  (`cf-mitigated: challenge` and friends; `x-iinfo` / `x-datadome*` additionally need a blocking
  status), then from the vendor widget's accessible name, then from wording; if none of those match,
  a page that stops changing after an action is reported as a possible wall instead of being retried.
  Recognition adds a note that tells the agent to stop and hand the window back to you — that note is
  advice to the model, not a hard block; the mechanism-level guarantee exists for native dialogs only
  ([docs/articles/dialogs-and-captcha.md](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/docs/articles/dialogs-and-captcha.md)).
- **ref 失效会明说** — per-document nonce refs; a stale ref fails fast with an explanation instead of
  silently clicking a different element.
- **强力工具默认关闭** — `browser_evaluate` / `browser_cdp` are **not registered at all** unless your
  deployment opts in; this package ships both off.

**安全一览 / Security at a glance** — dsh.so's scanner flags this repository's **one Critical finding**, and that finding **is** the
implementation of `browser_evaluate` (its dynamic evaluation), which this package ships switched off.
[SECURITY.md](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/SECURITY.md) says what each
finding actually is, whether a capability gate makes it reachable (two of the warnings are not gate-controlled:
cannot do with your logins (URL policy, CDP allow-list, dialog policy, no telemetry, and `browser_fill`
refuses password / one-time-code / card fields). Counts move as the scanner and the code change — their own report is the
passwords or 2FA codes). Counts move as the scanner and the code change — their own report is the
live number.

## Install

From npm (published since v0.5.1 — [npmjs.com/package/dsh-browser-playwright-codex](https://www.npmjs.com/package/dsh-browser-playwright-codex)):

```sh
dsh plugin --profile <name> add dsh-browser-playwright-codex
```

Or straight from the repository / a checkout:

```sh
dsh plugin --profile <name> add github:miqian-nomad/dsh-browser-playwright-codex

# local development: clone, then link the checkout
dsh plugin --profile <name> add link:<absolute path to this directory>
```

**Compatibility.** Built and tested against DSH `0.2.0-rc.1`. The dependency ranges are **floors, not
wildcards**: peers `@deepseek-ai/cordis` `>=4.0.4`, `@deepseek-ai/dsh-llm` `>=0.2.0-rc.1`,
`@deepseek-ai/dsh-tools` `>=0.2.0-rc.1`, and the direct dependency `@deepseek-ai/schemastery` `^3.18.4`. The
floors exist so an empty project cannot resolve a very old `0.0.1-rc.*` build, while a newer harness still
installs. One cost of npm's prerelease rules: a prerelease whose `[major, minor, patch]` tuple differs from
`0.2.0` (for example `0.2.1-rc.*`) is outside a `>=0.2.0-rc.1` range, so you may see a **peer warning** — a
warning, not an install failure (pnpm does not enforce peer ranges strictly by default). After a harness
upgrade, `npm run doctor` re-checks that every named export this plugin imports still exists — that is the
fast way to tell "the harness moved" from "the plugin broke".

`lib/` ships in the repository (and there is deliberately no `prepare` hook), so a fresh clone loads
without a build step — `npm run build` is only needed after editing `src/`.

The bundle mounts three rows: the `ctx.browser` seam (`service`), the Playwright provider (`playwright`), and the model-facing tool family (`tool`).

### Your first task

Install it and ask for something that leaves a visible result — there is nothing else to configure:

> Open `https://news.ycombinator.com` and list the titles of the first five stories with their links.

> Go to my orders page on `<site>` and tell me the delivery address on the most recent order.

> Fill in this contact form, but stop and show me the filled form before you submit it.
the model as a `ref`-numbered list. The first time it meets a verification page it **reports the page back
to you** — take the window over by hand and it continues from where it left off (sign-ins have no detector:
the agent is told to stop when it sees one).
the model as a `ref`-numbered list. The first time it meets a sign-in, a 2FA prompt or a verification page
it **reports the page back to you** — take the window over by hand and it continues from where it left off.
Native dialogs are the one case that is enforced at the interface: they are parked and never auto-accepted.
The logins already in that profile are what make the rest work.

Two habits worth having on day one:

- **Let it look before it clicks.** Start from `browser_snapshot`; a `ref` is only valid in the result that
  produced it (a stale one fails fast instead of clicking something else).
- **Say "stop" for the irreversible step.** Submitting, paying, deleting and sending are the points where
  you want to read the form first.

### Browser binary

The provider probes `chromium` → `chrome` → `msedge` → `edge` channels automatically; any installed Chromium-family browser works with **zero download**. To use Playwright-managed Chromium instead:

```sh
npx playwright-core install chromium
# Restricted networks (e.g. mainland China):
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright-core install chromium
```

Or pin a binary: `launch.executablePath` / `launch.channel` in the plugin config.

## Tools

The default `toolPrefix` is `browser_`. Every action returns a fresh snapshot, so refs always come from the latest result. The registered set is capability-gated: `browser_evaluate`, `browser_cdp` and `browser_extract` appear only when their capability is switched on (their schemas are resident in the system prompt on every turn, so a tool that could only answer "disabled" would be pure prompt cost). Count the live surface with `npm run cost` — the shipped `cordis.patch.yml` keeps **both power gates off** (since 0.4.7), so a profile mounting this bundle sees **16 tools**; 17 or 18 once your deployment opts into `evaluate` / `cdp`, 19 with `diagnostics: true`, 21 once `extract` is configured. How to opt in: paste the snippet under Known Limitations below, or use the built-in Settings card.

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
| `browser_console_messages` | Read the page console messages captured for the current page (levels, text, source); **only registered when `diagnostics: true`** |
| `browser_network_requests` | Read the network requests captured for the current page (method, URL, status, resource type); **only registered when `diagnostics: true`** |

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
> 见 [`codex-rules.md`](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/codex-rules.md)（A 层已内嵌进各工具 description; B 层供粘贴进 DSH profile / 系统提示）。

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

#### Result notes

A result can open with one or more notes before the tree. Each says what the plugin saw; none of them
claims to *prevent* anything:

- `[human verification]` — a challenge page was recognised; the line above the note names the tier
  (response header / widget / wording) and the evidence, and the note tells the agent to stop and ask
  you to finish it in the open window instead of retrying.
- `[http NNN]` — the main document answered a non-2xx status and no challenge was identified, so the
  tree may be an error page or an interception page rather than the content that was asked for.
- `[nothing here]` — the page has no clickable elements and almost no text: a gate or visitor check, a
  page that is still loading, or one that needs a person. The note says to take one more snapshot,
  then ask you rather than re-sending the same navigation.
- `[no visible change]` — the action left the page identical (after one action on a nearly empty page,
  or after two identical results on a page with content). It is worded as a guess on purpose: it is
  what an unrecognised wall looks like.
- A landing note (which element received the click), a parked-dialog note, and an engine-fallback note
  can also appear.

An actionable element with no text of its own is named from its descendants — `<a href="/set"><span>搜索设置</span></a>` renders as `link "搜索设置" [ref=e7]`, and `<a href="/b"><img alt="图标链接"></a>` as `link "图标链接" [ref=e8]` — so a visible label and the ref that carries it always appear on the same line. A non-actionable child that merely repeats an ancestor name is folded away, so each label appears once, on the line that carries the ref; container roles are never named from their content (a `<select>` shows its chosen option, the way a text input shows its value).

## Configuration

All tunables are patchable through the profile's `cordis.patch.yml` (later layers win per row).

```yaml
# ONE row for the whole capability (2026-10-19). A package with a client module (the
# Settings card lives here) may only be mounted once, so the three concerns are nested.
- id: browser
  name: 'dsh-browser-playwright-codex'
  config:
    service:
      provider: playwright                # explicit provider selection
    playwright:
      launch:
        channel: chrome                   # or chromium / msedge / edge
        headless: false                   # visible window you can watch and rescue
        persistent: true                  # profile-backed window, login survives close
        # profileDir: ~/.dsh/browser-profiles/playwright by default
        viewport: { width: 1280, height: 800 }   # headful: IGNORED (the window tracks the desktop; only headless: true pins it)
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
        diff: false                       # true = return "+/-/~" ref diffs instead of the full tree
    tool:
      toolPrefix: browser_                # model-facing tool name prefix
      allowEvaluate: false                # browser_evaluate gate
      allowCdp: false                     # browser_cdp gate (DOM inspection / Input simulation allow-list)
      registerDisabledTools: false        # register gated tools even while off (discoverability vs resident prompt cost)
      diagnostics: false                  # true = register browser_console_messages / browser_network_requests
      interactiveOnlyDefault: false       # true = browser_snapshot returns actionable elements only
      maxWaitMs: 60000                    # browser_wait bound
      extract:
        provider: deepseek-official       # optional: enables browser_extract
        model: deepseek-v4-flash
        maxInputChars: 20000              # caps the page text handed to that model
        maxOutputTokens: 2000
```
```

`snapshot.engine` picks the page-reading engine: `'legacy'` (the default) walks the injected DOM,
`'aria'` uses Playwright's official `ariaSnapshot({ mode: 'ai' })` and aligns the result back onto the
same `ref` ids; an aria tree that cannot be parsed falls back to legacy rather than handing the model an
empty tree. It lives under `playwright.snapshot`, next to `maxNodes` / `maxNameLength` / `maxTextLength` / `diff`.

`browser_extract` needs an auxiliary LLM route (`extract.provider` + `extract.model`); without one it fails with an actionable error. With a route configured, `extract.maxInputChars` bounds the page text in that prompt, and the prompt names the cap when it truncates. A gated tool is **not registered at all** while its capability is off, so its schema never reaches the system prompt; set `registerDisabledTools: true` to keep the whole surface discoverable (the tool then answers with the error naming the switch). The shipped layer in [`cordis.patch.yml`](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/cordis.patch.yml) keeps `allowEvaluate` and `allowCdp` **off**, matching the schema defaults and this sample: that file travels inside the package, so anything it enabled would be enabled for everyone who installs it. Opt in per deployment, in that deployment's own patch layer. `browser_evaluate` executes arbitrary page JavaScript; `browser_cdp` stays off until `allowCdp: true`, and even then only the allow-list in `lib/cdp-policy.js` passes — network, storage, cookie, security and arbitrary-JS (`Runtime.evaluate`) commands are rejected with `CDP_DENIED`.

### Two levers that shrink what tools *return*

The resident schema cost is fixed, but two switches cut what each call sends back — useful on pages
whose snapshots are long, and both are off by default because both change what the model sees:

- **`snapshot.diff`** (playwright row) — returns `+` / `-` / `~` diffs against the previous snapshot,
  keyed by stable refs, instead of the whole tree. A ref-nonce change is reported as a navigation reset,
  and a truncated tree falls back to the full snapshot, so the model is never handed a diff it cannot
  anchor. Turn it on when a page re-renders often and you resent paying for the same tree twice.
- **`interactiveOnlyDefault`** (tool row) — makes `browser_snapshot` default to actionable elements
  only; the model can still pass `interactiveOnly: false` per call when it needs the text around them.
  Frames are kept either way: an iframe's accessible name is the embedded widget's own title, which is
  how a challenge widget identifies itself, so pruning it would hide the wall the snapshot is meant to
  reveal.

Both are honest trades, not free wins: a diff is smaller but requires the model to hold the previous
tree, and an interactive-only snapshot hides the prose the model may want to read. Measure before
turning them on in a deployment that shares prompts across many users.

### Prefer a switch to editing config?

The Settings card ships **inside this package** (it moved out of the companion package `dsh-browser-toggle`, which is retired) and puts
this on one card: enable/disable the browser, pick the page-reading mode, and turn the two
power tools on or off — no restart, no YAML. The card also lists **which sites this browser looks
signed in to**. Two things make that list trustworthy: cookies are attributed **first-party** — only
domains this browser actually visited are candidates, because a tracker's cookie belongs to the site
you were browsing, not to the tracker — and "looks signed in" follows OWASP's session-ID criteria
(an `HttpOnly` cookie *and* a session-scoped or token-shaped one), not cookie names or counts. Domains that belong to the same company collapse into **one row** (`京东系（18 个域）`) with the totals
for the whole family, expandable to the individual domains. Each row also says **what the site is** (`jinritemai.com` → 巨量千川（抖音电商广告后台）): the page's
own title when the browser has that domain open, otherwise a curated offline table, otherwise just the
domain — never a guess. It is
labelled as an inference rather than a fact. It shows domain names,
counts and signal labels — never cookie names and never values. The list is shown only to you: nothing is written to disk; and no
tool exposes it to the model, so an agent cannot read this list. It is a separate package because
`dsh-client-modules` rejects a package mounted from multiple loader entries, and this plugin is
mounted as three (`service`, `playwright`, `tool`), while a Settings card needs a client module. The
card writes the gates into a managed block in the deployment's home-level `cordis.patch.yml`; the
package here stays untouched, so what you download is never the thing that decided to enable them.

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
[`cordis.patch.yml`](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/cordis.patch.yml) — the
same file the package ships. Register the checkout through your profile with
`dsh plugin --profile <name> add link:<absolute path to this directory>` (above); this repository carries no
separate dev patch file.

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

## Further reading

Written for people deciding whether to hand an agent their browser. These live in the GitHub repository
(`docs/articles/`); the npm tarball ships only `README.md`, `CHANGELOG.md`, `SECURITY.md` and `NOTICE.md`, so the
links below go to GitHub rather than to files inside the package:

- [让 AI 用你已经登录的账号干活](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/docs/articles/login-state.md) — why session cookies are the hard part, and
  what the export does to a minimised window.
- [AI 开着浏览器抢你的焦点：三个根因](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/docs/articles/focus-stealing.md) — all three traced into source, with a
  113-line reproduction script that needs no part of this plugin.
- [遇到验证码和弹窗，为什么它不该替你点「确定」](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/docs/articles/dialogs-and-captcha.md) — mechanism-level
  dialog parking, what the challenge detector does and does not guarantee, and the same philosophy behind
  stale refs failing loudly.
- [官方 Discussions 发帖草稿](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/docs/articles/discussions-post.md) — a compatibility report in the format the
  community asks for, ready to paste.

## Known Limitations and Deferred Work

- **Persistent mode is one shared window** — all calling sessions drive the same profile-backed window and share its login state and tabs. Ideal for a personal assistant; if you need hard per-session isolation (separate logins per conversation), set `launch.persistent: false` and manage per-owner contexts, or run separate DSH profiles.
- **Headless servers must opt in** — the bundle defaults to `headless: false`; on a headless/remote host set `launch.headless: true`.
- **Selector-free, not vision-free** — interaction is a11y-tree based; purely visual widgets (canvas, WebGL, custom-drawn controls) may expose no refs. `browser_screenshot` + an image-capable model is the fallback.
- **Cross-origin iframes** appear as leaf `(frame)` nodes without refs; same-origin frames are walked up to two levels deep.
- **Evaluate gate is config, not approval** — enabling `allowEvaluate` trusts the model with arbitrary page JavaScript; compose it with the harness approval/permission policy for stricter control.
- **The package ships both power gates OFF, and that is deliberate** — `cordis.patch.yml` is part of the package, so anything it enables is enabled for *everyone who installs this*. It therefore sets `allowEvaluate: false` and `allowCdp: false` (the code defaults), and each deployment opts in through its **own profile patch** (`~/.dsh/profiles/<name>/cordis.patch.yml`). A package that shipped them on would be handing every installer a backdoor they never asked for. Snippet:
  ```yaml
  # dsh replaces an entry's config object wholesale — list every key you rely on.
  - id: browser
    config:
      service: { provider: playwright }
      playwright: { launch: { headless: false, persistent: true }, idleTimeoutMs: 0, maxSessions: 8, snapshot: { diff: false } }
      tool:
        toolPrefix: 'browser_'
        allowEvaluate: true    # registers browser_evaluate
        allowCdp: true         # registers browser_cdp (needs a full DSH restart)
        registerDisabledTools: false
        maxWaitMs: 60000
  ```
- **`launch.viewport` only applies headless** — the visible window is a real window: it tracks the desktop size (`browser-lifecycle.ts` passes `viewport: null` in headful), so setting 1280×800 there changes nothing. Pin the size by running `headless: true`, or resize the window itself.
- **Chromium family only** — Firefox/WebKit channels are not probed; providers are swappable if another engine is needed.
- **Extract needs a dedicated model route** — it does not reuse the main request's route; misconfiguration fails loudly at call time.
- **JS-driven navigations are not statically checkable** — `allowedDomains` covers `browser_navigate`, `browser_open_tab`, every navigating click (`browser_click`: `ref`, `text`, `precise` and raw-coordinate modes) and `browser_switch_tab`; `mode: "hover"` reveals content without activating anything, so it is not checked against the URL policy. A button whose handler runs `location.href = …` can still leave the allowed hosts, and so can a `<form>` whose `action` points at another host (pressing its submit button is a navigation this check does not statically see), and a tab that is already sitting on a disallowed host stays open (the agent simply refuses to drive it); deploy an external network guard for hard isolation.
- **Stability waits are bounded by design** — a perpetually animating element falls back to a forced click on its current rect rather than stalling; a page that never settles is snapshotted after the cap. This is intentional: the agent must never hang.
- **Challenge detection reads the responses it has actually seen** — the response-header tier applies to a document response this session observed after it attached to the tab. A tab that was already sitting on a challenge page when the session took it over falls through to the widget and wording tiers and, failing those, to the no-progress backstop: it reports a *possible* wall instead of guessing the vendor. A page that is not recognised still never goes silent: a non-2xx document carries an `[http NNN]` note, and a page with no clickable elements and almost no text carries a `[nothing here]` note.

### Ref and lifecycle safety (fixed)

The scenario suites originally surfaced four hazards, now fixed and regression-tested:

- **Stale refs fail fast** — refs carry a per-snapshot nonce, so after a client-side re-render a stale ref matches nothing and `browser_click` fails with `REF_NOT_FOUND` instead of silently acting on a different element.
- **Link clicks respect `allowedDomains`** — every click path is checked before any input is delivered: `browser_click` — ref mode (the element's `href`), `precise` ref mode, and raw-coordinate mode (the enclosing link found at the point). A disallowed host is rejected with `URL_NOT_ALLOWED`. `javascript:` links are exempt because they run in-page and navigate nowhere; other non-http(s) schemes stay refused.
- **A page-opened tab outside `allowedDomains` cannot be driven** — a page can open a tab itself (`target="_blank"`, `window.open`) and the plugin never sees that navigation, so the policy is applied where it can be: `browser_switch_tab` refuses to enter such a tab (the current tab is kept, the tab itself stays open for the user).
- **Idle disposal defers during operations** — a navigation slower than `idleTimeoutMs` completes normally; disposal only fires when the session is truly idle.
- **Mid-navigation snapshots settle** — a `browser_snapshot` racing a JS navigation waits for the new document and retries instead of surfacing a raw "Execution context was destroyed" error.

## License

MIT


<!-- changelog:today -->
## 更新记录

（此列表只记 **minor 里程碑**；每个补丁版本见 [CHANGELOG.md](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/CHANGELOG.md)。）

### 0.7.0（2026-10-19）

- **两个插件合成一个（破坏性）**：设置卡片并入本包（`dsh.client` + `./client`），`dsh-browser-toggle` 退役；`cordis.patch.yml` 从三行 loader 收成**一行** —— `- id: browser` 加嵌套的 `service` / `playwright` / `tool`。这是硬约束：`dsh-client-modules` 拒绝一个包被多个 loader 行挂载，所以带 client 的包只能有一个入口。

### 0.6.0（2026-10-16）

- **工具面三合一（破坏性）**：`browser_click` / `browser_hover` / `browser_click_at` 合并成一个 `browser_click` —— `mode: "hover"` 是原来的悬停、`precise: true` 是原来的几何中点兜底、`x`+`y` 是裸坐标。常驻 prompt **净减 16.5%（约六分之一）**（当时的值；当前成本见上面的成本表），全量注册（含三个闸门工具）21 个；规则一条没丢，守卫改成"合并后的工具必须保住原来三个的全部规则"。
- **`browser_fill` 接受 `value` 作 `text` 的别名**：模型按语义猜参数名不再第一次就撞墙；缺值时给的是指路错误（同时点出两种写法，并说明要点可见标签该用 `browser_click`）。
- **设置页多了一节「已登录的站点」（只读）**：按域名列出"像登录态"的 cookie —— 只列你在浏览器里**真的访问过**的域（第三方统计/广告域排除），判据用 OWASP 的会话特征（httpOnly 且会话级/值像令牌），**名字与条数不再作为依据**。不显示 cookie 的名字和值、不写磁盘、**模型看不到**；同一家公司的域折叠成一行（如 `京东系（18 个域）`），每行写明"这个域名是什么"（离线对照表 → 网页自己的标题 → 域名，认不出不编）。
- **`GET /state` 补上防伪头**：四个路由里唯一一个没校验 `x-dsh-plugin` 的；新增的 `GET /logins` 同样强制该头（这份名单是用户的登录站点）。
- **工程侧**：类型检查扩到 `tests/`（新增 `npm run typecheck` 并接进发版路径，一次修掉 217 处历史不一致，其中包含一处"类与接口不一致"的真实缺陷）；新增"跨文档一致性"守卫（注册条目 ↔ package.json、设置卡片的关键说法在主插件三份文档间一致、配套件与主插件的安全承诺一致）。

### 0.5.0（2026-10-03）

- **CDP 白名单改为精确逐条列举（破坏性）**：`DOM.get` / `DOM.query` 这两个**家族前缀**不再放行任何东西 —— 它们此前多授权了 9 个 DOM 调用（`getAnchorElement`、`getDetachedDomNodes`、`getSearchResults` 等），而且会放行这两个家族**将来新增**的每一个方法。现在这份名单是 19 条完整方法名 + 等号匹配：**名单没听过的名字一律拒绝，不需要有人注意到它出现了**。同时经复核收回 9 条更早**手工列上**的调试器内部特性（`performSearch`、`requestNode`、`getRelayoutBoundary` 等）—— 那是有意选择，所以收它们是政策决定，不是修前缀溢出。允许面**只收不放**；插件自己的后台建页与窗口探测走内部会话，不受影响。
- **测试从"钉例子"改成"钉性质"**：测试里写一份**独立**的同一份名单，与源码表**双向相等**（加一条/删一条都必须同时改两处，任何放宽都会出现在 diff 里）；再加 9 类探针（大写/小写/数字/点号后缀、大小写互换、截断、尾空格、整域前缀）过真函数，断言"被接受的集合恰好等于复审名单"。**测试先行**：旧实现下这 3 条会红（`DOM.getDocumentZzz` 骑进白名单、`DOM.getAnchorElement` 被放行、两份名单不一致）。
- **升级提示**：如果你的脚本用 `browser_cdp` 调过被收回的那 18 个方法，会开始收到 `CDP_DENIED`；要加回来是"改代码 + 改测试"两处，**不是改配置**。

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

- **源码化**：插件重新变成有源码的工程 —— `src/` 10 个 TypeScript 模块（当时；现在 `src/` 是 32 个 `.ts`，`lib/` 是 32 个 `.js` + 32 个 `.d.ts`）是唯一真源，`lib/` 由 `npm run build` 生成，不再手改产物。
- **代码规范**：引入 Prettier 配置（`.prettierrc.json`），`npm run format` / `npm run format:check` 统一格式；严格类型检查 0 错误。
- **新增两只诊断工具**：`browser_console_messages`（控制台报错）与 `browser_network_requests`（网络请求），用于"点了没反应"时快速定位原因。
- **接口与实现同步**：`BrowserSession` 补齐 9 个实现里已有的方法；`errors.ts` 补齐 12 个实际在用的错误码；`BrowserSnapshot` 补 `dialogNote` / `landingNote`；`TabInfo` 补 `active`；`runtime-state` / `cdp-policy` 新增类型声明。
- **依赖范围修正**：`devDependencies` 与 `peerDependencies` 对齐，可在当前 DSH 版本下安装。
