// Fixture for widget sub-namespace ownership. One widget file defines both
// the flat parent namespace (`widget.demo`) and a subpath namespace
// (`widget.demo.subsection`). The extractor must attribute keys to the
// namespace of each binding independently — if the two accidentally collide,
// sync.ts's ownership logic (sync.ts:154–177) relies on that separation
// being correct.
//
// Regression target: if future resolver changes ever merge same-file
// bindings, this fixture catches it.
import {useTranslations} from 'next-intl';

// expect (flat namespace): widget.demo.subsection.fromFlat
export function FlatUsage() {
    const t = useTranslations('widget.demo');
    return <span>{t('subsection.fromFlat')}</span>;
}

// expect (subpath namespace): widget.demo.subsection.fromSubpath
export function SubpathUsage() {
    const t = useTranslations('widget.demo.subsection');
    return <span>{t('fromSubpath')}</span>;
}
