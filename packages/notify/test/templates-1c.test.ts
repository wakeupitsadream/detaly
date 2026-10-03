// Phase 1C client templates (docs/phase-1c-implementation.md section 7.1, decisions С2, С6, С20):
// every client message of ORDER_NOTIFY_TEMPLATES and of the VIN templates carries no client
// phone, phone digits or name (text, SMS text and buttons), links to /o/ or /p/, and the texts
// follow PLAN section 3 («Приехало», «Претензия») and the installation wording.
import {
  ORDER_NOTIFY_TEMPLATES,
  VIN_NOTIFY_TEMPLATES,
  type ClaimKind,
  type OrderNotifyTemplate,
} from '@detaly/domain';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_WORKFLOW_ACTIONS,
  isClientAction,
  isSmsAllowed,
  type OrderTemplateData,
  type RenderedMessage,
  renderSmsText,
  renderTemplate,
  selectChannel,
  smsSegments,
  vinRequestNumber,
  type VinTemplateData,
} from '../src';

const ORDER_ID = '0192f0c4-7b1a-7cde-8f00-0123456789ab';
const ORDER_URL = `https://detaly56.ru/o/${'A1b2C3d4E5'.repeat(4)}xyz`;
const VIN_ID = '0192f0c4-7b1a-7cde-8f00-00000000c0de';
const PROPOSAL_URL = `https://detaly56.ru/p/${'Q1w2E3r4T5'.repeat(3)}xy`;
const PHONE = '+7 (912) 345-67-89';
const PHONE_DIGITS = '79123456789';
const NAME = 'Иван Петров';
const PACKAGING =
  'order/0192f0c4-7b1a-7cde-8f00-0123456789ab/0192f0c4-7b1a-7cde-8f00-00000000beef.jpg';

/** Template data plus fields a client template must never print (the client's name, email). */
const data = (over: Partial<OrderTemplateData> = {}): OrderTemplateData => {
  const base: OrderTemplateData & { clientName: string; clientEmail: string } = {
    brandName: 'Тестовый бренд',
    orderId: ORDER_ID,
    orderNumber: 'DT-000123',
    orderUrl: ORDER_URL,
    scheme: 'prepay',
    items: [{ brand: 'MANN', article: 'W 914/2' }],
    promisedDate: '2026-10-08',
    totalKop: 128_000,
    paidAmountKop: 128_000,
    paymentUrl: 'https://pay.example.test/1',
    pickup: { name: 'Пункт выдачи', address: 'ул. Тестовая, 1', hours: 'пн–сб 9–19' },
    pickupCode: '4821',
    note: null,
    clientPhone: PHONE,
    adminUrl: 'https://detaly56.ru/admin/orders/1',
    deadlineDate: '2026-10-20',
    readyDays: null,
    storageDays: 10,
    slotText: 'чт 8 окт 14:00',
    installPartner: 'Тестовый сервис',
    installPartnerRequisites: 'ИП Сервисов С. С., ИНН 560011122233',
    claim: { kind: 'defect', decision: null, deadlineDate: '2026-10-20' },
    photos: [PACKAGING],
    clientName: NAME,
    clientEmail: 'ivan@example.test',
  };
  return { ...base, ...over };
};

const vinData = (over: Partial<VinTemplateData> = {}): VinTemplateData => {
  const base: VinTemplateData & { phone: string; clientName: string } = {
    brandName: 'Тестовый бренд',
    requestNumber: vinRequestNumber(VIN_ID),
    proposalUrl: PROPOSAL_URL,
    comment: 'Фильтр подходит к вашему мотору, звоните 8 912 345-67-89',
    phone: PHONE,
    clientName: NAME,
  };
  return { ...base, ...over };
};

const CLIENT_ORDER_TEMPLATES = ORDER_NOTIFY_TEMPLATES.filter((t) => !t.startsWith('staff_'));

