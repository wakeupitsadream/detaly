// Cart page pieces without a database: the summary (payment scheme, split advice, minimums,
// dates) and the rendered components (forms, links, no price from the client).
import {
  DEFAULT_EXCLUDED_RULES,
  type MarkupRule,
  type Offer,
  type OfferView,
  type RepricedLine,
} from '@detaly/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AddToCartForm } from '@/components/AddToCartForm';
import { CartLineRow } from '@/components/CartLineRow';
import { CartSummary } from '@/components/CartSummary';
import { PaymentSchemeNote } from '@/components/checkout/PaymentSchemeNote';
import { OfferRow } from '@/components/OfferRow';
import {
  PaymentModeNotice,
  SPLIT_BUTTON_TEXT,
  SPLIT_EXPLANATION,
} from '@/components/PaymentModeNotice';
import { cartCountLabel, SiteHeader } from '@/components/SiteHeader';
import { createCartService, type CartService, type CartSettings } from '@/server/cart/cart-service';
import {
  CART_ERROR_MESSAGES,
  CartRequestError,
  isCartErrorCode,
  isCartRequestError,
  safeErrorFields,
} from '@/server/cart/errors';
import {
  cartSetCookie,
  handleAddItem,
  handleLineRequest,
  requestCookies,
} from '@/server/cart/http';
import {
  FINAL_SCHEME_NOTE,
  MIXED_CART_TEXT,
  summarizeCart,
  toLineView,
} from '@/server/cart/summary';

