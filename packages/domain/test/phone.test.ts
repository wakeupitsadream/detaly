import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhone, phoneLast4 } from '../src';

describe('normalizePhone', () => {
  it.each([
    ['8 (912) 345-67-89', '+79123456789'],
    ['+7 912 345 67 89', '+79123456789'],
    ['+7 (912) 345-67-89', '+79123456789'],
    ['9123456789', '+79123456789'],
    ['79123456789', '+79123456789'],
    ['  8.912.345.67.89 ', '+79123456789'],
    ['3532123456', '+73532123456'],
    ['8 (3532) 12-34-56', '+73532123456'],
    ['8 800 555-35-35', '+78005553535'],
    ['8 (812) 123-45-67', '+78121234567'],
    ['8121234567', '+78121234567'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    '+1 202 555 0100',
    '12345',
    '912345678',
    '1234567890',
    '+7 123 456 78 90',
    '+7 701 123 45 67',
    '8 912 345 67 8a',
    'телефон',
    '791234567890',
    '+791234567890',
    '+8 912 345 67 89',
    // '8 9xx…' with a digit missing must not become +7 89x… (88x/89x are not allocated)
    '8912345678',
    '8 (912) 345-67-8',
    '+7 891 234 56 78',
    '8812345678',
    '',
    '   ',
    '+7',
  ])('rejects %j', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(normalizePhone(undefined as unknown as string)).toBeNull();
  });
});

describe('phoneLast4 and maskPhone', () => {
  it('takes the last four digits', () => {
    expect(phoneLast4('+79123456789')).toBe('6789');
  });

  it('masks everything except the last four digits', () => {
    expect(maskPhone('+79123454567')).toBe('+7 ••• •••-45-67');
    expect(maskPhone('+79123456789')).not.toContain('912');
  });
});
