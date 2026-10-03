// docs/external.md lists every unconfirmed assumption about an external API as
// «`path`: line[, line]» next to a `VERIFY:` comment in the code (phase 1C acceptance, item 11).
// The line numbers drift whenever a file above them changes; this test keeps both sides in step:
// every reference points at a line that carries VERIFY, and every VERIFY line of the code is
// referenced from the document.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DOC = readFileSync(join(ROOT, 'docs/external.md'), 'utf8');
const SOURCE_DIRS = ['apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'test-results', 'dist', 'coverage']);
const SOURCE_RE = /\.(?:ts|tsx|mjs)$/u;
const SELF = 'apps/web/test/external-verify.test.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (SOURCE_RE.test(name)) out.push(path);
  }
  return out;
}

/** `file:line` of every VERIFY marker in the code. */
function verifyLines(): Set<string> {
  const found = new Set<string>();
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const rel = relative(ROOT, file).split(sep).join('/');
      if (rel === SELF) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (line.includes('VERIFY')) found.add(`${rel}:${index + 1}`);
        });
    }
  }
  return found;
}

/** `file:line` of every reference «`path`: 12, 34» in docs/external.md. */
function documentedLines(): Set<string> {
  const refs = new Set<string>();
  for (const match of DOC.matchAll(/`([\w./()[\]-]+\.(?:ts|tsx|mjs))`: ([\d, ]+)/gu)) {
    for (const line of (match[2] as string).match(/\d+/gu) ?? []) {
      refs.add(`${match[1] as string}:${line}`);
    }
  }
  return refs;
}

describe('docs/external.md ↔ VERIFY markers', () => {
  const code = verifyLines();
  const doc = documentedLines();

  it('finds markers and references at all', () => {
    expect(code.size).toBeGreaterThan(50);
    expect(doc.size).toBeGreaterThan(50);
  });

  it('every documented file:line carries a VERIFY marker', () => {
    expect([...doc].filter((ref) => !code.has(ref)).sort()).toEqual([]);
  });

  it('every VERIFY marker of the code is documented by file:line', () => {
    expect([...code].filter((ref) => !doc.has(ref)).sort()).toEqual([]);
  });
});
