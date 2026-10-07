// Display rules added after the design review: the order of offers inside a group and the
// «Быстрее всего» / «Дешевле всего» marks, the draft state of a legal sheet, the stepper that
// agrees with the status badge, and the demo order's message preview.
import type { OfferView } from '@detaly/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { legalBodyForView, legalIsDraft } from '@/components/LegalDocumentView';
import { stockCountText } from '@/components/OfferRow';
import { MessengerPreview } from '@/components/order/OrderSections';
import { orderSteps } from '@/components/order/OrderStepper';
import { offerMarks, sortOffersForChoice } from '@/components/search/OfferGroup';

function offer(over: Partial<OfferView> & Pick<OfferView, 'id'>): OfferView {
  return {
    brand: 'KNECHT',
    article: 'OC 90',
    articleNorm: 'OC90',
    name: 'Фильтр масляный',
    isCross: false,
    isLocal: false,
    stockId: 'S',
    available: 5,
    multiplicity: 1,
    priceClientKop: 50_000,
    priceText: '500 ₽',
    etaDate: '2026-10-06',
    promiseText: 'к вт 6 октября',
    excluded: false,
    excludedReason: null,
    ...over,
  } as OfferView;
}

describe('offers inside a group', () => {
  const cheapOrder = offer({ id: 'order', priceClientKop: 49_800, etaDate: '2026-10-05' });
  const local = offer({
    id: 'local',
    isLocal: true,
    priceClientKop: 52_800,
    etaDate: '2026-10-02',
  });
  const marked = offer({ id: 'marked', excluded: true, isLocal: true, priceClientKop: 1 });

  it('Orenburg first, marked goods last, then date and price', () => {
    expect(sortOffersForChoice([marked, cheapOrder, local]).map((o) => o.id)).toEqual([
      'local',
      'order',
      'marked',
    ]);
  });

  it('marks the fastest and the cheapest sellable offers, nothing for a single one', () => {
    const marks = offerMarks([local, cheapOrder, marked]);
    expect(marks.get('local')).toEqual(['fastest']);
    expect(marks.get('order')).toEqual(['cheapest']);
    expect(marks.has('marked')).toBe(false);
    expect(offerMarks([local, marked]).size).toBe(0);
  });

  it('a tie keeps the mark on the earlier offer only (exact matches before crosses)', () => {
    const cross = offer({
      id: 'cross',
      isLocal: true,
      priceClientKop: 60_000,
      etaDate: '2026-10-02',
    });
    const marks = offerMarks([local, cheapOrder, cross]);
    expect(marks.get('local')).toEqual(['fastest']);
    expect(marks.has('cross')).toBe(false);
  });

  it('the stock count says where the parts are', () => {
    expect(stockCountText(local)).toBe('в Оренбурге: 5 шт.');
    expect(stockCountText(cheapOrder)).toBe('у поставщика: 5 шт.');
  });
});

describe('legal sheet', () => {
  const body =
    '> **Черновик, требует вычитки юристом.** Это не действующая редакция.\n\n# Оферта\n\nРедакция 2026-10-d1.\n\n1. Текст.';

  it('a published text that still opens with the draft note is a draft for the reader', () => {
    expect(legalIsDraft({ bodyMd: body, isDraft: false })).toBe(true);
    expect(legalIsDraft({ bodyMd: '# Оферта\n\nТекст.', isDraft: false })).toBe(false);
    expect(legalIsDraft({ bodyMd: '# Оферта', isDraft: true })).toBe(true);
  });

  it('drops the edition line under the title only', () => {
    const view = legalBodyForView({ bodyMd: body, version: '2026-10-d1' });
    expect(view).not.toContain('Редакция 2026-10-d1');
    expect(view).toContain('1. Текст.');
  });
});

describe('order stepper', () => {
  it('at the supplier the current step reads like the badge', () => {
    const steps = orderSteps('ordered_at_supplier', 'pay_on_handover');
    const current = steps.find((step) => step.state === 'current');
    expect(current?.label).toBe('Заказан у поставщика');
    // No «едет в Оренбург» on this step: «Доставка в Оренбург» is the next one.
    expect(JSON.stringify(steps)).not.toContain('едет');
    expect(steps.filter((step) => step.state === 'done')).toHaveLength(2);
  });

  it('other statuses keep their steps', () => {
    const ready = orderSteps('ready', 'prepay');
    expect(ready.find((step) => step.state === 'current')?.label).toBe('Выдача');
    expect(ready[2]?.label).toBe('Заказан у поставщика');
  });
});

describe('demo message preview', () => {
  it('uses the order number and the lift slot', () => {
    const html = renderToStaticMarkup(
      createElement(MessengerPreview, {
        number: 'DT-000042',
        hours: null,
        install: {
          partText: 'к сб 3 октября',
          slotText: 'пн 5 окт с 11:00',
          carReadyText: 'к 13:00',
          demo: true,
          slotStartIso: '2026-10-05T11:00:00+05:00',
        },
      }),
    );
    expect(html).toContain(
      'Заказ DT-000042: детали приехали. Ждём вас пн 5 окт, окно на подъёмнике с 11:00.',
    );
    expect(html).not.toMatch(/<button/);
  });
});
