/**
 * One saved browser script: a short, deterministic list of steps that a first
 * successful run left behind, so a repeat run costs one tool call instead of a
 * snapshot round-trip per action.
 *
 * Why a step list and not generated code: every mature runner in this space
 * separates "explore once" from "replay deterministically" — Stagehand caches
 * the resolved action and replays it with self-healing off, browser-use's
 * workflow-use records a workflow with variables, and Playwright MCP ships its
 * only batch entry point as `browser_run_code_unsafe`, behind an explicit
 * "unsafe" name. A step list keeps the validation the individual tools already
 * have (URL policy, ref freshness, credential refusal) that generated code
 * would walk around.
 *
 * Pure: no I/O, no browser, no clock. The runner and the store stay separate so
 * this module can be tested on its own.
 * @module dsh-browser-playwright-codex/script-steps
 */
import type { LoadState } from './types.ts'

/** How a step names the element it acts on. */
export interface ScriptTarget {
  /** Ref from the snapshot the previous step returned. Stale after a navigation. */
  ref?: string
  /** Visible label, matched against the current snapshot's accessible names. */
  text?: string
}

/** One deterministic step. */
export type ScriptStep =
  | { action: 'navigate'; url: string; waitFor?: LoadState }
  | { action: 'snapshot' }
  | { action: 'click'; target: ScriptTarget }
  | { action: 'fill'; target: ScriptTarget; value: string }
  | { action: 'press'; target: ScriptTarget; key: string }
  | { action: 'hover'; target: ScriptTarget }
  | { action: 'scroll'; direction: 'up' | 'down'; amount: number; target?: ScriptTarget }
  | { action: 'back' }
  | { action: 'forward' }
  | {
      action: 'wait'
      ms?: number
      text?: string
      selector?: string
      networkIdle?: boolean
      /** Wait until the page URL contains this substring — the only condition a “did the click navigate” check can trust. */
      urlContains?: string
    }

/** Upper bound on the steps one script may carry. A longer list is a loop, not a script. */
export const MAX_SCRIPT_STEPS = 40

/** Step actions this version understands. */
export const SCRIPT_ACTIONS = [
  'navigate',
  'snapshot',
  'click',
  'fill',
  'press',
  'hover',
  'scroll',
  'back',
  'forward',
  'wait',
] as const

/** Default scroll distance when a scroll step omits `amount`. */
export const DEFAULT_SCROLL_AMOUNT = 600

/** Upper bound on one scroll step's distance, so a typo cannot jump to the page end. */
export const MAX_SCROLL_AMOUNT = 20000

/** One step action name. */
export type ScriptAction = (typeof SCRIPT_ACTIONS)[number]

/** Raised for a malformed script; the message names the offending step. */
export class ScriptStepError extends Error {
  /** Index of the offending step, 1-based as the model sees them. */
  readonly step: number
  constructor(step: number, message: string) {
    super('step ' + String(step) + ': ' + message)
    this.name = 'ScriptStepError'
    this.step = step
  }
}

/** Normalise a target given as a plain string or an object. */
function parseTarget(raw: unknown, step: number): ScriptTarget {
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') throw new ScriptStepError(step, 'target is an empty label')
    return { text }
  }
  if (raw === null || typeof raw !== 'object') {
    throw new ScriptStepError(step, 'target must be a ref, a label, or { ref } / { text }')
  }
  const record = raw as Record<string, unknown>
  const ref = typeof record.ref === 'string' ? record.ref.trim() : ''
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  if (ref === '' && text === '') throw new ScriptStepError(step, 'target needs a ref or a text label')
  if (ref !== '' && text !== '') throw new ScriptStepError(step, 'target takes a ref OR a text label, not both')
  return ref !== '' ? { ref } : { text }
}

/** Resolve a step's target from either `target` or the `ref` / `text` shorthand. */
function targetOf(record: Record<string, unknown>, step: number): ScriptTarget {
  if (record.target !== undefined) return parseTarget(record.target, step)
  if (typeof record.ref === 'string') return parseTarget({ ref: record.ref }, step)
  if (typeof record.text === 'string') return parseTarget({ text: record.text }, step)
  return parseTarget(undefined, step)
}

/** How many conditions a wait step may carry: exactly one, like browser_wait. */
function countWaitConditions(step: Record<string, unknown>): number {
  let n = 0
  if (step.ms !== undefined) n += 1
  if (step.text !== undefined) n += 1
  if (step.selector !== undefined) n += 1
  if (step.networkIdle === true) n += 1
  if (step.urlContains !== undefined) n += 1
  return n
}

/**
 * Validate and normalise a script's steps.
 *
 * Throws {@link ScriptStepError} on the first bad step rather than collecting
 * everything: a script runs as a unit, so the first error is the one that
 * matters, and a partial list would read as if the rest were fine.
 *
 * @param raw - Steps exactly as the model sent them.
 * @param maxSteps - Upper bound; a long list is a sign the model meant a loop.
 * @returns The normalised steps.
 */
