// Redesign 2, round 4 critique: the fixes rendered without Next (docs/design-v2.md). One line
// weight for big icons, one look for help cards, the docs title first, a mixed proposal that
// does not promise payment at pickup, short footer captions, tidy badges and step numbers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PaymentSchemeNote } from '@/components/checkout/PaymentSchemeNote';
import { Footer } from '@/components/Footer';
import { WhyUs } from '@/components/home/WhyUs';
import { CategoryIcon, IconWallet, LARGE_LINE_PX, largeStroke } from '@/components/icons';
import { LegalDocumentView, splitLegalHead } from '@/components/LegalDocumentView';
import { StockBadge } from '@/components/StockBadge';
import { Badge } from '@/components/ui/Badge';
import { IconCard } from '@/components/ui/Card';
import { CtaCard } from '@/components/ui/CtaCard';
import { StepIconTile } from '@/components/ui/StepNumber';
import { TileGlyph } from '@/components/ui/Tile';
import {
  isMixedProposal,
  MIXED_PROPOSAL_PAYMENT,
  ProposalSheet,
} from '@/components/vin/ProposalSheet';
import { VinCtaArt } from '@/components/vin/VinCtaArt';
import type { Brand } from '@/server/brand';
import type { LegalDocument } from '@/server/documents';
import type { ProposalLineView, ProposalPageView } from '@/server/vin/proposal-page';

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

/** stroke-width of every <svg> in the markup, with its width. */
function strokes(html: string): { width: number; stroke: number }[] {
  return [...html.matchAll(/<svg[^>]*width="(\d+)"[^>]*stroke-width="([\d.]+)"/g)].map((m) => ({
    width: Number(m[1]),
    stroke: Number(m[2]),
  }));
}

describe('one line weight for big icons', () => {
  it('a big icon draws LARGE_LINE_PX on screen whatever its size; a row icon stays 1.75', () => {
    for (const size of [36, 40, 48, 52, 64, 72, 88, 96]) {
      const onScreen = (largeStroke(size) * size) / 24;
      expect(onScreen, `${size} px`).toBeGreaterThanOrEqual(2.25);
      expect(onScreen, `${size} px`).toBeLessThanOrEqual(2.75);
    }
    expect(LARGE_LINE_PX).toBe(2.5);
    const row = renderToStaticMarkup(createElement(IconWallet, { size: 24 }));
    expect(row).toContain('stroke-width="1.75"');
  });

  it('the category tile glyph and the dark panel glyphs share the line', () => {
    const tile = strokes(renderToStaticMarkup(createElement(TileGlyph, { category: 'filter' })));
    const panel = strokes(
      renderToStaticMarkup(createElement(WhyUs, { brandName: 'Тест', pickupName: 'Сервис' })),
    );
    expect(tile.map((s) => s.width)).toEqual([72, 88]);
    for (const { width, stroke } of [...tile, ...panel]) {
      expect((stroke * width) / 24).toBeCloseTo(LARGE_LINE_PX, 1);
    }
    // A big icon is never resized by CSS (the line would grow with it).
    const categoryHtml = renderToStaticMarkup(
      createElement(CategoryIcon, { category: 'pads', size: 72 }),
    );
    expect(categoryHtml).not.toMatch(/class="[^"]*size-/);
  });
});

describe('dark panel', () => {
  it('no chevrons; the lift on hover tells a tile is a link', () => {
    const html = renderToStaticMarkup(
      createElement(WhyUs, { brandName: 'Тест', pickupName: 'Сервис' }),
    );
    expect(html).not.toContain('M9.5 6l6 6-6 6');
    expect(html.match(/hover:-translate-y-0\.5/g)).toHaveLength(6);
    expect(html.match(/href="\/about#about-why"/g)).toHaveLength(3);
  });
});

