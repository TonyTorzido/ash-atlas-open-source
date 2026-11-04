import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { CityDistrictBenefitService } from "./cityDistrictBenefits.js";

describe("CityDistrictBenefitService", () => {
  it("aggregates every active Monument into one tiered benefit snapshot", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          city_id: "00000000-0000-4000-8000-000000000701",
          district_revision: "9",
          district_type: "forestry",
          monument_tier: 1
        },
        {
          city_id: "00000000-0000-4000-8000-000000000701",
          district_revision: "9",
          district_type: "hunting",
          monument_tier: 3
        },
        {
          city_id: "00000000-0000-4000-8000-000000000701",
          district_revision: "9",
          district_type: "mining",
          monument_tier: 2
        }
      ]
    }));
    const service = new CityDistrictBenefitService({ query } as unknown as pg.Pool);

    const snapshot = await service.refreshRuntime("miner");

    expect(snapshot).toEqual({
      cityId: "00000000-0000-4000-8000-000000000701",
      monumentTiers: { mining: 2, forestry: 1, hunting: 3 },
      districtRevision: "9",
      miningExtraYieldChance: 0.02,
      forestryExtraYieldChance: 0.01,
      directMobDamageBonus: 2,
      mobDefenseBonus: 2,
      resinPreservationChance: 0.12
    });
    expect(service.runtimeSnapshot("miner")).toEqual(snapshot);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("monument.district_type IN ('mining', 'forestry', 'hunting')"),
      ["miner"]
    );
  });

  it("retains the member city's global revision when no Monument is active", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        city_id: "00000000-0000-4000-8000-000000000701",
        district_revision: "10",
        district_type: null,
        monument_tier: null
      }]
    }));
    const service = new CityDistrictBenefitService({ query } as unknown as pg.Pool);

    await expect(service.resolveForPlayer(
      { query } as unknown as pg.Pool,
      "member"
    )).resolves.toEqual({
      cityId: "00000000-0000-4000-8000-000000000701",
      monumentTiers: { mining: null, forestry: null, hunting: null },
      districtRevision: "10",
      miningExtraYieldChance: 0,
      forestryExtraYieldChance: 0,
      directMobDamageBonus: 0,
      mobDefenseBonus: 0,
      resinPreservationChance: 0
    });
  });

  it("applies each active Monument specialty independently and reports its qualifier", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          city_id: "00000000-0000-4000-8000-000000000702",
          district_type: "forestry",
          monument_tier: 3,
          tax_revision: "12"
        },
        {
          city_id: "00000000-0000-4000-8000-000000000702",
          district_type: "mining",
          monument_tier: 1,
          tax_revision: "12"
        }
      ]
    }));
    const pool = { query } as unknown as pg.Pool;
    const service = new CityDistrictBenefitService(pool);

    await expect(service.resolveMarketTax(
      pool,
      "00000000-0000-4000-8000-000000000703",
      ["mining"]
    )).resolves.toEqual({
      cityId: "00000000-0000-4000-8000-000000000702",
      districtType: "mining",
      monumentTier: 1,
      taxRevision: "12",
      buyerTaxBps: 450,
      specialtyApplied: true,
      qualifyingTaxTag: "mining"
    });
    await expect(service.resolveMarketTax(
      pool,
      "00000000-0000-4000-8000-000000000703",
      ["hunting", "equipment"]
    )).resolves.toMatchObject({
      districtType: null,
      monumentTier: null,
      buyerTaxBps: 900,
      specialtyApplied: false,
      qualifyingTaxTag: null
    });
  });
});
