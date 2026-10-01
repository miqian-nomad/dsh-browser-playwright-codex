/**
 * Browser capability seam: the provider registry and selection service.
 * Providers implement browser backends; consumers acquire sessions through
 * ctx.browser without importing a concrete implementation.
 * @module dsh-browser-playwright-codex/service
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { BrowserProvider, BrowserSession } from './types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        browser: BrowserRuntime;
    }
}
/** Selection config for the browser seam. */
export interface BrowserRuntimeConfig {
    /** Explicit provider id. Omitted = auto-select when exactly one is registered. */
    readonly provider?: string;
}
/** Schemastery validation for {@link BrowserRuntimeConfig}. */
export declare const Config: z<BrowserRuntimeConfig>;
/**
 * The browser service, registered as ctx.browser (one instance per context).
 * Selection semantics (resolved at acquire time, never order-dependent):
 * - A configured id that is registered → that provider.
 * - A configured id not registered → CONFIGURED_PROVIDER_MISSING.
 * - No id configured, exactly one registered provider → that provider.
 * - No id configured, multiple registered providers → AMBIGUOUS_PROVIDER.
 * - No registered provider → NO_PROVIDER.
 */
export default class BrowserRuntime extends Service {
    static Config: z<BrowserRuntimeConfig>;
    private readonly providers;
    private readonly configuredId;
    constructor(ctx: Context, config?: BrowserRuntimeConfig);
    /**
     * Register a browser provider. Duplicate ids fail the registering plugin.
     * @param provider - the provider; its id is the registry key.
     * @returns the disposer that unregisters and disposes the provider.
     */
    registerProvider(provider: BrowserProvider): () => void;
    /**
     * Acquire the session owned by the owner key through the selected provider.
     * @param owner - opaque caller-owned session key (a harness session id).
     * @param signal - optional cancellation forwarded to the provider.
     * @returns the live browser session.
     */
    acquire(owner: string, signal?: AbortSignal): Promise<BrowserSession>;
    /**
     * Release the session owned by the owner key on every registered provider;
     * providers ignore unknown owners.
     * @param owner - the owner key whose session should be released.
     */
    disposeOwner(owner: string): Promise<void>;
    private resolveProvider;
}
