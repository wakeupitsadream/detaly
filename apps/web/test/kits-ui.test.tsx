// Step 5 (docs/kits.md) without a database: the sample kits of the demo priced on the bundled
// Rossko fixtures, a kit section as the page renders it (the demo label, the choices, the oil
// sentence, the replacement time, the button or the phone), the home make tiles, the footer link
// and the words for search engines.
import { parseEnv, type Env } from '@detaly/config';
import { KIT_DEMO_LABEL, KIT_FIT_HINT, KIT_OIL_TEXT, priceOffer, type Offer } from '@detaly/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { AdminKitEditor, AdminKitList } from '@/components/admin/AdminKits';
import { Footer, footerShopLinks } from '@/components/Footer';
import {
  BRANDS_HINT,
  BRANDS_HINT_KITS,
  BrandGrid,
  brandTileHref,
} from '@/components/home/BrandGrid';
import { KitMakeGrid, KitModelList } from '@/components/kits/KitCatalog';
import { KitSection } from '@/components/kits/KitSection';
import { CAR_BRANDS } from '@/lib/brands';
import { kitPath } from '@/lib/kit-paths';
import { KITS_SEO, kitMakeSeo, kitModelSeo } from '@/lib/seo';
import { vinRequestHref } from '@/lib/vin-link';
import { EMPTY_KIT_FORM, type AdminKitRow } from '@/server/admin/kits';
import type { Brand } from '@/server/brand';
import { createDemoSupplier } from '@/server/demo/supplier';
import { kitBrand, kitMakes, kitMakeSlugs, kitModels, type KitRecord } from '@/server/kits/catalog';
import { DEMO_KITS, demoKitById } from '@/server/kits/demo-kits';
import { chosenOptions, priceKit, type KitView } from '@/server/kits/kit-view';
import type { Supplier } from '@/server/supplier';

const NOW = new Date('2026-10-05T07:00:00Z');

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let env: Env;
let supplier: Supplier;

beforeAll(() => {
  env = parseEnv({ SESSION_SECRET: 'test-session-secret-0123456789abcdef', DEMO_MODE: 'true' });
  supplier = createDemoSupplier({ env });
});

async function price(kit: KitRecord): Promise<KitView> {
  return priceKit(kit, {
    rossko: supplier.rossko,
    settings: await supplier.settings.get(),
    now: NOW,
  });
}

function vesta(): KitRecord {
  const kit = demoKitById('demo-lada-vesta');
  if (!kit) throw new Error('no demo Vesta');
  return kit;
}

/** The radio input of a line. */
function radio(html: string, lineId: string): string {
  return (
    [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)]
      .map((match) => match[0])
      .find((tag) => tag.includes(`value="${lineId}"`)) ?? ''
  );
}

function render(view: KitView, options: { orderingOpen?: boolean; phone?: string | null } = {}) {
  return renderToStaticMarkup(
    createElement(KitSection, {
      view,
      orderingOpen: options.orderingOpen ?? true,
      phone: options.phone ?? null,
    }),
  );
}

