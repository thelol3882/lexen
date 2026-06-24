import type ts from 'typescript';

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
 * One namespace-binding hook, or several. A single object keeps the common
 * case terse; an array lets a project track more than one binder — e.g.
 * next-intl's client `useTranslations` (from `next-intl`) **and** its server
 * `getTranslations` (from `next-intl/server`). All listed hooks bind a
 * namespace from their first string argument; `const t = await getTranslations
 * ('ns')` is handled (the `await` is unwrapped).
 */
export type HookSpec = HookConfig | HookConfig[];

/**
 * Descriptor for a builder function that reads translation keys directly from
 * the message tree (e.g. `buildMetadata({namespace, key})`). Lexen will
 * collect aliases for the callee names, resolve the namespace and key-template
 * holes via `resolveStringLiterals`, and feed the results to `addKeyToNamespaces`.
 */
export interface CallExtractorConfig {
    /** Function name(s) to match at call sites. */
    callee: string | string[];
    /**
     * Optional import-source filter. When set, only call sites whose callee
     * was imported from this module specifier are matched (mirrors `hook.package`).
     */
    package?: string;
    /** Index of the object-literal argument (default 0). */
    arg?: number;
    /**
     * How to extract the namespace from the object argument.
     * `prop` is the property name; `default` is used when the prop is absent.
     */
    namespace: {
        prop: string;
        default?: string;
    };
    /**
     * Key templates. `${propName}` holes are filled from the object argument's
     * properties via `resolveStringLiterals`, cartesian-expanded across all holes.
     */
    keys: string[];
    /** Literal fallbacks for props absent at a given call site. */
    defaults?: Record<string, string>;
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
    $schema?: string;
    srcDir: string;
    locales: string[];
    defaultLocale?: string;
    filePatterns: string[];
    ignore?: string[];
    hook: HookSpec;
    layout: LayoutConfig;
    preserve?: PreserveConfig;
    /** String shorthand ("ast" | "typechecker") or object with sub-flags. Defaults to "ast". */
    resolver?: ResolverMode | ResolverConfig;
    /** Config-driven call extractors for builder functions (e.g. `buildMetadata`). */
    calls?: CallExtractorConfig[];
}

export interface Config extends RawConfig {
    projectRoot: string;
    configPath: string;
    absSrcDir: string;
    /**
     * Every configured hook, normalized to an array (the raw `hook` may be a
     * single object). `hook` itself is normalized to the first entry so legacy
     * `config.hook.name` reads keep working.
     */
    hooksResolved: HookConfig[];
    /** Normalized to the primary (first) hook — narrows RawConfig's `HookSpec`. */
    hook: HookConfig;
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
     *  - "call" — a configured call-extractor (`calls[].callee`) whose
     *    namespace or key prop couldn't be statically resolved.
     */
    call: 'useTranslations' | 't' | 'propFlow' | 'call';
    /** Short human-readable source snippet of the offending argument. */
    snippet: string;
    /**
     * The namespaces the `t` function is bound to at this unresolved call site.
     * Present only for `call === 't'` (bound namespaces are known).
     * Absent for `useTranslations` / `propFlow` / `call` where the namespace
     * itself is unknown.
     */
    namespaces?: string[];
}

export interface ExtractResult {
    namespaceKeys: NamespaceKeys;
    autoPreserved: AutoPreserved;
    namespaceUsages: UsageRecord[];
    unresolvedCalls: UnresolvedCall[];
    /**
     * Subset of `namespaceKeys` whose keys were resolved from a dynamic hole
     * (string/number-literal union, template, property access) rather than a
     * plain `t('literal')`. These mirror runtime values (API enums, etc.), so
     * the naming check (rule 7) exempts them.
     */
    dynamicKeys: NamespaceKeys;
}

export interface ExtractOptions {
    featureFilter?: string | null;
    /** Override the resolver mode for this run (used by --compare-resolvers). */
    resolverOverride?: ResolverMode;
    /**
     * Optional sink invoked for every statically-resolved literal `t('key')`
     * call, with its resolved namespaces and the call node. Lets `lexen context`
     * attach JSX call-site context without duplicating namespace resolution.
     * Only fires for plain string-literal keys — the ones with a real source
     * position to anchor context to.
     */
    onKeyContext?: (key: string, namespaces: string[], call: ts.CallExpression) => void;
}

export interface SyncOptions {
    write?: boolean;
    clean?: boolean;
    featureFilter?: string | null;
    checkOnly?: boolean;
    force?: boolean;
}

/**
 * A single key-level finding from a sync run (missing, unused, or untranslated).
 * Locale files don't carry per-key file/line info, so only namespace+key+locale.
 */
export interface KeyFinding {
    namespace: string;
    key: string;
    locale: string;
}

/**
 * Warning about a preserve config entry (invalid pointer or redundant coverage).
 * Moved here from validate.ts so reporters and lint can import it without a cycle.
 */
export interface PreserveWarning {
    namespace: string;
    entry: string;
    reason: string;
}

/**
 * Structured report produced by runSync. Populated when `write` is false
 * (check / lint paths) so callers can render findings in machine formats.
 */
export interface SyncReport {
    missing: KeyFinding[];
    unused: KeyFinding[];
    untranslated: KeyFinding[];
    drift: PlaceholderDrift[];
    invalidNamespace: InvalidUsage[];
    preserve: PreserveWarning[];
    unresolved: UnresolvedCall[];
}

/**
 * A rule-violation diagnostic produced by `lexen lint`.
 * `file`/`line`/`column` are null for violations without a precise call-site
 * (e.g. rule 7 key-naming, where key→callsite isn't tracked).
 */
export interface RuleViolation {
    rule: number;
    file: string | null;
    line: number | null;
    column: number | null;
    snippet: string;
    message: string;
    hint: string;
}

export interface SyncResult {
    ok: boolean;
    code: 0 | 1 | 2 | 3;
    added: number;
    removed: number;
    untranslated: number;
    drift: number;
    /** Structured findings — only populated when `write` is false. */
    report?: SyncReport;
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }
