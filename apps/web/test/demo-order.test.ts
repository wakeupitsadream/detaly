// /o/demo: the sample order of DEMO_MODE, built from the fixtures and rendered by the same
// OrderDetails as a real order. It carries no client data and offers no action.
import { parseEnv } from '@detaly/config';
import { buildOfferViews, formatPromise, promisedDate, type IsoDate } from '@detaly/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as Navigation from 'next/navigation';
import { describe, expect, it, vi } from 'vitest';
import { OrderDetails } from '@/components/order/OrderDetails';
import { createDemoSupplier } from '@/server/demo/supplier';
import {
  buildDemoOrderServices,
  buildDemoOrderView,
  DEMO_ORDER_NUMBER,
  DEMO_ORDER_TOKEN,
  type DemoScreen,
} from '@/server/demo/order-fixture';
import { demoFormRedirect } from '@/proxy';
import { isOrderToken } from '@/server/orders/access';

// ClaimForm is a client component: no app router in a static render.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

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

describe('demo order: phase 1C blocks (decision С21)', () => {
  const HOURS = 'Пн–Пт 10:00–19:00';
  const pickup = { name: null, address: 'г. Оренбург', hours: HOURS, phone: null };

  async function demoHtml(screen: DemoScreen) {
    const view = await build();
    const services = buildDemoOrderServices({
      view,
      screen,
      hours: HOURS,
      partner: null,
      now: NOW,
    });
    const html = renderToStaticMarkup(
      createElement(OrderDetails, {
        view,
        services,
        pickup,
        contactPhone: null,
        cartReminder: null,
        nowMs: NOW.getTime(),
        demo: true,
      }),
    );
    return { services, html };
  }

  /** Every form of the page: method and action. */
  function forms(html: string): string[] {
    return [...html.matchAll(/<form[^>]*>/g)].map((m) => {
      const tag = m[0];
      const method = /method="([^"]+)"/.exec(tag)?.[1] ?? '';
      const action = /action="([^"]+)"/.exec(tag)?.[1] ?? '';
      return `${method} ${action}`;
    });
  }

  it('its forms are GETs to the demo screens; nothing personal has a name', async () => {
    const { html, services } = await demoHtml(null);
    expect(forms(html)).toEqual(['get /o/demo', 'get /o/demo', 'get /o/demo']);
    for (const screen of ['link', 'install', 'claim']) {
      expect(html).toContain(`name="demo" value="${screen}"`);
    }
    for (const field of ['text', 'last4', 'photos', 'requestKey', 'channel']) {
      expect(html).not.toContain(`name="${field}"`);
    }
    // The proxy's answer to a POST from elsewhere leads to the same screens (decision С21).
    for (const form of ['link', 'install', 'claims']) {
      expect(demoFormRedirect('POST', `/api/orders/demo/${form}`)).toMatch(
        /^\/o\/demo\?demo=(link|install|claim)$/,
      );
    }
    expect(services.install?.slots.length).toBeGreaterThan(0);
    expect(services.install?.slots.length).toBeLessThanOrEqual(6);
    expect(services.install?.demo).toBe(true);
    expect(services.claims?.form?.kinds.map((k) => k.kind)).toEqual([
      'refusal',
      'not_fit',
      'defect',
    ]);
    // The packaging photo is a placeholder: no file, no URL.
    expect(services.photos).toEqual([{ id: 'demo-packaging', kind: 'packaging', url: null }]);
    expect(html).toContain('data-testid="order-photo-stub"');
    expect(html).not.toContain('/api/orders/demo/photos');
    expect(html).toContain('оплачивается в сервисе по его чеку');
    expect(html).not.toMatch(/(^|\D)(\d{10}|\d{12}|\d{15})(\D|$)/);
  });

  it('?demo=install shows the booking, ?demo=claim the accepted claim with its steps', async () => {
    const install = await demoHtml('install');
    expect(install.services.install?.booking?.status).toBe('requested');
    expect(install.html).toContain('data-testid="install-booking"');
    expect(install.html).not.toContain('/api/orders/demo/install/cancel');

    const claim = await demoHtml('claim');
    expect(claim.services.claims?.form).toBeNull();
    expect(claim.html).toContain('data-testid="claim-card"');
    expect(claim.html).toContain('Принесите деталь в упаковке');
    expect(claim.html).not.toContain('data-testid="claim-form"');
  });

  it('is pure: the same input gives the same blocks', async () => {
    const view = await build();
    const input = { view, screen: null, hours: HOURS, partner: null, now: NOW } as const;
    expect(buildDemoOrderServices(input)).toEqual(buildDemoOrderServices(input));
  });
});
