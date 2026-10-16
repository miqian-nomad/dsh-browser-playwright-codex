/**
 * 「这个域名是什么」的中文对照表。
 *
 * 用户原话："我都不知道我登的这些是什么" —— 光看 `a-mo.net`、`jdh.com`、`51epei.com` 确实认不出来。
 * 两条来源，按可靠性排序：
 *   1. **网页自己的标题**（浏览器/密码管理器的做法）—— 网站自己报的名字，不会过期；由 provider 提供，
 *      但只在那个域当前开着页面时才有。
 *   2. **这份对照表** —— 离线、可测、覆盖常见的国内服务与大厂域名；它**会被时代淘汰**，所以只在
 *      标题缺失时兜底，而且宁可留空也不瞎猜（认不出的就一直显示域名本身）。
 *
 * 顺手一个副作用：广告/统计类域名在这里被标出来（`（广告）`/`（统计）`），这本身就是一条提示 ——
 * 它出现在"像登录态"里通常意味着判据被数据相似性骗了。
 * @module dsh-browser-playwright-codex/site-aliases
 */

/** Curated domain → 中文说明. Keys are registrable domains. */
const ALIASES: Readonly<Record<string, string>> = {
  // ── 国内平台与大厂 ──────────────────────────────────────────────────────────
  'jinritemai.com': '巨量千川（抖音电商广告后台）',
  'chaoxing.com': '超星学习通（网课平台）',
  'douyin.com': '抖音',
  'doubao.com': '豆包（字节的 AI 助手）',
  'toutiao.com': '今日头条',
  'volcengine.com': '火山引擎（字节云服务）',
  'feishu.cn': '飞书',
  'larksuite.com': '飞书（国际版）',
  'juejin.cn': '掘金（开发者社区）',
  'qianwen.com': '通义千问（阿里的 AI 助手）',
  'qianwenai.com': '通义千问（阿里的 AI 助手）',
  'baidu.com': '百度',
  'taobao.com': '淘宝',
  'tmall.com': '天猫',
  'goofish.com': '闲鱼（二手交易）',
  'yangkeduo.com': '拼多多',
  'kuaishou.com': '快手',
  'deepseek.com': 'DeepSeek（深度求索）',
  '51epei.com': '易陪（陪练/服务预约平台）',

  // ── 京东系（同一家公司的多个域，所以很多行都是它）────────────────────────────
  'jd.com': '京东',
  'jingdong.com': '京东（旧域名）',
  'jd.hk': '京东香港',
  'jddj.com': '京东到家',
  'jdpay.com': '京东支付',
  'jcloud.com': '京东云',
  'jdcloud.com': '京东云',
  'jdbusiness.com': '京东企业购',
  'jdindustry.com': '京东工业',
  'jdl.cn': '京东物流',
  'jdl.com': '京东物流',
  'jdwl.com': '京东物流',
  'healthjd.com': '京东健康',
  'jingdonghealth.cn': '京东健康',
  '7fresh.com': '七鲜（京东生鲜超市）',
  'baitiao.com': '京东白条',
  'jingxi.com': '京喜',
  'jhscm.com': '京东供应链相关域名',
  'jingxiaoling.com': '京东相关服务域名',
  'joyai.com': '京东相关服务域名',
  'five-star.cn': '京东五星电器',

  // ── 国外服务 ────────────────────────────────────────────────────────────────
  'github.com': 'GitHub（代码托管）',
  'bing.com': '必应（微软搜索）',
  'live.com': '微软账号（Outlook 等）',
  'microsoftonline.com': '微软企业账号登录',
  'meta.com': 'Meta（Facebook 母公司）',
  'facebook.com': 'Facebook',
  'muse.ai': 'Muse AI（视频/素材工具）',
  'openrouter.ai': 'OpenRouter（AI 模型聚合服务）',
  'fearlessrevolution.com': 'FearlessRevolution（游戏修改器社区）',

  // ── 广告 / 统计 / 追踪（标出来本身就是提示：它们不该算"你登录过的站"）──────────
  'a-mo.net': '阿里妈妈（广告投放域名）',
  'a-mx.com': '阿里妈妈（广告投放域名）',
  'adroll.com': 'AdRoll（广告再营销，广告）',
  'mmstat.com': '阿里统计（统计）',
  'pubmatic.com': 'PubMatic（广告交易平台，广告）',
  'criteo.com': 'Criteo（广告再营销，广告）',
  'adnxs.com': 'Xandr/AppNexus（广告交易平台，广告）',
  'rubiconproject.com': 'Magnite（广告交易平台，广告）',
  'casalemedia.com': 'Index Exchange（广告交易平台，广告）',
  'scorecardresearch.com': 'Comscore（受众统计，统计）',
  'adsrvr.org': 'The Trade Desk（广告投放，广告）',
  'taboola.com': 'Taboola（内容推荐广告，广告）',
  'outbrain.com': 'Outbrain（内容推荐广告，广告）',
  'umeng.com': '友盟（移动统计，统计）',
  'umengcloud.com': '友盟（移动统计，统计）',
  'doubleclick.net': 'Google 广告（广告）',
  'google-analytics.com': 'Google Analytics（统计）',
  'googletagmanager.com': 'Google Tag Manager（统计）',
  'cnzz.com': 'CNZZ 站长统计（统计）',
  'clarity.ms': 'Microsoft Clarity（行为统计，统计）',
  'hotjar.com': 'Hotjar（行为统计，统计）',
  'sentry.io': 'Sentry（错误监控）',
  sajssdk: '神策数据（统计）',
  sensorsdata: '神策数据（统计）',
}

/**
 * A short Chinese explanation of what a domain is, or undefined when we do not know.
 * @param domain - registrable domain, e.g. `jinritemai.com`.
 * @returns the explanation, or undefined (never a guess).
 */
export function siteAlias(domain: string): string | undefined {
  const key = domain.trim().replace(/^\./, '').toLowerCase()
  return ALIASES[key]
}

/** How many domains this table explains — used by tests and docs to stay honest about coverage. */
export const ALIAS_COUNT = Object.keys(ALIASES).length
