// Fixture for Phase 3 lint tests.
// This file has deliberate rule violations so collectRuleViolations() can be
// tested against them:
//
//   Rule 1: useTranslations(dynamicNs)  — namespace is not a literal.
//   Rule 2: t(dynamicKey)               — key is not statically resolvable.
//
// The 'linttest' namespace is intentionally isolated so it does not disturb
// key counts in existing fixture namespaces.
import {useTranslations} from 'next-intl';

declare const dynamicNs: string;
declare const dynamicKey: string;

// Rule 1: dynamic namespace — useTranslations receives a non-literal arg.
export function Rule1Component() {
    const t = useTranslations(dynamicNs);
    return t('someKey');
}

// Rule 2: dynamic key — t() receives a non-literal arg.
export function Rule2Component() {
    const t = useTranslations('linttest');
    return t(dynamicKey);
}