/** Everything the client may see: text, SMS, button texts and URLs. */
function visible(message: RenderedMessage): string[] {
  return [
    message.text,
    message.smsText ?? '',
    renderSmsText(message),
    ...message.buttons.flat().map((b) => (b.kind === 'url' ? `${b.text} ${b.url}` : b.text)),
  ];
}

function assertNoPd(text: string, label: string): void {
  expect(text, label).not.toContain('+7');
  expect(text, label).not.toContain(NAME);
  expect(text, label).not.toContain('Иван');
  expect(text, label).not.toContain('ivan@');
  const digits = text.replace(/\D/g, '');
  for (let i = 0; i + 7 <= PHONE_DIGITS.length; i += 1) {
    const chunk = PHONE_DIGITS.slice(i, i + 7);
    expect(digits, `${label}: ${chunk}`).not.toContain(chunk);
  }
  expect(text, label).not.toMatch(/6\D?7\D?8\D?9/);
  expect(text, label).not.toContain('/admin');
}

const VARIANTS: Partial<OrderTemplateData>[] = [
  {},
  { scheme: 'pay_on_handover' },
  { readyDays: 3 },
  { readyDays: 9 },
  { claim: { kind: 'delay', decision: null, deadlineDate: '2026-10-20' } },
  { claim: { kind: 'refusal', decision: 'refund', deadlineDate: '2026-10-20' } },
  { installPartner: null, installPartnerRequisites: null, photos: [] },
  { pickup: null, slotText: null, claim: null },
];

describe('PD minimisation of every client template (V6)', () => {
  it.each(CLIENT_ORDER_TEMPLATES.map((t) => [t] as const))(
    '%s: no phone, phone digits or name; a link to /o/',
    (template) => {
      for (const variant of VARIANTS) {
        const message = renderTemplate(template, data(variant));
        const label = `${template}/${JSON.stringify(variant)}`;
        for (const text of visible(message)) assertNoPd(text, label);
        const urls = message.buttons.flat().flatMap((b) => (b.kind === 'url' ? [b.url] : []));
        expect(
          urls.some((url) => url.startsWith(ORDER_URL)),
          label,
        ).toBe(true);
        // Photos: only the packaging photo of «arrived».
        if (template === 'arrived') {
          expect(message.photos ?? [], label).toEqual(variant.photos ?? [PACKAGING]);
        } else {
          expect(message.photos, label).toBeUndefined();
        }
      }
    },
  );

  it.each(VIN_NOTIFY_TEMPLATES.map((t) => [t] as const))(
    '%s: no phone, phone digits or name; the master comment is masked',
    (template) => {
      for (const over of [{}, { comment: null }, { comment: 'Позвоните +7 912 3456789' }]) {
        const message = renderTemplate(template, vinData(over));
        for (const text of visible(message))
          assertNoPd(text, `${template}/${JSON.stringify(over)}`);
        expect(message.photos).toBeUndefined();
      }
    },
  );

  it('vin_proposal links to /p/, vin_received has nothing to link to yet', () => {
    const proposal = renderTemplate('vin_proposal', vinData());
    expect(proposal.buttons.flat()).toEqual([
      { kind: 'url', text: 'Открыть подборку', url: PROPOSAL_URL },
    ]);
    expect(proposal.text).toContain('Комментарий мастера: Фильтр подходит к вашему мотору');
    expect(proposal.text).toContain('•••');
    expect(renderTemplate('vin_received', vinData()).buttons).toEqual([]);
    expect(renderTemplate('vin_received', vinData()).text).toContain(
      'Тестовый бренд · заявка VIN № 00C0DE',
    );
  });

  it('only vin_proposal of the VIN templates is in the SMS allowlist', () => {
    expect(isSmsAllowed('vin_proposal')).toBe(true);
    expect(isSmsAllowed('vin_received')).toBe(false);
    const sms = renderSmsText(renderTemplate('vin_proposal', vinData()));
    expect(sms).toBe(`Подбор по VIN № 00C0DE готов: цены и сроки по ссылке.\n${PROPOSAL_URL}`);
    expect(smsSegments(sms).segments).toBeLessThanOrEqual(2);
  });
});

