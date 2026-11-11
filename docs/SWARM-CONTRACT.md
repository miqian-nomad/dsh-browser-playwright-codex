# swarm 资产：接口契约

> 这份文档回答一个问题：**插件到底捏着上游脚本的哪几个把手？上游改版时，我该核对什么？**
>
> 真值源是 `src/swarm-contract.ts`（代码），校验是 `tests/swarm-contract.test.ts`（跑 `npm test` 必过）。
> 本文是给人读的那一份，内容和代码由测试强制对齐 —— 文档里提到某个选择器，契约里没声明，测试就红。

---

## 〇、先说结论：这份资产**不能** fork

之前想"fork 一份自己的版本"来防上游改版。查完事实，这个思路两头都不成立：

| 想法                       | 事实                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fork 一下就有自己的版本了  | 上游 `DhvanilPatel/swarm-cursors` **根目录没有 LICENSE**，默认保留所有权利。fork 不改变任何授权，只是多出一份**同样没有许可**的副本，法律地位和现在完全一样     |
| 上游改版会让我这边突然失效 | **不会**。脚本是 vendored 进来的，`scripts/swarm-patch.mjs` 用 SHA-256 锁死基线。上游在 GitHub 上改成什么样，本地这份一个字节都不会动。换文件是**人的主动动作** |
| 所以需要一份文档来兜       | **这一条成立**，而且是唯一成立的那条。真正的风险不是上游改版，是插件对上游内部结构的二十多处依赖**没有任何声明**，坏的时候不会报错，只会"某个页面某天不播了"    |

所以这份文档做的是第三件事：**把接口分层声明、把核对流程固定下来、把每一步交给测试**。资产在 0.8.1 起重新随包分发（已获作者书面许可），`src/config.ts` 里 `swarm.enabled` 仍然默认 `false`。

上游 issue #12（询问授权）2026-11-08 提出；2026-11-11 Dhvanil Patel 邮件书面许可本项目**打包与修改**，所以 tarball 里重新有 `assets/swarm-rebuild.js`（原始基线仍只留在仓库）。许可不是 MIT，也没有 MIT 许可文本：它只覆盖本项目，第三方不能据此复用。要改分发状态，先看这页的授权记录，再动 `package.json#files`。

---

## 一、指纹

| 项                       | 值                                                                 |
| ------------------------ | ------------------------------------------------------------------ |
| 上游仓库                 | `DhvanilPatel/swarm-cursors`                                       |
| 入仓基准（**未打补丁**） | `assets/swarm-rebuild.upstream.js`                                 |
| 基准 SHA-256             | `6a30f19daaa182d52673035feaeae775c398fa426655cc71a87a451fe00c7bfe` |
| 随包产物（已打补丁）     | `assets/swarm-rebuild.js`                                          |
| 补丁脚本                 | `scripts/swarm-patch.mjs`                                          |
| 授权                     | **上游无 LICENSE**（保留所有权利）；本项目持有 Dhvanil Patel 2026-11-11 邮件书面许可（打包 + 修改）与 Joel Califa 2026-11-08 书面许可（效果 + 署名）。不是 MIT，第三方不能据此复用 |

`swarm-patch.mjs` 里的 `UPSTREAM_SHA256` 必须与上表逐字符相同。**两处各写一份哈希，是这个仓库最典型的漂移点**，所以测试会直接比对（`fingerprint: the patch script and the contract agree on the upstream hash`）。

---

## 二、三层接口

上游脚本暴露的东西，按"会不会被我们的补丁动到"分三层。**分层不是学术分类，是排查顺序** —— 出问题时先看哪层，决定你改代码还是改选择器。

### Tier A：硬接口 —— 插件主路径，补丁一处没碰

上游自己挂的 `window` 句柄。这是整份契约里**唯一不能变**的部分：它一变，插件立刻坏。

上游的暴露机制（原样引用）：

```js
const KEY = "__swarmRebuild";
if (window[KEY]) { window[KEY].toggle(); return; }
// ...
window[KEY] = { toggle() { ... }, stop(...) { ... }, ... };
```

