/**
 * 人机验证页识别：从快照里判断是否撞上 Cloudflare 之类的挑战页，并给出对应的提示文案。
 * @module dsh-browser-playwright-codex/challenge
 */
import type { ChallengeMatch, ChallengeSnapshot } from './tool-types.ts';
/**
 * Detect anti-bot / human-verification challenge pages (Cloudflare
 * interstitial, Turnstile, reCAPTCHA-style) from a snapshot's title, url and
 * visible text. We do NOT try to solve them: the correct move for an agent is
 * to hand the challenge to the human who can see the open window. Returns the
 * engine name when matched, else null. Matching is conservative to avoid
 * false positives on ordinary pages.
 */
export declare function detectChallenge(snapshot: ChallengeSnapshot): ChallengeMatch | null;
/**
 * Instruction appended above a snapshot when the page is an anti-bot
 * challenge. The browser window is visible on the user's desktop: the agent
 * should pause and ask the user to complete it by hand, then re-snapshot.
 */
export declare const CHALLENGE_NOTE = "[human verification] The page triggered an anti-bot challenge; it is NOT solvable by automation and must NOT be retried blindly. The browser window is open on the user's desktop \u2014 tell the user a verification appeared, wait for them to finish it (a few seconds), then call browser_snapshot again. The clearance cookie is saved to the profile automatically and keeps working for the session.";
