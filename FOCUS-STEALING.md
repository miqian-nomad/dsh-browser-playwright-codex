# The minimized window gets yanked back onto the screen / 最小化窗口被自动拽回桌面

Diagnosis of a headful-browser focus-stealing bug in `dsh-browser-playwright` (upstream v0.1.1) and in the Codex-merged fork published in this repository (0.2.0 at the time of the diagnosis; 0.3.0 and later carry the source this document points at).

对 `dsh-browser-playwright`（上游 v0.1.1）以及本仓库发布的 Codex 整合版中"headful 浏览器抢焦点 / 拽回最小化窗口"这个 bug 的诊断（诊断时是 0.2.0；0.3.0 起本仓库有源码，本文的行号指向 `src/`）。

Every claim below is labelled **measured** or **not measured**. Where the evidence is weaker than the conclusion, it says so.

下文每条结论都标注**实测**或**未实测**。证据弱于结论的地方，明确写出来。

---

## TL;DR

Headful + a minimized window + any of these three = the window comes back:

1. `switchTab` → `page.bringToFront()` — **measured**, exists in upstream `src/playwright.ts:505`, patched here.
2. Any tab creation → `context.newPage()` — **measured**, upstream `src/playwright.ts:514/607/614`, patched here. Chromium activates the window on tab creation; sending CDP `Target.createTarget({ background: true })` ourselves avoids it.
3. A post-operation login-state export in this fork (`endOp` → `persistStateSoon` → `context.storageState()`) — **measured on one long-lived live instance (A/B), NOT reproduced in a minimal harness**. Cause unknown; see [Cause 3](#cause-3--fork-specific-and-only-half-understood).

And one case that is *not* the plugin's to fix: a page-side `target="_blank"` link or `window.open()` restores a minimized window, because Chromium's default is that a new tab must be selected **and shown**.

**一句话**：headful + 最小化窗口 + 下列三者之一 = 窗口被弹回来。前两条是插件自己的代码（上游就有），第三条只在这个 fork 上出现过、且最小复现里复现不出。最后一条 `target="_blank"` 是 Chromium 自己的默认行为，插件无权干预。

---

## Environment / 环境

| Component | Value |
|---|---|
| OS | Windows 11 x64 |
| Node.js | v24.16.0 |
| playwright-core | 1.62.1 |
| Browser | Google Chrome 151 (`channel: 'chrome'`); bundled Chromium 1169 also present |
| DSH | 0.1.5-rc.2 profile |
| Affected build | this fork (0.2.0 compiled-only at diagnosis time; source in `src/` since 0.3.0) and upstream v0.1.1 source (`headless: false`) |
| Launch shape | own `chromium.launch()` / `launchPersistentContext()`, `viewport: null` (single shared window) |

---

## Method / 方法

The window state is **read back**, never eyeballed:

- Primary observer: CDP `Browser.getWindowForTarget` → `Browser.getWindowBounds` → `bounds.windowState`, on a CDP session attached to the anchor page. The window is minimized through `Browser.setWindowBounds({ windowState: 'minimized' })`.
- Cross-check (in the original live-instance investigation): a separate PowerShell process polling Win32 `IsIconic(hwnd)` every 500 ms for 120–240 s, with the window minimized by the user or by `ShowWindow(hwnd, SW_MINIMIZE)`, while the plugin's tool calls came from outside the poller. Foreground window (`GetForegroundWindow`) was logged too.

Each probe brackets the action with a state read, and every run includes a **no-op control** ("sleep only") so a probe harness that cannot detect a raise would be visible as such. The control never raised, and the two known-raisers (`newPage`, `bringToFront`) raised on every run — the harness is not blind.

窗口状态是**读回来的**，不靠肉眼：主观察量是 CDP `Browser.getWindowBounds` 的 `windowState`；原始调查还用独立 PowerShell 进程每 500ms 轮询 Win32 `IsIconic` 交叉验证。每轮都带"空转对照"，确保探针不是测不出来。

---

## Minimal reproduction / 最小复现

No DSH, no plugin — pure Playwright + Chromium: [`scripts/analysis/repro-minimize.mjs`](../scripts/analysis/repro-minimize.mjs).

```sh
set PW_MODE=launch          # upstream shape: chromium.launch() + browser.newContext()
set PW_CHANNEL=chrome
set PW_CORE_PATH=<path>\node_modules\playwright-core
node repro-minimize.mjs
```

`PW_MODE=launch` — the shape upstream v0.1.1 uses (`src/playwright.ts:273/283`, `chromium.launch({ channel, headless })`):

```text
mode=launch  playwright-core 1.62.1  node v24.16.0
channel=chrome

safe     baseline: sleep only (3s)                      before=minimized after=minimized
RAISES   context.newPage()                              before=minimized after=normal
safe     CDP Target.createTarget({background:true})     before=minimized after=minimized
RAISES   page.bringToFront()                            before=minimized after=normal
safe     context.newCDPSession(anchor)                  before=minimized after=minimized
safe     context.storageState()                         before=minimized after=minimized
safe     anchor.goto() (same tab)                       before=minimized after=minimized
safe     anchor.screenshot()                            before=minimized after=minimized
```

`PW_MODE=persistent` (the shape this fork uses, `launchPersistentContext`) — **identical results**, every line the same.

**未实测项**：本次最小复现只用 CDP 观察者跑过；原始实机调查里，`newPage` 与 `bringToFront` 两条同时被 Win32 `IsIconic` 独立确认过。

---

## Cause 1 — `switchTab` raises the window unconditionally

**Measured.** Upstream `src/playwright.ts:505` (in `switchTab`):

```ts
this.currentIndex = index
await withAbort(page.bringToFront(), signal)
return this.snapshot()
```

There is no gate. With `headless: true` (upstream's default) there is no window to raise, so the line is invisible; set `launch.headless: false` for login/captcha hand-off — the reason headful exists at all — and every tab switch drags a minimized window back.

Tab selection is a **browser-context** concern: `page.bringToFront()` is the only reason the OS window has to move, and the agent does not need the OS window in front to keep driving the tab. Measured after gating: `snapshot`, `click`, `fill`, `scroll`, `evaluate`, `screenshot` all keep working with the window minimized and never in the foreground.

**中文小结**：上游 `switchTab` 里那句 `bringToFront()` 没有门控。默认 headless 时没有窗口，看不出问题；一旦为了登录/验证码接管而开 headful，每次切标签都会把最小化的窗口拽出来。切标签本来是 context 层的事，不需要 OS 窗口前置——实测门控后所有功能正常。

## Cause 2 — tab creation raises the window

**Measured.** Upstream `src/playwright.ts:514` (`openTab`), `:607` and `:614` (`ensurePage`):

```ts
const page = await this.context.newPage()
```

Playwright's `newPage()` issues CDP `Target.createTarget` **without** `background`, and Chromium's default for a newly created tab is *select it and show it* — which un-minimizes the window. This is browser behaviour, not plugin logic: the probe above reproduces it with no plugin involved at all.

The fix is to send the command ourselves:

```ts
const attached = context.waitForEvent('page', { timeout: 10000 })
await session.send('Target.createTarget', { url: 'about:blank', background: true })
return await attached
```

Two implementation details that were verified live and matter:

- **`background: true` means "do not activate the window" — not "do not select the tab".** With the window visible, the new tab is still selected (`visible` + `document.hasFocus() === true`) and `requestAnimationFrame` fires normally, i.e. no background-tab throttling of the plugin's own stability probe. So the behavioural difference is confined to the minimized case.
- **No delay is needed, but the `waitForEvent('page')` listener must be armed before sending the command** — Playwright attaches as soon as the target exists, which can happen before `createTarget` resolves.

Upstream context for this choice: Playwright issue tracker discussion of `newPage()` stealing OS focus in headed Chromium, where the proposed upstream change is exactly to pass `background: true` to `Target.createTarget`. (Found during the original investigation; the plugin author independently arrived at, and live-verified, the same mechanism.)

**未实测**：`ensurePage` 的两处调用点在本 fork 的持久化模式下未被走过（`:614` 一行还疑似死分支），所以那两处只是"同构改写、保持行为一致"，没有单独做 A/B。

**中文小结**：`context.newPage()` 内部发的 `Target.createTarget` 不带 `background`，Chromium 建标签必激活窗口——这与插件逻辑无关，裸 Playwright 就能复现。改成自己发 `background: true` 即可；实测这个参数只表示"不激活窗口"，不表示"不选中标签"，窗口可见时新标签照常显示且没有后台节流。

## Cause 3 — fork-specific and only half understood

**This is where the evidence is weakest, and it is reported that way.**

In the Codex-merged 0.2.0 fork, the worst symptom was: **every** tool call raised a minimized window, including calls that failed before touching the page at all (a `ftp://` navigation rejected by the URL policy, i.e. parameter validation only). Measured with the Win32 poller, minimized by the user:

```text
t=0      … 30015ms   IsIconic=True     ← includes ~8 s after a MARK with zero tool calls
t=30523ms            IsIconic=False    ← only after the read-only browser_tabs call was issued
```

The only browser-touching step common to every call is the fork's login-state export, which runs after **every** operation (`endOp` → `persistStateSoon` → `context.storageState()`, writes `dsh-storage-state.json` atomically, throttled to 1/s). Gating it on "window minimized" made the raise disappear (A/B on the live instance): read-only calls, pre-navigation failures, scroll, `goto`, `switchTab`, `openTab` all stopped raising.

**But the minimal harness above cannot reproduce it**: `context.storageState()` is safe when minimized, in both `launch` and `persistent` modes, in a fresh process. So either the trigger needs the long-lived multi-tab instance (renderer/CDP state accumulated over hours), or the A/B was confounded by something else that changed at the same time.

**Conclusion:** treat the gate as a *mitigation* that demonstrably stopped the symptom on the affected instance, not as a root-cause fix. This is [help wanted #2](../README.md#help-wanted--求助).

**中文小结**：这个 fork 上最严重的症状是"**每次**调用都弹窗，连参数校验就失败的调用也弹"。唯一每次都跑的浏览器动作是"操作后导出登录态"。把它在最小化时跳过，症状消失（实机 A/B）；但最小复现里 `storageState()` 是安全的，所以这只能算**缓解**而非根治，机制仍未知。

## Remaining — `target="_blank"` / `window.open()`

**Measured.** Clicking a link with `target="_blank"` (or a page calling `window.open()`) restores a minimized window. The tab count went 2 → 3 in the same step; a plain in-page `goto` and a same-tab click did not raise it.

Why the plugin cannot prevent it the way it fixes `openTab`: **the plugin is not the one asking for the tab.** Chromium's default handler for "a page wants a new tab" is to select and show it, and no Playwright API reaches that call. When the plugin creates the tab itself, it can politely ask for `background: true`; when the page does, it cannot.

Known approaches, with their costs (none adopted here):

| Approach | Cost |
|---|---|
| Rewrite `a[target="_blank"]` → `_self` before the click (`addInitScript` / `MutationObserver`) | **Changes the page's declared semantics** (link opens in place instead of a new tab); dynamic links need a re-scan; `window.open()` is unaffected |
| Hook `window.open` in the page | Same semantic rewrite, plus it must run before page scripts; breaks sites that feature-detect it |
| Let the tab open, then re-minimize the window | Needs Win32 (or CDP `Browser.setWindowBounds`) window control; produces a visible flash; fights the browser |
| Do nothing, document it | The user sees the window once per such click |

Recommendation: **document it, and offer opt-in intercepts** — do not silently rewrite page semantics. (This build documents it; no intercept is implemented.)

**Note (the fork's own framing):** this behaviour is not only a cost. It is also the moment the user learns that the agent is now driving a **different** window instead of working out of sight — which is why this build deliberately leaves it as the browser does it, rather than rewriting the page's links. The distinction that matters is *who* raises the window: the plugin's own `switch_tab` / `open_tab` never do (both are gated), only a page's own `window.open()` / `target="_blank"` does — and that one is the page's decision, not the agent's.

**中文小结**：`target="_blank"` / `window.open()` 恢复最小化窗口是 Chromium 的默认行为，插件没法像修 `openTab` 那样传参拦截。已知几种绕法都要付代价（改写网页原意 / 事后压回去会闪），所以本 fork 的取舍是：**插件自己绝不去拽窗口**（切标签、开标签都已被门控），**网页自己要开新窗口时就让它跳出来**——那一下是浏览器的决定，而且它同时是"AI 正在另一个窗口里操作"的可见性提醒。

---

## Where the fixes live now / 这些修法现在在哪

Since 0.3.0 they are ordinary typed source in `src/playwright.ts`, covered by the test suite (`npm test`, `npm run verify`). Before the source tree existed they were hand-patches on the compiled bundle, which a rebuild or an upstream upgrade would have thrown away — that fragility is what the source-release work removed.

| Location | Change |
|---|---|
| `src/playwright.ts:210` `isWindowMinimized(page)` | CDP `Browser.getWindowForTarget` + `Browser.getWindowBounds`; returns `true` when unreadable (never gamble with the user's desktop) |
| `src/playwright.ts:234` `createBackgroundPage(context)` | Arm `waitForEvent('page')`, send `Target.createTarget({ background: true })`, fall back to `newPage()` on any failure |
| `src/playwright.ts:1684` (`switchTab`) | `bringToFront()` is skipped while the window is minimized; behaviour when visible is unchanged |
| `src/playwright.ts:1695` (`openTab`) | Uses `createBackgroundPage()` |
| `src/playwright.ts:681` (`persistStateSoon`) | Login-state export is skipped while the window is minimized (see Cause 3 — a mitigation, not a root-cause fix) |

Verification on the live instance, window minimized throughout, judged by Win32 `IsIconic` (0 = not minimized):

| Step | Action | Result |
|---|---|---|
| 0 | baseline: window minimized, no tool call | `IsIconic = True` (held for 30 s) |
| 1 | `browser_tabs` (read-only) | stays minimized **PASS** |
| 2 | a call that fails before navigation | stays minimized **PASS** |
| 3 | `browser_switch_tab` | stays minimized **PASS** |
| 4 | `browser_open_tab` | stays minimized **PASS** |
| 5 | scroll / click / `goto` | stays minimized **PASS** |
| 6 | click a `target="_blank"` link | **raises** (Cause 4, unfixed) |
| 7 | control: `page.bringToFront()` | **raises** → proves the probe can detect a raise |

Side note from the same session, worth knowing: with the window **already restored**, `bringToFront()` did **not** steal the foreground (Windows foreground lock). So on this setup the only externally visible effect of the un-gated call was "un-minimize the window" — which is exactly the reported symptom.

## For upstream / 给上游的东西

[`patches/upstream-window-activation.patch`](../patches/upstream-window-activation.patch) — applies cleanly to upstream `main` (`git apply --check` clean), **61 insertions, 5 deletions, one file** (`src/playwright.ts`):

- adds `isWindowMinimized()` and `createBackgroundPage()` as module-level helpers,
- gates `switchTab`'s `bringToFront()` on the window not being minimized,
- routes `openTab` and both `ensurePage` fallbacks through `createBackgroundPage()`.

**What is verified, and what is not:** the helper bodies are no longer hand-written JS inside a bundle — since 0.3.0 they are typed source in this repository's `src/playwright.ts`, type-checked (`tsc --noEmit`, strict) and exercised by the test suite and by `npm run verify`. What remains unverified is the patch *as applied to upstream's tree*: it has not been compiled there, and upstream's own test suite has not been run against it. `git apply --check` is clean; nothing beyond that is claimed.

## Prior art — how products avoid this entirely / 成熟产品怎么做

**Not measured here; gathered from public sources during the original investigation.** Nobody who ships an agent browser lets the user "minimize it to get it out of the way":

- **Codex (OpenAI)** and **Claude for Chrome (Anthropic)**: no browser of their own — a Chrome extension plus a native-messaging host drive *the user's own Chrome profile*. There is no second window to steal focus from.
- **ChatGPT Atlas / 豆包 PC**: they ship their own Chromium-based browser, but it is the browser the user is actively using — the window is the point, not a side effect.
- **`NousResearch/hermes-agent`**: a commit titled *"real-profile browsing runs headless — no focus-stealing window"* — the real-profile browser went **headless by default**, with an explicit opt-in to show it. `--headless=new` keeps the real cookie store, so "headless means no real login" is a legacy-headless claim.
- **Cloud VMs (Operator/Manus class)**: the window is not on the user's desktop at all.

The structural suggestion for a plugin in this fork's position: **make visibility an explicit choice rather than a side effect** — do the work without moving the user's desktop, and bring a window up only when a human is genuinely required. Note that this is *not* automatically "default to headless": that switch has costs of its own, measured in [`MODE-TRADE-OFFS.md`](MODE-TRADE-OFFS.md), and only captcha/challenge hand-off truly needs a visible window (**native dialogs do not** — corrected, see that document's §2).

**中文小结**：Codex / Claude for Chrome 寄生在用户自己的浏览器里；Atlas / 豆包 自带浏览器但用户主动在用；hermes-agent 把真实 profile 的浏览器**默认改回 headless**，要看再显式开（`--headless=new` 照样带真 cookie）。没人做"摆在桌面上、让用户靠最小化去躲"的浏览器。对本插件最结构化的建议是：**把"可见性"变成显式选择，而不是副作用**——但这**不等于**"默认 headless"，那条路的代价见 [`MODE-TRADE-OFFS.md`](MODE-TRADE-OFFS.md)；真正必须可见窗口的只有验证码/风控挑战（**原生对话框不需要**，已更正）。

---

## Limits of this evidence / 证据边界

- All measurements are from **one machine** (Windows 11 x64, one Chrome version, one playwright-core version) and mostly from **one long-lived instance**. Chromium window-activation behaviour is documented as Chromium-wide, but nothing here was cross-platform tested.
- The plugin-free probe observes through CDP window bounds; the live-instance table observes through Win32 `IsIconic`. They agree on every point where both were used. Neither is a video recording.
- Cause 3 is a **mitigation with an unreproduced mechanism** — do not read it as a proven root cause.
- The `background: true` "does not select the tab" nuance was measured with the window visible; its behaviour on other Chromium versions/platforms is unverified.
- No upstream test suite was run against the patch.
