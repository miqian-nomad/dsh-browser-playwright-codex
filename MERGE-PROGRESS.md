# 合并进度（merge-toggle-into-codex 分支）

分支：`merge-toggle-into-codex`，工作树：`D:\dsh-plugins\_worktrees\browser-merged`
基线：`465e6fb`（0.6.6）。主仓库与线上插件**未改动**（DSH 仍加载 `D:\dsh-plugins\dsh-browser-playwright-codex` 的 main）。

## 为什么必须"一个包一行 loader"

`dsh-client-modules`（本机 asar 里 0.2.x 的 README，第 76 行）：

> Distinct active Loader sources resolving to one package name are rejected

设置卡需要 client 模块；本包原来被 3 个 loader 行挂载（`/service`、`/playwright`、`/tool`），
所以卡片只能另立包（dsh-browser-toggle）。一个包一行 loader 之后，卡片才能合法住进本包。

## 已完成（commit `66786e0`）

- [x] `src/plugin.ts`：单入口 `name='browser'`，config 嵌套 `service` / `playwright` / `tool`，内部 `ctx.plugin()` 挂三个子插件 + 设置卡。
- [x] `src/settings-card.ts`：toggle 0.3.0 的 host 半（4 条 `/api/browser-playwright/*` 路由 + CSRF）原样并入（`@ts-nocheck`）。
- [x] `src/gates-patch.ts`：重写为**整行 config**（loader 整体替换 config），新标记 `# >>> dsh-browser:`，兼容旧 `dsh-browser-toggle` 标记就地替换；保留 `writeGates/parseGatesBlock` 旧名。
- [x] `client/client.js`：client 半并入，`__ModuleLoader__` id 改为 `dsh-browser-playwright-codex`；`scripts/build-client.mjs` 复制到 `lib/client.js`。
- [x] `package.json`：0.7.0、`exports["./client"]`、`exports["./plugin"]`、`dsh.client`、build 链加 `build-client`。
- [x] `cordis.patch.yml`：一行 `- id: browser`，三块嵌套配置，闸门仍出厂关闭。
- [x] `src/index.ts`：根部导出 `name/apply/Config`（loader 从包根读这三个）。
- [x] `scripts/shipped-gates.mjs`：按新行名解析。
- [x] `CHANGELOG.md`：0.7.0 节（Breaking / Added / Changed）。
- [x] `README.md`：更新记录加 0.7.0；"配套件"段改成"卡片已在本包"；Known Limitations 的示例改成单行。
- [x] 守卫测试：`plugin-entry.test.ts` 改为断言"只有一个 loader 行 + 包根导出 name/apply/Config"；`docs-consistency` 的独立解析改为按新行名。
- [x] 构建通过（tsc exit 0），非浏览器守卫测试 13/13、40/40 绿（docs-consistency / plugin-entry / tool-schema / cross-doc / doc-reality）。

## 未完成（下一轮）

- [ ] **文档配置示例**：`README.md` 中部的大配置例子（约 238 行）、`PLUGIN-README.md`、`中文说明.md`、`SECURITY.md` 仍有 `- id: browser-tool` / `- id: browser-playwright` 写法（共 ~11 处），要改成嵌套单行。
- [ ] **全量非浏览器测试 + verify + preflight**：`node --test --test-isolation=none` 全量（本机沙箱起 Chrome 会 EPERM，需真机跑）；`npm run verify`、`npm run preflight`（preflight 会按 75 文件清单/成本基线校验）。
- [ ] **线上迁移**（等合入 main 再做）：
  1. `~/.dsh/cordis.patch.yml`：把 `- id: browser-tool` 块换成 `- id: browser` 整行（或让设置卡写一次，gates-patch 会把旧块就地替换）。
  2. `~/.dsh/profiles/{web,desktop}/package.json`：从 bundles 里去掉 `dsh-browser-toggle`，`node_modules` 里的 junction 删掉。
  3. 重启 DSH 验证工具面仍是 18/21 个，且设置卡出现在"插件"页。
- [ ] **退役 toggle**：README 顶部加"已并入本包"说明；npm 上 `npm deprecate dsh-browser-toggle`（需代理）。
- [ ] **旧版兼容检查**：0.6.x 的 P0 待办（口径统一 + `browser_fill` 拒绝密码/OTP 字段）尚未做，建议一并在 0.7.0 落地（见 HANDOVER-browser-plugin.md 的 P0 两条）。
