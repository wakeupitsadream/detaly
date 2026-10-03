// /vin with the process env (decision С12): the form only with the checkout gate open (RKN
// number, documents in the test database, pickup point); a closed gate keeps the phase 1B page
// without any PD field. `?e=` codes of a post without JavaScript come back as field messages.
import { resetEnvCache } from '@detaly/config';
import { testRedisUrl } from '@detaly/config/testing';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as Navigation from 'next/navigation';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetSingleton } from '@/server/globals';
import { VIN_FORM_MESSAGES } from '@/server/vin/form';
import { webDatabaseUrl } from './helpers';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const saved = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>): void {
  process.env = {
    ...saved,
    DATABASE_URL: webDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    ROSSKO_MODE: 'fixtures',
    LOG_LEVEL: 'silent',
    APP_BASE_URL: 'http://127.0.0.1:3100',
    PICKUP_ADDRESS: 'г. Оренбург, ул. Тестовая, 1',
    PICKUP_HOURS: 'Пн–Пт 10:00–19:00',
    PICKUP_PHONE: '+7 900 000-00-01',
    DEMO_MODE: 'false',
    ...overrides,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
  resetEnvCache();
  // The photo store follows FILES_STORAGE of the current env.
  resetSingleton('file-store');
}

async function render(params: Record<string, string> = {}): Promise<string> {
  const { default: VinPage } = await import('@/app/(site)/vin/page');
  const element = await VinPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element);
}

beforeAll(() => {
  setEnv({});
});

afterAll(() => {
  process.env = { ...saved };
  resetEnvCache();
});

describe('/vin page', () => {
  it('without the RKN notice number: no form and no PD field, the phone instead', async () => {
    setEnv({ RKN_NOTICE_NUMBER: undefined });
    const html = await render();
    expect(html).not.toContain('data-testid="vin-form"');
    expect(html).not.toContain('name="phone"');
    expect(html).toContain('data-testid="vin-phone"');
    expect(html).toContain('Так выглядит VIN');
  });

  it('with the gate open: the form with VIN hint, consent link, honeypot and MAX as «скоро»', async () => {
    setEnv({ RKN_NOTICE_NUMBER: 'TEST-1', TG_CLIENT_BOT_USERNAME: 'detaly_test_bot' });
    const html = await render();
    expect(html).toContain('data-testid="vin-form"');
    expect(html).toContain('action="/api/vin"');
    expect(html.toLowerCase()).toContain('enctype="multipart/form-data"');
    expect(html).toContain('name="consentPd"');
    expect(html).toContain('href="/docs/consent"');
    expect(html).toContain('name="website"');
    expect(html).toMatch(/name="requestKey" value="[0-9a-f-]{36}"/);
    expect(html).toContain('Букв O, I и Q в VIN не бывает');
    expect(html).toMatch(/<input type="radio" disabled=""[^>]*value="max"/);
    expect(html).not.toMatch(/<input type="radio" disabled=""[^>]*value="telegram"/);
    // FILES_STORAGE=none: no photo field.
    expect(html).not.toContain('type="file"');
    // The VinPlate and the steps stay.
    expect(html).toContain('Так выглядит VIN');
  });

  it('photo storage on: the photo field; `?e=` codes become field messages', async () => {
    setEnv({ RKN_NOTICE_NUMBER: 'TEST-1', FILES_STORAGE: 'local', FILES_LOCAL_DIR: '/tmp' });
    const html = await render({ e: 'vin_oiq,consent,bogus' });
    expect(html).toContain('type="file"');
    expect(html).toContain(VIN_FORM_MESSAGES.vin_oiq);
    expect(html).toContain(VIN_FORM_MESSAGES.consent);
  });
});
