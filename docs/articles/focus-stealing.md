# AI 开着浏览器**抢你的焦点**：三个根因，都追到了源码

> 长尾定位：搜「dsh 浏览器 抢焦点 / 最小化」的人，正在被这件事烦。
> 结论先行：**有三个独立原因**会让那个窗口自己跳出来，其中两个在 Playwright 上游、一个在我们这层的持久化实现里。
> 三个都修了，而且每个都有可复现脚本，不靠感觉。

## 现象

你有头模式跑一个浏览器 agent：明明把它最小化了，去干别的；过一会儿它自己跳到你眼前 ——
有时是切标签，有时是开新标签，有时是**你什么都没做**。

## 根因（逐条）

| # | 触发 | 代码层原因 | 处理 |
|---|---|---|---|
| 1 | **切标签** | `switchTab` 无条件调用 `page.bringToFront()`（上游 `src/playwright.ts` 里就有这行） | 最小化时**跳过**激活，只切内部索引 |
| 2 | **开新标签** | `context.newPage()` —— Chromium 建标签**必然激活窗口** | 改走 `Target.createTarget({ background: true })`（CDP 后台建页） |
| 3 | **什么都不做** | 持久化方案「每次操作后导出登录态」→ Playwright 的 `storageState()` 会**开一个临时页面**导航到未覆盖的 origin | 最小化时**跳过完整导出**，只取 cookies |

第 3 条是最隐蔽的：**你以为是"它自己跳"，其实是它为了保存登录态自己开了个隐藏页面。**
完整的四环机制（含 `storageState` 源码行号）写在 [`FOCUS-STEALING.md`](../../FOCUS-STEALING.md)。

## 怎么证明（不靠我说）

仓库里有一个 60 行、**不依赖本插件**的复现脚本：

```sh
node scripts/analysis/repro-minimize.mjs
```

它只做一件事：用 CDP 读窗口状态（`Browser.getWindowForTarget` → `getWindowBounds` → `windowState`），
在任何「应该保持最小化」的动作前后各采一次。输出形如：

```
BEFORE  minimized
switchTab →  RAISES   page.bringToFront()
AFTER   normal
```

**这正是我们在 CI 之外还留着它的理由**：任何一条新加的窗口相关行为，都能在 10 秒内被它证伪。

## 一个刻意的例外：网页自己开的新窗口，我们**不拦**

网页里 `target="_blank"` 的跳转跳到前台，是 Chromium 的默认行为。要拦它就得摘掉
`target` 或劫持 `window.open` —— **那是在偷改网页的跳转方式**，我们不做。

而且它有一个真实的副作用是好的：**你立刻知道 AI 正在"那个新窗口"里操作**，而不是在你看不见的地方动。
「AI 在哪动手你随时看得见」是这个插件的核心承诺之一。

## 你可以自己验的三件事

```sh
dsh plugin --profile web add github:miqian-nomad/dsh-browser-playwright-codex
npm run verify     # 57 项自包含验收：不联网、不需要 DSH
```

1. 最小化窗口 → 让 AI 连续切几次标签 → 窗口**仍然是最小化的**；
2. 让 AI 开一个新标签 → 同上；
3. 关掉 DSH 再打开 → **登录状态还在**（这条同时验证了第 3 个根因的修法没把导出搞坏）。