| 接口                      | 形状                               | 插件拿它做什么                                             | 坏了会怎样           |
| ------------------------- | ---------------------------------- | ---------------------------------------------------------- | -------------------- |
| `window.__swarmRebuild`   | object                             | 一切的总入口                                               | 全部失效             |
| `.toggle()`               | `() => void`                       | 插件不用（第二次注入时上游自己调）                         | 无影响               |
| `.stop(reveal)`           | `(reveal?: boolean) => void`       | **退出主路径**，传 `false`                                 | 覆盖层留在页面上     |
| `.app`                    | object                             | 下面四个字段的容器                                         | 全部失效             |
| `.app.engine.speed`       | `number`（初值 `1`）               | **调速**：直接写 `1 + clicks`                              | 动画不提速           |
| `.app.engine.start()`     | `() => void`                       | 整页模式启动                                               | 整页模式不滚         |
| `.app.engine.started`     | `boolean`                          | 已是 `true` 就别重复 `start()`                             | 可能重复启动         |
| `.app.env.geom()`         | `() => { ox, oy, sx, sy, vw, vh }` | **记真实滚动位置**（局部滚动页里 `window.scrollY` 恒为 0） | 播完页面停在中途     |
| `.app.env.scrollTo(y, x)` | `(y, x) => void`                   | 播放结束还原位置                                           | 页面被扔在半路       |
| `.app.view.root`          | `ShadowRoot`                       | 找影子树的**首选**路径                                     | 退化到全页扫描（慢） |
| `.app.root`               | `ShadowRoot`                       | 找影子树的次选路径                                         | 同上                 |
| `.app.tour`               | `boolean`                          | **整页模式**：直接置 `true`，不点按钮                      | 只画当前一屏         |
| `<swarm-rebuild>`         | 自定义元素                         | `document.querySelector` 直接 remove 宿主                  | 覆盖层残留           |

**`stop()` 的参数语义必须分清**（这条单独拎出来，因为踩过坑）：

| 调用          | 上游语义                           | 观感        | 插件用不用            |
| ------------- | ---------------------------------- | ----------- | --------------------- |
| `stop(false)` | 立即 `destroy`：取消 RAF、移除宿主 | 瞬断        | **用**，AI 要立刻让路 |
| `stop(true)`  | 淡出到真页面（原 "Go live" 按钮）  | 淡出 1.2 秒 | **不用**              |

用 `true` 的后果不是"慢一点"：那 1.2 秒里覆盖层仍然接着命中测试，后续点击直接超时（2026-11-08 实测）。

### Tier B：兜底口 —— 上游原生，但**已被补丁删掉**

控制条。上游有，`swarm-patch.mjs` 第 1 处改动整个删了它。

**关键：这一层的"存在"和"生效"是两件事。** 插件里 `querySelector('[data-a="speed"]')` 那类分支永远拿到 `null`，实际走的全是 Tier A。留着它们只为一种情况：有人把**未打补丁的原版**塞回 `assets/`，插件仍然能用（点按钮），而不是当场白屏。

> 实测（2026-11-10）：`data-a=` 在上游文件里 11 处，补丁后的文件里只剩 2 处 —— 剩余的是 `[data-a="sound"]`（有 `if (!b || !this.sfx)` 防护）和一处 `name` 拼接的通用选择器。

**DOM 结构**（上游原版，控制条整块）：

```html
<div class="hud on">
  <div class="dots">…</div>
  <!-- 头像组 -->
  <span class="status">…</span>
  <!-- 状态文字 -->
  <div class="bar"><i></i></div>
  <!-- 进度条 -->
  <button data-a="tour">Tour</button>
  <button data-a="speed">1×</button>
  <button data-a="sound" class="snd"></button>
  <button data-a="live" class="pri" hidden>Go live</button>
  <button data-a="replay" hidden>Replay</button>
  <button data-a="close" class="x">✕</button>
</div>
```

