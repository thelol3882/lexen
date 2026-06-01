import {BARE_NAMESPACE} from './extract/index.js';
import type {Config, InvalidUsage, NamespaceKeys, PlaceholderDrift, PreserveWarning, UsageRecord} from './types.js';
import {getNestedValue, readNamespace} from './locales.js';

// Re-export so existing callers of `import { PreserveWarning } from './validate.js'` still work.
export type {PreserveWarning} from './types.js';

/**
 * Flag preserve entries pointing at namespaces with no locales dir on disk —
 * usually a misspelled or deleted namespace.
 */
export function findInvalidPreserveNamespaces(
    config: Config,
    validNamespaces: Set<string>,
): PreserveWarning[] {
    const out: PreserveWarning[] = [];
    if (!config.preserve) return out;
    for (const [ns, spec] of Object.entries(config.preserve)) {
        if (!validNamespaces.has(ns)) {
            const specStr = spec === '*' ? '"*"' : JSON.stringify(spec);
            out.push({
                namespace: ns,
                entry: specStr,
                reason: `preserve["${ns}"] points at a namespace with no locales dir. Known namespaces: ${[...validNamespaces].sort().join(', ')}`,
            });
        }
    }
    return out;
}

/**
 * Flag preserve entries whose covered keys are already statically visible —
 * dead config the resolver has caught up to. `--check` only so it doesn't
 * spam extract.
 */
export function findRedundantPreserveEntries(
    config: Config,
    namespaceKeys: NamespaceKeys,
): PreserveWarning[] {
    const out: PreserveWarning[] = [];
    if (!config.preserve) return out;
    for (const [ns, spec] of Object.entries(config.preserve)) {
        const codeKeys = namespaceKeys.get(ns);
        if (!codeKeys || codeKeys.size === 0) continue;

        if (spec === '*') {
            // Can't call '*' redundant without a full key inventory.
            continue;
        }
        for (const rawPrefix of spec) {
            const prefix = rawPrefix.endsWith('.*') ? rawPrefix.slice(0, -2) : rawPrefix;
            const covered = [...codeKeys].some(
                k => k === prefix || k.startsWith(prefix + '.'),
            );
            if (covered) {
                out.push({
                    namespace: ns,
                    entry: rawPrefix,
                    reason: `preserve["${ns}"] entry "${rawPrefix}" covers keys already seen statically — safe to remove.`,
                });
            }
        }
    }
    return out;
}

/**
 * Validate that every `useTranslations()` usage refers to a real namespace.
 * Accepts feature/global single-segment names and `widget.<name>` with a
 * `locales/` dir; rejects other multi-segment shapes and unknown names.
 */
export function findInvalidNamespaceUsages(
    namespaceUsages: UsageRecord[],
    validNamespaces: Set<string>,
    config: Config,
): InvalidUsage[] {
    const widgetPrefix = config.layout.widgetNamespacePrefix;
    const invalid: InvalidUsage[] = [];

    for (const usage of namespaceUsages) {
        const {namespace} = usage;

        // Bare `useTranslations()` — RULES.md rule 5.
        if (namespace === BARE_NAMESPACE) {
            invalid.push({
                ...usage,
                reason: `bare ${config.hook.name}() with no namespace — RULES.md rule 5: call the hook once per namespace with a literal arg (e.g. ${config.hook.name}('schedule'))`,
            });
            continue;
        }

        if (validNamespaces.has(namespace)) continue;

        const parts = namespace.split('.');
        const isWidgetShaped = !!widgetPrefix && parts.length === 2 && parts[0] === widgetPrefix;

        // `widget.<name>.<subPath>` — accept when the widget itself is valid.
        // Covers config-driven dynamic namespaces (literal-union values
        // shaped like `widget.<name>.<subPath>`). Keys land nested inside the
        // widget's locale file at that sub-path.
        if (widgetPrefix && parts.length > 2 && parts[0] === widgetPrefix) {
            const widgetRoot = `${widgetPrefix}.${parts[1]}`;
            if (validNamespaces.has(widgetRoot)) continue;
        }

        if (parts.length > 1 && !isWidgetShaped) {
            const suggestedKey = parts.slice(1).join('.');
            invalid.push({
                ...usage,
                reason: `multi-segment namespace "${namespace}" — use the root namespace "${parts[0]}" and prefix the key instead (e.g. t('${suggestedKey}.someKey'))`,
            });
            continue;
        }

        const hint = [...validNamespaces].sort().join(', ');
        if (isWidgetShaped) {
            invalid.push({
                ...usage,
                reason: `unknown widget namespace "${namespace}" — no matching ${config.layout.widgetsDir}/${parts[1]}/locales dir. Valid: ${hint}`,
            });
        } else {
            invalid.push({
                ...usage,
                reason: `unknown namespace "${namespace}" — no matching feature locales dir or root key in the global messages file. Valid: ${hint}`,
            });
        }
    }
    return invalid;
}

