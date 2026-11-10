# 那个动效脚本，从零读懂

> 对象：`assets/swarm-rebuild.upstream.js`（上游原版，3,826 行 / 149 KB）
> 它做的事一句话：**把当前页面拍成蓝图，抹白，然后让一群假光标一笔一笔把蓝图重画出来。**
> 本文按"从零"的顺序写：先骨架，再六个概念，再一条完整时间线，最后才是细节和坑。

---

## 一、它不是"动画特效"，是"现场重建"

很多人第一眼以为这是个 canvas 动画。不是。它的做法是：

1. 读真实页面 → 算出每个框、每段字、每张图的位置和样式（**蓝图**）；
2. 把页面抹白；
3. 用影子 DOM 里的光标，把蓝图上每一项**逐个再画出来**：方框是十字光标拖出来的，文字是真字体一个一个字打出来的，图片是原图裁出来贴上去的。

所以它天然依赖两件事：**能读到 DOM 和样式**，**页面在重建期间不能乱动**（这正是"滚动就卡住"的根源，后面讲）。

---

## 二、骨架：一个 IIFE，四个模块

整个文件是一个立即执行函数，里面只有四块东西：

| 模块                               | 位置      | 职责                                          |
| ---------------------------------- | --------- | --------------------------------------------- |
| **采集** `captureModel(env, shot)` | 491–1450  | DOM → 蓝图（items / tasks / groups / guides） |
| **渲染** `class View`              | 1618–2096 | 影子树、样式、每帧把引擎状态画成 DOM          |
| **调度** `class Engine`            | 2097–3066 | 任务队列、光标群、协程驱动、进度计算          |
| **音效** `class Sound`             | 3067–3461 | WebAudio 现场合成（没有音频文件）             |
| **编排** `class App`               | 3462–3826 | 启动时序、帧循环、快捷键、进出场              |

辅助函数都在 `captureModel` 前后：`cursorSVG`（画光标形状）、`prepClone/cloneStyled`（克隆节点并内联样式）、`pseudoClone`（把 `::before/::after` 变成真节点）、`cropShot`（从截图里裁一块）、`canvasPixels`（把 canvas 内容抠成图）。

---

## 三、六个必须懂的概念

### 1. `env`：页面在哪、滚到哪了

`detectEnv()`（1549）找出**真正在滚的那个容器**（可能是 `window`，也可能是某个 `overflow:auto` 的 div），之后所有坐标都换算成"蓝图坐标"：
`vpx = x - ox + sx`（`geom()` 给的 `ox/oy/sx/sy`）。这一层抽象是它能处理"整页滚动"和"局部滚动"两种站点的原因。

### 2. `item`：蓝图里的一项

```js
{ id, type: 'box'|'text'|'image'|..., x, y, w, h,   // 位置
  node,        // 原始 DOM 节点（用来拿内容/样式）
  live,        // 已经克隆好、等着被"一个字一个字显示"的那份副本
  units, seq,  // 文字被拆成的单元序列（打字机用）
  shown, total // 进度
}
```

### 3. `task`：一个待执行的动作

```js
{ spec: { type: 'rect'|'image'|'line'|'text'|'guide'|'dup'|'edit'|'restyle', it, g, k },
  state: 'wait' | 'active' | 'done',
  layer: 'world' | 'intro',   // world = 文档层（要滚动才能到），intro = 首屏
  gate,                       // 只有滚动到 gate 之后才允许开工（可理解为"解锁线"）
  deps }                      // 依赖：前面这些任务做完才能开始
```

### 4. `gate / frontier`：为什么"不滚就画不完"

`available()`（2256）只放行 `t.gate <= this.frontier` 的任务；`frontier` 是"用户已经滚到过的位置"（`step()` 里每次把 `viewBot` 抬上去）。
**这就是"页面卡在第一屏、下面的框叠上来"的根本原因**：蓝图是整页的，但下半页的任务被 gate 挡住；如果强制让它滚动（Tour），画面又和蓝图错位。

### 5. `cursor`：假光标

```js
{ id, name, color,              // 名字和颜色按序号取（NAMES / COLORS）
  x, y, vx, vy, angle,          // 位置与速度
  shape: 'arrow'|'cross'|'pen', // 空闲 / 拖框 / 画线
  task, gen, ov,                // 手上的任务、生成器、覆盖层
  speed, force, spin, curl, orbit }
```

