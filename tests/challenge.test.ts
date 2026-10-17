/**
 * 挑战页识别与「无进展」兜底：分层判定的正例，以及必须不触发的反例。
 *
 * 反例和正例一样重要：这一层的作用是让模型在撞墙时停下来问人，误判的代价是
 * 让用户去找一面不存在的墙。所以普通页面、讲验证码的帮助页、以及「获取验证码」
 * 这种正常登录控件都在下面钉住了。
 * @module dsh-browser-playwright-codex/tests/challenge
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHALLENGE_NOTE,
  NO_PROGRESS_MAX_REFS,
  NO_PROGRESS_NOTE,
  detectChallenge,
  detectNoProgress,
  detectSilentPage,
  snapshotFingerprint,
} from '../src/challenge.ts'
import { CHALLENGE_SIGNATURES, WIDGET_CORROBORATION } from '../src/challenge-signatures.ts'
import { snapshotValue } from '../src/tool-render.ts'
import type { ChallengeNode } from '../src/tool-types.ts'
import type { BrowserSnapshot } from '../src/types.ts'

/** One accessible node, the only shape the detector reads. */
const node = (role: string, name: string, children: ChallengeNode[] = []): ChallengeNode => ({
  role,
  name,
  children,
})

/** A response as Playwright reports it: header names lowercased. */
const response = (headers: Record<string, string>, status = 403) => ({
  status,
  url: 'https://example.test/',
  headers,
})

// --- tier 1: the vendor's own response metadata -----------------------------

test('cf-mitigated: challenge is reported as Cloudflare at the header tier', () => {
  const found = detectChallenge({ title: 'Example', nodes: [], response: response({ 'cf-mitigated': 'challenge' }) })
  assert.equal(found?.engine, 'Cloudflare')
  assert.equal(found?.tier, 'response-header')
  assert.match(String(found?.evidence), /cf-mitigated/)
})

test('header matching is case-insensitive on both name and value', () => {
  const found = detectChallenge({ nodes: [], response: response({ 'CF-Mitigated': 'Challenge' }) })
  assert.equal(found?.engine, 'Cloudflare')
})

test('cf-mitigated with any other value is not a challenge page', () => {
  // Cloudflare documents `challenge` as the only valid value; a future value
  // must not be silently treated as one.
  const found = detectChallenge({ nodes: [], response: response({ 'cf-mitigated': 'managed' }) })
  assert.equal(found, null)
})

test('AWS WAF challenge action is detected from its documented header', () => {
  const found = detectChallenge({ nodes: [], response: response({ 'x-amzn-waf-action': 'challenge' }) })
  assert.equal(found?.engine, 'AWS WAF')
  assert.equal(found?.tier, 'response-header')
})

test('Imperva X-IInfo counts on presence, once the status agrees', () => {
  const found = detectChallenge({ nodes: [], response: response({ 'x-iinfo': '9-12345-12346 PNNN' }) })
  assert.equal(found?.engine, 'Imperva')
})

test('DataDome is matched by header-name prefix, not one exact name', () => {
  const found = detectChallenge({ nodes: [], response: response({ 'x-datadome-cid': 'abc' }) })
  assert.equal(found?.engine, 'DataDome')
})

test('DataDome and Imperva need a blocking status, because their headers ride every response', () => {
  // Measured 2026-10-17: a normal DataDome-fronted page (g2.com was blocked, but
  // their docs state the headers are always attached, `NA` when detection is off)
  // and Imperva's `x-iinfo` is on everything it fronts. Reporting a wall from the
  // header alone would fire on perfectly usable pages.
  assert.equal(detectChallenge({ nodes: [], response: response({ 'x-iinfo': '9-1-2 PNNN' }, 200) }), null)
  assert.equal(detectChallenge({ nodes: [], response: response({ 'x-datadome': 'protected' }, 200) }), null)
  // A real block still is one.
  assert.equal(
    detectChallenge({ nodes: [], response: response({ 'x-datadome': 'protected' }, 403) })?.engine,
    'DataDome',
  )
  assert.equal(detectChallenge({ nodes: [], response: response({ 'x-iinfo': 'x' }, 503) })?.engine, 'Imperva')
})

