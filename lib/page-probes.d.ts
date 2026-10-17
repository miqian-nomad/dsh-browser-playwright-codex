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
export declare const clearLabelTargets: () => void;
/**
 * Page-side resolution for browser click/hover label mode: find the visible element
 * whose label (aria-label / alt / title / placeholder / own text) equals the
 * prefer the deepest match, stamp it with data-dsh-label-target, and describe
 * it so the landing note can name what was actually hovered. Runs inside the
 * page; used via page.evaluate(labelTargetProbe, { text }).
 */
export declare const labelTargetProbe: (arg: {
    text: string;
}) => {
    found: boolean;
    total: number;
    token?: never;
    desc?: never;
    exact?: never;
} | {
    found: boolean;
    token: string;
    desc: string;
    total: number;
    exact: boolean;
};
/**
 * Element-side bounded stability probe (Codex-style): samples the element's
 * boundingClientRect every animation frame; resolves true once it repeats for
 * `frames` consecutive frames, false after `timeoutMs`. Never hangs: the cap
 * always resolves. Used via locator.evaluate(elementStabilityProbe, arg).
 */
export declare const elementStabilityProbe: (el: Element, arg: {
    frames: number;
    timeoutMs: number;
}) => Promise<boolean>;
/**
 * Page-side bounded stability probe: samples layout size + pending images +
 * readyState. Used via page.evaluate(pageStabilityProbe, arg). The returned
 * "false on timeout" is intentional: a busy page must not stall the agent.
 */
export declare const pageStabilityProbe: (arg: {
    frames: number;
    timeoutMs: number;
}) => Promise<boolean>;
/**
 * The href a click on this element would follow: the element's own href, or the
 * nearest ancestor `<a href>` — crossing shadow-root boundaries, the same way the
 * hit-test walks. Raw-coordinate clicks already check `closest('a[href]')`; ref and
 * text clicks used to look only at the element itself, so a button/span nested in an
 * off-domain `<a>` reached the outside host while every check passed. This probe is
 * that missing layer: locator.evaluate(clickTargetHrefProbe).
 *
 * A policy check, not a navigation: `javascript:` hrefs are returned as-is and the
 * caller's session policy keeps its existing exemption for them.
 */
export declare const clickTargetHrefProbe: (el: Element) => string | null;
/**
 * The click-point hit test, moved out of the session so it lives with the other page-side
 * functions: it is serialized into the page by locator.evaluate(), so the same
 * "no named inner function bindings" rule applies (see the module header, and
 * tests/page-probes.test.ts which now enumerates this module's exports rather than a hand list).
 */
export type ClickProbe = {
    ok: true;
    x: number;
    y: number;
    hitDesc: string;
    hitSelf: boolean;
} | {
    ok: false;
    reason: 'zero-size' | 'off-screen' | 'nothing-at-point' | 'intercepted';
    x: number;
    y: number;
    geometry: string;
    by?: string;
};
export declare const hitTest: (el: Element) => ClickProbe;
