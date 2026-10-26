/**
 * Model-facing browser tool family: navigate, snapshot with refs, click,
 * hover, fill, press, scroll, history, tabs, screenshot, extract, evaluate,
 * close.
 * Every tool acquires the calling session's browser through ctx.browser, so
 * the browser persists across calls. Persistent mode shares one profile-backed
 * window across sessions (personal-browser style). Outputs follow the
 * canonical-value + pure-render contract.
 * @module dsh-browser-playwright-codex/tool
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolDefinition, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: makes the ctx.browser declaration merge visible to this module.
import type {} from './service.ts'
import type { BrowserSession, DiagnosticsValue } from './types.ts'
import { BrowserError, cdpDisabled, evaluateDisabled } from './errors.ts'
import { registeredSuffixes, type ToolSuffix, type ToolSurfaceConfig } from './contract.ts'
import { getEnabled, publishGates, publishLoginSites } from './runtime-state.ts'
import { summarizeLoginSites } from './login-sites.ts'
import { isCdpMethodAllowed, cdpDenialMessage } from './cdp-policy.ts'
import type { AttachmentServiceLike, JsonValue, LlmServiceLike, OptionalServices } from './tool-types.ts'
import { SCREENSHOT_SCHEMA, SNAPSHOT_SCHEMA, TABS_SCHEMA } from './tool-schemas.ts'
import { parseJsonText, extractionPrompt } from './extract.ts'
import { detectChallenge } from './challenge.ts'
import {
  renderDiagnostics,
  renderScreenshotValue,
  renderSnapshotValue,
  renderTabsValue,
  snapshotValue,
} from './tool-render.ts'
export { detectChallenge }
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-tool'
/** The browser runtime and tool registry this plugin consumes. */
export const inject = ['browser', 'tools']
/** Configuration for the browser tool family. */
export interface ToolConfig {
  /** Tool name prefix; final names are <prefix>navigate and so on. */
  toolPrefix: string
  /** Allow browser_evaluate (arbitrary page JavaScript). Defaults to false. */
  allowEvaluate: boolean
  /** Allow raw CDP inspection commands. Defaults to false. */
  allowCdp: boolean
  /**
   * Register the gated tools (evaluate, cdp, extract) even when their
   * capability is off, so the model can discover them and read the error that
   * names the switch. Defaults to false: a disabled tool can only error, and
   * its schema would sit in the system prompt on every turn for nothing.
   */
  registerDisabledTools: boolean
  /**
   * Register the two diagnostics tools (console messages, network requests).
   * Defaults to false: they exist to debug a failed run, and their schemas
   * would otherwise sit in the system prompt on every turn.
   */
  diagnostics: boolean
  /** Upper bound for browser_wait in milliseconds. */
  maxWaitMs: number
  /** Default value of the snapshot tool's interactiveOnly flag. */
  interactiveOnlyDefault: boolean
  /** Auxiliary extraction configuration; omitted means browser_extract is unconfigured. */
  extract?: {
    provider?: string
    model?: string
    maxInputChars: number
    maxOutputTokens: number
  }
}

/** Schemastery validation for {@link ToolConfig}. */
export const Config: z<ToolConfig> = z.object({
  toolPrefix: z.string().default('browser_'),
  allowEvaluate: z.boolean().default(false),
  allowCdp: z.boolean().default(false),
  registerDisabledTools: z.boolean().default(false),
  diagnostics: z.boolean().default(false),
  maxWaitMs: z.number().default(60000),
  interactiveOnlyDefault: z.boolean().default(false),
  extract: z.object({
    provider: z.string(),
    model: z.string(),
    maxInputChars: z.number().default(20000),
    maxOutputTokens: z.number().default(2000),
  }),
})
/**
 * Register the browser tool family on ctx.tools.
 * @param ctx - plugin context carrying browser, tools, and the optional services.
 * @param config - tool naming and safety configuration.
 */