test('header evidence is preferred over wording when both are present', () => {
  const found = detectChallenge({
    title: '安全验证',
    nodes: [node('button', '点击验证')],
    response: response({ 'cf-mitigated': 'challenge' }),
  })
  assert.equal(found?.tier, 'response-header')
})

test('no response metadata falls through to the lower tiers instead of throwing', () => {
  assert.equal(detectChallenge({ title: 'Example', nodes: [] }), null)
})

// --- tier 2: the vendor's own widget ---------------------------------------

test('a Turnstile iframe is recognised by its accessible title', () => {
  const found = detectChallenge({ nodes: [node('iframe', 'Widget containing a Cloudflare security challenge')] })
  assert.equal(found?.engine, 'Cloudflare')
  assert.equal(found?.tier, 'widget')
})

test('a reCAPTCHA iframe is recognised', () => {
  const found = detectChallenge({ nodes: [node('iframe', 'reCAPTCHA')] })
  assert.equal(found?.engine, 'captcha')
  assert.equal(found?.tier, 'widget')
})

test('a real hCaptcha widget is found even when it is nested below the shallow scan', () => {
  // Measured 2026-10-17 on nopecha.com/demo/hcaptcha: the widget's iframe carries
  // the localized name "包含 hCaptcha 安全挑战复选框的小部件" and sits deeper than the
  // three levels the wording tiers read. With the old depth-2 scan the detector
  // reported NO MATCH on a page that really had an hCaptcha widget on it.
  const deep = node('generic', '', [
    node('generic', '', [node('generic', '', [node('iframe', '包含 hCaptcha 安全挑战复选框的小部件')])]),
  ])
  const found = detectChallenge({ title: 'NopeCHA - hCaptcha Demo', nodes: [deep] })
  assert.equal(found?.engine, 'captcha')
  assert.equal(found?.tier, 'widget')
})

test('a real captcha iframe is still recognised on a busy login page', () => {
  // Regression: a refs ceiling on this tier used to suppress a genuine reCAPTCHA
  // simply because the login page around it had links. Busy pages embed captchas too.
  const nodes = [
    node('iframe', 'reCAPTCHA'),
    ...Array.from({ length: 20 }, (_, index) => node('link', '链接' + String(index))),
  ]
  assert.equal(detectChallenge({ nodes, refs: 21 })?.tier, 'widget')
})

test('a non-vendor iframe that is named 验证码 is still a challenge', () => {
  // Removing `iframe` from the captcha-control roles once made these invisible.
  assert.equal(detectChallenge({ nodes: [node('iframe', '验证码')], refs: 0 })?.tier, 'wording')
})

test('a vendor name on an ordinary node does not corroborate itself', () => {
  // "reCAPTCHA" contains "captcha"; if a token could corroborate itself this
  // guard would be vacuous, and every blog post about captchas would fire.
  const found = detectChallenge({
    title: 'How reCAPTCHA works',
    nodes: [node('heading', 'reCAPTCHA'), node('paragraph', 'A guide for developers')],
  })
  assert.equal(found, null)
})

test('a vendor word on an ordinary node does not fire, but a real verification control still does', () => {
  // Regression guard: the deep widget scan must not turn an article that names a
  // vendor into a wall. The heading alone is not enough — the actual "verify you
  // are human" control is, and that is the wording tier's job.
  const articleOnly = detectChallenge({
    title: 'How hCaptcha works',
    nodes: [node('heading', 'How hCaptcha works')],
    refs: 40,
  })
  assert.equal(articleOnly, null)
  const withControl = detectChallenge({
    nodes: [node('heading', 'reCAPTCHA'), node('button', 'Verify you are human')],
  })
  assert.equal(withControl?.tier, 'wording')
})

// --- tier 3: wording -------------------------------------------------------

test('a Chinese verification title is detected without any English token', () => {
  // The case the previous detector missed: 百度-style "安全验证".
  const found = detectChallenge({ title: '安全验证', nodes: [], refs: 0 })
  assert.equal(found?.engine, 'human-verification')
  assert.equal(found?.tier, 'wording')
})

