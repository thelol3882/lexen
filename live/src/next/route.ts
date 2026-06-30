/**
 * @thelol3882/lexen-live/next/route — thin Next.js App Router Route Handler.
 *
 * Usage in the app (src/app/api/lexen-live/[[...op]]/route.ts):
 *
 *   export { GET, POST } from '@thelol3882/lexen-live/next/route';
 *
 * This module re-exports the shared `handle` function from server/index.ts as
 * both `GET` and `POST` named exports.  Next.js App Router calls the matching
 * export for each HTTP method; `handle` dispatches internally on `req.method`,
 * so the same function safely serves both verbs.
 *
 * URL structure (from [[...op]] catch-all):
 *   GET  /api/lexen-live/config           → LiveConfigResponse (JSON)
 *   GET  /api/lexen-live/key?ns=&key=     → LiveKeyResponse   (JSON)
 *   POST /api/lexen-live/save             → SaveResponse      (JSON)
 *
 * Security (enforced inside handle / server/index.ts):
 *   - 404 when NODE_ENV !== 'development' (belt-and-suspenders; the package is
 *     already a devDependency so prod module tracing won't include it).
 *   - 403 for cross-origin requests (Origin allowlist: localhost / 127.0.0.1).
 *   - 403 when POST is missing X-Lexen-Live: 1 header (CSRF guard).
 *   - 415 when POST Content-Type is not application/json.
 *   - 403 for path-traversal attempts (resolved path outside absSrcDir).
 *
 * Production safety proof:
 *   The package is listed as a DEVDEPENDENCY of the app so Next's
 *   `output: 'standalone'` module tracer never copies it into .next/standalone.
 *   scripts/verify-no-markers.mjs (mandatory CI gate) additionally greps
 *   .next/static and .next/server for lexen-live sentinel strings after
 *   `next build` and fails the build on any match.
 */

// ---------------------------------------------------------------------------
// Re-export shared protocol types for app-side typing convenience
// ---------------------------------------------------------------------------

export type {
    KeyRef,
    SaveRequest,
    SaveResponse,
    KeyResponse,
    ConfigResponse,
} from '../shared/protocol.js';

// ---------------------------------------------------------------------------
// Next.js App Router named exports
// ---------------------------------------------------------------------------

/**
 * Next.js App Router GET handler.
 * Delegates to `handle(req)` which routes on the last URL path segment.
 *
 * Outside `NODE_ENV=development`, handle() returns 404 immediately.
 */
export { handle as GET } from '../server/index.js';

/**
 * Next.js App Router POST handler.
 * Delegates to `handle(req)` which routes on the last URL path segment.
 *
 * Requires the X-Lexen-Live: 1 header to guard against CSRF.
 * Outside `NODE_ENV=development`, handle() returns 404 immediately.
 */
export { handle as POST } from '../server/index.js';
