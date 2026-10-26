import { isHostAllowed } from "./url-policy.js";
/** Resource types that carry data off the page and are refused outside the allow-list. */
const DATA_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'eventsource']);
/**
 * Refuse every request to a host outside the allow-list for one context.
 *
 * Installed once per context, before the first navigation. When the configured
 * list is empty nothing is installed: "any host" must not pay the routing cost.
 * @param context - the context to guard.
 * @param allowedDomains - reads the live allow-list.
 * @param onBlocked - called for each refused request; the caller keeps the last
 *   document-level block and turns it into an error for the action that caused it.
 * @returns true when a guard was installed, false when the list is empty.
 */
export async function installHostGuard(context, allowedDomains, onBlocked) {
    const domains = allowedDomains();
    if (domains.length === 0)
        return false;
    await context.route('**/*', async (route) => {
        const request = route.request();
        let host;
        try {
            host = new URL(request.url()).hostname;
        }
        catch {
            // Not a URL we can judge (data:, blob:, about:, chrome-extension: …).
            // Neither a host nor a site the policy talks about: let the browser decide.
            await route.continue().catch(() => { });
            return;
        }
        if (isHostAllowed(host, allowedDomains())) {
            await route.continue().catch(() => { });
            return;
        }
        const resourceType = request.resourceType();
        const document = resourceType === 'document';
        // Sub-resources the page needs in order to render are left alone; only the
        // request classes that move the user or move data are refused.
        if (!document && !DATA_RESOURCE_TYPES.has(resourceType)) {
            await route.continue().catch(() => { });
            return;
        }
        if (document)
            onBlocked({ url: request.url(), host, resourceType, document, at: Date.now() });
        await route.abort('blockedbyclient').catch(() => { });
    });
    return true;
}
