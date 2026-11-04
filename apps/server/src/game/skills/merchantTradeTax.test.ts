import {
  CITY_MARKET_SPECIALTY_BUYER_TAX_BPS,
  CITY_MARKET_STANDARD_BUYER_TAX_BPS,
  merchantReducedBuyerTaxBps,
  merchantTradeTaxReductionPercent
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";
import { calculateFee } from "../marketRules.js";
import { activeSpecializationRank } from "./activeSpecialization.js";

describe("Merchant trade-post tax", () => {
  it("reduces the tax by 8/20/40 percent OF THE TAX at ranks 2/4/5", () => {
    expect([0, 1, 2, 3, 4, 5].map(merchantTradeTaxReductionPercent)).toEqual([0, 0, 8, 8, 20, 40]);
    const standard = CITY_MARKET_STANDARD_BUYER_TAX_BPS;
    expect([1, 2, 3, 4, 5].map((rank) => merchantReducedBuyerTaxBps(standard, rank))).toEqual([900, 828, 828, 720, 540]);
    const specialty = CITY_MARKET_SPECIALTY_BUYER_TAX_BPS;
    expect([1, 2, 4, 5].map((rank) => merchantReducedBuyerTaxBps(specialty, rank))).toEqual([450, 414, 360, 270]);
    expect(calculateFee(100_000n, merchantReducedBuyerTaxBps(standard, 5))).toBe(calculateFee(100_000n, 540));
  });

  it("never goes negative or above the base tax, whatever the rank or odd bps", () => {
    for (const rank of [-3, 0, 1, 2, 3, 4, 5, 99]) {
      for (const bps of [0, 1, 3, 7, 899, 900, 10_000]) {
        const reduced = merchantReducedBuyerTaxBps(bps, rank);
        expect(reduced).toBeGreaterThanOrEqual(0);
        expect(reduced).toBeLessThanOrEqual(bps);
        expect(calculateFee(12_345n, reduced)).toBeGreaterThanOrEqual(0n);
        // Quote and settle derive the same value from the same inputs.
        expect(merchantReducedBuyerTaxBps(bps, rank)).toBe(reduced);
      }
    }
    expect(merchantReducedBuyerTaxBps(-5, 5)).toBe(0);
    expect(merchantReducedBuyerTaxBps(Number.NaN, 5)).toBe(0);
  });

  it("reads the rank only for the ACTIVE specialization, server-side", async () => {
    const calls: unknown[][] = [];
    const queryable = (rank: number | null) => ({
      query: async (sql: string, params: unknown[]) => {
        calls.push([sql, params]);
        return { rows: rank === null ? [] : [{ rank }] };
      }
    }) as never;
    expect(await activeSpecializationRank(queryable(4), "p1", "warrior")).toBe(4);
    expect(await activeSpecializationRank(queryable(null), "p1", "warrior")).toBe(0);
    expect(calls[0]?.[1]).toEqual(["p1", "warrior"]);
    expect(String(calls[0]?.[0])).toContain("active_specialization_id = $2");
    // Merchant is hidden on the launch roster (Ronin, Warrior): its perks read as rank 0 without touching the database.
    const callsBefore = calls.length;
    expect(await activeSpecializationRank(queryable(4), "p1", "merchant")).toBe(0);
    expect(calls).toHaveLength(callsBefore);
  });
});
