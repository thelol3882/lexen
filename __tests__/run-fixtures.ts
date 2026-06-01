#!/usr/bin/env -S tsx
/**
 * Fixture runner for lexen's typechecker resolver.
 *
 * Walks the `fixtures/` project and asserts that the extracted key set matches
 * a hand-written expectation. Run with: `pnpm lexen:test` (or `tsx <this>`).
 *
 * Not a replacement for a real test framework — intentionally dependency-free
 * so it can ship with the lexen directory as a standalone reusable tool.
 */
import path from 'path';
import {fileURLToPath} from 'url';

import {loadConfig} from '../config.js';
import {extractAll} from '../extract/index.js';
import {collectRuleViolations} from '../lint.js';
import {parseFormat} from '../reporters.js';
import {runSync} from '../sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

interface Expectation {
    namespace: string;
    keys: string[];
}

const EXPECTED: Expectation[] = [
    {
        namespace: 'demo',
        keys: [
            'literal.hello',
            'status.pending',
            'status.confirmed',
            'status.cancelled',
            'roles.admin',
            'roles.owner',
            'nav.home',
            'nav.settings',
            // hookReturn.tsx — via useDemoTable() hook-return resolution
            'hookReturn.title',
            'hookReturn.renamed',
        ],
    },
    {
        namespace: 'widget.demo',
        keys: [
            'header',
            'actions.edit',
            'actions.delete',
            // propFlow.tsx — shorthand-property prop resolution
            'shorthand.save',
            // wrapper.tsx — both branches of a conditional JSX wrapper
            'wrapper.desktop.title',
            'wrapper.mobile.title',
            // subPath.tsx — flat parent calling into sub-path subtree
            'subsection.fromFlat',
        ],
    },
    {
        namespace: 'widget.demo.subsection',
        keys: [
            // subPath.tsx — subpath-scoped binding, same underlying locale file
            'fromSubpath',
        ],
    },
    {
        namespace: 'common',
        keys: [
            'hookReturn.loading',
            // propFlow.tsx — shorthand-property prop resolution
            'shorthand.cancel',
            // configuredCallUsage.tsx case (b) — buildRootFixtureMeta() uses namespace.default='common'
            'metadata.root.title',
            'metadata.root.description',
        ],
    },
    {
        // configuredCallUsage.tsx cases (a) and (c) — buildFixtureMeta from '@test/fixture-seo'
        namespace: 'widget.landing',
        keys: [
            // case (a): literal key 'root'
            'metadata.root.title',
            'metadata.root.description',
            // case (c): union key 'detail' | 'list' fans out
            'metadata.detail.title',
            'metadata.detail.description',
            'metadata.list.title',
            'metadata.list.description',
        ],
    },
];

