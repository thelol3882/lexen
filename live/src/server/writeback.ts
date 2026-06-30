/**
 * @thelol3882/lexen-live/server/writeback — lexen-core-backed IO operations.
 *
 * All three public API functions are synchronous (lexen core is fully sync);
 * they are exported as plain functions and wrapped in try/catch by the
 * caller (server/index.ts).
 *
 * Deep-imports lexen core dist modules directly.  This is safe because
 * @thelol3882/lexen has NO exports map (verified), so Node and TypeScript
 * both permit sub-path imports.  No changes to lexen core are required.
 *
 * Imports used:
 *   @thelol3882/lexen/dist/config.js        loadConfig
 *   @thelol3882/lexen/dist/locales.js       readNamespace, getNestedValue,
 *                                            setNestedValue, writeNamespace,
 *                                            discoverValidNamespaces
 *   @thelol3882/lexen/dist/sync.js          runSync
 *   @thelol3882/lexen/dist/extract.js       extractAll
 *   @thelol3882/lexen/dist/context.js       collectKeyContexts, KeyContext
 *   @thelol3882/lexen/dist/util/log.js      setSilent
 *   @thelol3882/lexen/dist/util/paths.js    resolveNamespaceScope,
 *                                            resolveLocalePath
 *   @thelol3882/lexen/dist/types.js         Config (type only)
 */

// ---------------------------------------------------------------------------
// Lexen core deep-imports (no exports map → sub-path imports are permitted)
// ---------------------------------------------------------------------------

import { loadConfig } from '@thelol3882/lexen/dist/config.js';
import {
    readNamespace,
    getNestedValue,
    setNestedValue,
    writeNamespace,
    discoverValidNamespaces,
} from '@thelol3882/lexen/dist/locales.js';
import { runSync } from '@thelol3882/lexen/dist/sync.js';
import { extractAll } from '@thelol3882/lexen/dist/extract/index.js';
import { collectKeyContexts } from '@thelol3882/lexen/dist/context.js';
import type { KeyContext } from '@thelol3882/lexen/dist/context.js';
import { setSilent } from '@thelol3882/lexen/dist/util/log.js';
import {
    resolveNamespaceScope,
    resolveLocalePath,
} from '@thelol3882/lexen/dist/util/paths.js';
import type { Config } from '@thelol3882/lexen/dist/types.js';

// ---------------------------------------------------------------------------
// Shared protocol types
// ---------------------------------------------------------------------------

import type {
    KeyResponse,
    ConfigResponse,
    SaveRequest,
    SaveResponse,
} from '../shared/protocol.js';

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

import { assertPathInside } from './security.js';

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Extended response types (superset of protocol.ts shapes)
// ---------------------------------------------------------------------------

/**
 * ConfigResponse extended with widgetPrefix so the client provider can
 * derive widget namespace keys without hard-coding the prefix.
 */
export interface LiveConfigResponse extends ConfigResponse {
    /** Widget namespace prefix from lexen config (default: "widget"). */
    widgetPrefix: string;
}

/**
 * KeyResponse extended with optional translator context and dynamic-key flag.
 */
export interface LiveKeyResponse extends KeyResponse {
    /** Translator context from lexen (JSX element, space budget, …) or null. */
    context: KeyContext | null;
    /**
     * true when the key was resolved from a dynamic expression (union type /
     * template literal / property access) — the server refuses writes for
     * these because there is no single static locale-file entry.
     */
    dynamic: boolean;
}

// ---------------------------------------------------------------------------
// Internal: load config once per request and silence lexen stdout
// ---------------------------------------------------------------------------

function loadCfg(): Config {
    // setSilent suppresses lexen's own progress output so it doesn't bleed
    // into the Next.js dev server console.
    setSilent(true);
    return loadConfig(process.cwd());
}

// ---------------------------------------------------------------------------
// Internal: cache the expensive static analysis (TypeScript program builds)
// ---------------------------------------------------------------------------

/**
 * Both `extractAll` and `collectKeyContexts` build a full `ts.Program` over the
 * whole app when the resolver is "typechecker" — 5-15s each on a large app. The
 * panel hits getKey on every alt-click, so without caching each click pays that
 * cost twice. The dynamic-key set and per-key JSX context are derived from SOURCE
 * CODE, so we build them once and reuse the result for the entire dev-server
 * session — invalidating only when a source file actually changes.
 *
 * Invalidation is by file mtime, not a timer: we take the newest mtime across the
 * project's code files and rebuild only when it advances. This deliberately
 * IGNORES locale JSON, so saving a translation never triggers a rebuild — the
 * structural analysis it feeds is unchanged. Locale VALUES are always read fresh,
 * and saveKey's check-gate runs on live data, so a cached analysis can only ever
 * affect the panel's read-only context hints (and even those refresh the instant
 * you edit the component).
 */
