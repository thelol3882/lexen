/**
 * @thelol3882/lexen-live/server — Node.js-only write-back and read API.
 *
 * Public surface:
 *
 *   handle(req: Request): Promise<Response>
 *     Routes a standard Fetch API Request to the appropriate handler:
 *       GET  .../config           → getConfig()    → LiveConfigResponse
 *       GET  .../key?ns=&key=     → getKey()       → LiveKeyResponse
 *       POST .../save             → saveKey()      → SaveResponse
 *     Returns 404 for any other method/path combination.
 *
 * Re-exports the shared protocol types so callers only need one import.
 *
 * Security is layered:
 *   - assertDev() at the top of handle() → 404 outside development.
 *   - checkOrigin(req) → 403 for cross-origin requests.
 *   - X-Lexen-Live: 1 header required on POST → 403 on CSRF.
 *   - Content-Type: application/json required on POST → 415.
 *   - Path-traversal guard inside saveKey() → 403 via SecurityError.
 */

// ---------------------------------------------------------------------------
// Re-export protocol types (for consumers of "@thelol3882/lexen-live/server")
// ---------------------------------------------------------------------------

export type {
    KeyRef,
    SaveRequest,
    SaveResponse,
    KeyResponse,
    ConfigResponse,
} from '../shared/protocol.js';

export type {
    LiveConfigResponse,
    LiveKeyResponse,
    GetKeyError,
} from './writeback.js';

// ---------------------------------------------------------------------------
// Implementation imports
// ---------------------------------------------------------------------------

import { assertDev, checkOrigin, SecurityError } from './security.js';
import { getConfig, getKey, saveKey } from './writeback.js';
import type { SaveRequest } from '../shared/protocol.js';

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

/**
 * Route a standard Fetch API {@link Request} to the appropriate handler and
 * return a {@link Response}.
 *
 * Designed to be exported as both `GET` and `POST` from a Next.js App Router
 * Route Handler (`[[...op]]/route.ts`).  Routing is based on the last URL
 * path segment (`config`, `key`, `save`) and the HTTP method.
 *
 * All errors (security violations, validation failures, unexpected throws) are
 * caught here and returned as JSON `{ error: string }` responses with the
 * appropriate HTTP status code.
 */
export async function handle(req: Request): Promise<Response> {
    try {
        // Belt-and-suspenders dev gate: returns 404 outside development so
        // the endpoint doesn't reveal its existence in any other environment.
        assertDev();

        const url = new URL(req.url, 'http://localhost');
        // Extract the last non-empty path segment as the operation name.
        const segments = url.pathname.split('/').filter(Boolean);
        const op = segments[segments.length - 1] ?? '';
        const method = req.method.toUpperCase();

        // ------------------------------------------------------------------
        // GET /config — project shape (locales, widgetPrefix, namespaces)
        // ------------------------------------------------------------------
        if (method === 'GET' && op === 'config') {
            checkOrigin(req);
            return jsonResponse(getConfig());
        }

        // ------------------------------------------------------------------
        // GET /key?ns=<namespace>&key=<dotKey>
        // ------------------------------------------------------------------
        if (method === 'GET' && op === 'key') {
            checkOrigin(req);
            const ns = url.searchParams.get('ns') ?? '';
            const key = url.searchParams.get('key') ?? '';
            if (!ns || !key) {
                return jsonResponse(
                    { error: 'Missing required query params: ns, key' },
                    400,
                );
            }
            const result = getKey(ns, key);
            if ('error' in result) {
                return jsonResponse({ error: result.error }, result.status);
            }
            return jsonResponse(result);
        }

        // ------------------------------------------------------------------
        // POST /save — write one or more locale values and gate with runSync
        // ------------------------------------------------------------------
        if (method === 'POST' && op === 'save') {
            checkOrigin(req);

            // CSRF guard — the panel always sends this header.
            if (req.headers.get('x-lexen-live') !== '1') {
                return jsonResponse(
                    { error: 'Missing or invalid X-Lexen-Live: 1 header' },
                    403,
                );
            }

            // Content-Type guard before attempting to parse.
            const ct = req.headers.get('content-type') ?? '';
            if (!ct.includes('application/json')) {
                return jsonResponse(
                    { error: 'Content-Type must be application/json' },
                    415,
                );
            }

            let body: SaveRequest;
            try {
                body = (await req.json()) as SaveRequest;
            } catch {
                return jsonResponse({ error: 'Request body is not valid JSON' }, 400);
            }

            // Basic shape validation before handing to saveKey.
            if (
                !body?.ref?.namespace ||
                !body?.ref?.dotKey ||
                typeof body?.updates !== 'object' ||
                body.updates === null ||
                Array.isArray(body.updates)
            ) {
                return jsonResponse(
                    {
                        error:
                            'Body must be { ref: { namespace, dotKey }, updates: Record<locale, value> }',
                    },
                    400,
                );
            }

            const result = saveKey(body);
            return jsonResponse(result, result.ok ? 200 : 422);
        }

        // ------------------------------------------------------------------
        // Unknown op / method combination
        // ------------------------------------------------------------------
        return jsonResponse({ error: 'Not found' }, 404);

    } catch (err) {
        if (err instanceof SecurityError) {
            return jsonResponse({ error: err.message }, err.status);
        }
        // Unexpected error — surface a sanitised message.
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ error: `Internal error: ${message}` }, 500);
    }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