export function filterByFeature(usages: UsageRecord[], featureFilter: string | null): UsageRecord[] {
    if (!featureFilter) return usages;
    return usages.filter(u => u.namespace.split('.')[0] === featureFilter);
}

/**
 * Parse ICU placeholder names. Handles `{name}`, typed `{count, number}`,
 * plural/select with nested sub-messages, and ICU escape `'{...}'`.
 */
export function parsePlaceholders(str: unknown): {names: string[]; malformed: boolean} {
    if (typeof str !== 'string') return {names: [], malformed: false};

    const names = new Set<string>();
    let depth = 0;
    let malformed = false;
    let currentStart = -1;
    let i = 0;

    while (i < str.length) {
        const ch = str[i];

        if (ch === "'" && depth === 0) {
            if (str[i + 1] === "'") { i += 2; continue; }
            const end = str.indexOf("'", i + 1);
            if (end === -1) { i += 1; continue; }
            i = end + 1;
            continue;
        }

        if (ch === '{') {
            if (depth === 0) currentStart = i;
            depth++;
            i++;
            continue;
        }

        if (ch === '}') {
            if (depth === 0) { malformed = true; i++; continue; }
            depth--;
            if (depth === 0 && currentStart !== -1) {
                const inner = str.slice(currentStart + 1, i);
                const name = extractPlaceholderName(inner);
                if (name) names.add(name);
                const nested = parsePlaceholders(inner);
                for (const n of nested.names) names.add(n);
                if (nested.malformed) malformed = true;
                currentStart = -1;
            }
            i++;
            continue;
        }

        i++;
    }

    if (depth !== 0) malformed = true;
    return {names: [...names], malformed};
}

function extractPlaceholderName(inner: string): string | null {
    const trimmed = inner.trim();
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    return m ? m[1] : null;
}

/**
 * Compare ICU placeholders across locales for every key present in code.
 * Empty values skipped — they're already reported as untranslated.
 */
export function findPlaceholderDrift(
    namespaceKeys: NamespaceKeys,
    namespaceUsages: UsageRecord[],
    config: Config,
): PlaceholderDrift[] {
    const drift: PlaceholderDrift[] = [];
    const firstUsageByNs = new Map<string, UsageRecord>();
    for (const usage of namespaceUsages) {
        if (!firstUsageByNs.has(usage.namespace)) {
            firstUsageByNs.set(usage.namespace, usage);
        }
    }

    for (const [namespace, keys] of namespaceKeys.entries()) {
        const perLocale: Record<string, ReturnType<typeof readNamespace>> = {};
        for (const locale of config.locales) {
            perLocale[locale] = readNamespace(config, namespace, locale);
        }

        for (const key of keys) {
            const placeholdersByLocale: Record<string, Set<string>> = {};
            let anyMalformed = false;
            let malformedLocale: string | null = null;

            for (const locale of config.locales) {
                const value = getNestedValue(perLocale[locale], key);
                if (typeof value !== 'string' || value === '') continue;
                const parsed = parsePlaceholders(value);
                if (parsed.malformed) {
                    anyMalformed = true;
                    malformedLocale = locale;
                }
                placeholdersByLocale[locale] = new Set(parsed.names);
            }

            const locales = Object.keys(placeholdersByLocale);
            if (locales.length < 2 && !anyMalformed) continue;

            const union = new Set<string>();
            for (const l of locales) {
                for (const p of placeholdersByLocale[l]) union.add(p);
            }

            const missingByLocale: Record<string, string[]> = {};
            let hasDrift = false;
            for (const l of locales) {
                const missing = [...union].filter(p => !placeholdersByLocale[l].has(p));
                if (missing.length > 0) {
                    missingByLocale[l] = missing;
                    hasDrift = true;
                }
            }

            if (!hasDrift && !anyMalformed) continue;

            const usage = firstUsageByNs.get(namespace) ?? {namespace, file: '<unknown>', line: 0, column: 0};
            let reason: string;
            if (anyMalformed) {
                reason = `malformed ICU placeholders in ${malformedLocale} for "${namespace}.${key}" (unbalanced braces)`;
            } else {
                const parts = Object.entries(missingByLocale)
                    .map(([l, names]) => `${l} missing {${names.join('}, {')}}`);
                reason = `placeholder drift in "${namespace}.${key}": ${parts.join('; ')}`;
            }

            drift.push({
                namespace,
                key,
                file: usage.file,
                line: usage.line,
                column: usage.column,
                reason,
            });
        }
    }

    return drift;
}
