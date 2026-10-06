// The «Выберите марку» data: every make has its logo file, logos stay light, slugs are unique.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAR_BRANDS, FEATURED_BRANDS_COUNT, brandLogoSrc } from '@/lib/brands';

const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

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

  it('declares logo sizes that fit the 240×120 export box', () => {
    for (const { slug, width, height } of CAR_BRANDS) {
      expect(width, slug).toBeGreaterThan(0);
      expect(width, slug).toBeLessThanOrEqual(240);
      expect(height, slug).toBeGreaterThan(0);
      expect(height, slug).toBeLessThanOrEqual(120);
    }
  });
});
