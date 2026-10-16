/**
 * 域名对照表（升级版）：每个域名一条「说明 + 归属公司」，卡片按公司折叠成一行。
 *
 * 用户的原话："这种一个类型的肯定要放一起啊" —— 京东系二十来个域各自占一行，小半屏都是它，
 * 既看不出重点、也找不到别的站。所以这份表不只回答"这是什么"，还回答"它属于谁"。
 *
 * 两条来源，按可靠性排序：
 *   1. **网页自己的标题**（浏览器/密码管理器的做法）：网站自己报的名字，不出网、不会过期；
 *      由 provider 提供，只在那个域当前开着页面时才有。
 *   2. **这份表**：离线、可测、覆盖常见的国内服务与大厂；**会被时代淘汰**，所以只在标题缺失时兜底，
 *      而且**宁可留空也不瞎猜**（认不出的就显示域名本身，也没有归属）。
 *
 * 附带的好处：广告/统计类域名在表里被标出来，而且**整族归到"广告/统计平台"一组** —— 它们成片出现在
 * "像登录态"里，本身就是判据被数据相似性骗了的信号。
 * @module dsh-browser-playwright-codex/site-aliases
 */
/** Group key → 折叠行显示的中文名. */
const GROUP_LABELS = {
    jd: '京东系',
    alibaba: '阿里系',
    bytedance: '字节系',
    microsoft: '微软系',
    meta: 'Meta 系',
    google: 'Google 系',
    ads: '广告 / 统计平台',
    tencent: '腾讯系',
    netease: '网易系',
};
/** Domain → what it is and who owns it. Keys are registrable domains. */
const SITES = {
    // ── 京东系（真实名单里占了二十来个域，所以单独成组）──────────────────────────
    'jd.com': { name: '京东', group: 'jd' },
    'jingdong.com': { name: '京东（旧域名）', group: 'jd' },
    'jd.hk': { name: '京东香港', group: 'jd' },
    'jddj.com': { name: '京东到家', group: 'jd' },
    'jdpay.com': { name: '京东支付', group: 'jd' },
    'jcloud.com': { name: '京东云', group: 'jd' },
    'jdcloud.com': { name: '京东云', group: 'jd' },
    'jdbusiness.com': { name: '京东企业购', group: 'jd' },
    'jdindustry.com': { name: '京东工业', group: 'jd' },
    'jdl.cn': { name: '京东物流', group: 'jd' },
    'jdl.com': { name: '京东物流', group: 'jd' },
    'jdwl.com': { name: '京东物流', group: 'jd' },
    'healthjd.com': { name: '京东健康', group: 'jd' },
    'jingdonghealth.cn': { name: '京东健康', group: 'jd' },
    '7fresh.com': { name: '七鲜（京东生鲜超市）', group: 'jd' },
    'baitiao.com': { name: '京东白条', group: 'jd' },
    'jingxi.com': { name: '京喜', group: 'jd' },
    'five-star.cn': { name: '京东五星电器', group: 'jd' },
    // ── 阿里系 ──────────────────────────────────────────────────────────────────
    'taobao.com': { name: '淘宝', group: 'alibaba' },
    'tmall.com': { name: '天猫', group: 'alibaba' },
    'goofish.com': { name: '闲鱼（二手交易）', group: 'alibaba' },
    'qianwen.com': { name: '通义千问（阿里的 AI 助手）', group: 'alibaba' },
    'qianwenai.com': { name: '通义千问（阿里的 AI 助手）', group: 'alibaba' },
    'a-mo.net': { name: '阿里妈妈（广告投放域名）', group: 'alibaba' },
    'a-mx.com': { name: '阿里妈妈（广告投放域名）', group: 'alibaba' },
    'yangkeduo.com': { name: '拼多多', group: 'alibaba' },
    // ── 字节系 ──────────────────────────────────────────────────────────────────
    'douyin.com': { name: '抖音', group: 'bytedance' },
    'doubao.com': { name: '豆包（字节的 AI 助手）', group: 'bytedance' },
    'toutiao.com': { name: '今日头条', group: 'bytedance' },
    'volcengine.com': { name: '火山引擎（字节云服务）', group: 'bytedance' },
    'jinritemai.com': { name: '巨量千川（抖音电商广告后台）', group: 'bytedance' },
    'feishu.cn': { name: '飞书', group: 'bytedance' },
    'larksuite.com': { name: '飞书（国际版）', group: 'bytedance' },
    // ── 其他国内 ────────────────────────────────────────────────────────────────
    'chaoxing.com': { name: '超星学习通（网课平台）' },
    'juejin.cn': { name: '掘金（开发者社区）' },
    'baidu.com': { name: '百度' },
    'kuaishou.com': { name: '快手' },
    'deepseek.com': { name: 'DeepSeek（深度求索）' },
    // ── 微软系 ──────────────────────────────────────────────────────────────────
    'live.com': { name: '微软账号（Outlook 等）', group: 'microsoft' },
    'microsoftonline.com': { name: '微软企业账号登录', group: 'microsoft' },
    'bing.com': { name: '必应（微软搜索）', group: 'microsoft' },
    'clarity.ms': { name: 'Microsoft Clarity（行为统计）', group: 'microsoft' },
    // ── Meta 系 ─────────────────────────────────────────────────────────────────
    'meta.com': { name: 'Meta（Facebook 母公司）', group: 'meta' },
    'facebook.com': { name: 'Facebook', group: 'meta' },
    // ── Google 系 ───────────────────────────────────────────────────────────────
    'doubleclick.net': { name: 'Google 广告', group: 'google' },
    'google-analytics.com': { name: 'Google Analytics（统计）', group: 'google' },
    'googletagmanager.com': { name: 'Google Tag Manager（统计）', group: 'google' },
    // ── 其他国外服务 ────────────────────────────────────────────────────────────
    'github.com': { name: 'GitHub（代码托管）' },
    'openrouter.ai': { name: 'OpenRouter（AI 模型聚合服务）' },
    'fearlessrevolution.com': { name: 'FearlessRevolution（游戏修改器社区）' },
    // ── 广告 / 统计平台（成片出现时就是"判据被骗了"的信号）────────────────────────
    'adroll.com': { name: 'AdRoll（广告再营销）', group: 'ads' },
    'pubmatic.com': { name: 'PubMatic（广告交易平台）', group: 'ads' },
    'criteo.com': { name: 'Criteo（广告再营销）', group: 'ads' },
    'adnxs.com': { name: 'Xandr/AppNexus（广告交易平台）', group: 'ads' },
    'rubiconproject.com': { name: 'Magnite（广告交易平台）', group: 'ads' },
    'casalemedia.com': { name: 'Index Exchange（广告交易平台）', group: 'ads' },
    'scorecardresearch.com': { name: 'Comscore（受众统计）', group: 'ads' },
    'adsrvr.org': { name: 'The Trade Desk（广告投放）', group: 'ads' },
    'taboola.com': { name: 'Taboola（内容推荐广告）', group: 'ads' },
    'outbrain.com': { name: 'Outbrain（内容推荐广告）', group: 'ads' },
    'mmstat.com': { name: '阿里统计', group: 'ads' },
    'umeng.com': { name: '友盟（移动统计）', group: 'ads' },
    'umengcloud.com': { name: '友盟（移动统计）', group: 'ads' },
    'cnzz.com': { name: 'CNZZ 站长统计', group: 'ads' },
    'hotjar.com': { name: 'Hotjar（行为统计）', group: 'ads' },
    'sentry.io': { name: 'Sentry（错误监控）', group: 'ads' },
    sajssdk: { name: '神策数据（统计）', group: 'ads' },
    sensorsdata: { name: '神策数据（统计）', group: 'ads' },
};
/**
 * A short Chinese explanation of what a domain is, or undefined when we do not know.
 * @param domain - registrable domain, e.g. `jinritemai.com`.
 * @returns the explanation, or undefined (never a guess).
 */
export function siteAlias(domain) {
    return SITES[normalize(domain)]?.name;
}
/**
 * Which company a domain belongs to, for collapsing sibling domains into one row.
 * @param domain - registrable domain.
 * @returns the group key and its 中文 label, or undefined when the domain is not part of a group.
 */
export function siteGroup(domain) {
    const key = SITES[normalize(domain)]?.group;
    if (key === undefined)
        return undefined;
    return { key, label: GROUP_LABELS[key] ?? key };
}
/** How many domains this table explains — tests and docs use it to stay honest about coverage. */
export const ALIAS_COUNT = Object.keys(SITES).length;
function normalize(domain) {
    return domain.trim().replace(/^\./, '').toLowerCase();
}
