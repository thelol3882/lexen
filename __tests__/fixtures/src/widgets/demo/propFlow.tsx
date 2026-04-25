// Fixture for Phase-2 prop-flow resolution. `TransportCard` takes `t` as a
// prop; the parent passes `useTranslations('widget.demo')`. The keys called
// inside TransportCard must be attributed to `widget.demo`.
import {useTranslations} from 'next-intl';

function TransportCard({t}: {t: (key: string) => string}) {
    return (
        <>
            <span>{t('actions.edit')}</span>
            <span>{t('actions.delete')}</span>
        </>
    );
}

// Shorthand-property variant: a plain helper (not a JSX component) whose
// translator params are destructured from an object. Callers pass the
// translators via object-literal SHORTHAND (`{tWidget, tCommon}`). TypeScript's
// `getSymbolAtLocation` on a shorthand identifier returns the shorthand's own
// symbol, not the outer `const` binding — lexen must use
// `getShorthandAssignmentValueSymbol` to reach the originating
// `useTranslations(...)` call.
function notify({
    tWidget,
    tCommon,
}: {
    tWidget: (key: string) => string;
    tCommon: (key: string) => string;
}) {
    // eslint-disable-next-line no-console
    console.log(tWidget('shorthand.save'), tCommon('shorthand.cancel'));
}

// expect (via prop-flow):
//   widget.demo.actions.edit, widget.demo.actions.delete
//   widget.demo.header
//   widget.demo.shorthand.save (via shorthand-prop resolution)
//   common.shorthand.cancel   (via shorthand-prop resolution)
export function ParentWidget() {
    const tWidget = useTranslations('widget.demo');
    const tCommon = useTranslations('common');
    notify({tWidget, tCommon});
    return (
        <>
            <h1>{tWidget('header')}</h1>
            <TransportCard t={tWidget} />
        </>
    );
}
