/**
 * ROSSKO_MODE=fixtures transport: answers from `fixtures/<Method>[.<arg>].json` without network.
 *
 * - GetSearch: `<arg>` is the normalized `text`; unknown articles get GetSearch.NOTFOUND.json.
 *   `priceFactorBp` scales every stock price (10100 = +1%, 11000 = +10%) to test the recheck.
 * - GetCheckout: `<arg>` is the variant (`ok` by default, `itemErrors` on request). The
 *   `timeout` variant answers nothing: it records the order as executed by Rossko and throws a
 *   timeout RosskoCallError, so the recovery by comment can find it (decision Б14);
 *   `timeoutNotExecuted` throws the same error without recording anything.
 * - GetOrders: with `order_ids` -> GetOrders.json; without (list mode, recentOrders) ->
 *   GetOrders.recent.json plus the orders recorded by the `timeout` variant, or
 *   GetOrders.unsupported.json with `ordersList: 'unsupported'`. A directory without the
 *   variant file falls back to GetOrders.json.
 * - GetCheckoutDetails: no `<arg>`.
 *
 * The `_meta` block of a fixture is stripped. With no directory the fixtures bundled into the
 * package are used (static JSON imports, so Next/standalone builds need no file tracing);
 * with a directory they are read from disk (e.g. responses recorded by rossko-smoke).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import checkoutItemErrors from '../fixtures/GetCheckout.itemErrors.json' with { type: 'json' };
import checkoutOk from '../fixtures/GetCheckout.ok.json' with { type: 'json' };
import checkoutDetails from '../fixtures/GetCheckoutDetails.json' with { type: 'json' };
import orders from '../fixtures/GetOrders.json' with { type: 'json' };
import ordersRecent from '../fixtures/GetOrders.recent.json' with { type: 'json' };
import ordersUnsupported from '../fixtures/GetOrders.unsupported.json' with { type: 'json' };
import searchBkr6e from '../fixtures/GetSearch.BKR6E.json' with { type: 'json' };
import searchC26003 from '../fixtures/GetSearch.C26003.json' with { type: 'json' };
import searchCu1919 from '../fixtures/GetSearch.CU1919.json' with { type: 'json' };
import searchEdge5w40 from '../fixtures/GetSearch.EDGE5W40.json' with { type: 'json' };
import searchFr7dcx from '../fixtures/GetSearch.FR7DCX.json' with { type: 'json' };
import searchGdb1330 from '../fixtures/GetSearch.GDB1330.json' with { type: 'json' };
import searchLx2046 from '../fixtures/GetSearch.LX2046.json' with { type: 'json' };
import searchNotFound from '../fixtures/GetSearch.NOTFOUND.json' with { type: 'json' };
import searchOc90 from '../fixtures/GetSearch.OC90.json' with { type: 'json' };
import searchW9142 from '../fixtures/GetSearch.W9142.json' with { type: 'json' };
import { RosskoCallError } from './errors';
import { normalizeArticle, rubToKop } from './normalize';
import { field, isObject, listOf, toArray, unwrapResult, type RawObject } from './raw';
import type { RosskoCaller, RosskoMethod } from './types';

/** Fixture file base names (without .json) mapped to their parsed content. */
export const BUNDLED_FIXTURES: Readonly<Record<string, unknown>> = {
  'GetCheckout.itemErrors': checkoutItemErrors,
  'GetCheckout.ok': checkoutOk,
  GetCheckoutDetails: checkoutDetails,
  GetOrders: orders,
  'GetOrders.recent': ordersRecent,
  'GetOrders.unsupported': ordersUnsupported,
  'GetSearch.EDGE5W40': searchEdge5w40,
  'GetSearch.GDB1330': searchGdb1330,
  'GetSearch.NOTFOUND': searchNotFound,
  'GetSearch.OC90': searchOc90,
  'GetSearch.W9142': searchW9142,
  // step 5 (docs/kits.md): parts of the two sample kits of the demo (filters, spark plugs)
  'GetSearch.BKR6E': searchBkr6e,
  'GetSearch.C26003': searchC26003,
  'GetSearch.CU1919': searchCu1919,
  'GetSearch.FR7DCX': searchFr7dcx,
  'GetSearch.LX2046': searchLx2046,
};

