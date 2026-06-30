/**
 * @thelol3882/lexen-live — marker sentinel constants and namespace-derivation contract.
 *
 * PURE constants — no imports, no runtime side-effects.
 * Imported by:
 *   - src/client/codec.ts      (encodes IDs into marker strings)
 *   - src/client/observer.ts   (strips markers from DOM text; looks up IDs)
 *   - src/client/index.ts      (walks messages tree, stamps markers)
 *   - src/server/index.ts      (strips markers from any stored value that leaked)
 *
 * ---------------------------------------------------------------------------
 * DESIGN: Architecture A — message-value boundary-prefix marking
 * ---------------------------------------------------------------------------
 *
 * In dev, @lexen/live's <LexenLiveProvider> deep-clones the next-intl
 * `messages` tree and prefixes every LEAF STRING value with an invisible
 * Unicode marker BEFORE the string is handed to next-intl's ICU compiler.
 *
 * Because the marker is a zero-width PREFIX at the string boundary, it lands
 * in IntlMessageFormat's first literal chunk OUTSIDE any `{...}` ICU argument
 * braces.  A pure `{count,plural,...}` message becomes:
 *
 *   "<MARKER>{count,plural,one{1 item}other{# items}}"
 *
 * This parses as `literal("<MARKER>") + argumentElement(...)` which is valid
 * ICU — plural/select/interpolation/number/date formatting is untouched.
 *
 * The walk is a pure function in JSON key order (pre-order depth-first),
 * so SSR and client passes assign byte-identical marker prefixes → no React 19
 * hydration mismatch.
 *
 * ---------------------------------------------------------------------------
 * MARKER FORMAT (12 characters per marker)
 * ---------------------------------------------------------------------------
 *
 *  Position  Content          Codepoint     Role
 *  --------  -------          ----------    ----
 *  0         START            U+2060        Fixed header sentinel (WORD JOINER)
 *  1–10      body[0..9]       one of ALPHA  20-bit ID, 2 bits per char (10 chars)
 *  11        END              U+200B        Fixed tail sentinel (ZERO-WIDTH SPACE)
 *
 * Body encoding: each body char encodes 2 bits of the ID (MSB first):
 *   0b00 → U+200B  (ZERO-WIDTH SPACE)
 *   0b01 → U+200C  (ZERO-WIDTH NON-JOINER)
 *   0b10 → U+200D  (ZERO-WIDTH JOINER)
 *   0b11 → U+2060  (WORD JOINER)
 *
 * To encode ID n (0 ≤ n < 2^20):
 *   for i in 9..0: body[i] = ALPHABET[(n >> (i*2)) & 0b11]
 *
 * To decode: for each body[i], find its index in ALPHABET, shift left (i*2),
 * OR into accumulator.
 *
 * ---------------------------------------------------------------------------
 * NAMESPACE-DERIVATION CONTRACT (observer ↔ provider)
 * ---------------------------------------------------------------------------
 *
 * During the provider's messages-tree walk a module-level Map is populated:
 *
 *   markerMap: Map<number, KeyRef>  (id → { namespace, dotKey })
 *
 * The map lives in src/client/codec.ts and is populated by the provider
 * (src/client/index.ts) on EVERY render (SSR and client), ensuring SSR-rendered
 * DOM text nodes are correctly resolved on client hydration.
 *
 * The observer (src/client/observer.ts) reads markerMap to turn a raw 20-bit ID
 * extracted from a DOM text node into a KeyRef for the panel.
 *
 * ---------------------------------------------------------------------------
 * PRODUCTION SAFETY
 * ---------------------------------------------------------------------------
 *
 * This module and all importers are behind a literal
 *   `process.env.NODE_ENV !== 'production'` && `process.env.NEXT_PUBLIC_LEXEN_LIVE`
 * guard in src/client/index.ts.  A mandatory CI gate
 * (scripts/verify-no-markers.mjs — NOT in this file) greps .next/static and
 * .next/server for SENTINEL_CODEPOINTS and for the literal symbol strings
 * after `next build`; any hit fails the build.
 */

