/**
 * Is this host inside the allow-list? Empty list means "any host".
 *
 * Suffix matching is deliberately anchored one level down: `example.com`
 * admits `example.com` and `a.example.com`, never `notexample.com` and never
 * `example.com.evil.net`. A configured entry is compared after
 * normalisation (lower case, leading dot dropped), because a user writing
 * `.example.com` means the domain, not a subdomain literally named "example".
 * @param host - hostname to test, e.g. "a.example.com".
 * @param allowedDomains - configured suffixes; empty means everything passes.
 * @returns true when the host is allowed.
 */
export declare function isHostAllowed(host: string, allowedDomains: readonly string[]): boolean;
/** Validate one absolute URL against the navigation policy. */
export declare function assertAllowedUrl(raw: string, allowedDomains: readonly string[]): URL;
