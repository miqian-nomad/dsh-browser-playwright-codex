/**
 * 挑战页识别与「无进展」兜底。
 *
 * 判定顺序 = 稳定性顺序：先读厂商自己的响应头（他们的公开 API），再看厂商控件的无障碍名，
 * 最后才看文案。三层都不认识的时候不猜厂商，改问一个与厂商无关的问题——「这个动作之后
 * 页面变了吗」。所以新出的验证方式没有签名也能被接住，代价只是多问用户一句。
 * @module dsh-browser-playwright-codex/challenge
 */
import type { ChallengeMatch, ChallengeNode, ChallengeSnapshot } from './tool-types.ts';
/**
 * Detect an anti-bot / human-verification surface from the MAIN document
 * response metadata, the page's accessible names and, as a last resort, its
 * wording. We never try to solve one: the correct move for an agent is to hand
 * it to the human who can see the open window.
 * @param snapshot - title, url, accessible tree and (when available) the main document response.
 * @returns the matched engine with its tier and the concrete evidence, else null.
 */
export declare function detectChallenge(snapshot: ChallengeSnapshot): ChallengeMatch | null;
/**
 * Instruction appended above a snapshot when the page is an anti-bot
 * challenge. The browser window is visible on the user's desktop: the agent
 * should pause and ask the user to complete it by hand, then re-snapshot.
 */
export declare const CHALLENGE_NOTE = "[human verification] The page triggered an anti-bot challenge; it is NOT solvable by automation and must NOT be retried blindly. The browser window is open on the user's desktop \u2014 tell the user a verification appeared, wait for them to finish it (a few seconds), then call browser_snapshot again. The clearance cookie is saved to the profile automatically and keeps working for the session.";
/**
 * Appended after an action that left the page byte-for-byte unchanged on a page
 * with almost nothing else to interact with. Worded as a guess, because that is
 * what it is: it is the shape an unrecognised wall has, and the whole point of
 * this tier is to cover the vendors we have no signature for.
 */
export declare const NO_PROGRESS_NOTE = "[no visible change] that action left the page identical \u2014 same URL, same title, same elements \u2014 and the page offers almost nothing else to click. This is a guess, not a diagnosis: it is what an unrecognised anti-bot wall looks like. Take one browser_snapshot to confirm; if the page still looks unchanged, stop and tell the user what you were trying to do and ask them to look at the open window, instead of retrying the same action.";
/** A page with at most this many actionable elements counts as "nearly empty". */
export declare const NO_PROGRESS_MAX_REFS = 3;
/**
 * Identity of one page state: URL, title, actionable-element count and the
 * accessible labels. Two captures with the same fingerprint look the same to a
 * human glancing at the window, which is exactly the question this tier asks.
 * @param input - the slice of a snapshot the backstop compares.
 * @returns an opaque fingerprint string.
 */
export declare function snapshotFingerprint(input: {
    readonly url?: string | undefined;
    readonly title?: string | undefined;
    readonly refs?: number | undefined;
    readonly nodes?: readonly ChallengeNode[] | undefined;
}): string;
/**
 * The no-progress backstop: a vendor we have never seen leaves no signature, so
 * we stop asking "which wall is this" and ask "did anything happen". Deliberately
 * conservative — it needs an identical page AND (a nearly empty page, or a second
 * identical result), so an ordinary click that is not meant to change anything
 * stays quiet.
 * @param input - whether an action just ran, the identical-capture streak, and the ref count.
 * @returns the advisory note, or null when the page is still plausibly alive.
 */
export declare function detectNoProgress(input: {
    readonly afterAction: boolean;
    readonly unchangedStreak: number;
    readonly refs: number;
}): string | null;