/** formatRub uses NBSP; compare with plain spaces. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const RULES: MarkupRule[] = [{ fromKop: 0, toKop: null, localBp: 2800, orderBp: 2800 }];

function settings(order: Partial<CartSettings['order']> = {}): CartSettings {
  return {
    markupRules: RULES,
    excludedRules: [...DEFAULT_EXCLUDED_RULES],
    eta: { bufferDays: 1, invoiceLagDays: 1, prepayInvoice: false },
    order: {
      minOrderTotalKop: 0,
      minMarginKop: 0,
      onPickupMaxTotalKop: 1_500_000,
      onPickupConfirmTtlH: 24,
      noShowLimit: 2,
      paymentTtlMin: 30,
      courierFeeKop: 0,
      ...order,
    },
  };
}

function offer(brand: string, article: string, isLocal: boolean, priceKop: number): Offer {
  return {
    source: 'rossko',
    brand,
    article,
    articleNorm: article.replace(/[^A-Z0-9]/gi, '').toUpperCase(),
    name: 'Фильтр масляный',
    group: null,
    isCross: false,
    priceSupplierKop: priceKop,
    stock: {
      stockId: isLocal ? 'ORB1' : 'MSK7',
      isLocal,
      count: 6,
      multiplicity: 1,
      type: null,
      deliveryDays: isLocal ? 0 : 3,
      deliveryStart: null,
      deliveryEnd: null,
      extra: null,
      description: null,
    },
  };
}

function line(
  id: string,
  isLocal: boolean,
  priceClientKop: number,
  qty = 1,
  etaDate: string = isLocal ? '2026-10-02' : '2026-10-05',
): RepricedLine {
  const o = offer(
    isLocal ? 'Knecht' : 'BOSCH',
    isLocal ? 'OC 90' : '0 451 103 079',
    isLocal,
    41_250,
  );
  return {
    id,
    offerKey: `${o.articleNorm}:${o.brand}:${o.stock.stockId}`,
    searchArticleNorm: 'OC90',
    qty,
    priceSupplierKop: 41_250,
    priceClientKop,
    markupBp: 2800,
    isLocal,
    etaDate,
    offer: o,
    status: 'ok',
    available: 6,
    multiplicity: 1,
    stale: false,
  };
}

describe('summarizeCart', () => {
  it('a mixed cart: prepayment notice and the split offer', () => {
    const summary = summarizeCart(
      [line('a', true, 52_800), line('b', false, 64_200, 2)],
      settings(),
    );
    expect(summary.subtotalKop).toBe(52_800 + 128_400);
    expect(summary.itemsCount).toBe(3);
    expect(summary.payment).toEqual({
      mixed: true,
      sentences: [MIXED_CART_TEXT],
      offerSplit: true,
    });
    // max(eta) + 1 buffer day: Tue 6 October.
    expect(summary.promiseText).toBe('к вт 6 октября');
    expect(summary.minimums).toEqual({ ok: true });
  });

  it('no split when the Orenburg part alone is over the on-handover limit', () => {
    const summary = summarizeCart(
      [line('a', true, 52_800), line('b', false, 64_200)],
      settings({ onPickupMaxTotalKop: 50_000 }),
    );
    expect(summary.payment.offerSplit).toBe(false);
  });

  it('no split when one part alone is below the minimum order total', () => {
    // The whole cart (1 170 ₽) passes a 1 000 ₽ minimum; the Orenburg part (528 ₽) does not.
    const summary = summarizeCart(
      [line('a', true, 52_800), line('b', false, 64_200)],
      settings({ minOrderTotalKop: 100_000 }),
    );
    expect(summary.minimums).toEqual({ ok: true });
    expect(summary.payment.offerSplit).toBe(false);
  });

  it('only Orenburg lines: payment on handover explained, final decision after the phone', () => {
    const summary = summarizeCart([line('a', true, 52_800)], settings());
    expect(summary.payment.mixed).toBe(false);
    expect(summary.payment.sentences[0]).toMatch(/^Оплата при получении/);
    expect(summary.payment.sentences.at(-1)).toBe(FINAL_SCHEME_NOTE);
  });

  it('only to-order lines: prepayment with the reason, final without a phone note', () => {
    const summary = summarizeCart([line('b', false, 64_200)], settings());
    expect(summary.payment.sentences[0]).toContain('предоплата 100%');
    expect(summary.payment.sentences).not.toContain(FINAL_SCHEME_NOTE);
    const overLimit = summarizeCart(
      [line('a', true, 52_800)],
      settings({ onPickupMaxTotalKop: 50_000 }),
    );
    expect(overLimit.payment.sentences[0]).toContain('нужна предоплата');
    expect(overLimit.payment.sentences).not.toContain(FINAL_SCHEME_NOTE);
  });

  it('the minimum-order hint names the missing sum; the margin is never disclosed', () => {
    const total = summarizeCart([line('a', true, 52_800)], settings({ minOrderTotalKop: 100_000 }));
    expect(total.minimums).toMatchObject({ ok: false, code: 'min_total', missingKop: 47_200 });
    expect(text(total.minimums.ok ? '' : total.minimums.message)).toBe(
      'Минимальная сумма заказа 1 000 ₽ — добавьте позиции ещё на 472 ₽',
    );
    const margin = summarizeCart([line('a', true, 52_800)], settings({ minMarginKop: 50_000 }));
    expect(margin.minimums).toMatchObject({ ok: false, code: 'min_margin', missingKop: null });
  });

  it('line views carry the client price only and a quantity cap by stock and step', () => {
    const view = toLineView({ ...line('a', true, 52_800, 2), available: 7 }, settings());
    expect(view).toMatchObject({
      qty: 2,
      maxQty: 7,
      multiplicity: 1,
      promiseText: 'к сб 3 октября',
    });
    expect(text(view.lineTotalText)).toBe('1 056 ₽');
    expect(Object.keys(view)).not.toContain('priceSupplierKop');
    expect(Object.keys(view)).not.toContain('markupBp');
  });
});

describe('cart components', () => {
  it('CartLineRow: quantity and delete forms with _method, no price fields', () => {
    const html = renderToStaticMarkup(
      createElement(CartLineRow, { line: toLineView(line('l-1', true, 52_800), settings()) }),
    );
    expect(html).toContain('action="/api/cart/items/l-1"');
    expect(html).toContain('name="_method" value="patch"');
    expect(html).toContain('name="_method" value="delete"');
    expect(html).toContain('name="qty"');
    expect(html).not.toMatch(/name="price/i);
    expect(text(html)).toContain('В Оренбурге — оплата при получении');
    expect(text(html)).toContain('Получение к сб 3 октября');
  });

  it('CartSummary: the checkout button, a disabled one below the minimum, the gate text', () => {
    const base = { subtotalText: '528 ₽', itemsCount: 1, promiseText: 'к сб 3 октября' };
    const open = renderToStaticMarkup(
      createElement(CartSummary, { ...base, minimums: { ok: true }, gate: { open: true } }),
    );
    expect(open).toContain('href="/checkout"');
    expect(text(open)).toContain('Оформить заказ');

    const below = renderToStaticMarkup(
      createElement(CartSummary, {
        ...base,
        minimums: { ok: false, code: 'min_total', message: 'Минимальная сумма', missingKop: 1 },
        gate: { open: true },
      }),
    );
    expect(below).not.toContain('href="/checkout"');
    expect(below).toContain('aria-disabled="true"');
    expect(text(below)).toContain('Минимальная сумма');

    const closed = renderToStaticMarkup(
      createElement(CartSummary, {
        ...base,
        minimums: { ok: true },
        gate: {
          open: false,
          message: 'Оформление на сайте скоро откроется',
          phone: '+7 900 000-00-01',
        },
      }),
    );
    expect(closed).not.toContain('href="/checkout"');
    expect(text(closed)).toContain('Оформление на сайте скоро откроется');
    // Every closed reason keeps a way to order: a tappable call button.
    expect(closed).toContain('href="tel:+79000000001"');
    expect(text(closed)).toContain('Позвонить +7 900 000-00-01');

    const noPhone = renderToStaticMarkup(
      createElement(CartSummary, {
        ...base,
        minimums: { ok: true },
        gate: { open: false, message: 'Оформление на сайте временно недоступно.', phone: null },
      }),
    );
    expect(noPhone).not.toContain('tel:');
    expect(text(noPhone)).toContain('временно недоступно');
  });

  it('PaymentModeNotice: split button to /checkout?part=local, else one order', () => {
    const split = renderToStaticMarkup(
      createElement(PaymentModeNotice, {
        payment: { mixed: true, sentences: [MIXED_CART_TEXT], offerSplit: true },
        checkoutOpen: true,
      }),
    );
    expect(split).toContain('href="/checkout?part=local"');
    expect(text(split)).toContain(SPLIT_BUTTON_TEXT);
    expect(text(split)).toContain(SPLIT_EXPLANATION);
    expect(text(split)).toContain(MIXED_CART_TEXT);

    const single = renderToStaticMarkup(
      createElement(PaymentModeNotice, {
        payment: { mixed: true, sentences: [MIXED_CART_TEXT], offerSplit: false },
        checkoutOpen: true,
      }),
    );
    expect(single).not.toContain('part=local');
    expect(text(single)).toContain('Оформить одним заказом');

    const closed = renderToStaticMarkup(
      createElement(PaymentModeNotice, {
        payment: { mixed: true, sentences: [MIXED_CART_TEXT], offerSplit: true },
        checkoutOpen: false,
      }),
    );
    expect(closed).not.toContain('/checkout');
  });

  const view: OfferView = {
    id: 'OC90:Knecht:ORB1',
    brand: 'Knecht',
    article: 'OC 90',
    articleNorm: 'OC90',
    name: 'Фильтр масляный',
    isCross: false,
    isLocal: true,
    stockId: 'ORB1',
    available: 6,
    multiplicity: 1,
    priceClientKop: 52_800,
    priceText: '528 ₽',
    etaDate: '2026-10-02',
    promiseText: 'к сб 3 октября',
    excluded: false,
    excludedReason: null,
  };

  it('OfferRow: "В корзину" posts the query, the offer id and the step — never a price', () => {
    const html = renderToStaticMarkup(
      createElement(OfferRow, { offer: view, searchArticleNorm: 'OC90' }),
    );
    expect(html).toContain('action="/api/cart/items"');
    expect(html).toContain('name="q" value="OC90"');
    expect(html).toContain('name="offerId" value="OC90:Knecht:ORB1"');
    expect(html).toContain('name="qty" value="1"');
    expect(html).toContain('h-11');
    expect(html).not.toMatch(/name="price/i);
    expect(text(html)).toContain('В корзину');
  });

  it('OfferRow: no button for marked goods or without stock', () => {
    const excluded = renderToStaticMarkup(
      createElement(OfferRow, {
        offer: { ...view, excluded: true, excludedReason: 'Масла' },
        searchArticleNorm: 'EDGE5W40',
      }),
    );
    expect(excluded).not.toContain('/api/cart/items');
    expect(text(excluded)).toContain('Не продаём онлайн');
    const empty = renderToStaticMarkup(
      createElement(OfferRow, { offer: { ...view, available: 0 }, searchArticleNorm: 'OC90' }),
    );
    expect(empty).not.toContain('/api/cart/items');
  });

  it('OfferRow: no "В корзину" while online checkout is closed (no dead-end cart)', () => {
    const closed = renderToStaticMarkup(
      createElement(OfferRow, { offer: view, searchArticleNorm: 'OC90', orderingOpen: false }),
    );
    expect(closed).not.toContain('/api/cart/items');
    expect(text(closed)).toContain(view.priceText.replace(/\u00a0/g, ' '));
  });

  it('PaymentSchemeNote: the phone note only under payment on handover', () => {
    const cod = renderToStaticMarkup(
      createElement(PaymentSchemeNote, { scheme: 'pay_on_handover', sentences: ['Оплата'] }),
    );
    expect(text(cod)).toContain(FINAL_SCHEME_NOTE);
    const prepay = renderToStaticMarkup(
      createElement(PaymentSchemeNote, { scheme: 'prepay', sentences: ['Предоплата'] }),
    );
    expect(text(prepay)).not.toContain(FINAL_SCHEME_NOTE);
    expect(text(prepay)).toContain('Предоплата 100% онлайн');
  });

  it('AddToCartForm names the offer for screen readers', () => {
    const html = renderToStaticMarkup(
      createElement(AddToCartForm, { q: 'OC90', offerId: 'x', qty: 2, title: 'Knecht OC 90' }),
    );
    expect(html).toContain('aria-label="В корзину: Knecht OC 90"');
    expect(html).toContain('name="qty" value="2"');
  });

  it('SiteHeader: the cart link with the number of lines', () => {
    const html = renderToStaticMarkup(
      createElement(SiteHeader, { brandName: 'Тест', cartCount: 3 }),
    );
    expect(html).toContain('href="/cart"');
    expect(html).toContain('aria-label="Корзина: 3 позиции"');
    expect(text(html)).toContain('Корзина 3');
    const empty = renderToStaticMarkup(
      createElement(SiteHeader, { brandName: 'Тест', cartCount: 0 }),
    );
    expect(empty).not.toContain('header-cart-count');
    expect(cartCountLabel(1)).toBe('1 позиция');
    expect(cartCountLabel(11)).toBe('11 позиций');
    expect(cartCountLabel(22)).toBe('22 позиции');
  });
});

describe('cart HTTP helpers', () => {
  it('reads the cart cookie among others and serializes it with the cart-store options', () => {
    const request = new Request('http://localhost/', {
      headers: { cookie: 'a=1; cart=abc; cart=second; b="q"' },
    });
    const cookies = requestCookies(request);
    expect(cookies.get('cart')?.value).toBe('abc');
    expect(cookies.get('b')?.value).toBe('q');
    expect(cookies.get('missing')).toBeUndefined();
    expect(cartSetCookie('tok', { APP_BASE_URL: 'https://x.example', CART_TTL_DAYS: 1 })).toBe(
      'cart=tok; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax; Secure',
    );
  });

  it('error codes map to statuses and messages', () => {
    expect(new CartRequestError('excluded').status).toBe(422);
    expect(new CartRequestError('excluded').message).toBe('Не продаём онлайн, спросите в сервисе');
    expect(new CartRequestError('line_not_found').status).toBe(404);
    expect(new CartRequestError('forbidden_origin').status).toBe(403);
    expect(new CartRequestError('supplier_unavailable').status).toBe(503);
    expect(isCartErrorCode('cart_full')).toBe(true);
    expect(isCartErrorCode('toString')).toBe(false);
    expect(CART_ERROR_MESSAGES.cart_full).toContain('20');
  });
});

/**
 * Next bundles the /cart page and the /api/cart route handlers separately; the cart service
 * and the supplier client are process-wide singletons built by whichever bundle ran first, so
 * their errors may come from another copy of the error classes.
 */
