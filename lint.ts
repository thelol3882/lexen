/**
 * `lexen lint` — rules-violation diagnostics.
 *
 * Runs extraction + validation and maps each finding to a `RuleViolation`
 * with file:line + a fix hint. Report-only; no auto-fix.
 */
import {extractAll} from './extract/index.js';
import {discoverValidNamespaces} from './locales.js';
import {
    renderGithubViolations,
    renderJsonViolations,
} from './reporters.js';
import type {Config, RuleViolation, UnresolvedCall} from './types.js';
import {c, log, setSilent} from './util/log.js';
import {
    filterByFeature,
    findInvalidNamespaceUsages,
    findPlaceholderDrift,
} from './validate.js';
import type {OutputFormat} from './reporters.js';

/** Short labels for rule headers in the human renderer. */
const RULE_LABELS: Record<number, string> = {
    1: 'dynamic useTranslations namespace',
    2: 'unresolved t() key',
    4: 't passed as prop',
    5: 'invalid namespace usage',
    7: 'non-camelCase key',
    9: 'placeholder drift',
};

/**
 * Collect all rule violations for the given config + optional feature filter.
 * Does NOT set quiet or write anything — pure data.
 */
export function collectRuleViolations(
    config: Config,
    featureFilter: string | null,
    naming: boolean = false,
): RuleViolation[] {
    const {namespaceKeys, namespaceUsages, unresolvedCalls} = extractAll(config, {featureFilter});

    // ── Unresolved calls ──────────────────────────────────────────────────────
    // Apply the same feature-scoping as sync.ts.
    const relevantUnresolved = featureFilter
        ? unresolvedCalls.filter(u => {
            const m = /^features\/([^/]+)\//.exec(u.file);
            return !m || m[1] === featureFilter;
        })
        : unresolvedCalls;

    // Dedup by file:line:snippet:call (propFlow re-walks per definer/param).
    const seen = new Set<string>();
    const deduped: UnresolvedCall[] = relevantUnresolved.filter(u => {
        const key = `${u.file}:${u.line}:${u.snippet}:${u.call}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const violations: RuleViolation[] = [];

    for (const u of deduped) {
        let rule: number;
        let hint: string;

        switch (u.call) {
            case 'useTranslations':
                rule = 1;
                hint = 'dynamic namespace — type the value as a string-literal union, or pass a literal.';
                break;
            case 't':
                rule = 2;
                hint = "key not statically resolvable — store t('…') in data, or type the template hole as a literal union (rule 6).";
                break;
            case 'propFlow':
                rule = 4;
                hint = 'T passed as a prop, source untraceable — call useTranslations(...) inside the component.';
                break;
            case 'call':
            default:
                rule = 2;
                hint = 'configured-call arg unresolved — add a defaults entry or make the arg a literal/union.';
                break;
        }

        violations.push({
            rule,
            file: u.file,
            line: u.line,
            column: u.column,
            snippet: u.snippet,
            message: `unresolved ${u.call}(${u.snippet})`,
            hint,
        });
    }

    // ── Invalid namespace usages (rule 5) ─────────────────────────────────────
    const validNamespaces = discoverValidNamespaces(config);
    const relevantUsages = filterByFeature(namespaceUsages, featureFilter);
    const invalidUsages = findInvalidNamespaceUsages(relevantUsages, validNamespaces, config);

    for (const inv of invalidUsages) {
        violations.push({
            rule: 5,
            file: inv.file,
            line: inv.line,
            column: inv.column,
            snippet: inv.namespace,
            message: inv.reason,
            hint: '',
        });
    }

    // ── Placeholder drift (rule 9) ────────────────────────────────────────────
    const drift = findPlaceholderDrift(namespaceKeys, relevantUsages, config);

    for (const d of drift) {
        violations.push({
            rule: 9,
            file: d.file,
            line: d.line,
            column: d.column,
            snippet: `${d.namespace}.${d.key}`,
            message: d.reason,
            hint: 'locales must use the same ICU placeholders.',
        });
    }

    // ── Rule 7: non-camelCase key segments (opt-in via --naming) ──────────────
    // Lower-severity style nits; off by default so they don't drown the
    // runtime-risk rules (1/2/4/5/9). Key→callsite isn't tracked, so no line.
    if (naming) {
        const camelCaseSegment = /^[a-z][a-zA-Z0-9]*$/;
        for (const [namespace, keys] of namespaceKeys.entries()) {
            for (const key of keys) {
                const segments = key.split('.');
                const badSegment = segments.find(seg => !camelCaseSegment.test(seg));
                if (badSegment !== undefined) {
                    violations.push({
                        rule: 7,
                        file: null,
                        line: null,
                        column: null,
                        snippet: `${namespace} › ${key}`,
                        message: `non-camelCase key "${namespace} › ${key}"`,
                        hint: 'use camelCase + dot-notation (rule 7).',
                    });
                }
            }
        }
    }

    return violations;
}

/**
 * Run the lint subcommand. Returns exit code (0 = no violations, 1 = violations found).
 */
export function runLint(
    config: Config,
    featureFilter: string | null,
    format: OutputFormat,
    naming: boolean = false,
): number {
    // Suppress ALL inline logs for non-human output — they'd corrupt the stream.
    if (format !== 'human') setSilent(true);

    const violations = collectRuleViolations(config, featureFilter, naming);

    if (format === 'json') {
        renderJsonViolations(violations);
        return violations.length > 0 ? 1 : 0;
    }

    if (format === 'github') {
        renderGithubViolations(violations);
        return violations.length > 0 ? 1 : 0;
    }

    // Human format — grouped by rule number.
    if (violations.length === 0) {
        log(`\n${c.green}No RULES violations.${c.reset}\n`);
        return 0;
    }

    log(`\n${c.bold}lexen LINT${c.reset}`);
    log('─'.repeat(50));

    // Group violations by rule number.
    const byRule = new Map<number, RuleViolation[]>();
    for (const v of violations) {
        if (!byRule.has(v.rule)) byRule.set(v.rule, []);
        byRule.get(v.rule)!.push(v);
    }

    for (const rule of [...byRule.keys()].sort((a, b) => a - b)) {
        const group = byRule.get(rule)!;
        const label = RULE_LABELS[rule] ?? `rule ${rule}`;
        log(`\n${c.red}${c.bold}rule ${rule} · ${label} (${group.length})${c.reset}`);
        for (const v of group) {
            if (v.file !== null && v.line !== null) {
                const col = v.column !== null ? `:${v.column}` : '';
                log(`  ${c.yellow}!${c.reset} ${c.cyan}${v.file}:${v.line}${col}${c.reset}  ${c.dim}${v.snippet}${c.reset}`);
            } else {
                log(`  ${c.yellow}!${c.reset} ${c.dim}${v.snippet}${c.reset}`);
            }
            if (v.hint) {
                log(`    ${c.dim}→ ${v.hint}${c.reset}`);
            }
        }
    }

    log('\n' + '─'.repeat(50));
    log(`${c.red}${violations.length} violation(s) found.${c.reset}`);
    if (!naming) {
        log(`${c.dim}tip: add --naming to also check key casing (rule 7).${c.reset}`);
    }
    log('');

    return 1;
}