describe('help cards', () => {
  it('IconCard: white, line border, a 24 px icon and an h3-size title in one head', () => {
    const html = renderToStaticMarkup(
      createElement(IconCard, { icon: 'i', title: 'Где найти VIN', titleId: 'x' }, 'Текст'),
    );
    expect(html).toContain('border border-line bg-bg');
    expect(html).toContain('rounded-tile');
    expect(html).toContain('<h2 id="x" class="min-w-0 text-h3">Где найти VIN</h2>');
    expect(html).toContain('aria-labelledby="x"');
    expect(html).not.toContain('bg-surface');
  });
});

describe('VIN call to action', () => {
  it('from lg a picture on a white plate beside the text, no empty grey field', () => {
    const html = renderToStaticMarkup(
      createElement(CtaCard, {
        title: 'Не знаете артикул?',
        art: createElement(VinCtaArt),
        action: { href: '/vin', label: 'Подобрать по VIN' },
      }),
    );
    expect(html).toContain('lg:grid-cols-[minmax(0,1fr)_auto]');
    expect(html).toContain('hidden lg:block');
    expect(html).toContain('bg-bg');
    // Without a picture the card stays one column.
    const plain = renderToStaticMarkup(createElement(CtaCard, { title: 'Закрыто' }));
    expect(plain).not.toContain('lg:grid');
  });
});

describe('mixed proposal', () => {
  const line = (id: string, isLocal: boolean): ProposalLineView => ({
    id,
    brand: isLocal ? 'TRW' : 'MAHLE',
    article: id,
    name: 'Деталь',
    qty: 1,
    isLocal,
    priceText: '1 000 ₽',
    lineTotalText: '1 000 ₽',
    promiseText: 'к пт 9 октября',
    status: 'ok',
  });
  const view = (lines: ProposalLineView[]): ProposalPageView => ({
    comment: 'Колодки оригинального размера',
    lines,
    totalKop: 200_000,
    totalText: '2 000 ₽',
    itemsCount: lines.length,
    promiseText: 'к пт 9 октября',
    expired: false,
    expiresText: '14 октября',
    stale: false,
    changed: false,
    unavailable: 0,
  });

  it('no «оплата при получении» next to «предоплата 100%»', () => {
    const lines = [line('A1', true), line('B2', false)];
    expect(isMixedProposal(lines)).toBe(true);
    const html = renderToStaticMarkup(
      createElement(ProposalSheet, {
        view: view(lines),
        mode: { kind: 'sample' },
        contactPhone: null,
      }),
    );
    expect(text(html)).not.toContain('оплата при получении');
    expect(text(html)).toContain(MIXED_PROPOSAL_PAYMENT);
    expect(text(html)).toContain('В Оренбурге');
    // The master's comment is a white card with the wrench in its head, not a red disc.
    expect(html).not.toContain('rounded-full bg-brand text-on-brand');
    expect(html).toMatch(/data-testid="proposal-comment"[^>]*/);
    // The brand and article of a line is a heading.
    expect(html).toMatch(/<h3[^>]*>TRW <span class="tabular-nums">A1<\/span><\/h3>/);
  });

  it('all in Orenburg: the badge keeps how it is paid', () => {
    const lines = [line('A1', true), line('A2', true)];
    expect(isMixedProposal(lines)).toBe(false);
    const html = renderToStaticMarkup(
      createElement(ProposalSheet, {
        view: view(lines),
        mode: { kind: 'sample' },
        contactPhone: null,
      }),
    );
    expect(text(html)).toContain('В Оренбурге — оплата при получении');
  });

  it('StockBadge without the payment tail', () => {
    expect(
      text(renderToStaticMarkup(createElement(StockBadge, { isLocal: true, payment: false }))),
    ).toBe('В Оренбурге');
    expect(
      text(renderToStaticMarkup(createElement(StockBadge, { isLocal: false, payment: false }))),
    ).toBe('Под заказ');
  });
});