// ---------------------------------------------------------------------------
// Marker structure constants
// ---------------------------------------------------------------------------

/** Fixed header sentinel: U+2060 WORD JOINER */
export const MARKER_START = '⁠' as const;

/** Fixed tail sentinel: U+200B ZERO-WIDTH SPACE */
export const MARKER_END = '​' as const;

/**
 * Encoding alphabet — 4 codepoints used as 2-bit digits in the body.
 * Index is the 2-bit value (0–3); value is the codepoint.
 *
 * All four codepoints are invisible in virtually every rendering context
 * (browser, terminal, copy-paste, JSON diff) and appear as zero-width
 * characters in all major fonts.
 */
export const MARKER_ALPHABET = [
    '​', // 0b00  ZERO-WIDTH SPACE
    '‌', // 0b01  ZERO-WIDTH NON-JOINER
    '‍', // 0b10  ZERO-WIDTH JOINER
    '⁠', // 0b11  WORD JOINER
] as const;

/** Type of the 4-element alphabet tuple. */
export type MarkerAlphabet = typeof MARKER_ALPHABET;

// ---------------------------------------------------------------------------
// ID space
// ---------------------------------------------------------------------------

/**
 * Number of bits in the marker ID.
 * 20 bits → up to 1 048 576 unique keys per dev session.
 */
export const ID_BITS = 20;

/**
 * Maximum number of distinct IDs before wrap-around (2^ID_BITS = 1 048 576).
 * If a project exceeds this, the codec increments modulo MAX_MARKER_IDS and
 * logs a console.warn (implementation in src/client/codec.ts).
 */
export const MAX_MARKER_IDS = 1 << ID_BITS; // 1_048_576

// ---------------------------------------------------------------------------
// Derived structure lengths
// ---------------------------------------------------------------------------

/**
 * Number of body characters needed to encode ID_BITS bits at 2 bits per char.
 * = ceil(20 / 2) = 10.
 */
export const MARKER_BODY_LENGTH = Math.ceil(ID_BITS / 2); // 10

/**
 * Total length in characters of one complete marker prefix:
 * 1 (START) + MARKER_BODY_LENGTH (body) + 1 (END) = 12.
 */
export const MARKER_LENGTH = 1 + MARKER_BODY_LENGTH + 1; // 12

// ---------------------------------------------------------------------------
// Sentinel set (for bundle-proof grep)
// ---------------------------------------------------------------------------

/**
 * The four codepoints that MUST NOT appear in any `.next/static/**` or
 * `.next/server/**` file after `next build`.
 *
 * scripts/verify-no-markers.mjs greps for these as a mandatory CI gate.
 * Exported here as a single authoritative source so the grep pattern and the
 * codec stay in sync.
 */
export const SENTINEL_CODEPOINTS = [
    '​', // ZERO-WIDTH SPACE
    '‌', // ZERO-WIDTH NON-JOINER
    '‍', // ZERO-WIDTH JOINER
    '⁠', // WORD JOINER
] as const;

/** Type of the sentinel codepoints tuple. */
export type SentinelCodepoint = (typeof SENTINEL_CODEPOINTS)[number];

// ---------------------------------------------------------------------------
// Sanity assertions (evaluated at module load time, compile-time checkable)
// ---------------------------------------------------------------------------

// MARKER_ALPHABET must have exactly 4 entries (one per 2-bit value 0–3).
// This is enforced by the `as const` tuple type and the MarkerAlphabet type.
// Runtime check below catches any future refactor that accidentally changes
// the alphabet length (would only fire in dev, which is the only context this
// module loads in).
if (MARKER_ALPHABET.length !== 4) {
    throw new Error(
        `[lexen-live] MARKER_ALPHABET must have exactly 4 entries; got ${MARKER_ALPHABET.length}`
    );
}

if (MARKER_BODY_LENGTH * 2 < ID_BITS) {
    throw new Error(
        `[lexen-live] MARKER_BODY_LENGTH (${MARKER_BODY_LENGTH}) cannot encode ID_BITS (${ID_BITS})`
    );
}
