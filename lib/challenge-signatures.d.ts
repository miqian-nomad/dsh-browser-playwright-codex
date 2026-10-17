/**
 * 挑战页签名表：把「这页是不是拦截页」的判据放在厂商自有信号上，而不是页面文案上。
 *
 * 为什么分层，以及为什么是这个顺序（稳定性递减）：
 *
 * 1. 响应头是厂商对外的 API。Cloudflare 专门发文教用户读 `cf-mitigated: challenge`
 *    来识别挑战页，AWS WAF 同理（`x-amzn-waf-action: challenge`）。厂商改一个字的代价
 *    是打断所有客户的集成，不是打断我们一个插件。
 * 2. 厂商控件的无障碍名是次稳的：reCAPTCHA / hCaptcha / Turnstile 的 iframe 标题就是
 *    他们自己的产品名，出现在每一张用了他们的页面上。
 * 3. 文案最脆。FlareSolverr 就是死在依赖页面 title 和元素 class 上（上游 issue #1734：
 *    「元素的 class 和 id 被改过，所以现有的检测规则失效」）。
 *
 * 因此新增一家厂商 = 在这张表里加一条签名 + 在 tests/challenge.test.ts 加一条用例，
 * 判定逻辑本身不用改。
 * @module dsh-browser-playwright-codex/challenge-signatures
 */
/**
 * How a signature was proven. `response-header` is the vendor's own API,
 * `widget` is the vendor's own widget, `wording` is the fallback we trust least.
 */
export type ChallengeTier = 'response-header' | 'widget' | 'wording';
/**
 * One response-header rule. Matching is case-insensitive; a rule with neither
 * `equals` nor `contains` fires on the header's presence alone.
 */
export interface HeaderRule {
    /** Exact header name. Ignored when `namePrefix` is set. */
    readonly name: string;
    /** Exact value the header must carry. */
    readonly equals?: string;
    /** Substring the value must contain. */
    readonly contains?: string;
}
/** One vendor's interception signature. */
export interface ChallengeSignature {
    /** Stable id, used in tests and diagnostics. */
    readonly id: string;
    /** Engine label shown to the model. */
    readonly engine: string;
    /** One-clause explanation of what is happening. */
    readonly hint: string;
    /**
     * Header rules proven against the MAIN document response. These are the
     * vendor's published detection contract, so they are checked first.
     */
    readonly headers?: readonly HeaderRule[];
    /** Case-insensitive header-name prefixes (e.g. DataDome's `x-datadome*`). */
    readonly headerPrefixes?: readonly string[];
    /**
     * Status codes this signature must be corroborated by. Needed for vendors whose
     * header is *not* challenge-specific: DataDome adds `x-datadome*` to every
     * response (their docs say so, and they return `NA` when detection is off), and
     * Imperva adds `x-iinfo` to everything it fronts. Measured 2026-10-17: a normal
     * DataDome-fronted page answered 200 with `x-datadome: protected`, which an
     * ungated rule would have reported as a wall.
     */
    readonly statuses?: readonly number[];
    /**
     * Accessible-name tokens only this vendor's widget carries. On a non-iframe
     * node a token must ALSO be corroborated by {@link WIDGET_CORROBORATION}.
     */
    readonly widgetTokens?: readonly RegExp[];
    /**
     * Wording this vendor puts in the TITLE of its own interstitial. Vendor
     * wording is stronger than generic wording, so it is checked first and keeps
     * the vendor's name on the result.
     */
    readonly titleWording?: readonly RegExp[];
}
/**
 * Wording that corroborates a widget token found on a non-iframe node.
 *
 * Shared by every vendor on purpose, and it contains no vendor token: three of
 * the tokens below ("reCAPTCHA", "FunCaptcha", "px-captcha") literally contain
 * the word "captcha", so a list that accepted "captcha" would let the token
 * corroborate itself and the guard would be vacuous.
 */
export declare const WIDGET_CORROBORATION: readonly RegExp[];
/**
 * Every vendor we can prove from machine signals. Adding a vendor here is the
 * whole change: the detector walks the table, it does not know any of these names.
 */
export declare const CHALLENGE_SIGNATURES: readonly ChallengeSignature[];
/**
 * Wording a challenge page puts in its TITLE, with no vendor to attribute it to.
 * A title is short and authored by the interceptor, so a match here is safe on
 * its own. Kept combinatorial ("verification" + "human/safety/…") rather than
 * one phrase per language, so a reworded page still matches without a new
 * signature.
 */
export declare const WORDING_TITLE: readonly RegExp[];
/**
 * Wording a challenge page puts on a CONTROL (a button, a link, an input).
 * Command forms only: a help page that explains captchas says "验证码说明",
 * a challenge says "请输入验证码". The bare word for captcha is deliberately NOT
 * here — it is gated on a control role in {@link CAPTCHA_ROLES} instead, so a
 * link to the documentation cannot fire this tier.
 */
export declare const WORDING_COMMAND: readonly RegExp[];
/**
 * Controls that mention verification but are NOT a bot wall: sending yourself a
 * code is an ordinary sign-in step, and labelling it an anti-bot challenge
 * would send the user looking for a wall that is not there.
 */
export declare const WORDING_EXCLUDE: readonly RegExp[];
/** The word for "captcha" itself; only counts on a {@link CAPTCHA_ROLES} node. */
export declare const CAPTCHA_WORD: RegExp;
/**
 * Roles that make {@link CAPTCHA_WORD} count. A captcha input, image or button
 * is a challenge; a link or heading named "验证码说明" is documentation, and
 * firing on it would send the user chasing a wall that is not there.
 */
export declare const CAPTCHA_ROLES: ReadonlySet<string>;
