// Fixes of the full site audit (2026-10), rendered without Next: the near-VIN and the words in
// «Подобрать по VIN», the stock count of an order, plain words and a call for marked goods, no
// payment tail on checkout lines, the claim block of /returns, the storage window, the demo
// forms that send nothing, the documents' «Электронная почта», canonical, sitemap and caching.
import { parseEnv } from '@detaly/config';
import { minimalEnvSource } from '@detaly/config/testing';
import type { OfferView, RepricedLine } from '@detaly/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as Navigation from 'next/navigation';
import { describe, expect, it, vi } from 'vitest';
import { CheckoutForm, type CheckoutFormProps } from '@/components/checkout/CheckoutForm';
import { CheckoutSummary, PickupPoint } from '@/components/checkout/CheckoutSummary';
import { EmptyState } from '@/components/EmptyState';
import { BrandGrid, PHONE_BRANDS_COUNT } from '@/components/home/BrandGrid';
import { excludedClientText, OfferRow, stockCountLine } from '@/components/OfferRow';
import { PickupBlock } from '@/components/order/OrderSections';
import { Requisites } from '@/components/Requisites';
import { DefectClaimNote } from '@/components/returns/DefectClaimNote';
import { VinForm, type VinFormProps } from '@/components/vin/VinForm';
import { vinRequestFromQuery, vinRequestHref } from '@/lib/vin-link';
import { brandFromEnv } from '@/server/brand';
import { storageDays } from '@/server/settings';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  usePathname: () => '/',
  useSearchParams: () => null,
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const render = <P extends object>(component: (props: P) => unknown, props: P): string =>
  renderToStaticMarkup(createElement(component as never, props as never));

describe('«Подобрать по VIN» from a search query (ux-8)', () => {
  it('an article goes as «Артикул …», words as they are', () => {
    expect(vinRequestFromQuery('OC90')).toEqual({
      href: vinRequestHref({ need: 'Артикул OC90' }),
      nearVin: false,
    });
    expect(vinRequestFromQuery('масляный фильтр').href).toBe(
      vinRequestHref({ need: 'масляный фильтр' }),
    );
    expect(vinRequestFromQuery('OC 90').href).toBe(vinRequestHref({ need: 'OC 90' }));
    expect(vinRequestFromQuery('колодки').href).toBe(vinRequestHref({ need: 'колодки' }));
  });

  it('a VIN with a character lost or added goes into the VIN field', () => {
    expect(vinRequestFromQuery('XTA2109904345678')).toEqual({
      href: vinRequestHref({ vin: 'XTA2109904345678' }),
      nearVin: true,
    });
    expect(vinRequestFromQuery('XTA210990434567890').nearVin).toBe(true);
    expect(vinRequestFromQuery('XTA21099043456').nearVin).toBe(false);
    const html = render(EmptyState, { query: 'XTA2109904345678' });
    expect(text(html)).toContain('Похоже на VIN — в нём 17 символов');
    expect(html).toContain(`href="${vinRequestHref({ vin: 'XTA2109904345678' })}"`);
    expect(render(EmptyState, { query: 'масляный фильтр' })).not.toContain('Артикул');
  });
});

const offer = (over: Partial<OfferView> = {}): OfferView => ({
  id: 'OC90:Knecht:EKB2',
  brand: 'Knecht',
  article: 'OC 90',
  articleNorm: 'OC90',
  name: 'Фильтр масляный',
  isCross: false,
  isLocal: false,
  stockId: 'EKB2',
  available: 24,
  multiplicity: 1,
  priceClientKop: 64_000,
  priceText: '640 ₽',
  etaDate: '2026-10-12',
  promiseText: 'к пн 12 октября',
  excluded: false,
  excludedReason: null,
  ...over,
});

