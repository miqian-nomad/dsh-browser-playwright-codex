/**
 * 给「读页面内容」这类**可能永远不返回**的调用加一道硬期限。
 *
 * 为什么需要它：Playwright 的 `page.evaluate` / `ariaSnapshot` 没有 timeout 参数。
 * 页面脚本一旦占住主线程（着色器编译、同步重绘循环、死循环），这些调用会一直
 * 挂着，工具调用、甚至整个对话就卡死在那里（GitHub issue #5：报告人卡了 12 分钟）。
 * `withAbort` 只解决了「用户按取消」，没有「到点自己断」；而且取消信号也不会被
 * 传进读内容那一步。这里把**硬期限 + 取消**合成一个包装。
 *
 * 注意：超时只能让我们这一侧返回，底层那个 evaluate 仍在浏览器里跑（Playwright
 * 不提供取消它的办法）。所以调用方在超时后要作废会话句柄，让下一次调用别继承
 * 这个卡住的页面；页面自己恢复后浏览器照常可用，不需要杀进程。
 *
 * @module dsh-browser-playwright-codex/read-deadline
 */
import { BrowserError } from "./errors.js";
import { isAbortError } from "./page-diagnostics.js";
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
export async function withDeadline(promise, timeoutMs, label, signal, onTimeout = 'reject') {
    const guarded = Promise.resolve(promise);
    guarded.catch(() => { }); // 超时后原调用仍在跑：别让它的 rejection 冒到宿主
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (act) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            act();
        };
        const onAbort = () => finish(() => reject(new DOMException('The operation was aborted', 'AbortError')));
        const timer = setTimeout(() => {
            if (onTimeout === 'resolve-undefined') {
                finish(() => resolve(undefined));
                return;
            }
            finish(() => reject(new BrowserError('ACTION_TIMEOUT', '[ACTION_TIMEOUT] ' +
                label +
                ' did not finish within ' +
                String(timeoutMs) +
                'ms; the page may be stuck running script. The next browser call reopens the session.')));
        }, timeoutMs);
        // 不要 unref：期限是「到点必须断」的承诺，unref 之后若这是进程里最后一个句柄，
        // 事件循环会判定无事可做直接退出，调用方永远等不到这条 ACTION_TIMEOUT
        // （tests/read-deadline.test.ts 就是这么被打成 cancelledByParent 的）。
        if (signal !== undefined && typeof signal.addEventListener === 'function') {
            if (signal.aborted)
                onAbort();
            else
                signal.addEventListener('abort', onAbort, { once: true });
        }
        guarded.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    });
}
/** 这个错误是不是「读内容超时」——调用方据此作废会话句柄，让下次自愈。 */
export function isReadTimeout(error) {
    return error instanceof BrowserError && error.code === 'ACTION_TIMEOUT';
}
/** 取消错误保持原样传递（不多包一层）。 */
export { isAbortError };
