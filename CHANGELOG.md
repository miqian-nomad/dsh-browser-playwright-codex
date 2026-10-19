# Changelog

Bilingual by intent: the version headings and the summary of each release are given in both
languages, the individual entries follow the language the surrounding code and docs use.

## 0.7.1 — 2026-10-19

一句话摘要：**只修文档与一处口径** —— 外部评分（8.9/10）点名的问题：CHANGELOG 的数字手写写错、对比表把五个闸门写成三个、有头模式的 viewport 仍然不生效却没标注。行为零变化。

### Added

- **设置卡新增第三个工具开关：诊断工具**（`browser_console_messages` / `browser_network_requests`）。与 `evaluate` / `cdp` 同一套机制：`POST /api/browser-playwright/gates` 现在接受 `diagnostics`，home 补丁块的整行 config 一并写入，`tool.ts` 把**实际生效值**（而不是猜的）发布给卡片；卡片上显示"当前：N 个开着"也把这一项算进去。
- **「已登录的站点」默认折叠**：标题行直接给出「N 个域 · M 个 cookie · 点击展开」，点开才渲染说明与名单（分组仍各自折叠）。设置页不再被这份名单占掉大半屏。

### Fixed

- **CHANGELOG 0.7.0 的数字按实测改正**：常驻是 **16 工具 / 11,179 字符**（此前手写成 11,005 字符，token 数也跟着漂），对比基线 18 工具 / 12,755 字符保持不变，字符降幅 **−1,576（−12.4%）**。这是连续第三个版本出现"主文档被守卫钉住、CHANGELOG 叙事手写漂移"——本轮起新增加一条守卫：**最新一节 CHANGELOG 不许出现手写的 `≈ N token/轮` 数字**，要写就写实测命令与结果表。
- **对比与优势.md 的闸门清单**："五个闸门"此前只列了 `evaluate` / `cdp` / `extract` 三个名字，补上 `console_messages` / `network_requests`，并把它与全量注册的字符差从旧的 2,853 更正为实测 4,603 字符（token 换算见 README 成本表）。

### Changed

- **有头模式的 `viewport` 标注**：`browser-lifecycle.ts:44` 用 `viewport: null` 跟随真实窗口，所以 `launch.viewport` 只在 `headless: true` 时生效；README 配置示例与 Known Limitations 现在明写这一点（此前"配了也不生效"没有任何提示，被外部评分连续四次点出）。

## 0.7.0 — 2026-10-19

一句话摘要：**两个插件合成一个** —— 设置卡片并入本包；加载行从三行收成一行（这是 `dsh-client-modules` 允许本包带 client 模块的前提），独立的 `dsh-browser-toggle` 退役。

### Breaking

- **一个包一行 loader**：`cordis.patch.yml` 现在只插 `- id: browser` / `name: 'dsh-browser-playwright-codex'`，三块配置收进嵌套的 `service` / `playwright` / `tool`。旧的 `browser-playwright`、`browser-tool` 行不再被读取；loader 整体替换 config，迁移时三节都要写全（设置卡会自动重写 home 补丁层里的那一块）。
- 版本跳到 0.7.0，因为配置形状变了。

### Added

- **设置卡随本包发布**：`dsh.client` + `./client` 导出，卡片仍在 `/api/browser-playwright/*` 上提供总开关、页面识别方式、两个强力工具闸门与已登录站点名单。
- **单 loader 行守卫**（tests/plugin-entry.test.ts）：`cordis.patch.yml` 不得再出现本包的子路径行，否则卡片会重新变成非法。

### Changed

- **两个诊断工具改为门控**：`browser_console_messages` / `browser_network_requests` 不再常驻 —— 新增 `tool.diagnostics: false`（默认关），开启后才注册。常驻成本 **18 工具 12,755 字符 ≈ 3,543 token/轮 → 16 工具 11,179 字符 ≈ 3,105 token/轮（−438，−12.4%）**；全量注册仍是 21 工具 15,782 字符 ≈ 4,384。
- **快照瘦身（运行时大头）**：无名无状态的 `generic` 包装层不再逐层输出（真实页面常把一个链接包在 7~8 层 div 里），显示用 `href` 去掉追踪参数（`utm_*` / `gclid` / `rsv_*` / `sa` 等）并截到 160 字符。百度结果页形状的样本：**6,169 → 2,557 字符（−58.6%）**，行数 108 → 24。refs 与点击行为不变 —— 省的是模型读到的东西。
- 闸门写入块改为**整行 config**（新标记 `# >>> dsh-browser:`），并兼容旧的 `dsh-browser-toggle` 标记就地替换 —— 避免同一个 id 被两段 patch 争抢。
- `scripts/shipped-gates.mjs` 按新行名读取出厂闸门；`scripts/build-client.mjs` 把 `client/client.js` 复制进 `lib/`。

## 0.6.6 — 2026-10-17

一句话摘要：**四份独立审查（文档漂移 / 代码对抗 / 发行打包 / 中性冷读）查出的问题集中修掉**——两条安全缺陷、几处"假成功/假失败"、随包自检的假承诺、发布门禁漏洞与一批文档漂移。

### Security

- **点击白名单可被祖先 `<a>` 绕过**：`browser_click` 的 `ref` / `text` / `precise` 三条路径只校验**被点元素自身**的 href，外层 `<a href="http://外站/">` 包住它时点击会导航到站外并返回成功。现在改为「自身 → 最近祖先 `<a href>`（穿 shadow host）」，与裸坐标路径同层，统一交给 URL 策略。两处独立审查各自用本地 fixture 复现过。
- **密码/验证码/卡号曾进入 prompt**：`browser_extract` 把 `pageData()` 拼进辅助模型的 prompt，而 `pageData()` 采集输入框**当前值**——登录页的明文密码会随请求发出去（实测 prompt 里出现 `hunter2`）。现在 `type=password` 与 `autocomplete` 为 `current-password` / `new-password` / `one-time-code` / `cc-number` / `cc-csc` / `cc-exp` 的字段一律置空值，**字段本身保留**（模型仍知道"这里有个码要填"）。

