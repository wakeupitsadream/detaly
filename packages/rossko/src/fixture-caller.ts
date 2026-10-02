/**
 * ROSSKO_MODE=fixtures transport: answers from `fixtures/<Method>[.<arg>].json` without network.
 *
 * - GetSearch: `<arg>` is the normalized `text`; unknown articles get GetSearch.NOTFOUND.json.
 * - GetCheckout: `<arg>` is the variant (`ok` by default, `itemErrors` on request).
 * - GetCheckoutDetails, GetOrders: no `<arg>`.
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
import searchEdge5w40 from '../fixtures/GetSearch.EDGE5W40.json' with { type: 'json' };
import searchGdb1330 from '../fixtures/GetSearch.GDB1330.json' with { type: 'json' };
import searchNotFound from '../fixtures/GetSearch.NOTFOUND.json' with { type: 'json' };
import searchOc90 from '../fixtures/GetSearch.OC90.json' with { type: 'json' };
import searchW9142 from '../fixtures/GetSearch.W9142.json' with { type: 'json' };
import { normalizeArticle } from './normalize';
import { isObject } from './raw';
import type { RosskoCaller, RosskoMethod } from './types';

/** Fixture file base names (without .json) mapped to their parsed content. */
export const BUNDLED_FIXTURES: Readonly<Record<string, unknown>> = {
  'GetCheckout.itemErrors': checkoutItemErrors,
  'GetCheckout.ok': checkoutOk,
  GetCheckoutDetails: checkoutDetails,
  GetOrders: orders,
  'GetSearch.EDGE5W40': searchEdge5w40,
  'GetSearch.GDB1330': searchGdb1330,
  'GetSearch.NOTFOUND': searchNotFound,
  'GetSearch.OC90': searchOc90,
  'GetSearch.W9142': searchW9142,
};

/** Stock ids that the synthetic fixtures treat as Orenburg (use in fixtures mode). */
export const FIXTURE_LOCAL_STOCK_IDS: readonly string[] = ['ORB1'];

export const NOT_FOUND_FIXTURE = 'GetSearch.NOTFOUND';

export type CheckoutFixtureVariant = 'ok' | 'itemErrors';

export interface FixtureCallerOptions {
  /** Read fixtures from this directory instead of the bundled set. */
  dir?: string;
  checkoutVariant?: CheckoutFixtureVariant;
}

/** Fixture base name for a call. */
export function fixtureName(
  method: RosskoMethod,
  args: Record<string, unknown>,
  checkoutVariant: CheckoutFixtureVariant = 'ok',
): string {
  switch (method) {
    case 'GetSearch': {
      const text = typeof args.text === 'string' ? normalizeArticle(args.text) : '';
      return text === '' ? NOT_FOUND_FIXTURE : `GetSearch.${text}`;
    }
    case 'GetCheckout':
      return `GetCheckout.${checkoutVariant}`;
    case 'GetCheckoutDetails':
    case 'GetOrders':
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

/**
 * `createFixtureCaller()` uses the bundled fixtures; `createFixtureCaller(dir)` or
 * `createFixtureCaller({dir})` reads `<dir>/<Method>[.<arg>].json`.
 */
export function createFixtureCaller(source?: string | FixtureCallerOptions): RosskoCaller {
  const options: FixtureCallerOptions =
    typeof source === 'string' ? { dir: source } : (source ?? {});
  const load = async (name: string): Promise<unknown> =>
    options.dir === undefined ? BUNDLED_FIXTURES[name] : readFixture(options.dir, name);

  return {
    lastRawResponse: null,
    async call(method, args) {
      const name = fixtureName(method, args, options.checkoutVariant);
      let fixture = await load(name);
      if (fixture === undefined && method === 'GetSearch') fixture = await load(NOT_FOUND_FIXTURE);
      if (fixture === undefined) {
        throw new Error(`Rossko fixture not found: ${name}.json`);
      }
      return stripMeta(fixture);
    },
  };
}
