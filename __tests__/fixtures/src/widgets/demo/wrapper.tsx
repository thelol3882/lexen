// Fixture for the Mobile/Desktop wrapper pattern used throughout the app:
// a thin wrapper picks between two sibling components based on a runtime
// flag. Both branches have their own `useTranslations(...)` bindings and
// their own keys. Lexen must extract keys from BOTH branches — neither
// branch is dead code from the resolver's point of view.
//
// Regression target: if the resolver ever started skipping one branch of a
// conditional (e.g. dead-code-elimination fantasy), this fixture catches it.
import {useTranslations} from 'next-intl';

function useIsMobile(): boolean {
    return false;
}

// expect: widget.demo.wrapper.desktop.title
function DemoWidgetDesktop() {
    const t = useTranslations('widget.demo');
    return <h1>{t('wrapper.desktop.title')}</h1>;
}

// expect: widget.demo.wrapper.mobile.title
function DemoWidgetMobile() {
    const t = useTranslations('widget.demo');
    return <h1>{t('wrapper.mobile.title')}</h1>;
}

// expect (both branches visible):
//   widget.demo.wrapper.desktop.title
//   widget.demo.wrapper.mobile.title
export function DemoWidget() {
    const isMobile = useIsMobile();
    return isMobile ? <DemoWidgetMobile /> : <DemoWidgetDesktop />;
}
