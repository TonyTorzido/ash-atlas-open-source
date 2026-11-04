import { describe, expect, it } from 'vitest';
import { INVENTORY_CATALOG } from './inventoryCatalog.js';
import { BACKPACK_LEVELS, requireBackpackLevel } from './backpacks.js';
import { formatWeightKg, getBackpackWeightGrams, getItemWeightGrams, ITEM_WEIGHT_GRAMS } from './inventoryWeight.js';
describe('integer carrying weights and backpack progression', () => {
  it('defines positive integer grams for every catalogued resource and equipment identity', () => {
    expect(Object.keys(ITEM_WEIGHT_GRAMS).sort()).toEqual(Object.keys(INVENTORY_CATALOG).sort());
    for (const itemId of Object.keys(INVENTORY_CATALOG)) {
      expect(Number.isSafeInteger(getItemWeightGrams(itemId))).toBe(true);
      // Only currency items (Lumen) are weightless.
      if (INVENTORY_CATALOG[itemId]!.category === 'currency') {
        expect(getItemWeightGrams(itemId)).toBe(0);
      } else {
        expect(getItemWeightGrams(itemId)).toBeGreaterThan(0);
      }
    }
    expect(getItemWeightGrams('wood')).toBe(100);
    expect(getItemWeightGrams('wheat_seed')).toBe(1);
    expect(() => getItemWeightGrams('not-an-item')).toThrow();
  });
  it('formats kilograms without rounding away a gram or coercing unsafe totals to numbers', () => {
    expect(formatWeightKg(0)).toBe('0');
    expect(formatWeightKg(72400n)).toBe('72.4');
    expect(formatWeightKg('100001')).toBe('100.001');
    expect(formatWeightKg(900719925474099100n)).toBe('900,719,925,474,099.1');
    expect(() => formatWeightKg(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => formatWeightKg(-1n)).toThrow();
  });
  it('stores the canonical +0 through +10 capacities, costs, and zero backpack weight', () => {
    expect(BACKPACK_LEVELS.map(level => level.level)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(BACKPACK_LEVELS.map(level => level.capacityBonusGrams)).toEqual([5000, 10000, 15000, 20000, 25000, 30000, 35000, 40000, 45000, 50000, 55000]);
    expect(BACKPACK_LEVELS.map(level => level.upgradeCost)).toEqual([
      { leather: 80, gold: 2000 }, { leather: 20, gold: 500 },
      { leather: 35, gold: 1000 }, { leather: 50, gold: 1500 },
      { leather: 80, gold: 2500 }, { leather: 120, gold: 4000 },
      { leather: 180, gold: 6500 }, { leather: 260, gold: 10000 },
      { leather: 375, gold: 15000 }, { leather: 550, gold: 22500 },
      { leather: 800, gold: 35000 }
    ]);
    expect(getBackpackWeightGrams()).toBe(0);
    for (let level = 0; level <= 10; level++) {
      expect(requireBackpackLevel(level).effects).toEqual({});
      if (level > 0)
        expect(requireBackpackLevel(level).capacityBonusGrams).toBeGreaterThan(requireBackpackLevel(level - 1).capacityBonusGrams);
    }
    expect(() => requireBackpackLevel(11)).toThrow();
    expect(() => requireBackpackLevel(-1)).toThrow();
  });
});