describe('the sample kits of the demo', () => {
  it('are two published samples of real makes, read by the admin parser', () => {
    expect(DEMO_KITS.map((kit) => [kit.makeSlug, kit.modelSlug, kit.slug, kit.status])).toEqual([
      ['lada', 'vesta', '1-6-16v', 'published'],
      ['hyundai', 'solaris', '1-6', 'published'],
    ]);
    for (const kit of DEMO_KITS) {
      expect(kit.demo, kit.id).toBe(true);
      expect(kitBrand(kit.makeSlug), kit.id).not.toBeNull();
      expect(new Set(kit.lines.map((line) => line.id)).size).toBe(kit.lines.length);
    }
    const lines = vesta().lines;
    expect(lines.map((line) => [line.position, line.brand, line.article, line.qty])).toEqual([
      [1, 'MANN', 'W914/2', 1],
      [2, 'KNECHT', 'OC90', 1],
      [3, 'MANN', 'C26003', 1],
      [4, 'MANN', 'CU1919', 1],
      [5, 'NGK', 'BKR6E', 4],
      [6, 'BOSCH', 'FR7DCX+', 4],
    ]);
    expect(lines[1]?.alternativeOf).toBe(lines[0]?.id);
    expect(lines[5]?.alternativeOf).toBe(lines[4]?.id);
  });

  it('every line of every sample is on offer in the fixtures', async () => {
    for (const kit of DEMO_KITS) {
      const view = await price(kit);
      expect(view.unavailable, kit.id).toBe(0);
      expect(view.supplierFailed, kit.id).toBe(false);
      for (const group of view.groups) {
        expect(
          group.options.every((option) => option.state === 'ok'),
          `${kit.id}: ${group.role}`,
        ).toBe(true);
      }
    }
  });

  it('the catalogue: makes in the order of the home page, models by name', () => {
    expect(kitMakes(DEMO_KITS).map((entry) => [entry.brand.slug, entry.models])).toEqual([
      ['lada', ['Vesta']],
      ['hyundai', ['Solaris']],
    ]);
    expect([...kitMakeSlugs(DEMO_KITS)]).toEqual(['lada', 'hyundai']);
    expect(kitMakeSlugs(null).size).toBe(0);
    expect(kitModels(DEMO_KITS, 'lada').map((entry) => entry.model)).toEqual(['Vesta']);
    expect(kitModels(DEMO_KITS, 'kia')).toEqual([]);
    expect(kitPath(vesta())).toBe('/to/lada/vesta#1-6-16v');
  });
});

describe('a kit priced now', () => {
  it('takes the main lines by default: the sum, the latest date, the roles', async () => {
    const view = await price(vesta());
    expect(view.title).toBe('ТО Lada Vesta 1.6 16V, 106 л.с.');
    expect(view.years).toBe('с 2015 г.');
    expect(view.groups.map((group) => group.role)).toEqual([
      'Фильтр масляный',
      'Фильтр воздушный',
      'Фильтр салонный',
      'Свечи зажигания',
    ]);
    // 798 + 884 + 1 114 + 4 × 314 ₽
    expect(view.totalKop).toBe(405_200);
    expect(view.totalText).toBe('4 052 ₽');
    expect(view.itemsCount).toBe(7);
    expect(view.installText).toBe('Замена ≈ 1 ч — можно записаться на установку после оформления');
    // MSK7 to order: 3 days from Monday 5 October + 1 buffer day.
    expect(view.promiseText).toBe('к пт 9 октября');
  });

  it('prices every line by priceOffer of the offer the preview rule chose', async () => {
    const view = await price(vesta());
    const settings = await supplier.settings.get();
    for (const group of view.groups) {
      for (const option of group.options) {
        const offer = option.offer;
        expect(offer, option.lineId).not.toBeNull();
        const found = (await supplier.rossko.search(offer!.searchArticleNorm)).offers.find(
          (candidate: Offer) =>
            `${candidate.articleNorm}:${candidate.brand}:${candidate.stock.stockId}` ===
            offer!.offerKey,
        );
        expect(found, option.lineId).toBeDefined();
        expect(offer!.priceClientKop).toBe(priceOffer(settings.pricing, found!).priceClientKop);
      }
    }
  });

  it('compares an alternative with its main line', async () => {
    const view = await price(vesta());
    const [oil, , , plugs] = view.groups;
    expect(oil?.options.map((option) => [option.brand, option.article, option.hint])).toEqual([
      ['MANN-FILTER', 'W 914/2', null],
      ['Knecht', 'OC 90', 'дешевле на 270 ₽ · быстрее'],
    ]);
    expect(plugs?.options[1]).toMatchObject({
      brand: 'BOSCH',
      qty: 4,
      hint: 'дешевле на 236 ₽ · дольше',
    });
    // The choice of the alternatives changes what goes to the cart.
    const picks = new Map([[oil!.mainLineId, oil!.options[1]!.lineId]]);
    expect(chosenOptions(view, picks).map((option) => option?.offer?.offerKey)).toEqual([
      'OC90:Knecht:ORB1',
      'C26003:MANN-FILTER:ORB1',
      'CU1919:MANN-FILTER:MSK7',
      'BKR6E:NGK:ORB1',
    ]);
  });

  it('a main line the supplier lacks: «Нет у поставщика», skipped, an alternative takes over', async () => {
    const kit: KitRecord = {
      ...vesta(),
      id: 'test-kit',
      lines: [
        {
          id: 'a',
          position: 1,
          role: 'Фильтр масляный',
          brand: 'ACME',
          article: 'NOPE123',
          qty: 1,
          alternativeOf: null,
        },
        {
          id: 'b',
          position: 2,
          role: null,
          brand: 'KNECHT',
          article: 'OC90',
          qty: 1,
          alternativeOf: 'a',
        },
        {
          id: 'c',
          position: 3,
          role: 'Колодки',
          brand: 'ACME',
          article: 'NOPE456',
          qty: 1,
          alternativeOf: null,
        },
        {
          id: 'd',
          position: 4,
          role: null,
          brand: 'NGK',
          article: 'BKR6E',
          qty: 4,
          alternativeOf: null,
        },
      ],
    };
    const view = await price(kit);
    expect(view.groups.map((group) => group.chosen)).toEqual(['b', null, 'd']);
    expect(view.unavailable).toBe(1);
    expect(view.groups[0]?.options[0]).toMatchObject({ state: 'unavailable', offer: null });
    // the alternative has no comparison without a priced main line
    expect(view.groups[0]?.options[1]?.hint).toBeNull();
    // the role of a line without one: the supplier's name of the part
    expect(view.groups[2]?.role).toBe('Свеча зажигания');
    expect(view.totalKop).toBe(52_800 + 4 * 31_400);
    const html = render(view);
    expect(text(html)).toContain('Нет у поставщика');
    expect(text(html)).toContain('Нет у поставщика: 1 позиция — в корзину не попадёт.');
    // the main line cannot be chosen, the alternative is checked
    expect(radio(html, 'a')).toContain('disabled=""');
    expect(radio(html, 'b')).toContain('checked=""');
    expect(radio(html, 'b')).not.toContain('disabled=""');
  });
});

