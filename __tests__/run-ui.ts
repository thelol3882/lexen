#!/usr/bin/env -S tsx
/**
 * Smoke test for the `lexen ui` HTTP server. Copies the existing extractor
 * fixture to a tempdir, adds a second locale, boots createServer() on an
 * ephemeral port, and exercises /api/state + /api/translate end-to-end.
 *
 * Dependency-free, like run-fixtures.ts — no vitest, no jest.
 */
import {cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync} from 'fs';
import {AddressInfo} from 'net';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';

import {loadConfig} from '../config.js';
import {createServer} from '../ui/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

interface Failure { msg: string }
const failures: Failure[] = [];
function fail(msg: string): void {
    // eslint-disable-next-line no-console
    console.error(`FAIL ${msg}`);
    failures.push({msg});
}
function pass(msg: string): void {
    // eslint-disable-next-line no-console
    console.log(`PASS ${msg}`);
}

async function main(): Promise<number> {
    // 1. Copy fixture to tempdir, add a second locale.
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'lexen-ui-'));
    cpSync(FIXTURES_DIR, tmp, {recursive: true});
    const cfgPath = path.join(tmp, 'i18n.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.locales = ['en', 'ru'];
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const config = loadConfig(tmp);
    const server = createServer(config, {sourceLocale: 'en'});

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;

    try {
        await testStateShape(base);
        await testRoundTrip(base, tmp);
        await testValidationErrors(base);
        await testStaticServing(base);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }

    if (failures.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`\n${failures.length} UI assertion(s) failed.`);
        return 1;
    }
    // eslint-disable-next-line no-console
    console.log('\nAll UI assertions passed.');
    return 0;
}

interface StateKey {
    key: string;
    values: Record<string, string>;
    sourcePlaceholders: string[];
    usages: {file: string; line: number}[];
}
interface StateNs { name: string; keys: StateKey[] }
interface StateBody {
    locales: string[];
    sourceLocale: string;
    namespaces: StateNs[];
    unresolvedCalls: number;
}

async function testStateShape(base: string): Promise<void> {
    const res = await fetch(`${base}/api/state`);
    if (res.status !== 200) {
        fail(`/api/state status: expected 200, got ${res.status}`);
        return;
    }
    const body = (await res.json()) as StateBody;

    if (body.locales.join(',') !== 'en,ru') {
        fail(`/api/state locales: expected [en,ru], got [${body.locales.join(',')}]`);
        return;
    }
    if (body.sourceLocale !== 'en') {
        fail(`/api/state sourceLocale: expected en, got ${body.sourceLocale}`);
        return;
    }
    const demo = body.namespaces.find(n => n.name === 'demo');
    if (!demo) {
        fail('/api/state: expected namespace "demo" to be present');
        return;
    }
    if (demo.keys.length === 0) {
        fail('/api/state: expected demo namespace to have keys');
        return;
    }
    const sample = demo.keys[0];
    if (!('en' in sample.values) || !('ru' in sample.values)) {
        fail(`/api/state: key "${sample.key}" missing per-locale values`);
        return;
    }
    pass(`/api/state shape (locales, sourceLocale, namespaces.keys.values)`);
}

async function testRoundTrip(base: string, projectRoot: string): Promise<void> {
    const stateRes = await fetch(`${base}/api/state`);
    const state = (await stateRes.json()) as StateBody;
    const demo = state.namespaces.find(n => n.name === 'demo')!;
    const target = demo.keys.find(k => k.key === 'literal.hello') ?? demo.keys[0];

    const value = 'Привет, мир';
    const res = await fetch(`${base}/api/translate`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            namespace: 'demo',
            key: target.key,
            locale: 'ru',
            value,
        }),
    });
    const body = (await res.json()) as {ok?: boolean; error?: string};
    if (res.status !== 200 || !body.ok) {
        fail(`PATCH /api/translate: expected ok, got ${res.status} ${JSON.stringify(body)}`);
        return;
    }

    const ruPath = path.join(projectRoot, 'src/features/demo/locales/ru.json');
    if (!existsSync(ruPath)) {
        fail(`PATCH did not create ${ruPath}`);
        return;
    }
    const ruData = JSON.parse(readFileSync(ruPath, 'utf8')) as Record<string, unknown>;
    const written = walkDotPath(ruData, target.key);
    if (written !== value) {
        fail(`PATCH round-trip: expected ${JSON.stringify(value)} at ${target.key}, got ${JSON.stringify(written)}`);
        return;
    }
    pass(`PATCH /api/translate round-trip writes ${target.key} = ${JSON.stringify(value)}`);

    // And /api/state should now reflect the written value.
    const stateRes2 = await fetch(`${base}/api/state`);
    const state2 = (await stateRes2.json()) as StateBody;
    const refreshed = state2.namespaces
        .find(n => n.name === 'demo')!
        .keys.find(k => k.key === target.key)!;
    if (refreshed.values.ru !== value) {
        fail(`/api/state did not reflect saved value (got ${JSON.stringify(refreshed.values.ru)})`);
        return;
    }
    pass('/api/state reflects saved value on next read');
}

async function testValidationErrors(base: string): Promise<void> {
    const badLocale = await fetch(`${base}/api/translate`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({namespace: 'demo', key: 'literal.hello', locale: 'fr', value: 'x'}),
    });
    if (badLocale.status !== 400) {
        fail(`PATCH unknown locale: expected 400, got ${badLocale.status}`);
        return;
    }
    pass('PATCH rejects unknown locale with 400');

    const missingFields = await fetch(`${base}/api/translate`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({namespace: 'demo'}),
    });
    if (missingFields.status !== 400) {
        fail(`PATCH missing fields: expected 400, got ${missingFields.status}`);
        return;
    }
    pass('PATCH rejects missing fields with 400');
}

async function testStaticServing(base: string): Promise<void> {
    const indexRes = await fetch(`${base}/`);
    if (indexRes.status !== 200) {
        fail(`GET /: expected 200, got ${indexRes.status}`);
        return;
    }
    const html = await indexRes.text();
    if (!html.includes('Lexen')) {
        fail(`GET /: expected HTML to mention "Lexen"`);
        return;
    }
    const contentType = indexRes.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
        fail(`GET /: expected text/html content-type, got ${contentType}`);
        return;
    }
    pass('GET / serves index.html');

    const traversal = await fetch(`${base}/../package.json`);
    // node:http resolves "/../package.json" to "/package.json" before we see it,
    // so this becomes a 404 against our static dir rather than a 403. Either is
    // acceptable as long as we don't leak the file.
    if (traversal.status !== 404 && traversal.status !== 403) {
        fail(`path traversal: expected 403/404, got ${traversal.status}`);
        return;
    }
    pass(`path traversal blocked (${traversal.status})`);
}

function walkDotPath(obj: unknown, dotPath: string): unknown {
    let cur: unknown = obj;
    for (const part of dotPath.split('.')) {
        if (!cur || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
}

main().then(code => process.exit(code), err => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
