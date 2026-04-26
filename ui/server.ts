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

// Resolve the static client directory. When this file lives in dist/ui/, the
// copy script places assets next to it under dist/ui/client. In dev (tsx) we
// run from source, where ui/client/ sits beside ui/server.ts.
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

interface NamespaceEntry {
    name: string;
    keys: KeyEntry[];
}

interface StateResponse {
    locales: string[];
    sourceLocale: string;
    namespaces: NamespaceEntry[];
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

    // Per-server cache for extractAll. The TS-compiler pass costs seconds on
    // large projects (7k+ keys); calling it on every /api/state request makes
    // navigation feel sluggish. Cache for the lifetime of the server process.
    // POST /api/refresh clears it so devs can pick up newly added t() calls
    // without restarting.
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

    if (req.method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, buildState(config, opts, cache));
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

function buildState(config: Config, opts: UiServerOptions, cache: CacheHandle): StateResponse {
    const extracted = cache.getExtract();

    const usagesByNs = new Map<string, {file: string; line: number}[]>();
    for (const u of extracted.namespaceUsages) {
        const list = usagesByNs.get(u.namespace) ?? [];
        list.push({file: u.file, line: u.line});
        usagesByNs.set(u.namespace, list);
    }

    const namespaces: NamespaceEntry[] = [];
    const sortedNamespaces = [...extracted.namespaceKeys.keys()].sort();

    for (const namespace of sortedNamespaces) {
        if (namespace.startsWith('<<')) continue; // skip <<bare>> sentinel
        const keys = [...(extracted.namespaceKeys.get(namespace) ?? new Set<string>())].sort();
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
            return {
                key,
                values,
                sourcePlaceholders,
                usages: (usagesByNs.get(namespace) ?? []).slice(0, 5),
            };
        });

        namespaces.push({name: namespace, keys: keyEntries});
    }

    return {
        locales: config.locales,
        sourceLocale: opts.sourceLocale,
        namespaces,
        unresolvedCalls: extracted.unresolvedCalls.length,
    };
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
    // Block path traversal — resolved file must stay under CLIENT_DIR.
    const target = path.normalize(path.join(CLIENT_DIR, rel));
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
            // 1 MB ceiling — translation payloads are tiny; anything larger is malformed.
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
