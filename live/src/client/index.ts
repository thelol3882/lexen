'use client';
/**
 * @thelol3882/lexen-live/client — public browser / React client entry.
 *
 * PRODUCTION SAFETY: The consuming app must guard its import of this module
 * behind the same `NODE_ENV !== 'production' && NEXT_PUBLIC_LEXEN_LIVE` literal
 * check.  LexenLiveProvider itself has a prod-passthrough path with zero dev
 * overhead, but the safest posture is to not ship this module to prod at all.
 *
 * Exports:
 *   LexenLiveProvider   — drop-in for <NextIntlClientProvider>; owns the
 *                          marker-wrapping + observer + panel lifecycle.
 *   stripMarkers(s)     — remove all marker codepoints from a string; use for
 *                          any === / .length / Number() / Date() call on a
 *                          translated string in dev.
 *   raw                 — alias for stripMarkers.
 *
 * Protocol types are also re-exported so the consuming app can import them
 * without reaching into the shared sub-path.
 */

// ---------------------------------------------------------------------------
// Core export
// ---------------------------------------------------------------------------

export { LexenLiveProvider } from './provider.js';
export type { LexenLiveProviderProps } from './provider.js';

// ---------------------------------------------------------------------------
// stripMarkers / raw — escape hatch for app code that does === / .length / etc.
// ---------------------------------------------------------------------------

export { stripMarkers } from './markers.js';

/**
 * Alias for stripMarkers — use whichever reads more clearly at the call site.
 *
 * Example:
 *   const title = raw(t('page.title'));
 *   if (title === expectedTitle) { ... }  // safe: no invisible codepoints
 */
export { stripMarkers as raw } from './markers.js';

// ---------------------------------------------------------------------------
// Protocol type re-exports
// ---------------------------------------------------------------------------

export type {
    KeyRef,
    SaveRequest,
    SaveResponse,
    KeyResponse,
    ConfigResponse,
} from '../shared/protocol.js';