test('the real 百度 安全验证 page fires, and its measurements are what the gate assumes', () => {
  // Captured 2026-10-17 from https://wappass.baidu.com/static/captcha/tuxing.html:
  // title "百度安全验证", zero actionable elements, and no vendor header at all —
  // which is why the wording tier is the only thing that can catch it.
  const found = detectChallenge({
    title: '百度安全验证',
    url: 'https://wappass.baidu.com/static/captcha/tuxing.html',
    nodes: [],
    refs: 0,
  })
  assert.equal(found?.engine, 'human-verification')
  assert.equal(found?.tier, 'wording')
})

test('a Baidu SEARCH page titled 安全验证_百度搜索 is not a challenge', () => {
  // Real false positive, captured 2026-10-17: searching 百度 for "安全验证" gives a
  // normal results page with 57 actionable elements whose title still contains the
  // phrase. This is the query a person investigating captchas types, so the title
  // tier must not fire on it.
  const found = detectChallenge({ title: '安全验证_百度搜索', nodes: [], refs: 57 })
  assert.equal(found, null)
  // Same for the slider wording (81 refs measured on the real page).
  assert.equal(detectChallenge({ title: '滑块验证_百度搜索', nodes: [], refs: 81 }), null)
})

test('the same title still fires when the page really has nothing to click', () => {
  // The gate is about the page being unusable, not about the exact title: a wall
  // with a couple of controls is still a wall.
  const found = detectChallenge({ title: '百度安全验证', nodes: [], refs: 3 })
  assert.equal(found?.tier, 'wording')
})

test('a captcha input is detected by role, not only by wording', () => {
  const found = detectChallenge({ nodes: [node('textbox', '验证码')] })
  assert.equal(found?.tier, 'wording')
})

test('a slider instruction on a button is detected', () => {
  const found = detectChallenge({ nodes: [node('button', '拖动滑块完成拼图')] })
  assert.equal(found?.tier, 'wording')
})

test('a documentation link mentioning captchas is NOT a challenge', () => {
  // Same words, wrong surface: this is the false positive that would send a
  // user looking for a wall that is not there.
  const found = detectChallenge({ title: '帮助中心', nodes: [node('link', '验证码说明')] })
  assert.equal(found, null)
})

test('a link telling you to obtain a captcha is not a challenge either', () => {
  const found = detectChallenge({ nodes: [node('link', '获取验证码')] })
  assert.equal(found, null)
})

test('a captcha delivery button is excluded even though it matches the command pattern', () => {
  // "获取/发送验证码" is an ordinary sign-in step, not a bot wall.
  const found = detectChallenge({ title: '登录', nodes: [node('button', '发送验证码')] })
  assert.equal(found, null)
})

test('long prose that merely mentions verification does not fire', () => {
  const prose = '请输入验证码以完成本次操作，若无法看到图片请点击刷新或更换浏览器后重试，谢谢配合。'
  assert.ok(prose.length > 32)
  const found = detectChallenge({ title: '公告', nodes: [node('paragraph', prose)] })
  assert.equal(found, null)
})

test('an ordinary page matches nothing', () => {
  const found = detectChallenge({
    title: '示例站点',
    url: 'https://example.test/search',
    nodes: [node('heading', '新闻'), node('textbox', '搜索'), node('button', '搜索'), node('link', '登录')],
    response: response({ 'content-type': 'text/html' }, 200),
  })
  assert.equal(found, null)
})

test('the word 安全 alone in a heading is not a verification page', () => {
  const found = detectChallenge({ title: '安全中心', nodes: [node('heading', '安全管理')] })
  assert.equal(found, null)
})

test('a Cloudflare interstitial title is attributed to Cloudflare, not to wording', () => {
  const found = detectChallenge({ title: 'Just a moment...', refs: 0 })
  assert.equal(found?.engine, 'Cloudflare')
  assert.equal(found?.tier, 'wording')
})

// --- the note itself -------------------------------------------------------

test('the challenge note tells the model not to retry blindly', () => {
  assert.match(CHALLENGE_NOTE, /NOT solvable by automation/)
  assert.match(CHALLENGE_NOTE, /browser_snapshot/)
})

// --- the signature table ---------------------------------------------------

