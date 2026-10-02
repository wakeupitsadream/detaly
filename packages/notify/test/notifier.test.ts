import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ORDER_NOTIFY_TEMPLATES, rulesFor, TRANSITIONS } from '@detaly/domain';
import { describe, expect, it } from 'vitest';
import {
  CALLBACK_ACTIONS,
  ChannelBlockedError,
  type ChannelDriver,
  createNotifier,
  eventForAction,
  FALLBACK_REASONS,
  maskPhone,
  type MessengerBindingInfo,
  type NotifyRecipient,
  ORDER_TEMPLATES,
  type OrderTemplateData,
  type RenderedMessage,
  renderPing,
  renderSmsText,
  renderTemplate,
  selectChannel,
  SMS_ALLOWED_TEMPLATES,
} from '../src';

const ORDER_ID = '0192f0c4-7b1a-7cde-8f00-0123456789ab';

const data = (over: Partial<OrderTemplateData> = {}): OrderTemplateData => ({
  brandName: 'Тестовый бренд',
  orderId: ORDER_ID,
  orderNumber: 'DT-000123',
  orderUrl: 'https://example.test/o/secret',
  scheme: 'prepay',
  items: [{ brand: 'MANN', article: 'W 914/2' }],
  promisedDate: '2026-10-08',
  totalKop: 128_000,
  paidAmountKop: 128_100,
  paymentUrl: 'https://pay.example.test/1',
  pickup: { name: 'Пункт выдачи', address: 'ул. Тестовая, 1', hours: 'пн–сб 9–19' },
  pickupCode: '4821',
  note: 'Новый срок от поставщика',
  clientPhone: '+7 (999) 123-45-67',
  adminUrl: 'https://example.test/admin/orders/1',
  supplierInvoice: { number: 'R-77', amountKop: 90_000 },
  deadlineDate: '2026-10-20',
  readyDays: null,
  ...over,
});

const binding = (over: Partial<MessengerBindingInfo>): MessengerBindingInfo => ({
  channel: 'telegram',
  chatId: '100',
  isPrimary: true,
  blocked: false,
  ...over,
});

const client = (
  bindings: MessengerBindingInfo[],
  phone: string | null = '+79991234567',
): NotifyRecipient => ({
  kind: 'client',
  bindings,
  phone,
});

const ALL = new Set(['telegram', 'max', 'sms'] as const);

