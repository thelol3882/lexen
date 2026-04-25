export interface LayoutConfig {
    feature: string;
    widget?: string;
    widgetNamespacePrefix?: string;
    global?: string;
    globalNamespace?: string;
    featuresDir?: string;
    widgetsDir?: string;
}

export interface HookConfig {
    name: string;
    package?: string;
}

/**
 * Preserve keys lexen's static analysis can't see, keyed by namespace.
 *
 *   "*"                → preserve every key under that namespace
 *   ["prefix.*", "x"]  → preserve keys starting with "prefix." or literal "x"
 *
 * Preserved keys survive `extract --clean` and aren't reported as unused.
 * Does NOT inject missing keys — locale files must still contain the values.
 */
export type PreserveConfig = Record<string, '*' | string[]>;

/**
 * Strategy for resolving non-literal `t(<expr>)` / `useTranslations(<expr>)`.
 *
 *   "ast"         — literal strings and template-literal prefixes only.
 *                   Non-literal args are invisible; use `preserve` to keep
 *                   their keys from being pruned.
 *   "typechecker" — uses the TS type-checker to resolve identifiers / property
 *                   access / template holes whose types are string-literal
 *                   (or unions). Truly runtime values still need `preserve`.
 */
export type ResolverMode = 'ast' | 'typechecker';

export interface ResolverConfig {
    mode?: ResolverMode;
    /** Enable caller-passed `t` prop resolution. Only effective when mode is "typechecker". */
    propFlow?: boolean;
    /** Path to the tsconfig lexen uses for the typechecker program. Relative to projectRoot. */
    tsconfig?: string;
}

export interface RawConfig {
    srcDir: string;
    locales: string[];
    defaultLocale?: string;
    filePatterns: string[];
    ignore?: string[];
    hook: HookConfig;
    layout: LayoutConfig;
    preserve?: PreserveConfig;
    /** String shorthand ("ast" | "typechecker") or object with sub-flags. Defaults to "ast". */
    resolver?: ResolverMode | ResolverConfig;
}

export interface Config extends RawConfig {
    projectRoot: string;
    configPath: string;
    absSrcDir: string;
    /** Normalized resolver config — object form, with defaults applied. */
    resolverResolved: Required<Pick<ResolverConfig, 'mode' | 'propFlow'>> & {tsconfig?: string};
    /**
     * Every top-level key in the global messages file (e.g. "common",
     * "navigation"). `useTranslations('<key>')` whose `<key>` is in this set
     * resolves as scope "global", reading from that sub-tree rather than a
     * feature dir. Discovered at config-load time.
     */
    globalSubNamespaces: Set<string>;
}

export interface UsageRecord {
    namespace: string;
    file: string;
    line: number;
    column: number;
}

export interface InvalidUsage extends UsageRecord {
    reason: string;
}

export interface PlaceholderDrift extends UsageRecord {
    key: string;
    reason: string;
}

export type NamespaceKeys = Map<string, Set<string>>;
export type AutoPreserved = Map<string, Set<string>>;

/**
 * A call site where the resolver couldn't enumerate the argument statically.
 * Surfaced at end of run so the user can fix the RULES.md violation
 * (usually rule 1/3/6, or rule 4 for propFlow).
 */
export interface UnresolvedCall extends UsageRecord {
    /**
     *  - "useTranslations" / "t" — hook arg couldn't be resolved (RULES 1/3/6).
     *  - "propFlow" — a component receives `t` as a prop and a caller passes
     *    an expression whose namespace can't be traced back to
     *    `useTranslations(...)` (RULES rule 4).
     */
    call: 'useTranslations' | 't' | 'propFlow';
    /** Short human-readable source snippet of the offending argument. */
    snippet: string;
}

export interface ExtractResult {
    namespaceKeys: NamespaceKeys;
    autoPreserved: AutoPreserved;
    namespaceUsages: UsageRecord[];
    unresolvedCalls: UnresolvedCall[];
}

export interface ExtractOptions {
    featureFilter?: string | null;
    /** Override the resolver mode for this run (used by --compare-resolvers). */
    resolverOverride?: ResolverMode;
}

export interface SyncOptions {
    write?: boolean;
    clean?: boolean;
    featureFilter?: string | null;
    checkOnly?: boolean;
}

export interface SyncResult {
    ok: boolean;
    code: 0 | 1 | 2 | 3;
    added: number;
    removed: number;
    untranslated: number;
    drift: number;
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }
