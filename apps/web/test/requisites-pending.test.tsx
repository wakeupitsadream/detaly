// Seller requisites that are not set yet (the Vercel demo before the launch, no
// SELLER_REQUISITES_*): the footer plate, /about and the legal sheet say it once in neutral
// words, never «уточняется» row after row, «undefined» or the seed's «[не задано: …]» markers.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Footer } from '@/components/Footer';
import { legalBodyForView, LegalDocumentView } from '@/components/LegalDocumentView';
import { Requisites } from '@/components/Requisites';
import {
  blankMissingLegalValues,
  hasSellerRequisites,
  LEGAL_BLANK,
  legalBlanksNotice,
  missingLegalValues,
  REQUISITES_PENDING,
} from '@/lib/requisites';
import type { Brand } from '@/server/brand';
import type { LegalDocument } from '@/server/documents';

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NO_SELLER: Brand['seller'] = {
  name: null,
  inn: null,
  ogrnip: null,
  address: null,
  email: null,
  phone: null,
};

function brand(seller: Partial<Brand['seller']> = {}): Brand {
  return {
    name: 'Детали',
    siteUrl: 'http://localhost:3000',
    seller: { ...NO_SELLER, ...seller },
    pickup: {
      name: 'Сервис56',
      address: 'Оренбург — адрес уточняется',
      hours: 'Пн–Пт 10:00–19:00',
      phone: null,
    },
    contactPhone: null,
    demoData: true,
    noindexAll: true,
  };
}

function expectNeutral(html: string): void {
  const body = text(html);
  expect(body).not.toMatch(/уточняется|undefined|null|не задано/);
  // No requisite row with an empty or placeholder value, e.g. «ИНН» followed by nothing.
  expect(body).not.toMatch(/(ИНН|ОГРНИП)\s*(:|,|\.|$)/);
}

describe('requisites before the launch', () => {
  it('hasSellerRequisites: any one value counts', () => {
    expect(hasSellerRequisites(NO_SELLER)).toBe(false);
    expect(hasSellerRequisites({ ...NO_SELLER, email: 'shop@example.test' })).toBe(true);
  });

  it('Footer: one neutral line on the plate, no INN line', () => {
    const html = renderToStaticMarkup(createElement(Footer, { brand: brand(), year: 2026 }));
    expect(html).toContain('data-testid="footer-requisites-pending"');
    expect(text(html)).toContain(REQUISITES_PENDING);
    expect(html).not.toContain('data-testid="footer-inn"');
    expect(html).not.toContain('Индивидуальный предприниматель');
    expect(text(html)).not.toContain('ИНН');
    expectNeutral(html);
  });

  it('Footer: a partial set lists only what is set', () => {
    const html = renderToStaticMarkup(
      createElement(Footer, { brand: brand({ ogrnip: '312565800012345' }), year: 2026 }),
    );
    expect(html).toMatch(/data-testid="footer-inn">ОГРНИП 312565800012345</);
    expect(text(html)).not.toMatch(/уточняется|undefined|ИНН /);
    expect(html).not.toContain('footer-requisites-pending');
  });

  it('Requisites (/about): one line instead of six «уточняется» rows', () => {
    const html = renderToStaticMarkup(createElement(Requisites, { brand: brand() }));
    expect(html).toContain('data-testid="requisites-pending"');
    expect(text(html)).toContain(`${REQUISITES_PENDING}.`);
    expect(html).not.toContain('<dl');
    expectNeutral(html);
  });

  it('Requisites (/about): set rows only, then one line about the rest', () => {
    const html = renderToStaticMarkup(
      createElement(Requisites, { brand: brand({ name: 'Тестов Тест', inn: '561234567890' }) }),
    );
    expect(html).toContain('data-testid="requisite-Продавец"');
    expect(html).toContain('data-testid="requisite-ИНН"');
    expect(html).not.toContain('data-testid="requisite-ОГРНИП"');
    expect(text(html)).toContain('Остальные реквизиты появятся к запуску.');
    expect(text(html)).not.toMatch(/уточняется|undefined/);
  });

  it('Requisites (/about): the full set has no trailing note', () => {
    const html = renderToStaticMarkup(
      createElement(Requisites, {
        brand: brand({
          name: 'Тестов Тест',
          inn: '561234567890',
          ogrnip: '312565800012345',
          address: 'г. Оренбург',
          email: 'shop@example.test',
          phone: '+7 900 000-00-00',
        }),
      }),
    );
    expect(text(html)).not.toContain('появятся к запуску');
  });
});

describe('legal sheet with blanks', () => {
  const body =
    '# Оферта\n\nРедакция 2026-10-d1.\n\n1.1. ИП [не задано: SELLER_NAME] (ИНН [не задано: SELLER_INN]).';

  it('markers become blanks for display, the notice names what is missing', () => {
    expect(missingLegalValues(body)).toEqual(['SELLER_NAME', 'SELLER_INN']);
    expect(blankMissingLegalValues(body)).toContain(`ИП ${LEGAL_BLANK} (ИНН ${LEGAL_BLANK})`);
    const view = legalBodyForView({ bodyMd: body, version: '2026-10-d1' });
    expect(view).not.toContain('не задано');
    expect(view).not.toContain('Редакция 2026-10-d1');
    expect(legalBlanksNotice([])).toBeNull();
    expect(legalBlanksNotice(['SELLER_INN'])).toContain(REQUISITES_PENDING);
    expect(legalBlanksNotice(['PICKUP_PHONE'])).toContain('Недостающие данные появятся к запуску');
  });

  it('LegalDocumentView: one notice, blanks in the text, no markers', () => {
    const doc: LegalDocument = {
      id: '00000000-0000-0000-0000-000000000000',
      kind: 'offer',
      version: '2026-10-d1',
      title: 'Оферта',
      bodyMd: body,
      sha256: 'x',
      publishedAt: null,
      isDraft: true,
    };
    const html = renderToStaticMarkup(createElement(LegalDocumentView, { doc, sheet: true }));
    expect(html).toContain('data-testid="legal-blanks"');
    expect(text(html)).toContain(`${REQUISITES_PENDING}: в тексте на их месте пока пропуски`);
    expect(html).not.toContain('не задано');
    expect(html).not.toContain('SELLER_');
  });

  it('LegalDocumentView: no notice when every value is set', () => {
    const doc: LegalDocument = {
      id: '00000000-0000-0000-0000-000000000000',
      kind: 'offer',
      version: '2026-10-d1',
      title: 'Оферта',
      bodyMd: '# Оферта\n\n1.1. ИП Тестов (ИНН 561234567890).',
      sha256: 'x',
      publishedAt: null,
      isDraft: false,
    };
    const html = renderToStaticMarkup(createElement(LegalDocumentView, { doc }));
    expect(html).not.toContain('legal-blanks');
  });
});
