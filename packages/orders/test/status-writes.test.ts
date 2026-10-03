// Acceptance criterion 2 of phase 1B (docs/phase-1b-implementation.md section 19): orders.status
// changes only through applyTransition / persistTransition of @detaly/orders. This test greps the
// production sources of the monorepo: an update of the orders table (Drizzle or raw SQL) is
// allowed only in packages/orders/src/engine.ts, and an insert of an order row only with the
// status 'draft' (checkout inserts a draft and hands it to persistTransition).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_DIRS = ['apps/web/src', 'apps/worker/src', 'packages', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'test', 'e2e', 'fixtures', 'drizzle']);
const ENGINE = 'packages/orders/src/engine.ts';
/**
 * Order columns another package may set outside the engine: links that never drive the state
 * machine. `vin_request_id` is set by markVinConverted (@detaly/vin) in the checkout transaction.
 */
const NON_LIFECYCLE_COLUMNS = new Set(['vinRequestId']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, dir);
  for (const name of readdirSync(abs)) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = path.join(dir, name);
    const stat = statSync(path.join(ROOT, rel));
    if (stat.isDirectory()) sourceFiles(rel, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.tsx?$|\.spec\.tsx?$/.test(name)) {
      out.push(rel.split(path.sep).join('/'));
    }
  }
  return out;
}

/** Drizzle `.update(orders)` / `.update(schema.orders)` and raw `update orders` / `update "orders"`. */
const ORDER_UPDATE = /\.update\(\s*(?:\w+\.)?orders\s*\)|\bupdate\s+"?orders"?\s+set\b/i;
const ORDER_INSERT = /\.insert\(\s*(?:\w+\.)?orders\s*\)/;
const RAW_STATUS_INSERT = /insert\s+into\s+"?orders"?/i;

describe('orders.status is written only by @detaly/orders', () => {
  const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(dir));

  it('finds the sources it guards', () => {
    expect(files).toContain(ENGINE);
    expect(files).toContain('apps/web/src/server/checkout/checkout-service.ts');
    expect(files.length).toBeGreaterThan(100);
  });

  it('updates the orders table only in the engine', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === ENGINE) continue;
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      for (const match of text.matchAll(new RegExp(ORDER_UPDATE.source, 'gi'))) {
        // Outside the engine only a Drizzle update whose `.set({...})` touches link columns that
        // carry no lifecycle (NON_LIFECYCLE_COLUMNS) is allowed, e.g. the VIN checkout hook.
        const window = text.slice(match.index, match.index + 400);
        const set = /^\.update\([^)]*\)\s*\.set\(\{([^}]*)\}\)/.exec(window);
        const keys = set ? [...set[1]!.matchAll(/(\w+)\s*:/g)].map((m) => m[1]!) : [];
        const allowed = keys.length > 0 && keys.every((key) => NON_LIFECYCLE_COLUMNS.has(key));
        if (!allowed) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('inserts orders only as drafts (the engine moves them on) and never by raw SQL', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      if (RAW_STATUS_INSERT.test(text)) offenders.push(`${file}: raw insert`);
      const match = ORDER_INSERT.exec(text);
      if (!match) continue;
      // the values object of the insert must carry status 'draft'
      const window = text.slice(match.index, match.index + 1500);
      const status = /\bstatus:\s*'([a-z_]+)'/.exec(window);
      if (status?.[1] !== 'draft')
        offenders.push(`${file}: insert with ${status?.[1] ?? 'no'} status`);
    }
    expect(offenders).toEqual([]);
  });

  it('the engine locks the order row before deciding', () => {
    const snapshot = readFileSync(path.join(ROOT, 'packages/orders/src/snapshot.ts'), 'utf8');
    expect(snapshot).toMatch(/\.for\('update'\)/);
  });
});
