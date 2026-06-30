/**
 * @thelol3882/lexen-live — shared wire types.
 *
 * PURE TypeScript interfaces and type aliases — no runtime code, no imports.
 * Shared by:
 *   - src/client/index.ts   (browser fetch payload shapes)
 *   - src/server/index.ts   (route handler request parsing)
 *   - src/next/route.ts     (re-exported for app-side typing)
 *
 * These types describe the HTTP contract between the client-side panel and
 * the dev-only Next.js Route Handler at /api/lexen-live.
 */

// ---------------------------------------------------------------------------
// Core reference
// ---------------------------------------------------------------------------

/**
 * A reference to a single translation key within a namespace.
 * This is the minimal handle the client encodes in every request — the server
 * uses it to locate the correct locale file via lexen core's IO layer.
 */
export interface KeyRef {
    /**
     * The next-intl namespace as known to lexen (e.g. "auth",
     * "widget.active-booking", "common").
     * Validated against lexen's discoverValidNamespaces() before any file I/O.
     */
    namespace: string;

    /**
     * Dot-separated key path within the namespace's JSON file
     * (e.g. "login.title", "errors.network").
     * Validated by getNestedValue() before writing.
     */
    dotKey: string;
}

// ---------------------------------------------------------------------------
// GET /api/lexen-live  (read a key's current values)
// ---------------------------------------------------------------------------

/**
 * Response payload for GET /api/lexen-live?namespace=...&key=...
 * Returns current locale values and metadata so the panel can display them.
 */
export interface KeyResponse {
    ref: KeyRef;

    /**
     * Current resolved string value per locale.
     * Keys are BCP-47 locale codes matching lexen config's `locales` array
     * (e.g. { "ru": "Войти", "kk": "Кіру" }).
     * An empty string means the key exists but is untranslated.
     * A missing key means the locale file doesn't have this key at all.
     */
    values: Record<string, string>;

    /**
     * Absolute filesystem paths of the locale files where values live.
     * Informational only — not displayed to the user; used by the panel for
     * error messages and by the agent loop for deterministic assertions.
     */
    filePaths: Record<string, string>;

    /**
     * Placeholder names present in any locale's value (e.g. ["count", "name"]).
     * Derived from parsePlaceholders() in lexen core across all locale values.
     * Shown in the panel as a reminder so the editor doesn't accidentally drop them.
     */
    placeholders: string[];
}

// ---------------------------------------------------------------------------
// POST /api/lexen-live  (write updated values)
// ---------------------------------------------------------------------------

/**
 * Request payload for POST /api/lexen-live.
 * The client sends only the locales it actually changed.
 */
export interface SaveRequest {
    ref: KeyRef;

    /**
     * New string value per locale to write.
     * Locales omitted here are left unchanged.
     * Each value is validated by a placeholder-drift check (runSync checkOnly)
     * before the write is committed.
     */
    updates: Record<string, string>;
}

/**
 * Response payload for POST /api/lexen-live.
 */
export interface SaveResponse {
    /** true if all writes succeeded and the check gate passed. */
    ok: boolean;

    /** Human-readable summary of what happened (suitable for panel toast). */
    message: string;

    /**
     * Exit code from runSync({checkOnly: true}) after the write:
     *   0 — no issues
     *   1 — drift / violations present (write still happened; panel shows warnings)
     *   2 — invalid namespace (write blocked)
     *   3 — config / usage error (write blocked)
     */
    checkCode: 0 | 1 | 2 | 3;

    /**
     * Human-readable drift / validation warnings from the check.
     * Empty when checkCode === 0.
     */
    warnings: string[];
}

// ---------------------------------------------------------------------------
// GET /api/lexen-live?action=config  (discover project shape)
// ---------------------------------------------------------------------------

/**
 * Response payload for GET /api/lexen-live?action=config.
 * Lets the panel (and agent loop) discover locale codes and valid namespaces
 * without hard-coding them.
 */
export interface ConfigResponse {
    /** Absolute path to the i18n.config.json that lexen resolved. */
    configPath: string;

    /** All locale codes configured in lexen (e.g. ["ru", "kk"]). */
    locales: string[];

    /** The default/source locale (e.g. "ru"). */
    defaultLocale: string;

    /** All valid namespace identifiers discovered by lexen. */
    namespaces: string[];
}