### Fixed

- **填表核对两头错**：上一版把回读改成严格相等后，页面自动改写格式的输入框（全大写、千分位 `1,000`）被误判成"没写进去"，而 `browser_fill` 的描述恰恰把 input-mask / currency 列为预期场景；更早的版本则相反，`ABCD→ZZZZ`、`John→Jane` 会被判成功。现在的归一化只放过"页面改写、不是我们写错"：NFKC + 去大小写 + 去掉非字母数字；`1000≡1,000`、`abc≡ABC` 通过，`ABCD↔ZZZZ`、`1234↔12345` 仍然失败。contenteditable 也不再假失败（改读 `textContent`/`innerText`）。
- **挑战页识别的两处回归**（本轮自查引入的）：给控件层加"页面得够空"的门控后，**正常登录页里嵌的真 reCAPTCHA / hCaptcha / Turnstile 完全不再识别**（登录页正是主要场景），已移除该门控；`CAPTCHA_ROLES` 曾删掉 `iframe`，导致名字就叫「验证码」的非厂商 iframe 不被识别，已恢复。
- **`[nothing here]` 提示三类误报**：静默页扫描深度 4 → 8 层（正文藏得深的正常页曾被判"几乎没有文字"，与同一结果树里的正文自相矛盾）；无标题的裸文档（`about:blank`、直接打开图片）不再提示；有挂起弹窗时不出这条（否则与 `[dialog]` 指令冲突）。
- **提示互斥**：已判定为拦截页时不再叠 `[http NNN]`；已识别为挑战时不再叠行为兜底提示。

### Added

- **测试 159 → 220**（+61）：挑战识别 50 条（含真实页面测得的门控数值与反例：讲 hCaptcha 的文章、`验证码说明` 帮助链接、`获取验证码` 按钮、百度搜索页标题）、真浏览器端到端 6 条（真实 `cf-mitigated` 头、无签名拦截面被行为兜底抓住、`interactiveOnly` 下 iframe 仍识别、单页应用改 URL 后旧响应头不复用、真实 404 显示状态码、真实访客门显示静默页提示）、安全回归 5 条（外链祖先点击被拒、密码/OTP 不进 prompt、contenteditable 成功、同长度不同值失败）、本机路径守卫。

### Changed

- **随包自检不再在 npm 安装形态崩溃**：`scripts/dsh-browser-verify.mjs` 的「`lib/` 与 `src/` 同步」一组在没有 `src/` 时**跳过**并打印说明，退出码 0 —— 安装形态显示「全部通过 (56 项，跳过 1 项)」，仓库形态仍是「(57 项)」。README / CHANGELOG 此前承诺的"装上即可跑"现在才真的成立。
- **依赖不再全是 `*`**：`@deepseek-ai/schemastery` 固定 `^3.18.4`，peer `cordis >=4.0.4`、`dsh-llm` / `dsh-tools >=0.2.0-rc.1`。修前空项目安装会解析到 `dsh-tools 0.0.1-rc.1`、`dsh-llm 0.0.1-rc.5`（远旧于测试基线）；修后解析到 `0.2.0-rc.2`。代价：不同版本元组的预发布版（如 `0.2.1-rc.*`）会收到 **peer 警告**（不是失败，pnpm 默认不严格）。
- **发布门禁补齐**：CI 增加 `npm run typecheck` 与 `npm run preflight`（与 `prepublishOnly` 对齐）；CI 与 publish 都新增「`npm run build` + `git diff --exit-code -- lib`」守卫——以前先 build 再比 mtime，`src` 改完忘重建也能全绿，而 `dsh plugin add github:…` 的安装路径会拿到旧 `lib/`。
- **文档漂移**：独立审查列出 13 条硬错误 / 11 条过期 / 8 条矛盾 / 8 条缺失，全部修掉——随包文档死链由 12 条清零（改 GitHub 绝对链接）、测试计数与成本数字按实际命令重取、`npm test:live` 与 `browser-plugin/dev.cordis.yml` 这类跑不通/不存在的引用纠正、URL 白名单不再声称覆盖 `hover`（实际不覆盖）、补写 `snapshot.engine` 说明，并在 `中文说明.md` 新增 **§4.14 挑战页识别**（四层判定与两条结果提示，明确"产出提示不是阻断，认不出来就停下来问人"）。许可表述收敛为：代码与说明文档 MIT，CC BY-NC-SA 仅限 `FOCUS-STEALING.md` / `MODE-TRADE-OFFS.md` 两篇分析长文。
- **`.gitignore` 补登录态**：`dsh-storage-state.json` / `browser-profiles/` / `profile/`。默认写在 `~/.dsh/browser-profiles/`（仓库外），但只要有人把 `launch.profileDir` 指进 checkout，那个文件里就是明文 cookie。

## 0.6.5 — 2026-10-16

一句话摘要：**挑战页识别不再靠一份关键词表** —— 判定改成「厂商自有的机器信号优先，认不出来就问一句『页面变了吗』」，所以新出现的验证方式也能被接住；顺带清掉漏网的 4 处本机路径，并把 npm 包里 12 个用不上的开发脚本收成 2 个。

### Changed