describe('offer row (ux-14, ux-15)', () => {
  it('an order shows the supplier count, the Orenburg stock «Есть»', () => {
    expect(stockCountLine(offer())).toBe('У поставщика 24 шт.');
    expect(stockCountLine(offer({ isLocal: true, available: 6 }))).toBe('Есть 6 шт.');
    const html = render(OfferRow, { offer: offer(), searchArticleNorm: 'OC90' });
    expect(text(html)).toContain('У поставщика 24 шт.');
    expect(text(html)).not.toContain('Есть 24 шт.');
  });

  it('a marked good says in plain words where it is sold, with a call when a phone is set', () => {
    expect(excludedClientText('Маркируемый товар: масла')).toBe('Масла продаём только в сервисе');
    expect(excludedClientText('Маркируемый товар: тормозные жидкости')).toBe(
      'Тормозные жидкости продаём только в сервисе',
    );
    expect(excludedClientText(null)).toBe('Этот товар продаём только в сервисе');
    expect(excludedClientText('по правилу админки')).toBe('Этот товар продаём только в сервисе');
    const oil = offer({ excluded: true, excludedReason: 'Маркируемый товар: масла' });
    const withPhone = render(OfferRow, {
      offer: oil,
      searchArticleNorm: 'OC90',
      contactPhone: '+7 900 000-00-01',
    });
    expect(text(withPhone)).toContain('Масла продаём только в сервисе');
    expect(text(withPhone)).not.toContain('Маркируемый');
    expect(withPhone).toContain('href="tel:+79000000001"');
    const noPhone = render(OfferRow, { offer: oil, searchArticleNorm: 'OC90' });
    expect(noPhone).not.toContain('tel:');
    expect(text(noPhone)).toContain('Цена — в сервисе');
  });
});

const line = (id: string, isLocal: boolean): RepricedLine => ({
  id,
  offerKey: `OC90:Knecht:${isLocal ? 'ORB1' : 'EKB2'}`,
  searchArticleNorm: 'OC90',
  qty: 1,
  priceSupplierKop: 50_000,
  priceClientKop: 64_000,
  markupBp: 2800,
  isLocal,
  etaDate: isLocal ? '2026-10-08' : '2026-10-12',
  offer: {
    source: 'rossko',
    brand: 'Knecht',
    article: 'OC 90',
    articleNorm: 'OC90',
    name: 'Фильтр масляный',
    group: null,
    isCross: false,
    priceSupplierKop: 50_000,
    stock: {
      stockId: isLocal ? 'ORB1' : 'EKB2',
      isLocal,
      count: 5,
      multiplicity: 1,
      type: null,
      deliveryDays: 0,
      deliveryStart: null,
      deliveryEnd: null,
      extra: null,
      description: null,
    },
  },
  status: 'ok',
  available: 5,
  multiplicity: 1,
  stale: false,
});

describe('checkout (ux-6, ux-9, legal-13, ux-11)', () => {
  it('a mixed order under 100% prepayment has no «оплата при получении» on its lines', () => {
    const html = render(CheckoutSummary, {
      lines: [line('a', true), line('b', false)],
      totalKop: 128_000,
      promisedDate: '2026-10-12',
      linePromises: { a: 'к чт 8 октября', b: 'к пн 12 октября' },
    });
    expect(text(html)).toContain('В Оренбурге');
    expect(text(html)).not.toMatch(/оплата при получении/i);
  });

  it('the pickup step says how long the order waits, by the scheme', () => {
    const order = { pickupWindowPrepaidDays: 10, pickupWindowCodDays: 7 };
    expect(storageDays(order, 'prepay')).toBe(10);
    expect(storageDays(order, 'pay_on_handover')).toBe(7);
    const pickup = { name: 'Сервис56', address: 'ул. Тестовая, 1', hours: null, phone: null };
    expect(text(render(PickupPoint, { pickup, storageDays: 7 }))).toContain(
      'Храним 7 дней после сообщения «Приехало»',
    );
    expect(text(render(PickupPoint, { pickup, storageDays: 1 }))).toContain('Храним 1 день');
    expect(render(PickupPoint, { pickup })).not.toContain('Храним');
  });

  const formProps: CheckoutFormProps = {
    part: 'all',
    expectedTotalKop: 64_000,
    itemsHash: '',
    checkoutKey: 'demo',
    documents: {
      offerVersionId: 'demo',
      consentPdVersionId: 'demo',
      consentMarketingVersionId: null,
    },
    expectedScheme: 'prepay',
    expectedPromisedDate: null,
    marketingAvailable: false,
    blockedMessage: null,
    contactPhone: null,
  };

  it('never ticks the consents in advance, the demo included', () => {
    for (const props of [
      formProps,
      { ...formProps, demo: { action: '/api/demo/checkout-done' } },
    ]) {
      const html = render(CheckoutForm, props);
      const boxes = [...html.matchAll(/<input[^>]*name="(acceptOffer|consentPd)"[^>]*>/g)];
      expect(boxes).toHaveLength(2);
      for (const box of boxes) expect(box[0]).not.toMatch(/\schecked=""/);
    }
  });

  it('the demo button posts an empty separate form, never the fields', () => {
    const html = render(CheckoutForm, {
      ...formProps,
      demo: { action: '/api/demo/checkout-done' },
    });
    expect(html).toMatch(
      /<button type="submit" form="demo-checkout-done"[^>]*data-testid="demo-checkout-submit"/,
    );
    const done = /<form id="demo-checkout-done"[^>]*>(.*?)<\/form>/s.exec(html);
    expect(done?.[0]).toContain('method="post"');
    expect(done?.[0]).toContain('action="/api/demo/checkout-done"');
    expect(done?.[1]).toBe('');
  });
});

