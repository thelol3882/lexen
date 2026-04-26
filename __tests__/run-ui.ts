#!/usr/bin/env -S tsx
/**
 * Smoke test for the `lexen ui` HTTP server. Copies the existing extractor
 * fixture to a tempdir, adds a second locale, boots createServer() on an
 * ephemeral port, and exercises /api/index, /api/namespace, /api/translate,
 * and /api/refresh end-to-end.
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
        await testIndexShape(base);
        await testNamespacePayload(base);
        await testRoundTrip(base, tmp);
        await testValidationErrors(base);
        await testRefresh(base);
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

interface IndexEntry { name: string; total: number; filled: number }
interface IndexBody {
    locales: string[];
    sourceLocale: string;
    target: string;
    namespaces: IndexEntry[];
    unresolvedCalls: number;
}
interface KeyEntry {
    key: string;
    values: Record<string, string>;
    sourcePlaceholders: string[];
    usages: {file: string; line: number}[];
}
interface NamespaceBody { name: string; keys: KeyEntry[] }

async function testIndexShape(base: string): Promise<void> {
    const res = await fetch(`${base}/api/index?target=ru`);
    if (res.status !== 200) {
        fail(`/api/index status: expected 200, got ${res.status}`);
        return;
    }
    const body = (await res.json()) as IndexBody;

    if (body.locales.join(',') !== 'en,ru') {
        fail(`/api/index locales: expected [en,ru], got [${body.locales.join(',')}]`);
        return;
    }
    if (body.sourceLocale !== 'en') {
        fail(`/api/index sourceLocale: expected en, got ${body.sourceLocale}`);
        return;
    }
    if (body.target !== 'ru') {
        fail(`/api/index target: expected ru, got ${body.target}`);
        return;
    }
    const demo = body.namespaces.find(n => n.name === 'demo');
    if (!demo) {
        fail('/api/index: expected namespace "demo" to be present');
        return;
    }
    if (typeof demo.total !== 'number' || typeof demo.filled !== 'number') {
        fail(`/api/index "demo": total/filled must be numbers, got total=${demo.total} filled=${demo.filled}`);
        return;
    }
    if ('keys' in (demo as object)) {
        fail('/api/index: should not include per-key data');
        return;
    }
    pass(`/api/index shape (locales, target, per-namespace counts, no key data)`);

    const badRes = await fetch(`${base}/api/index?target=fr`);
    if (badRes.status !== 400) {
        fail(`/api/index?target=fr: expected 400, got ${badRes.status}`);
        return;
    }
    pass('/api/index rejects unknown target locale with 400');
}

async function testNamespacePayload(base: string): Promise<void> {
    const res = await fetch(`${base}/api/namespace?name=demo`);
    if (res.status !== 200) {
        fail(`/api/namespace?name=demo status: expected 200, got ${res.status}`);
        return;
    }
    const body = (await res.json()) as NamespaceBody;
    if (body.name !== 'demo') {
        fail(`/api/namespace name: expected "demo", got "${body.name}"`);
        return;
    }
    if (body.keys.length === 0) {
        fail('/api/namespace: expected demo to have keys');
        return;
    }
    const sample = body.keys[0];
    if (!('en' in sample.values) || !('ru' in sample.values)) {
        fail(`/api/namespace key "${sample.key}" missing per-locale values`);
        return;
    }
    pass(`/api/namespace?name=demo returns ${body.keys.length} keys with values per locale`);

    const missing = await fetch(`${base}/api/namespace?name=does.not.exist`);
    if (missing.status !== 404) {
        fail(`/api/namespace unknown name: expected 404, got ${missing.status}`);
        return;
    }
    pass('/api/namespace 404s on unknown name');

    const noName = await fetch(`${base}/api/namespace`);
    if (noName.status !== 400) {
        fail(`/api/namespace no name: expected 400, got ${noName.status}`);
        return;
    }
    pass('/api/namespace 400s without ?name');
}

async function testRoundTrip(base: string, projectRoot: string): Promise<void> {
    const nsRes = await fetch(`${base}/api/namespace?name=demo`);
    const ns = (await nsRes.json()) as NamespaceBody;
    const target = ns.keys.find(k => k.key === 'literal.hello') ?? ns.keys[0];

    const value = 'Привет, мир';
    const res = await fetch(`${base}/api/translate`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({namespace: 'demo', key: target.key, locale: 'ru', value}),
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

    const nsRes2 = await fetch(`${base}/api/namespace?name=demo`);
    const ns2 = (await nsRes2.json()) as NamespaceBody;
    const refreshed = ns2.keys.find(k => k.key === target.key)!;
    if (refreshed.values.ru !== value) {
        fail(`/api/namespace did not reflect saved value (got ${JSON.stringify(refreshed.values.ru)})`);
        return;
    }
    pass('/api/namespace reflects saved value on next read');

    const idxRes = await fetch(`${base}/api/index?target=ru`);
    const idx = (await idxRes.json()) as IndexBody;
    const demoIdx = idx.namespaces.find(n => n.name === 'demo')!;
    if (demoIdx.filled < 1) {
        fail(`/api/index?target=ru "demo".filled: expected ≥1 after save, got ${demoIdx.filled}`);
        return;
    }
    pass(`/api/index?target=ru reflects filled count (demo.filled=${demoIdx.filled})`);
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

async function testRefresh(base: string): Promise<void> {
    const res = await fetch(`${base}/api/refresh`, {method: 'POST'});
    if (res.status !== 200) {
        fail(`POST /api/refresh: expected 200, got ${res.status}`);
        return;
    }
    const body = (await res.json()) as {ok?: boolean};
    if (!body.ok) {
        fail(`POST /api/refresh: expected ok, got ${JSON.stringify(body)}`);
        return;
    }
    pass('POST /api/refresh clears cache');

    const wrongMethod = await fetch(`${base}/api/refresh`);
    if (wrongMethod.status === 200) {
        fail(`/api/refresh should not respond to GET`);
        return;
    }
    pass(`GET /api/refresh declined (${wrongMethod.status})`);
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
