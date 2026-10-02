/**
 * Brand and requisites come only from env (PLAN, cross-cutting decision 13): the source must
 * not contain the brand name or anything that looks like a seller INN/OGRNIP.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webDir, '..', '..');

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return /\.(tsx?|css|mjs|json)$/.test(entry.name) ? [full] : [];
  });
}

/** BRAND_NAME and SELLER_* values from the committed .env.example (the brand default). */
function exampleValues(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path.join(repoRoot, '.env.example'), 'utf8').split('\n')) {
    const match =
      /^(BRAND_NAME|SELLER_REQUISITES_\w+|PICKUP_(?:POINT_NAME|ADDRESS|HOURS|PHONE))=(.*)$/.exec(
        line.trim(),
      );
    if (match && match[2]) values[match[1] as string] = match[2].trim();
  }
  return values;
}

const sources = [
  ...listFiles(path.join(webDir, 'src')),
  ...listFiles(path.join(webDir, 'scripts')),
];

describe('no hard-coded brand or requisites in apps/web', () => {
  it('scans a non-empty source tree', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it('does not contain the brand name', () => {
    const brand = exampleValues().BRAND_NAME;
    expect(brand, 'BRAND_NAME in .env.example').toBeTruthy();
    // Case-sensitive whole word: "детали" as a common noun is fine, the capitalized brand
    // as a standalone word is not.
    const re = new RegExp(`(^|[^\\p{L}])${brand}($|[^\\p{L}])`, 'u');
    const offenders = sources.filter((file) => re.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(webDir, file))).toEqual([]);
  });

  it('does not contain INN/OGRNIP-like numbers or example requisites', () => {
    const values = Object.entries(exampleValues())
      .filter(([key]) => key !== 'BRAND_NAME')
      .map(([, value]) => value);
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      // 10, 12 (INN) or 15 (OGRNIP) digits not part of a longer number.
      if (/(^|\D)(\d{10}|\d{12}|\d{15})(\D|$)/.test(text)) offenders.push(file);
      if (values.some((value) => text.includes(value))) offenders.push(file);
    }
    expect(offenders.map((file) => path.relative(webDir, file))).toEqual([]);
  });
});
