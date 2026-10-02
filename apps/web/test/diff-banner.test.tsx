import type { LineChange } from '@detaly/domain';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CART_CHANGED_TEXT,
  DiffBanner,
  describeChange,
  formatDelta,
} from '@/components/DiffBanner';

const base = { lineId: 'l1', offerKey: 'OC90:Knecht:S1', title: 'Knecht OC 90' };

/** formatRub separates groups and the ruble sign with NBSP; tests compare with plain spaces. */
function plain(value: string): string {
  return value.replace(/\u00a0/g, ' ');
}

/** Plain text of the rendered markup (tags removed). */
function text(html: string): string {
  return plain(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

describe('formatDelta', () => {
  it('signs the per-unit delta with plus or a true minus', () => {
    expect(plain(formatDelta(5_300))).toBe('+53 ₽');
    expect(plain(formatDelta(-12_000))).toBe('−120 ₽');
    expect(plain(formatDelta(105_050))).toBe('+1 050,50 ₽');
    // the amount never wraps away from its sign and currency
    expect(formatDelta(5_300)).toBe('+53\u00a0₽');
  });
});

describe('describeChange', () => {
  it.each<[LineChange, string]>([
    [
      { kind: 'price', ...base, oldPriceKop: 52_800, newPriceKop: 58_100, deltaKop: 5_300 },
      'Цена изменилась: Knecht OC 90 +53 ₽',
    ],
    [
      { kind: 'price', ...base, oldPriceKop: 58_100, newPriceKop: 52_800, deltaKop: -5_300 },
      'Цена изменилась: Knecht OC 90 −53 ₽',
    ],
    [
      { kind: 'qty', ...base, oldQty: 4, newQty: 2 },
      'Осталось меньше: Knecht OC 90 — теперь 2 шт.',
    ],
    [{ kind: 'unavailable', ...base }, 'Больше нет в наличии: Knecht OC 90 — убрали из корзины'],
    [
      { kind: 'excluded', ...base, reason: 'масло' },
      'Не продаём онлайн: Knecht OC 90 — убрали из корзины',
    ],
  ])('%o', (change, expected) => {
    expect(plain(describeChange(change))).toBe(expected);
  });

  it('never shows the exclusion rule to the client', () => {
    expect(describeChange({ kind: 'excluded', ...base, reason: 'антифриз*' })).not.toContain(
      'антифриз',
    );
  });
});

describe('DiffBanner', () => {
  it('renders nothing without changes', () => {
    expect(renderToStaticMarkup(<DiffBanner changes={[]} />)).toBe('');
  });

  it('is a status region with one item per change (price and qty of one line both shown)', () => {
    const html = renderToStaticMarkup(
      <DiffBanner
        changes={[
          { kind: 'price', ...base, oldPriceKop: 52_800, newPriceKop: 58_100, deltaKop: 5_300 },
          { kind: 'qty', ...base, oldQty: 4, newQty: 2 },
        ]}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(text(html)).toContain('Цена изменилась: Knecht OC 90 +53 ₽');
    expect(text(html)).toContain('Осталось меньше: Knecht OC 90 — теперь 2 шт.');
    expect(html).not.toContain(CART_CHANGED_TEXT);
  });

  it('shows the general notice when only the total changed', () => {
    const html = renderToStaticMarkup(<DiffBanner changes={[]} cartChanged />);
    expect(html).toContain('role="status"');
    expect(text(html)).toBe(CART_CHANGED_TEXT);
  });
});