test('every signature carries an id, an engine and a hint', () => {
  const ids = new Set<string>()
  for (const signature of CHALLENGE_SIGNATURES) {
    assert.ok(signature.id.length > 0)
    assert.ok(signature.engine.length > 0)
    assert.ok(signature.hint.length > 0)
    assert.ok(!ids.has(signature.id), 'duplicate signature id ' + signature.id)
    ids.add(signature.id)
    // A signature nobody can act on is dead weight: it must be provable.
    const provable =
      (signature.headers ?? []).length > 0 ||
      (signature.headerPrefixes ?? []).length > 0 ||
      (signature.widgetTokens ?? []).length > 0 ||
      (signature.titleWording ?? []).length > 0
    assert.ok(provable, signature.id + ' has no way to fire')
  }
})

test('the shared corroboration list cannot be satisfied by a vendor name itself', () => {
  // Three widget tokens literally contain the word "captcha". If the shared
  // list accepted it, finding a vendor's name would corroborate finding that
  // vendor's name, and tier 2 would fire on any page that discusses the vendor.
  for (const word of ['reCAPTCHA', 'hCaptcha', 'FunCaptcha', 'px-captcha', 'Arkose', 'DataDome']) {
    const selfCorroborating = WIDGET_CORROBORATION.some((pattern) => pattern.test(word))
    assert.ok(!selfCorroborating, word + ' corroborates itself')
  }
})

// --- tier 4: the no-progress backstop --------------------------------------

test('the backstop stays silent on a read-only capture', () => {
  assert.equal(detectNoProgress({ afterAction: false, unchangedStreak: 3, refs: 1 }), null)
})

test('the backstop stays silent when the page changed', () => {
  assert.equal(detectNoProgress({ afterAction: true, unchangedStreak: 0, refs: 1 }), null)
})

test('the backstop fires after an action that changed a nearly empty page', () => {
  const note = detectNoProgress({ afterAction: true, unchangedStreak: 1, refs: 2 })
  assert.ok(note !== null)
  assert.match(note, /no visible change/)
  // It must say it is a guess: this tier is for walls we cannot identify.
  assert.match(note, /guess, not a diagnosis/)
})

test('the backstop stays silent on a rich page after one unchanged action', () => {
  // Clicking something that legitimately changes nothing is normal on a real page.
  assert.equal(detectNoProgress({ afterAction: true, unchangedStreak: 1, refs: 40 }), null)
})

test('the backstop fires on a rich page only after two identical results', () => {
  const note = detectNoProgress({ afterAction: true, unchangedStreak: 2, refs: 40 })
  assert.ok(note !== null)
})

test('the ref threshold is the documented one', () => {
  assert.equal(NO_PROGRESS_MAX_REFS, 3)
  assert.ok(detectNoProgress({ afterAction: true, unchangedStreak: 1, refs: NO_PROGRESS_MAX_REFS }) !== null)
  assert.equal(detectNoProgress({ afterAction: true, unchangedStreak: 1, refs: NO_PROGRESS_MAX_REFS + 1 }), null)
})

// --- what the model actually reads -----------------------------------------

test('the rendered result does not stack the backstop on top of a recognised challenge', () => {
  const snapshot: BrowserSnapshot = {
    url: 'https://example.test/',
    title: '安全验证',
    nodes: [],
    totalRefs: 1,
    truncated: false,
    stallNote: NO_PROGRESS_NOTE,
  }
  const tree = snapshotValue(snapshot).tree
  assert.match(tree, /human-verification/)
  // "This is a wall, here is why" is the actionable message; a second, vaguer
  // warning on top of it only spends prompt budget on a case already decided.
  assert.ok(!tree.includes('no visible change'), 'the backstop must stay out of a decided result')
})

test('the backstop is rendered when nothing else identified the page', () => {
  const snapshot: BrowserSnapshot = {
    url: 'https://example.test/',
    title: '请稍等',
    nodes: [],
    totalRefs: 1,
    truncated: false,
    stallNote: NO_PROGRESS_NOTE,
  }
  assert.match(snapshotValue(snapshot).tree, /no visible change/)
})

test('a non-2xx status is surfaced to the model, a 200 is not', () => {
  // Measured 2026-10-17 on a real MDN 404: status 404, 35 refs, and the rendered
  // result said nothing about it, so an error page looked like a normal page.
  const base: BrowserSnapshot = {
    url: 'https://example.test/missing',
    title: 'Page not found',
    nodes: [],
    totalRefs: 35,
    truncated: false,
  }
  const missing = snapshotValue({
    ...base,
    response: { status: 404, url: base.url, headers: {} },
  }).tree
  assert.match(missing, /\[http 404\]/)
  const ok = snapshotValue({ ...base, response: { status: 200, url: base.url, headers: {} } }).tree
  assert.ok(!ok.includes('[http '), 'a 200 must not add a status line')
})

