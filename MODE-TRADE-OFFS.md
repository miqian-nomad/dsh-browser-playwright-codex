# Mode trade-offs, measured / 两种模式的代价，实测

This document exists because the obvious fix for the focus-stealing bug — "just default to headless and add a switch" — turns out to have costs that the bug report alone does not show. Everything below was measured on one machine with the plugin's real launch options, on the same persistent profile.

这份文档存在的理由：针对"拽窗"这个 bug，最直觉的修法是"默认 headless + 加个开关"。但实测下来，这个方案有报告里看不见的代价。以下全部是在同一台机器、同一份 profile、使用插件真实启动参数测出来的。

**Environment / 环境**：Windows 11 x64 · Chrome 151 (`channel: 'chrome'`) · playwright-core 1.62.1 · plugin launch options (`viewport: null` headful / `1280x800` headless, `HUMANIZED_LAUNCH`, `--start-maximized` headful only).

Reproduction scripts live in this repository's `scripts/` (`hl-compare.mjs`, `live-handoff-probe.mjs`, `needs-human-probe.mjs` — see the footer).

---

## 1. What `headless: true` actually changes / headless 到底改了什么

| Observation | headless | headful |
|---|---|---|
| `navigator.userAgent` | `...HeadlessChrome/151.0.0.0 Safari/537.36` | `...Chrome/151.0.0.0 Safari/537.36` |
| `innerWidth × innerHeight` | **1280 × 800** (pinned by config) | **1138 × 537** (real window) |
| `devicePixelRatio` | **1** | **2.25** (the machine's display scaling) |
| `screen` | 1280 × 800 | 1138 × 712 |
| `@media (min-width: 1280px)` | **true** | **false** |
| `@media (min-width: 1152px)` | true | **false** |
| screenshot size | 1280 × 800 | **2561 × 1208** |
| `requestAnimationFrame` / s | 143 | 75 |
| `navigator.webdriver` | false | false |

Two consequences worth stating plainly:

- **Layout is not the same page.** The 1280px breakpoint is one of the most common in the wild (`min-width: 1280px` and `1200px` both flip): headless renders a wide layout, headful renders a narrower one. Geometry-based clicking is calibrated against whichever mode produced the snapshot, so a mode switch mid-task invalidates what the model has learned about the page.
- **`--headless=new` does not help the UA.** Adding it explicitly produced no change: the UA still said `HeadlessChrome`. Hiding that token would require forging the UA, which contradicts this plugin's stated position in `HUMANIZED_LAUNCH` ("no fingerprint spoofing: real Chrome's own values are consistent by construction").

**中文小结**：headless 不只少一个窗口——UA 变成 `HeadlessChrome`、视口被钉在 1280×800、`dpr` 从 2.25 变 1、截图从 2561×1208 变 1280×800，而且**响应式断点直接翻转**（1280/1200/1152 三档全变），也就是"同一个网站是两套布局"。`--headless=new` 对 UA **没有任何改善**（实测）。

## 2. What actually needs a human eye / 到底哪些事真的需要人眼

| Case | Needs a visible window? | Measurement |
|---|---|---|
| `alert` / `confirm` / `prompt` / `beforeunload` | **No** | headless: `prompt()` parked, answered by the listener, page continued and returned the typed value |
| OS file picker | **No** | headless: `setInputFiles()` attached the file with no picker |
| Login | **Usually once per site** | after a browser restart both a durable cookie *and* localStorage survived (see §4) |
| Captcha / anti-bot challenge | **Yes** — no automation substitute | the human needs to see it *and* interact with it |

**Correction to this repository's own earlier text.** `docs/FOCUS-STEALING.md` and `patches/README.md` listed "native dialogs" among the reasons a window must exist. That was wrong, and it is now fixed in both files: this plugin answers dialogs through Playwright's `dialog` event plus CDP, which works with no window at all. The corrected short list of "why headful exists" is: **captcha/challenge hand-off, and letting the user watch.**

**中文小结**：**原生对话框不需要窗口**（实测 headless 下 prompt 被挂起、被回答、页面继续），文件选择器也不需要（`setInputFiles`）。登录多数只在首次需要人。**真正必须人眼可见窗口的只有验证码/风控挑战这一类。** 我此前在本仓库里把"原生对话框"也算进必须 headful 的理由，是错的，已在原文更正。

## 3. The alternative to switching modes: minimize ⇄ show, live / 不切模式的正解：活着的最小化↔抬起

Measured on a headful persistent context with a page holding a typed value, a live timer, and a scroll position (a stand-in for "a captcha form half-filled"):

| Step | Window state | Page state |
|---|---|---|
| start | `maximized` | — |
| minimize via `Browser.setWindowBounds` | **`minimized`** | — |
| agent works while minimized | `minimized` | typed value intact, `scrollY = 1500`, timer running (`counter = 8`) |
| show: `setWindowBounds('normal')` + `bringToFront()` | **`maximized`**, `document.hasFocus() = true` | **`loads = 1`** (no reload), typed value intact, `scrollY = 1500`, timer continuous (`counter = 13`) |

So a window can sit minimized while the agent works, and be handed to the human with **the same page instance** — the same challenge, the same half-filled form, the same scroll position. No relaunch, no reload, no lost tabs, no session-cookie risk, no UA change.

**中文小结**：实测"最小化着干活 → 抬起来给人"这一套，**页面实例全程不变**（`loads = 1`，输入值、滚动位置、计时器全部连续，抬起后窗口获得焦点）。也就是说，人工介入**不需要切换模式**：同一个验证码原封不动地出现在屏幕上。

## 4. What survives a mode switch (= a browser restart) / 切换模式（=重启）后还剩什么

Measured in both directions (headless → headful, headful → headless), same profile:

| State | Survives restart |
|---|---|
| durable cookie (with `expires`) | **yes** |
| `localStorage` | **yes** |
| session cookie (no `expires`) | **no** — dropped by the browser; needs the plugin's exported state file to re-inject |

Not measured, read from the code: **open tabs are not restored** by anything (`restoreState` handles cookies and localStorage only), and snapshot refs from before the switch are invalid by design (per-snapshot nonces fail fast rather than misclicking).

Also read from the code plus one probe: in headless the window-state CDP call (`Browser.getWindowForTarget` → `Browser.getWindowBounds`) **still works** — it returned `windowState: "normal"` with a real `windowId`. That matters because the minimize gate returns `true` ("treat as minimized") when the state is unreadable: in headless it returns `false`, so the login-state export keeps running rather than being silently disabled.

**中文小结**：重启能保住持久 cookie 和 localStorage，**保不住 session cookie**（要靠插件导出的 state 文件回注）；**标签页没有任何恢复逻辑**；切换前的快照 ref 会按设计快速失效。另外确认了一件容易踩雷的事：headless 下窗口状态 CDP 调用**仍然可用**，所以"最小化时跳过登录态导出"这个门控不会在 headless 里被误触发成永久跳过。

## 5. Residual costs, per option / 各方案剩下来的代价

| Option | Costs that remain |
|---|---|
| **A. Headless by default + explicit "show window"** | Switch = restart: page reloads (a live challenge is likely re-issued — *inference, not measured*), open tabs are lost, session cookies depend on a state export that must be forced before the switch, layout/DPR/UA all change, and headless brings the `HeadlessChrome` UA. Also needs playwright's own headless binary unless the channel resolves to an installed Chrome (measured failure: `chrome-headless-shell-1234` missing). |
| **B. Keep headful, minimize while working, add a re-minimize guard for page-initiated raises** | The guard fires *after* the browser has already raised the window, so a **visible flash** is possible. This is not theoretical: on the reporting machine the raise itself is plainly visible, and the user reports the flash is real. Nothing else changes: no restart, no reload, no tab loss, no cookie risk, no UA change. |
| **C. Strip `target="_blank"` at click time so no new tab is ever created** | Changes the page's declared behaviour (a link opens in place instead of in a new tab). Flash-free. Should be reported in the tool result, never done silently. |

For the "minimize it and forget about it, pull it up only when I'm actually needed" workflow, **B + C** is the set with the smallest deviation from the user's intent: B catches every raiser generically, C makes the most common raiser (links) flash-free. **A is the option that costs the most exactly in the cases where a human is needed**, which is the opposite of what the bug report asked for.

**中文小结**：A（headless 默认）的代价**恰好都落在"需要人"的那一刻**——重启、重载、丢标签、可能重新挑战、布局与 UA 全变；B（守卫 + 事后压回）唯一代价是**可能闪一下**（报告者实测：抬起本身肉眼可见，所以闪是真实的）；C（点击时摘 `target`）完全不闪，代价是网页原意被改，必须如实上报。对"丢后台、真需要再拉起来"的用法，**B + C** 最贴近本意。

---

## 6. The costs that no setting removes / 换任何设置都消不掉的代价

Everything in §5 has the same root: **this plugin owns a second OS window.** A window that exists can be raised (B's flash); a window that does not exist cannot be shown to a human (A's restart). Picking between A and B is picking which of those two prices to pay — no configuration removes both.

The options that remove the root instead, all of which put the agent into a browser that is **not a separate OS window**:

| Shape | How the human is pulled in | Not verified here |
|---|---|---|
| Extension + native messaging into the user's own browser (the Codex / Claude-for-Chrome route, see `FOCUS-STEALING.md` prior art) | the user's ordinary browser tab *is* the surface | nothing was built or tested in this repository |
| CDP attach to a browser the user already runs (several DSH plugins in the ecosystem advertise this) | same — the user's own window | not measured; and the agent would be able to see the user's other tabs |
| An embedded browser rendered inside the harness UI (the DSH right-sidebar browser) | the panel is already on screen | not verified whether it is agent-drivable or keeps a login profile |

**Honest summary:** if *both* costs in §5 are unacceptable, the answer is not another setting on this plugin — it is a different browser surface. That is a design decision with its own prices (a debug port or an extension to install; the agent sharing the user's browsing context), and none of them were measured in this repository.

**中文小结**：§5 里所有代价同一个根源——**这个插件拥有第二个 OS 窗口**。存在的窗口可以被抬起（B 的闪烁），不存在的窗口没法给人看（A 的重启）；二选一，都是为这个根源付费，换设置消不掉。要消掉根源，只能换成"不是独立窗口"的浏览器形态：扩展+原生消息寄生进用户自己的浏览器（Codex 那条路）、CDP 挂到用户已经在开的 Chrome、或渲染在 harness UI 里的内嵌浏览器。这三条本仓库都**没有实测**（也各有各的代价：装扩展/开调试端口、agent 会看到你的标签、内嵌浏览器是否可被驱动尚未核实）。
---

## Reproduction / 复现

All three probes are plain `playwright-core` + Chrome, no DSH and no plugin needed:

| Script | Question it answers |
|---|---|
| `scripts/analysis/hl-compare.mjs` | the headless/headful table in §1 (UA, viewport, DPR, breakpoints, screenshot size, portrait of media features) |
| `scripts/analysis/live-handoff-probe.mjs` | the minimize → work → show cycle in §3 (page-instance preservation) |
| `scripts/analysis/needs-human-probe.mjs` | §2 and the headless half of §4 (dialog parking, file input, the window-state CDP call in headless) |

```sh
set PW_CORE_PATH=<path>\node_modules\playwright-core
set CHANNEL=chrome
set MODE=headless            # or headful
node scripts/analysis/hl-compare.mjs
```

Limitations, stated up front: one machine, one Chrome version, one playwright-core version; the §1 numbers depend on that machine's display scaling (1138×537 at DPR 2.25 is *its* window geometry, not a universal constant — the breakpoint flip is the generalisable part).
