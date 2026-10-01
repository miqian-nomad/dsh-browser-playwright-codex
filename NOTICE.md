# NOTICE — licensing split, provenance, and third-party content

This repository mixes work from three different origins. They are **not** under one licence, and the split is deliberate.

本仓库的内容来自三个不同来源，**不是单一许可**，切分如下。

## 1. The plugin — MIT (`./LICENSE`)

Covers everything that is part of the plugin: `src/`, `tests/`, `scripts/`, `cordis.patch.yml`, `tsconfig.json`, `package.json`, `CHANGELOG.md`, and the plugin's own documentation (`docs/PLUGIN-README.md`, `docs/DIALOG-POLICY.md`, `docs/SAFETY-RULES.md`, `docs/SNAPSHOT-RULES.md`, `docs/codex-rules.md`).

| Origin | What | Licence |
|---|---|---|
| [ChenyuHeee/dsh-browser-playwright](https://github.com/ChenyuHeee/dsh-browser-playwright) v0.1.1 | The accessibility-snapshot engine (`src/injected.ts`, `src/snapshot-render.ts`), the tool family (`src/tool.ts`), the service/provider seams (`src/service.ts`, `src/playwright.ts`), the URL policy, and the test-suite shape. Copyright (c) 2026 dsh-browser-playwright contributors. | **MIT** |
| This fork's merged layer | Geometric click (`browser_click_at`) with landing-element reporting, the CDP policy layer (`src/cdp-policy.ts`), the persistent profile + login-state export (`src/runtime-state.ts`, `persistState`/`restoreState`), dialog parking, the console/network diagnostics tools, the contract/compat modules, and the fixes listed in [`CHANGELOG.md`](CHANGELOG.md) | **MIT** |

**Why the plugin cannot be non-commercial:** it is a derivative of MIT-licensed work. MIT grants everyone the right to use, modify and redistribute the software **including commercially**, and a redistributor cannot add a non-commercial restriction to it. Any non-commercial claim over `src/` would be an unauthorised restriction — worse for downstream users than leaving it MIT. The MIT text in `./LICENSE` (including the upstream copyright notice) is unchanged.

## 2. This repository's analysis prose — CC BY-NC-SA 4.0 (`./LICENSE-DOCS`)

Covers only the writing produced *for this repository*:

- `README.md` (this repository's landing page)
- `docs/FOCUS-STEALING.md`
- `docs/MODE-TRADE-OFFS.md`

Share and adapt for **non-commercial** purposes with attribution and share-alike; commercial use is not permitted. Legal code: [`LICENSE-DOCS`](LICENSE-DOCS).

Note the deliberate boundary: the plugin's *own* documentation is not in this set — it ships with the plugin under MIT, so that the whole plugin stays redistributable on MIT terms.

## 3. Third-party content that is **not** redistributed here

- **No OpenAI code is included in this repository.** Nothing from the bundled Codex browser plugin (`extension-host.exe`, the Chrome extension, `browser-client.mjs`, its `node_modules`) is copied, linked, decompiled or redistributed here.
- `docs/codex-rules.md` is an **independently written Chinese summary of browser-automation behaviour**, produced by studying publicly observable behaviour and a locally installed copy of that plugin's documentation. It contains no verbatim reproduction of that documentation; what it does contain is a *source map* (file names such as `docs/browser-safety.md`) so readers can consult the originals themselves. Facts and ideas are not copyrightable; the expression here is this project's own.
- **Rights in the original Codex documentation and browser plugin remain with their owner (OpenAI).** If you are that owner and you object to the source map or to any phrasing here, open an issue and it will be removed.
- `openai/codex` (the CLI) is Apache-2.0. It is mentioned for context only; no code from it is included.

## 4. If you need a different split

Want the analysis prose under a permissive licence, or the whole thing MIT? Open an issue — that licence is a choice, not a constraint. The plugin's licence is not (see §1).