export function apply(ctx: Context, config: ToolConfig): void {
  if (!/^[a-z][a-z0-9_]*$/.test(config.toolPrefix)) {
    throw new Error('browser-tool: toolPrefix must match [a-z][a-z0-9_]*')
  }
  const p = (base: string): string => config.toolPrefix + base
  /**
   * The live tool surface for this configuration. Gated tools (evaluate, cdp,
   * extract) register only when their capability is enabled: their schemas sit
   * in the system prompt on every turn, and a disabled capability can only
   * return an error, so shipping it would be pure prompt cost.
   */
  const surface: ToolSurfaceConfig = {
    allowEvaluate: config.allowEvaluate,
    allowCdp: config.allowCdp,
    extractConfigured: config.extract?.provider !== undefined && config.extract?.model !== undefined,
    diagnostics: config.diagnostics,
    registerDisabledTools: config.registerDisabledTools,
  }
  const registered = new Set<ToolSuffix>(registeredSuffixes(surface))
  // Tell the Settings page what is actually in effect. It cannot read this
  // config itself (the value may come from a bundle patch, a profile patch or a
  // home-level patch), so the tool family publishes it at registration and the
  // switch shows the truth instead of a guess.
  //
  // These are the CAPABILITY values, not `registered.has(...)`: the session
  // layer enforces the switch too, and `registerDisabledTools` deliberately
  // registers a switched-off tool so the model can discover it. Reading
  // registration as permission published "on" for a gate that was off — the
  // settings card showed a switch that was not there.
  publishGates({
    allowEvaluate: config.allowEvaluate,
    allowCdp: config.allowCdp,
    diagnostics: config.diagnostics,
  })
  /** Register one gated tool only when this configuration keeps it live. */
  const registerMaybe = (suffix: ToolSuffix, definition: ToolDefinition): void => {
    if (registered.has(suffix)) ctx.tools.register(definition)
  } /** Resolve the calling session's browser owner key. */
  const ownerFor = (exec: ToolExecution): string => {
    const id = exec.agent?.session.id
    return id === undefined ? 'anonymous' : String(id)
  }
  /** Acquire the calling session's live browser session. */
  /**
   * Publish the "which sites look logged in" summary for the settings card. Throttled, and
   * every failure is swallowed: this is a display nicety and must never slow down or break an
   * action. Nothing here is model-visible — it travels only to the settings route.
   */
  let lastLoginPublish = 0
  const publishLogins = (session: BrowserSession): void => {
    const now = Date.now()
    if (now - lastLoginPublish < 5000) return
    lastLoginPublish = now
    void session
      .cookieJar()
      .then(async (rows) => {
        publishLoginSites(
          summarizeLoginSites(rows, 'live', now, {
            visited: session.visitedHosts(),
            titles: await session.siteTitles(),
          }),
        )
      })
      .catch(() => {
        /* display-only: a failed cookie read must not surface as a tool failure */
      })
  }
  const acquire = (exec: ToolExecution): Promise<BrowserSession> => {
    if (!getEnabled()) {
      throw new BrowserError(
        'DISABLED',
        'dsh-browser-playwright-codex is disabled; open Settings → Plugins → 浏览器 and turn it on to use the browser',
      )
    }
    return ctx.browser.acquire(ownerFor(exec), exec.signal).then((session) => {
      publishLogins(session)
      return session
    })
  }
  const services = (): OptionalServices => {
    const out: OptionalServices = {}
    const attachments = ctx.get('attachments') as AttachmentServiceLike | undefined
    const llm = ctx.get('llm') as LlmServiceLike | undefined
    if (attachments !== undefined) out.attachments = attachments
    if (llm !== undefined) out.llm = llm
    return out
  }
  ctx.tools.register(
    defineTool({
      name: p('navigate'),
      description:
        'Navigate the persistent browser to a URL and return the new page snapshot. ' +
        'The snapshot lists visible elements with stable ref= identifiers for later click/fill calls. ' +
        'IRON RULE: if the page is already on the target URL, do NOT navigate to it again — re-navigating the ' +
        'same URL reloads the page and can discard in-progress user input; only navigate when the URL must actually change.',
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute http(s) URL to open.' },
        waitFor: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
          description: 'Load condition to wait for. Defaults to load.',
        },
      },
      output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
      async execute(args, exec) {
        const session = await acquire(exec)
        const waitUntil = args.waitFor ?? 'load'
        return snapshotValue(await session.navigate(args.url, waitUntil, exec.signal))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('snapshot'),
      description:
        'Return the current page snapshot: URL, title, and visible elements with stable ref= identifiers. ' +
        'Use this after dynamic content changes to refresh refs before clicking. ' +
        'An element shown with a name but NO [ref=...] has no ref handle of its own — ' +
        p('click') +
        ' and ' +
        p('hover') +
        ' still reach it by passing its exact label as text, as long as the element is visible at that moment. ' +
        'An effect can be real even when the URL does not change and no tab opens (a same-page overlay or popup): compare refs and content between snapshots instead of trusting the URL. ' +
        'A native dialog (alert / confirm / prompt / beforeunload) is not part of the page: it is left PENDING and blocks the page, reported at the top of the result as [dialog] type "message"; answer it with ' +
        p('dialog') +
        '({ accept }) and accept only when the user authorized exactly that action. ' +
        'IRON RULE: a snapshot is the cheapest state check after any click/type/scroll — confirm the previous ' +
        'action actually took effect here (URL change, selection, toast, new content) before your next action. ' +
        'Pick ONE verification channel per step: prefer a snapshot for DOM/locator ground truth or a screenshot ' +
        'when visual confirmation matters, but avoid requesting both by default.',
      parameters: {
        interactiveOnly: {
          type: 'boolean',
          description: 'Return only actionable elements. Defaults to ' + String(config.interactiveOnlyDefault) + '.',
        },
      },
      output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
      async execute(args, exec) {
        const session = await acquire(exec)
        const interactiveOnly = args.interactiveOnly ?? config.interactiveOnlyDefault
        return snapshotValue(await session.snapshot({ interactiveOnly }))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('click'),
      description:
        'Click the target from the latest snapshot — or reveal it without clicking (mode:"hover") — and return the new snapshot. ' +
        'Best target first: `ref` when the snapshot has one; `text`, a visible label copied exactly as rendered, for a target shown WITHOUT a ref; `x`+`y` viewport CSS pixels only as a last resort (canvas-drawn hit areas). Refs go stale after navigation or DOM changes: take a fresh snapshot if a ref fails. ' +
        'mode:"hover" only REVEALS content and never activates: use it when a control hides content until the pointer rests on it, especially when the snapshot lacks an element the page obviously should have. A hover returning only means the pointer moved: read the note comparing the actionable ref count before and after; new refs mean pre-hover refs are stale, so act from the NEW refs before an unrelated click closes the menu. If that note reports no new refs, do NOT repeat the hover and do NOT fall back to raw coordinates — hover the parent/container or the sibling that owns the menu, otherwise use a visible alternative or tell the user. ' +
        'precise:true takes a ref click down the geometric path instead: the element is scrolled into view and clicked at its exact centre through native input, with no screenshot measuring, no devicePixelRatio guesswork. It is the FALLBACK, not a routine alternative — use it only after a ref click reports the element is not actionable, or that the click could not be delivered. ' +
        'IRON RULE: verify the effect in the returned snapshot (URL, selection, toast, dialog, new content). No change may still be success: check ' +
        p('tabs') +
        ' for a new tab (a target="_blank" link) before concluding, and treat a same-page overlay as success. ' +
        'The landing note names what received the click: if that is not your target the click was intercepted — treat it as failed and retarget; do NOT blindly repeat it and do NOT throw raw coordinates at it, but inspect the visible state for the blocker or interception first, resolve that, then retry the most direct semantic action. ' +
        'A native dialog stays PENDING and this returns immediately with the dialog text; this tool cannot accept it — ' +
        p('dialog') +
        ' is a separate, deliberate call.',
      parameters: {
        ref: {
          type: 'string',
          description: 'Element ref (e.g. e12) from the latest snapshot. Preferred whenever the snapshot has one.',
        },
        text: {
          type: 'string',
          description:
            'Visible label of a target shown WITHOUT a ref, copied exactly as the snapshot renders it; the first visible element whose own text matches is used and the note names it.',
        },
        x: {
          type: 'integer',
          description: 'Viewport x in CSS pixels, with y: a raw click, mode "click" only, last resort.',
        },
        y: {
          type: 'integer',
          description: 'Viewport y in CSS pixels, with x: a raw click, mode "click" only, last resort.',
        },
        mode: {
          type: 'string',
          enum: ['click', 'hover'],
          description: 'click (default) activates the target; hover only reveals it.',
        },
        precise: {
          type: 'boolean',
          description:
            'Ref clicks only: click the geometric centre through native input instead of the standard click.',
        },
      },
      output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
      async execute(args, exec) {
        const session = await acquire(exec)
        const mode = args.mode ?? 'click'
        if (mode !== 'click' && mode !== 'hover') {
          throw new BrowserError(
            'PARAM_MISSING',
            'browser_click takes mode "click" or "hover", got: ' + String(args.mode),
          )
        }
        const ref = args.ref !== undefined && args.ref !== '' ? args.ref : undefined
        const text = args.text !== undefined && args.text !== '' ? args.text : undefined
        const point = typeof args.x === 'number' && typeof args.y === 'number' ? { x: args.x, y: args.y } : undefined
        if (mode === 'hover') {
          if (ref !== undefined) return snapshotValue(await session.hover(ref, exec.signal))
          if (text !== undefined) return snapshotValue(await session.hoverText(text, exec.signal))
          throw new BrowserError(
            'PARAM_MISSING',
            'browser_click with mode "hover" needs a ref from the latest snapshot, or the visible text label of a trigger that has no ref',
          )
        }
        if (ref !== undefined) {
          return snapshotValue(
            args.precise === true ? await session.clickAtRef(ref, exec.signal) : await session.click(ref, exec.signal),
          )
        }
        if (text !== undefined) return snapshotValue(await session.clickText(text, exec.signal))
        if (point !== undefined) return snapshotValue(await session.clickAt(point.x, point.y, exec.signal))
        throw new BrowserError(
          'PARAM_MISSING',
          'browser_click needs a target: a ref from the latest snapshot, the visible text label of a target that has no ref, or both x and y viewport coordinates',
        )
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('dialog'),
      description:
        'Answer the native dialog currently blocking the page — alert, confirm, prompt or beforeunload — and return the fresh snapshot. ' +
        'A dialog is NEVER auto-answered: it stays PENDING until this call. The call that raised it and ' +
        p('snapshot') +
        ' report it as a note; every other tool refuses to act and fails with DIALOG_PENDING. ' +
        'accept: true confirms it (OK / leave page), false cancels it (Cancel / stay on page). Accept only when the user has explicitly authorized exactly this action (delete / pay / submit / overwrite); never confirm on your own initiative, and state in your reply which dialog you answered and how. ' +
        'A prompt takes its value through promptText. Without a pending dialog this errors with NO_DIALOG — there is no way to accept a dialog the page never raised.',
      parameters: {
        accept: {
          type: 'boolean',
          required: true,
          description: 'true = confirm (OK / leave page), false = cancel (Cancel / stay on page).',
        },
        promptText: {
          type: 'string',
          description: 'Value a prompt() dialog should receive. Ignored for other dialog types.',
        },
      },
      output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
      async execute(args, exec) {
        const session = await acquire(exec)
        if (typeof args.accept !== 'boolean') {
          throw new BrowserError('PARAM_MISSING', 'browser_dialog needs accept: true (confirm) or false (cancel)')
        }
        return snapshotValue(await session.resolveDialog(args.accept, args.promptText, exec.signal))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('fill'),
      description:
        'Replace the value of the input or select referenced by the latest snapshot. ' +
        '`value` is accepted as an alias of `text`. ' +
        'For <select> elements the text selects the matching option label. ' +
        'Credential fields (password, one-time code, card number) are refused with CREDENTIAL_FIELD: ' +
        'a human types secrets in the visible window, so ask them and re-snapshot instead. ' +
        'IRON RULE: after filling, verify in the returned snapshot that the field actually holds the value. ' +
        'Frameworks can silently reject or transform input (controlled components, contenteditable editors, ' +
        'input-mask/currency fields). If the value is wrong or missing, do NOT blindly re-fill or append — ' +
        'inspect the field DOM first — ' +
        p('evaluate') +
        ' reading value/outerHTML, or ' +
        p('cdp') +
        ' Input.insertText for contenteditable (both are gated — when one is missing from your tool list, ' +
        'say so) — understand why it was ignored, then act.',
      parameters: {
        ref: { type: 'string', required: true, description: 'Input or select ref (e.g. e7) from the latest snapshot.' },
        text: {
          type: 'string',
          description:
            'Exact value to fill, or option label for selects. (In browser_click, `text` is a label to click instead.)',
        },
        value: { type: 'string', description: 'Alias of `text`; if both are given, `text` wins.' },
      },
      output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
      async execute(args, exec) {
        // `text` deliberately is NOT `required: true` here, even though in practice you must give it
        // (or `value`). The parameter DSL is a flat property map whose only requiredness is
        // per-property, so it cannot express "exactly one of text/value" — the `oneOf` the compiled
        // JSON Schema supports is value-level, not object-level. The requirement is therefore
        // enforced below, before a session is acquired (a malformed call must not launch a browser),
        // and the message names both spellings. 2026-10-16: a reviewing model passed `value` first
        // and only got `invalid arguments: missing required property "text"` — no way forward.
        const value = args.text ?? args.value
        if (value === undefined) {
          throw new BrowserError(
            'PARAM_MISSING',
            'browser_fill needs the value to type: pass `text` (alias `value`). The `text` here is the value you type — for a visible label to click, use browser_click instead.',
          )
        }
        const session = await acquire(exec)
        return snapshotValue(await session.fill(args.ref, value, exec.signal))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('press'),
      description:
        'Press a keyboard key (e.g. Enter, Tab, ArrowDown, Escape) on the referenced element. ' +
        'IRON RULE: after pressing, verify in the returned snapshot that the key actually did what you expected ' +
        '(e.g. Enter submitted the form, Escape closed the dialog) before moving on — do not assume it worked.',
      parameters: {
        ref: { type: 'string', required: true, description: 'Element ref from the latest snapshot.' },
        key: { type: 'string', required: true, description: 'Key name to press, e.g. Enter, Escape, ArrowDown.' },
      },
      output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
      async execute(args, exec) {
        const session = await acquire(exec)
        return snapshotValue(await session.press(args.ref, args.key, exec.signal))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('scroll'),
      description: 'Scroll the page (or bring the referenced element into view) and return the new snapshot.',
      parameters: {
        direction: { type: 'string', enum: ['up', 'down'], required: true, description: 'Scroll direction.' },
        amount: { type: 'integer', description: 'Scroll distance in pixels. Defaults to 600.' },
        ref: { type: 'string', description: 'Optional element ref to scroll into view first.' },
      },
      output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
      async execute(args, exec) {
        const session = await acquire(exec)
        const amount = args.amount ?? 600
        return snapshotValue(await session.scroll(args.direction, amount, args.ref, exec.signal))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('back'),
      description: 'Navigate history back and return the new snapshot.',
      parameters: {},
      output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
      async execute(_args, exec) {
        const session = await acquire(exec)
        return snapshotValue(await session.back(exec.signal))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('forward'),
      description: 'Navigate history forward and return the new snapshot.',
      parameters: {},
      output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
      async execute(_args, exec) {
        const session = await acquire(exec)
        return snapshotValue(await session.forward(exec.signal))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('wait'),
      description: 'Wait a fixed duration for slow pages or lazy content to settle.',
      parameters: {
        ms: {
          type: 'integer',
          required: true,
          description: 'Milliseconds to wait, up to ' + String(config.maxWaitMs) + '.',
        },
      },
      output: { schema: { type: 'null' }, render: (_args, _value) => [{ type: 'text', text: 'Waited.' }] },
      async execute(args, exec) {
        if (!Number.isSafeInteger(args.ms) || args.ms <= 0 || args.ms > config.maxWaitMs) {
          throw new Error('browser_wait: ms must be a positive integer no larger than ' + String(config.maxWaitMs))
        }
        const session = await acquire(exec)
        await session.wait(args.ms, exec.signal)
        return null
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('tabs'),
      description:
        'List the open tabs of this session with their indexes, URLs, and titles. The tab marked [active] is the page every other browser tool acts on.',
      parameters: {},
      output: { schema: TABS_SCHEMA, render: renderTabsValue },
      async execute(_args, exec) {
        const session = await acquire(exec)
        const tabs = await session.tabs()
        return { tabs: tabs.map((tab) => ({ index: tab.index, url: tab.url, title: tab.title, active: tab.active })) }
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('switch_tab'),
      description: 'Activate the tab at the given index and return its snapshot.',
      parameters: {
        index: { type: 'integer', required: true, description: 'Tab index from ' + p('tabs') + '.' },
      },
      output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
      async execute(args, exec) {
        const session = await acquire(exec)
        return snapshotValue(await session.switchTab(args.index, exec.signal))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('open_tab'),
      description:
        'Open a new tab at the given URL and return its snapshot. The new tab becomes [active], so later calls act on it.',
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute http(s) URL to open in the new tab.' },
        waitFor: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
          description: 'Load condition to wait for. Defaults to load.',
        },
      },
      output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
      async execute(args, exec) {
        const session = await acquire(exec)
        const waitUntil = args.waitFor ?? 'load'
        return snapshotValue(await session.openTab(args.url, waitUntil, exec.signal))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('close_tab'),
      description: 'Close the tab at the given index. Closing the last tab resets it to a blank page.',
      parameters: {
        index: { type: 'integer', required: true, description: 'Tab index from ' + p('tabs') + '.' },
      },
      output: { schema: { type: 'null' }, render: (_args, _value) => [{ type: 'text', text: 'Tab closed.' }] },
      async execute(args, exec) {
        const session = await acquire(exec)
        await session.closeTab(args.index, exec.signal)
        return null
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: p('screenshot'),
      description:
        'Capture a PNG screenshot of the current page (or the referenced element) and store it ' +
        'as a durable image attachment the model can view.',
      parameters: {
        fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport.' },
        ref: { type: 'string', description: 'Optional element ref to capture instead of the page.' },
      },
      output: { schema: SCREENSHOT_SCHEMA, render: renderScreenshotValue },
      async execute(args, exec) {
        const session = await acquire(exec)
        const capture = await session.screenshot(
          {
            fullPage: args.fullPage ?? false,
            ...(args.ref !== undefined ? { ref: args.ref } : {}),
          },
          exec.signal,
        )
        const attachments = services().attachments
        if (attachments === undefined) {
          throw new Error(
            'browser_screenshot needs the attachments service; mount @deepseek-ai/dsh-attachment with a provider such as @deepseek-ai/dsh-attachment-local',
          )
        }
        const ref = await attachments.saveImage({
          data: capture.bytes,
          mediaType: capture.mime,
          name: 'browser-screenshot.png',
        })
        const url = (await session.snapshot()).url
        return {
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          url,
        }
      },
    }),
  )
  registerMaybe(
    'extract',
    defineTool({
      name: p('extract'),
      description:
        'Extract structured data from the current page: describe what you want in plain language, ' +
        'and the tool returns one parsed JSON value built from the page content. Requires the extract ' +
        'provider/model configuration.',
      parameters: {
        instruction: {
          type: 'string',
          required: true,
          description: 'What to extract, e.g. "all product names and prices as {name, price} objects".',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const extract = config.extract ?? { maxInputChars: 20000, maxOutputTokens: 2000 }
        const { provider, model } = extract
        if (provider === undefined || model === undefined) {
          throw new Error(
            'browser_extract is not configured: set extract.provider and extract.model in the browser-tool plugin config',
          )
        }
        const llm = services().llm
        if (llm === undefined) {
          throw new Error(
            'browser_extract needs the llm service; the harness composition must mount @deepseek-ai/dsh-llm',
          )
        }
        const session = await acquire(exec)
        const data = await session.pageData()
        const options = {
          provider,
          model,
          messages: [
            createUserMessage({
              content: [{ type: 'text', text: extractionPrompt(args.instruction, data, extract.maxInputChars) }],
              source: { kind: 'user' },
            }),
          ],
          system: 'You are a structured data extraction engine. Respond with exactly one JSON value and nothing else.',
          temperature: 0,
          maxTokens: extract.maxOutputTokens,
          signal: exec.signal,
        }
        const assembler = new BlockAssembler()
        for await (const chunk of llm.stream(options)) assembler.push(chunk)
        const finish = assembler.finish
        if (finish !== undefined && finish.kind !== 'stop') {
          throw new Error('browser_extract: extraction ended with finish reason ' + String(finish.kind))
        }
        const blocks = assembler.blocks()
        const text = blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(' ')
        return parseJsonText(text)
      },
    }),
  )
  registerMaybe(
    'evaluate',
    defineTool({
      name: p('evaluate'),
      description:
        'Evaluate one JavaScript expression in the page and return its JSON-serializable result. ' +
        'Disabled by default; the deployment must enable allowEvaluate. ' +
        'IRON RULE: prefer read-only expressions to INSPECT state (value, outerHTML, checked, textContent) before ' +
        'concluding an interaction failed. If you write to the DOM directly (setting value/textContent), ' +
        'framework-managed inputs (React/Vue/controlled components, contenteditable) will NOT update their state — ' +
        'the change can be overwritten or duplicated on the next render, which is a common cause of "typed text ' +
        'appears twice / disappears". For trusted input into such fields use ' +
        p('fill') +
        ' or ' +
        p('cdp') +
        ' ' +
        'Input.insertText instead of raw DOM assignment.',
      parameters: {
        expression: {
          type: 'string',
          required: true,
          description:
            'Single JavaScript expression, e.g. document.title or Array.from(document.querySelectorAll("h2")).map(e => e.textContent).',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        if (!config.allowEvaluate) {
          throw evaluateDisabled()
        }
        const session = await acquire(exec)
        return (await session.evaluate(args.expression, exec.signal)) as JsonValue
      },
    }),
  )
  registerMaybe(
    'cdp',
    defineTool({
      name: p('cdp'),
      description:
        'Send one raw CDP (Chrome DevTools Protocol) command on the current page and return its result. ' +
        'This is the direct-protocol escape hatch behind every other browser tool: use it to inspect element geometry ' +
        '(DOM.getBoxModel / DOM.getNodeForLocation / DOM.getContentQuads), query the DOM (DOM.querySelector / DOM.describeNode), ' +
        'or dispatch trusted native input (Input.dispatchMouseEvent / Input.dispatchKeyEvent) exactly like Chrome DevTools. ' +
        'Disabled by default; the deployment must enable allowCdp. Only inspection and input-simulation methods are allowed — ' +
        'network, storage, cookie, security and arbitrary-JS (Runtime.evaluate) commands are intentionally blocked for safety. ' +
        'IRON RULE: raw CDP is a diagnostic / trusted-input escape hatch, NOT a bypass for page logic, anti-bot, ' +
        'or site rules — prefer the higher-level browser tools whenever they can do the job. If you use CDP to ' +
        'directly modify page content or browser state (beyond ordinary navigation/UI interaction) and leave that ' +
        'change in place, you MUST tell the user what you changed in your final response.',
      parameters: {
        method: {
          type: 'string',
          required: true,
          description: 'CDP method name, e.g. DOM.getNodeForLocation or Input.dispatchMouseEvent.',
        },
        params: {
          type: 'object',
          additionalProperties: true,
          description: 'CDP command parameters object (default {}).',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        if (!config.allowCdp) {
          throw cdpDisabled()
        }
        if (!isCdpMethodAllowed(args.method)) {
          throw new BrowserError('CDP_DENIED', cdpDenialMessage(args.method))
        }
        const session = await acquire(exec)
        return (await session.cdp(args.method, args.params ?? {}, exec.signal)) as JsonValue
      },
    }),
  )
  if (config.diagnostics || config.registerDisabledTools) {
    ctx.tools.register(
      defineTool({
        name: p('console_messages'),
        description:
          'Return recent console messages and uncaught page errors from the tab this session is driving, newest last. ' +
          'Use it right after an action that reported success but produced no visible change: a thrown page error or a failed ' +
          'subresource is the usual reason a click or fill did not take effect. Read-only observation, it never acts on the page. ' +
          'Capture starts when this session first drives a tab, so an empty list on a fresh tab is normal. ' +
          'In persistent mode all sessions share one window, so entries describe that shared page.',
        parameters: {
          level: {
            type: 'string',
            description:
              "Filter by level: 'all' (default), 'error' (errors + uncaught page errors), 'warning', 'info', 'log', 'debug'.",
          },
          limit: { type: 'number', description: 'Max entries to return, newest last. Default 50, cap 200.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args: unknown, value: unknown) => [
            { type: 'text', text: renderDiagnostics('console', value as DiagnosticsValue) },
          ],
        },
        async execute(args, exec) {
          const session = await acquire(exec)
          // The canonical value is a wire value; the framework types tool outputs as JSON.
          return session.consoleMessages(args ?? {}) as unknown as JsonValue
        },
      }),
    )
  }
  if (config.diagnostics || config.registerDisabledTools) {
    ctx.tools.register(
      defineTool({
        name: p('network_requests'),
        description:
          'Return recent network requests from the tab this session is driving, newest last: method, URL, status, ' +
          'resource type, duration, and the failure text for requests that never completed. Use it to tell "the page did not ' +
          'react" apart from "the request behind it failed", and to find the API call an action triggered. ' +
          'Read-only; response bodies are not captured. In persistent mode all sessions share one window, so entries describe that shared page.',
        parameters: {
          urlContains: {
            type: 'string',
            description: 'Only return requests whose URL contains this substring (case-insensitive).',
          },
          failedOnly: { type: 'boolean', description: 'Only return requests that failed or returned status >= 400.' },
          limit: { type: 'number', description: 'Max entries to return, newest last. Default 50, cap 200.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args: unknown, value: unknown) => [
            { type: 'text', text: renderDiagnostics('network', value as DiagnosticsValue) },
          ],
        },
        async execute(args, exec) {
          const session = await acquire(exec)
          // The canonical value is a wire value; the framework types tool outputs as JSON.
          return session.networkRequests(args ?? {}) as unknown as JsonValue
        },
      }),
    )
  }
  ctx.tools.register(
    defineTool({
      name: p('close'),
      description:
        "Release this session's browser window. Persistent mode shares one window, so it closes only when the last session releases it; the profile keeps login state either way, so the next browser call reopens it still signed in (reset the profile to clear cookies).",

      parameters: {},
      output: {
        schema: { type: 'null' },
        render: (_args, _value) => [{ type: 'text', text: 'Browser window closed (profile kept).' }],
      },
      async execute(_args, exec) {
        const session = await acquire(exec)
        await session.close()
        return null
      },
    }),
  )
  /**
   * Load-time contract check. The tool list is the model-visible API and the
   * resident prompt cost, so a tool that contract.ts lists but the code never
   * registers (or one blocked by a typo'd name) must fail loudly here instead
   * of silently disappearing from the model's view.
   */
  const present = new Set(ctx.tools.schemas().map((schema) => schema.name))
  const missing = [...registered].map((suffix) => p(suffix)).filter((name) => !present.has(name))
  if (missing.length > 0) {
    throw new Error(
      'browser-tool: ' + missing.join(', ') + ' registered nothing; check the name against src/contract.ts',
    )
  }
}