它们的移动不是"动画曲线"，而是**每帧朝目标加速 + 一点随机扰动**（`follow` / `flock`），所以看起来像一群真人在乱飞。

### 6. 生成器协程：一个动作怎么写出来

关键设计：每个动作都是 `function*`（生成器）。`drawBox`（2680 起）：

```js
*drawBox(c, it) {
  c.shape = 'cross'
  yield* this.moveTo(c, {x: it.x, y: it.y})   // 移过去（每帧只前进一点，然后 yield）
  c.press = 1                                  // 按下
  it.vis = true; it.draw = {w: 0, h: 0}         // 开始拖
  const end = this.dragEnd(c, it)
  yield* this.moveTo(c, end, { drag: true, onStep: () => { it.draw.w = ... } })  // 拖着画
  c.press = 0
}
```

`moveTo` 不是"一帧到位"，而是**每次只走一小步就 `yield` 回调度器**。所以一个光标"忙不忙"由它手上有没有生成器决定，而"画到哪了"由 item 上的 `draw.w/h` 决定——**渲染层完全不需要知道动作逻辑**。

---

## 四、一次播放的完整时间线

```
App.run()                                      (约 3490)
  ├─ 建影子树、塞样式、显示背景            → view.bg.classList.add('on')
  ├─ await sleep(520)                       → 让人看清"被抹白"的那一下
  ├─ await unhidePage()                     → 把真实页面隐藏（之前是可见的）
  ├─ await this.scan()                      → captureModel：DOM → 蓝图
  ├─ await document.fonts.ready（最多 1.2s）→ 不然文字会按错误字宽排版
  └─ engine.setModel(model) → engine.start()

每帧 frame()                                    (3649)
  ├─ engine.step(dt)      → 更新光标、发任务、推进生成器、算 frontier/tempo
  ├─ view.render(engine)  → 把状态画成 DOM（真正的"画面"）
  └─ updateHud()          → 控制条进度（我们已删掉这一段）

engine 判定完成                               (2306 附近)
  ├─ 所有任务 done、没有光标在忙 → flocking = true
  └─ onComplete() → 弹出 Go live / Replay，播收尾音

stop(false) / stop(true)                        (3791)
  ├─ false = 立即：取消 RAF、解绑、移除宿主
  └─ true  = 淡出 1.15 秒再移除（"Go live"那条路）
```

---

## 五、采集层难在哪（`captureModel`，约 960 行）

它要处理的东西，每一条都能让"看起来一样"变成"看起来不像"：

- **样式内联**：把 `getComputedStyle` 读到的几十个属性写进克隆节点的 `style`，否则克隆出来是裸 HTML。
- **伪元素**：`::before / ::after` 在 DOM 里不存在，得查样式、生成真节点插进去（`pseudoClone`）。
- **SVG**：`<use xlink:href="#id">` 引用会被克隆打断，得重写 id（`fixSvgRefs`）。
- **裁剪**：元素被祖先 `overflow:hidden` 切成什么形状，要算出来（`clipFor`）。
- **固定/粘性定位**：屏幕坐标和文档坐标不一样，得单独记（`layer: 'intro'`）。
- **重复组件**：一个列表 20 行长得一样，不能真画 20 遍，会被归组后"复制粘贴"（`dup` 任务）。
- **文字**：要按行、按字拆（`prepText`），先全部清空，再按 `seq` 一个字一个字显示（`reveal`）。
- **媒体**：图片能重新加载就重新加载；`canvas`、`video`、跨域 `iframe` 抓不到 DOM 内容，只能靠**截图裁一块**（`cropShot(shot, r)`）——这就是扩展为什么要先截一张图。

---

## 六、渲染层：为什么用真 DOM 而不是 canvas

`View.renderItem`（1796）把每个 item 画成真实节点：

- 方框 → 一个绝对定位的 div，尺寸跟着 `it.draw.w/h` 实时变；
- 文字 → 就是**真字体、真字重的克隆节点**，靠 `Visibility` 一个字一个字露出来；
- 光标 → 一个内联 SVG（`cursorSVG`），三种形状；
- 参考线 / 尺寸标注 → 单独一层（`renderRulers`）。

好处：观感是"真的"，和原页一模一样。
代价：几千个 DOM 节点，重站会明显掉帧 —— 这条在低配机器上是真实的性能瓶颈。