export function parseScriptSteps(raw: unknown, maxSteps: number): ScriptStep[] {
  if (!Array.isArray(raw)) throw new ScriptStepError(1, 'steps must be an array')
  if (raw.length === 0) throw new ScriptStepError(1, 'steps is empty')
  if (raw.length > maxSteps) {
    throw new ScriptStepError(1, 'steps has ' + String(raw.length) + ' entries; the cap is ' + String(maxSteps))
  }
  const out: ScriptStep[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const step = 1 + i
    const item = raw[i]
    if (item === null || typeof item !== 'object') throw new ScriptStepError(step, 'each step must be an object')
    const record = item as Record<string, unknown>
    const action = typeof record.action === 'string' ? record.action.trim() : ''
    switch (action) {
      case 'navigate': {
        const url = typeof record.url === 'string' ? record.url.trim() : ''
        if (url === '') throw new ScriptStepError(step, 'navigate needs a url')
        const waitFor = record.waitFor
        if (
          waitFor !== undefined &&
          waitFor !== 'load' &&
          waitFor !== 'domcontentloaded' &&
          waitFor !== 'networkidle'
        ) {
          throw new ScriptStepError(step, 'waitFor must be load, domcontentloaded or networkidle')
        }
        out.push(waitFor === undefined ? { action, url } : { action, url, waitFor: waitFor as LoadState })
        break
      }
      case 'snapshot':
        out.push({ action })
        break
      case 'click':
        out.push({ action, target: targetOf(record, step) })
        break
      case 'fill': {
        const value = typeof record.value === 'string' ? record.value : undefined
        if (value === undefined) throw new ScriptStepError(step, 'fill needs a value')
        out.push({ action, target: targetOf(record, step), value })
        break
      }
      case 'press': {
        const key = typeof record.key === 'string' ? record.key.trim() : ''
        if (key === '') throw new ScriptStepError(step, 'press needs a key (e.g. Enter, Escape, Tab)')
        out.push({ action, target: targetOf(record, step), key })
        break
      }
      case 'hover':
        out.push({ action, target: targetOf(record, step) })
        break
      case 'scroll': {
        const direction = record.direction
        if (direction !== 'up' && direction !== 'down') {
          throw new ScriptStepError(step, 'scroll needs direction "up" or "down"')
        }
        const rawAmount = record.amount === undefined ? DEFAULT_SCROLL_AMOUNT : record.amount
        if (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount) || rawAmount <= 0) {
          throw new ScriptStepError(step, 'scroll amount must be a positive number of pixels')
        }
        if (rawAmount > MAX_SCROLL_AMOUNT) {
          throw new ScriptStepError(step, 'scroll amount is capped at ' + String(MAX_SCROLL_AMOUNT) + 'px')
        }
        const amount = Math.round(rawAmount)
        // `target` is optional here: without it the whole page scrolls. Parse it
        // only when the step actually carries one, so a plain page scroll does
        // not require a ref the page may not have.
        const hasTarget = record.target !== undefined || record.ref !== undefined || record.text !== undefined
        const parsed: ScriptStep = { action, direction, amount }
        out.push(hasTarget ? { ...parsed, target: targetOf(record, step) } : parsed)
        break
      }
      case 'back':
      case 'forward':
        out.push({ action })
        break
      case 'wait': {
        const conditions = countWaitConditions(record)
        if (conditions === 0) {
          throw new ScriptStepError(step, 'wait needs exactly one of ms, text, selector, networkIdle, urlContains')
        }
        if (conditions > 1)
          throw new ScriptStepError(step, 'wait takes exactly one condition, got ' + String(conditions))
        const stepOut: ScriptStep = { action }
        if (typeof record.ms === 'number') stepOut.ms = record.ms
        if (typeof record.text === 'string') stepOut.text = record.text
        if (typeof record.selector === 'string') stepOut.selector = record.selector
        if (record.networkIdle === true) stepOut.networkIdle = true
        if (typeof record.urlContains === 'string' && record.urlContains.trim() !== '') {
          stepOut.urlContains = record.urlContains.trim()
        }
        out.push(stepOut)
        break
      }
      default:
        throw new ScriptStepError(
          step,
          'unknown action ' +
            (action === '' ? '(missing)' : '"' + action + '"') +
            '; supported: ' +
            SCRIPT_ACTIONS.join(', '),
        )
    }
  }
  return out
}

/** One line per step, for logs and for the model's summary. */
export function describeStep(step: ScriptStep): string {
  const targetLabel = (target: ScriptTarget): string =>
    target.ref === undefined ? '"' + String(target.text) + '"' : target.ref
  switch (step.action) {
    case 'navigate':
      return 'navigate ' + step.url
    case 'snapshot':
      return 'snapshot'
    case 'click':
      return 'click ' + targetLabel(step.target)
    case 'fill':
      return 'fill ' + targetLabel(step.target)
    case 'press':
      return 'press ' + step.key + ' on ' + targetLabel(step.target)
    case 'hover':
      return 'hover ' + targetLabel(step.target)
    case 'scroll':
      return (
        'scroll ' +
        step.direction +
        ' ' +
        String(step.amount) +
        'px' +
        (step.target === undefined ? '' : ' in ' + targetLabel(step.target))
      )
    case 'back':
      return 'back'
    case 'forward':
      return 'forward'
    case 'wait':
      if (step.ms !== undefined) return 'wait ' + String(step.ms) + 'ms'
      if (step.text !== undefined) return 'wait for text "' + step.text + '"'
      if (step.selector !== undefined) return 'wait for ' + step.selector
      if (step.urlContains !== undefined) return 'wait for url containing ' + step.urlContains
      return 'wait for network idle'
  }
}
