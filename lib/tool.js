import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { BrowserError } from "./errors.js";
import { registeredSuffixes } from "./contract.js";
import { getEnabled, publishGates } from "./runtime-state.js";
import { isCdpMethodAllowed, cdpDenialMessage } from "./cdp-policy.js";
import { SCREENSHOT_SCHEMA, SNAPSHOT_SCHEMA, TABS_SCHEMA } from "./tool-schemas.js";
import { parseJsonText, extractionPrompt } from "./extract.js";
import { detectChallenge } from "./challenge.js";
import { renderDiagnostics, renderScreenshotValue, renderSnapshotValue, renderTabsValue, snapshotValue, } from "./tool-render.js";
export { detectChallenge };
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-tool';
/** The browser runtime and tool registry this plugin consumes. */
export const inject = ['browser', 'tools'];
/** Schemastery validation for {@link ToolConfig}. */
export const Config = z.object({
    toolPrefix: z.string().default('browser_'),
    allowEvaluate: z.boolean().default(false),
    allowCdp: z.boolean().default(false),
    registerDisabledTools: z.boolean().default(false),
    maxWaitMs: z.number().default(60000),
    interactiveOnlyDefault: z.boolean().default(false),
    extract: z.object({
        provider: z.string(),
        model: z.string(),
        maxInputChars: z.number().default(20000),
        maxOutputTokens: z.number().default(2000),
    }),
});
/**
 * Register the browser tool family on ctx.tools.
 * @param ctx - plugin context carrying browser, tools, and the optional services.
 * @param config - tool naming and safety configuration.
 */
