import {useTranslations} from 'next-intl';

// Array-backed locale: keys items.0..2 resolve from a number-literal union,
// and the locale (locales/en.json) stores them as a JSON array. lexen must
// recognize the array values as present (not missing) and must never clobber
// the array into an object of empty strings.
// expect: arrayloc.items.0, arrayloc.items.1, arrayloc.items.2
export function ArrayMarquee({i}: {i: 0 | 1 | 2}) {
    const t = useTranslations('arrayloc');
    return t(`items.${i}`);
}
