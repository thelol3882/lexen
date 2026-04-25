// Fixture for the propFlow-unresolved warning (RULES rule 4 catch).
//
// A component takes `t` as a prop (rule 4 violation). The caller destructures
// `t` from a custom hook return — lexen's propFlow can't trace that back to
// a direct `useTranslations(...)` call through `absorbNamespaces`. The t()
// calls inside the receiving component become silently invisible.
//
// Lexen must SURFACE this as a propFlow-unresolved warning so the human can
// fix the t-prop threading (per rule 4) rather than have keys silently hidden.
//
// This fixture checks that the extractor (a) still emits 0 keys for this
// component (can't resolve), and (b) records an unresolvedCalls entry with
// call === 'propFlow' pointing at the t-prop expression on the caller.
import {useTranslations} from 'next-intl';

function useHookWrapper() {
    const t = useTranslations('widget.demo');
    return {t};
}

function BrokenReceiver({t}: {t: (key: string) => string}) {
    // These two keys are INVISIBLE to lexen — that's the point of the fixture.
    // If extraction ever starts picking them up again without a corresponding
    // lexen fix, the invariant has changed and run-fixtures.ts should be
    // updated to reflect the new behaviour.
    return (
        <>
            <span>{t('rule4.invisible.one')}</span>
            <span>{t('rule4.invisible.two')}</span>
        </>
    );
}

// Caller's `t` comes from a destructured hook return — absorbNamespaces bails,
// propFlow reports the unresolved caller.
export function BrokenCaller() {
    const {t} = useHookWrapper();
    return <BrokenReceiver t={t} />;
}
