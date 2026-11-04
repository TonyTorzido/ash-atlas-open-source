import { describe, expect, it } from "vitest";

import { clientMessageSchema, serializeServerMessage } from "./protocol.js";
import { settlementServerMessageSchemas } from "./protocol/settlementServerSchemas.js";
import {
  CITY_FACILITY_COSTS,
  CITY_MARKET_COST,
  CITY_MARKET_SPECIALTY_BUYER_TAX_BPS,
  CITY_MARKET_STANDARD_BUYER_TAX_BPS,
  CITY_MONUMENT_COSTS,
  EMPTY_CITY_DISTRICT_BENEFIT
} from "./citySystem.js";

const emptyCityAppState = {
  municipality: null,
  region: null,
  country: null,
  memberCount: 0,
  treasuryBalance: "0",
  lifetimeCoinsEarned: "0",
  lifetimeCoinsSpent: "0",
  playerContribution: "0",
  playerContributionRank: null,
  leaderboard: [],
  ownLeaderboardEntry: null,
  warehouseUsedSlots: 0,
  warehouseTotalSlots: 0,
  activeConstruction: null,
  civicCosts: {
    market: CITY_MARKET_COST,
    monument: CITY_MONUMENT_COSTS
  },
  district: {
    districtRevision: "0",
    monuments: {
      mining: { districtType: "mining", structureId: null, status: "inactive", tier: null },
      forestry: { districtType: "forestry", structureId: null, status: "inactive", tier: null },
      hunting: { districtType: "hunting", structureId: null, status: "inactive", tier: null }
    },
    memberBenefit: EMPTY_CITY_DISTRICT_BENEFIT,
    standardBuyerTaxBps: CITY_MARKET_STANDARD_BUYER_TAX_BPS,
    specialtyBuyerTaxBps: CITY_MARKET_SPECIALTY_BUYER_TAX_BPS,
    specialtyDescriptions: {}
  },
  gold: {
    balance: "0",
    capacity: "30000",
    remainingCapacity: "30000",
    lifetimeDonated: "0",
    lifetimeSpent: "0",
    revision: "0",
    canDonate: false,
    recentDonations: []
  }
};

