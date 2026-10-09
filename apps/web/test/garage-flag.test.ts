// Step 6 (docs/garage.md): GARAGE_ENABLED wires the kit memory of «Весь набор в корзину» only when
// on and never in the demo (no database there); the checkout input reads `vehicle` only with the
// switch. Unit level: env and mode are mocked.
import { parseEnv, type Env } from '@detaly/config';
import { minimalEnvSource } from '@detaly/config/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartService } from '@/server/cart/cart-service';

const state = vi.hoisted(() => ({ env: null as unknown, demo: false }));

vi.mock('@/server/env', () => ({ serverEnv: () => state.env }));
vi.mock('@/server/mode', () => ({ isDemoMode: () => state.demo }));
vi.mock('@/server/logger', () => ({
  getLogger: () => ({ warn: () => undefined, error: () => undefined, info: () => undefined }),
}));

const { kitAddDeps } = await import('@/server/kits');
const { parseCheckoutInput } = await import('@/server/checkout/input');
const { CAR_MAKES } = await import('@/lib/brands');

function env(overrides: Record<string, string | undefined> = {}): Env {
  return parseEnv(minimalEnvSource(overrides));
}

beforeEach(() => {
  state.env = env();
  state.demo = false;
});

const service = {} as CartService;

describe('the kit of a cart is remembered only with GARAGE_ENABLED', () => {
  it('off by default: no rememberKit', () => {
    expect(kitAddDeps(service, env()).rememberKit).toBeUndefined();
  });

  it('on: rememberKit is wired', () => {
    state.env = env({ GARAGE_ENABLED: 'true' });
    expect(typeof kitAddDeps(service, env()).rememberKit).toBe('function');
  });

  it('never in the demo, even switched on', () => {
    state.env = env({
      GARAGE_ENABLED: 'true',
      DEMO_MODE: 'true',
      DATABASE_URL: undefined,
      REDIS_URL: undefined,
    });
    state.demo = true;
    expect(kitAddDeps(service, env()).rememberKit).toBeUndefined();
  });
});

describe('the checkout input reads `vehicle` only with the switch', () => {
  const body = {
    part: 'all',
    phone: '8 912 345-67-89',
    name: 'Иван',
    channel: 'sms',
    acceptOffer: true,
    consentPd: true,
    expectedTotalKop: 1000,
    itemsHash: 'a'.repeat(64),
    checkoutKey: '01890000-0000-7000-8000-000000000001',
    offerVersionId: '01890000-0000-7000-8000-000000000002',
    consentPdVersionId: '01890000-0000-7000-8000-000000000003',
    consentMarketingVersionId: null,
    expectedScheme: 'prepay',
    expectedPromisedDate: null,
    vehicle: { make: 'Лада', model: 'Веста', vin: 'XTA2109904345678O' },
  };

  it('off: the key is dropped like any unknown field, even an invalid car', () => {
    const result = parseCheckoutInput(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input).not.toHaveProperty('vehicle');
  });

  it('on: the car is checked (here: the VIN) and normalised', () => {
    const garage = { makes: CAR_MAKES, today: '2026-10-09' };
    expect(parseCheckoutInput(body, { garage })).toMatchObject({
      ok: false,
      status: 422,
      error: 'validation',
      fields: { vehicleVin: expect.stringContaining('O, I и Q') },
    });
    const ok = parseCheckoutInput(
      { ...body, vehicle: { ...body.vehicle, vin: 'xta21099043456789' } },
      { garage },
    );
    expect(ok.ok && ok.input.vehicle).toMatchObject({
      makeSlug: 'lada',
      make: 'Lada',
      model: 'Веста',
      vin: 'XTA21099043456789',
    });
    const blank = parseCheckoutInput({ ...body, vehicle: { make: '' } }, { garage });
    expect(blank.ok && blank.input.vehicle).toBeNull();
  });
});