describe('texts against PLAN section 3', () => {
  it('arrived (V5): pickup code, the point, the packaging photo and «Записаться на установку»', () => {
    const message = renderTemplate('arrived', data());
    expect(message.text).toContain('Код выдачи: 4821');
    expect(message.text).toContain('Пункт выдачи, ул. Тестовая, 1.');
    expect(message.text).toContain('пн–сб 9–19');
    expect(message.text).toContain('MANN W 914/2');
    expect(message.photos).toEqual([PACKAGING]);
    expect(message.buttons).toEqual([
      [{ kind: 'action', text: 'Записаться на установку', action: 'install', orderId: ORDER_ID }],
      [{ kind: 'url', text: 'Открыть заказ', url: ORDER_URL }],
    ]);
    // SMS keeps the code and the link (the action button is dropped).
    expect(renderSmsText(message)).toBe(`Заказ DT-000123 приехал.\nКод выдачи 4821.\n${ORDER_URL}`);
  });

  it('arrived without INSTALL_PARTNER_NAME: no booking button (decision С6)', () => {
    const message = renderTemplate('arrived', data({ installPartner: null }));
    expect(message.buttons.flat().some((b) => b.kind === 'action')).toBe(false);
    expect(message.text).not.toContain('установк');
  });

  it('handed and how_is_it: «Претензия» opens the claim form of the order page', () => {
    for (const template of ['handed', 'how_is_it'] as const) {
      const message = renderTemplate(template, data());
      expect(message.buttons[0]).toEqual([
        { kind: 'url', text: 'Претензия', url: `${ORDER_URL}#claim` },
      ]);
    }
    expect(renderTemplate('handed', data()).text).toContain(
      '7 дней на отказ — памятка на странице заказа',
    );
  });

  it('claim_received: the order of actions with the point, the date and the money', () => {
    const text = renderTemplate('claim_received', data()).text;
    expect(text).toContain('Претензия принята (брак). Что дальше:');
    expect(text).toContain(
      '1. Принесите деталь в упаковке в Пункт выдачи, ул. Тестовая, 1 (пн–сб 9–19).',
    );
    expect(text).toContain('2. Мастер примет деталь и сфотографирует её.');
    expect(text).toContain('3. Ответим до 20 октября.');
    // Art. 22: 10 days from the claim (claims.deadline_at), not from the decision.
    expect(text).toContain(
      '4. Если решение — возврат, деньги вернём на ту же карту не позже 20 октября.',
    );
    expect(text).not.toContain('после решения');
    const delay = renderTemplate(
      'claim_received',
      data({ claim: { kind: 'delay', decision: null, deadlineDate: '2026-10-21' } }),
    ).text;
    expect(delay).toContain('Претензия о просрочке принята.');
    expect(delay).toContain('Ответим до 21 октября.');
    expect(delay).not.toContain('Принесите');
    expect(delay).toContain('деньги вернём на ту же карту не позже 21 октября');
    expect(delay).toContain('Если заказ уже получен — рассчитаем неустойку за просрочку.');
    const noDate = renderTemplate('claim_received', data({ claim: null, deadlineDate: null }));
    expect(noDate.text).toContain('Ответим в течение 10 дней.');
    expect(noDate.text).toContain('в течение 10 дней со дня претензии');
  });

  it('claim_refund_started: a claim refund of one handed item, money by the claim deadline', () => {
    const message = renderTemplate('claim_refund_started', data());
    expect(message.text).toBe(
      [
        'Тестовый бренд · заказ DT-000123',
        'Возврат по претензии: MANN W 914/2.',
        'Деньги за деталь вернём на ту же карту не позже 20 октября.',
      ].join('\n'),
    );
    expect(message.text).not.toContain('отменена');
    expect(message.text).not.toContain('оплата при получении');
    expect(message.buttons).toEqual([
      [{ kind: 'url', text: 'Открыть заказ', url: `${ORDER_URL}#claim` }],
    ]);
    const cod = renderTemplate(
      'claim_refund_started',
      data({ scheme: 'pay_on_handover', claim: null, deadlineDate: null }),
    ).text;
    expect(cod).toContain('в течение 10 дней со дня претензии');
    expect(cod).not.toContain('оплата при получении');
  });

  it('claim_decided: no decision text, only «ответ готов» and the link (С2)', () => {
    const message = renderTemplate(
      'claim_decided',
      data({
        note: 'Иван, возвращаем 1 280 ₽',
        claim: { kind: 'defect', decision: 'refund', deadlineDate: '2026-10-20' },
      }),
    );
    expect(message.text).toBe(
      'Тестовый бренд · заказ DT-000123\nОтвет по претензии готов — он на странице заказа.',
    );
    expect(message.buttons).toEqual([
      [{ kind: 'url', text: 'Открыть ответ', url: `${ORDER_URL}#claim` }],
    ]);
  });

  const INSTALL: OrderNotifyTemplate[] = [
    'install_requested',
    'install_confirmed',
    'install_declined',
    'install_reminder',
  ];

  it.each(INSTALL.map((t) => [t] as const))(
    '%s: the slot, the partner and «оплачивается в сервисе по его чеку», no price',
    (template) => {
      const message = renderTemplate(template, data());
      expect(message.text).toContain('чт 8 окт 14:00');
      expect(message.text).toContain(
        'Установка — услуга Тестовый сервис (ИП Сервисов С. С., ИНН 560011122233), оплачивается в сервисе по его чеку.',
      );
      expect(message.text).not.toMatch(/₽|руб/u);
      expect(message.buttons.flat().at(-1)).toMatchObject({
        kind: 'url',
        url: `${ORDER_URL}#install`,
      });
    },
  );

  it('claim kinds are named in staff cards without the client text', () => {
    for (const kind of ['refusal', 'not_fit', 'defect', 'delay'] as ClaimKind[]) {
      const text = renderTemplate(
        'staff_claim_opened',
        data({ claim: { kind, decision: null, deadlineDate: '2026-10-20' } }),
      ).text;
      expect(text).toContain('Ответить до 20 октября');
      expect(text).not.toContain('+7');
    }
    expect(
      renderTemplate(
        'staff_claim_deadline',
        data({
          deadlineDate: null,
          claim: { kind: 'defect', decision: null, deadlineDate: '2026-10-22' },
        }),
      ).text,
    ).toContain('Ответить до 22 октября (10 дней по закону)');
  });
});

