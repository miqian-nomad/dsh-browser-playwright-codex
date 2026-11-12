# 0.7.0 发布说明与迁移步骤

状态：分支 `merge-toggle-into-codex` 全绿（229 测试 / 225 过 / 0 失败 / 4 跳过、verify 57/57、preflight **0 处硬错误**）。
**尚未合入 main、尚未发布。**

## 一句话

两个插件（浏览器插件 + 设置卡）合成**一个**；常驻成本 −486 token/轮；快照 −58.6%/次；`browser_fill` 改为**机制级拒绝**密码/OTP/卡号字段。

## 破坏性变更（唯一一条）

配置从**三行 loader** 变成**一行**：

```yaml
# 旧（0.6.x）
- id: browser
  config: { provider: playwright }
- id: browser-playwright
  config: { launch: …, snapshot: … }
- id: browser-tool
  config: { toolPrefix, allowEvaluate, allowCdp, … }

# 新（0.7.0）
- id: browser
  name: 'dsh-browser-playwright-codex'
  config:
    service: { provider: playwright }
    playwright: { launch: …, idleTimeoutMs, maxSessions, allowedDomains, snapshot: … }
    tool: { toolPrefix, allowEvaluate, allowCdp, diagnostics, … }
```

原因：`dsh-client-modules` 拒绝一个包被多个 active loader 源挂载，而设置卡需要 client 模块 —— 一个包只能有一个入口。
loader **整体替换 config**，迁移时三节都要写全（设置卡会自动重写 home 补丁层里的那一块）。

## 这一版装了什么

| 类别 | 内容 | 实测 |
|---|---|---|
| 合并 | 设置卡（host 半 + client 半 + 闸门写入块）并入本包；`dsh-browser-toggle` 退役 | 单 loader 行 |
| 成本 | `console_messages` / `network_requests` 改为门控（`tool.diagnostics`） | 3,543 → **3,057** token/轮（−13.7%） |
| 成本 | 快照折叠无名包装层 + href 去追踪参数/截断 | 百度形状样本 6,169 → **2,557** 字符（−58.6%） |
| 安全 | `browser_fill` 拒绝 password / one-time-code / cc-* 字段（`CREDENTIAL_FIELD`） | 真 Chrome e2e 已验证 |
| 口径 | README/中文说明/SECURITY/registry 改为「弹窗=机制级、验证码=提示不阻断、登录=无探测器、密码类=拒绝」，并加守卫 | 守卫全绿 |
| 文档 | 清掉合并引入的漂移（配置示例、工具表、行名引用、成本数字） | 4 份文档 + 2 张表 |

## 验证清单（本地已跑）

- `node --test "tests/*.test.ts"`（默认 per-file isolation，真 Chrome）：**229 / 225 / 0 / 4**
- `node scripts/dsh-browser-verify.mjs`：**全部通过（57 项）**
- `node scripts/preflight.mjs .`：**0 处硬错误**（2 处待确认均为 CHANGELOG 里的历史包名）
- `npm run cost`：16 工具 / 11,179 字符 / ~3,105 token/轮（全量 21 ≈ 4,384）

## 发布步骤（需要代理 127.0.0.1:10808 重新开启）

1. `git checkout main && git merge --ff-only merge-toggle-into-codex`（或 PR 合并）
2. `git tag -a v0.7.0 -m "v0.7.0 — 一个插件：设置卡并入 + 成本/快照瘦身 + 凭据字段机制级拒绝"`
3. `git push origin main --tags` → 等 CI（双系统，含 typecheck + preflight + lib 同步守卫）
4. 创建 GitHub Release（notes 取 CHANGELOG 0.7.0 节）→ 触发 `publish.yml` 自动发 npm
5. 核对 npm：`dsh-browser-playwright-codex@0.7.0`，包内文件数应 ≥ 82（新增 `lib/client.js`、`lib/plugin.js`、`lib/settings-card.js`、`lib/gates-patch.js`）
6. `npm deprecate dsh-browser-toggle@0.3.0 "merged into dsh-browser-playwright-codex 0.7.0"`
7. 更新插件市场条目（本地 `registry/awesome-dsh-plugin.yml` 已是 16/5 口径，按文件头注释的 `gh api -X PUT` 更新 fork 分支）

## 本机迁移（发布后、重启前）

1. `~/.dsh/cordis.patch.yml`：把 `# >>> dsh-browser-toggle … >>>` 标记块换成 `# >>> dsh-browser … >>>` 单行块（**或** 打开设置卡随便点一下，插件会自动重写这一块；旧标记会被就地替换）
2. `~/.dsh/profiles/{web,desktop}/package.json`：`dsh.profile.bundles` 去掉 `dsh-browser-toggle`
3. 删除 `~/.dsh/profiles/{web,desktop}/node_modules/dsh-browser-toggle` 两个 junction
4. 重启 DSH；确认：工具面 16 个常驻（`allowEvaluate`/`allowCdp` 打开后 18）、设置→插件→浏览器卡片在、`browser_fill` 填密码字段报 `CREDENTIAL_FIELD`

## 回滚

分支与 tag 都保留在远端；`git checkout v0.6.6` 可回到三行配置（此时不要把 0.7.0 的 home 补丁块留着 —— 它是单行形状）。
