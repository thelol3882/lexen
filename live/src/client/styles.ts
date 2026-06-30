/**
 * Inline CSS-in-JS style objects for the @lexen/live dev overlay panel.
 *
 * All styles live here so panel.tsx has zero external CSS dependencies.
 * No emoji, no animations that could leak into a11y tooling.
 */

type Style = Record<string, string | number>;

// ---------------------------------------------------------------------------
// Panel shell
// ---------------------------------------------------------------------------

/** Full-page transparent cover (pointer-events none) that catches clicks. */
export const overlayStyle: Style = {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483000',
    pointerEvents: 'none',
};

/** The floating panel container. Position is applied inline per DOMRect anchor. */
export const panelStyle: Style = {
    position: 'fixed',
    zIndex: '2147483001',
    width: '340px',
    maxHeight: '80vh',
    overflowY: 'auto',
    background: '#1e1e2e',
    border: '1px solid #45475a',
    borderRadius: '8px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
    fontSize: '12px',
    color: '#cdd6f4',
    pointerEvents: 'auto',
};

export const panelHeaderStyle: Style = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px 8px',
    borderBottom: '1px solid #313244',
    gap: '8px',
};

export const panelKeyPathStyle: Style = {
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: '#89b4fa',
    fontWeight: '600',
    fontSize: '11px',
};

export const panelCloseButtonStyle: Style = {
    flexShrink: '0',
    background: 'none',
    border: 'none',
    color: '#6c7086',
    cursor: 'pointer',
    fontSize: '16px',
    lineHeight: '1',
    padding: '0 2px',
};

// ---------------------------------------------------------------------------
// Panel body
// ---------------------------------------------------------------------------

export const panelBodyStyle: Style = {
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
};

export const localeRowStyle: Style = {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
};

export const localeLabelStyle: Style = {
    fontSize: '10px',
    fontWeight: '700',
    textTransform: 'uppercase',
    color: '#a6adc8',
    letterSpacing: '0.05em',
};

export const localeInputStyle: Style = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 8px',
    background: '#181825',
    border: '1px solid #45475a',
    borderRadius: '4px',
    color: '#cdd6f4',
    fontFamily: 'inherit',
    fontSize: '12px',
    resize: 'vertical',
    minHeight: '56px',
};

export const localeInputFocusStyle: Style = {
    borderColor: '#89b4fa',
    outline: 'none',
};

export const readonlyValueStyle: Style = {
    padding: '6px 8px',
    background: '#11111b',
    border: '1px solid #313244',
    borderRadius: '4px',
    color: '#6c7086',
    fontSize: '12px',
    fontFamily: 'inherit',
    minHeight: '32px',
    wordBreak: 'break-word',
};

// ---------------------------------------------------------------------------
// Hints / badges
// ---------------------------------------------------------------------------

export const hintBarStyle: Style = {
    padding: '6px 12px',
    borderTop: '1px solid #313244',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
    alignItems: 'center',
};

export const badgeStyle: Style = {
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: '999px',
    fontSize: '10px',
    fontWeight: '600',
};

export const placeholderBadgeStyle: Style = {
    ...badgeStyle,
    background: '#313244',
    color: '#cba6f7',
};

export const spaceBudgetBadgeStyle: Style = {
    ...badgeStyle,
    background: '#1e3a5f',
    color: '#89b4fa',
};

export const dynamicBadgeStyle: Style = {
    ...badgeStyle,
    background: '#3b2f00',
    color: '#f9e2af',
};

export const richBadgeStyle: Style = {
    ...badgeStyle,
    background: '#2b1f00',
    color: '#fab387',
};

// ---------------------------------------------------------------------------
// Footer actions
// ---------------------------------------------------------------------------

export const panelFooterStyle: Style = {
    padding: '8px 12px 10px',
    borderTop: '1px solid #313244',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    alignItems: 'center',
};

export const saveButtonStyle: Style = {
    padding: '5px 14px',
    background: '#89b4fa',
    border: 'none',
    borderRadius: '4px',
    color: '#1e1e2e',
    fontFamily: 'inherit',
    fontSize: '12px',
    fontWeight: '700',
    cursor: 'pointer',
};

export const cancelButtonStyle: Style = {
    padding: '5px 14px',
    background: 'none',
    border: '1px solid #45475a',
    borderRadius: '4px',
    color: '#a6adc8',
    fontFamily: 'inherit',
    fontSize: '12px',
    cursor: 'pointer',
};

// ---------------------------------------------------------------------------
// Status / feedback
// ---------------------------------------------------------------------------

export const statusBarStyle: Style = {
    padding: '6px 12px',
    fontSize: '11px',
    borderTop: '1px solid #313244',
};

export const statusOkStyle: Style = {
    ...statusBarStyle,
    color: '#a6e3a1',
};

export const statusErrorStyle: Style = {
    ...statusBarStyle,
    color: '#f38ba8',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
};

export const statusWarnStyle: Style = {
    ...statusBarStyle,
    color: '#f9e2af',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
};

export const loadingStyle: Style = {
    padding: '24px 12px',
    textAlign: 'center',
    color: '#6c7086',
    fontSize: '12px',
};