describe("city protocol", () => {
  it("accepts only the three supported City Monument types", () => {
    const message = {
      type: "BUILD_CITY_MONUMENT",
      requestId: "monument-1",
      cityId: "00000000-0000-4000-8000-0000000000c1",
      expectedCityRevision: "1",
      expectedDistrictRevision: "1"
    };
    for (const districtType of ["mining", "forestry", "hunting"] as const) {
      expect(clientMessageSchema.safeParse({ ...message, districtType }).success).toBe(true);
    }
    expect(clientMessageSchema.safeParse({ ...message, districtType: "fashion" }).success).toBe(false);
  });

  it("requires one selected flag and rejects client municipality authority fields", () => {
    const flagId = "00000000-0000-4000-8000-000000000001";
    expect(clientMessageSchema.safeParse({
      type: "FOUND_CITY", requestId: "found-1", flagId
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "FOUND_CITY", requestId: "found-1" }).success)
      .toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "FOUND_CITY", requestId: "found-1", flagId,
      playerId: "attacker", name: "Fake City",
      settlementId: "fake", lat: 1, lon: 2
    }).success).toBe(false);
  });

  it("accepts only the exact server-authoritative city construction actions", () => {
    const cityId = "00000000-0000-4000-8000-0000000000c1";
    for (const action of ["build_foundation", "build_frames", "finish"] as const) {
      expect(clientMessageSchema.safeParse({
        type: "ADVANCE_CITY_CONSTRUCTION",
        requestId: `construction-${action}`,
        cityId,
        action
      }).success).toBe(true);
    }
    expect(clientMessageSchema.safeParse({
      type: "ADVANCE_CITY_CONSTRUCTION",
      requestId: "construction-forged",
      cityId,
      action: "complete",
      expectedPhase: "framing"
    }).success).toBe(false);
  });

  it("accepts physical house membership and explicit mayor actions with no Warehouse withdrawal", () => {
    const cityId = "00000000-0000-4000-8000-0000000000c1";
    expect(clientMessageSchema.safeParse({
      type: "BUILD_CITY_HOUSE", requestId: "house-1"
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "BUILD_CITY_HOUSE", requestId: "house-1", cityId
    }).success).toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "BUILD_CITY_HOUSE", requestId: "house-1", lat: 35, lon: -106
    }).success).toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "DESTROY_CITY_HOUSE",
      requestId: "leave-1",
      structureId: "00000000-0000-4000-8000-000000000002",
      expectedPlacementRevision: "1"
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "CLAIM_CITY_MAYOR", requestId: "claim-1", cityId
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "RELINQUISH_CITY_MAYOR", requestId: "relinquish-1", cityId
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "BUILD_OIL_WELL", requestId: "oil-build-1", cityId
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "OPEN_OIL_WELL", requestId: "oil-open-1",
      structureId: "00000000-0000-4000-8000-000000000003"
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "HARVEST_OIL_WELL", requestId: "oil-harvest-1",
      structureId: "00000000-0000-4000-8000-000000000003"
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "VISIT_CITY_HOUSE",
      requestId: "visit-house-1",
      structureId: "00000000-0000-4000-8000-000000000002"
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "VISIT_CITY_HOUSE",
      requestId: "visit-house-1",
      structureId: "00000000-0000-4000-8000-000000000002",
      flagId: "00000000-0000-4000-8000-000000000003"
    }).success).toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "CITY_WAREHOUSE_WITHDRAW",
      requestId: "withdraw-1",
      structureId: "00000000-0000-4000-8000-000000000002",
      stackId: "00000000-0000-4000-8000-000000000003",
      quantity: 1
    }).success).toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "REORGANIZE_CITY_WAREHOUSE",
      requestId: "warehouse-reorganize-1",
      structureId: "00000000-0000-4000-8000-000000000002"
    }).success).toBe(true);
  });

  it("makes the temporary free cost explicit in the founding result", () => {
    const seatFlag = {
      id: "00000000-0000-4000-8000-000000000001",
      controlType: "city_seat" as const,
      ownerId: "player-1",
      name: "Founding Flag",
      lat: 35.0844,
      lon: -106.6504,
      packageId: null,
      elevationM: null,
      terrainClass: null,
      biome: null,
      ecoregion: null,
      claimRadiusM: 750,
      cityId: "00000000-0000-4000-8000-0000000000c1",
      createdAt: "2026-07-10T00:00:00.000Z"
    };
    const serialized = serializeServerMessage({
      type: "CITY_FOUNDED",
      requestId: "found-1",
      replayed: false,
      materialCost: 0,
      seatFlag,
      territoryFlags: Array.from({ length: 6 }, (_, index) => ({
        ...seatFlag,
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        controlType: index === 0 ? "city_seat" as const : "city" as const
      })),
      city: {
        id: "00000000-0000-4000-8000-0000000000c1",
        worldId: "main",
        worldSettlementId: "settlement-1",
        worldSettlementSource: "overture",
        worldSourceSettlementId: "source-1",
        settlementClass: "city",
        settlementReleaseId: "world-settlements-v1",
        settlementReleaseFingerprint: "f".repeat(64),
        name: "Albuquerque",
        countryCode: "US",
        regionCode: "US-NM",
        founderPlayerId: "player-1",
        mayorPlayerId: null,
        mayorConfirmed: false,
        founderMayorClaimDeadline: "2026-07-10T00:15:00.000Z",
        seatFlagId: "00000000-0000-4000-8000-000000000001",
        lat: 35.0844,
        lon: -106.6504,
        active: true,
        jumpable: true,
        constructionPhase: "complete",
        constructionCompletedAt: "2026-01-01T00:00:00.000Z",
        constructionContributions: [],
        spatialRevision: "1",
        foundingAnnexRadiusM: 750,
        createdAt: "2026-07-10T00:00:00.000Z"
      }
    });
    expect(JSON.parse(serialized)).toMatchObject({
      type: "CITY_FOUNDED",
      materialCost: 0,
      city: {
        founderPlayerId: "player-1",
        mayorPlayerId: null,
        mayorConfirmed: false,
        founderMayorClaimDeadline: "2026-07-10T00:15:00.000Z"
      }
    });
  });

  it("requires authoritative founder-claim eligibility in City app snapshots", () => {
    const snapshot = {
      ...emptyCityAppState,
      city: null,
      membership: null,
      house: null,
      structures: [],
      facilityCosts: CITY_FACILITY_COSTS,
      founderClaimDeadline: null,
      playerIsFounder: false,
      mayorVacant: true,
      mayorClaimAllowed: false,
      mayorClaimReason: "An active City House membership is required"
    };
    expect(settlementServerMessageSchemas.CITY_APP.safeParse({
      type: "CITY_APP",
      requestId: "city-app-1",
      snapshot
    }).success).toBe(true);
    expect(settlementServerMessageSchemas.CITY_APP.safeParse({
      type: "CITY_APP",
      requestId: "city-app-1",
      snapshot: { ...snapshot, founderClaimDeadline: undefined }
    }).success).toBe(false);
  });

  it("validates and preserves the complete facility-cost schedules", () => {
    const base = {
      ...emptyCityAppState,
      city: null,
      membership: null,
      house: null,
      structures: [],
      facilityCosts: CITY_FACILITY_COSTS,
      founderClaimDeadline: null,
      playerIsFounder: false,
      mayorVacant: true,
      mayorClaimAllowed: false,
      mayorClaimReason: null
    };
    const parse = (snapshot: unknown) => settlementServerMessageSchemas.CITY_APP.safeParse({
      type: "CITY_APP",
      requestId: "costs-1",
      snapshot
    });

    const parsed = parse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.snapshot.facilityCosts.cistern_warrens).toEqual(
        CITY_FACILITY_COSTS.cistern_warrens
      );
    }
    expect(parse({
      ...base,
      facilityCosts: { ...CITY_FACILITY_COSTS, weaponsmith: {}, armory: {} }
    }).success).toBe(true);
    expect(parse({ ...base, facilityCosts: undefined }).success).toBe(false);
    expect(parse({ ...base, facilityCosts: {} }).success).toBe(false);
    expect(parse({
      ...base,
      facilityCosts: { warehouse: CITY_FACILITY_COSTS.warehouse }
    }).success).toBe(false);
    expect(parse({
      ...base,
      facilityCosts: {
        warehouse: { 1: CITY_FACILITY_COSTS.warehouse[1] },
        cistern_warrens: CITY_FACILITY_COSTS.cistern_warrens
      }
    }).success).toBe(false);
    expect(parse({
      ...base,
      facilityCosts: {
        warehouse: {
          ...CITY_FACILITY_COSTS.warehouse,
          2: { materials: [{ itemId: "wood", quantity: 0 }], cityCoins: -1 }
        },
        cistern_warrens: CITY_FACILITY_COSTS.cistern_warrens
      }
    }).success).toBe(false);
  });
});