function main(): number {
    const config = loadConfig(FIXTURES_DIR);
    const {namespaceKeys, unresolvedCalls} = extractAll(config);

    let failures = 0;
    for (const {namespace, keys} of EXPECTED) {
        const found = namespaceKeys.get(namespace) ?? new Set<string>();
        const missing = keys.filter(k => !found.has(k));
        if (missing.length > 0) {
            // eslint-disable-next-line no-console
            console.error(`FAIL ${namespace}: missing [${missing.join(', ')}]`);
            failures++;
        } else {
            // eslint-disable-next-line no-console
            console.log(`PASS ${namespace}: ${keys.length} keys`);
        }
    }

    // propFlowUnresolved.tsx — BrokenCaller passes `t` destructured from
    // a custom hook. absorbNamespaces can't trace it to useTranslations,
    // so propFlow must record an unresolvedCalls entry.
    const propFlowUnresolved = unresolvedCalls.filter(
        u => u.call === 'propFlow' && u.file.endsWith('propFlowUnresolved.tsx'),
    );
    if (propFlowUnresolved.length === 0) {
        // eslint-disable-next-line no-console
        console.error('FAIL propFlow-unresolved: expected a propFlow entry for propFlowUnresolved.tsx (BrokenCaller), got none');
        failures++;
    } else {
        // eslint-disable-next-line no-console
        console.log(`PASS propFlow-unresolved: ${propFlowUnresolved.length} entry`);
    }

    // And the broken keys must NOT have been silently extracted.
    const brokenKeys = namespaceKeys.get('widget.demo') ?? new Set<string>();
    const rule4Leaked = ['rule4.invisible.one', 'rule4.invisible.two'].filter(k => brokenKeys.has(k));
    if (rule4Leaked.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`FAIL rule4-invariant: extractor unexpectedly resolved [${rule4Leaked.join(', ')}]`);
        failures++;
    } else {
        // eslint-disable-next-line no-console
        console.log('PASS rule4-invariant: hidden keys stayed hidden');
    }

    // configuredCalls-localDecl exclusion: localDeclNoExtract.tsx declares
    // buildFixtureMeta locally (not imported from '@test/fixture-seo'), so the
    // package filter must prevent it from producing any keys.
    const localDeclLeaked = [
        'metadata.localSecret.title',
        'metadata.localSecret.description',
    ].filter(k => (namespaceKeys.get('widget.demo') ?? new Set<string>()).has(k));
    if (localDeclLeaked.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`FAIL configuredCalls-localDecl: local declaration unexpectedly produced keys [${localDeclLeaked.join(', ')}]`);
        failures++;
    } else {
        // eslint-disable-next-line no-console
        console.log('PASS configuredCalls-localDecl: local declaration correctly excluded');
    }

    // ── Phase 2: safe-clean + --force assertions ──────────────────────────────
    // The 'cleanguard' feature has:
    //   - t('kept')       — static key (extracted)
    //   - t(dynamicKeyVar) — unresolved dynamic key (namespace known = 'cleanguard')
    //   - locale file has 'kept' + 'orphan' (orphan is not in code)
    //
    // Without --force, --clean must NOT prune 'orphan' (result.removed === 0).
    // With --force, --clean SHOULD prune 'orphan' (result.removed >= 1).
    // write:false ensures no locale files are mutated.
    {
        const cleanGuardResult = runSync(config, {clean: true, write: false, featureFilter: 'cleanguard'});
        if (cleanGuardResult.removed !== 0) {
            // eslint-disable-next-line no-console
            console.error(`FAIL cleanguard-protected: expected removed=0 without --force, got ${cleanGuardResult.removed}`);
            failures++;
        } else {
            // eslint-disable-next-line no-console
            console.log('PASS cleanguard-protected: orphan key kept (removed=0) without --force');
        }

        const cleanGuardForceResult = runSync(config, {clean: true, write: false, force: true, featureFilter: 'cleanguard'});
        if (cleanGuardForceResult.removed < 1) {
            // eslint-disable-next-line no-console
            console.error(`FAIL cleanguard-force: expected removed>=1 with --force, got ${cleanGuardForceResult.removed}`);
            failures++;
        } else {
            // eslint-disable-next-line no-console
            console.log(`PASS cleanguard-force: orphan key pruned (removed=${cleanGuardForceResult.removed}) with --force`);
        }
    }

    // ── Phase 3: lint + reporters assertions ─────────────────────────────────
    // Fixture 'linttest' has a rule-1 violation (dynamic useTranslations namespace)
    // and a rule-2 violation (dynamic t() key). collectRuleViolations must surface both.
    {
        const violations = collectRuleViolations(config, 'linttest');
        const rule1 = violations.filter(v => v.rule === 1);
        const rule2 = violations.filter(v => v.rule === 2);

        if (rule1.length === 0) {
            // eslint-disable-next-line no-console
            console.error('FAIL lint-rule1: expected rule 1 violation for dynamic useTranslations, got none');
            failures++;
        } else if (rule1[0].file === null || rule1[0].line === null) {
            // eslint-disable-next-line no-console
            console.error(`FAIL lint-rule1: expected non-null file+line, got file=${rule1[0].file} line=${rule1[0].line}`);
            failures++;
        } else {
            // eslint-disable-next-line no-console
            console.log(`PASS lint-rule1: rule 1 violation at ${rule1[0].file}:${rule1[0].line}`);
        }

        if (rule2.length === 0) {
            // eslint-disable-next-line no-console
            console.error('FAIL lint-rule2: expected rule 2 violation for dynamic t(), got none');
            failures++;
        } else if (rule2[0].file === null || rule2[0].line === null) {
            // eslint-disable-next-line no-console
            console.error(`FAIL lint-rule2: expected non-null file+line, got file=${rule2[0].file} line=${rule2[0].line}`);
            failures++;
        } else {
            // eslint-disable-next-line no-console
            console.log(`PASS lint-rule2: rule 2 violation at ${rule2[0].file}:${rule2[0].line}`);
        }
    }

    // parseFormat basics.
    {
        const fmt = parseFormat(['--format=json']);
        if (fmt !== 'json') {
            // eslint-disable-next-line no-console
            console.error(`FAIL parseFormat-json: expected 'json', got '${fmt}'`);
            failures++;
        } else {
            // eslint-disable-next-line no-console
            console.log('PASS parseFormat-json: parseFormat([\'--format=json\']) === \'json\'');
        }

        let threw = false;
        try {
            parseFormat(['--format=invalid']);
        } catch {
            threw = true;
        }
        if (!threw) {
            // eslint-disable-next-line no-console
            console.error('FAIL parseFormat-unknown: expected throw on unknown format value');
            failures++;
        } else {
            // eslint-disable-next-line no-console
            console.log('PASS parseFormat-unknown: unknown format value throws as expected');
        }
    }

    const totalAssertions = EXPECTED.length + 5 + 4;
    if (failures > 0) {
        // eslint-disable-next-line no-console
        console.error(`\n${failures} fixture assertion(s) failed.`);
        return 1;
    }
    // eslint-disable-next-line no-console
    console.log(`\nAll ${totalAssertions} fixture assertions passed.`);
    return 0;
}

process.exit(main());
