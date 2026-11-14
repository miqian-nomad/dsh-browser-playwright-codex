/**
 * Runs a saved script's steps against a live browser session.
 *
 * Shape of a run, and why:
 *  - A step list is executed in order, and the first failure ends the run. A
 *    script that continued past a failed click would act on a page that never
 *    got to where the script assumed, and every later step would be noise.
 *  - Each step uses the same session methods the individual tools call, so the
 *    URL policy, ref validation and credential refusal stay in force; a step
 *    cannot do anything the model could not do one call at a time.
 *  - A `text` target is resolved against the freshest snapshot immediately
 *    before the action, never against a snapshot taken at the start: that is
 *    the ref-staleness failure every mature runner designs around.
 *  - The failure result carries the index, the action and the snapshot from
 *    the last good step, so the model can take over from there instead of
 *    replaying the whole script blind.
 * @module dsh-browser-playwright-codex/script-runner
 */
import type { BrowserNode, BrowserSession, BrowserSnapshot } from './types.ts'
import { BrowserError } from './errors.ts'
import { describeStep, ScriptStepError, type ScriptStep, type ScriptTarget } from './script-steps.ts'

/** One step's result. */
export interface ScriptStepOutcome {
  /** 1-based index, as the model numbered the steps. */
  readonly index: number
  /** Human-readable line, e.g. `click "登录"`. */
  readonly step: string
  readonly ok: boolean
  /** What the step did, on success. */
  readonly note?: string
}

/** Everything one run produced. */
export interface ScriptRunOutcome {
  /** Steps attempted, including the one that failed. */
  readonly ran: number
  /** Steps in the script. */
  readonly total: number
  /** 1-based index of the failed step; absent when the whole script ran. */
  readonly failedAt?: number
  /** Action name of the failed step. */
  readonly failedAction?: string
  /** Failure message, unchanged from the underlying action. */
  readonly failure?: string
  /** Machine-readable code when the failure was a BrowserError. */
  readonly failureCode?: string
  /** Snapshot from the last step that succeeded (or the failed one's page). */
  readonly snapshot?: BrowserSnapshot
  /** Per-step log, oldest first. */
  readonly outcomes: readonly ScriptStepOutcome[]
}

/** How long a `urlContains` wait may take before the step fails. */
const URL_WAIT_TIMEOUT_MS = 15000
/** How often a `urlContains` wait re-reads the URL. */
const URL_WAIT_INTERVAL_MS = 250

/** Options for {@link runScript}. */
export interface RunScriptOptions {
  /** Cancellation from the calling tool execution. */
  readonly signal?: AbortSignal
  /** Called with the last working snapshot; used to publish login sites. */
  readonly onSnapshot?: (snapshot: BrowserSnapshot) => void
}

/**
 * Resolve a target to a ref using the freshest snapshot.
 *
 * A given ref is passed through untouched: the session validates it, and its
 * REF_NOT_FOUND is the honest answer when the page moved on. A label is matched
 * by accessible name — exact first, then a unique case-insensitive substring —
 * and an ambiguous or missing label fails loudly instead of clicking the first
 * thing that looks close, because a script that silently clicks the wrong node
 * is worse than one that stops.
 */
