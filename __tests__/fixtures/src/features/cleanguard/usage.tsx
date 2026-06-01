// Fixture for Phase 2 safe-clean test.
// This file has a static key 'kept' AND a bare dynamic call t(dynamicKeyVar)
// (no literal prefix), so the namespace 'cleanguard' should be protected from
// --clean pruning unless --force is passed.
import {useTranslations} from 'next-intl';

declare const dynamicKeyVar: string;

export function CleanGuardComponent() {
    const t = useTranslations('cleanguard');
    // Static key — always extracted.
    const label = t('kept');
    // Prefixless dynamic key — unresolved, namespace known.
    const dynamic = t(dynamicKeyVar);
    return label + dynamic;
}
