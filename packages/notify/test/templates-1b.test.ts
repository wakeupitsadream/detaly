import { ORDER_NOTIFY_TEMPLATES } from '@detaly/domain';
import { describe, expect, it } from 'vitest';
import {
  deadline,
  formatReplyBy,
  type OrderTemplateData,
  type RenderedMessage,
  renderSmsText,
  renderTemplate,
  SMS_ALLOWED_TEMPLATES,
  smsSegments,
} from '../src';

const ORDER_ID = '0192f0c4-7b1a-7cde-8f00-0123456789ab';
/** A realistic order page: APP_BASE_URL + /o/ + 43-char token. */
const ORDER_URL = `https://detaly56.ru/o/${'A1b2C3d4E5'.repeat(4)}xyz`;
const PHONE = '+7 (912) 345-67-89';
const PHONE_DIGITS = '79123456789';
const NAME = 'Иван Петров';

/** Template data plus fields templates must never print (name, raw phone on client side). */
const data = (over: Partial<OrderTemplateData> = {}): OrderTemplateData => {
  const base: OrderTemplateData & { clientName: string; clientEmail: string } = {
    brandName: 'Тестовый бренд',
    orderId: ORDER_ID,
    orderNumber: 'DT-000123',
    orderUrl: ORDER_URL,
    scheme: 'prepay',
    items: [
      { brand: 'MANN', article: 'W 914/2' },
      { brand: 'BOSCH', article: '0 986 452 041' },
    ],
    promisedDate: '2026-10-08',
    totalKop: 128_000,
    paidAmountKop: 128_000,
    paymentUrl: 'https://pay.example.test/1',
    pickup: { name: 'Пункт выдачи', address: 'ул. Тестовая, 1', hours: 'пн–сб 9–19' },
    pickupCode: '4821',
    note: 'Аналог MANN W 914/2 за 1 280 ₽',
    clientPhone: PHONE,
    adminUrl: 'https://detaly56.ru/admin/orders/1',
    supplierInvoice: { number: 'R-77', amountKop: 90_000 },
    deadlineDate: '2026-10-20',
    readyDays: 9,
    replyBy: '2026-10-03T09:30:00.000Z',
    storageDays: 10,
    clientName: NAME,
    clientEmail: 'ivan@example.test',
  };
  return { ...base, ...over };
};

const clientTemplates = ORDER_NOTIFY_TEMPLATES.filter((t) => !t.startsWith('staff_'));
const staffTemplates = ORDER_NOTIFY_TEMPLATES.filter((t) => t.startsWith('staff_'));

/** Every text a client may receive: messenger text, SMS text and the final SMS. */
function clientTexts(message: RenderedMessage): string[] {
  return [message.text, message.smsText ?? '', renderSmsText(message)];
}

function assertNoPd(text: string, label: string): void {
  expect(text, label).not.toContain('+7');
  expect(text, label).not.toContain(NAME);
  expect(text, label).not.toContain('Иван');
  expect(text, label).not.toContain('ivan@');
  // Any 7 consecutive digits of the phone, however formatted (spaces, dashes, brackets).
  const digits = text.replace(/\D/g, '');
  for (let i = 0; i + 7 <= PHONE_DIGITS.length; i += 1) {
    const chunk = PHONE_DIGITS.slice(i, i + 7);
    expect(digits, `${label}: ${chunk}`).not.toContain(chunk);
  }
  // Nor the last four digits (the cancellation check on /o/<token>).
  expect(text, label).not.toMatch(/6\D?7\D?8\D?9/);
}

describe('PD minimisation in rendered templates', () => {
  it.each(clientTemplates.map((t) => [t] as const))(
    'client template %s carries no phone, phone digits or name',
    (template) => {
      for (const scheme of ['prepay', 'pay_on_handover'] as const) {
        for (const readyDays of [null, 3, 9]) {
          const message = renderTemplate(template, data({ scheme, readyDays }));
          for (const text of clientTexts(message)) {
            assertNoPd(text, `${template}/${scheme}/${String(readyDays)}`);
            expect(text).not.toContain('•••');
            expect(text).not.toContain('/admin');
          }
        }
      }
    },
  );

  it.each(staffTemplates.map((t) => [t] as const))(
    'staff template %s shows the phone only as •••XXXX',
    (template) => {
      for (const scheme of ['prepay', 'pay_on_handover'] as const) {
        const { text } = renderTemplate(template, data({ scheme }));
        expect(text).not.toContain(NAME);
        expect(text).not.toContain('ivan@');
        const withoutMask = text.replaceAll('•••6789', '');
        expect(withoutMask).not.toContain('+7');
        expect(withoutMask).not.toMatch(/6789/);
        expect(withoutMask.replace(/\D/g, '')).not.toContain('9123456');
        expect(text).not.toMatch(/•••\d{5,}/);
      }
    },
  );

  it('staff cards that name the client use the mask', () => {
    for (const template of ['staff_new_order', 'staff_problem', 'staff_approval_unreachable']) {
      expect(renderTemplate(template as 'staff_new_order', data()).text).toContain('•••6789');
    }
  });
});