/** Every node in the tree, depth first: the labels a script targets live at any depth. */
function flatten(nodes: readonly BrowserNode[]): BrowserNode[] {
  const out: BrowserNode[] = []
  const walk = (list: readonly BrowserNode[]): void => {
    for (const node of list) {
      out.push(node)
      if (node.children.length > 0) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

function resolveRef(snapshot: BrowserSnapshot, step: number, target: { ref?: string; text?: string }): string {
  if (target.ref !== undefined) return target.ref
  const wanted = String(target.text ?? '').trim()
  // Walk the tree, not just the roots: a textbox sits three levels down under
  // paragraph > form, and matching only the roots found nothing (real run on
  // httpbin.org/forms/post, 2026-11-14).
  const nodes = flatten(snapshot.nodes).filter((node) => node.ref !== undefined)
  const exact = nodes.filter((node) => node.name.trim() === wanted)
  if (exact.length === 1) return String(exact[0]?.ref)
  if (exact.length > 1) {
    throw new ScriptStepError(step, String(exact.length) + ' elements are labelled "' + wanted + '"; use a ref instead')
  }
  const lower = wanted.toLowerCase()
  const partial = nodes.filter((node) => node.name.toLowerCase().includes(lower))
  if (partial.length === 1) return String(partial[0]?.ref)
  if (partial.length > 1) {
    throw new ScriptStepError(step, String(partial.length) + ' elements contain "' + wanted + '"; use a ref instead')
  }
  throw new ScriptStepError(step, 'nothing on the page is labelled "' + wanted + '"')
}

/** Index of the step that failed, when the error came from a target lookup. */
function failedStepOf(error: unknown): number | undefined {
  const withStep = error as { step?: unknown; name?: unknown }
  return typeof withStep.step === 'number' ? withStep.step : undefined
}

/**
 * Execute every step in order, stopping at the first failure.
 *
 * @param session - The calling session's live browser.
 * @param steps - Steps already validated by `parseScriptSteps`.
 * @param options - Cancellation and the snapshot callback.
 * @returns What ran, what failed, and the last working snapshot.
 */
export async function runScript(
  session: BrowserSession,
  steps: readonly ScriptStep[],
  options: RunScriptOptions = {},
): Promise<ScriptRunOutcome> {
  const outcomes: ScriptStepOutcome[] = []
  const { signal } = options
  // A snapshot taken before the first step, so a `text` target in step 1 has
  // something to resolve against without spending an extra tool call.
  // Lazy: a script that starts with navigate must not pay for a snapshot of
  // the page it is about to replace.
  let snapshot: BrowserSnapshot | undefined
  const current = async (): Promise<BrowserSnapshot> => {
    if (snapshot === undefined) {
      snapshot = await session.snapshot({ interactiveOnly: false })
      options.onSnapshot?.(await current())
    }
    return snapshot
  }

  /**
   * Resolve a step's element, re-reading the page once when a label misses.
   *
   * A label that resolved on the first run can miss on a replay because the
   * page rendered a beat late or a list came back one row shorter. Re-reading
   * once costs a snapshot and fixes that whole class outright. An explicit
   * `ref` is never retried: a ref belongs to the document that produced it, so
   * a fresh snapshot can only return new ones — the honest answer stays "this
   * ref is stale, take a new snapshot".
   */
  const resolveTarget = async (index: number, target: ScriptTarget): Promise<string> => {
    const first = await current()
    try {
      return resolveRef(first, index, target)
    } catch (error) {
      if (target.ref !== undefined || signal?.aborted === true) throw error
      snapshot = await session.snapshot({ interactiveOnly: false })
      return resolveRef(snapshot, index, target)
    }
  }

  /**
   * Run one element action on a step's target, re-pointing it once when the
   * page replaced the element between resolution and the action.
   *
   * Filling a search box is the canonical case: Wikipedia's header input is
   * swapped for a new node the moment it takes focus, so the ref read from the
   * snapshot `fill` returned is already stale for the `press` that follows
   * (measured on the cloud box, 2026-11-14 — the Linux run failed at the Enter
   * that had worked on Windows). A `REF_NOT_FOUND` also proves the action never
   * ran, so re-pointing cannot double-click; every other failure is propagated
   * untouched. A step that pinned an explicit `ref` is never retried: it asked
   * for that exact node, and a fresh snapshot can only hand back new ones.
   */
  const actOnTarget = async (
    index: number,
    target: ScriptTarget,
    action: (ref: string) => Promise<BrowserSnapshot>,
  ): Promise<{ snapshot: BrowserSnapshot; healed: boolean }> => {
    const ref = await resolveTarget(index, target)
    try {
      return { snapshot: await action(ref), healed: false }
    } catch (error) {
      if (target.ref !== undefined || signal?.aborted === true) throw error
      if (!(error instanceof BrowserError) || error.code !== 'REF_NOT_FOUND') throw error
      snapshot = await session.snapshot({ interactiveOnly: false })
      const fresh = resolveRef(snapshot, index, target)
      return { snapshot: await action(fresh), healed: true }
    }
  }

  const fail = (index: number, step: ScriptStep, error: unknown, fallbackCode: string): ScriptRunOutcome => {
    const browserError = error as { code?: unknown; message?: unknown }
    // The step error already prefixes "step N: "; the render adds the index
    // again, so strip it here instead of printing "step 3" twice.
    const raw = String(browserError.message ?? error)
    const message = raw.replace(/^step \d+: /, '')
    const base: ScriptRunOutcome = {
      ran: outcomes.length + 1,
      total: steps.length,
      failedAt: index,
      failedAction: step.action,
      failure: message,
      failureCode: typeof browserError.code === 'string' ? browserError.code : fallbackCode,
      outcomes: [...outcomes, { index, step: describeStep(step), ok: false, note: message }],
    }
    return snapshot === undefined ? base : { ...base, snapshot }
  }

  for (let i = 0; i < steps.length; i += 1) {
    const index = i + 1
    const step = steps[i]
    if (step === undefined) break
    if (signal?.aborted === true) break
    try {
      switch (step.action) {
        case 'navigate': {
          snapshot = await session.navigate(step.url, step.waitFor ?? 'domcontentloaded', signal)
          outcomes.push({ index, step: describeStep(step), ok: true, note: snapshot.title })
          break
        }
        case 'snapshot': {
          snapshot = await session.snapshot({ interactiveOnly: false })
          outcomes.push({ index, step: describeStep(step), ok: true, note: String(snapshot.totalRefs) + ' refs' })
          break
        }
        case 'click': {
          const result = await actOnTarget(index, step.target, (ref) => session.click(ref, signal))
          snapshot = result.snapshot
          outcomes.push({
            index,
            step: describeStep(step),
            ok: true,
            ...(result.healed ? { note: 're-pointed after the page re-rendered' } : {}),
          })
          break
        }
        case 'fill': {
          const result = await actOnTarget(index, step.target, (ref) => session.fill(ref, step.value, signal))
          snapshot = result.snapshot
          outcomes.push({
            index,
            step: describeStep(step),
            ok: true,
            ...(result.healed ? { note: 're-pointed after the page re-rendered' } : {}),
          })
          break
        }
        case 'press': {
          const result = await actOnTarget(index, step.target, (ref) => session.press(ref, step.key, signal))
          snapshot = result.snapshot
          outcomes.push({
            index,
            step: describeStep(step),
            ok: true,
            ...(result.healed ? { note: 're-pointed after the page re-rendered' } : {}),
          })
          break
        }
        case 'hover': {
          const result = await actOnTarget(index, step.target, (ref) => session.hover(ref, signal))
          snapshot = result.snapshot
          outcomes.push({
            index,
            step: describeStep(step),
            ok: true,
            ...(result.healed ? { note: 're-pointed after the page re-rendered' } : {}),
          })
          break
        }
        case 'scroll': {
          // `target` is optional: without it the whole page scrolls, which is
          // what "load more" flows need and what costs no element lookup.
          const ref = step.target === undefined ? undefined : await resolveTarget(index, step.target)
          snapshot = await session.scroll(step.direction, step.amount, ref, signal)
          outcomes.push({ index, step: describeStep(step), ok: true })
          break
        }
        case 'back': {
          snapshot = await session.back(signal)
          outcomes.push({ index, step: describeStep(step), ok: true, note: snapshot.url })
          break
        }
        case 'forward': {
          snapshot = await session.forward(signal)
          outcomes.push({ index, step: describeStep(step), ok: true, note: snapshot.url })
          break
        }
        case 'wait': {
          if (step.urlContains !== undefined) {
            // Polling the snapshot's URL is the only honest "the click
            // navigated" check available here: a text wait can be satisfied by
            // the text the same script just typed (seen on npmjs.com,
            // 2026-11-14 — the run reported the old page as the final one).
            const needle = step.urlContains
            const deadline = Date.now() + URL_WAIT_TIMEOUT_MS
            let hit = false
            while (Date.now() < deadline) {
              const probe = await session.snapshot({ interactiveOnly: true })
              if (probe.url.includes(needle)) {
                hit = true
                break
              }
              await session.wait(URL_WAIT_INTERVAL_MS, signal)
            }
            if (!hit) {
              throw new BrowserError(
                'ACTION_TIMEOUT',
                'the URL never contained "' + needle + '" within ' + String(URL_WAIT_TIMEOUT_MS / 1000) + 's',
              )
            }
          } else if (step.ms !== undefined) {
            await session.wait(step.ms, signal)
          } else {
            const condition =
              step.text !== undefined
                ? { text: step.text }
                : step.selector !== undefined
                  ? { selector: step.selector }
                  : { networkIdle: true }
            await session.waitForCondition(condition, signal)
          }
          snapshot = await session.snapshot({ interactiveOnly: false })
          outcomes.push({ index, step: describeStep(step), ok: true })
          break
        }
      }
      options.onSnapshot?.(await current())
    } catch (error) {
      // A target lookup already names the step; a browser failure is reported
      // with the index so the two read the same way to the model.
      const stepIndex = failedStepOf(error) ?? index
      if (error instanceof BrowserError) return fail(stepIndex, step, error, error.code)
      return fail(stepIndex, step, error, 'SCRIPT_STEP_FAILED')
    }
  }

  return snapshot === undefined
    ? { ran: outcomes.length, total: steps.length, outcomes }
    : { ran: outcomes.length, total: steps.length, snapshot, outcomes }
}
