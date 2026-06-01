import {extractAll} from './extract.js';
import {
    deleteNestedValue,
    discoverValidNamespaces,
    getLeafKeys,
    getNestedValue,
    readNamespace,
    setNestedValue,
    writeNamespace,
} from './locales.js';
import type {Config, SyncOptions, SyncResult} from './types.js';
import {c, log} from './util/log.js';
import {resolveNamespaceScope} from './util/paths.js';
import {
    filterByFeature,
    findInvalidNamespaceUsages,
    findInvalidPreserveNamespaces,
    findPlaceholderDrift,
    findRedundantPreserveEntries,
} from './validate.js';

interface LocaleStat {
    untranslated: number;
    total: number;
}

/**
 * Reconcile extracted keys against locale files. `code` follows the documented
 * exit-code contract: 0=success, 1=drift, 2=invalid namespace; caller
 * propagates it to `process.exit()`.
 */
export function runSync(
    config: Config,
    {write = false, clean = false, featureFilter = null, checkOnly = false}: SyncOptions = {},
): SyncResult {
    const mode = checkOnly ? 'CHECK' : 'EXTRACT';
    log(`\n${c.bold}lexen ${mode}${featureFilter ? ` (${featureFilter})` : ''}`, c.bold);
    log('─'.repeat(50));

    const {namespaceKeys, autoPreserved, namespaceUsages, unresolvedCalls} = extractAll(config, {featureFilter});
    if (config.resolverResolved.mode === 'typechecker') {
        log(`${c.dim}resolver: typechecker${config.resolverResolved.propFlow ? ' (+propFlow)' : ''}${c.reset}`);
    }

    // Surface unresolved call sites — almost always RULES.md rule 1/3/6
    // violations. Silent-skip would hide real missing keys.
    const relevantUnresolved = featureFilter
        ? unresolvedCalls.filter(u => {
            // No known namespace → can only drop entries whose FILE clearly
            // belongs to a different feature.
            const m = /^features\/([^/]+)\//.exec(u.file);
            return !m || m[1] === featureFilter;
        })
        : unresolvedCalls;
    if (relevantUnresolved.length > 0) {
        const cap = process.env.LEXEN_VERBOSE ? 500 : 20;
        // propFlow re-walks per (definer, param), so the same caller site can
        // be reported multiple times — dedup by file:line:snippet:call.
        const seen = new Set<string>();
        const deduped = relevantUnresolved.filter(u => {
            const key = `${u.file}:${u.line}:${u.snippet}:${u.call}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const argCount = deduped.filter(u => u.call !== 'propFlow' && u.call !== 'call').length;
        const propCount = deduped.filter(u => u.call === 'propFlow').length;
        const callCount = deduped.filter(u => u.call === 'call').length;
        log(`\n${c.yellow}${c.bold}Unresolved translation call sites (${deduped.length}):${c.reset}`);
        if (argCount > 0) {
            log(`${c.dim}  ${argCount} ${config.hook.name}/t arg(s) — RULES rule 1/3/6 (non-literal namespace, broad \`string\` type, or runtime value). Keys hidden.${c.reset}`);
        }
        if (propCount > 0) {
            log(`${c.dim}  ${propCount} t-prop caller(s) — RULES rule 4 (t passed as prop, source not traceable to useTranslations). Keys inside the receiving component hidden.${c.reset}`);
        }
        if (callCount > 0) {
            log(`${c.dim}  ${callCount} configured call(s) — namespace or key prop couldn't be resolved statically. Add a "defaults" entry in calls config or fix the call site.${c.reset}`);
        }
        for (const u of deduped.slice(0, cap)) {
            const tag = u.call === 'propFlow' ? 'rule4' : u.call;
            log(`  ${c.yellow}!${c.reset} ${c.cyan}${u.file}:${u.line}${c.reset}  ${c.dim}${tag}: ${u.snippet}${c.reset}`);
        }
        if (deduped.length > cap) {
            log(`  ${c.dim}... and ${deduped.length - cap} more.${c.reset}`);
        }
    }

    // Merge user-declared preserve directives — for keys/namespaces lexen's
    // static analysis can't see. See README "What Lexen can't see".
    if (config.preserve) {
        for (const [ns, spec] of Object.entries(config.preserve)) {
            if (featureFilter && ns !== featureFilter && ns !== 'common') continue;
            if (!autoPreserved.has(ns)) autoPreserved.set(ns, new Set());
            const bucket = autoPreserved.get(ns)!;
            if (spec === '*') {
                bucket.add('*');
            } else {
                for (const p of spec) {
                    // Accept both "prefix.*" and "prefix" forms.
                    bucket.add(p.endsWith('.*') ? p.slice(0, -2) : p);
                }
            }
        }
    }

    if (namespaceKeys.size === 0) {
        log('\nNo translation keys found in code.', c.yellow);
        if (featureFilter) {
            log(`Make sure feature "${featureFilter}" uses ${config.hook.name}().`, c.dim);
        }
        return {ok: true, code: 0, added: 0, removed: 0, untranslated: 0, drift: 0};
    }

    const validNamespaces = discoverValidNamespaces(config);
    const relevantUsages = filterByFeature(namespaceUsages, featureFilter);
    const invalidUsages = findInvalidNamespaceUsages(relevantUsages, validNamespaces, config);

    // Preserve hygiene runs only when no featureFilter — preserve is global.
    // Invalid entries are errors; redundant entries are surfaced only in
    // `check` mode so `extract` keeps a clean success path.
    const invalidPreserve = !featureFilter
        ? findInvalidPreserveNamespaces(config, validNamespaces)
        : [];
    const redundantPreserve = checkOnly && !featureFilter
        ? findRedundantPreserveEntries(config, namespaceKeys)
        : [];

    if (invalidPreserve.length > 0) {
        log(`\n${c.red}${c.bold}Invalid preserve entries (${invalidPreserve.length}):${c.reset}`);
        for (const w of invalidPreserve) {
            log(`  ${c.red}✗${c.reset} ${c.cyan}${w.namespace}${c.reset} → ${w.entry}`);
            log(`    ${c.dim}${w.reason}${c.reset}`);
        }
        if (checkOnly) {
            log(`\n${c.red}lexen check failed — preserve points at unknown namespace(s).${c.reset}\n`);
            return {ok: false, code: 1, added: 0, removed: 0, untranslated: 0, drift: 0};
        }
    }

    if (redundantPreserve.length > 0) {
        log(`\n${c.yellow}${c.bold}Redundant preserve entries (${redundantPreserve.length}):${c.reset}`);
        for (const w of redundantPreserve) {
            log(`  ${c.yellow}!${c.reset} ${c.cyan}${w.namespace}${c.reset} → ${w.entry}`);
            log(`    ${c.dim}${w.reason}${c.reset}`);
        }
    }

    if (invalidUsages.length > 0) {
        log(`\n${c.red}${c.bold}Invalid ${config.hook.name}() namespaces (${invalidUsages.length}):${c.reset}`);
        for (const u of invalidUsages) {
            log(`  ${c.red}✗${c.reset} ${c.cyan}${u.file}:${u.line}${c.reset}`);
            log(`    ${c.dim}${u.reason}${c.reset}`);
        }
        if (checkOnly) {
            log(`\n${c.red}lexen check failed — ${invalidUsages.length} invalid namespace usage(s).${c.reset}\n`);
            return {ok: false, code: 2, added: 0, removed: 0, untranslated: 0, drift: 0};
        }
        log(`\n${c.yellow}Fix these before keys can be validated for these namespaces.${c.reset}`);
    }

    let totalAdded = 0;
    let totalRemoved = 0;
    let totalKeys = 0;
    let totalUntranslated = 0;
    let namespacesProcessed = 0;
    const localeStats: Record<string, LocaleStat> = {};
    for (const locale of config.locales) localeStats[locale] = {untranslated: 0, total: 0};

    // Sibling-widget ownership: flat `widget.<name>` and sub-path
    // `widget.<name>.<subPath>` write to the same locale file, so each
    // namespace's unused check must exclude keys the other claims in code.
    //   • siblingSubPaths[flat] — subtrees owned by sub-namespaces (flat
    //     ignores them).
    //   • parentCodeKeys[subPath-ns] — keys the flat parent calls under the
    //     sub-path's prefix (sub-namespace ignores them).
    // featureFilter drops sibling namespaces from `namespaceKeys`; re-run
    // extractAll with no filter to populate ownership.
    const siblingSourceKeys = featureFilter
        ? extractAll(config, {featureFilter: null}).namespaceKeys
        : namespaceKeys;
    const siblingSubPaths = new Map<string, Set<string>>();
    const parentCodeKeys = new Map<string, Set<string>>();
    if (config.layout.widgetNamespacePrefix) {
        for (const ns of siblingSourceKeys.keys()) {
            const scope = resolveNamespaceScope(config, ns);
            if (scope.scope === 'widget' && scope.subPath) {
                const parent = `${config.layout.widgetNamespacePrefix}.${scope.name}`;
                if (!siblingSubPaths.has(parent)) siblingSubPaths.set(parent, new Set());
                siblingSubPaths.get(parent)!.add(scope.subPath);
            }
        }
        // For each sub-namespace, collect keys its flat parent sees in code
        // under the sub-path's prefix.
        for (const ns of siblingSourceKeys.keys()) {
            const scope = resolveNamespaceScope(config, ns);
            if (scope.scope !== 'widget' || !scope.subPath) continue;
            const parent = `${config.layout.widgetNamespacePrefix}.${scope.name}`;
            const parentKeys = siblingSourceKeys.get(parent);
            if (!parentKeys) continue;
            const prefix = scope.subPath + '.';
            const fromParent = new Set<string>();
            for (const k of parentKeys) {
                if (k.startsWith(prefix)) fromParent.add(k.slice(prefix.length));
            }
            if (fromParent.size > 0) parentCodeKeys.set(ns, fromParent);
        }
    }
    const ownedBySubPath = (key: string, subs: Set<string>): boolean => {
        for (const sub of subs) {
            if (key === sub || key.startsWith(sub + '.')) return true;
        }
        return false;
    };

    for (const [namespace, keys] of namespaceKeys.entries()) {
        const sortedKeys = [...keys].sort();
        namespacesProcessed++;

        log(`\n${c.cyan}${namespace}${c.reset} (${sortedKeys.length} keys in code)`);

        for (const locale of config.locales) {
            const existing = readNamespace(config, namespace, locale);
            const existingKeys = getLeafKeys(existing);
            const codeKeys = new Set(sortedKeys);

            const missing = sortedKeys.filter(k => getNestedValue(existing, k) === undefined);

            const nsPrefixes = autoPreserved.get(namespace);
            const subsOwned = siblingSubPaths.get(namespace);
            const parentOwned = parentCodeKeys.get(namespace);
            const unused = existingKeys.filter(k =>
                !codeKeys.has(k)
                && !isPreserved(k, nsPrefixes)
                && !(subsOwned && ownedBySubPath(k, subsOwned))
                && !(parentOwned && parentOwned.has(k)),
            );
            const preserved = nsPrefixes
                ? existingKeys.filter(k =>
                    !codeKeys.has(k)
                    && isPreserved(k, nsPrefixes)
                    && !(subsOwned && ownedBySubPath(k, subsOwned))
                    && !(parentOwned && parentOwned.has(k)),
                )
                : [];

            let changed = false;

            if (missing.length > 0) {
                log(`  ${locale}: ${c.yellow}+${missing.length} new${c.reset}`);
                missing.forEach(k => {
                    log(`    ${c.green}+ ${k}${c.reset}`);
                    if (write) {
                        setNestedValue(existing, k, '');
                        changed = true;
                    }
                });
                totalAdded += missing.length;
            }

            if (unused.length > 0 && clean) {
                log(`  ${locale}: ${c.red}-${unused.length} unused${c.reset}`);
                unused.forEach(k => {
                    log(`    ${c.red}- ${k}${c.reset}`);
                    if (write) {
                        deleteNestedValue(existing, k);
                        changed = true;
                    }
                });
                totalRemoved += unused.length;
            } else if (unused.length > 0) {
                log(`  ${locale}: ${c.dim}${unused.length} unused (use --clean to remove)${c.reset}`);
            }

            if (preserved.length > 0) {
                log(`  ${locale}: ${c.blue}${preserved.length} preserved (auto-detected)${c.reset}`);
            }

            const finalKeys = getLeafKeys(existing);
            const untranslated = finalKeys.filter(k => getNestedValue(existing, k) === '');
            if (untranslated.length > 0) {
                log(`  ${locale}: ${c.magenta}${untranslated.length} untranslated${c.reset}`);
                localeStats[locale].untranslated += untranslated.length;
                totalUntranslated += untranslated.length;
            }
            localeStats[locale].total += finalKeys.length;

            if (missing.length === 0 && unused.length === 0 && untranslated.length === 0) {
                log(`  ${locale}: ${c.green}synced${c.reset} (${existingKeys.length} keys)`);
            }

            if (write && changed) {
                writeNamespace(config, namespace, locale, existing);
            }

            totalKeys += existingKeys.length + missing.length - (clean ? unused.length : 0);
        }
    }

    // Run after sync so newly-added empty keys don't trip drift detection.
    const drift = findPlaceholderDrift(namespaceKeys, relevantUsages, config);
    if (drift.length > 0) {
        log(`\n${c.red}${c.bold}Placeholder drift (${drift.length}):${c.reset}`);
        for (const d of drift) {
            log(`  ${c.red}✗${c.reset} ${c.cyan}${d.file}:${d.line}${c.reset}`);
            log(`    ${c.dim}${d.reason}${c.reset}`);
        }
        if (!checkOnly) {
            log(`\n${c.yellow}Fix placeholder drift — locales must use the same ICU variables.${c.reset}`);
        }
    }

    printSummary({
        namespacesProcessed,
        totalKeys,
        totalAdded,
        totalRemoved,
        totalUntranslated,
        localeStats,
        locales: config.locales,
    });

    if (checkOnly && (totalAdded > 0 || totalRemoved > 0 || drift.length > 0)) {
        const issues: string[] = [];
        if (totalAdded > 0) issues.push(`${totalAdded} missing`);
        if (totalRemoved > 0) issues.push(`${totalRemoved} unused`);
        if (drift.length > 0) issues.push(`${drift.length} placeholder drift`);
        log(`\n${c.red}lexen check failed — ${issues.join(', ')}.${c.reset}`);
        if (totalAdded > 0 || totalRemoved > 0) {
            log(`Run ${c.cyan}pnpm lexen extract${clean ? '' : ' --clean'}${c.reset} to fix keys.\n`);
        }
        return {ok: false, code: 1, added: totalAdded, removed: totalRemoved, untranslated: totalUntranslated, drift: drift.length};
    }

    if (totalAdded > 0) {
        log(`\n${c.yellow}Added ${totalAdded} empty keys — fill in translations!${c.reset}`);
        log(`Tip: Search for ${c.cyan}""${c.reset} in locale files to find untranslated keys.\n`);
    } else if (totalUntranslated > 0) {
        log(`\n${c.yellow}${totalUntranslated} untranslated key(s) — search for "" in locale files.${c.reset}\n`);
    } else {
        log(`\n${c.green}All keys are synced!${c.reset}\n`);
    }

    return {ok: true, code: 0, added: totalAdded, removed: totalRemoved, untranslated: totalUntranslated, drift: drift.length};
}

function printSummary({
    namespacesProcessed,
    totalKeys,
    totalAdded,
    totalRemoved,
    totalUntranslated,
    localeStats,
    locales,
}: {
    namespacesProcessed: number;
    totalKeys: number;
    totalAdded: number;
    totalRemoved: number;
    totalUntranslated: number;
    localeStats: Record<string, LocaleStat>;
    locales: string[];
}): void {
    log('\n' + '─'.repeat(50));
    log(`${c.bold}Summary:${c.reset}`);
    log(`  Namespaces: ${namespacesProcessed}`);
    log(`  Total keys: ${totalKeys}`);
    if (totalAdded > 0) log(`  ${c.green}Added: ${totalAdded}${c.reset}`);
    if (totalRemoved > 0) log(`  ${c.red}Removed: ${totalRemoved}${c.reset}`);

    if (totalUntranslated > 0) {
        log('');
        log(`${c.bold}Translation coverage:${c.reset}`);
        for (const locale of locales) {
            const {untranslated, total} = localeStats[locale];
            if (total === 0) continue;
            const translated = total - untranslated;
            const pct = Math.round((translated / total) * 100);
            const color = pct === 100 ? c.green : pct >= 80 ? c.yellow : c.red;
            log(`  ${locale}: ${color}${pct}%${c.reset} (${translated}/${total})`);
        }
    }
}

function isPreserved(key: string, preservedPrefixes: Set<string> | undefined): boolean {
    if (!preservedPrefixes) return false;
    if (preservedPrefixes.has('*')) return true;
    for (const prefix of preservedPrefixes) {
        if (key === prefix || key.startsWith(prefix + '.')) return true;
    }
    return false;
}
