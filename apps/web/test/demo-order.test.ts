// /o/demo: the sample order of DEMO_MODE, built from the fixtures and rendered by the same
// OrderDetails as a real order. It carries no client data and offers no action.
import { parseEnv } from '@detaly/config';
import { buildOfferViews, formatPromise, promisedDate, type IsoDate } from '@detaly/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OrderDetails } from '@/components/order/OrderDetails';
import { createDemoSupplier } from '@/server/demo/supplier';
import {
  buildDemoOrderView,
  DEMO_ORDER_NUMBER,
  DEMO_ORDER_TOKEN,
} from '@/server/demo/order-fixture';
import { isOrderToken } from '@/server/orders/access';

const env = parseEnv({ SESSION_SECRET: 'test-session-secret-0123456789abcdef', DEMO_MODE: 'true' });
const supplier = createDemoSupplier({ env });
const NOW = new Date('2026-10-02T09:00:00Z');

function build() {
  return buildDemoOrderView({
    rossko: supplier.rossko,
    loadSettings: () => supplier.settings.get(),
    now: NOW,
  });
}

describe('demo order', () => {
  it('is an order at the supplier with two fixture positions and three events', async () => {
    const view = await build();
    expect(view).toMatchObject({
      number: DEMO_ORDER_NUMBER,
      token: DEMO_ORDER_TOKEN,
      status: 'ordered_at_supplier',
      statusLabel: 'Заказан у поставщика',
      scheme: 'pay_on_handover',
      closed: false,
      payment: null,
      pickupCode: null,
      canCancel: false,
    });
    expect(view.items).toHaveLength(2);
    expect(view.items.map((item) => item.article.replace(/\W/g, '').toUpperCase())).toEqual([
      'OC90',
      'GDB1330',
    ]);
    expect(view.totalKop).toBe(view.items.reduce((sum, item) => sum + item.lineTotalKop, 0));
    expect(view.promiseText).toMatch(/^к /);
    expect(view.timeline.map((entry) => entry.text)).toEqual([
      'Заказ оформлен, оплата при получении',
      'Вы подтвердили заказ',
      'Заказали детали у поставщика',
    ]);
    expect(Object.values(view.actions).every((allowed) => !allowed)).toBe(true);
    expect(view.items.every((item) => !item.canCancel)).toBe(true);
    // Never mistaken for a real order link.
    expect(isOrderToken(view.token)).toBe(false);
  });

  it('is paid on handover, so it holds Orenburg parts, and promises the date the cart does', async () => {
    const view = await build();
    expect(view.items.every((item) => item.isLocal)).toBe(true);
    const settings = await supplier.settings.get();
    const etaDates: string[] = [];
    for (const article of ['OC90', 'GDB1330']) {
      const { offers } = await supplier.rossko.search(article, { priority: 'search' });
      const local = buildOfferViews(offers, { ...settings, now: NOW }).find(
        (offer) => offer.isLocal && !offer.isCross && !offer.excluded,
      );
      expect(local).toBeDefined();
      etaDates.push(local!.etaDate);
    }
    expect(view.promisedDate).toBe(promisedDate(etaDates as IsoDate[], settings.eta));
    expect(view.promiseText).toBe(formatPromise(view.promisedDate!));
  });

  it('is deterministic for the same clock', async () => {
    expect(await build()).toEqual(await build());
  });

  it('renders without forms and without INN-like numbers', async () => {
    const view = await build();
    const html = renderToStaticMarkup(
      createElement(OrderDetails, {
        view,
        pickup: { name: null, address: 'г. Оренбург', hours: 'Пн–Пт 10:00–19:00', phone: null },
        contactPhone: null,
        cartReminder: null,
        nowMs: NOW.getTime(),
      }),
    );
    expect(html).toContain(DEMO_ORDER_NUMBER);
    expect(html).toContain('Заказан у поставщика');
    expect(html).not.toMatch(/<form/);
    expect(html).not.toMatch(/(^|\D)(\d{10}|\d{12}|\d{15})(\D|$)/);
  });
});
