// Step 4 (docs/fit-check.md) on the pages, rendered without a database: the fit check form
// (fields, the pre-filled VIN, the ticked line, the honeypot, the promise under the button), the
// demo form that sends nothing but the line, the closed gate, every state of a cart line, the
// badge with and without the guarantee, the search card link, the «Гарантия подбора» section of
// /returns (only with FIT_GUARANTEE_ENABLED) and the claim label of the admin.
import { parseEnv, type Env } from '@detaly/config';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as Navigation from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepricedLine } from '@detaly/domain';
import type { ClaimView } from '@detaly/orders';
import type { FitLineView, FitShared } from '@/server/fit-checks/cart-fit';

const state = vi.hoisted(() => ({ env: null as unknown }));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock('@/server/env', () => ({ serverEnv: () => state.env }));
vi.mock('@/server/documents', () => ({ loadPublishedDocument: async () => null }));
vi.mock('@/server/logger', () => ({
  getLogger: () => ({ warn: () => undefined, error: () => undefined, info: () => undefined }),
}));

const { FitCheckForm } = await import('@/components/fit/FitCheckForm');
const { FitLineBlock } = await import('@/components/fit/FitLineBlock');
const { FitCheckedBadge, FIT_GUARANTEE_TEXT } = await import('@/components/fit/FitBadge');
const { FitSearchLink } = await import('@/components/fit/FitSearchLink');
const { FitGuaranteeNote, FIT_GUARANTEE_RETURNS_TEXT } =
  await import('@/components/returns/FitGuaranteeNote');
const { AdminOrder1C } = await import('@/components/admin/AdminOrder1C');
const { CheckoutSummary } = await import('@/components/checkout/CheckoutSummary');
const ReturnsPage = (await import('@/app/(site)/returns/page')).default;
type FitLineState = FitLineView['state'];

const VIN = 'XTA21099012345678';
const LINE = '01890000-0000-7000-8000-000000000001';
const OTHER = '01890000-0000-7000-8000-000000000002';
const WAITING = '01890000-0000-7000-8000-000000000003';

function env(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    APP_BASE_URL: 'https://shop.test',
    BRAND_NAME: 'Тестовый бренд',
    ...overrides,
  });
}

beforeEach(() => {
  state.env = env();
});

const SHARED: FitShared = {
  open: true,
  closedMessage: 'Проверка откроется вместе с заказами на сайте. Пока позвоните: +7 900 000-00-01',
  phone: { text: '+7 900 000-00-01', href: 'tel:+79000000001' },
  demo: false,
  guarantee: false,
  lastVin: VIN,
  promiseText: 'Мастер проверит в течение часа',
  pendingText: 'Мастер проверяет · ответит в течение часа',
  commentMax: 200,
  messages: { vin: 'Проверьте VIN', lines: 'Отметьте деталь', internal: 'Не удалось' },
};

const LINES = [
  { id: LINE, title: 'Knecht OC 90', name: 'Фильтр масляный', pending: false },
  { id: OTHER, title: 'MANN-FILTER W 914/2', name: 'Фильтр масляный', pending: false },
  { id: WAITING, title: 'LUCAS GDB1330', name: 'Колодки', pending: true },
];