/** Stock ids that the synthetic fixtures treat as Orenburg (use in fixtures mode). */
export const FIXTURE_LOCAL_STOCK_IDS: readonly string[] = ['ORB1'];

export const NOT_FOUND_FIXTURE = 'GetSearch.NOTFOUND';

export type CheckoutFixtureVariant = 'ok' | 'itemErrors' | 'timeout' | 'timeoutNotExecuted';

/** GetOrders without order_ids: the recent list, or a refusal of the list mode. */
export type OrdersListFixtureVariant = 'recent' | 'unsupported';

export interface FixtureCallerOptions {
  /** Read fixtures from this directory instead of the bundled set. */
  dir?: string;
  checkoutVariant?: CheckoutFixtureVariant;
  ordersList?: OrdersListFixtureVariant;
  /**
   * GetSearch price factor in basis points of the original price: 10000 = as recorded,
   * 10100 = +1%, 11000 = +10%. Prices are scaled in kopecks and rounded half up. Allowed range
   * 5000..50000, so that a delta passed by mistake (100 for +1%) fails loudly.
   */
  priceFactorBp?: number;
  /** Clock for orders recorded by the `timeout` variant. Default: wall clock. */
  now?: () => Date;
}

/** Message of the simulated GetCheckout timeout (what node-soap reports for an axios timeout). */
export const FIXTURE_TIMEOUT_MESSAGE = 'timeout of 30000ms exceeded';

const TIMEOUT_VARIANTS: ReadonlySet<CheckoutFixtureVariant> = new Set([
  'timeout',
  'timeoutNotExecuted',
]);

/** First id of orders recorded by the `timeout` variant. */
const RECORDED_ORDER_BASE_ID = 79_000_001;

/** Fixture base name for a call. */
export function fixtureName(
  method: RosskoMethod,
  args: Record<string, unknown>,
  checkoutVariant: CheckoutFixtureVariant = 'ok',
  ordersList: OrdersListFixtureVariant = 'recent',
): string {
  switch (method) {
    case 'GetSearch': {
      const text = typeof args.text === 'string' ? normalizeArticle(args.text) : '';
      return text === '' ? NOT_FOUND_FIXTURE : `GetSearch.${text}`;
    }
    case 'GetCheckout':
      return `GetCheckout.${checkoutVariant}`;
    case 'GetOrders':
      return Object.hasOwn(args, 'order_ids') ? method : `GetOrders.${ordersList}`;
    case 'GetCheckoutDetails':
      return method;
  }
}

/** Removes `_meta` and returns a deep copy, so callers cannot mutate the bundled fixtures. */
export function stripMeta(fixture: unknown): unknown {
  if (!isObject(fixture)) return structuredClone(fixture);
  const { _meta: _ignored, ...rest } = fixture;
  return structuredClone(rest);
}

