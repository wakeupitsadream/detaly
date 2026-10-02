import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from './client';
import { DEFAULT_LEGAL_DIR } from './seed/legal';

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return Promise.resolve(entry.name.endsWith('.ts') ? [full] : []);
    }),
  );
  return nested.flat();
}

describe('package paths', () => {
  it('resolves the migrations folder and content/legal', () => {
    expect(existsSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'))).toBe(true);
    expect(existsSync(path.join(DEFAULT_LEGAL_DIR, 'offer'))).toBe(true);
  });

  it('never uses new URL(<literal>, import.meta.url): bundlers treat it as an asset import', async () => {
    // apps/web imports @detaly/db; Turbopack fails the build with "Module not found: '../drizzle'".
    const pattern = /new URL\(\s*['"`][^'"`]*['"`]\s*,\s*import\.meta\.url\s*\)/;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    for (const file of await sourceFiles(here)) {
      if (file.endsWith('.test.ts')) continue;
      if (pattern.test(await readFile(file, 'utf8'))) offenders.push(path.relative(here, file));
    }
    expect(offenders).toEqual([]);
  });
});
