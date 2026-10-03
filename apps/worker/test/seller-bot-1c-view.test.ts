// Pure parts of the phase 1C seller bot (docs/phase-1c-implementation.md section 9): the claim
// and booking lines of the order card, the 1C buttons, the VIN card (masked view, preview lines,
// which buttons when), the Redis waits.
import { CALLBACK_DATA_MAX_BYTES, parseCallbackData } from '@detaly/notify';
import type { VinPreview, VinPreviewLine } from '@detaly/domain';
import type { VinRequestStaffView } from '@detaly/vin';
import { describe, expect, it } from 'vitest';
import { awaitKey, parseAwaiting } from '../src/bots/seller/awaiting';
import {
  bookingLine,
  claimLine,
  mainKeyboard,
  PACKAGING_PHOTO_HINT,
  renderCardText,
  type CardData,
} from '../src/bots/seller/card-view';
import {
  canSendPreview,
  hasUnsentPreview,
  previewLineText,
  renderVinCardText,
  vinKeyboard,
  type VinCardData,
} from '../src/bots/seller/vin-view';

const ORDER_ID = '0192f0c4-0000-7000-8000-00000000a001';
const CLAIM_ID = '0192f0c4-0000-7000-8000-00000000c001';
const BOOKING_ID = '0192f0c4-0000-7000-8000-00000000b001';
const VIN_ID = '0192f0c4-0000-7000-8000-0000006789ab';
const NONCE = 'AbCd_-12';
const ETA = { bufferDays: 1, invoiceLagDays: 0, prepayInvoice: false };

function cardData(overrides: Partial<CardData> = {}): CardData {
  return {
    order: {
      id: ORDER_ID,
      number: 'DT-000123',
      status: 'handed',
      paymentScheme: 'prepay',
      totalKop: 192_000,
      createdAt: new Date('2026-10-01T05:00:00Z'),
      promisedDate: '2026-10-05',
      attentionReason: null,
      supplierReturnDeadlineAt: null,
    },
    items: [{ id: 'i1', brand: 'MANN', article: 'W 914/2', qty: 1, state: 'handed' }],
    phone: '+79161234567',
    actions: [],
    adminUrl: `https://detaly.test/admin/orders/${ORDER_ID}`,
    ...overrides,
  };
}

describe('order card, phase 1C', () => {
  it('claim line: kind, item, deadline, return accepted, client photos count; no texts', () => {
    const line = claimLine({
      id: CLAIM_ID,
      kind: 'defect',
      item: { brand: 'MANN', article: 'W 914/2' },
      deadlineAt: new Date('2026-10-12T10:00:00Z'),
      returnAccepted: false,
      photoCount: 2,
      decision: null,
    });
    expect(line).toBe(
      'Претензия: брак · позиция MANN W 914/2 · ответить до 12 октября · возврат принят нет · фото клиента: 2 (в админке)',
    );
    const delay = claimLine({
      id: CLAIM_ID,
      kind: 'delay',
      item: null,
      deadlineAt: new Date('2026-10-12T10:00:00Z'),
      returnAccepted: false,
      photoCount: 0,
      decision: 'replace',
    });
    expect(delay).toContain('Претензия: просрочка · весь заказ');
    expect(delay).not.toContain('возврат принят');
    expect(delay).toContain('решение: замена — закажите замену, затем «Замена выдана»');
  });

  it('booking line and the 1C buttons carry the claim / booking / order id', () => {
    expect(
      bookingLine({ id: BOOKING_ID, dayText: 'чт 8 окт', timeText: '14:00', status: 'requested' }),
    ).toBe('Запись на установку: чт 8 окт 14:00 — ждёт подтверждения');
    const data = cardData({
      actions1C: [
        { code: 'cret', label: 'Принял возврат', claimId: CLAIM_ID, enabled: true },
        {
          code: 'cref',
          label: 'Вернуть деньги',
          claimId: CLAIM_ID,
          enabled: false,
          disabledReason: 'Сначала «Принял возврат»',
        },
        { code: 'bconf', label: 'Подтвердить запись', bookingId: BOOKING_ID, enabled: true },
        { code: 'pphoto', label: 'Фото упаковки', enabled: true },
      ],
    });
    const keyboard = mainKeyboard(data, NONCE).flat();
    expect(keyboard.map((b) => b.text)).toEqual([
      'Принял возврат',
      'Подтвердить запись',
      'Фото упаковки',
      'Открыть в админке',
    ]);
    const parsed = keyboard
      .filter((b): b is { text: string; callback_data: string } => 'callback_data' in b)
      .map((b) => {
        expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
        return parseCallbackData(b.callback_data);
      });
    expect(parsed.map((p) => [p?.action, p?.orderId])).toEqual([
      ['cret', CLAIM_ID],
      ['bconf', BOOKING_ID],
      ['pphoto', ORDER_ID],
    ]);
    // A disabled button is explained in the text.
    expect(renderCardText(data)).toContain(
      '«Вернуть деньги» пока недоступно: Сначала «Принял возврат»',
    );
  });

  it('the hint in ordered_at_supplier and the packaging photo count; masked phone only', () => {
    const data = cardData({
      order: { ...cardData().order, status: 'ordered_at_supplier' },
      packagingPhotos: 1,
    });
    const text = renderCardText(data);
    expect(text).toContain(PACKAGING_PHOTO_HINT);
    expect(text).toContain('Фото упаковки: 1');
    expect(text).toContain('Клиент •••4567');
    expect(text).not.toContain('9161234567');
  });
});

