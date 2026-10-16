# Security

This plugin drives a **real browser with your login state**. That is the point of it, and it is also
the thing worth being careful about. This file answers the two questions a reader actually has:

1. **What can it do to me?**
2. **Why does dsh.so's scanner report a Critical finding?**

If you only read one line: **the two findings are the implementation of `browser_evaluate`, a tool
this package ships switched off** — it is not registered at all until a deployment turns it on.

---

## 1. What it can and cannot do

**It drives your browser, as you.** The provider opens a visible, profile-backed Chromium-family
window (`~/.dsh/browser-profiles/playwright` by default) and reuses the logins already in it. It does
not have your passwords, and it never types them: when a login, a 2FA prompt or a captcha appears,
the agent is supposed to stop and hand the page back to you.

**It is visible and interruptible.** The window lives on your desktop. You can watch every action,
minimise it (the provider detects a minimised window and keeps working without raising it — see
[FOCUS-STEALING.md](FOCUS-STEALING.md)), or close it: login state is exported first and restored on
the next launch.

**Native dialogs are never auto-accepted.** `alert` / `confirm` / `prompt` / `beforeunload` are
parked as a pending state, reported to the model, and answered only by an explicit `browser_dialog`
call — a click that raises `confirm()` returns the parked dialog instead of accepting it. See
[DIALOG-POLICY.md](DIALOG-POLICY.md).

**Which hosts it may touch is policy, not goodwill.** `allowedDomains` is enforced on every path that
can navigate: `browser_navigate`, `browser_open_tab`, every click variant (ref, text, geometric,
raw coordinates) and `browser_switch_tab`. It is **not** a sandbox: a page's own JavaScript
(`location.href = …`) can still leave the list, and a tab already sitting on a disallowed host stays
open (the agent simply refuses to drive it). For hard isolation, put an external network guard around
it.

