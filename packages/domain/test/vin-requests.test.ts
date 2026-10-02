import { describe, expect, it } from 'vitest';
import * as installParams from '../src/install-params';
import {
  LINK_TOKEN_TTL_MS,
  maskDigits,
  PROPOSAL_TTL_DAYS,
  VIN_NOTIFY_TEMPLATES,
  VIN_PHOTO_RETENTION_DAYS,
  VIN_PHOTOS_MAX,
} from '../src';

describe('maskDigits (decision С2)', () => {
  it.each([
    ['звоните 89123456789', 'звоните •••'],
    ['мой номер +7 (912) 345-67-89, спасибо', 'мой номер •••, спасибо'],
    ['8 912 345 67 89', '•••'],
    ['паспорт 5310 123456', 'паспорт •••'],
    ['два номера 1234567 и 7654321', 'два номера ••• и •••'],
  ])('%s', (input, expected) => {
    expect(maskDigits(input)).toBe(expected);
  });

  it('keeps short numbers: years, quantities, articles', () => {
    for (const text of [
      'Лада Гранта 2019, 1.6',
      'фильтр W 914/2, 2 шт',
      'колодки передние 0 986 4',
      'VIN XTA21099012345',
    ]) {
      expect(maskDigits(text)).toBe(text);
    }
  });

  it('leaves no 7-digit run behind', () => {
    const text = 'тел. 8-912-345-67-89 или 8 (3532) 12-34-56';
    expect(maskDigits(text).replace(/\D/g, '').length).toBeLessThan(7);
  });
});

describe('VIN policy constants', () => {
  it('match PLAN and the phase 1C decisions', () => {
    expect(VIN_PHOTOS_MAX).toBe(3);
    expect(VIN_PHOTO_RETENTION_DAYS).toBe(90);
    expect(PROPOSAL_TTL_DAYS).toBe(7);
    expect(LINK_TOKEN_TTL_MS).toBe(24 * 3600 * 1000);
    expect(VIN_NOTIFY_TEMPLATES).toEqual(['vin_received', 'vin_proposal']);
  });

  it('install params are plain numbers in a subpath without imports', () => {
    expect(installParams).toMatchObject({
      INSTALL_LIFTS: 2,
      INSTALL_JOB_MIN: 120,
      INSTALL_ARRIVAL_TIME: '12:00',
      INSTALL_SLOTS_SHOWN: 6,
      INSTALL_CLIENT_CANCEL_BEFORE_MIN: 120,
    });
  });
});