| 选择器              | 含义                   | 插件是否真的用                                                 |
| ------------------- | ---------------------- | -------------------------------------------------------------- |
| `.hud`              | 控制条容器             | **仅用于判存**（`findRoot` 扫描、`hadHud` 判断要不要挂观察者） |
| `.hud .dots`        | 头像组                 | 不用                                                           |
| `.hud .status`      | 状态文字               | 不用                                                           |
| `.hud .bar i`       | 进度条                 | 不用                                                           |
| `[data-a="tour"]`   | 整页自动滚动           | **不点**（改 `app.tour = true`）；上游代码自己也查询它         |
| `[data-a="speed"]`  | 帧速 1×→2×→3×          | **仅兜底**（主路径写 `engine.speed`）；上游自己也查询它        |
| `[data-a="sound"]`  | 声音开关               | 不用；上游自己也查询它                                         |
| `[data-a="live"]`   | Go live = `stop(true)` | **兜底退出**，顺序第一；上游自己也查询它                       |
| `[data-a="replay"]` | 重播                   | 不用；上游自己也查询它                                         |
| `[data-a="close"]`  | ✕ = `stop(false)`      | **兜底退出**，顺序第二；**上游代码从不查询它**，见下           |

> **`close` 是个反例，值得单独记。** 上游 HTML 里确实渲染了 `<button data-a="close" class="x" title="Exit (Esc)">✕</button>`，但它的代码里 `querySelector('[data-a="close"]')` **一次都没有** —— 点击走的是事件委托。
> 也就是说这一条选择器是**我们自己声称有效**的，靠的是 DOM 里真有这个属性，而不是上游验证过。
> 这不影响它现在能用，但上游哪天把 `data-a` 换成别的属性名、模板和查询代码不同步改的时候，差别正好落在这里。
> 契约里 `upstreamQuery: false` 标的就是这件事，测试会核对上游文件的真实情况 —— 不是靠记性。

插件自己往影子树里插的标记（这两个是**我们的**，不是上游的）：

| 名                    | 值                             | 作用                                      |
| --------------------- | ------------------------------ | ----------------------------------------- |
| `data-dsh-swarm-hide` | `1`                            | 隐藏规则 `<style>` 的标记，重试时据此判重 |
| 规则文本              | `.hud{display:none!important}` | 压住控制条，连**以后重建的节点**一并压    |

隐藏走双层：① 写内联样式（`style-src` CSP 下仍生效）；② `<style>` 规则（压住重建节点）。`MutationObserver` **只在真的有 `.hud` 时才挂** —— 动画每帧大改影子树，没控制条还挂观察者会把主线程吃满、引擎看着"没进展"（2026-11-09 实测：停在 32 个图层）。

### Tier C：自造桥 —— 插件注入的，上游永远不会提供

这一层和上游改版**无关**（上游根本不认识这些名字）。它坏通常是插件自己重构漏了赋值，所以更需要测试，而不是文档。

| 全局名                | 类型         | 谁写                                  | 谁读                             | 作用                                                     |
| --------------------- | ------------ | ------------------------------------- | -------------------------------- | -------------------------------------------------------- |
| `__dshSwarmStop`      | `() => void` | `swarm-intro.ts`                      | `stopSwarm()`                    | **停止函数挂载点**：先试它，再退到 `__swarmRebuild.stop` |
| `__dshSwarmStart`     | `{ x, y }`   | `swarm-intro.ts`、`swarm-curtain.ts`  | `restoreScroll()`                | 播放前的滚动位置；局部滚动页由 `env.geom()` 覆盖         |
| `__dshSwarmEarly`     | `boolean`    | `swarm-curtain.ts`（`addInitScript`） | `playSwarm()`、`swarm-patch.mjs` | 引擎已提前起来，**绝不能再注入第二遍**                   |
| `__dshSwarmAiWorking` | `boolean`    | `stopSwarm()`                         | ——                               | AI 已在用页面，整页滚动循环看到就停                      |
| `__dshSwarmGo`        | `boolean`    | 快照逻辑                              | `swarm-patch.mjs`（第 5 处）     | 快照已到手，放行扫描                                     |

### 附：上游自带的诊断钩子（不是我们的，别误认）

`__swarmShot`、`__swarmSfxLog`、`__swarmHidden`、`__swarmUnhide`。

插件**不依赖**它们，列出来只为两件事：① 调试时知道这些名字姓谁；② 上游改版时若它们消失，说明改动面比预期大，值得警觉。

---

## 三、停止函数挂在哪（单独回答）

问的是"停止函数挂在哪"，答案是**两个位置，先 A 后 B**：

