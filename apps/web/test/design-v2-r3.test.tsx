// Redesign 2, round 3 critique: the fixes rendered without Next (docs/design-v2.md). The glyph
// of a part fills the tile, the dark panel tiles lead somewhere, how to pay is said before the
// order, the documents get a table of contents, the proposal says how it is paid.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CartSummary } from '@/components/CartSummary';
import { PaymentSchemeNote } from '@/components/checkout/PaymentSchemeNote';
import { PAYMENT_METHOD_LINE } from '@/components/checkout/scheme-text';
import { WhyUs } from '@/components/home/WhyUs';
import { RouteLinks } from '@/components/PickupRouteLinks';
import { PartTile } from '@/components/ui/PartTile';
import { StepNumber } from '@/components/ui/StepNumber';
import { proposalPaymentLine } from '@/components/vin/ProposalSheet';
import { CAR_BRANDS } from '@/lib/brands';
import { headingAnchors, Markdown } from '@/lib/markdown';
import { vinRequestHref } from '@/lib/vin-link';
import type { ProposalLineView } from '@/server/vin/proposal-page';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => null,
}));

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('PartTile', () => {
  it('draws the glyph at about two thirds of the plate', () => {
    const md = renderToStaticMarkup(createElement(PartTile, { name: 'Фильтр масляный' }));
    expect(md).toContain('width="48"');
    expect(md).toContain('width="52"');
    expect(md).toContain('lg:size-20');
    const sm = renderToStaticMarkup(
      createElement(PartTile, { name: 'Фильтр масляный', size: 'sm' }),
    );
    expect(sm).toContain('width="40"');
    expect(sm).not.toContain('width="30"');
  });
});

describe('brand logos', () => {
  it('wide ovals and plates are drawn smaller, compact emblems keep their size', () => {
    const scale = (slug: string) => CAR_BRANDS.find((brand) => brand.slug === slug)?.scale ?? 1;
    for (const slug of ['kia', 'ford', 'hyundai', 'lada', 'chevrolet']) {
      expect(scale(slug)).toBeLessThan(1);
    }
    for (const slug of ['renault', 'volkswagen', 'skoda', 'mercedes-benz']) {
      expect(scale(slug)).toBe(1);
    }
    for (const brand of CAR_BRANDS) {
      expect(brand.scale ?? 1).toBeGreaterThan(0.5);
      expect(brand.scale ?? 1).toBeLessThanOrEqual(1);
    }
  });
});

describe('dark panel', () => {
  it('every tile is a link to where its caption leads', () => {
    const html = renderToStaticMarkup(createElement(WhyUs, { brandName: 'Тест' }));
    const tile = (key: string) =>
      new RegExp(`data-testid="home-why-${key}"[^>]*>\\s*<a[^>]*href="([^"]*)"`).exec(html)?.[1];
    expect(tile('vin')).toBe(vinRequestHref());
    expect(tile('install')).toBe('/about#pickup');
    expect(tile('return')).toBe('/returns');
    for (const key of ['cod', 'date', 'receipt']) expect(tile(key)).toBe('/about#about-why');
    expect(html.match(/<a /g)).toHaveLength(6);
    expect(html).toContain('focus-visible:outline-on-brand');
  });
});

describe('how to pay, before the order', () => {
  it('the checkout payment card says card or QR and no cash, visibly', () => {
    const html = renderToStaticMarkup(
      createElement(PaymentSchemeNote, { scheme: 'pay_on_handover', sentences: ['x'] }),
    );
    const visible = html.slice(0, html.indexOf('<details'));
    expect(text(visible)).toContain(
      'С вашего телефона по QR-коду (СБП или карта). Наличные не принимаем.',
    );
    const prepay = renderToStaticMarkup(
      createElement(PaymentSchemeNote, { scheme: 'prepay', sentences: ['x'] }),
    );
    expect(text(prepay.slice(0, prepay.indexOf('<details')))).toContain(PAYMENT_METHOD_LINE.prepay);
  });

  it('the cart total says it under the payment badge', () => {
    const html = renderToStaticMarkup(
      createElement(CartSummary, {
        subtotalText: '528 ₽',
        itemsCount: 1,
        promiseText: null,
        minimums: { ok: true },
        gate: { open: true },
        payment: 'on_pickup',
      } as Parameters<typeof CartSummary>[0]),
    );
    expect(html).toContain('data-testid="cart-payment-method"');
    expect(text(html)).toContain('Наличные не принимаем');
  });
});

describe('proposal payment line', () => {
  const line = (isLocal: boolean, status: ProposalLineView['status'] = 'ok') =>
    ({ isLocal, status }) as ProposalLineView;

  it('one scheme: one phrase; a mix: one prepaid order, as the cart says', () => {
    expect(proposalPaymentLine([line(true), line(true)])).toContain('при получении');
    expect(proposalPaymentLine([line(false)])).toContain('Предоплата');
    expect(proposalPaymentLine([line(true), line(false)])).toContain(
      'Предоплата 100% за всю подборку',
    );
    // A line that cannot be sold does not count.
    expect(proposalPaymentLine([line(true), line(false, 'unavailable')])).toContain(
      'при получении',
    );
    expect(proposalPaymentLine([line(false, 'excluded')])).toBeNull();
  });
});

describe('legal table of contents', () => {
  const source = '# Оферта\n\n## 1. **Общие** положения\n\nТекст.\n\n## 2. Цена\n\n### 2.1 Мелко\n';

  it('lists the h2 sections with the ids the text gets', () => {
    expect(headingAnchors(source)).toEqual([
      { id: 'section-1', text: '1. Общие положения' },
      { id: 'section-2', text: '2. Цена' },
    ]);
    const html = renderToStaticMarkup(createElement(Markdown, { source, anchorLevel: 2 }));
    expect(html).toContain('<h2 id="section-1">');
    expect(html).toContain('<h2 id="section-2">');
    expect(html).not.toContain('<h3 id=');
    // Without anchors the text renders as before.
    expect(renderToStaticMarkup(createElement(Markdown, { source }))).not.toContain(' id=');
  });
});

describe('neutral bits', () => {
  it('step numbers are neutral circles, not brand stickers', () => {
    const html = renderToStaticMarkup(createElement(StepNumber, { n: 2 }));
    expect(html).toContain('bg-bg');
    expect(html).toContain('text-ink');
    expect(html).not.toContain('bg-brand');
  });

  it('route links: a grid in the cards, quiet text links in the footer', () => {
    const routes = [
      { label: 'Яндекс Карты', href: 'https://yandex.ru/maps/?text=x' },
      { label: '2ГИС', href: 'https://2gis.ru/search/x' },
    ];
    const grid = renderToStaticMarkup(createElement(RouteLinks, { routes, variant: 'grid' }));
    expect(grid).toContain('sm:grid-cols-2');
    const inline = renderToStaticMarkup(createElement(RouteLinks, { routes, variant: 'inline' }));
    expect(inline).toContain('text-muted');
    expect(inline).not.toContain('border-[1.5px]');
    expect(inline.match(/min-h-11/g)).toHaveLength(2);
  });
});
