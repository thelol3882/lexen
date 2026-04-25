// Fixture for hook-return resolution: a custom hook that wraps
// `useTranslations` and returns it under a known property name. Callers
// destructure `t`, and lexen must attribute their `t(...)` calls to the
// namespace the hook used internally.
import {useTranslations} from 'next-intl';

function useDemoTable() {
    const t = useTranslations('demo');
    const tCommon = useTranslations('common');
    return {t, tCommon};
}

// expect:
//   demo.hookReturn.title
//   common.hookReturn.loading
export function HookReturnConsumer() {
    const {t, tCommon} = useDemoTable();
    return (
        <>
            <h1>{t('hookReturn.title')}</h1>
            <span>{tCommon('hookReturn.loading')}</span>
        </>
    );
}

// Renamed destructure: `t: tLocal` — local name differs from property name.
// expect: demo.hookReturn.renamed
export function RenamedDestructure() {
    const {t: tLocal} = useDemoTable();
    return <span>{tLocal('hookReturn.renamed')}</span>;
}
