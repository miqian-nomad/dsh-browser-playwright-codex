import { isAbortError } from './page-diagnostics.ts';
/**
 * 让一个可能挂住的 Promise 同时响应「到点」和「取消」。
 *
 * - 到点：抛 `ACTION_TIMEOUT`，消息里带上限和这一步在做什么，模型/用户能看懂。
 * - 取消：原样抛 `AbortError`，和工具层其它取消行为一致。
 * - 原始 Promise 无论多晚才 settle，都不会变成未捕获的 rejection（和 withAbort 同规矩）。
 *
 * @param promise - 可能挂住的调用
 * @param timeoutMs - 硬期限（毫秒），应来自部署配置，且已校验有下限
 * @param label - 超时消息里说明卡在哪一步
 * @param signal - 可选的取消信号
 */
export declare function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal, onTimeout?: 'reject' | 'resolve-undefined'): Promise<T | undefined>;
/** 这个错误是不是「读内容超时」——调用方据此作废会话句柄，让下次自愈。 */
export declare function isReadTimeout(error: unknown): boolean;
/** 取消错误保持原样传递（不多包一层）。 */
export { isAbortError };