function html(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Some `<tag …>` of the markup carries every one of these attributes (in any order). */
function hasTag(markup: string, tag: string, attrs: readonly string[]): boolean {
  return [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].some(([open]) =>
    attrs.every((attr) => open.includes(attr)),
  );
}

function form(shared: Partial<FitShared> = {}, error: string | null = null): string {
  return html(
    createElement(FitCheckForm, {
      lineId: LINE,
      lines: LINES,
      shared: { ...SHARED, ...shared },
      error,
    }),
  );
}

function block(
  stateName: FitLineState,
  options: {
    shared?: Partial<FitShared>;
    analog?: FitLineView['analog'];
    demoDone?: boolean;
    openInitially?: boolean;
  } = {},
): string {
  return html(
    createElement(FitLineBlock, {
      lineId: LINE,
      view: { state: stateName, analog: options.analog ?? null },
      shared: { ...SHARED, ...options.shared },
      lines: LINES,
      openInitially: options.openInitially ?? false,
      demoDone: options.demoDone ?? false,
      refreshHref: `/cart?r=1#fit-${LINE}`,
    }),
  );
}

describe('the fit check form', () => {
  it('posts the VIN, the comment, the ticked lines and the honeypot to /api/fit-checks', () => {
    const markup = form();
    expect(hasTag(markup, 'form', [`action="/api/fit-checks?line=${LINE}"`, 'method="post"'])).toBe(
      true,
    );
    expect(hasTag(markup, 'input', ['name="vin"', `value="${VIN}"`])).toBe(true);
    expect(hasTag(markup, 'textarea', ['name="comment"', 'maxLength="200"'])).toBe(true);
    expect(markup).toContain('placeholder="Например: двигатель 1.6, 2019"');
    expect(hasTag(markup, 'input', ['type="hidden"', 'name="line"', `value="${LINE}"`])).toBe(true);
    // The line the form was opened from is ticked; the others are not; a waiting line is locked.
    expect(hasTag(markup, 'input', ['name="lines"', `value="${LINE}"`, 'checked=""'])).toBe(true);
    expect(hasTag(markup, 'input', ['name="lines"', `value="${OTHER}"`, 'checked=""'])).toBe(false);
    expect(hasTag(markup, 'input', ['name="lines"', `value="${WAITING}"`, 'disabled=""'])).toBe(
      true,
    );
    expect(text(markup)).toContain('Мастер уже проверяет');
    // «Все детали корзины»: two lines can be sent.
    expect(hasTag(markup, 'input', ['name="all"', 'value="on"'])).toBe(true);
    expect(markup).toMatch(/name="website"/);
    expect(text(markup)).toContain('Отправить мастеру');
    expect(text(markup)).toContain('Мастер проверит в течение часа');
  });

  it('shows a returned error and keeps the VIN empty without an earlier request', () => {
    const markup = form({ lastVin: null }, 'Проверьте VIN: 17 символов');
    expect(markup).toContain('data-testid="fit-form-error"');
    expect(text(markup)).toContain('Проверьте VIN: 17 символов');
    expect(hasTag(markup, 'input', ['name="vin"', 'value='])).toBe(false);
  });

  it('DEMO_MODE: no field has a name — a submit sends nothing but the line, to /cart', () => {
    const markup = form({ demo: true });
    expect(hasTag(markup, 'form', ['method="get"', `action="/cart#fit-${LINE}"`])).toBe(true);
    expect(markup).toContain(`name="fit_demo" value="${LINE}"`);
    for (const name of ['vin', 'comment', 'lines', 'all', 'website', 'line']) {
      expect(markup).not.toContain(`name="${name}"`);
    }
    expect(markup).not.toContain('/api/fit-checks');
    expect(text(markup)).toContain('Демо: VIN не уйдёт с этой страницы');
  });

  it('the closed gate: no form and no VIN field, the explanation and the phone', () => {
    const markup = form({ open: false });
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('fit-vin');
    expect(text(markup)).toContain('Проверка откроется вместе с заказами на сайте');
    expect(markup).toContain('href="tel:+79000000001"');
  });
});

describe('a cart line and its check', () => {
  it('none: «Проверить под мою машину» opens the form inline without JavaScript', () => {
    const markup = block('none');
    expect(markup).toContain('data-state="none"');
    expect(markup).toContain(`id="fit-${LINE}"`);
    expect(hasTag(markup, 'details', ['data-testid="fit-open-details"'])).toBe(true);
    expect(text(markup)).toContain('Проверить под мою машину');
    expect(hasTag(markup, 'details', [' open=""'])).toBe(false);
    expect(hasTag(block('none', { openInitially: true }), 'details', [' open=""'])).toBe(true);
  });

  it('pending: the promise of the answer and «Обновить» for a page without JavaScript', () => {
    const markup = block('pending');
    expect(text(markup)).toContain('Мастер проверяет · ответит в течение часа');
    expect(markup).toContain(`href="/cart?r=1#fit-${LINE}"`);
    expect(text(markup)).toContain('Обновить');
  });

  it('fits and an accepted analog: «Проверено мастером»; the guarantee line only when on', () => {
    for (const name of ['fits', 'analog_accepted'] as const) {
      const off = block(name);
      expect(text(off)).toContain('Проверено мастером');
      expect(off).not.toContain('/returns#fit-guarantee');
      expect(text(off)).not.toContain('вернём деньги');
      const on = block(name, { shared: { guarantee: true } });
      expect(text(on)).toContain(FIT_GUARANTEE_TEXT);
      expect(on).toContain('href="/returns#fit-guarantee"');
    }
  });

  it('analog: brand, article, the price and the date, «Заменить» and «Оставить как есть»', () => {
    const analog = {
      brand: 'MANN-FILTER',
      article: 'W 914/2',
      name: 'Фильтр масляный',
      priceText: '450 ₽',
      promiseText: 'к пт 10 октября',
    };
    const markup = block('analog_offer', { analog });
    expect(text(markup)).toContain(
      'Мастер предлагает аналог: MANN-FILTER W 914/2 · 450 ₽ · к пт 10 октября',
    );
    expect(markup).toContain(`action="/api/cart/items/${LINE}/fit"`);
    expect(markup).toContain('name="action" value="replace"');
    expect(markup).toContain('name="action" value="keep"');
    expect(text(markup)).toContain('Оставить как есть');
    const kept = block('analog_kept', { analog });
    expect(text(kept)).toContain('Вы оставили свою деталь');
    expect(kept).not.toContain('value="keep"');
    expect(text(kept)).not.toContain('Проверено мастером');
  });

  it('not_fit: «Удалить из корзины» and the VIN request', () => {
    const markup = block('not_fit');
    expect(text(markup)).toContain('Не подходит для вашей машины');
    expect(markup).toContain(`action="/api/cart/items/${LINE}"`);
    expect(markup).toContain('name="_method" value="delete"');
    expect(text(markup)).toContain('Удалить из корзины');
    expect(markup).toContain('href="/vin"');
  });

  it('call_needed: «Мастеру нужно уточнить — позвоните <phone>» with a tel: link', () => {
    const markup = block('call_needed');
    expect(text(markup)).toContain('Мастеру нужно уточнить — позвоните +7 900 000-00-01');
    expect(markup).toContain('href="tel:+79000000001"');
    expect(text(block('call_needed', { shared: { phone: null } }))).toContain(
      'спросите в пункте выдачи',
    );
  });

  it('expired: «Мастер не успел ответить» and «Отправить снова»', () => {
    const markup = block('expired');
    expect(text(markup)).toContain('Мастер не успел ответить');
    expect(text(markup)).toContain('Отправить снова');
  });

  it('DEMO_MODE: the line of a demo form post shows the demo answer, labelled', () => {
    const markup = block('none', { shared: { demo: true }, demoDone: true });
    expect(markup).toContain('data-state="demo_done"');
    expect(text(markup)).toContain('Проверено мастером · демо');
    expect(text(markup)).not.toContain('вернём деньги');
    expect(
      text(block('none', { shared: { demo: true, guarantee: true }, demoDone: true })),
    ).toContain(FIT_GUARANTEE_TEXT);
    // Outside the demo the query cannot fake an answer.
    expect(block('none', { demoDone: true })).toContain('data-state="none"');
  });

  it('the badge alone: the fact, the guarantee line links to /returns', () => {
    expect(text(html(createElement(FitCheckedBadge, { guarantee: false })))).toBe(
      'Проверено мастером',
    );
    expect(html(createElement(FitCheckedBadge, { guarantee: true }))).toContain(
      'href="/returns#fit-guarantee"',
    );
  });
});

describe('the checkout summary', () => {
  const offer = {
    source: 'rossko',
    brand: 'Knecht',
    article: 'OC 90',
    articleNorm: 'OC90',
    name: 'Фильтр масляный',
  };
  const line = (id: string) =>
    ({
      id,
      offer,
      qty: 1,
      priceClientKop: 52_800,
      isLocal: true,
      etaDate: '2026-10-10',
    }) as unknown as RepricedLine;

  function summary(fitGuarantee: boolean): string {
    return html(
      createElement(CheckoutSummary, {
        lines: [line(LINE), line(OTHER)],
        totalKop: 105_600,
        promisedDate: null,
        linePromises: {},
        fitChecked: { [LINE]: true, [OTHER]: false },
        fitGuarantee,
      }),
    );
  }

  it('«Проверено мастером» on the checked line only; the guarantee line when enabled', () => {
    expect(text(summary(false)).match(/Проверено мастером/g)).toHaveLength(1);
    expect(summary(false)).not.toContain('/returns#fit-guarantee');
    expect(summary(true).match(/href="\/returns#fit-guarantee"/g)).toHaveLength(1);
  });
});

describe('the search card link', () => {
  const props = {
    q: 'OC90',
    offerId: 'OC90:Knecht:ORB1',
    qty: 1,
    title: 'Knecht OC 90',
    phone: '+7 900 000-00-01',
  };

  it('adds the offer and opens its form: a plain post with then=check', () => {
    const markup = html(createElement(FitSearchLink, { ...props, open: true }));
    expect(hasTag(markup, 'form', ['method="post"', 'action="/api/cart/items"'])).toBe(true);
    expect(markup).toContain('name="then" value="check"');
    expect(markup).toContain('name="offerId" value="OC90:Knecht:ORB1"');
    expect(text(markup)).toContain('Проверить под мою машину');
  });

  it('the closed gate: the same words open the explanation with the phone, no cart', () => {
    const markup = html(createElement(FitSearchLink, { ...props, open: false }));
    expect(markup).not.toContain('/api/cart/items');
    expect(text(markup)).toContain('Проверка откроется вместе с заказами на сайте');
    expect(markup).toContain('href="tel:+79000000001"');
  });
});

describe('/returns: «Гарантия подбора»', () => {
  it('the section has the anchor and the draft text', () => {
    const markup = html(createElement(FitGuaranteeNote));
    expect(markup).toContain('id="fit-guarantee"');
    expect(text(markup)).toContain('Гарантия подбора');
    expect(text(markup)).toContain(FIT_GUARANTEE_RETURNS_TEXT);
  });

  it('only with FIT_GUARANTEE_ENABLED', async () => {
    const off = html(await ReturnsPage());
    expect(off).not.toContain('id="fit-guarantee"');
    state.env = env({ FIT_GUARANTEE_ENABLED: 'true' });
    const on = html(await ReturnsPage());
    expect(on).toContain('id="fit-guarantee"');
    expect(text(on)).toContain('вернём деньги полностью — даже если упаковка вскрыта');
  });
});

describe('the admin claim of an item with the fit guarantee', () => {
  function claim(kind: ClaimView['kind'], fitGuarantee: boolean): ClaimView {
    const openedAt = new Date('2026-10-09T08:00:00Z');
    return {
      id: '01890000-0000-7000-8000-0000000000c1',
      orderId: '01890000-0000-7000-8000-0000000000a1',
      orderItemId: '01890000-0000-7000-8000-0000000000b1',
      item: {
        id: '01890000-0000-7000-8000-0000000000b1',
        brand: 'Knecht',
        article: 'OC 90',
        fitGuarantee,
      },
      kind,
      openedAt,
      deadlineAt: new Date('2026-10-19T08:00:00Z'),
      decision: null,
      decidedAt: null,
      returnAcceptedAt: null,
      compensationAmountKop: null,
      refundId: null,
      closedAt: null,
      replacementOrderedAt: null,
      photoCount: 0,
      photos: [],
      returnPhotos: [],
      openedVia: 'web',
      decidedVia: null,
      clientText: null,
      decisionText: null,
      overrideReason: null,
      replacementNote: null,
      open: true,
    };
  }

  function admin(claims: ClaimView[]): string {
    return html(
      createElement(AdminOrder1C, {
        orderId: '01890000-0000-7000-8000-0000000000a1',
        data: { claims, bookings: [], photos: [], actions: [] },
        items: [{ id: '01890000-0000-7000-8000-0000000000b1', title: 'Knecht OC 90' }],
        canOpenClaim: false,
      }),
    );
  }

  it('«Гарантия подбора: мастер проверил под VIN» on a «не подошла» claim only', () => {
    expect(text(admin([claim('not_fit', true)]))).toContain(
      'Гарантия подбора: мастер проверил под VIN',
    );
    expect(text(admin([claim('not_fit', false)]))).not.toContain('Гарантия подбора');
    expect(text(admin([claim('defect', true)]))).not.toContain('Гарантия подбора');
  });
});