export function apply(ctx, config) {
    if (!/^[a-z][a-z0-9_]*$/.test(config.toolPrefix)) {
        throw new Error('browser-tool: toolPrefix must match [a-z][a-z0-9_]*');
    }
    const p = (base) => config.toolPrefix + base;
    /**
     * The live tool surface for this configuration. Gated tools (evaluate, cdp,
     * extract) register only when their capability is enabled: their schemas sit
     * in the system prompt on every turn, and a disabled capability can only
     * return an error, so shipping it would be pure prompt cost.
     */
    const surface = {
        allowEvaluate: config.allowEvaluate,
        allowCdp: config.allowCdp,
        extractConfigured: config.extract?.provider !== undefined && config.extract?.model !== undefined,
        registerDisabledTools: config.registerDisabledTools,
    };
    const registered = new Set(registeredSuffixes(surface));
    // Tell the Settings page what is actually in effect. It cannot read this
    // config itself (the value may come from a bundle patch, a profile patch or a
    // home-level patch), so the tool family publishes it at registration and the
    // switch shows the truth instead of a guess. Driven by the same values that
    // decided which tools register, so the two can never disagree.
    publishGates({ allowEvaluate: registered.has('evaluate'), allowCdp: registered.has('cdp') });
    /** Register one gated tool only when this configuration keeps it live. */
    const registerMaybe = (suffix, definition) => {
        if (registered.has(suffix))
            ctx.tools.register(definition);
    }; /** Resolve the calling session's browser owner key. */
    const ownerFor = (exec) => {
        const id = exec.agent?.session.id;
        return id === undefined ? 'anonymous' : String(id);
    };
    /** Acquire the calling session's live browser session. */
    const acquire = (exec) => {
        if (!getEnabled()) {
            throw new BrowserError('DISABLED', 'dsh-browser-playwright-codex is disabled; open Settings → Plugins → 浏览器 and turn it on to use the browser');
        }
        return ctx.browser.acquire(ownerFor(exec), exec.signal);
    };
    const services = () => {
        const out = {};
        const attachments = ctx.get('attachments');
        const llm = ctx.get('llm');
        if (attachments !== undefined)
            out.attachments = attachments;
        if (llm !== undefined)
            out.llm = llm;
        return out;
    };
    ctx.tools.register(defineTool({
        name: p('navigate'),
        description: 'Navigate the persistent browser to a URL and return the new page snapshot. ' +
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
            const session = await acquire(exec);
            const waitUntil = args.waitFor ?? 'load';
            return snapshotValue(await session.navigate(args.url, waitUntil, exec.signal));
        },
    }));
    ctx.tools.register(defineTool({
        name: p('snapshot'),
        description: 'Return the current page snapshot: URL, title, and visible elements with stable ref= identifiers. ' +
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
            const session = await acquire(exec);
            const interactiveOnly = args.interactiveOnly ?? config.interactiveOnlyDefault;
            return snapshotValue(await session.snapshot({ interactiveOnly }));
        },
    }));
    ctx.tools.register(defineTool({
        name: p('click'),
        description: 'Click the element with the given ref from the latest snapshot and return the new snapshot. ' +
            'Refs go stale after navigation or DOM changes — take a fresh ' +
            p('snapshot') +
            ' if a ref fails. ' +
            'Prefer ref when the snapshot has one; for a target shown WITHOUT a ref (plain text, e.g. generic "设置", or a menu item ' +
            p('hover') +
            ' just revealed), pass text instead, copied exactly as rendered — a revealed item may need ' +
            p('hover') +
            ' first to stay on screen. ' +
            'IRON RULE: after the click, verify in the returned snapshot that the intended effect actually happened (URL, selection, toast, dialog, new content). ' +
            'A click can also succeed without changing this page: when the snapshot shows no change, check ' +
            p('tabs') +
            ' for a new tab (a target="_blank" link) before concluding failure, and treat a same-page overlay or popup, URL unchanged and no new tab, as success — the returned snapshot is the evidence: compare its refs and content with the pre-click snapshot. ' +
            'The snapshot may open with a landing note naming what received the click: if that is not your target, the click was intercepted — treat it as failed and retarget. ' +
            'If there was no visible effect, do NOT blindly repeat the click and do NOT fall back to ' +
            p('click_at') +
            ' raw coordinates — inspect the visible state for the blocker or interception, resolve it, then retry the most direct semantic action. ' +
            'If the click raises a native dialog, it stays PENDING and this call returns immediately with the dialog text instead of the page tree — answer it with ' +
            p('dialog') +
            '. This tool has no way to accept a dialog: accepting is a separate, deliberate call.',
        parameters: {
            ref: {
                type: 'string',
                description: 'Element ref (e.g. e12) from the latest snapshot. Use this whenever the snapshot has a ref for the target.',
            },
            text: {
                type: 'string',
                description: 'Visible label of a target shown WITHOUT a ref (plain text, e.g. generic "搜索设置"). Copied exactly as the snapshot renders it; the first visible element whose own text matches is clicked and the landing note names it.',
            },
        },
        output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
        async execute(args, exec) {
            const session = await acquire(exec);
            if (args.ref !== undefined && args.ref !== '') {
                return snapshotValue(await session.click(args.ref, exec.signal));
            }
            if (args.text !== undefined && args.text !== '') {
                return snapshotValue(await session.clickText(args.text, exec.signal));
            }
            throw new BrowserError('PARAM_MISSING', 'browser_click needs either a ref from the latest snapshot or the visible text label of a target that has no ref');
        },
    }));
    ctx.tools.register(defineTool({
        name: p('dialog'),
        description: 'Answer the native dialog currently blocking the page — alert, confirm, prompt or beforeunload — and return the fresh snapshot. ' +
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
            const session = await acquire(exec);
            if (typeof args.accept !== 'boolean') {
                throw new BrowserError('PARAM_MISSING', 'browser_dialog needs accept: true (confirm) or false (cancel)');
            }
            return snapshotValue(await session.resolveDialog(args.accept, args.promptText, exec.signal));
        },
    }));
    ctx.tools.register(defineTool({
        name: p('click_at'),
        description: 'Precise native click, two modes. Ref mode (prefer it): pass ref — the element is scrolled into view, awaited for geometry stability, and clicked at its exact geometric centre through native input: no screenshot measuring, no devicePixelRatio guesswork. ' +
            'Raw mode: pass x/y viewport CSS pixels to click a raw point with no element involvement. ' +
            'This is the FALLBACK, not a routine alternative: try ' +
            p('click') +
            ' (including its text mode) first, and use ref mode only after a click reports the element is not actionable or the click could not be delivered. Raw x/y is a last resort for targets no ref resolves (canvas-drawn hit areas): raw clicks still return a landing note saying what they hit, so re-snapshot and confirm. ' +
            'IRON RULE: verify the effect in the returned snapshot; if nothing changed, do NOT repeat blindly and do NOT throw more raw coordinates at it — find the blocker or interception first, then retry the most direct semantic action. ' +
            'The snapshot may open with a landing note naming what received the click, or — when an intercepted ref-mode target had to fall back to a bare click at its centre — a CAUTION note: if the click was intercepted, treat it as failed and retarget.',
        parameters: {
            ref: {
                type: 'string',
                description: 'Element ref (e.g. e12) from the latest snapshot. If given, its geometric centre is clicked; x/y are ignored.',
            },
            x: { type: 'integer', description: 'Raw-mode viewport x in CSS pixels (required only when ref is omitted).' },
            y: { type: 'integer', description: 'Raw-mode viewport y in CSS pixels (required only when ref is omitted).' },
        },
        output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
        async execute(args, exec) {
            const session = await acquire(exec);
            if (args.ref !== undefined && args.ref !== '') {
                return snapshotValue(await session.clickAtRef(args.ref, exec.signal));
            }
            if (typeof args.x !== 'number' || typeof args.y !== 'number') {
                throw new BrowserError('PARAM_MISSING', 'browser_click_at needs a ref, or both x and y viewport coordinates');
            }
            return snapshotValue(await session.clickAt(args.x, args.y, exec.signal));
        },
    }));
    ctx.tools.register(defineTool({
        name: p('hover'),
        description: 'Hover the element with the given ref — or, for a trigger the snapshot gave no ref, the visible element whose own label equals text — and return the new snapshot. ' +
            'Hover only REVEALS content and never activates anything: use ' +
            p('click') +
            ' to open, select or submit. Use it when a control hides content until the pointer rests on it (submenus, dropdowns, account menus, tooltips, previews, chart values, player controls) — and especially when the snapshot lacks an element the page obviously should have. ' +
            'Prefer ref when the snapshot has one; use text only for a label shown WITHOUT a ref, copied exactly as rendered. Do not hover plain links/buttons you mean to activate, and never hover "just in case". ' +
            'A hover returning only means the pointer moved: the snapshot opens with a note comparing the actionable ref count before and after — read it. New refs mean the revealed content is in this snapshot and pre-hover refs are stale, so pick from the NEW refs and act before any unrelated click closes the menu. ' +
            'IRON RULE: if the note reports no new refs and what you expected is still missing, do NOT repeat the hover and do NOT fall back to ' +
            p('click_at') +
            ' raw coordinates — hover the parent/container or the sibling that owns the menu; if that also reveals nothing, hover is not implemented here, so use a visible alternative or tell the user.',
        parameters: {
            ref: {
                type: 'string',
                description: 'Element ref (e.g. e12) from the latest snapshot. Use this whenever the snapshot has a ref for the trigger.',
            },
            text: {
                type: 'string',
                description: 'Visible label of a trigger shown WITHOUT a ref (plain text, e.g. generic "设置"). Copied exactly as the snapshot renders it; the first visible element whose own text matches is hovered and the note names it.',
            },
        },
        output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
        async execute(args, exec) {
            const session = await acquire(exec);
            if (args.ref !== undefined && args.ref !== '') {
                return snapshotValue(await session.hover(args.ref, exec.signal));
            }
            if (args.text !== undefined && args.text !== '') {
                return snapshotValue(await session.hoverText(args.text, exec.signal));
            }
            throw new BrowserError('PARAM_MISSING', 'browser_hover needs either a ref from the latest snapshot or the visible text label of a trigger that has no ref');
        },
    }));
    ctx.tools.register(defineTool({
        name: p('fill'),
        description: 'Replace the value of the input or select referenced by the latest snapshot. ' +
            'For <select> elements the text selects the matching option label. ' +
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
            text: { type: 'string', required: true, description: 'Exact value to fill, or option label for selects.' },
        },
        output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
        async execute(args, exec) {
            const session = await acquire(exec);
            return snapshotValue(await session.fill(args.ref, args.text, exec.signal));
        },
    }));
    ctx.tools.register(defineTool({
        name: p('press'),
        description: 'Press a keyboard key (e.g. Enter, Tab, ArrowDown, Escape) on the referenced element. ' +
            'IRON RULE: after pressing, verify in the returned snapshot that the key actually did what you expected ' +
            '(e.g. Enter submitted the form, Escape closed the dialog) before moving on — do not assume it worked.',
        parameters: {
            ref: { type: 'string', required: true, description: 'Element ref from the latest snapshot.' },
            key: { type: 'string', required: true, description: 'Key name to press, e.g. Enter, Escape, ArrowDown.' },
        },
        output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
        async execute(args, exec) {
            const session = await acquire(exec);
            return snapshotValue(await session.press(args.ref, args.key, exec.signal));
        },
    }));
    ctx.tools.register(defineTool({
        name: p('scroll'),
        description: 'Scroll the page (or bring the referenced element into view) and return the new snapshot.',
        parameters: {
            direction: { type: 'string', enum: ['up', 'down'], required: true, description: 'Scroll direction.' },
            amount: { type: 'integer', description: 'Scroll distance in pixels. Defaults to 600.' },
            ref: { type: 'string', description: 'Optional element ref to scroll into view first.' },
        },
        output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
        async execute(args, exec) {
            const session = await acquire(exec);
            const amount = args.amount ?? 600;
            return snapshotValue(await session.scroll(args.direction, amount, args.ref, exec.signal));
        },
    }));
    ctx.tools.register(defineTool({
        name: p('back'),
        description: 'Navigate history back and return the new snapshot.',
        parameters: {},
        output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
        async execute(_args, exec) {
            const session = await acquire(exec);
            return snapshotValue(await session.back(exec.signal));
        },
    }));
    ctx.tools.register(defineTool({
        name: p('forward'),
        description: 'Navigate history forward and return the new snapshot.',
        parameters: {},
        output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
        async execute(_args, exec) {
            const session = await acquire(exec);
            return snapshotValue(await session.forward(exec.signal));
        },
    }));
    ctx.tools.register(defineTool({
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
                throw new Error('browser_wait: ms must be a positive integer no larger than ' + String(config.maxWaitMs));
            }
            const session = await acquire(exec);
            await session.wait(args.ms, exec.signal);
            return null;
        },
    }));
    ctx.tools.register(defineTool({
        name: p('tabs'),
        description: 'List the open tabs of this session with their indexes, URLs, and titles. The tab marked [active] is the page every other browser tool acts on.',
        parameters: {},
        output: { schema: TABS_SCHEMA, render: renderTabsValue },
        async execute(_args, exec) {
            const session = await acquire(exec);
            const tabs = await session.tabs();
            return { tabs: tabs.map((tab) => ({ index: tab.index, url: tab.url, title: tab.title, active: tab.active })) };
        },
    }));
    ctx.tools.register(defineTool({
        name: p('switch_tab'),
        description: 'Activate the tab at the given index and return its snapshot.',
        parameters: {
            index: { type: 'integer', required: true, description: 'Tab index from ' + p('tabs') + '.' },
        },
        output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
        async execute(args, exec) {
            const session = await acquire(exec);
            return snapshotValue(await session.switchTab(args.index, exec.signal));
        },
    }));
    ctx.tools.register(defineTool({
        name: p('open_tab'),
        description: 'Open a new tab at the given URL and return its snapshot. The new tab becomes [active], so later calls act on it.',
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
            const session = await acquire(exec);
            const waitUntil = args.waitFor ?? 'load';
            return snapshotValue(await session.openTab(args.url, waitUntil, exec.signal));
        },
    }));
    ctx.tools.register(defineTool({
        name: p('close_tab'),
        description: 'Close the tab at the given index. Closing the last tab resets it to a blank page.',
        parameters: {
            index: { type: 'integer', required: true, description: 'Tab index from ' + p('tabs') + '.' },
        },
        output: { schema: { type: 'null' }, render: (_args, _value) => [{ type: 'text', text: 'Tab closed.' }] },
        async execute(args, exec) {
            const session = await acquire(exec);
            await session.closeTab(args.index, exec.signal);
            return null;
        },
    }));
    ctx.tools.register(defineTool({
        name: p('screenshot'),
        description: 'Capture a PNG screenshot of the current page (or the referenced element) and store it ' +
            'as a durable image attachment the model can view.',
        parameters: {
            fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport.' },
            ref: { type: 'string', description: 'Optional element ref to capture instead of the page.' },
        },
        output: { schema: SCREENSHOT_SCHEMA, render: renderScreenshotValue },
        async execute(args, exec) {
            const session = await acquire(exec);
            const capture = await session.screenshot({
                fullPage: args.fullPage ?? false,
                ...(args.ref !== undefined ? { ref: args.ref } : {}),
            }, exec.signal);
            const attachments = services().attachments;
            if (attachments === undefined) {
                throw new Error('browser_screenshot needs the attachments service; mount @deepseek-ai/dsh-attachment with a provider such as @deepseek-ai/dsh-attachment-local');
            }
            const ref = await attachments.saveImage({
                data: capture.bytes,
                mediaType: capture.mime,
                name: 'browser-screenshot.png',
            });
            const url = (await session.snapshot()).url;
            return {
                attachmentId: String(ref.attachmentId),
                mediaType: ref.mediaType,
                bytes: ref.bytes,
                width: ref.width,
                height: ref.height,
                url,
            };
        },
    }));
    registerMaybe('extract', defineTool({
        name: p('extract'),
        description: 'Extract structured data from the current page: describe what you want in plain language, ' +
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
            const extract = config.extract ?? { maxInputChars: 20000, maxOutputTokens: 2000 };
            const { provider, model } = extract;
            if (provider === undefined || model === undefined) {
                throw new Error('browser_extract is not configured: set extract.provider and extract.model in the browser-tool plugin config');
            }
            const llm = services().llm;
            if (llm === undefined) {
                throw new Error('browser_extract needs the llm service; the harness composition must mount @deepseek-ai/dsh-llm');
            }
            const session = await acquire(exec);
            const data = await session.pageData();
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
            };
            const assembler = new BlockAssembler();
            for await (const chunk of llm.stream(options))
                assembler.push(chunk);
            const finish = assembler.finish;
            if (finish !== undefined && finish.kind !== 'stop') {
                throw new Error('browser_extract: extraction ended with finish reason ' + String(finish.kind));
            }
            const blocks = assembler.blocks();
            const text = blocks
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join(' ');
            return parseJsonText(text);
        },
    }));
    registerMaybe('evaluate', defineTool({
        name: p('evaluate'),
        description: 'Evaluate one JavaScript expression in the page and return its JSON-serializable result. ' +
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
                description: 'Single JavaScript expression, e.g. document.title or Array.from(document.querySelectorAll("h2")).map(e => e.textContent).',
            },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
            if (!config.allowEvaluate) {
                throw new BrowserError('EVALUATE_DISABLED', 'browser_evaluate is disabled; set allowEvaluate: true on the browser-tool plugin to enable arbitrary page JavaScript');
            }
            const session = await acquire(exec);
            return (await session.evaluate(args.expression, exec.signal));
        },
    }));
    registerMaybe('cdp', defineTool({
        name: p('cdp'),
        description: 'Send one raw CDP (Chrome DevTools Protocol) command on the current page and return its result. ' +
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
                throw new BrowserError('CDP_DISABLED', 'browser_cdp is disabled; set allowCdp: true on the browser-tool plugin to enable raw CDP inspection commands');
            }
            if (!isCdpMethodAllowed(args.method)) {
                throw new BrowserError('CDP_DENIED', cdpDenialMessage(args.method));
            }
            const session = await acquire(exec);
            return (await session.cdp(args.method, args.params ?? {}, exec.signal));
        },
    }));
    ctx.tools.register(defineTool({
        name: p('console_messages'),
        description: 'Return recent console messages and uncaught page errors from the tab this session is driving, newest last. ' +
            'Use it right after an action that reported success but produced no visible change: a thrown page error or a failed ' +
            'subresource is the usual reason a click or fill did not take effect. Read-only observation, it never acts on the page. ' +
            'Capture starts when this session first drives a tab, so an empty list on a fresh tab is normal. ' +
            'In persistent mode all sessions share one window, so entries describe that shared page.',
        parameters: {
            level: {
                type: 'string',
                description: "Filter by level: 'all' (default), 'error' (errors + uncaught page errors), 'warning', 'info', 'log', 'debug'.",
            },
            limit: { type: 'number', description: 'Max entries to return, newest last. Default 50, cap 200.' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [
                { type: 'text', text: renderDiagnostics('console', value) },
            ],
        },
        async execute(args, exec) {
            const session = await acquire(exec);
            // The canonical value is a wire value; the framework types tool outputs as JSON.
            return session.consoleMessages(args ?? {});
        },
    }));
    ctx.tools.register(defineTool({
        name: p('network_requests'),
        description: 'Return recent network requests from the tab this session is driving, newest last: method, URL, status, ' +
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
            render: (_args, value) => [
                { type: 'text', text: renderDiagnostics('network', value) },
            ],
        },
        async execute(args, exec) {
            const session = await acquire(exec);
            // The canonical value is a wire value; the framework types tool outputs as JSON.
            return session.networkRequests(args ?? {});
        },
    }));
    ctx.tools.register(defineTool({
        name: p('close'),
        description: "Release this session's browser window. Persistent mode shares one window, so it closes only when the last session releases it; the profile keeps login state either way, so the next browser call reopens it still signed in (reset the profile to clear cookies).",
        parameters: {},
        output: {
            schema: { type: 'null' },
            render: (_args, _value) => [{ type: 'text', text: 'Browser window closed (profile kept).' }],
        },
        async execute(_args, exec) {
            const session = await acquire(exec);
            await session.close();
            return null;
        },
    }));
    /**
     * Load-time contract check. The tool list is the model-visible API and the
     * resident prompt cost, so a tool that contract.ts lists but the code never
     * registers (or one blocked by a typo'd name) must fail loudly here instead
     * of silently disappearing from the model's view.
     */
    const present = new Set(ctx.tools.schemas().map((schema) => schema.name));
    const missing = [...registered].map((suffix) => p(suffix)).filter((name) => !present.has(name));
    if (missing.length > 0) {
        throw new Error('browser-tool: ' + missing.join(', ') + ' registered nothing; check the name against src/contract.ts');
    }
}
