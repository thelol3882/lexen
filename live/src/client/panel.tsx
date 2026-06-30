'use client';
/**
 * @thelol3882/lexen-live — side-panel React component.
 *
 * DEV-ONLY. Loaded via dynamic import() from provider.tsx so it never enters
 * the prod bundle.
 *
 * Shows: namespace + key path, per-locale editable values, placeholders hint,
 * spaceBudget badge.  Dynamic keys and rich-text values render read-only with
 * an explanatory badge.
 *
 * Communication:
 *   GET  /api/lexen-live/key?ns=<ns>&key=<dotKey>  → KeyResponse (+extras)
 *   POST /api/lexen-live/save  { ref, updates }     → SaveResponse
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { KeyRef, KeyResponse, SaveRequest, SaveResponse } from '../shared/protocol.js';
import {
    panelStyle,
    panelHeaderStyle,
    panelKeyPathStyle,
    panelCloseButtonStyle,
    panelBodyStyle,
    localeRowStyle,
    localeLabelStyle,
    localeInputStyle,
    readonlyValueStyle,
    hintBarStyle,
    placeholderBadgeStyle,
    spaceBudgetBadgeStyle,
    dynamicBadgeStyle,
    richBadgeStyle,
    panelFooterStyle,
    saveButtonStyle,
    cancelButtonStyle,
    statusOkStyle,
    statusErrorStyle,
    statusWarnStyle,
    loadingStyle,
} from './styles.js';

// ---------------------------------------------------------------------------
// Extended server response (the route handler may include extra fields)
// ---------------------------------------------------------------------------

interface KeyData extends KeyResponse {
    /** True when key is dynamic — panel renders values read-only. */
    dynamic?: boolean;
    /** Rich-text keys (t.rich/t.markup) — panel renders read-only. */
    isRich?: boolean;
    /** Optional translator context from collectKeyContexts. */
    context?: {
        callSite?: string;
        jsx?: { element?: string; attribute?: string; spaceBudget?: string };
        spaceBudget?: 'tight' | 'medium' | 'roomy';
        placeholders?: string[];
    };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PanelProps {
    keyRef: KeyRef;
    anchorRect: DOMRect;
    locales: string[];
    onClose: () => void;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const API_BASE = '/api/lexen-live';

async function fetchKeyData(keyRef: KeyRef): Promise<KeyData> {
    const params = new URLSearchParams({
        ns: keyRef.namespace,
        key: keyRef.dotKey,
    });
    const res = await fetch(`${API_BASE}/key?${params.toString()}`);
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`[lexen-live] GET /key failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<KeyData>;
}

async function saveValues(
    keyRef: KeyRef,
    updates: Record<string, string>
): Promise<SaveResponse> {
    const body: SaveRequest = { ref: keyRef, updates };
    const res = await fetch(`${API_BASE}/save`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Lexen-Live': '1',
        },
        body: JSON.stringify(body),
    });
    const data = (await res.json()) as SaveResponse;
    return data;
}

// ---------------------------------------------------------------------------
// Panel positioning
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 340;
const PANEL_GAP = 8;
const PANEL_MIN_TOP = 8;

function computePanelPosition(
    anchorRect: DOMRect
): { top: number; left: number } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = anchorRect.right + PANEL_GAP;
    if (left + PANEL_WIDTH > vw - PANEL_GAP) {
        // Flip to the left of the anchor
        left = anchorRect.left - PANEL_WIDTH - PANEL_GAP;
    }
    // Clamp left to viewport
    left = Math.max(PANEL_GAP, Math.min(left, vw - PANEL_WIDTH - PANEL_GAP));

    let top = anchorRect.top;
    top = Math.max(PANEL_MIN_TOP, Math.min(top, vh - 120));

    return { top, left };
}

// ---------------------------------------------------------------------------
// Panel component
// ---------------------------------------------------------------------------

export function Panel({ keyRef, anchorRect, locales, onClose }: PanelProps) {
    const [keyData, setKeyData] = useState<KeyData | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [editValues, setEditValues] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [saveResult, setSaveResult] = useState<SaveResponse | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    // -----------------------------------------------------------------------
    // Fetch key data on mount / when keyRef changes
    // -----------------------------------------------------------------------

    useEffect(() => {
        let cancelled = false;
        setKeyData(null);
        setLoadError(null);
        setSaveResult(null);
        setSaveError(null);

        fetchKeyData(keyRef)
            .then((data) => {
                if (cancelled) return;
                setKeyData(data);
                // Initialise edit values from current stored values
                const initial: Record<string, string> = {};
                for (const locale of locales) {
                    initial[locale] = data.values[locale] ?? '';
                }
                setEditValues(initial);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setLoadError(err instanceof Error ? err.message : String(err));
            });

        return () => {
            cancelled = true;
        };
    }, [keyRef.namespace, keyRef.dotKey, locales]);

    // -----------------------------------------------------------------------
    // Dismiss on Escape
    // -----------------------------------------------------------------------

    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape') onClose();
        }
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [onClose]);

    // -----------------------------------------------------------------------
    // Save handler
    // -----------------------------------------------------------------------

    const handleSave = useCallback(async () => {
        if (!keyData || saving) return;
        setSaving(true);
        setSaveResult(null);
        setSaveError(null);

        try {
            // Only send locales that actually changed
            const updates: Record<string, string> = {};
            for (const locale of locales) {
                const original = keyData.values[locale] ?? '';
                if (editValues[locale] !== original) {
                    updates[locale] = editValues[locale] ?? '';
                }
            }
            if (Object.keys(updates).length === 0) {
                onClose();
                return;
            }

            const result = await saveValues(keyRef, updates);
            setSaveResult(result);
            if (result.ok) {
                // Update local state to reflect saved values
                setKeyData((prev) =>
                    prev ? { ...prev, values: { ...prev.values, ...updates } } : prev
                );
            }
        } catch (err: unknown) {
            setSaveError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }, [keyData, keyRef, locales, editValues, saving, onClose]);

    // -----------------------------------------------------------------------
    // Position
    // -----------------------------------------------------------------------

    const { top, left } = computePanelPosition(anchorRect);

    const isReadOnly = Boolean(keyData?.dynamic || keyData?.isRich);

    // Combine placeholders from keyData.placeholders + context.placeholders
    const placeholders = Array.from(
        new Set([
            ...(keyData?.placeholders ?? []),
            ...(keyData?.context?.placeholders ?? []),
        ])
    );

    const spaceBudget =
        keyData?.context?.spaceBudget ?? keyData?.context?.jsx?.spaceBudget;

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    const containerStyle: Record<string, string | number> = {
        ...panelStyle,
        top: `${top}px`,
        left: `${left}px`,
    };

    return (
        <div
            ref={panelRef}
            style={containerStyle}
            role="dialog"
            aria-label="Lexen Live Editor"
            aria-modal="false"
        >
            {/* Header */}
            <div style={panelHeaderStyle}>
                <span style={panelKeyPathStyle} title={`${keyRef.namespace} / ${keyRef.dotKey}`}>
                    {keyRef.namespace}&nbsp;/&nbsp;{keyRef.dotKey}
                </span>
                <button
                    style={panelCloseButtonStyle}
                    onClick={onClose}
                    aria-label="Close panel"
                    type="button"
                >
                    x
                </button>
            </div>

            {/* Loading / error */}
            {!keyData && !loadError && (
                <div style={loadingStyle}>Loading...</div>
            )}
            {loadError && (
                <div style={statusErrorStyle}>{loadError}</div>
            )}

            {/* Body */}
            {keyData && (
                <div style={panelBodyStyle}>
                    {locales.map((locale) => (
                        <div key={locale} style={localeRowStyle}>
                            <label style={localeLabelStyle} htmlFor={`lexen-${locale}`}>
                                {locale}
                            </label>
                            {isReadOnly ? (
                                <div style={readonlyValueStyle}>
                                    {keyData.values[locale] ?? (
                                        <span style={{ color: '#6c7086' }}>(empty)</span>
                                    )}
                                </div>
                            ) : (
                                <textarea
                                    id={`lexen-${locale}`}
                                    style={localeInputStyle}
                                    value={editValues[locale] ?? ''}
                                    onChange={(e) =>
                                        setEditValues((prev) => ({
                                            ...prev,
                                            [locale]: e.target.value,
                                        }))
                                    }
                                    onFocus={(e) => {
                                        e.target.style.borderColor = '#89b4fa';
                                        e.target.style.outline = 'none';
                                    }}
                                    onBlur={(e) => {
                                        e.target.style.borderColor = '#45475a';
                                    }}
                                    rows={3}
                                    spellCheck={false}
                                />
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* Hint bar: badges */}
            {(isReadOnly || placeholders.length > 0 || spaceBudget) && (
                <div style={hintBarStyle}>
                    {keyData?.dynamic && (
                        <span style={dynamicBadgeStyle} title="Dynamic key — value cannot be statically written">
                            dynamic
                        </span>
                    )}
                    {keyData?.isRich && (
                        <span style={richBadgeStyle} title="Rich-text key (t.rich/t.markup) — edit in source">
                            rich
                        </span>
                    )}
                    {spaceBudget && (
                        <span style={spaceBudgetBadgeStyle} title="Approximate UI space budget">
                            {spaceBudget}
                        </span>
                    )}
                    {placeholders.map((p) => (
                        <span key={p} style={placeholderBadgeStyle} title="ICU placeholder — keep in translation">
                            {'{' + p + '}'}
                        </span>
                    ))}
                </div>
            )}

            {/* Save result feedback */}
            {saveResult && saveResult.ok && saveResult.warnings.length === 0 && (
                <div style={statusOkStyle}>Saved</div>
            )}
            {saveResult && saveResult.ok && saveResult.warnings.length > 0 && (
                <div style={statusWarnStyle}>
                    Saved with warnings:{'\n'}
                    {saveResult.warnings.join('\n')}
                </div>
            )}
            {saveResult && !saveResult.ok && (
                <div style={statusErrorStyle}>
                    Save blocked (code {saveResult.checkCode}):{'\n'}
                    {saveResult.warnings.join('\n') || saveResult.message}
                </div>
            )}
            {saveError && (
                <div style={statusErrorStyle}>{saveError}</div>
            )}

            {/* Footer */}
            {keyData && !isReadOnly && (
                <div style={panelFooterStyle}>
                    <button
                        style={cancelButtonStyle}
                        onClick={onClose}
                        type="button"
                        disabled={saving}
                    >
                        Cancel
                    </button>
                    <button
                        style={saveButtonStyle}
                        onClick={handleSave}
                        type="button"
                        disabled={saving}
                    >
                        {saving ? 'Saving...' : 'Save'}
                    </button>
                </div>
            )}
            {keyData && isReadOnly && (
                <div style={panelFooterStyle}>
                    <button
                        style={cancelButtonStyle}
                        onClick={onClose}
                        type="button"
                    >
                        Close
                    </button>
                </div>
            )}
        </div>
    );
}
