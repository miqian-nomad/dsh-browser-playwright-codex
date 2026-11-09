import type { Page } from 'playwright-core';
/**
 * 生成注册进 `addInitScript` 的脚本全文。
 *
 * 必须用**字符串拼接**把资产塞进去，不能用模板字符串：资产里有大量反引号和
 * `${...}`，放进外层模板字符串会被当成插值直接炸掉。
 * 每次现读资产：和 playSwarm 里 `readScript()` 一样，改完磁盘立即用新的，不缓存。
 */
export declare function swarmBootScript(): string;
/** 导航前打标记：下一次文档创建时，addInitScript 会把原版引擎提前启动。 */
export declare function armCurtain(page: Page): Promise<void>;
/** 清掉导航标记（导航失败时别让它留到下一次普通跳转）。 */
export declare function clearCurtainToken(page: Page): Promise<void>;
/**
 * 决定"这一页不播"时：把可能已经提前启动的引擎彻底关掉。
 *
 * 这层原是"撤掉自造白幕"，现在没有白幕了 —— 引擎是真的、会一直等放行，所以必须
 * 调它自己的 stop(false)、把宿主立刻摘掉、把滚动还原，否则那一页会永远盖着白。
 * 触发场景：遮罩页不播、CSP 把影子树样式表挡成半成品、oncePerSite 判定跳过、
 * 用户关掉特效等。顺手把标记和几个开关清干净，免得同文档内 toggle/replay 被旧值影响。
 */
export declare function dropCurtain(page: Page, _waitForSwarm?: boolean): Promise<void>;
