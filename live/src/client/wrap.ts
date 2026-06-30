/**
 * @thelol3882/lexen-live — pure message-tree wrapper.
 *
 * wrapMessages: deterministic pre-order deep clone of a next-intl messages
 * object that boundary-prefix-marks every non-empty leaf string with an
 * invisible-Unicode marker (encode(id) from ./markers.ts).
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM GUARANTEE
 * ---------------------------------------------------------------------------
 * - id assignment follows a single pre-order walk in native JSON key order
 *   (Object.keys preserves insertion order, which equals JSON parse order).
 * - nextId starts at 0 on every call — there is NO module-level counter.
 * - Identical input `messages` → identical wrapped output and identical
 *   registry Map contents across any number of calls.
 * - This ensures the SSR pass and the client hydration pass of React produce
 *   byte-identical marked strings, eliminating React 19 hydration mismatches.
 *
 * ---------------------------------------------------------------------------
 * NAMESPACE-DERIVATION CONTRACT (mirrors lexen resolveNamespaceScope)
 * ---------------------------------------------------------------------------
 * The `widgetPrefix` option names the top-level key that signals a widget
 * namespace (default "widget", read from GET /api/lexen-live/config).
 *
 * For a path [ topKey, ...rest ] of a leaf string:
 *   If topKey === widgetPrefix AND rest.length >= 1:
 *     namespace = `${widgetPrefix}.${rest[0]}`   e.g. "widget.active-booking"
 *     dotKey    = rest.slice(1).join('.')         e.g. "label"
 *   Otherwise:
 *     namespace = topKey                          e.g. "auth"
 *     dotKey    = rest.join('.')                  e.g. "login.title"
 *
 * This mirrors lexen's resolveNamespaceScope so that the client-side registry
 * and the server-side write-back agree on the canonical namespace string.
 */

import type { KeyRef } from '../shared/protocol.js';
import { encode } from './markers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A plain JSON-serializable object — the shape of a next-intl messages tree. */
export type Messages = Record<string, unknown>;

/** Return type of wrapMessages. */
export interface WrapResult {
    /**
     * Deep clone of the input messages with every non-empty leaf string
     * prefixed by its 12-character invisible-Unicode marker.
     * Pass this as the `messages` prop of <NextIntlClientProvider>.
     */
    wrapped: Messages;

    /**
     * Maps each assigned integer id to its { namespace, dotKey } reference.
     * The client-side MutationObserver reads this registry to turn a decoded
     * id from a marked DOM text node into a KeyRef for the edit panel.
     */
    registry: Map<number, KeyRef>;
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Derives the { namespace, dotKey } KeyRef for a leaf at `pathParts`.
 * The derivation mirrors lexen's resolveNamespaceScope so the client and
 * server sides agree on the canonical namespace string without any RPC.
 */
function deriveRef(pathParts: string[], widgetPrefix: string): KeyRef {
    const topKey = pathParts[0] ?? '';
    const rest = pathParts.slice(1);

    if (topKey === widgetPrefix && rest.length >= 1) {
        // Widget: namespace = "widget.<child>", dotKey = remaining path
        const child = rest[0];
        const remaining = rest.slice(1);
        return {
            namespace: `${topKey}.${child}`,
            dotKey: remaining.join('.'),
        };
    }

    // Regular feature/global namespace
    return {
        namespace: topKey,
        dotKey: rest.join('.'),
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure deterministic wrapper: deep-clones `messages`, prefix-marking every
 * non-empty leaf string with an invisible-Unicode ID marker.
 *
 * Skipped values (passed through unchanged):
 *   - Empty strings (no content to identify)
 *   - null, numbers, booleans (not translation strings)
 *   - Arrays (not typical in next-intl messages; skipped for safety)
 *
 * @param messages      The next-intl messages object (flat or nested JSON tree).
 * @param options.widgetPrefix  Top-level key that signals a widget namespace
 *                              (from GET /api/lexen-live/config; typically "widget").
 * @returns { wrapped, registry }
 */
export function wrapMessages(
    messages: Messages,
    options: { widgetPrefix: string },
): WrapResult {
    const { widgetPrefix } = options;
    const registry = new Map<number, KeyRef>();
    let nextId = 0;

    function walkNode(val: unknown, pathParts: string[]): unknown {
        if (typeof val === 'string') {
            // Skip empty strings — no visible content to anchor an edit panel to
            if (val.length === 0) return val;

            const ref = deriveRef(pathParts, widgetPrefix);
            const id = nextId++;
            registry.set(id, ref);
            // Prefix with the marker; the original string (including any ICU
            // argument braces) is untouched and follows immediately after.
            return encode(id) + val;
        }

        if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            // Recurse into nested objects; Object.keys preserves JSON key order
            const obj = val as Record<string, unknown>;
            const result: Record<string, unknown> = {};
            for (const key of Object.keys(obj)) {
                result[key] = walkNode(obj[key], [...pathParts, key]);
            }
            return result;
        }

        // null, number, boolean, Array — pass through unchanged
        return val;
    }

    const wrapped = walkNode(messages, []) as Messages;
    return { wrapped, registry };
}