interface AnalysisCache {
    configPath: string;
    sourceMtime: number;
    contexts: KeyContext[];
    dynamicKeys: Map<string, Set<string>>;
}

let analysisCache: AnalysisCache | null = null;

/** Code-file extensions whose edits can change extraction/context output. */
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
/** Directories never worth walking when looking for source changes. */
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', '.turbo', 'coverage']);

/** Newest mtime (ms) across code files under `dir`; locale JSON is ignored. */
function newestSourceMtime(dir: string): number {
    let newest = 0;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return newest; // unreadable dir — treat as no contribution
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const m = newestSourceMtime(join(dir, entry.name));
            if (m > newest) newest = m;
        } else if (entry.isFile()) {
            const dot = entry.name.lastIndexOf('.');
            if (dot < 0 || !CODE_EXTENSIONS.has(entry.name.slice(dot))) continue;
            try {
                const m = statSync(join(dir, entry.name)).mtimeMs;
                if (m > newest) newest = m;
            } catch {
                // file vanished between readdir and stat — ignore
            }
        }
    }
    return newest;
}

function getAnalysis(
    config: Config,
): { contexts: KeyContext[]; dynamicKeys: Map<string, Set<string>> } {
    const sourceMtime = newestSourceMtime(config.absSrcDir);
    if (
        analysisCache &&
        analysisCache.configPath === config.configPath &&
        analysisCache.sourceMtime === sourceMtime
    ) {
        return analysisCache;
    }

    const dynamicKeys = extractAll(config).dynamicKeys;
    const contexts = collectKeyContexts(config);

    analysisCache = { configPath: config.configPath, sourceMtime, contexts, dynamicKeys };
    return analysisCache;
}

// ---------------------------------------------------------------------------
// GET /config
// ---------------------------------------------------------------------------

/**
 * Return the project's lexen configuration shape for the client provider.
 *
 * Called once by LexenLiveProvider on mount to discover locales,
 * widgetPrefix, and valid namespaces.
 */
export function getConfig(): LiveConfigResponse {
    const config = loadCfg();
    const namespaces = [...discoverValidNamespaces(config)].sort();
    const defaultLocale = config.defaultLocale ?? config.locales[0] ?? 'en';

    return {
        configPath: config.configPath,
        locales: config.locales,
        defaultLocale,
        namespaces,
        widgetPrefix: config.layout.widgetNamespacePrefix ?? 'widget',
    };
}

// ---------------------------------------------------------------------------
// GET /key
// ---------------------------------------------------------------------------

/** Discriminated error shape returned by getKey on bad input. */
export interface GetKeyError {
    error: string;
    status: number;
}

/**
 * Read the current locale values and translator context for a single key.
 *
 * Returns a {@link GetKeyError} (discriminated by the `error` property) for
 * client-visible validation failures (unknown namespace, etc.); throws for
 * unexpected I/O errors (caught by the caller).
 */
export function getKey(
    namespace: string,
    dotKey: string,
): LiveKeyResponse | GetKeyError {
    const config = loadCfg();

    // Validate namespace
    const validNs = discoverValidNamespaces(config);
    if (!validNs.has(namespace)) {
        return { error: `Unknown namespace: "${namespace}"`, status: 400 };
    }

    // Static analysis (dynamic-key set + per-key JSX context) — cached per
    // dev-server session so rapid alt-clicks don't each rebuild a ts.Program.
    const { contexts, dynamicKeys } = getAnalysis(config);

    // Determine whether the key is dynamic (no write allowed for these)
    const isDynamic = dynamicKeys.get(namespace)?.has(dotKey) ?? false;

    // Read values and collect file paths per locale
    const values: Record<string, string> = {};
    const filePaths: Record<string, string> = {};

    for (const locale of config.locales) {
        try {
            const filePath = resolveLocalePath(config, namespace, locale);
            filePaths[locale] = filePath;
            const obj = readNamespace(config, namespace, locale);
            const val = getNestedValue(obj, dotKey);
            values[locale] = typeof val === 'string' ? val : '';
        } catch {
            // Locale file may not exist yet — omit the locale silently.
        }
    }

    // Translator context: find the matching KeyContext entry (first call site)
    const ctx = contexts.find(c => c.namespace === namespace && c.key === dotKey) ?? null;

    // Collect placeholder names (union of context + parsed values)
    const placeholders = ctx?.placeholders ?? [];

    return {
        ref: { namespace, dotKey },
        values,
        filePaths,
        placeholders,
        context: ctx,
        dynamic: isDynamic,
    };
}

// ---------------------------------------------------------------------------
// POST /save
// ---------------------------------------------------------------------------

