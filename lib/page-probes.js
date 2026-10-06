/**
 * Page-side probe functions: every one of these is **serialized into the browser** by
 * locator.evaluate()/page.evaluate(), so each must be self-contained.
 *
 * The rule, learned the hard way (2026-10-05): a transpiler that keeps function names — esbuild,
 * through its \`__name\` helper — rewrites a named inner binding like \`const describe = (…) => …\`
 * into a call to a helper that exists only in module scope. The page has no such helper, so the
 * probe throws ReferenceError on every call. In this file that is not a style question: it silently
 * disabled the whole click-geometry pipeline for weeks. Safe shapes are an array literal
 * (\`const [a, b] = [() => …, () => …]\`) and an immediately-invoked arrow; both allow the two to
 * call each other. tests/page-probes.test.ts enforces this by grepping the serialized source.
 *
 * @module dsh-browser-playwright-codex/page-probes
 */
/** Remove browser label stamps. Used via page.evaluate(clearLabelTargets). */
export const clearLabelTargets = () => {
    for (const el of document.querySelectorAll('[data-dsh-label-target]'))
        el.removeAttribute('data-dsh-label-target');
};
/**
 * Page-side resolution for browser click/hover label mode: find the visible element
 * whose label (aria-label / alt / title / placeholder / own text) equals the
 * prefer the deepest match, stamp it with data-dsh-label-target, and describe
 * it so the landing note can name what was actually hovered. Runs inside the
 * page; used via page.evaluate(labelTargetProbe, { text }).
 */
