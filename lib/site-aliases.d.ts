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
/**
 * A short Chinese explanation of what a domain is, or undefined when we do not know.
 * @param domain - registrable domain, e.g. `jinritemai.com`.
 * @returns the explanation, or undefined (never a guess).
 */
export declare function siteAlias(domain: string): string | undefined;
/**
 * Which company a domain belongs to, for collapsing sibling domains into one row.
 * @param domain - registrable domain.
 * @returns the group key and its 中文 label, or undefined when the domain is not part of a group.
 */
export declare function siteGroup(domain: string): {
    key: string;
    label: string;
} | undefined;
/** How many domains this table explains — tests and docs use it to stay honest about coverage. */
export declare const ALIAS_COUNT: number;