/**
 * Validate, write, gate, and (on drift) auto-revert a set of locale updates.
 *
 * Steps:
 *  1. Validate namespace against discoverValidNamespaces.
 *  2. Refuse writes to dynamic keys (no static file entry exists).
 *  3. Canonicalize + path-traversal-guard each target file path.
 *  4. Read previousValue per locale (needed for auto-revert).
 *  5. Write new values via setNestedValue + writeNamespace (lexen-canonical).
 *  6. Gate with runSync({ checkOnly: true }) — the only reachable failure after
 *     a single-value edit is placeholder drift (code 1).
 *  7. On drift: auto-revert all written locales, return ok:false + warnings.
 *  8. On success: return ok:true.
 */
export function saveKey(body: SaveRequest): SaveResponse {
    const config = loadCfg();
    const { ref: { namespace, dotKey }, updates } = body;

    // -----------------------------------------------------------------------
    // 1. Validate namespace
    // -----------------------------------------------------------------------
    const validNs = discoverValidNamespaces(config);
    if (!validNs.has(namespace)) {
        return {
            ok: false,
            checkCode: 2,
            message: `Invalid namespace: "${namespace}". Not a known lexen namespace.`,
            warnings: [],
        };
    }

    // -----------------------------------------------------------------------
    // 2. Refuse dynamic keys
    // -----------------------------------------------------------------------
    const { dynamicKeys } = getAnalysis(config);
    if (dynamicKeys.get(namespace)?.has(dotKey)) {
        return {
            ok: false,
            checkCode: 3,
            message:
                `Key "${dotKey}" in namespace "${namespace}" is dynamic — ` +
                'it has no single static locale-file entry and cannot be written.',
            warnings: [],
        };
    }

    // -----------------------------------------------------------------------
    // 3. Resolve scope (for featureFilter) and allowed roots (path guard)
    // -----------------------------------------------------------------------
    const scope = resolveNamespaceScope(config, namespace);
    const featureFilter: string | undefined =
        scope.scope === 'feature' ? scope.name : undefined;

    // All locale files for this project must live under absSrcDir.
    const allowedRoots = [config.absSrcDir];

    // -----------------------------------------------------------------------
    // 4. Validate paths + capture previous values
    // -----------------------------------------------------------------------
    const previousValues: Record<string, string> = {};

    for (const locale of Object.keys(updates)) {
        const filePath = resolveLocalePath(config, namespace, locale);
        // Throws SecurityError(403) if outside allowed roots.
        assertPathInside(filePath, allowedRoots);

        const obj = readNamespace(config, namespace, locale);
        const prev = getNestedValue(obj, dotKey);
        previousValues[locale] = typeof prev === 'string' ? prev : '';
    }

    // -----------------------------------------------------------------------
    // 5. Write new values (lexen-canonical via writeNamespace → writeJsonFile)
    // -----------------------------------------------------------------------
    for (const [locale, value] of Object.entries(updates)) {
        const obj = readNamespace(config, namespace, locale);
        setNestedValue(obj, dotKey, value);
        writeNamespace(config, namespace, locale, obj);
    }

    // -----------------------------------------------------------------------
    // 6. Gate: placeholder-drift check
    // -----------------------------------------------------------------------
    const syncResult = runSync(config, { checkOnly: true, featureFilter });

    // -----------------------------------------------------------------------
    // 7. On drift: auto-revert and surface warnings
    // -----------------------------------------------------------------------
    if (!syncResult.ok && syncResult.code === 1) {
        // Best-effort revert — never leave a partially-written/drifting file.
        for (const [locale, prev] of Object.entries(previousValues)) {
            try {
                const obj = readNamespace(config, namespace, locale);
                setNestedValue(obj, dotKey, prev);
                writeNamespace(config, namespace, locale, obj);
            } catch {
                // I/O error during revert — log silently; caller surfaces the
                // original drift warning to the user.
            }
        }

        const driftWarnings = syncResult.report?.drift.map(
            d => `[${d.namespace}] ${d.key}: ${d.reason}`,
        ) ?? ['Placeholder drift detected'];

        return {
            ok: false,
            checkCode: 1,
            message: 'Placeholder drift detected — changes have been reverted.',
            warnings: driftWarnings,
        };
    }

    // -----------------------------------------------------------------------
    // 8. Other unexpected sync failures (missing keys added in the same edit,
    //    config errors, etc.) — surface without revert since they don't
    //    represent a content error in what was written.
    // -----------------------------------------------------------------------
    if (!syncResult.ok) {
        return {
            ok: false,
            checkCode: syncResult.code,
            message: `Sync check returned code ${syncResult.code}.`,
            warnings: syncResult.report?.drift.map(d => d.reason) ?? [],
        };
    }

    // -----------------------------------------------------------------------
    // 9. Success
    // -----------------------------------------------------------------------
    return {
        ok: true,
        checkCode: 0,
        message: `Saved ${Object.keys(updates).length} locale(s) for "${namespace}.${dotKey}".`,
        warnings: [],
    };
}