- **挑战页识别重做成分层判定**（新增 `src/challenge-signatures.ts`，重写 `src/challenge.ts`）。原来只有一份中英混杂的词表，而且词表里**根本没有「验证码」「安全验证」「拖动滑块」这些中文说法** —— 也就是说 README 承诺的「遇到验证码会停下来」，在中文站点上大半不成立：百度系的「安全验证」、滑块页的「拖动滑块完成拼图」一个都识别不到，插件会当作普通页面继续点。现在按**稳定性**排序，而不是按覆盖率：
  1. **主文档响应头** —— 厂商对外的公开 API：`cf-mitigated: challenge`（Cloudflare 官方文档就是教用户读这个头）、`x-amzn-waf-action: challenge`（AWS WAF）、`x-iinfo`（Imperva）、`x-datadome*`（DataDome）。为此在 `src/page-diagnostics.ts` 已有的 `page.on('response')` 里认出**主文档导航响应**，把 status 与头透传进快照（`BrowserSnapshot.response`）。只认**产生当前文档的那次响应**：单页应用改了 URL 却没有文档加载时，旧响应不再复用 —— 否则会在一个好好的页面上报出墙；退回低层是安全的失败方向。
  2. **厂商控件自己的无障碍名** —— reCAPTCHA / hCaptcha / Turnstile / Arkose / PerimeterX 的 iframe 标题就是他们自己的产品名；非 iframe 节点上的同名 token 必须**另有**「请你验证」字样才算数，而且那份旁证语汇**排除了它自己**（`reCAPTCHA` 里就含 `captcha`，不排除的话这条守卫是空的 —— 第一版就是这样，被测试当场抓出来）。
  3. **文案（最后手段）** —— 标题里的 `安全验证` / `Just a moment...`，或控件上的命令式文案（`请输入验证码`、`拖动滑块完成拼图`）；按「动词族」组合匹配而不是逐句枚举。**只有控件角色**（输入框 / 按钮 / 图片 / 滑块…）能凭「验证码」二字触发，`验证码说明` 这种帮助页链接不触发；`获取验证码` / `发送验证码` 这类正常登录控件也排除（另一个被测试抓出来的误判）。
  4. **行为兜底（不认识任何厂商）** —— 动作之后 URL、标题、元素集合完全没变、且页面上几乎没有别的可点，就在这次结果里附一句「没有可见变化」，并**明说这是猜测**。这一层覆盖所有没有签名的厂商：新出现的验证方式靠它接住，代价只是多问用户一句，而不是拿账号去撞墙。
- **`interactiveOnly` 不再把 iframe 剪掉**（`src/injected.ts` 与 `src/snapshot-aria.ts` 两个引擎都改）：iframe 的无障碍名就是内嵌控件自己的标题，是第 2 层唯一的证据。原来这个省 token 的开关一开，等于把验证码识别关掉 —— 一个**静默失效**。
- **已经认出是拦截面时，不再叠那句兜底提示**：「这是墙、原因是什么」才是可执行的信息，再叠一句更含糊的警告只是多花 prompt。
- **清掉仓库里漏网的 4 处本机绝对路径**（`README.md`、`PLUGIN-README.md`、`SNAPSHOT-RULES.md`、`scripts/autocommit.ps1`）。0.6.1 声称清干净了，实际漏了这四处；而它正是外部评审用来判断「这个项目离开作者的电脑就转不动」的证据。**这次改成脚本守**：`tests/doc-reality.test.ts` 新增守卫，扫全仓手写文本文件里「盘符 + 至少一段目录」的路径（已用探针验证：三条真实路径全部抓到，仓库里唯一命中是给读者的 `D:\path\to\…` 占位符，由白名单排除）。
- **npm 包从 85 个文件收到 75 个**：`files` 里那一整个 `scripts/` 收成逐个文件的白名单，只留 `doctor.mjs` 与 `dsh-browser-verify.mjs`（这两个只依赖 `lib/` 与 harness，装到 npm 的用户**能直接跑**）。顺带修掉一处假承诺：README 原来说 `measure-prompt-cost.mjs` 也随包可跑，但它依赖 `src/` 与 `shipped-gates.mjs`，在装好的包里**从来跑不起来**。`scripts/preflight.mjs` 的 `SHOULD_SHIP` 现在钉住这两个脚本，防止以后再被顺手丢掉。
- **新增上手一节「第一个任务」**（`README.md` / `PLUGIN-README.md` / `中文说明.md`）：三条可以直接复制的话 + 你会看到什么 + 第一天两个习惯（先看再点、不可逆的那步说停）。四家外部评审独立提到「装完不知道第一步干什么、文档过载」，而 `examples/` 目录一直不存在。

### Added

- `tests/challenge.test.ts`：**35 条**用例，正例与**必须不触发**的反例各占一半 —— 讲 reCAPTCHA 的文章、`验证码说明` 帮助链接、`获取验证码` 按钮、只是提到「请输入验证码」的长段落、普通搜索页、只有「安全」二字的标题。另有一条守卫：旁证语汇不得被任何厂商自己的名字满足。
- `tests/scenarios.test.ts`：**4 条真浏览器端到端**。①真实 `cf-mitigated: challenge` 响应头一路走到渲染结果（钉住「监听 → 快照 → 判定 → 模型读到的文字」这条链，单测盖不住）；②一个**完全没有任何签名**的拦截面（标题「请稍等」、一个点不动的按钮）由第 4 层兜底抓住，测试**先断言 `detectChallenge` 返回 null**，证明它不是靠签名抓到的；③`interactiveOnly` 下 iframe 名字仍在；④单页应用改 URL 后旧响应头不复用。
- `tests/snapshot-aria.test.ts`：`interactiveOnly` 保留 iframe 的用例。
- `tests/doc-reality.test.ts`：本机路径守卫（见上）。

### Fixed

- **`PlaywrightSession.blockedSnapshot` 从未声明返回类型**，于是 `navigate()` 的推断返回类型变成一个联合类型，新加的字段在类型上根本不存在。类型检查抓出来的，不是运行期 —— 这正是把 `typecheck` 扩到 `tests/` 的价值。
- **兜底指纹原来只读两层**：深层文字变化会被误判成「页面没变」，于是在一个正常页面上报出「没有可见变化」的假警告。现在读到 4 层。