function okLine(overrides: Partial<Extract<VinPreviewLine, { status: 'ok' }>> = {}) {
  return {
    line: 1,
    raw: 'MANN W914/2 1',
    status: 'ok',
    brand: 'MANN-FILTER',
    article: 'W 914/2',
    name: 'Фильтр масляный',
    qty: 1,
    offer: {} as never,
    searchArticleNorm: 'W9142',
    offerKey: 'W9142:MANN-FILTER:ORB1',
    priceClientKop: 79_800,
    priceSupplierKop: 62_340,
    markupBp: 2800,
    etaDate: '2026-10-08',
    isLocal: true,
    note: null,
    ...overrides,
  } as Extract<VinPreviewLine, { status: 'ok' }>;
}

function preview(lines: VinPreviewLine[], checkedAt = '2026-10-03T05:00:00.000Z'): VinPreview {
  const ok = lines.filter((l) => l.status === 'ok') as Extract<VinPreviewLine, { status: 'ok' }>[];
  return {
    lines,
    comment: null,
    totalKop: ok.reduce((sum, l) => sum + l.priceClientKop * l.qty, 0),
    okCount: ok.length,
    errorCount: lines.length - ok.length,
    checkedAt,
  };
}

function request(overrides: Partial<VinRequestStaffView> = {}): VinRequestStaffView {
  return {
    id: VIN_ID,
    status: 'new',
    vin: 'XTA21099043456789',
    carText: 'ВАЗ 2109',
    needText: 'Фильтр, звоните •••',
    phone: '•••4567',
    channel: 'telegram',
    photos: [`vin/${VIN_ID}/a.jpg`, `vin/${VIN_ID}/b.jpg`],
    photosDeleted: false,
    assignedStaffId: null,
    answerText: null,
    preview: null,
    proposalCount: 0,
    proposalCartId: null,
    proposalExpiresAt: null,
    proposalToken: null,
    createdAt: new Date('2026-10-03T04:00:00Z'),
    answeredAt: null,
    closedAt: null,
    closeReason: null,
    ...overrides,
  };
}

function vinData(overrides: Partial<VinRequestStaffView> = {}): VinCardData {
  return {
    request: request(overrides),
    adminUrl: `https://detaly.test/admin/vin/${VIN_ID}`,
    eta: ETA,
  };
}

const buttonTexts = (data: VinCardData) =>
  vinKeyboard(data, NONCE)
    .flat()
    .map((b) => b.text);