describe('channels (V3)', () => {
  it('MAX binding without a MAX driver -> Telegram', () => {
    const recipient = {
      kind: 'client' as const,
      bindings: [
        { channel: 'max' as const, chatId: 'm', isPrimary: true, blocked: false },
        { channel: 'telegram' as const, chatId: 't', isPrimary: false, blocked: false },
      ],
      phone: '+79123456789',
    };
    expect(selectChannel(recipient, 'ordered', new Set(['telegram', 'sms']))).toEqual({
      status: 'send',
      channel: 'telegram',
      address: 't',
      fallbackReason: null,
    });
  });

  it('no bindings and a template outside the allowlist -> skipped', () => {
    const recipient = { kind: 'client' as const, bindings: [], phone: '+79123456789' };
    for (const template of [
      'ordered',
      'vin_received',
      'claim_received',
      'install_reminder',
    ] as const) {
      expect(selectChannel(recipient, template, new Set(['telegram', 'sms']))).toEqual({
        status: 'skipped',
        fallbackReason: 'no_messenger:not_in_sms_allowlist',
      });
    }
  });

  it('client workflow codes', () => {
    expect([...CLIENT_WORKFLOW_ACTIONS]).toEqual(['install', 'islot', 'orders', 'unsub']);
    expect(isClientAction('install')).toBe(true);
    expect(isClientAction('confirm')).toBe(true);
    expect(isClientAction('cref')).toBe(false);
    expect(isClientAction('recheck')).toBe(false);
  });
});
