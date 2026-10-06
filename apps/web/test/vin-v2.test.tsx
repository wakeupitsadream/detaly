// Redesign 2, package P4 (docs/design-v2.md, «VIN» and «Инфостраницы»): /vin pre-fills VIN, car
// and need from the query (links from the home page and the header search), the form keeps its
// contract (fields, consent link, MAX «скоро»), /vin/sent has one title, and the return memo
// embedded on /returns does not add a second h1.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as Navigation from 'next/navigation';
import { describe, expect, it, vi } from 'vitest';
import { LegalDocumentView } from '@/components/LegalDocumentView';
import { VinForm, type VinFormProps } from '@/components/vin/VinForm';
import { VinPlate } from '@/components/vin/VinPlate';
import { vinFormInitial } from '@/components/vin/vin-query';
import { VinSent } from '@/components/vin/VinSent';
import { vinRequestHref } from '@/lib/vin-link';
import type { LegalDocument } from '@/server/documents';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const FORM: VinFormProps = {
  consentPdVersionId: '00000000-0000-0000-0000-000000000001',
  requestKey: '00000000-0000-7000-8000-000000000002',
  photos: { enabled: false, max: 3, maxFileMb: 8 },
  telegram: true,
  errors: {},
  formError: null,
  demo: false,
};

function form(props: Partial<VinFormProps> = {}): string {
  return renderToStaticMarkup(createElement(VinForm, { ...FORM, ...props }));
}

describe('/vin pre-fill from the query', () => {
  it('takes vin, car and need: the first value, trimmed, cut to the field limit', () => {
    expect(
      vinFormInitial({ vin: '  xta210990y1234567 ', car: ['Lada', 'Kia'], need: 'Тормоза' }),
    ).toEqual({ vin: 'xta210990y1234567', car: 'Lada', need: 'Тормоза' });
    expect(vinFormInitial({ vin: 'X'.repeat(40), car: 'C'.repeat(300) })).toEqual({
      vin: 'X'.repeat(24),
      car: 'C'.repeat(200),
    });
    expect(vinFormInitial({ vin: '   ', need: '', e: 'vin_oiq' })).toEqual({});
  });

  it('round-trips vinRequestHref links from the home page', () => {
    const href = vinRequestHref({ car: 'Lada', need: 'Тормозные колодки' });
    const query = Object.fromEntries(new URL(href, 'http://x').searchParams);
    expect(vinFormInitial(query)).toEqual({ car: 'Lada', need: 'Тормозные колодки' });
  });

  it('the form shows them as default values; nothing pre-filled without them', () => {
    const html = form({
      initial: { vin: 'XTA210990Y1234567', car: 'Lada Granta', need: 'Колодки <передние>' },
    });
    expect(html).toMatch(/<input id="vin-vin"[^>]*value="XTA210990Y1234567"/);
    expect(html).toMatch(/<input id="vin-car"[^>]*value="Lada Granta"/);
    expect(html).toMatch(/<textarea id="vin-need"[^>]*>Колодки &lt;передние&gt;<\/textarea>/);
    const empty = form();
    expect(empty).not.toMatch(/<input id="vin-vin"[^>]*value=/);
    expect(empty).toMatch(/<textarea id="vin-need"[^>]*><\/textarea>/);
  });

  it('keeps the form contract: fields, consent link, honeypot, MAX «скоро», Telegram on', () => {
    const html = form();
    for (const name of ['vin', 'car', 'need', 'phone', 'channel', 'consentPd', 'website']) {
      expect(html, name).toContain(`name="${name}"`);
    }
    expect(html).toContain('action="/api/vin"');
    expect(html).toContain('href="/docs/consent"');
    expect(html).toContain('Букв O, I и Q в VIN не бывает');
    expect(html).toMatch(/<input type="radio" [^>]*disabled=""[^>]*value="max"/);
    expect(html).not.toMatch(/<input type="radio" [^>]*disabled=""[^>]*value="telegram"/);
    expect(html).toMatch(/<input type="radio" [^>]*checked="" value="telegram"/);
    expect(html).toContain('data-testid="vin-submit"');
  });

  it('without the client bot, SMS is the default and Telegram is off', () => {
    const html = form({ telegram: false });
    expect(html).toMatch(/<input type="radio" [^>]*disabled=""[^>]*value="telegram"/);
    expect(html).toMatch(/<input type="radio" [^>]*checked="" value="sms"/);
  });

  it('the VIN plate keeps its caption and has no text under 14 px', () => {
    const html = renderToStaticMarkup(createElement(VinPlate));
    expect(html).toContain('Так выглядит VIN');
    expect(html).toContain('Где найти VIN');
    expect(html).not.toMatch(/text-\[0\.(?:6|7|8[0-6])\d*rem\]|text-xs/);
  });
});

describe('/vin/sent', () => {
  it('one h1 «Заявка принята»; SMS or the Telegram deep link', () => {
    const sms = renderToStaticMarkup(
      createElement(VinSent, { channel: { kind: 'sms' }, hours: 'Пн–Пт 10–19', demo: false }),
    );
    expect(sms).toMatch(/<h1[^>]*data-testid="vin-sent-title"[^>]*>Заявка принята<\/h1>/);
    expect(sms.match(/<h1/g)).toHaveLength(1);
    expect(sms).toContain('data-testid="vin-sent-sms"');
    const tg = renderToStaticMarkup(
      createElement(VinSent, {
        channel: { kind: 'telegram', deepLink: 'https://t.me/bot?start=abc' },
        hours: null,
        demo: true,
        chatUrl: 'https://t.me/point',
      }),
    );
    expect(tg).toContain('data-testid="vin-sent-demo"');
    expect(tg).toMatch(
      /href="https:\/\/t\.me\/bot\?start=abc"[^>]*data-testid="vin-telegram-link"/,
    );
    expect(tg).toContain('href="https://t.me/point"');
  });
});

describe('LegalDocumentView embedded', () => {
  const doc: LegalDocument = {
    id: '00000000-0000-0000-0000-000000000000',
    kind: 'return_memo',
    version: '2026-10-d1',
    title: 'Памятка о возврате',
    bodyMd: '# Памятка о возврате\n\n## Сроки\n\n7 дней.\n\n### Деньги\n\n10 дней.',
    sha256: 'x',
    publishedAt: null,
    isDraft: false,
  };

  it('on its own page the document keeps its h1', () => {
    const html = renderToStaticMarkup(createElement(LegalDocumentView, { doc, sheet: true }));
    expect(html).toContain('<h1>Памятка о возврате</h1>');
    expect(html).toContain('<h2>Сроки</h2>');
  });

  it('inside /returns every heading moves one level down: no second h1', () => {
    const html = renderToStaticMarkup(createElement(LegalDocumentView, { doc, embedded: true }));
    expect(html).not.toContain('<h1');
    expect(html).toContain('<h2>Памятка о возврате</h2>');
    expect(html).toContain('<h3>Сроки</h3>');
    expect(html).toContain('<h4>Деньги</h4>');
  });
});
