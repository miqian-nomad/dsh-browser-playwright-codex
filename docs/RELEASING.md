# 发版清单

按顺序做，**上一步红了就不许往下走**。这份清单的存在理由是两次真实事故：一次是测试没跑完却判绿
（0.7.8 有 7 条被取消，对外仍说"278 通过"），一次是保存设置写出重复键的非法 YAML，让 DSH 下次启动
直接 fatal（issue #4）。

## 0. 现场读数字，不凭印象

```powershell
(Get-Content package.json -Raw | ConvertFrom-Json).version
git tag --sort=-creatordate | Select-Object -First 3
```

版本号、tag、包内条目数，全部**现场读**。过去的报告里出现过"照记忆报 0.7.7、实际 0.8.0"。

## 1. 升版本

- `package.json` 的 `version`（`package-lock.json` 顶部与 `packages[""]` 两处同步）
- `CHANGELOG.md` 顶部新开一节（标题里的版本必须等于 `package.json`，有守卫测试盯着）
- `README.md` 的「更新记录」只记 **minor** 里程碑；补丁版本进 CHANGELOG 就够了（也有守卫）

## 2. 六项门禁

```powershell
npm run typecheck
npm run build
npm run format:check
npm test
npm run verify
npm run preflight
```

- `npm test` 的摘要必须满足 **tests = pass + fail + cancelled + skipped + todo**，且
  `cancelled` / `todo` 都是 0。preflight 会自己核对这条恒等式；对不上就是硬错误。
- `npm run preflight` 的"待确认"必须逐条看过，不能当成噪声。

## 3. 真碰互联网的 live 三条（**手动，必跑或明写没跑**）

```powershell
$env:DSH_BROWSER_LIVE='1'; npm run test:live; Remove-Item Env:\DSH_BROWSER_LIVE
```

- 它**故意不在 `prepublishOnly` 里**：CI 没网会不稳，硬塞会把发版卡在网络抖动上。
- 结论写进 **Release 正文**（跑了就是"live 3 条通过"，写明日期）。
- **没跑就在 `CHANGELOG.md` 里明写「本次未跑 live」**。preflight 每次都会把这件未验证的事
  摆到"待确认"里，不许它悄悄消失。

## 4. 配套件跨仓库检查（有配套件目录就跑）

```powershell
$env:DSH_TOGGLE_DIR='<配套件仓库路径>'; npm run test:toggle; Remove-Item Env:\DSH_TOGGLE_DIR
```

- 它读的是**邻座仓库** `dsh-browser-toggle` 的文档，不在默认套件里（`tests/cross-repo/`），
  所以默认套件的数字在任何机器上都一致。
- 设了 `DSH_TOGGLE_DIR`，`npm run preflight` 会顺手跑它并把它当硬错误；没设，preflight 会明写
  **「未验证」**。

## 5. 打包清单

```powershell
npm pack --dry-run
```

确认：没有 `tests/`、没有 `_` 开头的临时脚本、没有 `.bak`、没有任何本机绝对路径或昵称，
该在的都在（`lib/`、`locale/`、`cordis.patch.yml`、`NOTICE.md`）。

## 6. 提交、推、tag

```powershell
git add -A
git commit -m "chore(release): X.Y.Z —— 一句话说这次修了什么"
git -c http.proxy=<你的代理地址> push gh main
git tag -a vX.Y.Z -m "vX.Y.Z — 一句话"
git -c http.proxy=<你的代理地址> push gh vX.Y.Z
```

推完核对：`git ls-remote gh refs/heads/main` 的 SHA 必须等于本地 `git rev-parse HEAD`。

## 7. GitHub Release + npm

- Release 正文用中文，分两段写：**这批修了什么** / **其它变更（例如恢复进场动画并注明已获授权）**。
- 正文里写清 live 三条跑没跑。
- `npm publish` 会再跑一遍 `prepublishOnly`（build / typecheck / test / swarm:check / verify / preflight）。
- 发布后现场核对：`npm view <包名> version` 的实际输出。

## 8. 收尾自检

- 工作区干净（`git status`）
- 没有残留临时文件
- 没有把本机路径、本机昵称带进仓库或包

## 附：覆盖率（不是门禁）

```powershell
npm run coverage
```

用 Node 自带的 `--experimental-test-coverage` 出数，并额外列出 **0 覆盖**（从来没被任何测试加载）
的模块 —— 自带报告只列加载过的文件，恰好藏掉最该看的那些。**不要**立刻拿它卡人。