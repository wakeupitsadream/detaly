// Step 2 (docs/pricing.md): the storefront category tiles and the price groups of the markup
// adjustments mean the same, and the domain classifier is the one source of truth for both.
import { PRICE_GROUPS, priceGroupOf } from '@detaly/domain';
import { describe, expect, it } from 'vitest';
import { PART_CATEGORIES } from '@/lib/part-categories';

describe('PART_CATEGORIES and PRICE_GROUPS', () => {
  it('every tile names a price group, every group but «other» has a tile', () => {
    const groups = PART_CATEGORIES.map((tile) => tile.priceGroup);
    expect(new Set(groups).size).toBe(groups.length);
    expect([...groups].sort()).toEqual(PRICE_GROUPS.filter((g) => g !== 'other').sort());
  });

  it.each(PART_CATEGORIES.map((tile) => [tile.key, tile] as const))(
    'priceGroupOf puts the «%s» request text into its group',
    (_key, tile) => {
      expect(priceGroupOf({ name: tile.need })).toBe(tile.priceGroup);
      expect(priceGroupOf({ name: tile.title })).toBe(tile.priceGroup);
    },
  );

  it('tile keys match the group keys (the hub tile is «bearings»)', () => {
    for (const tile of PART_CATEGORIES) {
      expect(tile.priceGroup).toBe(tile.key === 'hubs' ? 'bearings' : tile.key);
    }
  });
});