describe('templates', () => {
  it('cover every transition template id', () => {
    expect(Object.keys(ORDER_TEMPLATES).sort()).toEqual([...ORDER_NOTIFY_TEMPLATES].sort());
    for (const rule of TRANSITIONS) {
      for (const spec of rule.notify) expect(ORDER_TEMPLATES).toHaveProperty(spec.template);
    }
  });

  it.each(ORDER_NOTIFY_TEMPLATES.map((t) => [t] as const))(
    '%s renders for both schemes',
    (template) => {
      for (const scheme of ['prepay', 'pay_on_handover'] as const) {
        const message = renderTemplate(template, data({ scheme }));
        expect(message.text.length).toBeGreaterThan(10);
        expect(message.text).toContain('DT-000123');
        for (const button of message.buttons.flat()) {
          if (button.kind === 'action') {
            expect(eventForAction(button.action), button.action).not.toBeNull();
            expect(button.orderId).toBe(ORDER_ID);
          } else {
            expect(button.url).toMatch(/^https:\/\//);
          }
        }
      }
    },
  );

  it('client templates carry no client phone; staff cards show it masked', () => {
    for (const template of ORDER_NOTIFY_TEMPLATES) {
      const { text } = renderTemplate(template, data());
      expect(text, template).not.toMatch(/999\D*123/);
      if (!template.startsWith('staff_')) {
        expect(text, template).not.toContain('•••');
        expect(text, template).not.toContain('admin');
      }
    }
    expect(renderTemplate('staff_new_order', data()).text).toContain('•••4567');
  });

  it('client templates use the brand from data', () => {
    expect(renderTemplate('paid', data()).text).toContain('Тестовый бренд · заказ DT-000123');
    expect(renderTemplate('paid', data()).text).toContain('к чт 8 октября');
  });

  it('scheme-specific wording: no refund promise without money', () => {
    expect(renderTemplate('order_cancelled', data({ scheme: 'pay_on_handover' })).text).toContain(
      'Оплаты не было',
    );
    expect(renderTemplate('storage_expired', data()).text).toContain('Деньги вернутся');
    expect(
      renderTemplate('storage_expired', data({ scheme: 'pay_on_handover' })).text,
    ).not.toContain('Деньги');
  });

  it('decision_needed offers "Согласен" and "Вернуть деньги"', () => {
    const { buttons } = renderTemplate('decision_needed', data());
    expect(buttons[0]?.map((b) => b.text)).toEqual(['Согласен', 'Вернуть деньги']);
  });

  it('ping', () => {
    expect(renderPing({ heartbeatAgeSec: 12.4, dbOk: true, gitSha: 'abcdef123456' }).text).toBe(
      'pong · heartbeat 12s · db ok · abcdef1',
    );
    expect(renderPing({ heartbeatAgeSec: null, dbOk: false, gitSha: null }).text).toBe(
      'pong · heartbeat нет · db fail · dev',
    );
  });

  it('vin proposal', () => {
    const message = renderTemplate('vin_proposal', {
      brandName: 'Тестовый бренд',
      proposalUrl: 'https://example.test/p/x',
    });
    expect(renderSmsText(message)).toBe(
      'Тестовый бренд · подбор по VIN готов\nЦены и сроки — по ссылке.\nhttps://example.test/p/x',
    );
  });

  it('maskPhone keeps only the last 4 digits', () => {
    expect(maskPhone('+7 (999) 123-45-67')).toBe('•••4567');
    expect(maskPhone(null)).toBe('•••');
    expect(maskPhone('12')).toBe('•••');
  });

  it('callback actions map to order events', () => {
    expect(eventForAction('recheck')).toBe('supplier_order_requested');
    expect(eventForAction('toString')).toBeNull();
    expect(Object.keys(CALLBACK_ACTIONS).every((a) => a.length <= 16)).toBe(true);
  });

  it('action buttons map to events that have a rule in the status the message is sent for', () => {
    for (const rule of TRANSITIONS) {
      for (const spec of rule.notify) {
        for (const scheme of ['prepay', 'pay_on_handover'] as const) {
          const message = ORDER_TEMPLATES[spec.template](data({ scheme }));
          for (const button of message.buttons.flat()) {
            if (button.kind !== 'action') continue;
            const event = eventForAction(button.action);
            expect(event, `${spec.template}: ${button.action}`).not.toBeNull();
            expect(
              rulesFor(rule.to, event as NonNullable<typeof event>).length,
              `${spec.template} (sent in ${rule.to}): ${button.action} -> ${String(event)}`,
            ).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('no hardcoded brand name in sources', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(join(import.meta.dirname, '..', 'src'));
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/Детали/u);
  });
});

describe('selectChannel', () => {
  it('prefers MAX, then Telegram', () => {
    const both = client([
      binding({ channel: 'telegram', chatId: 't' }),
      binding({ channel: 'max', chatId: 'm' }),
    ]);
    expect(selectChannel(both, 'paid', ALL)).toEqual({
      status: 'send',
      channel: 'max',
      address: 'm',
      fallbackReason: null,
    });
    expect(selectChannel(both, 'paid', new Set(['telegram', 'sms'] as const))).toMatchObject({
      channel: 'telegram',
      address: 't',
    });
  });

  it('skips blocked bindings and prefers the primary one', () => {
    const recipient = client([
      binding({ channel: 'max', chatId: 'm', blocked: true }),
      binding({ chatId: 't1', isPrimary: false }),
      binding({ chatId: 't2', isPrimary: true }),
    ]);
    expect(selectChannel(recipient, 'paid', ALL)).toMatchObject({
      channel: 'telegram',
      address: 't2',
    });
  });

  it('falls back to SMS only for allowlisted templates', () => {
    expect(SMS_ALLOWED_TEMPLATES).toEqual([
      'confirm_request',
      'vin_proposal',
      'decision_needed',
      'arrived',
      'money_sent',
    ]);
    for (const template of SMS_ALLOWED_TEMPLATES) {
      expect(selectChannel(client([]), template, ALL)).toEqual({
        status: 'send',
        channel: 'sms',
        address: '+79991234567',
        fallbackReason: FALLBACK_REASONS.noMessenger,
      });
    }
    expect(selectChannel(client([]), 'paid', ALL)).toEqual({
      status: 'skipped',
      fallbackReason: FALLBACK_REASONS.notInSmsAllowlist,
    });
    expect(selectChannel(client([], null), 'arrived', ALL)).toMatchObject({
      status: 'skipped',
      fallbackReason: FALLBACK_REASONS.noPhone,
    });
    expect(selectChannel(client([]), 'arrived', new Set(['telegram'] as const))).toMatchObject({
      status: 'skipped',
      fallbackReason: FALLBACK_REASONS.smsUnavailable,
    });
  });

  it('fixed chats go to their channel', () => {
    const chat: NotifyRecipient = { kind: 'chat', channel: 'telegram', chatId: '-100' };
    expect(selectChannel(chat, 'staff_new_order', ALL)).toMatchObject({
      channel: 'telegram',
      address: '-100',
    });
    expect(selectChannel(chat, 'staff_new_order', new Set(['sms'] as const))).toMatchObject({
      status: 'skipped',
    });
  });
});

describe('createNotifier', () => {
  function driver(
    channel: 'telegram' | 'max' | 'sms',
    behaviour: 'ok' | 'blocked' | 'error' = 'ok',
  ) {
    const sent: { address: string; message: RenderedMessage }[] = [];
    const d: ChannelDriver = {
      channel,
      send(address, message) {
        sent.push({ address, message });
        if (behaviour === 'blocked') return Promise.reject(new ChannelBlockedError(channel));
        if (behaviour === 'error') return Promise.reject(new Error('timeout'));
        return Promise.resolve({ externalId: `${channel}-1` });
      },
    };
    return { d, sent };
  }

  it('renders and sends through the selected driver', async () => {
    const tg = driver('telegram');
    const notifier = createNotifier({ drivers: [tg.d] });
    const result = await notifier.send(client([binding({ chatId: '555' })]), 'paid', data());
    expect(result).toEqual({
      status: 'sent',
      channel: 'telegram',
      externalId: 'telegram-1',
      fallbackReason: null,
      blocked: [],
    });
    expect(tg.sent[0]?.address).toBe('555');
    expect(tg.sent[0]?.message.text).toContain('Заказ оплачен');
  });

  it('a blocked bot falls back to SMS for allowlisted templates', async () => {
    const tg = driver('telegram', 'blocked');
    const sms = driver('sms');
    const notifier = createNotifier({ drivers: [tg.d, sms.d] });
    const result = await notifier.send(client([binding({ chatId: '555' })]), 'arrived', data());
    expect(result).toMatchObject({
      status: 'sent',
      channel: 'sms',
      fallbackReason: 'blocked:telegram',
      blocked: [{ channel: 'telegram', address: '555' }],
    });
    expect(sms.sent[0]?.address).toBe('+79991234567');
  });

  it('a blocked bot with a non-allowlisted template is skipped', async () => {
    const tg = driver('telegram', 'blocked');
    const notifier = createNotifier({ drivers: [tg.d, driver('sms').d] });
    const result = await notifier.send(client([binding({ chatId: '555' })]), 'paid', data());
    expect(result).toEqual({
      status: 'skipped',
      fallbackReason: `blocked:telegram;${FALLBACK_REASONS.notInSmsAllowlist}`,
      blocked: [{ channel: 'telegram', address: '555' }],
    });
  });

  it('other driver errors propagate for queue retries', async () => {
    const notifier = createNotifier({ drivers: [driver('telegram', 'error').d] });
    await expect(notifier.send(client([binding({})]), 'paid', data())).rejects.toThrow('timeout');
  });

  it('staff ping goes to a fixed chat', async () => {
    const tg = driver('telegram');
    const notifier = createNotifier({ drivers: [tg.d] });
    await notifier.send({ kind: 'chat', channel: 'telegram', chatId: '-100' }, 'ping', {
      heartbeatAgeSec: 3,
      dbOk: true,
      gitSha: 'abc1234',
    });
    expect(tg.sent[0]).toEqual({
      address: '-100',
      message: { text: 'pong · heartbeat 3s · db ok · abc1234', buttons: [] },
    });
  });
});
