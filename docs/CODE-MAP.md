# 代码地图：从零读懂这个项目

> 给"想自己读懂全部代码"的人看的阅读顺序与分层说明书。
> 源码 40 个文件 / 约 10,478 行，测试 29 个 / 约 7,230 行，设置界面 1 个 / 1,229 行。
> 别从 `page-actions.ts` 那 853 行开始 —— 那是最后一站。

---

## 一、一句话：这个包是什么

一个 DSH 插件，让模型能操作**你桌面上那个已经登录的浏览器**：拍快照 → 用 ref 点击/填表 → 截图。
它自己不发请求、不存密码、不替你点弹窗。所有能力都通过 Playwright 驱动一个持久化的浏览器 profile。

---

## 二、入口：三个包入口 + 一个插件入口

`package.json` 的 `exports` 决定外部能看到什么：

| 入口 | 文件 | 作用 |
|---|---|---|
| `.` | `src/index.ts` | 公共导出（类型 + 几个纯函数）。给外部 import 用的门面 |
| `./plugin` | `src/plugin.ts` | **真正的加载入口**。一个包只能有一行 loader，它把三块挂成子插件 |
| `./service` `./playwright` `./tool` | 三个子模块 | 各自保留原配置 schema 与 `apply()`，给测试 / 验证脚本单独用 |

`plugin.ts` 是本项目最重要的一个设计决定，见文件头注释：DSH 拒绝"多个 loader 行指向同一个包"，而设置卡又必须由带 client 模块的包提供，所以三块子插件挂在一行里。
配置形状（`cordis.patch.yml` 里那一段）：

```
- id: browser
  service:    { provider }                     ← 浏览器缝（谁来实现）
  playwright: { launch, idleTimeoutMs, ... }    ← 怎么开窗、怎么拍快照
  tool:       { toolPrefix, allowEvaluate, ... }← 给模型哪些工具、哪几个默认关
```

---

## 三、六层结构（按"从下往上"读）

### 第 0 层 · 地基：类型、错误、契约

| 文件 | 它回答什么问题 |
|---|---|
| `types.ts` (306) | 一个快照、一个节点、一个标签页长什么样 |
| `errors.ts` | 所有错误码（`REF_NOT_FOUND`、`URL_NOT_ALLOWED`、`CDP_DENIED`…）怎么定义、怎么抛 |
| `contract.ts` (136) | **工具名与包的契约**：注册了哪些工具、哪些后缀常驻、哪些是闸门。改工具面必须动这里 |
| `compat.ts` | 宿主 API 变过名字（`CallId` / `toolCallId`），这里做一层兼容 |
| `config.ts` (146) | `playwright` 那块的配置 schema 与默认值 |

**读完能回答**：为什么插件"少注册一个工具"会被测试抓住？（`contract.ts` 与 `package.json` 双向比对）

### 第 1 层 · 浏览器怎么被打开

| 文件 | 它回答什么问题 |
|---|---|
| `service.ts` (118) | "浏览器能力"的抽象缝：`BrowserRuntime`。上层只认它，不认 Playwright |
| `provider.ts` (519) | `PlaywrightProvider`：持久化 profile 的启动、`ensurePage`、标签页跟踪、登录态导出/回注 |
| `window-focus.ts` | 怎么做到"窗口在你看得见的地方但不抢焦点"、最小化时照样干活、后台建页 |
| `browser-lifecycle.ts` (230) | 开窗/关窗的生命周期、`about:blank` 换成"已就绪"卡片、开关切换时的收尾 |
| `runtime-state.ts` (348) | 运行期开关落盘：`enabled` / `engine` / `headless` / `swarm`，写在 `~/.dsh/dsh-browser-playwright.state.json` |
| `legacy-config.ts` | 老的三行配置（`dsh-browser-toggle` 时代）怎么识别并给出警告 |

**读完能回答**：为什么关掉插件窗口会关、登录态却留着？

### 第 2 层 · 会话与快照（这个项目的核心）

| 文件 | 它回答什么问题 |
|---|---|
| `session.ts` (834) | **一个会话的全部状态**：当前页、ref 表、忙碌计数、`settleAndSnapshot`、点击点解析、空闲回收 |
| `injected.ts` (380) | 注入页面的那段 `SNAPSHOT_SCRIPT`：怎么把 DOM 变成可访问性节点 |
| `snapshot-aria.ts` (543) | "智能模式"：用浏览器官方的页面说明书拍快照 |
| `page-snapshot.ts` (377) | 把上面两种结果组装成一份快照：稳定、截断、附 landing note |
| `snapshot-render.ts` (181) | 节点树 → 模型读到的那段紧凑文本（含 `[ref=e12]`） |
| `page-probes.ts` (315) | 点击前的探测：按可见标签找目标、命中测试、拦截判定 |