describe('errors from another bundle copy', () => {
  const env = { APP_BASE_URL: 'http://127.0.0.1:3100', CART_TTL_DAYS: 30 };
  const ORIGIN_HEADERS = { origin: 'http://127.0.0.1:3100' };

  /** A twin of CartRequestError, as another bundle's copy of errors.ts would define it. */
  class ForeignCartRequestError extends Error {
    override name = 'CartRequestError';
    readonly code = 'qty';
    readonly status = 422;
    readonly retryAfterSec = null;
  }

  function throwingService(error: Error): CartService {
    const fail = () => Promise.reject(error);
    return { addItem: fail, updateItem: fail, removeItem: fail, viewCart: fail };
  }

  it('a foreign CartRequestError keeps its code and status (not a 500)', async () => {
    const foreign = new ForeignCartRequestError('В наличии только 24 шт.');
    expect(isCartRequestError(foreign)).toBe(true);
    expect(isCartRequestError(Object.assign(new Error('x'), { name: 'CartRequestError' }))).toBe(
      false,
    );
    const deps = { service: throwingService(foreign), env };
    const viaForm = await handleLineRequest(
      new Request('http://127.0.0.1:3100/api/cart/items/x', {
        method: 'POST',
        headers: { ...ORIGIN_HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
        body: '_method=patch&qty=99',
      }),
      '00000000-0000-7000-8000-000000000000',
      deps,
    );
    expect(viaForm.status).toBe(303);
    expect(viaForm.headers.get('location')).toBe('/cart?error=qty');
    const viaJson = await handleAddItem(
      new Request('http://127.0.0.1:3100/api/cart/items', {
        method: 'POST',
        headers: { ...ORIGIN_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ q: 'OC90', offerId: 'x' }),
      }),
      deps,
    );
    expect(viaJson.status).toBe(422);
    expect(await viaJson.json()).toEqual({ error: 'qty', message: 'В наличии только 24 шт.' });
  });

  it('a foreign Rossko rate-limit error -> 503 with Retry-After, not logged as a fault', async () => {
    class ForeignRateLimit extends Error {
      override name = 'RosskoRateLimitError';
      readonly retryAfterMs = 4_200;
    }
    const logged: string[] = [];
    const service = createCartService({
      db: {} as never,
      supplier: { rossko: { search: () => Promise.reject(new ForeignRateLimit('limit')) } },
      loadSettings: () => Promise.resolve(settings()),
      onError: (_error, what) => logged.push(what),
    });
    const res = await handleAddItem(
      new Request('http://127.0.0.1:3100/api/cart/items', {
        method: 'POST',
        headers: { ...ORIGIN_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ q: 'OC90', offerId: 'OC90:Knecht:ORB1' }),
      }),
      { service, env },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(logged).toEqual([]);
  });

  it('logged failures drop drizzle query parameters (the cart token)', () => {
    const token = 'A'.repeat(43);
    const cause = Object.assign(new Error('connection terminated'), {
      name: 'PostgresError',
      code: '57P01',
    });
    const queryError = Object.assign(
      new Error(`Failed query: select 1 where anon_token = $1\nparams: ${token}`),
      { query: 'select 1 where anon_token = $1', params: [token], cause },
    );
    const fields = safeErrorFields(queryError);
    expect(fields).toMatchObject({
      name: 'PostgresError',
      code: '57P01',
      message: 'connection terminated',
    });
    expect(JSON.stringify(fields)).not.toContain(token);
    expect(safeErrorFields(new TypeError('boom'))).toMatchObject({
      name: 'TypeError',
      message: 'boom',
    });
  });
});
