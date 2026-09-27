import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import BrowserRuntime from '../src/service.ts'
import { PlaywrightProvider } from '../src/playwright.ts'
import type { PlaywrightConfig } from '../src/playwright.ts'
import * as browserTool from '../src/tool.ts'
import type { ToolConfig } from '../src/tool.ts'

/**
 * Description coverage: every rule a tool description used to carry must still
 * be readable in it. Descriptions are the only thing that makes the model use a
 * tool correctly (SNAPSHOT-RULES §5), so trimming prose is allowed — silently
 * dropping a rule, a concrete example, or the reason a rule exists is not. Each
 * entry is one rule, expressed as a pattern the description must still match.
 * This table is the real budget: the character cap below only catches prose that
 * grows back, while every entry here is a fact a previous trim could have eaten.
 */
const RULES: Record<string, { id: string; pattern: RegExp }[]> = {
  browser_click: [
    { id: 'what it does', pattern: /Click the element with the given ref[\s\S]*return the new snapshot/i },
    { id: 'stale refs → fresh snapshot', pattern: /Refs go stale[\s\S]*snapshot[\s\S]*if a ref fails/i },
    { id: 'ref preferred; text for no-ref targets', pattern: /Prefer ref[\s\S]*WITHOUT a ref[\s\S]*pass text/i },
    { id: 'label copied exactly as rendered', pattern: /copied exactly as rendered/i },
    { id: 'a revealed item may need hover first', pattern: /revealed[\s\S]*hover[\s\S]*first/i },
    { id: 'verify the effect after clicking', pattern: /IRON RULE: after the click, verify[\s\S]*actually happened/i },
    { id: 'no blind repeat', pattern: /do NOT blindly repeat/i },
    { id: 'no raw-coordinate fallback', pattern: /do NOT fall back to[\s\S]*raw coordinates/i },
    { id: 'find the blocker or interception first', pattern: /blocker or interception/i },
    { id: 'retry the most direct semantic action', pattern: /most direct semantic action/i },
    { id: 'landing note → treat as failed and retarget', pattern: /landing note[\s\S]*retarget/i },
    { id: 'no change may still be success: check tabs', pattern: /tabs[\s\S]*new tab[\s\S]*before concluding/i },
    { id: 'same-page overlay counts as success', pattern: /overlay[\s\S]*success/i },
    { id: 'a dialog stays PENDING', pattern: /PENDING[\s\S]*dialog text/i },
    { id: 'answer the dialog with the dialog tool', pattern: /answer it with[\s\S]*dialog/i },
    {
      id: 'no way to accept a dialog from this tool',
      pattern: /no way to accept a dialog[\s\S]*separate, deliberate call/i,
    },
    { id: 'the effect may be a dialog', pattern: /selection, toast, dialog, new content/i },
    { id: 'a new tab comes from a target="_blank" link', pattern: /a target="_blank" link/i },
    {
      id: 'compare refs and content with the pre-click snapshot',
      pattern: /compare its refs and content with the pre-click snapshot/i,
    },
    {
      id: 'inspect the visible state for the blocker',
      pattern: /inspect the visible state for the blocker or interception/i,
    },
  ],
  browser_click_at: [
    { id: 'two modes', pattern: /two modes/i },
    { id: 'ref mode clicks the geometric centre', pattern: /geometric centre/i },
    { id: 'raw mode is viewport CSS pixels', pattern: /x\/y viewport CSS pixels/i },
    { id: 'it is the fallback, not routine', pattern: /FALLBACK, not a routine alternative/i },
    { id: 'try click (incl. text mode) first', pattern: /click[\s\S]*including its text mode[\s\S]*first/i },
    { id: 'ref mode only after click reports a failure', pattern: /not actionable|could not be delivered/i },
    { id: 'raw x/y is a last resort (canvas hit areas)', pattern: /last resort[\s\S]*canvas/i },
    {
      id: 'a raw click still reports what it hit',
      pattern: /raw clicks still return a landing note/i,
    },
    { id: 'verify the effect', pattern: /verify the effect in the returned snapshot/i },
    { id: 'no blind repeat, no more raw coordinates', pattern: /do NOT repeat blindly[\s\S]*raw coordinates/i },
    { id: 'find the blocker or interception first', pattern: /blocker or interception/i },
    {
      id: 'CAUTION note when ref mode fell back to coordinates',
      pattern: /fall back to a bare click[\s\S]*CAUTION note/i,
    },
    { id: 'intercepted → failed and retarget', pattern: /treat it as failed and retarget/i },
    { id: 'ref mode scrolls the element into view', pattern: /the element is scrolled into view/i },
    {
      id: 'ref mode needs no measuring or dpr guesswork',
      pattern: /no screenshot measuring, no devicePixelRatio guesswork/i,
    },
  ],
  browser_hover: [
    {
      id: 'what it does (ref or visible text)',
      pattern: /Hover the element with the given ref[\s\S]*label equals text/i,
    },
    { id: 'hover only reveals, never activates', pattern: /only REVEALS content and never activates/i },
    {
      id: 'use it when content hides until the pointer rests',
      pattern: /hides content until the pointer rests on it/i,
    },
    {
      id: 'especially when the snapshot lacks an expected element',
      pattern: /lacks an element the page obviously should have/i,
    },
    {
      id: 'text mode only for a no-ref label, exactly as rendered',
      pattern: /text only for a label shown WITHOUT a ref[\s\S]*copied exactly as rendered/i,
    },
    {
      id: 'do not hover links/buttons you mean to activate',
      pattern: /Do not hover plain links\/buttons you mean to activate/i,
    },
    { id: 'never hover "just in case"', pattern: /never hover "just in case"/i },
    { id: 'a hover returning is not proof', pattern: /only means the pointer moved/i },
    { id: 'read the ref-count comparison note', pattern: /comparing the actionable ref count before and after/i },
    {
      id: 'new refs: pre-hover refs are stale, act before the menu closes',
      pattern: /pre-hover refs are stale[\s\S]*closes the menu/i,
    },
    { id: 'IRON RULE when no new refs appear', pattern: /IRON RULE: if the note reports no new refs/i },
    { id: 'do not repeat the hover', pattern: /do NOT repeat the hover/i },
    { id: 'no fallback to raw coordinates', pattern: /do NOT fall back to[\s\S]*raw coordinates/i },
    { id: 'try the parent/container or owning sibling', pattern: /parent\/container or the sibling/i },
    { id: 'otherwise: visible alternative or tell the user', pattern: /visible alternative or tell the user/i },
    {
      id: 'hover-only controls, named',
      pattern: /account menus, tooltips, previews, chart values, player controls/i,
    },
  ],
}