**这两个概念必须懂**：
- **ref**：每次快照给每个元素发的编号（`e12`），带 per-document nonce。页面重渲染后旧 ref 匹配不到任何东西 → 直接报错，而不是点到别的元素。
- **settle**：动作之后不是立刻拍，而是等页面"安静下来"（DOM 不再变、导航完成），再拍。

**读完能回答**：为什么"点了没反应"时能看到 `CAUTION: ... intercepted`？为什么刷新后旧 ref 会失效？

### 第 3 层 · 动作（模型真的动手的地方）

| 文件 | 它回答什么问题 |
|---|---|
| `page-actions.ts` (853) | 所有动作的实现：`navigate` / 点击（三种寻址）/ 填表 / 按键 / 悬停 / 滚动 / 截图 / 前进后退 / 标签页 |
| `wait-conditions.ts` (157) | `browser_wait` 的判据：选择器可见、文字出现、网络空闲 —— 都是"目标"，不是"睡多久" |
| `url-policy.ts` | `allowedDomains` 怎么判：主机、子域、协议 |
| `navigation-guard.ts` | 请求级闸门：页面想加载白名单外的域，在请求层就拒（不是事后检查） |
| `challenge.ts` (340) | 挑战页识别：响应头 → 厂商控件名 → 文案，认不出就报"可能是墙" |
| `challenge-signatures.ts` (210) | 上面那套判据的签名表（`cf-mitigated`、`x-iinfo`、`x-datadome`…） |
| `page-diagnostics.ts` (246) | 控制台消息 / 网络请求（这两个工具默认关） |

**读完能回答**：为什么点击有三种寻址方式？为什么"页面没反应"和"请求失败了"要分开看？

### 第 4 层 · 给模型的工具面

| 文件 | 它回答什么问题 |
|---|---|
| `tool.ts` (841) | 全部工具的注册、参数、闸门（`allowEvaluate` / `allowCdp` / `diagnostics`），以及"闸门关着就根本不注册"。具体条数以 `npm run cost` 报的实测值为准，本文不写死 |
| `tool-schemas.ts` | 每个工具的参数 schema（模型看到的那份） |
| `tool-types.ts` (92) | 工具输入的 TS 类型 |
| `tool-render.ts` (204) | 工具结果的渲染：截图变成附件、快照变成文本块 |
| `cdp-policy.ts` (107) | `browser_cdp` 的方法白名单（19 条精确方法名，前缀不授权任何东西） |
| `gates-patch.ts` (175) | 运行期改闸门的补丁层（设置卡点了开关就生效，不用重启） |

**读完能回答**：为什么"模型能不能执行任意 JS"是**注册层**决定的，而不是运行时判断？

### 第 5 层 · 界面与周边

| 文件 | 它回答什么问题 |
|---|---|
| `settings-card.ts` (496) | 设置卡的服务端：`/state`、`/swarm`、`/logins` 等路由 + 防伪头 |
| `client/client.js` (1229) | 设置卡的界面本身（React，无构建步骤，手写 `h()`） |
| `login-sites.ts` (363) | "已登录的站点"：按会话 cookie 特征判，不显示名字和值 |
| `login-state.ts` (89) | 登录态导出/回注 |
| `site-aliases.ts` (138) | 域名 → 中文人话名（离线对照表，认不出不编） |
| `swarm-intro.ts` (523) | 进场特效的注入、控制条压制、CSP 判定、播放记账 |
| `cache-clean.ts` (420) | 缓存/磁盘清理与计量 |
| `extract.ts` | 正文提取的小工具 |

**读完能回答**：设置卡为什么改完立刻生效？"已登录的站点"凭什么判断某个域是你登录过的？

---

## 四、一次点击的完整旅程（把上面几层串起来）