describe('the kit section', () => {
  it('a sample says so; the oil sentence, the replacement time, the fit hint', async () => {
    const view = await price(vesta());
    const html = render(view);
    const words = text(html);
    expect(html).toContain('id="1-6-16v"');
    expect(words).toContain('ТО Lada Vesta 1.6 16V, 106 л.с.');
    expect(words).toContain(KIT_DEMO_LABEL);
    expect(words).toContain(`${KIT_OIL_TEXT}.`);
    expect(words).toContain('Замена ≈ 1 ч — можно записаться на установку после оформления.');
    expect(words).toContain(KIT_FIT_HINT);
    expect(words).toContain('Весь набор: 4 позиции');
    expect(words).toContain('4 052 ₽');
    // no installation price anywhere
    expect(words).not.toMatch(/установк[аиу][^.]*₽/);
  });

  it('one plain form: the kit, its version and a radio per choice, the main line checked', async () => {
    const view = await price(vesta());
    const html = render(view);
    expect(html).toContain('action="/api/cart/kits"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="kit" value="demo-lada-vesta"');
    expect(html).toContain('name="version" value="demo"');
    const [oil, , , plugs] = view.groups;
    for (const group of [oil!, plugs!]) {
      const radios = [
        ...html.matchAll(new RegExp(`<input[^>]*name="pick_${group.mainLineId}"[^>]*>`, 'g')),
      ];
      expect(radios).toHaveLength(2);
      expect(radios[0]?.[0]).toContain('checked=""');
      expect(radios[1]?.[0]).not.toContain('checked=""');
    }
    // lines without a choice carry no field: the server takes them as they are
    expect(html.match(/name="pick_/g)).toHaveLength(4);
    expect(html).toContain('data-testid="kit-add"');
    expect(text(html)).toContain('Весь набор в корзину');
  });

  it('a real kit has no sample label', async () => {
    const view = await price({ ...vesta(), demo: false, version: '2026-10-09T00:00:00.000Z' });
    expect(text(render(view))).not.toContain('Пример набора');
  });

  it('with the checkout closed: the phone instead of the button', async () => {
    const view = await price(vesta());
    const html = render(view, { orderingOpen: false, phone: '+7 900 000-00-01' });
    expect(html).not.toContain('data-testid="kit-add"');
    expect(html).toContain('href="tel:+79000000001"');
    expect(text(html)).toContain('Заказать по телефону');
    expect(text(html)).not.toContain(KIT_FIT_HINT);
  });
});

describe('the catalogue cards', () => {
  it('a make card leads to its models; a model card names the engines and years', () => {
    const makes = renderToStaticMarkup(createElement(KitMakeGrid, { makes: kitMakes(DEMO_KITS) }));
    expect(makes).toContain('href="/to/lada"');
    expect(makes).toContain('href="/to/hyundai"');
    expect(text(makes)).toContain('Lada Vesta');
    const lada = kitBrand('lada')!;
    const models = renderToStaticMarkup(
      createElement(KitModelList, { brand: lada, models: kitModels(DEMO_KITS, 'lada') }),
    );
    expect(models).toContain('href="/to/lada/vesta"');
    expect(text(models)).toContain('Lada Vesta 1.6 16V, 106 л.с. · с 2015 г.');
  });
});

describe('home: make tiles with kits', () => {
  it('a make with published kits leads to them with «ТО»; the others to the VIN request', () => {
    const html = renderToStaticMarkup(
      createElement(BrandGrid, { kitMakes: new Set(['lada', 'hyundai']) }),
    );
    expect(text(html)).toContain(BRANDS_HINT_KITS);
    expect(text(html)).not.toContain(BRANDS_HINT);
    for (const brand of CAR_BRANDS) {
      const tag = new RegExp(`<a[^>]*data-testid="home-brand-${brand.slug}"[^>]*>`).exec(html)?.[0];
      const kits = brand.slug === 'lada' || brand.slug === 'hyundai';
      const href = kits ? `/to/${brand.slug}` : vinRequestHref({ car: brand.name });
      expect(tag, brand.slug).toContain(`href="${href.replace(/&/g, '&amp;')}"`);
      expect(tag?.includes('data-kits="yes"'), brand.slug).toBe(kits);
    }
    expect(html.match(/>ТО<\/span>/g)?.length).toBeGreaterThanOrEqual(2);
    // Every tile keeps room for the chip, so the logos and names of a row stay level.
    const tiles = [...html.matchAll(/<a[^>]*data-testid="home-brand-[^"]*"[^>]*>/g)].map(
      (match) => match[0],
    );
    expect(tiles.length).toBeGreaterThanOrEqual(CAR_BRANDS.length);
    expect(tiles.filter((tag) => !/class="[^"]* pt-5 md:pt-6/.test(tag))).toEqual([]);
    expect(brandTileHref({ slug: 'kia', name: 'Kia' }, false)).toBe(vinRequestHref({ car: 'Kia' }));
  });

  it('without kits nothing changes: every tile asks for the VIN', () => {
    const html = renderToStaticMarkup(createElement(BrandGrid));
    expect(text(html)).toContain(BRANDS_HINT);
    expect(html).not.toContain('data-kits');
    expect(html).not.toContain('href="/to/');
    expect(html).not.toContain('pt-5 md:pt-6');
  });
});

const BRAND: Brand = {
  name: 'Тестовый бренд',
  siteUrl: 'http://localhost:3000',
  seller: {
    name: null,
    inn: null,
    ogrnip: null,
    address: null,
    email: null,
    phone: null,
  },
  pickup: { name: null, address: null, hours: null, phone: null },
  pickupLinks: { yandexMap: null, twoGisMap: null, telegram: null },
  pickupLogo: { color: null, emblemWhite: null },
  contactPhone: null,
  demoData: false,
  noindexAll: false,
};

describe('footer: «Наборы для ТО»', () => {
  it('is there only while a kit is published', () => {
    const withKits = renderToStaticMarkup(
      createElement(Footer, { brand: BRAND, year: 2026, kits: true }),
    );
    expect(withKits).toContain('href="/to"');
    expect(text(withKits)).toContain('Наборы для ТО');
    const without = renderToStaticMarkup(createElement(Footer, { brand: BRAND, year: 2026 }));
    expect(without).not.toContain('href="/to"');
    expect(footerShopLinks(true).map((link) => link.href)).toEqual([
      '/vin',
      '/to',
      '/returns',
      '/about',
    ]);
    expect(footerShopLinks(false).map((link) => link.href)).toEqual(['/vin', '/returns', '/about']);
  });
});

describe('words for search engines', () => {
  it('titles name the model and Orenburg; descriptions carry no price', () => {
    const model = kitModelSeo('Lada', 'Vesta', ['1.6 16V, 106 л.с.']);
    expect(model.title).toBe('ТО Lada Vesta в Оренбурге — набор запчастей');
    const make = kitMakeSeo('Lada', ['Granta', 'Vesta']);
    expect(make.title).toBe('ТО Lada в Оренбурге — наборы запчастей');
    expect(KITS_SEO.title).toBe('Наборы для ТО в Оренбурге');
    for (const description of [model.description, make.description, KITS_SEO.description]) {
      expect(description).toBeTruthy();
      expect(description).not.toMatch(/₽|руб/);
    }
  });
});

describe('the admin list and check (/admin/kits)', () => {
  const row = (overrides: Partial<AdminKitRow>): AdminKitRow => ({
    id: '0192f5a0-0000-7000-8000-000000000001',
    makeSlug: 'lada',
    makeName: 'Lada',
    model: 'Vesta',
    modelSlug: 'vesta',
    engine: '1.6 16V, 106 л.с.',
    years: 'с 2015 г.',
    slug: '1-6-16v',
    status: 'published',
    mainLines: 4,
    alternatives: 2,
    updatedAt: NOW,
    updatedBy: 'admin',
    ...overrides,
  });

  it('a kit per row: the car, the engine and years, the lines, the status and its page', () => {
    const html = renderToStaticMarkup(
      createElement(AdminKitList, {
        rows: [
          row({}),
          row({
            id: '0192f5a0-0000-7000-8000-000000000002',
            model: 'Granta',
            modelSlug: 'granta',
            engine: '1.6 8V',
            slug: '1-6-8v',
            status: 'draft',
            mainLines: 1,
            alternatives: 0,
          }),
        ],
        done: null,
      }),
    );
    const plain = text(html);
    expect(plain).toContain('Наборы: 2');
    expect(plain).toContain('Lada Vesta 1.6 16V, 106 л.с. · с 2015 г. 4 позиции + 2 аналога');
    expect(plain).toContain('Lada Granta 1.6 8V · с 2015 г. 1 позиция · изменён');
    expect(plain).toContain('Опубликован');
    expect(plain).toContain('Черновик');
    // only the published kit links to its page
    expect(html.match(/href="\/to\//g)).toEqual(['href="/to/']);
    expect(html).toContain('href="/to/lada/vesta#1-6-16v"');
    // no inner horizontal scroll: a list, not a wide table
    expect(html).not.toContain('<table');
  });

  it('a line without an offer shows the part as typed, a line that cannot be read its text', () => {
    const html = renderToStaticMarkup(
      createElement(AdminKitEditor, {
        kit: null,
        values: EMPTY_KIT_FORM,
        fieldErrors: {},
        draftMode: true,
        done: null,
        error: null,
        check: {
          lines: [
            {
              line: 1,
              raw: 'CASTROL EDGE5W40 1 — Масло моторное',
              part: 'CASTROL EDGE5W40',
              alternative: false,
              state: 'excluded',
              message: 'Маркируемый товар: масла — только в сервисе',
              role: 'Масло моторное',
              roleFromOffer: null,
              qty: 1,
              offer: null,
            },
            {
              line: 2,
              raw: 'MANN',
              part: null,
              alternative: false,
              state: 'parse',
              message: 'Нужны бренд, артикул и количество',
              role: null,
              roleFromOffer: null,
              qty: 0,
              offer: null,
            },
          ],
          totalText: '0 ₽',
          promiseText: null,
          problems: ['Строка 1: маркируемый товар — в набор нельзя'],
          checkedAt: NOW,
        },
      }),
    );
    const plain = text(html);
    // the verdict next to the part: in view on a phone too (a list, not a wide table)
    expect(plain).toContain('1 Масло моторное CASTROL EDGE5W40 ✗ маркируемый товар × 1');
    expect(plain).not.toContain('CASTROL EDGE5W40 1 — Масло моторное');
    expect(plain).toContain('2 MANN ✗ ошибка в строке Нужны бренд, артикул и количество');
    expect(html).not.toContain('<table');
    expect(plain).toContain(
      'Опубликовать пока нельзя: Строка 1: маркируемый товар — в набор нельзя',
    );
  });
});
