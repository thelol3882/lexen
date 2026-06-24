// Fixture for `lexen context` — JSX call-site context extraction.
// Local stand-in components carry Mantine-style props so the role/space-budget
// heuristics have something to read. The keys (ctx.*) are seeded in
// locales/en.json so source values + placeholders resolve.
import {useTranslations} from 'next-intl';

function Title(_props: {order?: number; fz?: number; children?: unknown}) { return null; }
function Text(_props: {fz?: number; size?: string; tt?: string; children?: unknown}) { return null; }
function Button(_props: {children?: unknown}) { return null; }

export function ContextCard() {
    const t = useTranslations('demo');
    return (
        <div>
            {/* fz=26 → heading / tight */}
            <Title order={1} fz={26}>{t('ctx.heading')}</Title>
            {/* fz=11 + uppercase → eyebrow-label / tight */}
            <Text fz={11} tt="uppercase">{t('ctx.eyebrow')}</Text>
            {/* size=sm, ICU {count} → body / medium */}
            <Text size="sm">{t('ctx.body', {count: 2})}</Text>
            {/* Button tag → button / tight */}
            <Button>{t('ctx.cta')}</Button>
            {/* aria-label attribute → a11y-label / roomy */}
            <input aria-label={t('ctx.search')} />
        </div>
    );
}
