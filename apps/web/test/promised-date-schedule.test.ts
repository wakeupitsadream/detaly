// The promised pickup date skips the days the pickup point is closed (PICKUP_HOURS), and every
// place that shows it reads the schedule from the same settings: the storefront row
// (buildOfferViews), the cart and checkout (promiseFor), the order (resolveOrderSettings, the
// engine and the worker read it) and the VIN preview in the seller bot (vinLinePromisedDate).
import { parseEnv } from '@detaly/config';
import { minimalEnvSource } from '@detaly/config/testing';
import { buildOfferViews, formatPromise, promisedDate, type Offer } from '@detaly/domain';
import { resolveOrderSettings } from '@detaly/orders';
import { vinLinePromisedDate } from '@detaly/vin';
import { describe, expect, it } from 'vitest';
import { promiseFor } from '@/server/cart/summary';
import { resolveSearchSettings } from '@/server/settings';

const offer = (deliveryDays: number): Offer => ({
  source: 'rossko',
  brand: 'Knecht',
  article: 'OC 90',
  articleNorm: 'OC90',
  name: 'Фильтр масляный',
  group: null,
  isCross: false,
  priceSupplierKop: 50_000,
  stock: {
    stockId: 'EKB2',
    isLocal: false,
    count: 24,
    multiplicity: 1,
    type: null,
    deliveryDays,
    deliveryStart: null,
    deliveryEnd: null,
    extra: null,
    description: null,
  },
});

// Thursday 8 October, 02:04 in Orenburg (the audit's case): +2 days + 1 buffer = Sunday 11.
const NOW = new Date('2026-10-07T21:04:00Z');

function everywhere(hours: string | undefined) {
  const env = parseEnv(minimalEnvSource({ PICKUP_HOURS: hours, ETA_BUFFER_DAYS: '1' }));
  const web = resolveSearchSettings(new Map(), env, []);
  const order = resolveOrderSettings(new Map(), env);
  const [view] = buildOfferViews([offer(2)], {
    pricing: web.pricing,
    excludedRules: [],
    eta: web.eta,
    now: NOW,
  });
  const etaDate = view?.etaDate ?? '';
  return {
    search: view?.promiseText,
    cart: promiseFor([etaDate], web),
    order: formatPromise(promisedDate([etaDate], order.eta)),
    bot: formatPromise(vinLinePromisedDate({ etaDate }, order.eta)),
  };
}

describe('promised date by the pickup point schedule', () => {
  it('moves Sunday to Monday when the point works Mon–Fri, the same everywhere', () => {
    const shown = everywhere('Пн–Пт 10:00–19:00');
    expect(new Set(Object.values(shown))).toEqual(new Set(['к пн 12 октября']));
  });

  it('keeps Sunday when the point works every day', () => {
    const shown = everywhere('Ежедневно 9–21');
    expect(new Set(Object.values(shown))).toEqual(new Set(['к вс 11 октября']));
  });

  it('does not move the date when PICKUP_HOURS is not set or not understood', () => {
    expect(new Set(Object.values(everywhere(undefined)))).toEqual(new Set(['к вс 11 октября']));
    expect(new Set(Object.values(everywhere('по звонку')))).toEqual(new Set(['к вс 11 октября']));
  });
});