## 0.6.1 — 2026-10-16
### Changed

- **清掉仓库里的本机绝对路径**：`DIALOG-POLICY.md` 里那条 `D:\dsh-plugins\…` 与 `codex-rules.md` 里那条 `C:\Users\…\.codex\…` 换成通用说法；`ci.yml` 里写死的验收计数（"(52 checks)"，实际 57 项）改成由脚本自己打印，从此不会再漂移。三处都是外部模型评审当场读出来的。
- **SECURITY.md 的扫描数字更新为 2026-10-16 对 0.6.0 的实测**：dsh.so 的 `dsh-plugin-vet` 扫出
  **1 Critical / 3 Warning / 25 Info**（80 个文件），此前记的是 v0.5.3 的 1 / 3 / 22（75 个文件）。
  Critical 与 Warning 的**条目**没变（Critical 仍是 `browser_evaluate` 的 `new Function`），只有 Info 随代码增长增加。
  （旧数字来自我们的上一次扫描；新数字来自 dsh.so 的独立扫描，用于核对。）

## 0.6.0 — 2026-10-16
一句话摘要：**`browser_fill` 现在也接受 `value` 这个参数名**（模型按语义猜也能一次成功），缺值时给的是指路错误，而不是"缺少属性 text"。

### Added

- **同一家公司的域折叠成一行**（用户："这种一个类型的肯定要放一起啊"）：对照表升级成「说明 + 归属公司」，
  载荷每行带 `group: { key, label }`，卡片按公司折叠（京东系 / 阿里系 / 字节系 / 微软系 / Meta 系 /
  Google 系 / 广告与统计平台），组行显示成员数与整族汇总，展开看单个域；只剩一个成员的组自动退回单行。
- 顺带修掉上一版说明行里**不配对的括号**：有网页标题时反而会把 cookie 计数吞掉（只在有标题的行上出现）。

### Added

- **每一行写明"这个域名是什么"**（用户："我都不知道我登的这些是什么"）：优先用**网页自己的标题**
  （浏览器与密码管理器的做法，网站自己报的名字，不出网），其次包内一份**离线对照表**
  （`src/site-aliases.ts`，60 多条：国内平台、京东系一大家子、国外服务，以及被明确标注的广告/统计域），
  认不出的只显示域名、不编。广告/统计域被标出来本身就是提示 —— 它出现在"像登录态"里通常说明判据被
  数据相似性骗了。`LoginSite` 新增 `alias?` 与 `title?`（标题由 `session.siteTitles()` 提供，
  `page.title()` 是异步的，所以该方法是 async）。

### Fixed

- **`browser_fill` 参数名歧义（评审 A1）**：`value` 作为 `text` 的别名被接受，两者都给时 `text` 优先。缺值时抛 `PARAM_MISSING`，消息同时点出两种写法，并说明"`text` 是要填入的值（要点可见标签请用 `browser_click`）"；这条检查在**获取会话之前**，所以参数传错不会白开一个浏览器。schema 里 `text` 不再是 required —— 参数 DSL 是扁平属性表、required 只能逐属性标，表达不了"text 与 value 二选一"，只能在处理函数里兜，代码注释写明了原因。
- **`PLUGIN-README.md` 的安装命令指向不存在的包**：它写着 `add dsh-browser-playwright`（0.4.0 改名前的旧包名，npm 上没有这个包）。已改为当前包名、标题同步；并修掉上一批我加错的说明 —— `git log --follow` 显示这份文件在初始提交里就叫 `README.md`，是本插件自己的英文自述，**不是**上游插件的文档。

### Changed

- 文档的常驻成本数字同步为实测值：20 工具 **15,269** 字符 ≈ **4,241** token/轮（全量注册 23 工具 18,122 ≈ 5,034），README / PLUGIN-README / 中文说明三处一致。本次改动净增约 236 字符（≈ +65 token/轮），是别名说明的代价。

### Changed（破坏性：工具面 20 → 18）

- **click / hover / click_at 合并成一个 `browser_click`**：三者的能力一个没丢，用两个开关表达 —— `mode:"hover"` = 只揭示不激活（原 `browser_hover`），`precise:true` = 几何中点兜底路径（原 `browser_click_at` 的 ref 模式），`x`+`y` = 裸坐标（原 `click_at` 的裸模式）。
  新旧对照：`browser_hover { ref | text }` → `browser_click { mode: "hover", ref | text }`；`browser_click_at { ref }` → `browser_click { ref, precise: true }`；`browser_click_at { x, y }` → `browser_click { x, y }`。
- **常驻成本**：20 工具 15,269 字符 ≈ 4,241 token/轮 → **18 工具 12,745 字符 ≈ 3,540 token/轮（−701，−16.5%）**；全量注册（含三个闸门工具）23 → 21。
- **守卫随之调整，而不是被绕过**：`tests/tool-descriptions.test.ts` 的 `RULES` 表从三个键并为 `browser_click` 一个键（29 条），覆盖原来 46 条里的核心；`SNAPSHOT-RULES.md §5` 的长度预算改成"每条 ≤1650；承接过多个同类工具的合并工具 ≤2400；整个描述面合计 ≤11500"，并写明理由 —— 去重后仍要 ~2165 字符才能把"精确点击兜底""悬停揭示失败怎么办"这两段失败路径一条不丢地说完，而它们属于规范里的五要素，不许删。

### Fixed

