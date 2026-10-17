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
 * Wording that corroborates a widget token found on a non-iframe node.
 *
 * Shared by every vendor on purpose, and it contains no vendor token: three of
 * the tokens below ("reCAPTCHA", "FunCaptcha", "px-captcha") literally contain
 * the word "captcha", so a list that accepted "captcha" would let the token
 * corroborate itself and the guard would be vacuous.
 */
export const WIDGET_CORROBORATION = Object.freeze([
    /verify|challenge|robot|human|verification/i,
    /验证|校验|人机|真人/,
]);
/**
 * Every vendor we can prove from machine signals. Adding a vendor here is the
 * whole change: the detector walks the table, it does not know any of these names.
 */
export const CHALLENGE_SIGNATURES = Object.freeze([
    {
        id: 'cloudflare-challenge',
        engine: 'Cloudflare',
        hint: 'Cloudflare answered with a challenge page instead of the page itself',
        headers: [{ name: 'cf-mitigated', equals: 'challenge' }],
        // The interstitial's own title, in both languages. Only reached when the
        // header is missing (a cached page, a prefetch, a client-side fetch).
        titleWording: [
            /just a moment|attention required|checking (your )?browser|enable javascript and cookies|cf-chl-/i,
            /请稍候|验证你的浏览器|正在进行安全验证/,
        ],
    },
    {
        id: 'aws-waf',
        engine: 'AWS WAF',
        hint: 'AWS WAF answered with a challenge instead of the page itself',
        headers: [{ name: 'x-amzn-waf-action', equals: 'challenge' }],
    },
    {
        id: 'imperva-incapsula',
        engine: 'Imperva',
        hint: 'Imperva (Incapsula) blocked this request from its edge',
        // Presence only: X-IInfo is an opaque per-response trace that Imperva adds to
        // everything it fronts, so the header alone says nothing about a block — the
        // status code has to agree.
        headers: [{ name: 'x-iinfo' }],
        statuses: [403, 429, 503],
    },
    {
        id: 'datadome',
        engine: 'DataDome',
        hint: 'DataDome blocked this request',
        headerPrefixes: ['x-datadome'],
        statuses: [403, 429, 503],
    },
    {
        id: 'recaptcha',
        engine: 'captcha',
        hint: 'the page embedded a reCAPTCHA widget, which automation must not attempt to solve',
        widgetTokens: [/recaptcha/i],
    },
    {
        id: 'hcaptcha',
        engine: 'captcha',
        hint: 'the page embedded an hCaptcha widget, which automation must not attempt to solve',
        widgetTokens: [/hcaptcha/i],
    },
    {
        id: 'turnstile',
        engine: 'Cloudflare',
        hint: 'Cloudflare Turnstile is asking the visitor to prove they are human',
        widgetTokens: [/turnstile/i, /widget containing a cloudflare security challenge/i],
    },
    {
        id: 'arkose-funcaptcha',
        engine: 'captcha',
        hint: 'the page embedded an Arkose / FunCaptcha challenge, which automation must not attempt to solve',
        widgetTokens: [/arkoselabs/i, /funcaptcha/i, /arkose/i],
    },
    {
        id: 'perimeterx-human',
        engine: 'PerimeterX',
        hint: 'PerimeterX is asking the visitor to press and hold, which automation must not attempt',
        widgetTokens: [/px-captcha/i, /perimeterx/i, /press (and|&) hold/i],
    },
]);
/**
 * Wording a challenge page puts in its TITLE, with no vendor to attribute it to.
 * A title is short and authored by the interceptor, so a match here is safe on
 * its own. Kept combinatorial ("verification" + "human/safety/…") rather than
 * one phrase per language, so a reworded page still matches without a new
 * signature.
 */
export const WORDING_TITLE = Object.freeze([
    /verify (you are|you're|that you are) (a )?human|are you a robot/i,
    /人机验证|验证您(是|为)人类|真人验证|安全验证|身份验证|访客验证/,
    /(滑块|拼图)(验证|校验)/,
]);
/**
 * Wording a challenge page puts on a CONTROL (a button, a link, an input).
 * Command forms only: a help page that explains captchas says "验证码说明",
 * a challenge says "请输入验证码". The bare word for captcha is deliberately NOT
 * here — it is gated on a control role in {@link CAPTCHA_ROLES} instead, so a
 * link to the documentation cannot fire this tier.
 */
export const WORDING_COMMAND = Object.freeze([
    /(请|点击|输入|拖动|按住|滑动|完成|进行|通过)[^。！？]{0,8}(验证|校验|拼图|滑块)/,
    /(验证|校验)(您|你)(是|为)/,
    /(是|为)(真人|人类)(吗|？|\?)?$/,
    /(拖动|按住|滑动)[^。！？]{0,8}(滑块|拼图)/,
    /(verify|click|press|complete|solve|check|confirm)[^.!?]{0,24}(human|robot|browser|captcha|challenge|you are)/i,
    /i'?m not a robot|not a robot/i,
]);
/**
 * Controls that mention verification but are NOT a bot wall: sending yourself a
 * code is an ordinary sign-in step, and labelling it an anti-bot challenge
 * would send the user looking for a wall that is not there.
 */
export const WORDING_EXCLUDE = Object.freeze([
    /(获取|发送|重新获取|重新发送|接收)[^。！？]{0,4}(验证码|校验码|短信码)/,
    /send (the )?(code|sms)|resend/i,
]);
/** The word for "captcha" itself; only counts on a {@link CAPTCHA_ROLES} node. */
export const CAPTCHA_WORD = /captcha|验证码/i;
/**
 * Roles that make {@link CAPTCHA_WORD} count. A captcha input, image or button
 * is a challenge; a link or heading named "验证码说明" is documentation, and
 * firing on it would send the user chasing a wall that is not there.
 */
export const CAPTCHA_ROLES = new Set([
    'textbox',
    'searchbox',
    'combobox',
    'spinbutton',
    'button',
    'checkbox',
    'radio',
    'slider',
    'img',
    'image',
    'iframe',
    'figure',
]);
