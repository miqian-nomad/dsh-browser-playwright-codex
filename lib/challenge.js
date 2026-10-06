/**
 * Detect anti-bot / human-verification challenge pages (Cloudflare
 * interstitial, Turnstile, reCAPTCHA-style) from a snapshot's title, url and
 * visible text. We do NOT try to solve them: the correct move for an agent is
 * to hand the challenge to the human who can see the open window. Returns the
 * engine name when matched, else null. Matching is conservative to avoid
 * false positives on ordinary pages.
 */
export function detectChallenge(snapshot) {
    const title = snapshot.title ?? '';
    const url = snapshot.url ?? '';
    const parts = [];
    const walk = (nodes, depth) => {
        for (const node of nodes) {
            if (parts.length >= 60)
                return;
            if (node.name !== undefined && node.name !== '')
                parts.push(node.name);
            if (depth < 2 && node.children !== undefined && node.children.length > 0)
                walk(node.children, depth + 1);
        }
    };
    walk(snapshot.nodes ?? [], 0);
    const text = [title, url, ...parts].join(' | ').slice(0, 900);
    const saidCaptcha = parts.some((name) => /(captcha|turnstile|recaptcha|hcaptcha)/i.test(name));
    if (/just a moment|attention required|checking (your )?browser|cf-chl-|请稍候|验证你的浏览器/i.test(text))
        return { engine: 'Cloudflare', hint: 'Cloudflare is challenging the browser before letting the page load' };
    if (/verify (you are|you're|that you are) (a )?human|人机验证|验证您(是|为)人类/i.test(text))
        return { engine: 'human-verification', hint: 'the page is asking to verify a human visitor' };
    if (/(captcha|turnstile|recaptcha|hcaptcha)/i.test(text) &&
        (saidCaptcha || /(captcha|turnstile|recaptcha)/i.test(title)))
        return { engine: 'captcha', hint: 'the page embedded a captcha-style challenge' };
    return null;
}
/**
 * Instruction appended above a snapshot when the page is an anti-bot
 * challenge. The browser window is visible on the user's desktop: the agent
 * should pause and ask the user to complete it by hand, then re-snapshot.
 */
export const CHALLENGE_NOTE = "[human verification] The page triggered an anti-bot challenge; it is NOT solvable by automation and must NOT be retried blindly. The browser window is open on the user's desktop — tell the user a verification appeared, wait for them to finish it (a few seconds), then call browser_snapshot again. The clearance cookie is saved to the profile automatically and keeps working for the session.";