- **「已登录的站点」的归属模型与判据都错了**（这份功能第一次吐出真实名单时暴露的：231 个域、1177 个 cookie，
  `pubmatic.com`（广告交易所）27 个、`mmstat.com`（统计）30 个都排在前面，展示的 60 个**全被标"推测"**）。
  按两个成熟做法重写：
  1. **第一方归属**（Firefox Total Cookie Protection 的模型）：cookie 属于"你当时浏览的那个站"，
     不是"设它的那个域"。现在只把**浏览器真的访问过**的域当候选（用当前打开页面的 URL，**不读浏览历史**；
     浏览器没开时用导出文件里的 localStorage origins 顶上），其余只报个数（`thirdPartyTotal`）、不进列表。
  2. **OWASP 的会话特征**：`httpOnly` 且（会话级 或 值像令牌）才算"推测登录"；**名字与 cookie 条数不再作为依据**
     （上一版正是靠它们把广告域排到了前面）。值只在 `session.cookieJar()` 里被折算成一个布尔（`tokenLike`），
     值本身不出那个函数 —— 红线不变。
  另外：载荷补上诚实的统计（`likelyTotal` / `total` / `thirdPartyTotal`），卡片默认**只显示像登录态的**、
  可展开其余，每行给出可核对的证据（cookie 数 / httpOnly / 会话 / 值像令牌）；域级名单补上广告交易所
  （pubmatic / criteo / adnxs / rubiconproject / scorecardresearch / adsrvr / taboola / outbrain 等）。
  接口 `summarizeLoginSites` 的第 4 个参数改为**具名选项**（`{ visited, maxSites }`）—— 位置参数在这个位置
  太容易传错，改的时候就踩了一次。

### Added


- **设置页新增只读的「已登录的站点」名单**（配套件 `dsh-browser-toggle` 的卡片里）：provider 从浏览器自己的
  cookie 推断哪些站点像登录着，按可注册域聚合（含 `com.cn` / `co.uk` 这类多段后缀），剔除分析/风控 cookie
  （`_ga`、`__cf_bm`、`Hm_lvt_*`、`BAIDUID` 等），再按 httpOnly、有效期与名字特征打分，界面标"推测登录"。
  **出去的内容只有域名、条数与布尔信号 —— 没有 cookie 的名字，也没有值**；`src/login-sites.ts` 在唯一入口
  丢弃 `value`，测试断言整份产出序列化后搜不到任何名字或值。
  数据是内存态（不落盘），模型看不到（不注册工具、不进 diagnostics），唯一出口是
  `GET /api/browser-playwright/logins`，且强制 `x-dsh-plugin` 自定义头（不带即 403，有测试盯着）。
  新增 `tests/login-sites.test.ts`（8 条）与 `src/login-sites.ts`；会话接口 `BrowserSession` 增加
  `cookieJar()`（只返回 name/domain/expires/httpOnly/secure）。
- **顺手补掉一个真实缺口**：`GET /api/browser-playwright/state` 此前**不校验** `x-dsh-plugin` 防伪头
  （四个路由里唯一一个），现已补上；客户端读写都带头。这是加登录名单时顺手发现的 —— 一个暴露部署开关状态的
  GET 不该裸奔。

- **`tests/doc-reality.test.ts` 第 6 条守卫**：文档里的 `dsh plugin … add <spec>` 必须指向真实来源（本包名、本仓库 `github:` 或 URL、`link:`），引用上游命令的行除外。
- **README 的工具参数签名（评审 B2）**：新增 “Parameter signatures” 段，列出全部 21 个工具（18 常驻 + 3 个闸门，闸门工具带标记）的参数与必填性（`*` 必填 / `?` 可选）。
  **签名是从活的工具面导出的，不是手写的**；`tests/tool-schema.test.ts` 新增守卫逐项比对 README 与 schema —— 工具多一个少一个、参数名或必填性漂移都会红，并且这条守卫是用“故意把 README 写错一版”验证过确实会红的。中文说明的工具表本来就有参数列，英文 README 之前完全没有，调用方只能靠猜（`browser_fill` 的 `value` 就是这么猜错的）。
- 测试：schema 层断言别名在 schema 中可见、`ref` 是唯一必填；行为层断言用 `value` 填的值**真的进了页面**（以它触发的搜索结果为证），以及缺值时错误同时点出两种写法与 `browser_click`。

## 0.5.5

一句话摘要：**把 `NOTICE.md` 补进 npm 包**（此前从未随包发布过），并把发版审计固化成 `npm run preflight` —— 挂在 `prepublishOnly` 上，不通过就发不出去。

### Fixed

- **`NOTICE.md` 从未随包发布**：`package.json#files` 里没有它，而 npm 只会自动带上 `LICENSE`、不会带 `NOTICE`。那份文件说明的是"MIT 衍生部分保持 MIT、只有本项目的分析性散文才是 CC BY-NC-SA"，属于归属声明，必须送到用户手里。已加入 `files`：现在包内 79 个文件，含 NOTICE.md。
- 上游那个插件的 README 放在仓库根目录，容易与本包混淆（它写着旧包名与旧版本号）—— 顶部加了一行说明。
- 0.5.4 的 CHANGELOG 条目描述"哪里写错了"时，把失效路径与失效行号照抄进了正文，于是审计（正确地）把它们当成真引用。改为描述而不照抄。

### Added

- **`scripts/preflight.mjs`（`npm run preflight`）**：发版前审计，并挂到 `prepublishOnly`（`build && test && verify && preflight`）。检查项：
  - 包里装了什么 —— 必备文件清单（NOTICE / LICENSE / SECURITY / CHANGELOG / locale / cordis.patch.yml）、`lib/` 必须在、`src/` 与 `tests/` 与 `.bak` 必须不在；
  - 文档"关于世界的断言" —— 本包版本号、写死的工具数、写死的总 token 数、旧包名、反引号路径、「文件:行号」是否越界、markdown 相对链接是否失效；
  - 基线取自**命令本身**（`npm run cost`、`node --test`），不是文档自述；
  - 输出分 **✗ 必须修 / ？ 待确认 / ✓ 已核对** 三类，规则刻意收窄避免噪声。

