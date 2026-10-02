import { describe, expect, it } from 'vitest';
import { type RenderedMessage, renderSmsText, smsCapacity, smsSegments } from '../src';

const URL = 'https://example.test/o/abc';

const message = (text: string, over: Partial<RenderedMessage> = {}): RenderedMessage => ({
  text,
  buttons: [
    [{ kind: 'action', text: 'Подтверждаю', action: 'confirm', orderId: 'x' }],
    [{ kind: 'url', text: 'Открыть', url: URL }],
  ],
  ...over,
});

describe('smsSegments', () => {
  it('GSM-7: 160 in one part, 153 per part after that; extension chars cost two', () => {
    expect(smsSegments('')).toEqual({ encoding: 'gsm7', units: 0, segments: 0 });
    expect(smsSegments('a'.repeat(160))).toMatchObject({ encoding: 'gsm7', segments: 1 });
    expect(smsSegments('a'.repeat(161))).toMatchObject({ segments: 2 });
    expect(smsSegments('a'.repeat(306))).toMatchObject({ segments: 2 });
    expect(smsSegments('a'.repeat(307))).toMatchObject({ segments: 3 });
    expect(smsSegments('{}')).toMatchObject({ encoding: 'gsm7', units: 4 });
  });

  it('any Cyrillic letter makes the message UCS-2: 70, then 67 per part', () => {
    expect(smsSegments('ж'.repeat(70))).toMatchObject({ encoding: 'ucs2', segments: 1 });
    expect(smsSegments('ж'.repeat(71))).toMatchObject({ segments: 2 });
    expect(smsSegments(`ж${'a'.repeat(133)}`)).toMatchObject({ units: 134, segments: 2 });
    expect(smsSegments(`ж${'a'.repeat(134)}`)).toMatchObject({ segments: 3 });
    expect(smsSegments('₽…')).toMatchObject({ encoding: 'ucs2' });
    expect(smsCapacity('ucs2', 2)).toBe(134);
    expect(smsCapacity('gsm7', 1)).toBe(160);
  });
});

describe('renderSmsText', () => {
  it('uses smsText when set, drops action buttons, appends URLs', () => {
    expect(renderSmsText(message('Длинный текст', { smsText: 'Коротко' }))).toBe(`Коротко\n${URL}`);
    expect(renderSmsText(message('Текст'))).toBe(`Текст\n${URL}`);
    expect(renderSmsText({ text: 'Без ссылки', buttons: [] })).toBe('Без ссылки');
  });

  it('shortens the text to two segments and never cuts the link', () => {
    const long = 'Очень длинное сообщение о заказе. '.repeat(10);
    const sms = renderSmsText(message(long));
    expect(smsSegments(sms)).toMatchObject({ encoding: 'ucs2', units: 134, segments: 2 });
    expect(sms.endsWith(`…\n${URL}`)).toBe(true);
    expect(sms.startsWith('Очень длинное сообщение')).toBe(true);
  });

  it('maxSegments is configurable', () => {
    const sms = renderSmsText(message('ж'.repeat(200)), { maxSegments: 1 });
    expect(sms).toHaveLength(70);
    expect(sms.endsWith(URL)).toBe(true);
  });

  it('a GSM-7 text that does not fit is cut on the UCS-2 budget (the ellipsis is UCS-2)', () => {
    const sms = renderSmsText(message('a'.repeat(400)));
    expect(smsSegments(sms).segments).toBeLessThanOrEqual(2);
    expect(sms.endsWith(URL)).toBe(true);
  });

  it('does not split a surrogate pair', () => {
    const sms = renderSmsText(message('😀'.repeat(100)));
    expect(sms.endsWith(`…\n${URL}`)).toBe(true);
    expect(sms).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(smsSegments(sms).segments).toBeLessThanOrEqual(2);
  });
});
