import fs from 'fs';
import http from 'http';
import path from 'path';
import {fileURLToPath} from 'url';

import {extractAll} from '../extract.js';
import {readNamespace, writeNamespace, getNestedValue, setNestedValue} from '../locales.js';
import type {Config, ExtractResult, JsonObject} from '../types.js';
import {parsePlaceholders} from '../validate.js';
import {c, log} from '../util/log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_DIR = path.join(__dirname, 'client');

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
};

export interface UiServerOptions {
    sourceLocale: string;
}

interface KeyEntry {
    key: string;
    values: Record<string, string>;
    sourcePlaceholders: string[];
    usages: {file: string; line: number}[];
}

interface NamespacePayload {
    name: string;
    keys: KeyEntry[];
}

interface IndexEntry {
    name: string;
    total: number;
    filled: number;
}

interface IndexResponse {
    locales: string[];
    sourceLocale: string;
    target: string;
    namespaces: IndexEntry[];
    unresolvedCalls: number;
}

interface PatchBody {
    namespace?: unknown;
    key?: unknown;
    locale?: unknown;
    value?: unknown;
}

export function createServer(config: Config, opts: UiServerOptions): http.Server {
    if (!config.locales.includes(opts.sourceLocale)) {
        throw new Error(
            `source locale "${opts.sourceLocale}" is not in config.locales [${config.locales.join(', ')}]`,
        );
    }

    // extractAll runs the TS compiler — seconds on large projects. Cache it
    // for the server's lifetime; POST /api/refresh clears so devs see new keys.
    const cache: {extracted: ExtractResult | null} = {extracted: null};
    const getExtract = (): ExtractResult => {
        if (cache.extracted) return cache.extracted;
        const t0 = Date.now();
        cache.extracted = extractAll(config);
        log(`${c.dim}[lexen ui] extracted ${countKeys(cache.extracted)} keys in ${Date.now() - t0}ms (cached)${c.reset}`);
        return cache.extracted;
    };

    return http.createServer((req, res) => {
        handle(req, res, config, opts, {getExtract, clearCache: () => { cache.extracted = null; }})
            .catch(err => {
                const msg = err instanceof Error ? err.message : String(err);
                sendJson(res, 500, {error: msg});
            });
    });
}

function countKeys(extracted: ExtractResult): number {
    let n = 0;
    for (const set of extracted.namespaceKeys.values()) n += set.size;
    return n;
}

interface CacheHandle {
    getExtract: () => ExtractResult;
    clearCache: () => void;
}

async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    config: Config,
    opts: UiServerOptions,
    cache: CacheHandle,
): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/index') {
        const target = url.searchParams.get('target') ?? opts.sourceLocale;
        if (!config.locales.includes(target)) {
            sendJson(res, 400, {error: `unknown target locale: ${target}`});
            return;
        }
        sendJson(res, 200, buildIndex(config, opts, cache, target));
        return;
    }

    if (req.method === 'GET' && pathname === '/api/namespace') {
        const name = url.searchParams.get('name') ?? '';
        if (!name) {
            sendJson(res, 400, {error: 'missing ?name=<namespace>'});
            return;
        }
        const payload = buildNamespace(config, opts, cache, name);
        if (!payload) {
            sendJson(res, 404, {error: `unknown namespace: ${name}`});
            return;
        }
        sendJson(res, 200, payload);
        return;
    }

    if (req.method === 'POST' && pathname === '/api/refresh') {
        cache.clearCache();
        sendJson(res, 200, {ok: true});
        return;
    }

    if (req.method === 'PATCH' && pathname === '/api/translate') {
        const body = await readJsonBody(req);
        const result = applyTranslation(config, body);
        sendJson(res, result.status, result.body);
        return;
    }

    if (req.method === 'GET') {
        serveStatic(pathname, res);
        return;
    }

    sendJson(res, 405, {error: `method not allowed: ${req.method} ${pathname}`});
}