describe('SMS texts of allowlisted templates', () => {
  it.each(SMS_ALLOWED_TEMPLATES.filter((t) => t !== 'vin_proposal').map((t) => [t] as const))(
    '%s fits two segments and keeps the order link whole',
    (template) => {
      for (const scheme of ['prepay', 'pay_on_handover'] as const) {
        for (const readyDays of [null, 3, 6, 9]) {
          const sms = renderSmsText(renderTemplate(template, data({ scheme, readyDays })));
          expect(smsSegments(sms).segments, sms).toBeLessThanOrEqual(2);
          expect(sms.endsWith(`\n${ORDER_URL}`), sms).toBe(true);
          expect(sms).toContain('DT-000123');
          expect(sms).not.toContain('…');
        }
      }
    },
  );

  it('confirm_request: confirm on the page by the deadline, no buttons in SMS', () => {
    const message = renderTemplate('confirm_request', data({ scheme: 'pay_on_handover' }));
    expect(renderSmsText(message)).toBe(
      `Подтвердите заказ DT-000123 до 14:30 03.10 на странице.\n${ORDER_URL}`,
    );
    expect(message.text).toContain('Подтвердите заказ до 14:30 3 октября.');
    expect(message.buttons[0]?.[0]).toMatchObject({ kind: 'action', action: 'confirm' });
    expect(
      renderSmsText(renderTemplate('confirm_request', data({ replyBy: null }))).split('\n')[0],
    ).toBe('Подтвердите заказ DT-000123 на странице.');
  });

  it('decision_needed: «Нужно ваше решение по заказу DT-… до <время>» + link', () => {
    const message = renderTemplate('decision_needed', data());
    expect(renderSmsText(message)).toBe(
      `Нужно ваше решение по заказу DT-000123 до 14:30 03.10.\n${ORDER_URL}`,
    );
    expect(message.text).toContain('Нужно ваше решение по заказу DT-000123 до 14:30 3 октября.');
    expect(message.text).toContain('Аналог MANN W 914/2');
    expect(message.buttons[0]?.map((b) => b.text)).toEqual(['Согласен', 'Вернуть деньги']);
    // A Date works as well as an ISO string.
    expect(
      renderTemplate('decision_needed', data({ replyBy: new Date('2026-10-03T19:05:00Z') })).text,
    ).toContain('до 00:05 4 октября');
  });

  it('a long site address: the SMS deadline survives, the link stays whole', () => {
    // 25-character domain: the URL alone takes 79 of the 134 characters of two UCS-2 parts.
    const longUrl = `https://detaly-avtozapchasti56.ru/o/${'A1b2C3d4E5'.repeat(4)}xyz`;
    for (const template of ['confirm_request', 'decision_needed'] as const) {
      const sms = renderSmsText(
        renderTemplate(template, data({ orderUrl: longUrl, scheme: 'pay_on_handover' })),
      );
      expect(smsSegments(sms).segments, template).toBeLessThanOrEqual(2);
      expect(sms.endsWith(`\n${longUrl}`), template).toBe(true);
      expect(sms, template).toContain('DT-000123 до 14:30 03.10');
    }
  });

  it('arrived on day 9: the offer storage phrase, prepay -> money back', () => {
    const prepay = renderTemplate('arrived', data({ readyDays: 9, storageDays: 10 }));
    expect(prepay.text).toContain('По оферте заказ хранится 10 дн., затем возврат денег.');
    expect(renderSmsText(prepay)).toBe(
      `Заказ DT-000123: хранение по оферте 10 дн., затем возврат денег.\n${ORDER_URL}`,
    );
    const cod = renderTemplate(
      'arrived',
      data({ scheme: 'pay_on_handover', readyDays: 6, storageDays: 7 }),
    );
    expect(cod.text).toContain('По оферте заказ хранится 7 дн., затем заказ отменяется.');
    expect(renderSmsText(cod)).toContain('затем отмена');
    expect(cod.text).not.toContain('возврат денег');
  });

  it('arrived before the last day: no storage phrase; first message has the pickup code', () => {
    for (const readyDays of [3, 6]) {
      const message = renderTemplate('arrived', data({ readyDays, storageDays: 10 }));
      expect(message.text).not.toContain('По оферте');
      expect(renderSmsText(message)).toBe(
        `Заказ DT-000123 ждёт вас ${readyDays} дн.\nКод выдачи 4821.\n${ORDER_URL}`,
      );
    }
    const first = renderTemplate('arrived', data({ readyDays: null }));
    expect(renderSmsText(first)).toBe(`Заказ DT-000123 приехал.\nКод выдачи 4821.\n${ORDER_URL}`);
    expect(renderTemplate('arrived', data({ storageDays: null })).text).not.toContain('оферте');
  });

  it('a long site address: the text is shortened, the link stays whole', () => {
    const longUrl = `https://zapchasti-orenburg-detali.example/o/${'x'.repeat(43)}`;
    for (const template of ['confirm_request', 'decision_needed', 'arrived'] as const) {
      const sms = renderSmsText(renderTemplate(template, data({ orderUrl: longUrl })));
      expect(sms.endsWith(`…\n${longUrl}`), sms).toBe(true);
      expect(smsSegments(sms).segments).toBe(2);
      expect(
        ['Заказ DT-000123', 'Нужно ваше решение', 'Подтвердите заказ DT-000123'].some((start) =>
          sms.startsWith(start),
        ),
        sms,
      ).toBe(true);
    }
  });

  it('money_sent', () => {
    expect(renderSmsText(renderTemplate('money_sent', data()))).toBe(
      `Заказ DT-000123: деньги отправлены, зачисление зависит от банка.\n${ORDER_URL}`,
    );
  });
});