export const labelTargetProbe = (arg) => {
    const wanted = String(arg.text).replace(/\s+/g, ' ').trim();
    // Array destructuring, not named bindings: this function is serialized into the page,
    // and a transpiler that keeps function names (esbuild's `__name`) would rewrite a named
    // inner binding into a call to a module-scope helper the page does not have. An array
    // literal is not a named binding, so it survives (same rule as the probes below).
    const [norm, ownText] = [
        (s) => (s || '').replace(/\s+/g, ' ').trim(),
        (el) => {
            let out = '';
            for (const node of el.childNodes) {
                if (node.nodeType === 3)
                    out += node.textContent;
                else if (node.nodeType === 1 && node.tagName.toLowerCase() === 'br')
                    out += ' ';
            }
            return norm(out);
        },
    ];
    // Mirror the snapshot's name sources, so anything the page shows under a
    // name can be addressed by that name: aria-label / alt / title / placeholder
    // first, then the element's own visible text.
    const [labelOf, visible, depthOf] = [
        (el) => 
        // Attribute reads are inlined, not wrapped in a local `attr` helper: any named
        // function binding inside this serialized function would be rewritten to a call to
        // a module-scope helper the page does not have. norm() already turns null/blank
        // into '', which is what the helper did.
        norm(el.getAttribute('aria-label')) ||
            norm(el.getAttribute('alt')) ||
            norm(el.getAttribute('title')) ||
            norm(el.getAttribute('placeholder')) ||
            ownText(el),
        (el) => {
            if (!(el instanceof Element))
                return false;
            if (el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true')
                return false;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden')
                return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 || rect.height > 0;
        },
        (el) => {
            let depth = 0;
            let cur = el;
            while (cur !== null && cur.parentElement !== null) {
                depth += 1;
                cur = cur.parentElement;
            }
            return depth;
        },
    ];
    const root = document.body !== null && document.body !== undefined ? document.body : document.documentElement;
    const all = Array.from(root.querySelectorAll('*')).slice(0, 8000).filter(visible);
    let pool = all.filter((el) => labelOf(el) === wanted);
    let exact = true;
    if (pool.length === 0) {
        exact = false;
        pool = all.filter((el) => ownText(el).indexOf(wanted) !== -1 || labelOf(el).indexOf(wanted) !== -1);
    }
    if (pool.length === 0)
        return { found: false, total: 0 };
    pool.sort((a, b) => depthOf(b) - depthOf(a));
    const picked = pool[0];
    if (picked === undefined)
        return { found: false, total: pool.length };
    for (const el of document.querySelectorAll('[data-dsh-label-target]'))
        el.removeAttribute('data-dsh-label-target');
    const token = 'ht' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    try {
        picked.setAttribute('data-dsh-label-target', token);
    }
    catch (_) {
        return { found: false, total: pool.length };
    }
    const cls = typeof picked.className === 'string' && picked.className.trim() !== ''
        ? '.' + picked.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
    return {
        found: true,
        token,
        desc: picked.tagName.toLowerCase() + (picked.id ? '#' + picked.id : '') + cls,
        total: pool.length,
        exact,
    };
};
/**
 * Element-side bounded stability probe (Codex-style): samples the element's
 * boundingClientRect every animation frame; resolves true once it repeats for
 * `frames` consecutive frames, false after `timeoutMs`. Never hangs: the cap
 * always resolves. Used via locator.evaluate(elementStabilityProbe, arg).
 */
export const elementStabilityProbe = (el, arg) => new Promise((resolve) => {
    const frames = arg.frames;
    const timeoutMs = arg.timeoutMs;
    const deadline = performance.now() + timeoutMs;
    let prev = null;
    let stable = 0;
    // Array destructuring, not `const sig = …`: these functions are serialized into
    // the page, and a transpiler that keeps function names (esbuild's `__name`) rewrites
    // a named inner binding into a *call* to a module-scope helper the page does not have
    // (`ReferenceError: __name is not defined`). An array literal is not a named binding,
    // so this shape survives — and the two can still call each other. Verified 2026-10-05
    // with fn.toString() under tsx, and by running this suite under tsx again.
    const [sig, tick] = [
        () => {
            const r = el.getBoundingClientRect();
            return [r.left, r.top, r.width, r.height].join(',');
        },
        () => {
            const cur = sig();
            if (prev !== null && cur === prev) {
                stable += 1;
                if (stable >= frames) {
                    resolve(true);
                    return;
                }
            }
            else {
                stable = 0;
            }
            prev = cur;
            if (performance.now() >= deadline) {
                resolve(false);
                return;
            }
            requestAnimationFrame(tick);
        },
    ];
    requestAnimationFrame(tick);
});
/**
 * Page-side bounded stability probe: samples layout size + pending images +
 * readyState. Used via page.evaluate(pageStabilityProbe, arg). The returned
 * "false on timeout" is intentional: a busy page must not stall the agent.
 */
export const pageStabilityProbe = (arg) => new Promise((resolve) => {
    const frames = arg.frames;
    const timeoutMs = arg.timeoutMs;
    const deadline = performance.now() + timeoutMs;
    let prev = null;
    let stable = 0;
    // Array destructuring, not `const sig = …`: these functions are serialized into
    // the page, and a transpiler that keeps function names (esbuild's `__name`) rewrites
    // a named inner binding into a *call* to a module-scope helper the page does not have
    // (`ReferenceError: __name is not defined`). An array literal is not a named binding,
    // so this shape survives — and the two can still call each other. Verified 2026-10-05
    // with fn.toString() under tsx, and by running this suite under tsx again.
    const [sig, tick] = [
        () => {
            const de = document.documentElement;
            return [de.scrollWidth, de.scrollHeight, document.querySelectorAll('img:not([complete])').length].join(',');
        },
        () => {
            const cur = sig();
            if (prev !== null && cur === prev) {
                stable += 1;
                if (stable >= frames) {
                    resolve(true);
                    return;
                }
            }
            else {
                stable = 0;
            }
            prev = cur;
            if (performance.now() >= deadline) {
                resolve(false);
                return;
            }
            requestAnimationFrame(tick);
        },
    ];
    requestAnimationFrame(tick);
});
export const hitTest = (el) => {
    const r = el.getBoundingClientRect();
    const w = r.width;
    const h = r.height;
    const geometry = 'rect ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(w) + 'x' + Math.round(h);
    if (w <= 0 || h <= 0)
        return { ok: false, reason: 'zero-size', x: r.left, y: r.top, geometry };
    // The probe must sit inside the element AND inside the viewport:
    // elementFromPoint() answers null for coordinates outside the viewport, so
    // sampling the element's own centre missed any target taller than the viewport
    // (or one whose centre was below the fold) even when most of it was plainly
    // clickable. Aim at the centre of the visible intersection instead.
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const right = Math.min(r.right, view.innerWidth);
    const bottom = Math.min(r.bottom, view.innerHeight);
    if (right - left <= 0 || bottom - top <= 0) {
        return {
            ok: false,
            reason: 'off-screen',
            x: r.left,
            y: r.top,
            geometry: geometry + ' viewport ' + view.innerWidth + 'x' + view.innerHeight,
        };
    }
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    let hit = null;
    try {
        hit = document.elementFromPoint(x, y);
    }
    catch {
        hit = null;
    }
    if (!hit)
        return { ok: false, reason: 'nothing-at-point', x, y, geometry };
    // Describe the hit inline, as a string: session function is serialized into the
    // page, so it must be self-contained. A transpiler that keeps function names
    // (esbuild/tsx, through its `__name` helper) rewrites a named inner binding
    // like `const describe = (…) => …` into a call to a helper that exists only in
    // module scope — and the page has no such helper, so the probe would throw
    // ReferenceError and every click would silently fall back to Playwright's
    // actionability click (3s cap). That is what made the Windows runner flaky
    // until 2026-10-05; the test runner now strips types natively, and keeping the
    // probe free of inner function bindings protects anyone who transpiles src/.
    const hitDesc = (hit.tagName ? hit.tagName.toLowerCase() : hit.nodeName) +
        (hit.id ? '#' + hit.id : '') +
        (typeof hit.className === 'string' && hit.className.trim()
            ? '.' + hit.className.trim().split(/\s+/).filter(Boolean).join('.')
            : '') +
        (hit.getAttribute && hit.getAttribute('role') ? '[role=' + hit.getAttribute('role') + ']' : '') +
        (hit.childElementCount === 0 && hit.textContent ? ' "' + hit.textContent.trim().slice(0, 24) + '"' : '');
    let belongs = false;
    if (hit === el || el.contains(hit)) {
        belongs = true;
    }
    else {
        // Walk up from the hit; crossing a shadow boundary hops to the
        // shadow host so targets inside shadow DOM still count.
        let node = hit;
        const seen = new Set();
        while (node && !seen.has(node)) {
            seen.add(node);
            if (node === el) {
                belongs = true;
                break;
            }
            const root = node.getRootNode
                ? node.getRootNode()
                : null;
            node = node.parentNode || (root && root.host ? root.host : null);
        }
    }
    return belongs
        ? { ok: true, x, y, hitDesc, hitSelf: hit === el }
        : { ok: false, reason: 'intercepted', x, y, by: hitDesc, geometry };
};
