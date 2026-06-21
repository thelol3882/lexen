// Fixture for the multi-hook feature: lexen must track next-intl's *server*
// binder `getTranslations` (from 'next-intl/server') in addition to the client
// `useTranslations`. The `await` in front of getTranslations must be unwrapped
// so the namespace binds exactly like the synchronous hook.
import {getTranslations} from 'next-intl/server';

// -- Pattern S1: server component, await + plain literal key
// expect: demo.server.title
export async function ServerLiteral() {
    const t = await getTranslations('demo');
    return t('server.title');
}

// -- Pattern S2: await + template literal with a string-union hole.
// Exercises await-unwrap AND the typechecker union resolver together.
type Tab = 'overview' | 'details';
// expect: demo.tab.overview, demo.tab.details
export async function ServerUnion({tab}: {tab: Tab}) {
    const t = await getTranslations('demo');
    return t(`tab.${tab}`);
}
