// Step 3 (docs/reviews.md): «Как деталь?» with the review buttons and the one review reminder.
// Without a review link how_is_it is exactly the phase 1C message; the review buttons lead to
// our redirect under the order page (never to the map service), «Есть проблема» to the claim
// form; no rewards, no rating question; the reminder never goes by SMS.
import type { ReviewPlatform } from '@detaly/domain';
import { describe, expect, it } from 'vitest';
import {
  isSmsAllowed,
  renderTemplate,
  selectChannel,
  type MessengerBindingInfo,
  type OrderTemplateData,
} from '../src';

const ORDER_ID = '0192f0c4-7b1a-7cde-8f00-0123456789ab';
const ORDER_URL = `https://shop.test/o/${'A1b2C3d4E5'.repeat(4)}xyz`;

const data = (over: Partial<OrderTemplateData> = {}): OrderTemplateData => ({
  brandName: 'Тестовый бренд',
  orderId: ORDER_ID,
  orderNumber: 'DT-000123',
  orderUrl: ORDER_URL,
  scheme: 'pay_on_handover',
  items: [{ brand: 'MANN', article: 'W 914/2' }],
  ...over,
});

const PHASE_1C_HOW_IS_IT = {
  text: 'Тестовый бренд · заказ DT-000123\nКак деталь? Если что-то не так, оформите претензию на странице заказа.',
  buttons: [
    [{ kind: 'url', text: 'Претензия', url: `${ORDER_URL}#claim` }],
    [{ kind: 'url', text: 'Открыть заказ', url: ORDER_URL }],
  ],
};

const BOTH: readonly ReviewPlatform[] = ['yandex', '2gis'];

describe('how_is_it without a review link', () => {
  it('is exactly the phase 1C message (no field, null or empty list)', () => {
    for (const over of [{}, { reviewPlatforms: null }, { reviewPlatforms: [] }]) {
      expect(renderTemplate('how_is_it', data(over)), JSON.stringify(over)).toEqual(
        PHASE_1C_HOW_IS_IT,
      );
    }
  });
});

describe('how_is_it with review links', () => {
  it('asks for a review and offers «Есть проблема» alike', () => {
    const message = renderTemplate('how_is_it', data({ reviewPlatforms: BOTH }));
    expect(message.text).toBe(
      'Тестовый бренд · заказ DT-000123\nКак деталь? Если всё в порядке — оставьте, пожалуйста, отзыв о Тестовый бренд: он помогает другим водителям найти нас. Если что-то не так — нажмите «Есть проблема», разберёмся.',
    );
    expect(message.buttons).toEqual([
      [
        { kind: 'url', text: 'Отзыв в Яндекс Картах', url: `${ORDER_URL}/review/yandex` },
        { kind: 'url', text: 'Отзыв в 2ГИС', url: `${ORDER_URL}/review/2gis` },
      ],
      [{ kind: 'url', text: 'Есть проблема', url: `${ORDER_URL}#claim` }],
      [{ kind: 'url', text: 'Открыть заказ', url: ORDER_URL }],
    ]);
    expect(message.photos).toBeUndefined();
    expect(message.smsText).toBeUndefined();
  });

  it('only the configured platform gets a button', () => {
    const yandex = renderTemplate('how_is_it', data({ reviewPlatforms: ['yandex'] }));
    expect(yandex.buttons[0]).toEqual([
      { kind: 'url', text: 'Отзыв в Яндекс Картах', url: `${ORDER_URL}/review/yandex` },
    ]);
    const twoGis = renderTemplate('how_is_it', data({ reviewPlatforms: ['2gis'] }));
    expect(twoGis.buttons[0]).toEqual([
      { kind: 'url', text: 'Отзыв в 2ГИС', url: `${ORDER_URL}/review/2gis` },
    ]);
    expect(twoGis.buttons[1]).toEqual([
      { kind: 'url', text: 'Есть проблема', url: `${ORDER_URL}#claim` },
    ]);
  });
});

describe('review_reminder', () => {
  it('a short request with the same review buttons and «Есть проблема»', () => {
    const message = renderTemplate('review_reminder', data({ reviewPlatforms: BOTH }));
    expect(message.text).toBe(
      'Тестовый бренд · заказ DT-000123\nЕсли будет минутка — оставьте отзыв о Тестовый бренд в Картах. Спасибо!',
    );
    expect(message.buttons).toEqual([
      [
        { kind: 'url', text: 'Отзыв в Яндекс Картах', url: `${ORDER_URL}/review/yandex` },
        { kind: 'url', text: 'Отзыв в 2ГИС', url: `${ORDER_URL}/review/2gis` },
      ],
      [{ kind: 'url', text: 'Есть проблема', url: `${ORDER_URL}#claim` }],
    ]);
  });

  it('is not in the SMS allowlist: skipped without a messenger, sent to Telegram', () => {
    expect(isSmsAllowed('review_reminder')).toBe(false);
    expect(isSmsAllowed('how_is_it')).toBe(false);
    const available = new Set(['telegram', 'max', 'sms'] as const);
    expect(
      selectChannel(
        { kind: 'client', bindings: [], phone: '+79990000000' },
        'review_reminder',
        available,
      ),
    ).toEqual({ status: 'skipped', fallbackReason: 'no_messenger:not_in_sms_allowlist' });
    const telegram: MessengerBindingInfo = {
      channel: 'telegram',
      chatId: '42',
      isPrimary: true,
      blocked: false,
    };
    expect(
      selectChannel(
        { kind: 'client', bindings: [telegram], phone: '+79990000000' },
        'review_reminder',
        available,
      ),
    ).toEqual({ status: 'send', channel: 'telegram', address: '42', fallbackReason: null });
  });
});

describe('both templates', () => {
  it('review buttons go to our redirect only, never to the map services', () => {
    for (const template of ['how_is_it', 'review_reminder'] as const) {
      const urls = renderTemplate(template, data({ reviewPlatforms: BOTH }))
        .buttons.flat()
        .flatMap((button) => (button.kind === 'url' ? [button.url] : []));
      for (const url of urls) {
        expect(url.startsWith(ORDER_URL), url).toBe(true);
        expect(url).not.toMatch(/yandex\.ru|2gis\.ru/);
      }
    }
  });

  it('no reward, no rating question, the brand from data', () => {
    for (const template of ['how_is_it', 'review_reminder'] as const) {
      const { text } = renderTemplate(template, data({ reviewPlatforms: BOTH }));
      expect(text).toContain('Тестовый бренд');
      expect(text).not.toMatch(/скидк|бонус|подар|балл|промокод|кэшбэк|оцените|звёзд|5 звезд/i);
    }
  });
});
