'use client';
/**
 * @thelol3882/lexen-live — LexenLiveProvider
 *
 * Drop-in replacement for <NextIntlClientProvider> that, in dev mode, stamps
 * every leaf string in the `messages` object with an invisible Unicode marker
 * and mounts the MutationObserver + side panel for live editing.
 *
 * PRODUCTION SAFETY
 * -----------------
 * The dev branch is behind a literal `process.env.NODE_ENV !== 'production'`
 * AND `process.env.NEXT_PUBLIC_LEXEN_LIVE` check.  Both are inlined by
 * Turbopack/Next as string literals, making the dead branch eligible for DCE.
 * The observer and panel are loaded via dynamic import() so they live in
 * separate chunks and are NEVER evaluated in the prod bundle.
 *
 * A mandatory post-build grep (scripts/verify-no-markers.mjs) asserts that no
 * sentinel codepoints or lexen-live symbols appear in .next/static/** or
 * .next/server/** after `next build`.
 */

import React, { useState, useEffect, useRef } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import type { NextIntlClientProviderProps } from 'next-intl';
import type { KeyRef, ConfigResponse } from '../shared/protocol.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props accepted by LexenLiveProvider — a superset of NextIntlClientProvider. */
export type LexenLiveProviderProps = NextIntlClientProviderProps;

interface PanelState {
    keyRef: KeyRef;
    rect: DOMRect;
}

// ---------------------------------------------------------------------------
// Dev provider (inner component — only instantiated when gate is true)
// ---------------------------------------------------------------------------

function DevProvider(props: LexenLiveProviderProps) {
    const { messages, ...rest } = props;

    const [wrappedMessages, setWrappedMessages] = useState<
        Record<string, unknown>
    >(messages as Record<string, unknown>);
    const [config, setConfig] = useState<ConfigResponse | null>(null);
    const [panelState, setPanelState] = useState<PanelState | null>(null);

    // Dynamically loaded Panel component — avoids eager bundling
    const [PanelComponent, setPanelComponent] = useState<
        React.ComponentType<import('./panel.js').PanelProps> | null
    >(null);

    const registryRef = useRef<Map<number, KeyRef>>(new Map());
    const cleanupObserverRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        let cancelled = false;

        // 1. Fetch config from the dev route handler
        fetch('/api/lexen-live/config')
            .then((r) => {
                if (!r.ok) throw new Error(`[lexen-live] config fetch failed (${r.status})`);
                return r.json() as Promise<ConfigResponse>;
            })
            .then((cfg) => {
                if (cancelled) return;
                setConfig(cfg);

                // 2. Dynamically import wrapMessages from wrap.ts (LIVE-CODEC)
                return Promise.all([
                    import('./wrap.js'),
                    import('./observer.js'),
                    import('./panel.js'),
                ] as const).then(([wrapMod, observerMod, panelMod]) => ({
                    cfg,
                    wrapMod,
                    observerMod,
                    panelMod,
                }));
            })
            .then((result) => {
                if (cancelled || !result) return;
                const { cfg, wrapMod, observerMod, panelMod } = result;

                // 3. Wrap messages using widgetPrefix from config
                const { wrapped, registry } = wrapMod.wrapMessages(
                    messages as Record<string, unknown>,
                    { widgetPrefix: 'widget' }
                );
                registryRef.current = registry;
                setWrappedMessages(wrapped);

                // Expose registry for the headless Playwright agent loop so it
                // can resolve markerId -> {namespace, dotKey} inside page.evaluate
                // without a server round-trip.  Keys are numeric IDs; they become
                // string keys in the plain object (Object.fromEntries coerces them).
                // Cleaned up in the effect cleanup function below.
                if (typeof window !== 'undefined') {
                    (window as unknown as Record<string, unknown>).__LEXEN_LIVE__ = {
                        registry: Object.fromEntries(registry),
                    };
                }

                // 4. Mount observer with the populated registry
                cleanupObserverRef.current = observerMod.initObserver({
                    registry,
                    onKeyClick: (keyRef, rect) =>
                        setPanelState({ keyRef, rect }),
                });

                // 5. Store Panel component type for React rendering
                setPanelComponent(
                    () =>
                        panelMod.Panel as React.ComponentType<
                            import('./panel.js').PanelProps
                        >
                );
                // cfg used for locale list; store it
                setConfig(cfg);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                console.warn('[lexen-live] DevProvider init failed:', err);
            });

        return () => {
            cancelled = true;
            cleanupObserverRef.current?.();
            cleanupObserverRef.current = null;
            // Remove the agent registry from window when the provider unmounts.
            if (typeof window !== 'undefined') {
                delete (window as unknown as Record<string, unknown>).__LEXEN_LIVE__;
            }
        };
        // Run once on mount; messages identity is stable from SSR serialisation.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <>
            <NextIntlClientProvider
                {...rest}
                messages={wrappedMessages as NextIntlClientProviderProps['messages']}
            />
            {panelState && PanelComponent && config && (
                <PanelComponent
                    keyRef={panelState.keyRef}
                    anchorRect={panelState.rect}
                    locales={config.locales}
                    onClose={() => setPanelState(null)}
                />
            )}
        </>
    );
}

// ---------------------------------------------------------------------------
// Public export: LexenLiveProvider
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for <NextIntlClientProvider>.
 *
 * In PRODUCTION (NODE_ENV === 'production' or NEXT_PUBLIC_LEXEN_LIVE unset):
 *   Renders the stock <NextIntlClientProvider> with the ORIGINAL untouched
 *   messages object.  Zero allocation, zero observer, zero dynamic imports.
 *
 * In DEVELOPMENT (NODE_ENV !== 'production' && NEXT_PUBLIC_LEXEN_LIVE set):
 *   Deep-clones messages and prefixes every leaf string with an invisible
 *   Unicode marker.  Mounts a single MutationObserver that maps marked text
 *   nodes to key references and opens a live-edit side panel on alt/cmd-click.
 *
 * Usage in providers.tsx:
 *   import { LexenLiveProvider } from '@thelol3882/lexen-live/client';
 *   // Replace <NextIntlClientProvider ...> with:
 *   <LexenLiveProvider locale={locale} messages={messages} timeZone="Asia/Almaty">
 *     {children}
 *   </LexenLiveProvider>
 */
export function LexenLiveProvider(props: LexenLiveProviderProps) {
    // LITERAL gate — Turbopack/Next inlines these as string literals so the
    // dead branch is DCE-eligible.  Never abstract this into a helper function.
    if (
        process.env.NODE_ENV !== 'production' &&
        process.env.NEXT_PUBLIC_LEXEN_LIVE
    ) {
        return <DevProvider {...props} />;
    }

    // Prod: zero overhead — stock provider, original messages, no extra allocations.
    return <NextIntlClientProvider {...props} />;
}