```
模型 → browser_click { ref: "e12" }
  ↓ tool.ts          校验参数、闸门、前缀
  ↓ session.ts       runAction()：忙碌计数、拦对话框、停特效
  ↓ page-actions.ts  把 ref 解析成元素 → 几何点/可访问性动作
  ↓ page-probes.ts   命中测试：这个点最上层是谁？被拦了就说清楚
  ↓ 真点击
  ↓ session.ts       settleAndSnapshot()：等页面安静、拍新快照、发新 ref
  ↓ snapshot-render  节点树 → 文本
  ↓ tool-render      快照 / 截图 → 模型看得到的东西
模型 ← "点了这里，落点是 X，现在页面是这样"
```

记住这条链，40 个文件的位置就都有意义了：**每一层只干一件事，出错时从下往上查**。

---

## 五、从零读的顺序（建议 5 天，每天 1–2 小时）

**第 1 天 · 骨架**
`package.json` → `src/plugin.ts` → `src/service.ts` → `src/config.ts`
目标：说清楚"一行配置怎么变成三个子插件"。

**第 2 天 · 浏览器与会话**
`src/provider.ts` → `src/browser-lifecycle.ts` → `src/session.ts`（先读 `ensurePage` / `runAction` / `settleAndSnapshot` 三个函数）
目标：说清楚"一个会话里当前页是谁、ref 存哪、为什么会被回收"。

**第 3 天 · 快照**
`src/injected.ts` → `src/snapshot-aria.ts` → `src/page-snapshot.ts` → `src/snapshot-render.ts`
目标：说清楚"页面 → 文本"和"ref 为什么会失效"。

**第 4 天 · 动作与安全**
`src/page-actions.ts`（按函数跳读）→ `src/url-policy.ts` → `src/cdp-policy.ts` → `src/challenge.ts`
目标：说清楚三种点击寻址、两道闸门（URL / CDP）。

**第 5 天 · 界面与特效**
`src/settings-card.ts` → `client/client.js` → `src/runtime-state.ts` → `src/swarm-intro.ts`
目标：说清楚"设置卡点一下，为什么服务端和运行期同时变"。

---

## 六、五个必须懂的名词

1. **provider（提供方）**：真正开浏览器的那层。换实现（Playwright / CDP 直连）只换这一层。
2. **session（会话）**：一次对话对应一个浏览器上下文；里面记住当前页、ref 表、忙碌状态。
3. **snapshot（快照）**：某一刻页面的可访问性树，加上每个元素的 ref。模型只信快照，不信 screenshot。
4. **ref**：快照里的元素编号，带 nonce。失效就报 `REF_NOT_FOUND`，绝不"按位置猜"。
5. **gate（闸门）**：危险能力（任意 JS、原始 CDP、诊断）默认**不注册**，打开才注册。

---

## 七、测试怎么读（29 个文件，别全读）

按"它能抓住什么错"来挑：

- `contract` / `cross-doc` / `doc-reality` / `docs-consistency`：抓**文档与代码/包内容互相矛盾**（这个项目历史上栽过三次）
- `scenarios` / `tool-scenarios`：真浏览器跑完整使用流程
- `page-probes` / `redirect` / `cdp-policy`：抓安全边界被放宽
- `swarm-intro`：抓进场特效的账本、CSP、控制条隐藏
- `live-smoke`：连真实站点（默认不跑，`npm run test:live`）

一个项目里最值钱的测试不是"覆盖率高"，而是**能在改动时喊出"你刚刚放宽了什么"**。这个仓库的守卫类测试就是干这个的。

---

## 八、已知的坑（读代码时会撞到）

1. **配置出现在三处**：`cordis.patch.yml`（部署）→ `config.ts` 的 schema（默认值）→ `runtime-state.ts`（用户点过之后）。三者优先级是"用户 > 部署 > 出厂默认"，改任何一处都要想清楚另两处。
2. **`lib/` 是构建产物但随包提交**：宿主加载的是 `lib/*.js`，不是 `src/*.ts`。改完必须 `npm run build`。
3. **`assets/swarm-rebuild.js` 是打补丁生成的**：原文件在 `assets/swarm-rebuild.upstream.js`，改动写在 `scripts/swarm-patch.mjs`；改完跑 `npm run swarm:patch`，`npm run swarm:check` 会抓"文件和补丁不一致"。
4. **无头模式不播特效**：这是被测试逼出来的行为，不是随便写的。
5. **拿函数给 `page.evaluate`**：函数会被序列化进页面，不能引用模块作用域里的东西；用 tsx/esbuild 跑源码时还会被 `keepNames` 包一层 `__name` 而报错 —— 线上走 `tsc` 产物没这个问题。
