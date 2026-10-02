# 官方 Discussions 发帖草稿（可直接贴）

> **已发布（B 版）**：<https://github.com/deepseek-ai/deepseek-harness/discussions/8685>
> 板块 Show Your Plugins! · 作者 miqian-nomad · 2026-10-02T15:22Z
> 待办：观察回复并逐条回答；A 版（兼容性报告）按计划隔一两天发到 General。

两个版本：**A 是短版兼容性报告**（按 dsh.so 提交页给的模板格式，他们明说会把 Discussions 上的实测并入数据）；
**B 是长版"交作业"帖**（更能带来点击）。

发布位置：<https://github.com/deepseek-ai/deepseek-harness/discussions>

官方仓库的实况（2026-10-02 查）：★242k、**Issues 已关闭**（`has_issues: false`）→ **Discussions 是唯一的官方沟通渠道**；
共 8,536 条讨论，当天仍有多帖在动。板块有：Announcements / General / Ideas / Polls / Q&A / **Show Your Plugins!**

| 内容 | 发到哪个板块 | 链接 |
|---|---|---|
| **B（插件展示长帖）** | **Show Your Plugins!** ← 就是为这个开的 | `/discussions/new?category=show-your-plugins` |
| **A（兼容性实测报告）** | **General** | `/discussions/new?category=general` |
| 以后回答别人的"怎么让 AI 操作网页" | **Q&A**（比发自己的帖回报更高） | `/discussions/new?category=q-a` |

建议顺序：先在 **Show Your Plugins!** 发 B（有内容、有人味），隔一两天再把 A 作为其回复或单独发到 General。
**别把 B 发到 Ideas 或 Announcements** —— 前者是提需求，后者只有维护者能发。

---

## A. 短版：插件兼容性报告

```
插件：@miqian-nomad/dsh-browser-playwright-codex
      https://github.com/miqian-nomad/dsh-browser-playwright-codex
dsh 版本：0.2.0-rc.1
安装方式：源码（dsh plugin --profile web add github:miqian-nomad/dsh-browser-playwright-codex）
结果：通过

补充信息（供并入数据时参考）：
- 环境：Windows 11 x64，Node v24.16.0，本机已装 Chrome（插件自动探测 chromium→chrome→msedge→edge，无需下载浏览器）
- 有头模式 + 持久 profile；最小化后连续切标签/开标签不抢焦点（复现脚本 scripts/analysis/repro-minimize.mjs）
- 插件自带验收 57 项全过（不需要 DSH、不需要联网）：npm run verify
- 单元/场景测试 100+ 项：npm test
- 安全边界与第三方扫描结论的逐条解释：SECURITY.md
```

---

## B. 长版：我为了让 AI 用**我自己的登录态**上网，踩了三个坑（附复现脚本）

> 标题建议：**《DSH 浏览器插件踩坑记录：抢焦点、会话 cookie、和一个静默点错元素的 bug》**

正文要点（每条都有仓库里的出处，不是感想）：

1. **窗口抢焦点有三个独立根因**，其中两个在 Playwright 上游、一个在持久化实现里：
   `switchTab` 的无条件 `bringToFront()`、`context.newPage()` 必然激活窗口、以及 `storageState()`
   为了覆盖未打开的 origin **会开一个临时页面**。第三个最隐蔽 —— 你以为"它自己跳"，其实是它在导出登录态。
   → 60 行、不依赖插件的复现脚本在 `scripts/analysis/repro-minimize.mjs`。

2. **"登录一次一直记得"的难点全在会话 cookie**（关窗即丢的那类）。做法：独立 profile + 关窗前导出、
   启动时回注；并且**最小化时跳过完整导出**（只取 cookies），否则修好了抢焦点又被导出拽回去。

3. **一个静默点错元素的 bug（已修）**：智能模式曾把 DOM 侧的 ref 列表**按位置**贴到无障碍树上，
   页面上只要有一个"树看不见但 DOM 侧仍编号"的元素（重渲染留下的 0×0 残留），后面每个 ref 就整体错位 ——
   实测在 dsh-plugin.market 上，快照把输入框标成 `…411`，而 `…411` 其实是个隐藏链接。修法：DOM 侧跳过不可见元素
   + 对齐层改为**校验身份**（角色不符就拒绝整棵树、退回兼容模式），并在验收里加了一个"隐藏元素排在按钮前面"的
   端到端用例。

4. **遇事停下来等人**：原生对话框机制级挂起、验证码/登录交还给用户；CDP 只放行检查与输入模拟。
   `SECURITY.md` 里逐条解释了第三方扫描报的 2 个 Critical 是什么、什么条件下才可达（默认关闭）。

5. 想要 GUI 开关：配套插件 `dsh-browser-toggle`（设置页卡片，可开关功能、切换页面识别方式、开关两个强力工具）。

安装：

```sh
dsh plugin --profile web add github:miqian-nomad/dsh-browser-playwright-codex
```

---

## 发布前的检查清单（给自己）

- [ ] 帖子里**没有**"最强/吊打/秒杀"这类词，只有可验证的事实与出处
- [ ] 链接可点：仓库、SECURITY.md、FOCUS-STEALING.md、DIALOG-POLICY.md
- [ ] 不要求别人点星（第一次就要星很尴尬）；等有人真说好用再提
- [ ] 有人提问就**回答**，别把帖子当广告位