## 0.5.4

一句话摘要：**把第三方评审（2026-10-11，8.6/10）指出的"对外表述与现实脱节"修干净，并把这些说法变成守卫** —— 运行时行为零变化。但 README / SECURITY / NOTICE 是**随包发布**的，所以必须发一版：不发版，从 npm 装的用户看到的仍是那句"不在 npm 上"。

### Fixed

- **README 声称"这个包不在 npm 上"**（与同一文件里的 `# from npm` 自相矛盾）：包从 v0.5.1 起已在 npm 上。改为「From npm (published since v0.5.1)」并给出 npm 安装命令，仓库与本地 link 两种方式保留。
- **NOTICE.md 的 7 个路径全部失效**（这 7 份文档都写成 `docs/` 前缀，实际都在仓库根目录）：已按根相对路径改正。同一段里指向**上游文档**的 `docs/browser-safety.md` 保持原样 —— 那是给读者的来源索引，不是我们的文件。顺带修掉 `MODE-TRADE-OFFS.md` 里同类一处。
- **README"安全一览"写死"2 Critical"**，而 dsh.so 当前扫描是 **1 Critical / 3 Warning / 22 Info**（v0.5.3、75 文件）：改为不含数字的说法。
- **SECURITY.md §2 与表格按当前扫描重写**：Critical 就是 `browser_evaluate` 的动态求值（`src/session.ts` → `lib/session.js`，出厂关闭）、3 条 Warning、22 条 Info；v0.4.9 的 2/5/26 作为历史留在引用块里，并写明"以他们的报告为准"。
- **SECURITY.md 里"某个文件 + 行号"式的引用在 0.5.x 拆分后失效**（该文件现在 55 行）：改为模块名 —— 行号会漂，模块名不会。
- **三份发帖草稿里的"2 个 Critical"**：去掉数字，改为"那个 Critical"。
- **几处把上游文件写得像我们自己的**：`docs/articles/focus-stealing.md`、`patches/README.md`、`codex-rules.md` 里标明那是**上游仓库**的文件。
- **README 增加 "Compatibility" 段**：写明构建与测试用的 DSH 版本是 `0.2.0-rc.1`、peer 范围故意留 `*`（换新版 harness 仍可安装）、升级后跑 `npm run doctor` 复核本插件导入的具名导出是否还在。

### Added

- **`tests/doc-reality.test.ts`（5 条守卫）**，把"文档对世界说的话"变成 CI 会拦的事实：
  1. 现行文档不得声称"不在 npm 上"（CHANGELOG 是历史，跳过）；
  2. README 必须给出 npm 安装路径（与第 1 条互为孪生）；
  3. 反引号包着的仓库路径必须真的在那个位置（规则：该路径不存在、但同名文件在本仓库里存在才报 —— 不误伤上游引用；`./`、`../` 相对所在文档解析，其余相对仓库根）；
  4. 文档里的「文件:行号」引用不得越界（行号 > 该文件现在的行数即报错 —— 正是 0.5.x 重构制造的那类腐烂）；
  5. 带数字的 `N Critical` 只允许出现在 SECURITY.md（计数会变，其它文档一律用文字指过去）。
  每条都做了"有牙复检"：把对应的旧文案塞回去，守卫立刻报红。

## 0.5.3

一句话摘要：**源码按职责拆开、可维护性大幅提升，并修掉拆分过程中暴露的三处隐患** —— 对用户可见的行为零变化：工具面、配置接口、出厂默认值全部不动。本版同时修掉中文说明里一处会让人误判权限状态的过期说法。

### Changed

- 源码按职责拆开：`playwright.ts` **2,727 → 55 行**，只剩注册入口 `apply()` 与一张给来访者的模块地图；对外零变化（loader 三行、`package.json` exports、`lib/` 入口、工具面全都不动）。做法是"纯搬运、一次一个接缝"：每步 `npm test` + `npm run verify` + 解析一致性脚本全绿才提交，任何一步不绿就当场回退（过程中真回退过一次：拆 `tool.ts` 时用启发式切错边界，回退后改用 TypeScript 解析器取精确范围）。
  - `provider.ts`（370 行）：profile/context 生命周期、会话注册、空闲回收、弹窗登记、标签记账。
  - `session.ts`（668）：会话骨架 —— 持有 page/context，处理弹窗、截图、页面数据、evaluate/CDP，并把动作/快照/诊断转发给对应模块。
  - `page-actions.ts`（786）：可点击性检查、点击（几何阶梯 + Playwright 兜底）、填充与写后核对、按键、悬停、滚动、前进后退、标签切换。
  - `page-snapshot.ts`（335）：等页面稳定、兼容/智能两种采集、ref 签名与差异、ref 解析与存活校验。
  - `page-diagnostics.ts`（198）：控制台消息、页面错误、网络请求的有界记录 + 失败原因归类。
  - `page-probes.ts`（288）：会被序列化进浏览器的页内函数（铁律：必须自包含）。
  - `window-focus.ts`（56）：承载窗口是否最小化、后台建标签 —— 只为了让窗口/标签不打扰用户。
  - `browser-lifecycle.ts`（183）：启动/复用持久化 context、清理 Chrome 锁、启动与 profile 参数。
  - `login-state.ts`（90）：登录态导出/恢复（窗口最小化读不到状态时只取 cookies）。
  - `config.ts` / `url-policy.ts` / `challenge.ts` / `extract.ts` / `tool-types.ts` / `tool-schemas.ts` / `tool-render.ts`：配置与常量、URL 策略、人机验证识别、提取工具辅助、工具面类型/schema/渲染。
- 12 个模块的文件说明与内容对齐（此前 6 处内容变了没改、5 处还留着拆分当天的占位文案）。

### Fixed

