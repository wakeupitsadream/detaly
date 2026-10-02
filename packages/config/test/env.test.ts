import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ENV_KEYS, EnvError, getEnv, parseEnv, resetEnvCache } from '../src/env';
import { minimalEnvSource } from '../src/testing';

const ENV_EXAMPLE = fileURLToPath(new URL('../../../.env.example', import.meta.url));

function readEnvExample(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of readFileSync(ENV_EXAMPLE, 'utf8').split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) result[match[1]!] = match[2]!;
  }
  return result;
}

describe('parseEnv', () => {
  it('applies PLAN defaults', () => {
    const env = parseEnv(minimalEnvSource());
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      TZ: 'Asia/Yekaterinburg',
      BRAND_NAME: 'Детали',
      ROSSKO_MODE: 'fixtures',
      ROSSKO_WSDL_BASE: 'https://api.rossko.ru/service/v2.1',
      ROSSKO_RPM_LIMIT: 250,
      ROSSKO_DAILY_LIMIT: 90000,
      ROSSKO_QUOTA_BREAKER_PCT: 70,
      ROSSKO_ALLOW_CHECKOUT: false,
      ROSSKO_LOCAL_STOCK_IDS: [],
      PRICING_MARKUP_PCT: 28,
      PRICE_DRIFT_TOLERANCE_PCT: 3,
      MARGIN_FLOOR_PCT: 10,
      ETA_BUFFER_DAYS: 1,
      ORDER_PAYMENT_TTL_MIN: 120,
      ON_PICKUP_MAX_TOTAL: 15000,
      ON_PICKUP_CONFIRM_TTL_H: 24,
      PICKUP_WINDOW_PREPAID_DAYS: 10,
      PICKUP_WINDOW_COD_DAYS: 7,
      SUPPLIER_RETURN_DAYS: 14,
      SUPPLIER_INVOICE_LAG_DAYS: 1,
      HANDED_COMPLETE_DAYS: 7,
      HANDOVER_QR_TTL_MIN: 15,
      NO_SHOW_LIMIT: 2,
      REMINDER_DAYS: [3, 6, 9],
      HEARTBEAT_STALE_SEC: 300,
      TRUSTED_IP_HEADER: 'none',
      NOINDEX_ALL: false,
      STAFF_SEED_JSON: [],
      VIN_PROVIDER: 'manual',
      SMS_PROVIDER: 'none',
      GIT_SHA: 'dev',
    });
    expect(env.SELLER_REQUISITES_INN).toBeUndefined();
  });

  it('treats empty strings as unset', () => {
    const env = parseEnv(
      minimalEnvSource({ ROSSKO_RPM_LIMIT: '', REMINDER_DAYS: '', BRAND_NAME: '' }),
    );
    expect(env.ROSSKO_RPM_LIMIT).toBe(250);
    expect(env.REMINDER_DAYS).toEqual([3, 6, 9]);
    expect(env.BRAND_NAME).toBe('Детали');
  });

  it('parses lists, numbers and booleans', () => {
    const env = parseEnv(
      minimalEnvSource({
        REMINDER_DAYS: ' 2, 5 ,9 ',
        ROSSKO_LOCAL_STOCK_IDS: 'ORB1, ORB2',
        PRICING_MARKUP_PCT: '27.5',
        NOINDEX_ALL: 'true',
        ROSSKO_ALLOW_CHECKOUT: '1',
        TG_SELLER_CHAT_ID: '-1001234567890',
      }),
    );
    expect(env.REMINDER_DAYS).toEqual([2, 5, 9]);
    expect(env.ROSSKO_LOCAL_STOCK_IDS).toEqual(['ORB1', 'ORB2']);
    expect(env.PRICING_MARKUP_PCT).toBe(27.5);
    expect(env.NOINDEX_ALL).toBe(true);
    expect(env.ROSSKO_ALLOW_CHECKOUT).toBe(true);
    expect(env.TG_SELLER_CHAT_ID).toBe(-1001234567890);
    expect(parseEnv(minimalEnvSource({ NOINDEX_ALL: 'false' })).NOINDEX_ALL).toBe(false);
    expect(parseEnv(minimalEnvSource({ NOINDEX_ALL: 'off' })).NOINDEX_ALL).toBe(false);
  });

  it('rejects malformed values', () => {
    expect(() => parseEnv(minimalEnvSource({ NOINDEX_ALL: 'maybe' }))).toThrow(EnvError);
    expect(() => parseEnv(minimalEnvSource({ REMINDER_DAYS: '3,x' }))).toThrow(/REMINDER_DAYS/);
    expect(() => parseEnv(minimalEnvSource({ REMINDER_DAYS: '3,-1' }))).toThrow(/REMINDER_DAYS/);
    expect(() => parseEnv(minimalEnvSource({ PRICING_MARKUP_PCT: '28.123' }))).toThrow(
      /PRICING_MARKUP_PCT/,
    );
    expect(() => parseEnv(minimalEnvSource({ TRUSTED_IP_HEADER: 'x-forwarded-for' }))).toThrow(
      /TRUSTED_IP_HEADER/,
    );
    expect(() => parseEnv(minimalEnvSource({ SELLER_REQUISITES_INN: '12345' }))).toThrow(
      /SELLER_REQUISITES_INN/,
    );
    expect(() => parseEnv(minimalEnvSource({ DATABASE_URL: 'mysql://x@y/z' }))).toThrow(
      /DATABASE_URL/,
    );
  });

  it('lists every missing required key without echoing values', () => {
    try {
      parseEnv({ SESSION_SECRET: 'short-secret-value' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const message = (error as EnvError).message;
      expect(message).toMatch(/DATABASE_URL/);
      expect(message).toMatch(/REDIS_URL/);
      expect(message).toMatch(/SESSION_SECRET/);
      expect(message).not.toContain('short-secret-value');
    }
  });

  it('requires Rossko keys in live mode', () => {
    expect(() => parseEnv(minimalEnvSource({ ROSSKO_MODE: 'live' }))).toThrow(/ROSSKO_KEY1/);
    const env = parseEnv(
      minimalEnvSource({ ROSSKO_MODE: 'live', ROSSKO_KEY1: 'k1', ROSSKO_KEY2: 'k2' }),
    );
    expect(env.ROSSKO_MODE).toBe('live');
  });

  it('parses STAFF_SEED_JSON', () => {
    const env = parseEnv(
      minimalEnvSource({
        STAFF_SEED_JSON:
          '[{"name":"Максим","role":"owner","tgUserId":111},{"name":"Лёша","role":"seller","tgUserId":222,"isActive":false}]',
      }),
    );
    expect(env.STAFF_SEED_JSON).toEqual([
      { name: 'Максим', role: 'owner', tgUserId: 111, maxUserId: null, isActive: true },
      { name: 'Лёша', role: 'seller', tgUserId: 222, maxUserId: null, isActive: false },
    ]);
    expect(() => parseEnv(minimalEnvSource({ STAFF_SEED_JSON: '{oops' }))).toThrow(
      /STAFF_SEED_JSON/,
    );
    expect(() =>
      parseEnv(minimalEnvSource({ STAFF_SEED_JSON: '[{"name":"X","role":"boss","tgUserId":1}]' })),
    ).toThrow(/STAFF_SEED_JSON/);
    expect(() =>
      parseEnv(minimalEnvSource({ STAFF_SEED_JSON: '[{"name":"X","role":"seller"}]' })),
    ).toThrow(/tgUserId or maxUserId/);
  });
});

describe('.env.example', () => {
  const example = readEnvExample();

  it('declares every schema key', () => {
    const missing = ENV_KEYS.filter((key) => !(key in example));
    expect(missing).toEqual([]);
  });

  it('declares no unknown keys', () => {
    const known = new Set<string>(ENV_KEYS);
    const unknown = Object.keys(example).filter((key) => !known.has(key));
    expect(unknown).toEqual([]);
  });

  it('is itself a valid environment', () => {
    const env = parseEnv(example);
    expect(env.BRAND_NAME).toBe('Детали');
    expect(env.REMINDER_DAYS).toEqual([3, 6, 9]);
  });
});

describe('getEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
  });

  it('parses lazily and caches until reset', () => {
    Object.assign(process.env, minimalEnvSource({ BRAND_NAME: 'Первый' }));
    resetEnvCache();
    expect(getEnv().BRAND_NAME).toBe('Первый');
    process.env.BRAND_NAME = 'Второй';
    expect(getEnv().BRAND_NAME).toBe('Первый');
    resetEnvCache();
    expect(getEnv().BRAND_NAME).toBe('Второй');
  });
});