const pwConfig: PlaywrightConfig = {
  launch: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
    navigationTimeoutMs: 5000,
    ignoreHTTPSErrors: false,
  },
  idleTimeoutMs: 0,
  maxSessions: 2,
  snapshot: { maxNodes: 200, maxNameLength: 120, maxTextLength: 300 },
}

const toolConfig: ToolConfig = {
  toolPrefix: 'browser_',
  allowEvaluate: true,
  allowCdp: true,
  registerDisabledTools: false,
  maxWaitMs: 60000,
  interactiveOnlyDefault: false,
}

let descriptions: Map<string, string>

test('assemble the full tool surface once', async () => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(BrowserRuntime)
  root.browser.registerProvider(new PlaywrightProvider(pwConfig))
  browserTool.apply(root, toolConfig)
  descriptions = new Map(root.tools.schemas().map((schema) => [schema.name, schema.description]))
  assert.ok(descriptions.size >= 20)
})

test('every description stays within the SNAPSHOT-RULES budget', async () => {
  for (const [name, description] of descriptions) {
    assert.ok(
      description.length <= 1650,
      `${name} description is ${description.length} characters; SNAPSHOT-RULES §5 caps it at 1650`,
    )
  }
})

test('the click family still states every rule it used to carry', async () => {
  for (const [name, rules] of Object.entries(RULES)) {
    const description = descriptions.get(name)
    assert.ok(description !== undefined, `${name} is not registered`)
    for (const rule of rules) {
      assert.match(description, rule.pattern, `${name} lost the rule "${rule.id}"`)
    }
  }
})

test('the whole description surface stays inside its total budget', async () => {
  let total = 0
  for (const description of descriptions.values()) total += description.length
  assert.ok(
    total <= 11500,
    'the tool descriptions total ' + String(total) + ' characters; the surface budget is 11,500',
  )
})