---

## 七、音效：没有音频文件

`Sound`（3067）全部是 WebAudio 现场合成：

- `piano()`：几个振荡器 + 包络，模拟钢琴；
- `clack() / tick()`：滤波噪声，模拟鼠标与键盘；
- `place()`：按元素的大小、位置算音高和声像（左边的东西声像靠左）；
- `finale() / intro()`：和弦与渐强。

所以我们删控制条后，"关声音"这个入口也没了——它默认开着，需要静音得自己想办法（`sfx.setOn(false)`）。

---

## 八、对外接口与生命周期

文件末尾（3811 起）：

```js
window.__swarmRebuild = {
  toggle(),        // 开着就关、关了就开
  start(),         // 建一个 App 并 run()
  stop(reveal),    // reveal=true 淡出、false 立即
  get app(),       // 当前 App（拿内部状态用）
  debug: { captureModel, detectEnv, Sound }
}
start();           // 注入即开播
```

**注入即开播**——这也是我们插件能在导航后直接"放一遍"的原因；不需要点任何按钮。

---

## 九、读它的顺序（建议 4 天）

1. **看画面从哪来**：`App.run`（3490）→ `frame`（3649）→ `View.render`（2079）→ `renderItem`（1796）。先弄清"每帧画什么"，其余都是喂给它数据。
2. **看数据从哪来**：`detectEnv`（1549）→ `captureModel` 的开头 100 行（491–590）→ 结尾的 `tasks` 组装。不必读那 960 行的每个分支。
3. **看动作怎么发生**：`Engine.step`（2297）→ `available/pick`（2256/2272）→ `run`（2641）→ `drawBox`（2680）/`drawText`/`drawLine`。重点体会"生成器每帧推一点"。
4. **看它怎么结束**：`onComplete`（3714）→ `destroy`（3731）→ `stop`（3791）。

---

## 十、已知脆弱点（读的时候会撞上）

1. **必须能滚动才能画完**：`gate/frontier` 机制导致"不滚就只画第一屏"。强制滚动又会和蓝图错位——这就是我们**不点 Tour** 的原因。
2. **`position: fixed` / `sticky`**：进 `intro` 层，坐标算法另一套。
3. **跨域 iframe、canvas、video**：DOM 抓不到内容，只能靠截图；没截图就是占位块。
4. **严格 CSP 站点**：影子树里的 `<style>` 会被挡，整份样式失效（我们因此判定"这页不播"）。
5. **长页面 + 慢机器**：几千个 DOM 节点逐帧改样式，掉帧明显。
6. **字号/缩放敏感**：字体没就绪就扫描，字宽会算错（所以有 `document.fonts.ready` 这段等待）。

---

## 十一、我们改了什么（7 处，见 `scripts/swarm-patch.mjs`）

1. 删掉它自带的底部控制条（速度 / Tour / Go live / ✕）；
2. 控制条那四个字段（`hud/status/barFill/dots`）指向**离屏哑元素**，这样下游代码照写不误、屏幕上看不见；
3. `updateHud()` 发现控制条不在文档里就整段跳过（省掉每 200ms 的白工）；
4. 播完那一下原本要设置四个按钮的显示状态，改成"找到才设"，避免空指针；
5. 扫描前先等 `__dshSwarmGo`：扫描会滚一遍页面、和插件的"拍快照"抢，插件要先把快照拿到手再放行；
6. 去掉白底 `.5s` 淡入：`document_start` 提前注入时，那半秒里原页面会透出来；
7. 结尾自启动改成"等 `<html>` 出现再启动"：`document_start` 时 `scrollingElement` 还是 `null`，`detectEnv` 会抛错、白底全无。

改动只碰这七处；蓝图层、引擎层、渲染层**一行没动**。原始文件留在 `assets/swarm-rebuild.upstream.js`，随时可 diff。

> 第 5–7 处是补丁扩写后加的，此段一度仍写"4 处"——现在由 `tests/swarm-contract.test.ts` 对着 `TRANSFORMS` 的长度核对，写错会红。
>
> 接口层面的东西（控制条 class、调速按钮选择器、停止函数挂在哪、上游改版怎么核对）另见 **[SWARM-CONTRACT.md](./SWARM-CONTRACT.md)**：那份讲"我们捏着上游的哪几个把手"，这份讲"上游内部是怎么转的"。