describe('legal sheet', () => {
  const bodyMd =
    '> **Черновик, требует вычитки юристом.** Это не действующая редакция.\n\n# Публичная оферта\n\nРедакция 2026-10-d1.\n\n## 1. Общие положения\n\nТекст.';
  const doc: LegalDocument = {
    id: '00000000-0000-0000-0000-000000000000',
    kind: 'offer',
    version: '2026-10-d1',
    title: 'Оферта',
    bodyMd,
    sha256: 'x',
    publishedAt: null,
    isDraft: false,
  };

  it('splits the lawyer note and the title off the text, display only', () => {
    const head = splitLegalHead('> **Черновик.** Не действует.\n\n# Оферта\n\n## 1. Текст');
    expect(head).toEqual({
      title: 'Оферта',
      note: '**Черновик.** Не действует.',
      rest: '## 1. Текст',
    });
    expect(splitLegalHead('Просто текст')).toEqual({
      title: null,
      note: null,
      rest: 'Просто текст',
    });
  });

  it('the h1 opens the sheet, the edition and «Черновик» under it, the note is a Notice', () => {
    const html = renderToStaticMarkup(
      createElement(LegalDocumentView, {
        doc,
        sheet: true,
        toc: createElement('div', { 'data-testid': 'toc' }),
      }),
    );
    const h1 = html.indexOf('<h1');
    expect(h1).toBeGreaterThan(-1);
    expect(h1).toBeLessThan(html.indexOf('Редакция'));
    expect(html.indexOf('Редакция')).toBeLessThan(html.indexOf('data-testid="legal-note"'));
    expect(html.indexOf('data-testid="legal-note"')).toBeLessThan(
      html.indexOf('data-testid="toc"'),
    );
    expect(html.indexOf('data-testid="toc"')).toBeLessThan(html.indexOf('Общие положения'));
    expect(html).toContain('data-testid="legal-draft"');
    expect(html).not.toContain('<blockquote');
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(text(html)).toContain('Черновик, требует вычитки юристом.');
  });
});

describe('footer captions', () => {
  it('document links fit one line on a 360 px phone', () => {
    const brand = {
      name: 'Тест',
      contactPhone: null,
      pickupLinks: null,
      pickup: { name: null, address: null, hours: null, phone: null },
      seller: {
        name: null,
        inn: null,
        ogrnip: null,
        address: null,
        email: null,
        phone: null,
      },
    } as unknown as Brand;
    const html = renderToStaticMarkup(createElement(Footer, { brand, year: 2026 }));
    expect(text(html)).toContain('Политика обработки данных');
    expect(text(html)).toContain('Согласие на обработку данных');
    expect(text(html)).not.toContain('Политика обработки персональных данных');
    expect(html).not.toContain('py-1 text-body');
  });
});

describe('small parts', () => {
  it('a badge that wraps stays tidy: 20 px radius, the dot on the first line', () => {
    const html = renderToStaticMarkup(createElement(Badge, { tone: 'ok' }, 'В Оренбурге'));
    expect(html).toContain('rounded-[1.25rem]');
    expect(html).not.toContain('rounded-full font-semibold');
    expect(html).toContain('items-start');
    expect(html).toContain('h-[1.375em]');
  });

  it('a step number is a badge on the corner of its icon plate', () => {
    const html = renderToStaticMarkup(createElement(StepIconTile, { n: 2, icon: IconWallet }));
    expect(html).toContain('absolute -top-2 -left-2');
    expect(text(html)).toBe('2');
    expect(strokes(html).map((s) => s.width)).toEqual([40, 48]);
  });

  it('the payment card has the anatomy of a chosen ChoiceCard', () => {
    const html = renderToStaticMarkup(
      createElement(PaymentSchemeNote, { scheme: 'prepay', sentences: ['x'] }),
    );
    expect(html).toContain('absolute top-2.5 right-2.5');
    expect(html).not.toContain('rounded-full bg-bg text-brand');
    expect(html).toContain('border-brand bg-brand-soft');
  });

  it('an ordered item never «едет» to the point: the words of the stepper', () => {
    for (const file of ['src/server/orders/order-view.ts', 'src/server/demo/order-fixture.ts']) {
      const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
      expect(source, file).not.toContain('едет к нам');
      expect(source, file).toContain("'Заказана у поставщика'");
    }
  });
});