describe('demo VIN form sends nothing, not even before hydration (legal-14)', () => {
  const props: VinFormProps = {
    consentPdVersionId: '00000000-0000-0000-0000-000000000001',
    requestKey: '00000000-0000-7000-8000-000000000002',
    photos: { enabled: false, max: 3, maxFileMb: 8 },
    telegram: true,
    errors: {},
    formError: null,
    demo: true,
  };

  it('has no action and no submit button in the demo', () => {
    const html = render(VinForm, props);
    const formTag = /<form[^>]*id="vin-form"[^>]*>/.exec(html)?.[0] ?? '';
    expect(formTag).not.toContain('action=');
    expect(formTag).not.toContain('multipart');
    expect(html).not.toContain('type="submit"');
    expect(html).toMatch(/<button type="button"[^>]*data-testid="vin-submit"/);
  });

  it('stays a multipart post to /api/vin outside the demo', () => {
    const html = render(VinForm, { ...props, demo: false });
    expect(html).toMatch(/<form[^>]*action="\/api\/vin"/);
    expect(html).toMatch(/encType="multipart\/form-data"/i);
    expect(html).toMatch(/<button type="submit"[^>]*data-testid="vin-submit"/);
  });
});

describe('/returns and the order page (ux-4, ux-9)', () => {
  it('tells where to go with a defect, the call only with a phone', () => {
    const html = render(DefectClaimNote, { pointName: 'Сервис56', phone: '+7 900 000-00-01' });
    expect(text(html)).toContain('Брак или претензия');
    expect(text(html)).toContain('«Претензия»');
    expect(text(html)).toContain('принесите деталь в Сервис56');
    expect(html).toContain('href="tel:+79000000001"');
    expect(render(DefectClaimNote, { pointName: null, phone: null })).not.toContain('tel:');
  });

  it('a ready order says until when it waits', () => {
    const pickup = { name: 'Сервис56', address: 'ул. Тестовая, 1', hours: null, phone: null };
    const html = render(PickupBlock, { pickup, code: '1234', keepUntil: 'чт 15 октября' });
    expect(text(html)).toContain('Храним до чт 15 октября');
    expect(render(PickupBlock, { pickup, code: '1234' })).not.toContain('Храним');
  });
});

describe('requisites in Russian (legal-17)', () => {
  it('names the e-mail «Электронная почта»', () => {
    const brand = brandFromEnv(
      parseEnv(
        minimalEnvSource({
          SELLER_REQUISITES_NAME: 'Тестов Т. Т.',
          SELLER_REQUISITES_INN: '123456789012',
          SELLER_REQUISITES_OGRNIP: '312565800012345',
          SELLER_REQUISITES_ADDRESS: 'г. Оренбург',
          SELLER_REQUISITES_PHONE: '+7 900 000-00-00',
          SELLER_REQUISITES_EMAIL: 'seller@example.test',
        }),
      ),
    );
    const html = render(Requisites, { brand });
    expect(text(html)).toContain('Электронная почта');
    expect(html).not.toMatch(/E-mail/i);
  });
});

describe('home brand logos on phones (perf-9)', () => {
  it('the featured logos hidden on phones are lazy, the visible ones are not', () => {
    const html = renderToStaticMarkup(createElement(BrandGrid));
    const featured = /data-testid="home-brands"[^>]*>(.*?)<\/ul>/s.exec(html)?.[1] ?? '';
    const imgs = [...featured.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
    expect(imgs.length).toBeGreaterThan(PHONE_BRANDS_COUNT);
    imgs.forEach((img, index) => {
      expect(img.includes('loading="lazy"'), `logo ${index}`).toBe(index >= PHONE_BRANDS_COUNT);
    });
  });
});