test('a 403 already identified as a challenge does not also get the status line', () => {
  const tree = snapshotValue({
    url: 'https://example.test/',
    title: '安全验证',
    nodes: [],
    totalRefs: 1,
    truncated: false,
    response: { status: 403, url: 'https://example.test/', headers: {} },
  }).tree
  assert.match(tree, /human-verification/)
  assert.ok(!tree.includes('[http 403]'), 'one reason is enough')
})

test('the silent-page note never lands on a snapshot that is blocked by a dialog', () => {
  // A parked dialog gives title='', nodes=[], refs=0 — the exact shape the silent
  // check looks for — but the page is fine; the dialog is the blocker.
  const tree = snapshotValue({
    url: 'https://example.test/',
    title: '',
    nodes: [],
    totalRefs: 0,
    truncated: false,
    dialogNote: '[dialog] confirm "确定删除吗？" is pending',
  }).tree
  assert.match(tree, /\[dialog\]/)
  assert.ok(!tree.includes('[nothing here]'), 'the dialog note and the silent note contradict each other')
})

test('refs that were never reported fail closed: the title tier stays off', () => {
  // Passing a BrowserSnapshot (which has totalRefs, not refs) used to open the gate
  // silently, which is how the 百度 "安全验证_百度搜索" false positive came back.
  assert.equal(detectChallenge({ title: '安全验证_百度搜索', nodes: [] }), null)
  assert.equal(detectChallenge({ title: '安全验证_百度搜索', nodes: [], refs: 86 }), null)
})

// --- the silent page: nothing to click, nothing to read --------------------

test('a page with nothing to click and nothing to read gets the silent-page note', () => {
  // Measured 2026-10-17 on 微博's visitor gate: 364 characters of "URL / Title /
  // Refs: 0 / (no visible elements)" and no explanation at all.
  const note = detectSilentPage({ refs: 0, nodes: [] })
  assert.ok(note !== null)
  assert.match(note, /nothing here/)
})

test('an article that happens to have no links is not a silent page', () => {
  // One heading plus one paragraph is a normal (if sparse) page, not a wall.
  const nodes = [node('heading', '标题'), node('paragraph', '一段正文')]
  assert.equal(detectSilentPage({ refs: 0, nodes }), null)
  const six = Array.from({ length: 6 }, (_, index) => node('paragraph', '第 ' + String(index) + ' 段正文'))
  assert.equal(detectSilentPage({ refs: 0, nodes: six }), null)
})

test('a page with controls is never silent', () => {
  assert.equal(detectSilentPage({ refs: 3, nodes: [] }), null)
})

test('the rendered snapshot carries the silent-page note', () => {
  const tree = snapshotValue({
    url: 'https://passport.weibo.com/visitor/visitor?entry=miniblog',
    title: 'Sina Visitor System',
    nodes: [],
    totalRefs: 0,
    truncated: false,
  }).tree
  assert.match(tree, /nothing here/)
})

// --- page-state fingerprint ------------------------------------------------

test('the fingerprint is stable for the same page state', () => {
  const input = { url: 'https://example.test/', title: 'Example', refs: 2, nodes: [node('button', '确定')] }
  assert.equal(snapshotFingerprint(input), snapshotFingerprint({ ...input }))
})

test('the fingerprint changes when the title, the refs or a label change', () => {
  const base = { url: 'https://example.test/', title: 'Example', refs: 2, nodes: [node('button', '确定')] }
  const hash = snapshotFingerprint(base)
  assert.notEqual(snapshotFingerprint({ ...base, title: 'Other' }), hash)
  assert.notEqual(snapshotFingerprint({ ...base, refs: 3 }), hash)
  assert.notEqual(snapshotFingerprint({ ...base, nodes: [node('button', '取消')] }), hash)
  assert.notEqual(snapshotFingerprint({ ...base, url: 'https://example.test/next' }), hash)
})