**`browser_cdp` is CDP with an allow-list.** Nineteen methods pass, matched by **exact name with no
family prefixes**: DOM reads (geometry, node lookup, attributes, markup), one focus action, the four
trusted input events (`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `dispatchTouchEvent` /
`insertText`) and read-only Page / CSS helpers. Network, storage, cookie, security, arbitrary-JS
(`Runtime.evaluate`), `Page.navigate`, `Page.getResourceContent` and the debugger-internal DOM
commands are rejected before they reach the browser. The list lives in `src/cdp-policy.ts`, is frozen,
and has its own adversarial test file: a method it has never heard of is denied, so a future Chromium
command cannot widen the surface on its own.

**The two power tools are off in the package.**

| Gate | What it registers | Shipped default |
|---|---|---|
| `allowEvaluate` | `browser_evaluate` — run one JavaScript expression in the page | **`false`** |
| `allowCdp` | `browser_cdp` — raw CDP, restricted by the allow-list above | **`false`** |

While a gate is off the tool is **not registered at all**, so it does not exist for the model and
costs no prompt tokens. But this file travels inside the package, so if it enabled them, every
installer would get a backdoor they never asked for; the opt-in belongs to the deployment, and it
lives in that deployment's own patch layer (the bundled Settings card writes it, or edit your
profile patch — see the configuration section of the [README](README.md)).

**No telemetry.** The plugin does not phone home and does not upload page content anywhere. The only
outbound traffic is what the page itself requests — plus one exception you control: `browser_extract`
is registered only when you configure an LLM route (`extract.provider` + `extract.model`) and it
sends the page text in that prompt, bounded by `extract.maxInputChars`.

**Where it writes.** A login-state JSON file (cookies + localStorage) under your DSH home, the
runtime state file `~/.dsh/dsh-browser-playwright.state.json`, and the browser profile directory.
Nothing else.

---

## 2. What the scanner reports, and which gate contains it

dsh.so runs `dsh-plugin-vet` over the whole repository. Their scan of **v0.5.3 (2026-10-11)** reports
**1 Critical, 3 Warning, 22 Info** across 75 files — and it is **right about the capability**. Here is
each one, with the gate that decides whether it is reachable at all.

> For the record: their v0.4.9 scan — before this plugin was split into responsibility-scoped modules —
> reported 2 Critical, 5 Warning, 26 Info across 57 files. Counts move as the scanner and the code
> change; **their report is the live number**, and this table is a map, not a snapshot.

| Level | Finding (as reported) | What it actually is | Reachable when |
|---|---|---|---|
| Critical | `new Function('return (' + expression + ')')` — reported in `lib/session.js` (source: `src/session.ts`) | The body of **`browser_evaluate`**: it wraps your expression and runs it in the page. This is what "run JavaScript in the page" means; there is no way to implement it without dynamic evaluation. | Only when `allowEvaluate: true`. **The package ships `false`, so the tool is not registered.** |
| Warning | `fs.writeFileSync` of a JSON blob (`lib/login-state.js`, `lib/runtime-state.js`) | Exporting the login state (`cookies` + `localStorage`) so a closed window can be reopened still logged in, and the small runtime state file behind the Settings switches. | Always — it is how login persistence works. The files live under your DSH home. |
| Warning | HTTP request to a bare IP (`scripts/dsh-browser-verify.mjs`) | The acceptance suite starts a **local** `http.server` on `127.0.0.1` with a fixture page, so `npm run verify` needs no DSH and no internet. | Only when you run that script. |
| Info ×22 | `localStorage` reads, `process.env` reads, hardcoded `127.0.0.1`, dev-only probe scripts | Restoring login state; test hooks (`DSH_BROWSER_STATE_FILE`, `PLAYWRIGHT_DOWNLOAD_HOST`); and scripts under `scripts/analysis/` that the scanner itself marks *"Dev-only file — not executed at install/runtime"*. | — |

Two honest notes:

- These numbers **will not go to zero**, because `browser_evaluate` exists in the code whether or not
  your deployment turns it on. A scanner that reads code cannot see a runtime gate.
- We did **not** try to hide the finding (moving the call, obfuscating it, or suppressing the rule).
  That would be deceiving the tool that is trying to protect users, and it would make this file a lie.
- Module names, not line numbers: this file used to cite a line number in `src/playwright.ts`, which the
  0.5.x split made meaningless (the code lives in `src/session.ts` now, and that file is a 55-line
  entry point). File names survive refactors; line numbers do not.

## 3. How to check all of this yourself

```sh
npm test          # 100+ unit, scenario and guard tests: contracts, tool schemas, scenarios,
                  # aria engine, CDP policy, diff, click/tab allow-lists, snapshot rendering,
                  # prompt budget, docs-vs-reality consistency
npm run verify    # 57 self-contained acceptance checks: no DSH, no network, local fixture server
npm run doctor    # the host packages this plugin imports are still exporting what it uses
npm run cost      # resident prompt cost of the registered tool surface
```

- CI runs the whole suite on **ubuntu-latest and windows-latest** for every push
  ([workflow](.github/workflows/ci.yml)).
- The gates really are off in the package:
  `git show v0.4.7:cordis.patch.yml` (0.4.7 is where that changed).
- Sandbox evidence, produced by someone else: [dsh.so's L4/L5 records](https://www.dsh.so/zh/artifact/dsh-browser-playwright-codex/)
  — note they pin a **specific frozen artifact**, so a newer release may still show an older record.

## 4. Reporting a problem

Open an issue on this repository. If it is about the scanner, quote the table above and include the
exact finding — the point of this file is that the answer does not have to be re-derived every time.

## 5. 隐私：设置页的「已登录的站点」名单

设置页多了一节只读展示：这台浏览器**像登录着**的站点。它由 provider 从浏览器自己给的 cookie 里推断，
出去的内容只有域名、cookie 条数和几个布尔信号（httpOnly / 长有效期 / 名字像会话）——**没有 cookie 的名字，
也没有值**；`src/login-sites.ts` 在唯一入口处就把 `value` 丢掉了，测试里有一条断言把整份产出
序列化后搜不到任何名字或值。

几条边界，写清楚是为了以后不被误改：

- **不读 Chrome 的密码库**（`Login Data`）。只碰 cookie，且只碰浏览器交出来的那份。
- **不落盘。** 这份摘要是内存态（`runtime-state` 的 `publishLoginSites`），DSH 重启即消失。
  卡片上"隐藏某一行"是**浏览器 localStorage 里的显示偏好**，不是服务端记录。
- **模型看不到。** 它不注册任何工具、不写进 diagnostics、也不出现在工具返回值里；唯一出口是
  `GET /api/browser-playwright/logins`，而该路由**强制要求 `x-dsh-plugin: browser-toggle` 自定义头**
  （自定义头会触发 CORS 预检，浏览器里的其它页面因此读不到它）。这条路由有测试盯着：不带头的请求必须 403。
- **它只是推断。** "有 cookie"不等于"登录着"，所以界面写的是"推测登录"；需要更确定时请自己打开窗口看。
