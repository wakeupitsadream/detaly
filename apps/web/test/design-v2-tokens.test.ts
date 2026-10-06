/**
 * Redesign 2 tokens (docs/design-v2.md, section 2): the palette and the old-name aliases in
 * globals.css, Manrope as the only storefront face, the brand colour only through tokens. The
 * last block greps the client paths for «Техкарта» leftovers (docs/design-v2.md, section 8,
 * item 3).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(webDir, 'src');
const css = readFileSync(path.join(srcDir, 'app', 'globals.css'), 'utf8');
const rootLayout = readFileSync(path.join(srcDir, 'app', 'layout.tsx'), 'utf8');

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return /\.(tsx?|css)$/.test(entry.name) ? [full] : [];
  });
}

/** Value of `--name: value;` inside @theme. */
function token(name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
}

/** Storefront sources: the site pages and every component except the admin's. */
function clientFiles(): string[] {
  return [
    ...listFiles(path.join(srcDir, 'app', '(site)')),
    ...listFiles(path.join(srcDir, 'components')).filter(
      (file) => !file.includes(`${path.sep}components${path.sep}admin${path.sep}`),
    ),
  ];
}

describe('design v2 tokens', () => {
  it('the palette of the spec', () => {
    const palette: Record<string, string> = {
      'color-bg': '#ffffff',
      'color-surface': '#f2f3f5',
      'color-surface-2': '#e8eaed',
      'color-ink': '#111317',
      'color-muted': '#5b616b',
      'color-faint': '#80868f',
      'color-line': '#e3e5e8',
      'color-line-strong': '#c9cdd2',
      'color-brand': '#b3291e',
      'color-brand-hover': '#8f2017',
      'color-brand-soft': '#fbeae7',
      'color-on-brand': '#ffffff',
      'color-dark': '#17181a',
      'color-dark-2': '#2a2d32',
      'color-ok': '#1e7a46',
      'color-ok-soft': '#e3f2e8',
      'color-info': '#2b5c8a',
      'color-info-soft': '#e3ecf5',
      'color-wait': '#8a5300',
      'color-wait-soft': '#fbf0dc',
      'color-danger': '#c42b2b',
      'color-danger-soft': '#fce6e6',
    };
    for (const [name, value] of Object.entries(palette)) {
      expect(token(name)?.toLowerCase(), name).toBe(value);
    }
  });

  it('radii and the type scale exist', () => {
    expect(token('radius-tile')).toBe('20px');
    expect(token('radius-panel')).toBe('28px');
    expect(token('radius-control')).toBe('14px');
    for (const utility of [
      'text-display',
      'text-h1',
      'text-h2',
      'text-h3',
      'text-body',
      'text-small',
      'text-caption',
      'text-price',
    ]) {
      expect(css, utility).toContain(`@utility ${utility} {`);
    }
  });

  it('nothing in the type scale is smaller than 14 px', () => {
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)rem/g)].map((m) => Number(m[1]) * 16);
    expect(sizes.length).toBeGreaterThan(10);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(14);
  });

  it('old «Техкарта» names stay as aliases for the admin', () => {
    const aliases: Record<string, string> = {
      'color-graphite-950': 'color-dark',
      'color-graphite-900': 'color-dark',
      'color-graphite-800': 'color-dark-2',
      'color-graphite-700': 'color-dark-2',
      'color-paper': 'color-bg',
      'color-paper-2': 'color-surface',
      'color-card': 'color-bg',
      'color-accent': 'color-brand',
      'color-accent-hover': 'color-brand-hover',
      'color-accent-strong': 'color-brand-hover',
      'color-accent-ink': 'color-brand',
      'color-accent-soft': 'color-brand-soft',
      'color-signal': 'color-wait-soft',
      'color-steel-400': 'color-faint',
      'color-steel-200': 'color-line-strong',
      'color-local': 'color-ok',
      'color-local-soft': 'color-ok-soft',
      'color-order': 'color-info',
      'color-order-soft': 'color-info-soft',
      'color-warn': 'color-wait',
      'color-warn-soft': 'color-wait-soft',
    };
    for (const [name, target] of Object.entries(aliases)) {
      expect(token(name), name).toBe(`var(--${target})`);
    }
    // The admin's cards and mono VINs.
    expect(token('radius-card')).toBeDefined();
    expect(token('font-mono')).toContain('JetBrains Mono');
  });

  it('no drafting texture or grain any more', () => {
    for (const leftover of [
      '.bg-blueprint',
      '.grain-dark',
      '.bg-tread',
      '.hazard',
      'body::after',
    ]) {
      expect(css, leftover).not.toContain(leftover);
    }
  });

  it('Manrope is the face; Unbounded and Onest are not loaded', () => {
    expect(token('font-sans')).toMatch(/^'Manrope Variable'/);
    expect(rootLayout).toContain("'@fontsource-variable/manrope/index.css'");
    expect(rootLayout).not.toMatch(/unbounded|onest/i);
  });

  it('the browser bar colour is the brand token', () => {
    const theme = /BRAND_THEME_COLOR = '(#[0-9a-f]{6})'/i.exec(rootLayout)?.[1];
    expect(theme?.toLowerCase()).toBe(token('color-brand'));
  });

  it('no brand hex in the storefront sources: the colour is a token', () => {
    const hexes = ['color-brand', 'color-brand-hover', 'color-brand-soft'].map((name) =>
      token(name)!.toLowerCase(),
    );
    const offenders = clientFiles().filter((file) => {
      const source = readFileSync(file, 'utf8').toLowerCase();
      return hexes.some((hex) => source.includes(hex));
    });
    expect(offenders.map((file) => path.relative(webDir, file))).toEqual([]);
  });
});

// The admin keeps the old names through the aliases above; the storefront does not use them.
describe('no «Техкарта» leftovers in client paths', () => {
  // A class starts after a space, a quote, a variant colon or `!`, never inside a word or a
  // kebab-case name: data-testid="call-to-order" is not the utility `to-order`.
  const OLD_TOKEN =
    /(?<![\w-])(?:bg|text|border|outline|decoration|fill|stroke|ring|from|to|via|divide|placeholder|shadow|border-[lrtbxy])-(?:graphite-\d+|steel-\d+|paper(?:-2)?|card|accent(?:-[a-z]+)?|signal|local(?:-soft)?|order(?:-soft)?|warn(?:-soft)?)\b/;
  const OLD_FACE = /\bfont-(?:display|mono)\b|Unbounded|JetBrains|Onest/;
  const OLD_PART = /\b(?:HazardBand|CornerMarks|Eyebrow|BrandMark)\b/;
  const OLD_CLASS =
    /\b(?:text-label|text-article|bg-blueprint|grain-dark|bg-tread|corner-marks|hazard|rounded-card)\b/;

  it.each([
    ['old colour tokens', OLD_TOKEN],
    ['old fonts', OLD_FACE],
    ['old components', OLD_PART],
    ['old texture classes', OLD_CLASS],
  ] as const)('%s', (_name, re) => {
    const offenders = clientFiles().filter((file) => re.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(webDir, file))).toEqual([]);
  });
});