describe('staff templates of phase 1B', () => {
  it('format deadlines as day and month', () => {
    expect(renderTemplate('staff_refund_deadline', data()).text).toContain('Вернуть до 20 октября');
    expect(renderTemplate('staff_supplier_return_task', data()).text).toContain(
      'Вернуть Rossko до 20 октября',
    );
    expect(renderTemplate('staff_claim_deadline', data({ deadlineDate: null })).text).toContain(
      'Ответить до —',
    );
  });

  it('audit fixes: a refused payment, a missing refund receipt, «Повторить возврат»', () => {
    const rejected = renderTemplate(
      'staff_payment_rejected',
      data({ note: 'Ответ ЮKassa: invalid_request (HTTP 400).' }),
    ).text;
    expect(rejected).toContain('Заказ DT-000123: ЮKassa не создала платёж');
    expect(rejected).toContain('invalid_request (HTTP 400)');
    expect(renderTemplate('staff_refund_receipt_failed', data()).text).toContain(
      'чек возврата не зарегистрирован',
    );
    expect(renderTemplate('staff_refund_failed', data()).text).toContain('«Повторить возврат»');
  });

  it('staff_problem keeps order-level actions only (item menus live in the bot card)', () => {
    const actions = renderTemplate('staff_problem', data())
      .buttons.flat()
      .flatMap((b) => (b.kind === 'action' ? [b.action] : []));
    expect(actions).toEqual(['anyway', 'cancel']);
  });

  it('orphan payment, receipt failure, unreachable client, refund deadline', () => {
    expect(renderTemplate('staff_orphan_payment', data()).text).toMatch(/1\s280/u);
    expect(renderTemplate('staff_receipt_failed', data({ note: 'код 400' })).text).toContain(
      '«Повторить чек»',
    );
    expect(renderTemplate('staff_approval_unreachable', data()).text).toContain(
      'Таймер ответа не запущен',
    );
    for (const template of staffTemplates) {
      const message = renderTemplate(template, data());
      expect(message.buttons.flat().at(-1)).toMatchObject({ kind: 'url' });
    }
  });
});

describe('format helpers', () => {
  it('formatReplyBy shows Orenburg wall clock', () => {
    expect(formatReplyBy('2026-10-03T09:30:00Z')).toBe('14:30 3 октября');
    expect(formatReplyBy(new Date('2026-12-31T19:00:00Z'))).toBe('00:00 1 января');
    expect(formatReplyBy('not a date')).toBeNull();
    expect(formatReplyBy(null)).toBeNull();
    expect(formatReplyBy('2026-10-03T09:30:00Z', { compact: true })).toBe('14:30 03.10');
    expect(formatReplyBy(new Date('2026-12-31T19:00:00Z'), { compact: true })).toBe('00:00 01.01');
    expect(formatReplyBy(undefined)).toBeNull();
  });

  it('deadline', () => {
    expect(deadline('2026-10-20')).toBe('20 октября');
    expect(deadline(null)).toBe('—');
    expect(deadline(undefined, 'срока')).toBe('срока');
  });
});
