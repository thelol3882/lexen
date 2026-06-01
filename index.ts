#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

import {loadConfig} from './config.js';
import {extractAll} from './extract.js';
import {sortAll} from './locales.js';
import {runSync} from './sync.js';
import {collectRuleViolations, runLint} from './lint.js';
import {parseFormat, renderGithubReport, renderGithubViolations, renderJsonReport, renderJsonViolations} from './reporters.js';
import {c, log, setQuiet, setSilent} from './util/log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRESETS_DIR = path.join(__dirname, 'presets');
const DEFAULT_PRESET = 'next-intl';

const SUBCOMMANDS = ['extract', 'check', 'sort', 'init', 'lint'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function listPresets(): string[] {
    if (!fs.existsSync(PRESETS_DIR)) return [];
    return fs
        .readdirSync(PRESETS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -'.json'.length))
        .sort();
}

function getFlagValue(args: string[], flag: string): string | null {
    // Accept both `--flag value` and `--flag=value`.
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === flag && i + 1 < args.length) return args[i + 1];
        if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
    }
    return null;
}

function printUsage(): void {
    log(`${c.bold}Lexen${c.reset} — config-driven i18n extraction & validation`);
    log('');
    log('Usage:');
    log(`  ${c.cyan}pnpm lexen extract${c.reset} [feature] [--clean] [--force] [--quiet] [--compare-resolvers]`);
    log(`                                       scan code, add missing keys (and optionally prune unused)`);
    log(`  ${c.cyan}pnpm lexen check${c.reset}   [feature] [--quiet] [--strict] [--format=human|github|json]`);
    log(`                                       CI mode — fail on drift or invalid namespaces`);
    log(`  ${c.cyan}pnpm lexen lint${c.reset}    [feature] [--naming] [--format=human|github|json]`);
    log(`                                       rules-violation diagnostics (file:line + fix hint)`);
    log(`  ${c.cyan}pnpm lexen sort${c.reset}                            normalize key order in every locale file`);
    log(`  ${c.cyan}pnpm lexen init${c.reset}    [--preset=<name>] [--force]  scaffold i18n.config.json`);
    log('');
    log(`Exit codes: ${c.dim}0 ok · 1 drift/violations · 2 invalid namespace · 3 config/usage error${c.reset}`);
}

function runInit(args: string[], projectRoot: string): number {
    const force = args.includes('--force');
    const presetName = getFlagValue(args, '--preset') ?? DEFAULT_PRESET;
    const available = listPresets();

    if (!available.includes(presetName)) {
        log(`error: unknown preset "${presetName}". Available: ${available.join(', ')}`);
        return 1;
    }

    const presetPath = path.join(PRESETS_DIR, `${presetName}.json`);
    const targetPath = path.join(projectRoot, 'i18n.config.json');

    if (fs.existsSync(targetPath) && !force) {
        log('error: i18n.config.json already exists. Pass --force to overwrite.');
        return 3;
    }

    fs.copyFileSync(presetPath, targetPath);
    log(`Wrote i18n.config.json (preset: ${presetName})`);
    log('Edit the locales array and run `pnpm lexen extract`.');
    return 0;
}

function runSort(projectRoot: string): number {
    const config = loadConfig(projectRoot);
    log(`\n${c.bold}lexen SORT${c.reset}`);
    log('─'.repeat(50));
    const {sorted, skipped} = sortAll(config);
    log('\n' + '─'.repeat(50));
    if (sorted > 0) {
        log(`${c.green}Sorted ${sorted} file(s)${c.reset}, ${skipped} already sorted.`);
    } else {
        log(`${c.green}All ${skipped} locale files are already sorted.${c.reset}`);
    }
    log('');
    return 0;
}

function runExtractOrCheck(
    args: string[],
    projectRoot: string,
    {checkOnly}: {checkOnly: boolean},
): number {
    const clean = args.includes('--clean');
    const force = args.includes('--force');
    const quiet = args.includes('--quiet');
    const strict = checkOnly && args.includes('--strict');
    const positional = args.filter(a => !a.startsWith('-'));
    // positional[0] is the subcommand; [1] is the optional feature filter.
    const featureFilter = positional[1] ?? getFlagValue(args, '--feature') ?? null;

    const config = loadConfig(projectRoot);

    const format = parseFormat(args);

    // For non-human formats suppress ALL inline logs so only the machine output is emitted.
    if (format !== 'human') {
        setSilent(true);
    } else {
        setQuiet(quiet);
    }

    if (!checkOnly && args.includes('--compare-resolvers')) {
        return runCompareResolvers(config, featureFilter);
    }

    const result = runSync(config, {
        write: !checkOnly,
        clean,
        force,
        featureFilter,
        checkOnly,
    });

    // Non-human output: render the report via the chosen formatter.
    if (format !== 'human' && result.report) {
        if (format === 'github') {
            renderGithubReport(result.report);
        } else {
            renderJsonReport(result.report);
        }
    }

    let exitCode = result.code;

    // --strict: also run lint and fold violations into the result.
    if (strict && exitCode === 0) {
        const violations = collectRuleViolations(config, featureFilter);
        if (violations.length > 0) {
            if (format === 'github') {
                renderGithubViolations(violations);
            } else if (format === 'json') {
                renderJsonViolations(violations);
            } else {
                // Human: run the full lint renderer (prints grouped report).
                runLint(config, featureFilter, 'human');
            }
            exitCode = 1;
        }
    }

    return exitCode;
}