function buildIndex(
    config: Config,
    opts: UiServerOptions,
    cache: CacheHandle,
    target: string,
): IndexResponse {
    const extracted = cache.getExtract();
    const sortedNamespaces = [...extracted.namespaceKeys.keys()].sort();

    const namespaces: IndexEntry[] = [];
    for (const namespace of sortedNamespaces) {
        if (namespace.startsWith('<<')) continue; // skip <<bare>> sentinel
        const keys = extracted.namespaceKeys.get(namespace) ?? new Set<string>();
        const total = keys.size;
        const data = readNamespace(config, namespace, target);
        let filled = 0;
        for (const key of keys) {
            const v = getNestedValue(data, key);
            if (typeof v === 'string' && v.length > 0) filled++;
        }
        namespaces.push({name: namespace, total, filled});
    }

    return {
        locales: config.locales,
        sourceLocale: opts.sourceLocale,
        target,
        namespaces,
        unresolvedCalls: extracted.unresolvedCalls.length,
    };
}

function buildNamespace(
    config: Config,
    opts: UiServerOptions,
    cache: CacheHandle,
    namespace: string,
): NamespacePayload | null {
    const extracted = cache.getExtract();
    const keySet = extracted.namespaceKeys.get(namespace);
    if (!keySet) return null;

    const usages = extracted.namespaceUsages
        .filter(u => u.namespace === namespace)
        .map(u => ({file: u.file, line: u.line}))
        .slice(0, 5);

    const keys = [...keySet].sort();
    const data: Record<string, JsonObject> = {};
    for (const locale of config.locales) {
        data[locale] = readNamespace(config, namespace, locale);
    }

    const keyEntries: KeyEntry[] = keys.map(key => {
        const values: Record<string, string> = {};
        for (const locale of config.locales) {
            const v = getNestedValue(data[locale], key);
            values[locale] = typeof v === 'string' ? v : '';
        }
        const sourcePlaceholders = parsePlaceholders(values[opts.sourceLocale]).names;
        return {key, values, sourcePlaceholders, usages};
    });

    return {name: namespace, keys: keyEntries};
}

interface PatchResult {
    status: number;
    body: unknown;
}

function applyTranslation(config: Config, body: PatchBody): PatchResult {
    const namespace = typeof body.namespace === 'string' ? body.namespace : '';
    const key = typeof body.key === 'string' ? body.key : '';
    const locale = typeof body.locale === 'string' ? body.locale : '';
    const value = typeof body.value === 'string' ? body.value : null;

    if (!namespace || !key || !locale || value === null) {
        return {
            status: 400,
            body: {error: 'expected JSON body {namespace, key, locale, value} (all strings)'},
        };
    }
    if (!config.locales.includes(locale)) {
        return {status: 400, body: {error: `unknown locale: ${locale}`}};
    }

    const data = readNamespace(config, namespace, locale);
    setNestedValue(data, key, value);
    writeNamespace(config, namespace, locale, data);

    const placeholders = parsePlaceholders(value);
    return {
        status: 200,
        body: {
            ok: true,
            placeholders: placeholders.names,
            malformed: placeholders.malformed,
        },
    };
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = path.normalize(path.join(CLIENT_DIR, rel));
    // Path-traversal guard — resolved file must stay under CLIENT_DIR.
    if (!target.startsWith(CLIENT_DIR + path.sep) && target !== CLIENT_DIR) {
        sendJson(res, 403, {error: 'forbidden'});
        return;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        sendJson(res, 404, {error: `not found: ${pathname}`});
        return;
    }
    const ext = path.extname(target).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    res.writeHead(200, {'Content-Type': mime, 'Cache-Control': 'no-store'});
    fs.createReadStream(target).pipe(res);
}

function readJsonBody(req: http.IncomingMessage): Promise<PatchBody> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', chunk => {
            chunks.push(chunk);
            total += chunk.length;
            if (total > 1_000_000) {
                req.destroy();
                reject(new Error('request body too large'));
            }
        });
        req.on('end', () => {
            if (total === 0) return resolve({});
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
                resolve(JSON.parse(raw) as PatchBody);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                reject(new Error(`malformed JSON body: ${msg}`));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload).toString(),
    });
    res.end(payload);
}
