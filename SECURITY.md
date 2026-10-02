# Security

This plugin drives a **real browser with your login state**. That is the point of it, and it is also
the thing worth being careful about. This file answers the two questions a reader actually has:

1. **What can it do to me?**
2. **Why does dsh.so's scanner report "2 Critical"?**

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

**`browser_cdp` is CDP with an allow-list.** Only DOM inspection (geometry, node lookup, attributes)
and trusted input simulation (`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `dispatchTouchEvent`
/ `insertText`) pass. Network, storage, cookie, security and arbitrary-JS (`Runtime.evaluate`)
commands are rejected before they reach the browser — the list lives in `lib/cdp-policy.js` and has
its own test file.

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

## 2. Why the scanner reports "2 Critical"

dsh.so runs `dsh-plugin-vet` over the whole repository. On v0.4.9 it reports **2 Critical, 5 Warning,
26 Info** across 57 files — and it is **right about the capability**. Here is each one, with the gate
that decides whether it is reachable at all.

| Level | Finding (as reported) | What it actually is | Reachable when |
|---|---|---|---|
| Critical | `new Function('return (' + expression + ')')` — `src/playwright.ts` (~:2041) and its `lib/` mirror | The body of **`browser_evaluate`**: it wraps your expression and runs it in the page. This is what "run JavaScript in the page" means; there is no way to implement it without dynamic evaluation. | Only when `allowEvaluate: true`. **The package ships `false`, so the tool is not registered.** |
| Warning | `fs.writeFileSync` of a JSON blob (3 sites: `playwright.ts` ×2, `runtime-state.ts`) | Exporting the login state (`cookies` + `localStorage`) so a closed window can be reopened still logged in, and the small runtime state file behind the Settings switches. | Always — it is how login persistence works. The files live under your DSH home. |
| Warning | HTTP request to a bare IP (`scripts/dsh-browser-verify.mjs`) | The acceptance suite starts a **local** `http.server` on `127.0.0.1` with a fixture page, so `npm run verify` needs no DSH and no internet. | Only when you run that script. |
| Info ×26 | `localStorage` reads, `process.env` reads, dev-only probe scripts | Restoring login state; test hooks (`DSH_BROWSER_STATE_FILE`, `PLAYWRIGHT_DOWNLOAD_HOST`); and scripts under `scripts/analysis/` that the scanner itself marks *"Dev-only file — not executed at install/runtime"*. | — |

Two honest notes:

- These numbers **will not go to zero**, because `browser_evaluate` exists in the code whether or not
  your deployment turns it on. A scanner that reads code cannot see a runtime gate.
- We did **not** try to hide the finding (moving the call, obfuscating it, or suppressing the rule).
  That would be deceiving the tool that is trying to protect users, and it would make this file a lie.

---

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
