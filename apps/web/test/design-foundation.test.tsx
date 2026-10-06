// Foundation of the storefront (docs/design-v2.md, package F): category glyphs, plural forms,
// the shared header/footer contracts and the base components, rendered without Next.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DemoDataBanner } from '@/components/DemoDataBanner';
import { Footer } from '@/components/Footer';
import { CATEGORY_LABEL, categoryOf } from '@/components/icons';
import { INSTALL_FALLBACK_TEXT, InstallLine } from '@/components/install/InstallLine';
import { MobileCartBar } from '@/components/MobileCartBar';
import { STOCK_BADGE_TEXT, StockBadge } from '@/components/StockBadge';
import { Badge } from '@/components/ui/Badge';
import { buttonClass } from '@/components/ui/Button';
import { Field, fieldDescribedBy } from '@/components/ui/Field';
import { PartTile } from '@/components/ui/PartTile';
import { cartCountLabel, plural } from '@/lib/plural';
import type { Brand } from '@/server/brand';
import { planInstallForDate, planInstallForOffers } from '@/server/install';

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BRAND: Brand = {
  name: 'Тестовый бренд',
  siteUrl: 'http://localhost:3000',
  seller: {
    name: 'Тестов Тест Тестович',
    inn: '0000',
    ogrnip: null,
    address: 'г. Оренбург',
    email: 'shop@example.test',
    phone: '+7 (3532) 00-00-00',
  },
  pickup: { name: null, address: null, hours: null, phone: null },
  contactPhone: null,
  demoData: false,
  noindexAll: true,
};

describe('categoryOf', () => {
  it.each([
    ['Фильтр масляный', 'filter'],
    ['ФИЛЬТР ВОЗДУШНЫЙ', 'filter'],
    ['Колодки тормозные дисковые передние', 'pads'],
    ['Диск тормозной вентилируемый', 'disc'],
    ['Свеча зажигания', 'plug'],
    ['Амортизатор задний газовый', 'shock'],
    ['Стойка стабилизатора', 'shock'],
    ['Ремень ГРМ', 'belt'],
    ['Комплект ремня поликлинового', 'belt'],
    ['Подшипник ступицы', 'bearing'],
    ['Ступица в сборе', 'bearing'],
    ['Щётка стеклоочистителя', 'wiper'],
    ['Щетка дворника 600 мм', 'wiper'],
    ['Лампа H7 12V', 'bulb'],
    ['Масло моторное 5W-30', 'oil'],
    ['Ремкомплект суппорта', 'part'],
    ['Датчик ABS передний', 'part'],
    ['Фаркоп', 'part'],
    ['Прокладка клапанной крышки', 'engine'],
    ['Опора двигателя', 'engine'],
    ['Диск сцепления', 'clutch'],
    ['Комплект сцепления', 'clutch'],
    ['Подшипник выжимной', 'clutch'],
    ['Радиатор охлаждения', 'cooling'],
    ['Насос водяной (помпа)', 'cooling'],
    ['Термостат', 'cooling'],
    ['Датчик температуры охлаждающей жидкости', 'cooling'],
    ['Комплект ремня ГРМ с помпой', 'belt'],
    ['Цепь ГРМ', 'belt'],
    ['Фара передняя левая', 'bulb'],
    ['Бампер передний', 'body'],
    ['Зеркало наружное', 'body'],
    ['', 'part'],
  ] as const)('%s -> %s', (name, category) => {
    expect(categoryOf(name)).toBe(category);
  });

  it('null and undefined fall back to the nut', () => {
    expect(categoryOf(null)).toBe('part');
    expect(categoryOf(undefined)).toBe('part');
  });

  it('every category has a label', () => {
    for (const label of Object.values(CATEGORY_LABEL)) expect(label).not.toBe('');
  });

  it('PartTile shows the glyph only (v2: no caption), never a "no photo" text', () => {
    const html = renderToStaticMarkup(createElement(PartTile, { name: 'Фильтр масляный' }));
    expect(html).toContain('data-category="filter"');
    expect(html).toContain('<svg');
    expect(text(html)).toBe('');
    expect(html).toContain('aria-hidden');
    expect(html.toLowerCase()).not.toContain('фото');
  });
});

describe('plural', () => {
  it.each([
    [0, 'позиций'],
    [1, 'позиция'],
    [2, 'позиции'],
    [5, 'позиций'],
    [11, 'позиций'],
    [12, 'позиций'],
    [21, 'позиция'],
    [24, 'позиции'],
    [111, 'позиций'],
  ])('%i -> %s', (n, word) => {
    expect(plural(n, 'позиция', 'позиции', 'позиций')).toBe(word);
    expect(cartCountLabel(n)).toBe(`${n} ${word}`);
  });
});

