import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  databaseUrl,
  ENV_KEYS,
  EnvError,
  getEnv,
  parseEnv,
  redisUrl,
  resetEnvCache,
} from '../src/env';
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
      SMS_PRICE_KOP: 500,
      GIT_SHA: 'dev',
    });
    expect(env.SELLER_REQUISITES_INN).toBeUndefined();
    expect(env.SMS_LOGIN).toBeUndefined();
    expect(env.SMS_API_URL).toBeUndefined();
  });

  it('reads the phase 1B SMS settings', () => {
    const env = parseEnv(
      minimalEnvSource({
        SMS_LOGIN: 'shop@example.org',
        SMS_API_URL: 'http://127.0.0.1:3299/v2',
        SMS_PRICE_KOP: '450',
      }),
    );
    expect(env).toMatchObject({
      SMS_LOGIN: 'shop@example.org',
      SMS_API_URL: 'http://127.0.0.1:3299/v2',
      SMS_PRICE_KOP: 450,
    });
    expect(() => parseEnv(minimalEnvSource({ SMS_API_URL: 'not a url' }))).toThrow(EnvError);
    expect(() => parseEnv(minimalEnvSource({ SMS_PRICE_KOP: '-1' }))).toThrow(EnvError);
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

  it('runs DEMO_MODE without a database and Redis', () => {
    const source = { SESSION_SECRET: 'test-session-secret-0123456789abcdef', DEMO_MODE: 'true' };
    const env = parseEnv(source);
    expect(env.DEMO_MODE).toBe(true);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(() => databaseUrl(env)).toThrow(/DATABASE_URL/);
    expect(() => redisUrl(env)).toThrow(/REDIS_URL/);
    expect(parseEnv(minimalEnvSource()).DEMO_MODE).toBe(false);
    expect(databaseUrl(parseEnv(minimalEnvSource()))).toMatch(/^postgres:/);
    expect(redisUrl(parseEnv(minimalEnvSource()))).toMatch(/^redis:/);
    // SESSION_SECRET stays required in the demo (cart cookie signature, rate-limit buckets).
    expect(() => parseEnv({ DEMO_MODE: 'true' })).toThrow(/SESSION_SECRET/);
  });

  it('takes the demo address from Vercel when APP_BASE_URL is not set', () => {
    const demo = { SESSION_SECRET: 'test-session-secret-0123456789abcdef', DEMO_MODE: 'true' };
    const vercel = {
      VERCEL_URL: 'detaly-git-x-team.vercel.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'detaly-demo.vercel.app',
    };
    expect(parseEnv({ ...demo, ...vercel, VERCEL_ENV: 'production' }).APP_BASE_URL).toBe(
      'https://detaly-demo.vercel.app',
    );
    expect(parseEnv({ ...demo, ...vercel, VERCEL_ENV: 'preview' }).APP_BASE_URL).toBe(
      'https://detaly-git-x-team.vercel.app',
    );
    // An explicit APP_BASE_URL wins, and outside the demo Vercel's variables are ignored.
    expect(
      parseEnv({ ...demo, ...vercel, APP_BASE_URL: 'https://demo.example.ru' }).APP_BASE_URL,
    ).toBe('https://demo.example.ru');
    expect(parseEnv(minimalEnvSource(vercel)).APP_BASE_URL).toBe('http://localhost:3000');
    expect(parseEnv(demo).APP_BASE_URL).toBe('http://localhost:3000');
  });

  it('takes GIT_SHA from the Vercel build commit when GIT_SHA is not set', () => {
    const sha = '0F1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';
    expect(parseEnv(minimalEnvSource({ VERCEL_GIT_COMMIT_SHA: sha })).GIT_SHA).toBe('0f1e2d3');
    // An explicit GIT_SHA wins (production sets it in infra/deploy.sh).
    expect(
      parseEnv(minimalEnvSource({ VERCEL_GIT_COMMIT_SHA: sha, GIT_SHA: 'v1.2.3' })).GIT_SHA,
    ).toBe('v1.2.3');
    expect(parseEnv(minimalEnvSource({ VERCEL_GIT_COMMIT_SHA: 'not a sha' })).GIT_SHA).toBe('dev');
    expect(parseEnv(minimalEnvSource()).GIT_SHA).toBe('dev');
  });

  it('requires DATABASE_URL and REDIS_URL outside DEMO_MODE', () => {
    const secret = { SESSION_SECRET: 'test-session-secret-0123456789abcdef' };
    expect(() => parseEnv(secret)).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ ...secret, DEMO_MODE: 'false' })).toThrow(/REDIS_URL/);
  });

  it('keeps DEMO_MODE on fixtures and without YooKassa', () => {
    const demo = (extra: Record<string, string>) =>
      parseEnv(minimalEnvSource({ DEMO_MODE: 'true', ...extra }));
    expect(() => demo({ ROSSKO_MODE: 'live', ROSSKO_KEY1: 'k1', ROSSKO_KEY2: 'k2' })).toThrow(
      /ROSSKO_MODE/,
    );
    expect(() => demo({ YOOKASSA_SHOP_ID: '123' })).toThrow(/YOOKASSA_SHOP_ID/);
    expect(() => demo({ YOOKASSA_SECRET_KEY: 'live_x' })).toThrow(/YOOKASSA_SECRET_KEY/);
    expect(() => demo({ YOOKASSA_WEBHOOK_IP_ALLOWLIST: '185.71.76.0/27' })).toThrow(
      /YOOKASSA_WEBHOOK_IP_ALLOWLIST/,
    );
    // The API URL has a default and is harmless without credentials.
    expect(demo({}).YOOKASSA_API_URL).toBe('https://api.yookassa.ru/v3');
  });

  it('phase 1C: photo storage and the installation partner', () => {
    expect(parseEnv(minimalEnvSource())).toMatchObject({
      FILES_STORAGE: 'none',
      FILES_LOCAL_DIR: 'var/files',
      FILES_S3_PREFIX: 'files/',
      FILES_MAX_UPLOAD_MB: 8,
    });
    const env = parseEnv(minimalEnvSource());
    expect(env.FILES_S3_BUCKET).toBeUndefined();
    expect(env.INSTALL_PARTNER_NAME).toBeUndefined();
    expect(env.INSTALL_PARTNER_REQUISITES).toBeUndefined();
    expect(
      parseEnv(
        minimalEnvSource({
          FILES_STORAGE: 'local',
          FILES_LOCAL_DIR: '/tmp/files',
          FILES_MAX_UPLOAD_MB: '12',
          INSTALL_PARTNER_NAME: 'Сервис56',
          INSTALL_PARTNER_REQUISITES: 'ИП Тестов Т. Т., ИНН 561234567890',
        }),
      ),
    ).toMatchObject({
      FILES_STORAGE: 'local',
      FILES_LOCAL_DIR: '/tmp/files',
      FILES_MAX_UPLOAD_MB: 12,
      INSTALL_PARTNER_NAME: 'Сервис56',
    });
    expect(() => parseEnv(minimalEnvSource({ FILES_STORAGE: 'ftp' }))).toThrow(/FILES_STORAGE/);
    expect(() => parseEnv(minimalEnvSource({ FILES_MAX_UPLOAD_MB: '13' }))).toThrow(
      /FILES_MAX_UPLOAD_MB/,
    );
    expect(() => parseEnv(minimalEnvSource({ FILES_MAX_UPLOAD_MB: '0' }))).toThrow(
      /FILES_MAX_UPLOAD_MB/,
    );
  });

  it('FILES_STORAGE=s3 needs the S3 credentials and a bucket', () => {
    const s3 = {
      FILES_STORAGE: 's3',
      S3_ENDPOINT: 'https://s3.example.ru',
      S3_KEY: 'key',
      S3_SECRET: 'secret',
    };
    let issues: readonly string[] = [];
    try {
      parseEnv(minimalEnvSource({ FILES_STORAGE: 's3' }));
    } catch (error) {
      issues = (error as EnvError).issues;
    }
    expect(issues).toEqual([
      'S3_ENDPOINT: required when FILES_STORAGE=s3',
      'S3_KEY: required when FILES_STORAGE=s3',
      'S3_SECRET: required when FILES_STORAGE=s3',
      'FILES_S3_BUCKET: FILES_S3_BUCKET or S3_BUCKET is required when FILES_STORAGE=s3',
    ]);
    expect(() => parseEnv(minimalEnvSource(s3))).toThrow(/FILES_S3_BUCKET/);
    expect(parseEnv(minimalEnvSource({ ...s3, S3_BUCKET: 'backups' })).FILES_STORAGE).toBe('s3');
    expect(parseEnv(minimalEnvSource({ ...s3, FILES_S3_BUCKET: 'photos' })).FILES_S3_BUCKET).toBe(
      'photos',
    );
  });

  it('keeps DEMO_MODE without file storage', () => {
    const demo = (extra: Record<string, string>) =>
      parseEnv(minimalEnvSource({ DEMO_MODE: 'true', ...extra }));
    expect(demo({}).FILES_STORAGE).toBe('none');
    expect(() => demo({ FILES_STORAGE: 'local' })).toThrow(/FILES_STORAGE: must be none/);
  });

  it('strips an "ИП" prefix from SELLER_REQUISITES_NAME', () => {
    const name = (value: string) =>
      parseEnv(minimalEnvSource({ SELLER_REQUISITES_NAME: value })).SELLER_REQUISITES_NAME;
    expect(name('Иванов Иван Иванович')).toBe('Иванов Иван Иванович');
    expect(name('ИП Иванов И. И.')).toBe('Иванов И. И.');
    expect(name('  ип. Иванов И. И. ')).toBe('Иванов И. И.');
    expect(name('Индивидуальный предприниматель Иванов И. И.')).toBe('Иванов И. И.');
    expect(name('Ипатов Пётр')).toBe('Ипатов Пётр');
    expect(name('')).toBeUndefined();
    expect(() => parseEnv(minimalEnvSource({ SELLER_REQUISITES_NAME: 'ИП ' }))).toThrow(EnvError);
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

describe('review links (step 3, docs/reviews.md)', () => {
  it('REVIEW_URL_YANDEX and REVIEW_URL_2GIS are optional https links', () => {
    const none = parseEnv(minimalEnvSource());
    expect(none.REVIEW_URL_YANDEX).toBeUndefined();
    expect(none.REVIEW_URL_2GIS).toBeUndefined();
    const env = parseEnv(
      minimalEnvSource({
        REVIEW_URL_YANDEX: 'https://yandex.ru/maps/org/test/1/reviews/',
        REVIEW_URL_2GIS: 'https://2gis.ru/orenburg/firm/1',
      }),
    );
    expect(env.REVIEW_URL_YANDEX).toBe('https://yandex.ru/maps/org/test/1/reviews/');
    expect(env.REVIEW_URL_2GIS).toBe('https://2gis.ru/orenburg/firm/1');
    // An empty line in .env is «not set».
    expect(parseEnv(minimalEnvSource({ REVIEW_URL_2GIS: '' })).REVIEW_URL_2GIS).toBeUndefined();
  });

  it('refuses anything but https', () => {
    for (const [key, value] of [
      ['REVIEW_URL_YANDEX', 'http://yandex.ru/maps/org/test/1/reviews/'],
      ['REVIEW_URL_2GIS', 'javascript:alert(1)'],
      ['REVIEW_URL_2GIS', '2gis.ru/orenburg/firm/1'],
    ] as const) {
      expect(() => parseEnv(minimalEnvSource({ [key]: value })), value).toThrow(new RegExp(key));
    }
  });
});

describe('fit guarantee (step 4, docs/fit-check.md)', () => {
  it('FIT_GUARANTEE_ENABLED is off unless set to true', () => {
    expect(parseEnv(minimalEnvSource()).FIT_GUARANTEE_ENABLED).toBe(false);
    expect(parseEnv(minimalEnvSource({ FIT_GUARANTEE_ENABLED: '' })).FIT_GUARANTEE_ENABLED).toBe(
      false,
    );
    expect(
      parseEnv(minimalEnvSource({ FIT_GUARANTEE_ENABLED: 'true' })).FIT_GUARANTEE_ENABLED,
    ).toBe(true);
    expect(
      parseEnv(minimalEnvSource({ FIT_GUARANTEE_ENABLED: 'false' })).FIT_GUARANTEE_ENABLED,
    ).toBe(false);
    expect(() => parseEnv(minimalEnvSource({ FIT_GUARANTEE_ENABLED: 'maybe' }))).toThrow(
      /FIT_GUARANTEE_ENABLED/,
    );
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