describe('VIN card', () => {
  it('shows the VIN, the photo count (never the keys), the masked phone and the channel', () => {
    const text = renderVinCardText(vinData());
    expect(text).toContain('Заявка VIN № 6789AB');
    expect(text).toContain('VIN XTA21099043456789');
    expect(text).toContain('Фото: 2 (в админке)');
    expect(text).not.toContain('a.jpg');
    expect(text).toContain('Клиент •••4567 · ответ: Telegram');
    expect(buttonTexts(vinData())).toEqual([
      'Взять в работу',
      'Ответить строками',
      'Закрыть заявку',
      'Открыть в админке',
    ]);
    for (const button of vinKeyboard(vinData(), NONCE).flat()) {
      if ('callback_data' in button) {
        expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(
          CALLBACK_DATA_MAX_BYTES,
        );
        expect(parseCallbackData(button.callback_data)?.orderId).toBe(VIN_ID);
      }
    }
  });

  it('preview lines: ✓ with the sum, the date and the local badge; ✗ with the reason', () => {
    expect(previewLineText(okLine({ qty: 2 }), ETA)).toMatch(
      /^✓ MANN-FILTER W 914\/2 × 2 — 1\u00a0596\u00a0₽ \(по 798\u00a0₽\), к \S+ 9 октября, в Оренбурге$/u,
    );
    expect(
      previewLineText(
        {
          line: 2,
          raw: 'BOSH OC90 1',
          status: 'error',
          reason: 'brand_mismatch',
          brands: ['Knecht', 'MAHLE'],
          message: 'Бренд BOSH не найден для OC90, есть: Knecht, MAHLE',
        },
        ETA,
      ),
    ).toBe('✗ 2: BOSH OC90 1 — Бренд BOSH не найден для OC90, есть: Knecht, MAHLE');
  });

  it('«Отправить клиенту» only for an unsent preview without errors', () => {
    const withError = preview([
      okLine(),
      { line: 2, raw: 'X 1', status: 'error', reason: 'parse', message: 'Нет артикула' },
    ]);
    expect(buttonTexts(vinData({ status: 'in_work', preview: withError }))).toEqual([
      'Исправить',
      'Закрыть заявку',
      'Открыть в админке',
    ]);
    const clean = preview([okLine()]);
    expect(canSendPreview(request({ status: 'in_work', preview: clean }))).toBe(true);
    expect(buttonTexts(vinData({ status: 'in_work', preview: clean }))[0]).toBe(
      'Отправить клиенту',
    );
    // Sent after the check: no second «Отправить», a new answer is «Новая подборка строками».
    const sent = request({
      status: 'offered',
      preview: clean,
      proposalCount: 1,
      answeredAt: new Date('2026-10-03T05:01:00Z'),
    });
    expect(hasUnsentPreview(sent)).toBe(false);
    expect(buttonTexts({ ...vinData(), request: sent })).toEqual([
      'Новая подборка строками',
      'Закрыть заявку',
      'Открыть в админке',
    ]);
    // A preview checked after the send is a new answer.
    const newer = { ...sent, preview: preview([okLine()], '2026-10-03T06:00:00.000Z') };
    expect(canSendPreview(newer)).toBe(true);
    // Finished requests: the admin link only, no preview.
    for (const status of ['converted', 'closed'] as const) {
      const data = vinData({ status, preview: clean });
      expect(buttonTexts(data)).toEqual(['Открыть в админке']);
      expect(renderVinCardText(data)).not.toContain('Превью ответа');
    }
  });
});

describe('Redis waits', () => {
  it('parses every kind, the 1B value without a kind is «Счёт оплачен», junk is nothing', () => {
    expect(awaitKey('p:', -100, 7)).toBe('p:seller:await:-100:7');
    expect(parseAwaiting(JSON.stringify({ orderId: ORDER_ID, promptMessageId: 5 }))).toEqual({
      kind: 'invoice',
      orderId: ORDER_ID,
      promptMessageId: 5,
    });
    expect(
      parseAwaiting(
        JSON.stringify({
          kind: 'claim_text',
          code: 'cref',
          orderId: ORDER_ID,
          claimId: CLAIM_ID,
          reason: 'причина',
          promptMessageId: 6,
        }),
      ),
    ).toMatchObject({ kind: 'claim_text', code: 'cref', reason: 'причина' });
    expect(
      parseAwaiting(
        JSON.stringify({
          kind: 'photo',
          purpose: 'return',
          orderId: ORDER_ID,
          claimId: null,
          promptMessageId: 1,
        }),
      ),
    ).toBeNull();
    expect(
      parseAwaiting(
        JSON.stringify({ kind: 'vin_answer', vinRequestId: VIN_ID, promptMessageId: 2 }),
      ),
    ).toEqual({ kind: 'vin_answer', vinRequestId: VIN_ID, promptMessageId: 2 });
    expect(parseAwaiting(JSON.stringify({ kind: 'claim_text', code: 'cdel' }))).toBeNull();
    expect(parseAwaiting('not json')).toBeNull();
    expect(parseAwaiting(null)).toBeNull();
  });
});
