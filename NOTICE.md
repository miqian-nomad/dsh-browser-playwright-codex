# NOTICE — licensing split, provenance, and third-party content

This repository mixes work from four different origins. They are **not** under one licence, and the split is deliberate.

本仓库的内容来自四个不同来源，**不是单一许可**，切分如下。

## 1. The plugin — MIT (`./LICENSE`)

Covers everything that is part of the plugin: `src/`, `tests/`, `scripts/`, `cordis.patch.yml`, `tsconfig.json`, `package.json`, `CHANGELOG.md`, and the plugin's own documentation (`README.md`, `SECURITY.md`, `NOTICE.md`, `PLUGIN-README.md`, `DIALOG-POLICY.md`, `SAFETY-RULES.md`, `SNAPSHOT-RULES.md`, `codex-rules.md`, `中文说明.md`, `对比与优势.md`, and the articles under `docs/articles/`).

| Origin | What | Licence |
|---|---|---|
| [ChenyuHeee/dsh-browser-playwright](https://github.com/ChenyuHeee/dsh-browser-playwright) v0.1.1 | The accessibility-snapshot engine (`src/injected.ts`, `src/snapshot-render.ts`), the tool family (`src/tool.ts`), the service/provider seams (`src/service.ts`, `src/playwright.ts`), the URL policy, and the test-suite shape. Copyright (c) 2026 dsh-browser-playwright contributors. | **MIT** |
| This fork's merged layer | Geometric click (`browser_click` with `precise: true`) with landing-element reporting, the CDP policy layer (`src/cdp-policy.ts`), the persistent profile + login-state export (`src/provider.ts`, `persistState`/`restoreState`), dialog parking, the console/network diagnostics tools, the contract/compat modules, and the fixes listed in [`CHANGELOG.md`](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/CHANGELOG.md) | **MIT** |

**Why the plugin cannot be non-commercial:** it is a derivative of MIT-licensed work. MIT grants everyone the right to use, modify and redistribute the software **including commercially**, and a redistributor cannot add a non-commercial restriction to it. Any non-commercial claim over `src/` would be an unauthorised restriction — worse for downstream users than leaving it MIT. The MIT text in `./LICENSE` (including the upstream copyright notice) is unchanged.

## 2. This repository's analysis prose — CC BY-NC-SA 4.0 (`./LICENSE-DOCS`)

Covers only the two analysis documents produced *for this repository*:

- `FOCUS-STEALING.md`
- `MODE-TRADE-OFFS.md`

Share and adapt for **non-commercial** purposes with attribution and share-alike; commercial use is not permitted. Legal code: [`LICENSE-DOCS`](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/LICENSE-DOCS) (the licence text lives in the repository; it is not part of the npm tarball).

Note the deliberate boundary: these two documents are **not shipped in the npm package** — only `README.md`, `CHANGELOG.md`, `SECURITY.md` and `NOTICE.md` travel with the plugin, and all four are MIT (§1). As of 0.8.1 the tarball also carries the third-party file described in §3, under its own written permission — that file is **not** MIT, and §1 does not cover it.

## 3. The intro effect asset — third-party code, bundled with written permission

`assets/swarm-rebuild.js` (**shipped again in the npm tarball as of 0.8.1** — `package.json#files` lists `assets/`, minus the pristine baseline) is **not** this project's work. The position, stated plainly:

1. **We hold written permission from Joel Califa for the effect and its choreography** (2026-11-08, on file; his one condition was that he be credited). That credit is in [`README.md`](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/README.md#credits--the-intro-effect) and in the settings card.
2. **We hold written permission from Dhvanil Patel for the script** (email, 2026-11-11, on file): he is "happy for you to use and adapt the animation", and answers "yes, you are welcome to bundle and modify it as needed". **Bundling and modification are both covered.** No MIT (or other OSI) licence was granted — the grant is that written email, not a licence text, and it does **not** give third parties a general licence to extract and re-use the file.
3. **This project claims and grants no rights in that file.** It travels inside this package under that permission only. If either author withdraws it, the file — and the feature that injects it — will be removed on request.

| Origin | What | Status |
|---|---|---|
| [califa/swarm-site](https://github.com/califa/swarm-site) — **Joel Califa** | The effect itself: the page wiped white, the swarm of cursors, and the choreography that draws boxes, text and images back. The published copy declares no licence. | Written permission, 2026-11-08, condition: credit. Done. |
| [DhvanilPatel/swarm-cursors](https://github.com/DhvanilPatel/swarm-cursors) — **Dhvanil Patel** | `swarm-rebuild/swarm.js` at commit `3d49e0ac` (2026-11-06). That repository declares no licence ("None yet") and its README says the original Swarm was released without one. | Written permission by email, 2026-11-11: bundle + modify. Bounded to this project. |

**Modified, and the modification is disclosed.** `assets/swarm-rebuild.js` is that upstream file **with seven changes**, applied by [`scripts/swarm-patch.mjs`](https://github.com/miqian-nomad/dsh-browser-playwright-codex/blob/main/scripts/swarm-patch.mjs): (1) the vendor's own bottom control bar is removed; (2) its four DOM fields are pointed at off-screen placeholders so the rest of the code keeps working; (3) its per-frame HUD refresh returns early; (4) the end-of-playback button updates are null-guarded — that last one is a real crash fix: without it the asset throws as soon as the animation completes; (5) scanning waits for the plugin's go-ahead (so the snapshot is taken before the page is scrolled); (6) the white background no longer fades in over 0.5 s, and on early starts the scroll environment is re-detected once after the page loads; (7) its final self-start is deferred until `<html>` exists, so the whole engine can run from `addInitScript` before the page's own scripts. The patched file ships inside the npm package as of 0.8.1, while the pristine upstream baseline stays **in the repository only** (`assets/swarm-rebuild.upstream.js`, SHA-256 `6a30f19d…c7bfe`) — so anyone can diff what we changed and regenerate the patched file with `npm run swarm:patch`, or check that it still matches with `npm run swarm:check`.

**运行方式也被改了**：本项目不是等网页加载完再运行这份第三方脚本，而是通过 Playwright 的 `addInitScript` 把它放到**网页自己的脚本之前**执行（只在顶层文档、且带一个 30 秒内有效的 `window.name` 标记时启动），启动时机再由 `window.__dshSwarmGo` 放行控制。也就是说，第三方作品的启动流程、注入时机和运行上下文都由本项目重新安排过；这一步同样落在 Dhvanil 邮件许可的「modify」范围内。

**中文**：`assets/swarm-rebuild.js` **改过**（0.8.1 起重新随 npm 包分发；原始基线只留在仓库），改动共七处 —— ①删掉原版自带的底部控制条；②把它的四个界面字段指向离屏占位元素（否则下游代码会抛错）；③让每帧的界面刷新提前返回；④播完那一下设置按钮显示状态的代码加空值保护（这一处是**真崩溃修复**：不改的话动画一播完就抛错）；⑤扫描改成等插件放行、开场至少停 2.8 秒（拍快照前不滚页面）；⑥白底去掉 0.5 秒淡入、第一帧就盖死，提前启动时页面加载完再重认一次滚动环境；⑦结尾自启动改成「等 `<html>` 出现」，这样整台引擎能在网页脚本之前就跑起来。**打包和修改都已获得 Dhvanil Patel 邮件书面许可（2026-11-11）**；许可只覆盖本项目随插件分发，不是给第三方的通用许可，也没有附 MIT 许可文本。补丁产物随包走，原始基线 `assets/swarm-rebuild.upstream.js` 留在仓库（SHA-256 可核对），所以任何人都能 diff 出我们改了什么，用 `npm run swarm:patch` 复原生成、用 `npm run swarm:check` 校验。

What this means for you: §1 (MIT) does **not** cover `assets/swarm-rebuild.js`; it travels in the package under the authors' written permission to this project. That permission is **not** a licence to you — if you want to re-use that file elsewhere, ask the two authors yourself.

## 4. Third-party content that is **not** redistributed here

- **No OpenAI code is included in this repository.** Nothing from the bundled Codex browser plugin (`extension-host.exe`, the Chrome extension, `browser-client.mjs`, its `node_modules`) is copied, linked, decompiled or redistributed here.
- `codex-rules.md` is an **independently written Chinese summary of browser-automation behaviour**, produced by studying publicly observable behaviour and a locally installed copy of that plugin's documentation. It contains no verbatim reproduction of that documentation; what it does contain is a *source map* (file names such as `docs/browser-safety.md`) so readers can consult the originals themselves. Facts and ideas are not copyrightable; the expression here is this project's own.
- **Rights in the original Codex documentation and browser plugin remain with their owner (OpenAI).** If you are that owner and you object to the source map or to any phrasing here, open an issue and it will be removed.
- `openai/codex` (the CLI) is Apache-2.0. It is mentioned for context only; no code from it is included.

## 5. If you need a different split

Want the analysis prose under a permissive licence, or the whole thing MIT? Open an issue — that licence is a choice, not a constraint. The plugin's licence is not (see §1).
