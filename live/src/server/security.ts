/**
 * @thelol3882/lexen-live/server/security — request-level security guards.
 *
 * All functions throw {@link SecurityError} on violation; callers catch it
 * and turn it into an appropriate HTTP response.
 *
 * Three invariants enforced:
 *  1. Dev-only gate  — every handler calls {@link assertDev} first so the
 *     entire API is a no-op outside `NODE_ENV=development`.
 *  2. Origin allowlist — cross-origin POST/GET from non-localhost hosts are
 *     rejected to prevent CSRF from tabs open on other origins.
 *  3. Path-traversal guard — resolved locale file paths are asserted to lie
 *     inside the configured locales root so a crafted namespace cannot escape
 *     to arbitrary filesystem locations.
 */

import path from 'node:path';

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/**
 * Thrown by security guards when a request must be rejected.
 * `status` is the HTTP status code to send (403, 404, etc.).
 */
export class SecurityError extends Error {
    public readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'SecurityError';
        this.status = status;
    }
}

// ---------------------------------------------------------------------------
// Guard 1: dev-only gate
// ---------------------------------------------------------------------------

/**
 * Throw {@link SecurityError}(404) when not running in development mode.
 *
 * Returns 404 (rather than 403) so the endpoint does not reveal its existence
 * to a production scanner.  This is belt-and-suspenders — the package is
 * already a devDependency, so prod bundles should never contain it.
 */
export function assertDev(): void {
    if (process.env.NODE_ENV !== 'development') {
        throw new SecurityError(404, 'Not found');
    }
}

// ---------------------------------------------------------------------------
// Guard 2: Origin allowlist
// ---------------------------------------------------------------------------

/**
 * Throw {@link SecurityError}(403) when the request Origin is not
 * `localhost` or `127.0.0.1` (any port).
 *
 * Same-origin requests from the Next.js dev server may omit the Origin header
 * (navigation + same-origin fetch); those are allowed because no cross-site
 * cookie can be piggybacked.  Any explicit cross-origin header that isn't
 * localhost / 127.0.0.1 is rejected.
 */
export function checkOrigin(req: Request): void {
    const origin = req.headers.get('origin');
    // Same-origin or requests with no Origin header — allow.
    if (!origin) return;

    let parsed: URL;
    try {
        parsed = new URL(origin);
    } catch {
        throw new SecurityError(403, `Invalid Origin header: ${origin}`);
    }

    const { hostname } = parsed;
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
        throw new SecurityError(
            403,
            `Cross-origin request rejected (origin: ${origin}). ` +
            'lexen-live only accepts requests from localhost.',
        );
    }
}

// ---------------------------------------------------------------------------
// Guard 3: path-traversal guard
// ---------------------------------------------------------------------------

/**
 * Throw {@link SecurityError}(403) if `resolvedPath` is not inside any of
 * `allowedRoots`.
 *
 * Both `resolvedPath` and each entry of `allowedRoots` are normalised through
 * `path.resolve` before comparison so Windows drive-letter capitalisation,
 * mixed separators, and `..` segments cannot bypass the check.
 *
 * @param resolvedPath  Absolute path returned by `resolveLocalePath`.
 * @param allowedRoots  One or more absolute root directories the path must
 *                      be inside (typically just `config.absSrcDir`).
 */
export function assertPathInside(resolvedPath: string, allowedRoots: string[]): void {
    const normalized = path.resolve(resolvedPath);

    for (const root of allowedRoots) {
        const normalizedRoot = path.resolve(root);
        // Append the platform separator so "C:\foobar" does not falsely match
        // root "C:\foo".
        const withSep = normalizedRoot.endsWith(path.sep)
            ? normalizedRoot
            : normalizedRoot + path.sep;

        if (normalized === normalizedRoot || normalized.startsWith(withSep)) {
            return; // inside this root — safe
        }
    }

    throw new SecurityError(
        403,
        `Path-traversal guard: resolved file path is outside the allowed locale roots.`,
    );
}