async function readFixture(dir: string, name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function validateFactor(factorBp: number | undefined): number {
  if (factorBp === undefined) return 10_000;
  if (!Number.isSafeInteger(factorBp) || factorBp < 5_000 || factorBp > 50_000) {
    throw new RangeError(
      `priceFactorBp must be an integer factor 5000..50000 (10100 = +1%), got ${String(factorBp)}`,
    );
  }
  return factorBp;
}

function kopToRub(kop: number): string {
  return `${Math.floor(kop / 100)}.${String(kop % 100).padStart(2, '0')}`;
}

/** Scales the `price` of every stock of every part and cross in place (bad prices stay). */
function scaleSearchPrices(raw: unknown, factorBp: number): void {
  const result = unwrapResult(raw);
  if (result === null) return;
  const scalePart = (part: unknown): void => {
    if (!isObject(part)) return;
    for (const stock of listOf(field(part, 'stocks'), ['stock'])) {
      if (!isObject(stock)) continue;
      const key = Object.keys(stock).find((k) => k.toLowerCase() === 'price');
      const value = key === undefined ? undefined : stock[key];
      if (key === undefined || (typeof value !== 'string' && typeof value !== 'number')) continue;
      let kop: number;
      try {
        kop = rubToKop(value);
      } catch {
        continue;
      }
      if (kop <= 0) continue;
      stock[key] = kopToRub(Math.floor((kop * factorBp + 5_000) / 10_000));
    }
    for (const cross of listOf(field(part, 'crosses'), ['Part'])) scalePart(cross);
  };
  for (const part of listOf(field(result, 'PartsList'), ['Part'])) scalePart(part);
}

/** A GetOrders entry for a GetCheckout that "executed" before the simulated timeout. */
function recordedOrder(id: string, args: Record<string, unknown>, created: Date): RawObject {
  const parts = listOf(field(args, 'PARTS'), ['Part'])
    .filter(isObject)
    .map((part) => ({
      brand: field(part, 'brand'),
      partnumber: field(part, 'partnumber'),
      stock: field(part, 'stock'),
      count: field(part, 'count'),
      status: 1,
    }));
  const comment = field(args, 'comment');
  return {
    id,
    created: created.toISOString(),
    status: 1,
    status_name: 'В работе',
    ...(typeof comment === 'string' ? { comment } : {}),
    parts: { part: parts },
  };
}

/** Appends recorded orders to a GetOrders list answer (newest first). */
function withRecordedOrders(raw: unknown, recorded: readonly RawObject[]): unknown {
  const result = unwrapResult(raw);
  if (result === null || recorded.length === 0) return raw;
  const list = isObject(result.OrdersList) ? result.OrdersList : {};
  list.Order = [...[...recorded].reverse(), ...toArray(list.Order)];
  result.OrdersList = list;
  return raw;
}

/**
 * `createFixtureCaller()` uses the bundled fixtures; `createFixtureCaller(dir)` or
 * `createFixtureCaller({dir})` reads `<dir>/<Method>[.<arg>].json`.
 */
export function createFixtureCaller(source?: string | FixtureCallerOptions): RosskoCaller {
  const options: FixtureCallerOptions =
    typeof source === 'string' ? { dir: source } : (source ?? {});
  const factorBp = validateFactor(options.priceFactorBp);
  const now = options.now ?? (() => new Date());
  const load = async (name: string): Promise<unknown> =>
    options.dir === undefined ? BUNDLED_FIXTURES[name] : readFixture(options.dir, name);
  /** Orders "created" by timed-out GetCheckout calls of this caller. */
  const recorded: RawObject[] = [];

  return {
    lastRawResponse: null,
    async call(method, args) {
      const variant = options.checkoutVariant;
      if (method === 'GetCheckout' && variant !== undefined && TIMEOUT_VARIANTS.has(variant)) {
        if (variant === 'timeout') {
          const id = String(RECORDED_ORDER_BASE_ID + recorded.length);
          recorded.push(recordedOrder(id, args, now()));
        }
        throw new RosskoCallError('GetCheckout', FIXTURE_TIMEOUT_MESSAGE, {
          timeout: true,
          code: 'ECONNABORTED',
        });
      }
      let name = fixtureName(method, args, options.checkoutVariant, options.ordersList);
      let fixture = await load(name);
      if (fixture === undefined && method === 'GetSearch') fixture = await load(NOT_FOUND_FIXTURE);
      if (fixture === undefined && method === 'GetOrders' && name !== method) {
        name = method;
        fixture = await load(name);
      }
      if (fixture === undefined) {
        throw new Error(`Rossko fixture not found: ${name}.json`);
      }
      const raw = stripMeta(fixture);
      if (method === 'GetSearch' && factorBp !== 10_000) scaleSearchPrices(raw, factorBp);
      if (name === 'GetOrders.recent') return withRecordedOrders(raw, recorded);
      return raw;
    },
  };
}
