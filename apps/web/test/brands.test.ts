// The «Выберите марку» data: every make has its logo file, logos stay light, slugs are unique.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAR_BRANDS, FEATURED_BRANDS_COUNT, brandLogoSrc } from '@/lib/brands';

const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

/** Pixel size from a WebP header (VP8X extended or VP8 lossy; the logos use these two). */
function webpSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8 ') {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  throw new Error(`unexpected WebP chunk ${chunk} in ${file}`);
}

describe('car brands', () => {
  it('has a logo file for every make, each under 10 KB', () => {
    for (const brand of CAR_BRANDS) {
      const file = join(PUBLIC_DIR, brandLogoSrc(brand));
      expect(existsSync(file), brand.slug).toBe(true);
      expect(statSync(file).size, brand.slug).toBeLessThan(10 * 1024);
    }
  });

  it('keeps slugs unique and the featured block within the list', () => {
    expect(new Set(CAR_BRANDS.map((b) => b.slug)).size).toBe(CAR_BRANDS.length);
    expect(FEATURED_BRANDS_COUNT).toBeLessThanOrEqual(CAR_BRANDS.length);
    expect(CAR_BRANDS[0]?.slug).toBe('lada');
  });

  it('declares the real pixel size of every logo file', () => {
    for (const brand of CAR_BRANDS) {
      const { width, height } = webpSize(join(PUBLIC_DIR, brandLogoSrc(brand)));
      expect({ width: brand.width, height: brand.height }, brand.slug).toEqual({ width, height });
    }
  });

  it('declares logo sizes that fit the 240×120 export box', () => {
    for (const { slug, width, height } of CAR_BRANDS) {
      expect(width, slug).toBeGreaterThan(0);
      expect(width, slug).toBeLessThanOrEqual(240);
      expect(height, slug).toBeGreaterThan(0);
      expect(height, slug).toBeLessThanOrEqual(120);
    }
  });
});