- **入口子路径恢复 `Config` 导出**（`./playwright`）：拆分时 schema 被搬进 `config.ts` 而入口忘了转出 —— Cordis 因此不会补默认值，而配置块里没有 `snapshot`，provider 又直接读 `config.snapshot.engine`，**下次重启就起不来**。该回归只存在于 main、从未随版本发布。现已补上入口契约测试：从 `src` 与 `lib` 两条路检查导出、校验 schema 补出默认值、复现"不含 `snapshot` 的 profile 配置"这一故障场景，并断言 `lib/` 与 `src/` 行为一致（防漂移）。
- **页内探测守卫覆盖不到 `hitTest`**：它原本是 `resolveClickPoint` 里的嵌套命名函数（同样会被 `keepNames` 改写成 `__name`），现已搬进 `page-probes.ts`；守卫从"手写 4 个函数"改成**枚举该模块所有函数导出**（并断言至少 5 个，避免空跑）。
- **中文说明写明两个闸门出厂关闭**：原文写"本包自带的 bundle 层是… `allowEvaluate`/`allowCdp` 打开"，与出厂 `false`/`false` 矛盾，读者会以为"页面任意 JS / 原始 CDP"默认可用。现在写明出厂关闭并指向 §4.6。
- **文档守卫补洞**：原规则要求行内出现 `: true|false`，而措辞检查写在这个提前返回**之后** → "…`allowCdp` 打开"这类写法永远走不进检查。现改为两条带邻近性的规则；负向自检三种坏写法全部被抓住，且 `SECURITY.md` 里那句合法表述不被误报。
- **新增两条守卫**：模块文件说明不得留下拆分脚本的占位文案；页内函数必须自包含（第 5 个函数 `hitTest` 因此归位）。
- **测试的导航预算 2500ms → 15s**：冷启动的 windows runner 连加载本机 fixture 页都超时（`page.goto: Timeout 2500ms exceeded`），一次挂掉 4 条与超时无关的用例；没有任何测试断言导航超时行为，journeys 另有 25s 兜底。
- **拆分过程中暴露的 3 处隐患**：`WeakMap<Request>` 实际落在浏览器内置的 DOM `Request`（两个类型身份）、`provider.ts` ⇄ `session.ts` 的**运行时**循环依赖（多个测试文件直接加载失败，用例从 119 掉到 46）、测试与脚本仍在旧路径引用搬走的符号。
- 清掉搬迁后残留的未使用 import/参数（以 `tsc --noUnusedLocals --noUnusedParameters` 为裁判，28 处 → 0）。

## 0.5.2

一句话摘要：**查出 Windows CI 抖动的真正根因并修掉**—— 测试用的转译器 tsx/esbuild 会开启 `keepNames`，把"要送进浏览器执行"的页内函数里的**命名内部函数**改写成 `__name(fn, "名字")`，而 `__name` 只存在于模块作用域、页面里没有 → 探测每次抛 `ReferenceError`，且被 `catch` 吞成无声的 `unreachable`。后果是**几何点击路径从来没工作过**：所有点击都退化成 Playwright 兜底点击（上限 3 秒），慢速 Windows runner 一超时，就把几何路径那句**误导性**的错误抛了出来。

### Fixed

- **根因：页内探测函数必须自包含。** `hitTest` 里那个 `const describe = (…) => …` 被 esbuild 包成 `__name(...)`，序列化进页面后直接抛 `ReferenceError: __name is not defined`（用 `fn.toString()` 在 tsx 下实测确认）。改为内联成字符串计算 —— 函数体里不再有任何函数字面量。
- **测试运行器换成 Node 原生类型剥离**（`node --test "tests/*.test.ts"`，CI 用 Node 24，引擎要求 `^22.19 || >=24`）。这从根上移除了整类陷阱：同一个测试在 tsx 下红、在原生下绿（已实测）。`tsx` 仍是 devDependency（`cost` 等脚本还在用），只是测试不再经过它。
- **失败原因不再被丢弃。** 原循环的判断读的是 `lastReason === null`，而变量初值是 `undefined`，所以那个分支**从未执行过**：瞬时失败一律伪装成 "could not find an unobstructed click point"。现在按信息量排序记录原因、在错误里点名、连探测抛出的**错误文本**也带上（正是它让我看到 `__name`）。
- **点击探测点改为取「元素 ∩ 视口」的中心**。`elementFromPoint()` 对视口外坐标返回 `null`，而原先取元素自身中心 —— 比视口高的元素、或中心落在折线以下的元素会三个对齐档全败。现在取可见交集中心；**完全不在屏幕上**给出独立的 `off-screen` 原因。
- **截图改用独立的超时下限**（`Math.max(timeoutMs, 10s)`）：全页截图的耗时由页面大小与 CPU 编码决定，复用"导航超时"（2500ms）会让慢机器把一次成功捕获判成失败 —— 2026-10-05 的 windows runner 正是这样挂的（`page.screenshot: Timeout 2500ms exceeded`）。这个下限只约束失败路径，拍好即返回。
- **每个对齐档允许有限重采样**（三次、间隔 60ms，稳定性等待只在第一次前做一次）。

### Tests

- `the click geometry pipeline itself delivers the click, not the fallback` —— **先写测试**并在旧源码上验红（红的时候它打印出的正是 `got: playwright actionability click delivered …`），在修复后转绿。它断言的是**哪条路径送出的点击**，所以能挡住这一类回归。
- `click by visible label reaches the element through the page-side probe` —— 新覆盖：此前**整套测试从未调用过** `clickText`，而它的页内探测（`labelTargetProbe`）同样被 `__name` 破坏，只会以"找不到这个文字"的形式表现出来。这条在 tsx 下红、原生下绿。
- `click by ref reaches an element taller than the viewport`、`an element that is never on screen is reported as off-screen` —— 夹视口与原因措辞的回归用例。
- `stale-ref journey` 改用**不在 `#recent` 里**的商品做断言：`#recent` 异步插入 `CATALOG.slice(0,4)`，其中恰好含原先那个商品，于是"链接数 === 0"只在竞态窗口内成立 —— 慢一点的点击就会输掉这个竞态（这正是本次调查中先撞上的那条失败）。

