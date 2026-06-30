/**
 * @thelol3882/lexen-live — marker codec.
 *
 * Pure functions, no module-level state, no side-effects.
 * Constants and format spec live in src/shared/markers-spec.ts.
 *
 * Marker format (MARKER_LENGTH = 12 chars):
 *   [MARKER_START (U+2060)][body: 10 chars from MARKER_ALPHABET][MARKER_END (U+200B)]
 *
 * Body encoding: body[i] encodes bits (i*2)..(i*2+1) of the 20-bit id.
 *   body[0] = bits 0-1 (LSB), body[9] = bits 18-19 (MSB).
 *   Each char is one of MARKER_ALPHABET[0..3] (U+200B, U+200C, U+200D, U+2060).
 *
 * Placement: PREFIX-ONLY. Every marked leaf string starts with the 12-char
 * marker. This keeps the marker outside ICU argument braces, so
 * plural/select/number/date formatting is unaffected. A pure ICU message like
 * "{count,plural,one{# item}other{# items}}" becomes:
 *   "<MARKER>{count,plural,one{# item}other{# items}}"
 * which parses as: literal("<MARKER>") + argumentElement(...) — valid ICU.
 */

import {
    MARKER_START,
    MARKER_END,
    MARKER_ALPHABET,
    MARKER_BODY_LENGTH,
    MARKER_LENGTH,
    MAX_MARKER_IDS,
} from '../shared/markers-spec.js';

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Returns the index (0-3) of codepoint ch in MARKER_ALPHABET, or -1 if not found.
 * Written as a manual loop to avoid TypeScript's strict const-tuple indexOf
 * signature which requires the exact union type, not string.
 */
function alphabetIndex(ch: string): number {
    for (let i = 0; i < MARKER_ALPHABET.length; i++) {
        if (MARKER_ALPHABET[i] === ch) return i;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encodes a non-negative integer `id` into a 12-character invisible-Unicode
 * marker prefix string:
 *
 *   MARKER_START + body[0..9] + MARKER_END
 *
 * Body encoding: body[i] = MARKER_ALPHABET[(id >> (i*2)) & 3]
 * (body[0] carries the 2 least-significant bits; body[9] the 2 most-significant).
 *
 * IDs outside [0, MAX_MARKER_IDS) are taken modulo MAX_MARKER_IDS.
 */
export function encode(id: number): string {
    // Clamp to unsigned 32-bit then take modulo to stay within 20-bit range
    const safeId = ((id | 0) >>> 0) % MAX_MARKER_IDS;
    const body = new Array<string>(MARKER_BODY_LENGTH);
    for (let i = 0; i < MARKER_BODY_LENGTH; i++) {
        body[i] = MARKER_ALPHABET[(safeId >>> (i * 2)) & 0b11];
    }
    return MARKER_START + body.join('') + MARKER_END;
}

/**
 * Scans `text` for a valid marker (START sentinel + MARKER_BODY_LENGTH body
 * chars from MARKER_ALPHABET + END sentinel) and returns the decoded 20-bit
 * integer id, or null if no valid marker is found.
 *
 * The scan is forward-only and handles false positives (a MARKER_START
 * codepoint that does not form a complete valid marker) by advancing past the
 * candidate start and retrying.
 *
 * In the common case (prefix-only placement), the marker is at position 0 and
 * the first scan iteration succeeds immediately.
 */
export function decode(text: string): number | null {
    let searchFrom = 0;
    while (searchFrom < text.length) {
        const startIdx = text.indexOf(MARKER_START, searchFrom);
        if (startIdx === -1) return null;

        // Not enough characters remaining for a full marker
        if (startIdx + MARKER_LENGTH > text.length) return null;

        // The END sentinel must appear at the fixed offset after the body
        if (text[startIdx + MARKER_BODY_LENGTH + 1] !== MARKER_END) {
            searchFrom = startIdx + 1;
            continue;
        }

        // Decode the MARKER_BODY_LENGTH body chars, each encoding 2 bits
        let decodedId = 0;
        let valid = true;
        for (let i = 0; i < MARKER_BODY_LENGTH; i++) {
            const val = alphabetIndex(text[startIdx + 1 + i]);
            if (val === -1) {
                // Character not in MARKER_ALPHABET — not a genuine marker
                valid = false;
                break;
            }
            decodedId |= val << (i * 2);
        }

        if (valid) return decodedId;
        searchFrom = startIdx + 1;
    }
    return null;
}

/**
 * Removes all four invisible-Unicode sentinel codepoints from `s`:
 *   U+200B  ZERO-WIDTH SPACE
 *   U+200C  ZERO-WIDTH NON-JOINER
 *   U+200D  ZERO-WIDTH JOINER
 *   U+2060  WORD JOINER
 *
 * Use this escape hatch in application code that performs ===, .length,
 * .slice, Number(), or Date() comparisons on a translated string at runtime.
 * The panel and write-back path strip markers before sending values to the
 * server, so stripping is NOT needed for normal next-intl usage.
 */
export function stripMarkers(s: string): string {
    // Remove all four sentinel codepoints using explicit Unicode escapes:
    //   ​ = ZERO-WIDTH SPACE  (MARKER_END and ALPHABET[0])
    //   ‌ = ZERO-WIDTH NON-JOINER  (ALPHABET[1])
    //   ‍ = ZERO-WIDTH JOINER  (ALPHABET[2])
    //   ⁠ = WORD JOINER  (MARKER_START and ALPHABET[3])
    // eslint-disable-next-line no-misleading-character-class
    return s.replace(/[​‌‍⁠]/g, '');
}