describe('shared chrome', () => {
  it('Footer: requisites plate with the INN line and the developer credit', () => {
    const html = renderToStaticMarkup(createElement(Footer, { brand: BRAND, year: 2026 }));
    expect(html).toContain('data-testid="site-footer"');
    expect(html).toMatch(/data-testid="footer-inn">ИНН 0000/);
    expect(html).toContain('aria-label="Документы"');
    expect(html).toContain('href="/docs/offer"');
    expect(html).toContain('<a href="https://maxim-batutin.ru" target="_blank" rel="noopener"');
    expect(text(html)).toContain('Дизайн и разработка — maxim-batutin.ru');
    expect(text(html)).toContain('© 2026 Тестовый бренд');
  });

  it('MobileCartBar: only with lines in the cart', () => {
    expect(renderToStaticMarkup(createElement(MobileCartBar, { cartCount: 0 }))).toBe('');
    const html = renderToStaticMarkup(createElement(MobileCartBar, { cartCount: 2 }));
    expect(html).toContain('data-testid="mobile-cart-bar"');
    expect(text(html)).toContain('В корзине 2 позиции');
    expect(html).toContain('href="/cart"');
  });

  it('StockBadge texts are unchanged', () => {
    expect(text(renderToStaticMarkup(createElement(StockBadge, { isLocal: true })))).toBe(
      STOCK_BADGE_TEXT.local,
    );
    expect(text(renderToStaticMarkup(createElement(StockBadge, { isLocal: false })))).toBe(
      STOCK_BADGE_TEXT.order,
    );
  });

  it('DemoDataBanner links the demo articles as plain links', () => {
    const html = renderToStaticMarkup(createElement(DemoDataBanner));
    expect(html).toContain('data-testid="demo-banner"');
    for (const article of ['OC90', 'W9142', 'GDB1330']) {
      expect(html).toContain(`href="/search?q=${article}"`);
    }
  });
});

describe('base components', () => {
  it('primary button: white on the brand token, never a raw colour', () => {
    const primary = buttonClass();
    expect(primary).toContain('bg-brand');
    expect(primary).toContain('text-on-brand');
    expect(primary).not.toContain('text-white');
    expect(primary).not.toMatch(/#[0-9a-f]{3,6}/i);
    expect(buttonClass({ size: 'lg' })).toContain('min-h-13');
    expect(buttonClass({ size: 'md' })).toContain('min-h-12');
  });

  it('Badge carries data attributes through', () => {
    const html = renderToStaticMarkup(
      createElement(Badge, { tone: 'demo', 'data-testid': 'x' } as never, 'демо'),
    );
    expect(html).toContain('data-testid="x"');
    expect(html).toContain('bg-wait-soft');
    expect(html).toContain('rounded-full');
  });

  it('Field wires hint and error ids', () => {
    expect(fieldDescribedBy('phone', {})).toBeUndefined();
    expect(fieldDescribedBy('phone', { hint: 'h', error: 'e' })).toBe('phone-hint phone-error');
    const html = renderToStaticMarkup(
      createElement(Field, {
        id: 'phone',
        label: 'Телефон',
        error: 'Неверный номер',
        children: null,
      }),
    );
    expect(html).toContain('for="phone"');
    expect(html).toContain('id="phone-error"');
  });

  it('InstallLine: the slot or the honest fallback', () => {
    const none = text(renderToStaticMarkup(createElement(InstallLine, { plan: null })));
    expect(none).toBe(`Установка — ${INSTALL_FALLBACK_TEXT}`);
    const html = renderToStaticMarkup(
      createElement(InstallLine, {
        plan: {
          partText: 'к чт 8 октября',
          slotText: 'чт 8 окт с 14:00',
          carReadyText: 'к 16:00',
          demo: true,
          slotStartIso: '2026-10-08T14:00:00+05:00',
        },
      }),
    );
    expect(text(html)).toBe('С установкой — машина готова чт 8 окт к 16:00');
    expect(html).toContain('dateTime="2026-10-08T14:00:00+05:00"');
    expect(html).toContain('title="Установка: чт 8 окт с 14:00"');
  });

  it('install contract never fails: no offers give an empty map, a date gives a plan or null', async () => {
    expect((await planInstallForOffers([], new Date())).size).toBe(0);
    // Null when the env has no parsable PICKUP_HOURS (or the load source fails); otherwise a
    // full plan. Either way the page never sees an exception.
    const plan = await planInstallForDate('2026-10-08', new Date());
    if (plan !== null) {
      expect(plan.slotText).not.toBe('');
      expect(plan.carReadyText).toMatch(/^к \d{1,2}:\d{2}$/);
      expect(plan.slotStartIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    }
  });
});
