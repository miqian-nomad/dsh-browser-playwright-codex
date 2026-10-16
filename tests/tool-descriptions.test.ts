import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import BrowserRuntime from '../src/service.ts'
import { PlaywrightProvider } from '../src/provider.ts'
import type { PlaywrightConfig } from '../src/config.ts'
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
/**
 * 2026-10-16：click / hover / click_at 合并成一个 browser_click，所以这张表从三个键并成一个键。
 * 下面每条都对应一次真实踩坑，合并时逐条确认过"这句话还在描述里"；被删掉的是枚举性文字和
 * 低风险风格建议（例如"别悬停你本来就要点的链接"），不是失败教训。
 */
const RULES: Record<string, { id: string; pattern: RegExp }[]> = {
  browser_click: [
    {
      id: 'what it does (click, or reveal with mode hover)',
      pattern: /Click the target from the latest snapshot[\s\S]*mode:"hover"[\s\S]*new snapshot/i,
    },
    {
      id: 'ref preferred, text for no-ref targets, copied exactly',
      pattern: /Best target first[\s\S]*shown WITHOUT a ref/i,
    },
    { id: 'label copied exactly as rendered', pattern: /copied exactly as rendered/i },
    { id: 'raw x/y is a last resort (canvas hit areas)', pattern: /last resort[\s\S]*canvas-drawn hit areas/i },
    { id: 'stale refs → fresh snapshot', pattern: /Refs go stale[\s\S]*if a ref fails/i },
    { id: 'hover only reveals, never activates', pattern: /only REVEALS content and never activates/i },
    {
      id: 'use it when content hides until the pointer rests',
      pattern: /hides content until the pointer rests on it/i,
    },
    {
      id: 'especially when the snapshot lacks an expected element',
      pattern: /lacks an element the page obviously should have/i,
    },
    { id: 'a hover returning is not proof', pattern: /only means the pointer moved/i },
    { id: 'read the ref-count comparison note', pattern: /comparing the actionable ref count before and after/i },
    {
      id: 'new refs: pre-hover refs are stale, act before the menu closes',
      pattern: /pre-hover refs are stale[\s\S]*closes the menu/i,
    },
    { id: 'no new refs: do not repeat the hover', pattern: /do NOT repeat the hover/i },
    { id: 'no fallback to raw coordinates', pattern: /do NOT fall back to[\s\S]*raw coordinates/i },
    { id: 'try the parent/container or owning sibling', pattern: /parent\/container or the sibling/i },
    { id: 'otherwise: visible alternative or tell the user', pattern: /visible alternative or tell the user/i },
    {
      id: 'precise: geometric centre through native input',
      pattern: /scrolled into view[\s\S]*exact centre through native input/i,
    },
    {
      id: 'precise needs no measuring or dpr guesswork',
      pattern: /no screenshot measuring, no devicePixelRatio guesswork/i,
    },
    {
      id: 'precise is the fallback, only after a failed ref click',
      pattern: /FALLBACK, not a routine alternative[\s\S]*not actionable/i,
    },
    { id: 'verify the effect after clicking', pattern: /IRON RULE: verify the effect in the returned snapshot/i },
    { id: 'the effect may be a dialog or new content', pattern: /URL, selection, toast, dialog, new content/i },
    { id: 'no change may still be success: check tabs', pattern: /tabs[\s\S]*new tab[\s\S]*before concluding/i },
    { id: 'a new tab comes from a target="_blank" link', pattern: /a target="_blank" link/i },
    { id: 'same-page overlay counts as success', pattern: /same-page overlay as success/i },
    {
      id: 'landing note → treat as failed and retarget',
      pattern: /landing note[\s\S]*treat it as failed and retarget/i,
    },
    { id: 'no blind repeat', pattern: /do NOT blindly repeat/i },
    { id: 'find the blocker or interception first', pattern: /blocker or interception first/i },
    { id: 'retry the most direct semantic action', pattern: /most direct semantic action/i },
    { id: 'a dialog stays PENDING', pattern: /stays PENDING[\s\S]*dialog text/i },
    { id: 'answer the dialog with the dialog tool', pattern: /cannot accept it[\s\S]*separate, deliberate call/i },
  ],
}

const pwConfig: PlaywrightConfig = {
  launch: {
    channel: 'chrome',
    headless: true,
    persistent: false,
    profileDir: 'unused-desc-profile',
    viewport: { width: 1280, height: 800 },
    navigationTimeoutMs: 5000,
    ignoreHTTPSErrors: false,
  },
  idleTimeoutMs: 0,
  maxSessions: 2,
  snapshot: { engine: 'legacy', diff: false, maxNodes: 200, maxNameLength: 120, maxTextLength: 300 },
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
  // 默认每条 ≤1650。承接过多个同类工具的合并工具额度更高：browser_click 吸收了 click_at 与 hover，
  // 去重后仍要 ~2165 字符才能把原来 46 条规则里的核心（含"精确点击兜底""悬停揭示失败怎么办"这两段
  // 失败路径，规范里的五要素之一）一条不丢地说完。整个描述面的总量上限另有断言，这里只是单品额度。
  const CONSOLIDATED: Record<string, number> = { browser_click: 2400 }
  for (const [name, description] of descriptions) {
    const cap = CONSOLIDATED[name] ?? 1650
    assert.ok(
      description.length <= cap,
      `${name} description is ${description.length} characters; SNAPSHOT-RULES §5 caps it at ${cap}`,
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
