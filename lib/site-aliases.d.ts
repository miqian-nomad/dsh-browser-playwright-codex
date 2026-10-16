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
/**
 * A short Chinese explanation of what a domain is, or undefined when we do not know.
 * @param domain - registrable domain, e.g. `jinritemai.com`.
 * @returns the explanation, or undefined (never a guess).
 */
export declare function siteAlias(domain: string): string | undefined;
/** How many domains this table explains — used by tests and docs to stay honest about coverage. */
export declare const ALIAS_COUNT: number;