### Hardened afterwards

- **三个同类页内函数（`elementStabilityProbe` / `pageStabilityProbe` / `labelTargetProbe`，含 `labelOf` 内部的 `attr`）也改成对转译器免疫的写法。** 用的是实测安全的数组解构：`const [sig, tick] = [() => …, () => …]` —— 初始值是数组字面量而不是函数字面量，所以不会被 `__name` 包，而且两个函数仍可互相调用（自递归也验过）。
  验证方式很直接：同一批测试**在 tsx 下也变绿**。加固前 `click by visible label` 在 tsx 下红、原生下绿；加固后两种运行器全绿（本地全套 117 / 114 pass / 0 fail / 3 skipped，verify 57 项）。

## 0.5.1

一句话摘要：**npm 首发 + 元数据写成用户会搜的词** —— 包以 `dsh-browser-playwright-codex` 发布到 npm，于是安装可以只写包名；同时把 `package.json` 的 description / keywords 从术语改成需求词，补上 `repository` / `homepage`，并加 `prepublishOnly`（发布前强制 build + test）。**运行时一行未改。**

### Changed

- **Package metadata is written for search, not for maintainers.** The npm description used to open
  with "accessibility-snapshot interaction with stable element refs" — precise, and useless in a search
  box. It now opens with what a user does (fill in forms, scrape lists, work across tabs, using the
  logins you already have); keywords gained `automation`, `browser-automation`, `web-scraping`,
  `form-filling`, `deepseek`, `ai-agent`, `rpa`; `repository` and `homepage` were missing entirely, so
  the npm page had no link back to its source.
- **The README first screen carries the same words** (Chinese and English), because it is the other half
  of the same search surface — the Chinese one-liner used to say "上网办事", which nobody searches for.
- **GitHub topics gained the single-word head terms** (`browser`, `automation`, `web-automation`,
  `browser-automation`, `web-scraping`, `form-filling`, `rpa`, `ai-agent`, `deepseek`), because the
  repository search weights topics heavily.
- **`prepublishOnly: npm run build && npm test`** — a publish can no longer ship a `lib/` older than
  `src/`, which is the one way this package could go out subtly broken.
- **The README 更新记录 now states it lists minor milestones only**, so a patch release cannot make the
  log look like the project stopped at the previous version.
- **No runtime change:** `src/` and `lib/` are untouched; tools, gates and the CDP policy are exactly
  what 0.5.0 shipped.

## 0.5.0

一句话摘要：**CDP 白名单从「家族前缀匹配」收紧为「精确逐条列举」** —— `DOM.get` / `DOM.query` 两个前缀不再放行任何东西（它们此前多授权了 9 个 DOM 调用，并且会授权这两个家族将来新增的成员）；同时经复核收回 9 条更早手工列上、现已判定不需要的调试器/UA 内部特性。允许面**只收不放**：终表 19 条全部是原本就已放行的权限，插件自己的后台建页与窗口探测走内部会话、不受影响。

### Changed

- **The CDP allow-list matches exact names only** — breaking for agent-issued CDP.
  `DOM.get` / `DOM.query` were matched as families, which authorised nine DOM calls beyond the
  reviewed list (`getAnchorElement`, `getDetachedDomNodes`, `getElementByRelation`, `getFileInfo`,
  `getFlattenedDocument`, `getImplicitAnchorCandidates`, `getNodeStackTraces`, `getSearchResults`,
  `getTopLayerElements`) and would have authorised every future member of those families without
  anyone noticing. The policy is now 19 full method names (`CDP_ALLOWED_METHODS`, frozen) compared
  by equality, so an unknown name is denied by construction.
- **Nine more DOM methods were reviewed out** (hand-listed earlier, not prefix spill):
  `collectClassNamesFromSubtree`, `getContainerForNode`, `getFrameOwner`,
  `getNodesForSubtreeByStyle`, `getQueryingDescendantsForContainer`, `getRelayoutBoundary`,
  `performSearch`, `requestChildNodes`, `requestNode`. All eighteen stay denied and stay listed as
  denied in the tests: bringing one back is a policy decision, not a bug fix.
- **Nothing gained:** every one of the 19 allowed names was already allowed before this change, and the
  plugin's own `Target.createTarget` / `Browser.getWindowForTarget` calls use the internal session, so
  background tabs and the window probe are unaffected.
- **The tests pin the property, not examples.** `tests/cdp-policy.test.ts` writes the reviewed list out
  independently and asserts it equals the source (so widening the policy takes two edits and shows up in
  review), and a probe set — uppercase/lowercase/digit/dot suffixes, case flips, truncation, trailing
  space, whole-domain prefixes — is filtered through the real matcher and compared as a set, so any
  looser matching rule fails the suite. Written test-first: against the old implementation these cases
  fail (`DOM.getDocumentZzz` rode in; `DOM.getAnchorElement` was allowed; the two lists disagreed).

### Fixed

- **The README update log was missing this version's heading** (docs). The 0.5.0 entry had been filed
  under the 0.4.0 heading, so the first thing a visitor read — in the repository `v0.5.0` points at —
  said the project stopped at 0.4.0 while the release list showed v0.5.0 as latest. The entry now opens
  its own section, and a guard asserts that the opening entry is always the newest minor release
  (`tests/docs-consistency.test.ts`). No runtime code changed for this fix: `src/` and `lib/` are
  identical to the earlier 0.5.0 commit, which is why the tag was moved instead of a 0.5.1 being cut.

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
