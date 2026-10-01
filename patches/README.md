# Patches

## `upstream-window-activation.patch`

Applies to **[ChenyuHeee/dsh-browser-playwright](https://github.com/ChenyuHeee/dsh-browser-playwright)** `main` (v0.1.1 source tree). Verified with `git apply --check` on a fresh clone; **not** compiled or run against upstream's test suite. The same helper code lives in this fork's `src/playwright.ts` (0.3.0+), where it does type-check and is exercised by tests — that is the strongest evidence available for these bodies, but it is not evidence about upstream's tree.

```sh
git clone https://github.com/ChenyuHeee/dsh-browser-playwright
cd dsh-browser-playwright
git apply /path/to/upstream-window-activation.patch
pnpm install && pnpm test
```

What it changes (`src/playwright.ts`, 61 insertions / 5 deletions):

| Change | Why |
|---|---|
| `+ isWindowMinimized(page)` | Reads the OS window state through CDP `Browser.getWindowForTarget` + `Browser.getWindowBounds`; returns `true` when unreadable, so an unreadable state never moves the user's window |
| `switchTab`: gate `page.bringToFront()` on `!isWindowMinimized(page)` | Tab selection is a context-level concern; activation is a side effect the plugin can decline. Behaviour with a visible window is unchanged |
| `+ createBackgroundPage(context)` | Creates a tab via `Target.createTarget({ background: true })` instead of `context.newPage()`, so Chromium does not activate the window. Falls back to `newPage()` on any failure |
| `openTab`, `ensurePage` (both fallbacks): route through `createBackgroundPage()` | Same justification; the `ensurePage` fallbacks are unreachable in the paths exercised here and are converted for consistency only |

Why it matters: upstream defaults to `headless: true`, so neither call site is visible in the default configuration. The moment a user sets `launch.headless: false` — which is how a human gets pulled in at all — every tab switch and every tab creation drags a **minimized** window back onto the screen.

> Update: a later measurement round found that this patch's `isWindowMinimized()` helper works in headless too (it returns `false`, so nothing is silently disabled there), and that **native dialogs do not need a window** — so "headful is needed for dialogs" (an earlier claim of ours) is wrong. See [`../docs/MODE-TRADE-OFFS.md`](../docs/MODE-TRADE-OFFS.md).

The evidence, the reproduction script, and the honest limits of both are in [`../docs/FOCUS-STEALING.md`](../docs/FOCUS-STEALING.md).

## Not included on purpose

The fork also gates its post-operation login-state export (`persistStateSoon` → `context.storageState()`) while the window is minimized. That change is a **mitigation for an unreproduced mechanism** (see Cause 3 in the analysis): the same call is measurably safe in a minimal harness. It is fork-specific — upstream v0.1.1 has no persistent-profile state export — so it does not belong in an upstream patch.