function runCompareResolvers(
    config: ReturnType<typeof loadConfig>,
    featureFilter: string | null,
): number {
    log(`\n${c.bold}lexen COMPARE RESOLVERS${c.reset}`);
    log('─'.repeat(50));
    log(`${c.dim}Running both "ast" and "typechecker" resolvers side-by-side. No writes.${c.reset}\n`);

    const ast = extractAll(config, {featureFilter, resolverOverride: 'ast'});
    log(`${c.cyan}ast${c.reset}: ${countKeys(ast.namespaceKeys)} keys across ${ast.namespaceKeys.size} namespaces`);

    const tc = extractAll(config, {featureFilter, resolverOverride: 'typechecker'});
    log(`${c.cyan}typechecker${c.reset}: ${countKeys(tc.namespaceKeys)} keys across ${tc.namespaceKeys.size} namespaces`);

    const onlyTc = diffKeys(tc.namespaceKeys, ast.namespaceKeys);
    const onlyAst = diffKeys(ast.namespaceKeys, tc.namespaceKeys);

    log('\n' + '─'.repeat(50));
    if (onlyTc.size === 0 && onlyAst.size === 0) {
        log(`${c.green}Parity — both resolvers produced identical key sets.${c.reset}`);
    } else {
        if (onlyTc.size > 0) {
            log(`\n${c.green}${c.bold}Only seen by typechecker (${countKeys(onlyTc)}):${c.reset}`);
            for (const [ns, keys] of sortedEntries(onlyTc)) {
                log(`  ${c.cyan}${ns}${c.reset}`);
                for (const k of [...keys].sort()) log(`    ${c.green}+ ${k}${c.reset}`);
            }
        }
        if (onlyAst.size > 0) {
            // Should be empty — typechecker is a strict superset, so any AST-only
            // key means the resolver lost ground.
            log(`\n${c.red}${c.bold}Only seen by AST (${countKeys(onlyAst)}) — resolver gap:${c.reset}`);
            for (const [ns, keys] of sortedEntries(onlyAst)) {
                log(`  ${c.cyan}${ns}${c.reset}`);
                for (const k of [...keys].sort()) log(`    ${c.red}- ${k}${c.reset}`);
            }
        }
    }
    log('');
    return onlyAst.size > 0 ? 1 : 0;
}

function countKeys(map: Map<string, Set<string>>): number {
    let n = 0;
    for (const s of map.values()) n += s.size;
    return n;
}

function diffKeys(
    a: Map<string, Set<string>>,
    b: Map<string, Set<string>>,
): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const [ns, keys] of a.entries()) {
        const bKeys = b.get(ns) ?? new Set<string>();
        const diff = new Set<string>();
        for (const k of keys) if (!bKeys.has(k)) diff.add(k);
        if (diff.size > 0) out.set(ns, diff);
    }
    return out;
}

function sortedEntries<T>(map: Map<string, T>): [string, T][] {
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function main(): number {
    const args = process.argv.slice(2);

    // Project root is the user's CWD (where they invoke `lexen`), not lexen's
    // install location — that's where i18n.config.json lives.
    const projectRoot = process.cwd();

    const positional = args.filter(a => !a.startsWith('-'));
    const sub = positional[0] as Subcommand | undefined;

    if (!sub || args.includes('--help') || args.includes('-h')) {
        printUsage();
        return sub ? 0 : 3;
    }

    if (!SUBCOMMANDS.includes(sub)) {
        log(`${c.red}error: unknown subcommand "${sub}"${c.reset}\n`);
        printUsage();
        return 3;
    }

    switch (sub) {
        case 'init':
            return runInit(args, projectRoot);
        case 'sort':
            return runSort(projectRoot);
        case 'extract':
            return runExtractOrCheck(args, projectRoot, {checkOnly: false});
        case 'check':
            return runExtractOrCheck(args, projectRoot, {checkOnly: true});
        case 'lint': {
            const format = parseFormat(args);
            const naming = args.includes('--naming');
            const positional = args.filter(a => !a.startsWith('-'));
            const featureFilter = positional[1] ?? getFlagValue(args, '--feature') ?? null;
            return runLint(loadConfig(projectRoot), featureFilter, format, naming);
        }
    }
}

try {
    process.exit(main());
} catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`\n${c.red}Error: ${msg}${c.reset}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(3);
}
