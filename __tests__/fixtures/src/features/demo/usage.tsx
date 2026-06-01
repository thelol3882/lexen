// Fixture for lexen's typechecker resolver test. Every pattern here must be
// discovered by the typechecker resolver (and the comments document what the
// expected emitted keys are).
import {useTranslations} from 'next-intl';

// -- Pattern A: plain literal key
// expect: demo.literal.hello
export function LiteralKey() {
    const t = useTranslations('demo');
    return t('literal.hello');
}

// -- Pattern B: template literal with string-union hole
type Status = 'pending' | 'confirmed' | 'cancelled';
// expect: demo.status.pending, demo.status.confirmed, demo.status.cancelled
export function TemplateUnion({status}: {status: Status}) {
    const t = useTranslations('demo');
    return t(`status.${status}`);
}

// -- Pattern C: property access on a const Record<K, V>
type Role = 'admin' | 'owner';
const ROLE_CONFIG: Record<Role, {titleKey: 'roles.admin' | 'roles.owner'}> = {
    admin: {titleKey: 'roles.admin'},
    owner: {titleKey: 'roles.owner'},
};
// expect: demo.roles.admin, demo.roles.owner
export function ConfigRecord({role}: {role: Role}) {
    const t = useTranslations('demo');
    return t(ROLE_CONFIG[role].titleKey);
}

// -- Pattern D: map over a const array of literal keys
const ITEMS = [
    {labelKey: 'nav.home' as const},
    {labelKey: 'nav.settings' as const},
];
// expect: demo.nav.home, demo.nav.settings
export function MapArray() {
    const t = useTranslations('demo');
    return ITEMS.map(item => t(item.labelKey));
}

// -- Pattern E: template literal with a NUMBER-literal union hole
// expect: demo.level_1, demo.level_2, demo.level_3
// rule 7: these are dynamic-hole keys — EXEMPT from the camelCase naming check.
export function NumericUnion({tier}: {tier: 1 | 2 | 3}) {
    const t = useTranslations('demo');
    return t(`level_${tier}`);
}

// -- Pattern F: hand-authored snake_case literal — rule 7 SHOULD flag this.
// expect: demo.bad_key
export function SnakeLiteral() {
    const t = useTranslations('demo');
    return t('bad_key');
}