```ts
// stopSwarm() 里的实际顺序
const w = window
if (typeof w.__dshSwarmStop === 'function')
  w.__dshSwarmStop() // ① 我们的桥（Tier C）
else if (typeof w.__swarmRebuild?.stop === 'function') w.__swarmRebuild.stop() // ② 上游句柄（Tier A）
// 然后无条件：移除所有 <swarm-rebuild> 宿主
for (const host of document.querySelectorAll('swarm-rebuild')) host.remove()
```

而 `__dshSwarmStop` 内部（`swarm-intro.ts` 的 `HIDE_CONTROLS`）又按这个顺序：

1. `__swarmRebuild.stop(false)` —— **补丁后的正常路径**
2. 兜底：`[data-a="live"]` → `[data-a="close"]` —— **只在原版被塞回时走**

最后那句 `host.remove()` **不是冗余**：资产退出时先恢复页面、再淡出 1.2 秒才移除宿主，那 1.2 秒里覆盖层还在，命中测试会判成"被遮挡"（实测点击直接失败）。所以直接摘掉。

---

## 四、上游改版怎么办

**前提：这必须是你主动的动作。** 本地日常开发不需要做任何事 —— vendored 文件不会自己变。

按顺序走，别跳：

| 步  | 动作                                                                            | 看到什么就该警觉                                                                               |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | `npm run swarm:patch`                                                           | SHA 不符会**当场拒绝**并报出新旧两个哈希。先看这一条，别急着改补丁                             |
| 2   | 同步两处哈希：`SWARM_UPSTREAM.sha256` 与 `swarm-patch.mjs` 的 `UPSTREAM_SHA256` | 只改一处，测试红                                                                               |
| 3   | `node --test tests/swarm-contract.test.ts`                                      | 它逐条去新文件里找 Tier A/B 的每个名字                                                         |
| 4   | 分流红的项                                                                      | **Tier A 红 → 必须改代码**；Tier B 红 → 通常只改选择器；Tier C 红 → 插件自己的 bug，与上游无关 |
| 5   | `npm test` 全量                                                                 | `swarm-intro.test.ts` 用假 page 校验调用序列，能抓到"注入流程被打乱"                           |
| 6   | 更新 `docs/SWARM-CODE.md`（改了几处、为什么）和本文的指纹段                     | `SWARM-CODE.md` 的改动数由测试对着 `TRANSFORMS` 数，写错会红                                   |

第 3 步是这份契约的核心价值：**它把"上游动了什么"变成一张逐条的清单**，而不是让你打开两个 15 万字符的文件肉眼 diff。

---

## 五、为什么补丁是 7 处而不是 4 处

`docs/SWARM-CODE.md` 曾长期写"改动 4 处"，而 `swarm-patch.mjs` 的 `TRANSFORMS` 早就是 7 处。这份文档正是上游改版时的核对依据，数字一漂，整个应急流程就建在假前提上。

7 处分别是（`why` 取自补丁脚本）：

| #   | 改动                                 | 为什么                                                                         |
| --- | ------------------------------------ | ------------------------------------------------------------------------------ |
| 1   | 删掉自带底部控制条                   | 插件自动播放，它只是噪音                                                       |
| 2   | 控制条上的节点换成离屏哑元素         | 下游代码还在写这些节点，换掉就不用改它们                                       |
| 3   | `updateHud` 检测控制条不在就整段跳过 | 否则每 200ms 白烧 CPU 拼 `innerHTML`                                           |
| 4   | 播完设按钮显隐那段加存在性判断       | 按钮没了会空指针，实测动画一结束就抛                                           |
| 5   | 扫描前等 `__dshSwarmGo`              | 扫描会和插件"拍快照"抢；开场至少停 2.8 秒、最多 5 秒                           |
| 6   | 去掉白底 `.5s` 淡入                  | `document_start` 提前注入时那半秒会透出原页面（用户最介意的那一下）            |
| 7   | 自启动改成等 `<html>` 出现再启动     | `document_start` 时 `scrollingElement` 还是 `null`，`detectEnv` 会抛、白底全无 |

改动只碰这些；**蓝图层、引擎层、渲染层一行没动**。所以 Tier A 完好无损 —— 这不是运气，是补丁一直刻意只碰"控制条 / 过渡 / 启动时机"这三样。
