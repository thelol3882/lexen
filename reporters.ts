/**
 * Machine-readable output renderers for `lexen check` and `lexen lint`.
 *
 * Writers use `console.log` directly (NOT the colored `log` helper) so output
 * is clean and machine-parseable regardless of the `--quiet` flag.
 */
import type {RuleViolation, SyncReport} from './types.js';

export type OutputFormat = 'human' | 'github' | 'json';

/**
 * Parse `--format=<value>` from an args array (same convention as getFlagValue).
 * Defaults to `'human'`. Throws a usage-error string (exit 3) on unknown value.
 */
export function parseFormat(args: string[]): OutputFormat {
    let value: string | null = null;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--format' && i + 1 < args.length) {
            value = args[i + 1];
            break;
        }
        if (a.startsWith('--format=')) {
            value = a.slice('--format='.length);
            break;
        }
    }
    if (value === null) return 'human';
    if (value === 'human' || value === 'github' || value === 'json') return value;
    throw new Error(`Unknown --format value "${value}". Valid: human, github, json`);
}

// ── GitHub Actions workflow commands ──────────────────────────────────────────

/**
 * Render a SyncReport in GitHub Actions annotation format.
 * Findings with a precise file+line get `::error`/`::warning` annotations;
 * aggregate counts (missing/unused/untranslated) use fileless `::notice`.
 */
export function renderGithubReport(report: SyncReport): void {
    for (const inv of report.invalidNamespace) {
        const loc = `file=${inv.file},line=${inv.line},col=${inv.column}`;
        console.log(`::error ${loc}::invalid namespace — ${inv.reason}`);
    }

    for (const d of report.drift) {
        const loc = `file=${d.file},line=${d.line},col=${d.column}`;
        console.log(`::error ${loc}::placeholder drift — ${d.reason}`);
    }

    for (const u of report.unresolved) {
        const loc = `file=${u.file},line=${u.line},col=${u.column}`;
        const level = u.call === 'propFlow' ? 'warning' : 'error';
        console.log(`::${level} ${loc}::unresolved ${u.call} — ${u.snippet}`);
    }

    // Key-level findings have no precise source location — use notices.
    for (const m of report.missing) {
        console.log(`::notice::missing key "${m.namespace}.${m.key}" (${m.locale})`);
    }

    for (const u of report.unused) {
        console.log(`::warning::unused key "${u.namespace}.${u.key}" (${u.locale})`);
    }

    for (const u of report.untranslated) {
        console.log(`::warning::untranslated key "${u.namespace}.${u.key}" (${u.locale})`);
    }

    for (const p of report.preserve) {
        console.log(`::warning::preserve warning — ${p.reason}`);
    }
}

/**
 * Render a SyncReport as JSON.
 */
export function renderJsonReport(report: SyncReport): void {
    console.log(JSON.stringify(report, null, 2));
}

// ── Lint violation renderers ──────────────────────────────────────────────────

/**
 * Render lint violations in GitHub Actions annotation format.
 */
export function renderGithubViolations(violations: RuleViolation[]): void {
    for (const v of violations) {
        if (v.file !== null && v.line !== null) {
            const col = v.column !== null ? `,col=${v.column}` : '';
            const loc = `file=${v.file},line=${v.line}${col}`;
            console.log(`::error ${loc}::rule ${v.rule}: ${v.message}${v.hint ? ` — ${v.hint}` : ''}`);
        } else {
            // No precise location (e.g. rule 7 naming — key→callsite not tracked).
            console.log(`::warning::rule ${v.rule}: ${v.message}${v.hint ? ` — ${v.hint}` : ''}`);
        }
    }
}

/**
 * Render lint violations as JSON.
 */
export function renderJsonViolations(violations: RuleViolation[]): void {
    console.log(JSON.stringify(violations, null, 2));
}
