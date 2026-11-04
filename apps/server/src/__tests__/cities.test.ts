import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import {
  CityFoundingError,
  CityService,
  cityExpansionFlagLimit,
  compassDirection,
  type CityServiceOptions
} from "../game/cities.js";
import type { PlayerRecord } from "../game/state.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldSettlement } from "../world/worldTypes.js";

const flagId = "00000000-0000-4000-8000-000000000010";
const authority = {
  releaseId: "world-settlements-v1",
  releaseFingerprint: "f".repeat(64),
  foundingPolicyId: "settlement-founding-v2",
  foundingPolicyFingerprint: "c".repeat(64),
  resolutionPolicyId: "primary-settlement-resolution-v1",
  resolutionPolicyFingerprint: "d".repeat(64)
};
const settlement: WorldSettlement = {
  settlementId: "00000000-0000-4000-8000-0000000000c1",
  source: "global-boundaries",
  sourceSettlementId: "overture-albuquerque",
  name: "Albuquerque",
  countryCode: "US",
  regionCode: "US-NM",
  jurisdictionName: "New Mexico",
  subtype: "city",
  administrativeLevel: "city",
  sourceClass: "city",
  sourceVersion: "2026-06-17.0",
  settlementClass: "city",
  settlementReleaseId: "world-settlements-v1",
  settlementReleaseFingerprint: "f".repeat(64),
  foundingPolicyId: "settlement-founding-v2",
  foundingPolicyFingerprint: "c".repeat(64),
  resolutionPolicyId: "primary-settlement-resolution-v1",
  resolutionPolicyFingerprint: "d".repeat(64),
  resolution: {
    policyId: "primary-settlement-resolution-v1",
    selectedAs: "primary_locality" as const,
    candidateCount: 2
  },
  foundingEligible: true,
  population: 560_000,
  minimumFoundingPopulation: 20_000,
  foundingIneligibilityReason: null
};

const foundSettlement = (value = settlement) => ({
  found: true as const,
  inside: true as const,
  settlement: value,
  nearest: null,
  authority
});

const noSettlement = (nearest: Record<string, unknown> | null = null) => ({
  found: false as const,
  inside: false as const,
  settlement: null,
  nearest,
  authority
});

describe("CityService founding authority", () => {
  it("evaluates the selected flag center against the municipal polygon", async () => {
    const database = new CityDatabaseStub();
    const lookupSettlement = vi.fn().mockResolvedValue(foundSettlement());
    const preview = await service(database, lookupSettlement)
      .previewFounding(player(35.085, -106.651), flagId);

    expect(preview).toMatchObject({
      eligible: true,
      flag: { id: flagId, lat: 35.0844, lon: -106.6504 },
      hallPosition: { lat: 35.0844, lon: -106.6504 },
      municipality: {
        municipalityId: settlement.settlementId,
        name: "Albuquerque",
        jurisdictionName: "New Mexico",
        municipalityType: "city"
      }
    });
    expect(lookupSettlement).toHaveBeenCalledWith(35.0844, -106.6504);
  });

  it("reports the nearest polygon boundary distance and compass direction outside all cities", async () => {
    const preview = await service(
      new CityDatabaseStub(),
      vi.fn().mockResolvedValue(noSettlement({
          municipalityId: settlement.settlementId,
          name: "Albuquerque",
          countryCode: "US",
          regionCode: "US-NM",
          jurisdictionName: "New Mexico",
          subtype: "city",
          distanceM: 3_420,
          bearingDegrees: 315
        }))
    ).previewFounding(player(), flagId);

    expect(preview).toMatchObject({
      eligible: false,
      reasonCode: "CITY_NO_MUNICIPALITY_HERE",
      nearestMunicipality: { distanceM: 3_420, direction: "northwest" }
    });
    expect(preview.reason).toContain("3.4 km northwest");
  });

  it("distinguishes no municipality from a genuine boundary authority failure", async () => {
    const unavailable = service(
      new CityDatabaseStub(),
      vi.fn().mockRejectedValue(new Error("boundary database offline"))
    );
    await expect(unavailable.previewFounding(player(), flagId)).rejects.toMatchObject({
      code: "CITY_BOUNDARY_AUTHORITY_UNAVAILABLE"
    });

    const outside = service(
      new CityDatabaseStub(),
      vi.fn().mockResolvedValue(noSettlement())
    );
    await expect(outside.previewFounding(player(), flagId)).resolves.toMatchObject({
      reasonCode: "CITY_NO_MUNICIPALITY_HERE"
    });
  });

  it.each(["megacity", "city", "town", "village", "hamlet"])(
    "accepts an authority-eligible %s without a game-side whitelist",
    async (settlementClass) => {
      const preview = await service(
        new CityDatabaseStub(),
        vi.fn().mockResolvedValue(foundSettlement({
          ...settlement,
          subtype: settlementClass,
          settlementClass
        }))
      ).previewFounding(player(), flagId);

      expect(preview).toMatchObject({
        eligible: true,
        municipality: { municipalityType: settlementClass }
      });
    }
  );

  it.each(["macrohood", "neighborhood", "microhood"])(
    "rejects an authority-ineligible %s even when its geometry covers the flag",
    async (settlementClass) => {
      const preview = await service(
        new CityDatabaseStub(),
        vi.fn().mockResolvedValue(foundSettlement({
          ...settlement,
          subtype: settlementClass,
          settlementClass,
          foundingEligible: false,
          foundingIneligibilityReason: "class_ineligible" as const
        }))
      ).previewFounding(player(), flagId);

      expect(preview).toMatchObject({
        eligible: false,
        reasonCode: "CITY_MUNICIPALITY_TYPE_INELIGIBLE",
        municipality: { municipalityType: settlementClass },
        reason: "This City Hall placement is not inside an eligible settlement area"
      });
    }
  );

  it.each([
    [
      "population_missing",
      null,
      "Population data is unavailable for Albuquerque, New Mexico. City founding requires a verified population of at least 20,000."
    ],
    [
      "population_below_minimum",
      19_999,
      "Albuquerque, New Mexico has a population of 19,999. City founding requires at least 20,000."
    ]
  ] as const)("reports %s as population ineligibility", async (reason, population, message) => {
    const preview = await service(
      new CityDatabaseStub(),
      vi.fn().mockResolvedValue(foundSettlement({
        ...settlement,
        foundingEligible: false,
        population,
        foundingIneligibilityReason: reason
      }))
    ).previewFounding(player(), flagId);

    expect(preview).toMatchObject({
      eligible: false,
      reasonCode: "CITY_MUNICIPALITY_POPULATION_INELIGIBLE",
      reason: message,
      municipality: { municipalityId: settlement.settlementId }
    });
    expect(preview.municipality).not.toHaveProperty("population");
  });

  it("rejects founding for population ineligibility before opening a transaction", async () => {
    const database = new CityDatabaseStub();
    const cities = service(database, vi.fn().mockResolvedValue(foundSettlement({
      ...settlement,
      foundingEligible: false,
      population: 19_999,
      foundingIneligibilityReason: "population_below_minimum"
    })));

    await expect(cities.foundCity(player(), {
      requestId: "population-ineligible",
      flagId
    })).rejects.toMatchObject({
      code: "CITY_MUNICIPALITY_POPULATION_INELIGIBLE",
      message: "Albuquerque, New Mexico has a population of 19,999. City founding requires at least 20,000.",
      details: {
        population: 19_999,
        minimumFoundingPopulation: 20_000,
        foundingIneligibilityReason: "population_below_minimum"
      }
    });
    expect(database.calls).not.toContain("BEGIN");
  });

  it("distinguishes missing, foreign-owned, and outside-territory founding flags", async () => {
    const missing = new CityDatabaseStub();
    missing.flag = null;
    await expect(service(missing).previewFounding(player(), flagId)).rejects.toMatchObject({
      code: "CITY_FOUNDING_FLAG_REQUIRED"
    });

    const foreign = new CityDatabaseStub();
    foreign.flag!.owner_id = "player-2";
    await expect(service(foreign).previewFounding(player(), flagId)).rejects.toMatchObject({
      code: "CITY_FOUNDING_FLAG_NOT_CONTROLLED"
    });

    const distant = new CityDatabaseStub();
    distant.flag!.distance_m = 999_999;
    await expect(service(distant).previewFounding(player(), flagId)).rejects.toMatchObject({
      code: "CITY_FOUNDING_OUTSIDE_TERRITORY"
    });
  });

  it("uses the canonical territory-edge tolerance for City Hall placement", async () => {
    const boundary = new CityDatabaseStub();
    boundary.flag!.distance_m = 1_000.05;
    await expect(service(boundary).previewFounding(player(), flagId))
      .resolves.toMatchObject({ eligible: true });

    const outside = new CityDatabaseStub();
    outside.flag!.distance_m = 1_000.051;
    await expect(service(outside).previewFounding(player(), flagId))
      .rejects.toMatchObject({ code: "CITY_FOUNDING_OUTSIDE_TERRITORY" });
  });

  it("reuses a municipality preview while the player moves within the unchanged flag", async () => {
    const lookupSettlement = vi.fn().mockResolvedValue(foundSettlement());
    const cities = service(new CityDatabaseStub(), lookupSettlement);

    await cities.previewFounding(player(35.0844, -106.6504), flagId);
    await cities.previewFounding(player(35.0845, -106.6505), flagId);

    expect(lookupSettlement).toHaveBeenCalledTimes(1);
    expect(lookupSettlement).toHaveBeenCalledWith(35.0844, -106.6504);
  });

  it("singleflight-coalesces repeated previews and reuses the result during confirmation", async () => {
    let resolveLookup!: (value: ReturnType<typeof foundSettlement>) => void;
    const pending = new Promise<ReturnType<typeof foundSettlement>>((resolve) => {
      resolveLookup = resolve;
    });
    const lookupSettlement = vi.fn().mockReturnValue(pending);
    const database = new CityDatabaseStub();
    const cities = service(database, lookupSettlement);
    const previews = Promise.all([
      cities.previewFounding(player(), flagId),
      cities.previewFounding(player(), flagId)
    ]);
    await vi.waitFor(() => expect(lookupSettlement).toHaveBeenCalledTimes(1));
    resolveLookup(foundSettlement());
    await previews;

    await cities.foundCity(player(), { requestId: "cached-confirmation", flagId });
    expect(lookupSettlement).toHaveBeenCalledTimes(1);
  });

  it("resolves World authority before opening the founding transaction", async () => {
    const database = new CityDatabaseStub();
    let resolveLookup!: (value: ReturnType<typeof foundSettlement>) => void;
    const lookupSettlement = vi.fn().mockImplementation(() =>
      new Promise<ReturnType<typeof foundSettlement>>((resolve) => {
        resolveLookup = resolve;
      })
    );
    const founding = service(database, lookupSettlement).foundCity(
      player(),
      { requestId: "preflight-before-begin", flagId }
    );
    await vi.waitFor(() => expect(lookupSettlement).toHaveBeenCalledOnce());
    expect(database.calls).not.toContain("BEGIN");
    resolveLookup(foundSettlement());
    await founding;
    expect(database.calls.indexOf("BEGIN")).toBeGreaterThan(0);
  });

  it("rejects a flag mutation between World preflight and the transaction", async () => {
    const database = new CityDatabaseStub();
    const lookupSettlement = vi.fn().mockImplementation(async () => {
      database.flag = {
        ...database.flag!,
        lat: 35.0845,
        lifecycle_revision: "2"
      };
      return foundSettlement();
    });
    await expect(service(database, lookupSettlement).foundCity(
      player(),
      { requestId: "mutated-after-preflight", flagId }
    )).rejects.toMatchObject({ code: "CITY_FLAG_LIFECYCLE_CHANGED" });
    expect(database.calls.some((sql) => sql.includes("INSERT INTO cities"))).toBe(false);
  });

  it("invalidates preview reuse when the stored flag coordinate or control lifecycle changes", async () => {
    const database = new CityDatabaseStub();
    const lookupSettlement = vi.fn().mockResolvedValue(foundSettlement());
    const cities = service(database, lookupSettlement);
    await cities.previewFounding(player(), flagId);

    database.flag!.lat = 35.0845;
    database.flag!.lon = -106.6505;
    database.flag!.lifecycle_revision = "2";
    await cities.foundCity(player(), { requestId: "coordinate-changed", flagId });
    expect(lookupSettlement).toHaveBeenCalledTimes(2);
    expect(lookupSettlement).toHaveBeenLastCalledWith(35.0845, -106.6505);

    const controlled = new CityDatabaseStub();
    const controlledLookup = vi.fn().mockResolvedValue(foundSettlement());
    const controlledCities = service(controlled, controlledLookup);
    await controlledCities.previewFounding(player(), flagId);
    controlled.flag!.control_type = "city";
    controlled.flag!.city_id = "00000000-0000-4000-8000-000000000099";
    controlled.flag!.lifecycle_revision = "2";
    await expect(controlledCities.foundCity(player(), {
      requestId: "control-changed", flagId
    })).rejects.toMatchObject({ code: "CITY_FOUNDING_FLAG_NOT_CONTROLLED" });
    expect(controlledLookup).toHaveBeenCalledTimes(1);
  });

  it("invalidates cached previews when the pinned release or policy identity changes", async () => {
    let required = authority;
    const replacementAuthority = {
      releaseId: "world-settlements-v2",
      releaseFingerprint: "e".repeat(64),
      foundingPolicyId: "settlement-founding-v3",
      foundingPolicyFingerprint: "d".repeat(64),
      resolutionPolicyId: "primary-settlement-resolution-v2",
      resolutionPolicyFingerprint: "e".repeat(64)
    };
    const replacementSettlement = {
      ...settlement,
      settlementReleaseId: replacementAuthority.releaseId,
      settlementReleaseFingerprint: replacementAuthority.releaseFingerprint,
      foundingPolicyId: replacementAuthority.foundingPolicyId,
      foundingPolicyFingerprint: replacementAuthority.foundingPolicyFingerprint,
      resolutionPolicyId: replacementAuthority.resolutionPolicyId,
      resolutionPolicyFingerprint: replacementAuthority.resolutionPolicyFingerprint,
      resolution: {
        policyId: replacementAuthority.resolutionPolicyId,
        selectedAs: "primary_locality" as const,
        candidateCount: 2
      }
    };
    const lookupSettlement = vi.fn()
      .mockResolvedValueOnce(foundSettlement())
      .mockResolvedValueOnce({
        ...foundSettlement(replacementSettlement),
        authority: replacementAuthority
      });
    const cities = service(new CityDatabaseStub(), lookupSettlement, {
      settlementAuthority: () => required
    });
    await cities.previewFounding(player(), flagId);
    required = replacementAuthority;
    await cities.previewFounding(player(), flagId);
    expect(lookupSettlement).toHaveBeenCalledTimes(2);
  });

  it("fails closed when only the founding-policy fingerprint differs", async () => {
    const mismatchedAuthority = {
      ...authority,
      foundingPolicyFingerprint: "d".repeat(64)
    };
    const lookupSettlement = vi.fn().mockResolvedValue({
      ...foundSettlement({
        ...settlement,
        foundingPolicyFingerprint: mismatchedAuthority.foundingPolicyFingerprint
      }),
      authority: mismatchedAuthority
    });
    await expect(service(new CityDatabaseStub(), lookupSettlement).previewFounding(
      player(),
      flagId
    )).rejects.toMatchObject({ code: "CITY_BOUNDARY_AUTHORITY_UNAVAILABLE" });
  });

  it("invalidates cached previews when only primary-resolution policy changes", async () => {
    let required = authority;
    const replacement = {
      ...authority,
      resolutionPolicyId: "primary-settlement-resolution-v2",
      resolutionPolicyFingerprint: "e".repeat(64)
    };
    const lookupSettlement = vi.fn()
      .mockResolvedValueOnce(foundSettlement())
      .mockResolvedValueOnce({
        ...foundSettlement({
          ...settlement,
          resolutionPolicyId: replacement.resolutionPolicyId,
          resolutionPolicyFingerprint: replacement.resolutionPolicyFingerprint,
          resolution: {
            ...settlement.resolution,
            policyId: replacement.resolutionPolicyId
          }
        }),
        authority: replacement
      });
    const cities = service(new CityDatabaseStub(), lookupSettlement, {
      settlementAuthority: () => required
    });
    await cities.previewFounding(player(), flagId);
    required = replacement;
    await cities.previewFounding(player(), flagId);
    expect(lookupSettlement).toHaveBeenCalledTimes(2);
  });

  it("uses a shorter negative TTL and evicts the oldest bounded cache entry", async () => {
    let now = 0;
    const negativeLookup = vi.fn().mockResolvedValue(noSettlement());
    const negativeCities = service(new CityDatabaseStub(), negativeLookup, {
      now: () => now,
      negativePreviewTtlMs: 5,
      positivePreviewTtlMs: 50
    });
    await negativeCities.previewFounding(player(), flagId);
    now = 4;
    await negativeCities.previewFounding(player(), flagId);
    expect(negativeLookup).toHaveBeenCalledTimes(1);
    now = 6;
    await negativeCities.previewFounding(player(), flagId);
    expect(negativeLookup).toHaveBeenCalledTimes(2);

    const database = new CityDatabaseStub();
    const boundedLookup = vi.fn().mockResolvedValue(foundSettlement());
    const boundedCities = service(database, boundedLookup, { previewCacheMaxEntries: 1 });
    await boundedCities.previewFounding(player(), flagId);
    const firstFlag = { ...database.flag! };
    const secondFlagId = "00000000-0000-4000-8000-000000000011";
    database.flag = { ...firstFlag, id: secondFlagId, lifecycle_revision: "2" };
    await boundedCities.previewFounding(player(), secondFlagId);
    database.flag = firstFlag;
    await boundedCities.previewFounding(player(), flagId);
    expect(boundedLookup).toHaveBeenCalledTimes(3);
  });

  it("transactionally creates the City Center plus five expansion flags and replays retries", async () => {
    const database = new CityDatabaseStub();
    const cities = service(database);
    const first = await cities.foundCity(
      player(35.085, -106.651),
      { requestId: "found-city", flagId }
    );
    const replay = await cities.foundCity(player(), { requestId: "found-city", flagId });

    expect(first).toMatchObject({
      city: {
        worldId: "main",
        worldSettlementId: settlement.settlementId,
        worldSourceSettlementId: settlement.sourceSettlementId,
        settlementClass: "city",
        settlementReleaseId: "world-settlements-v1",
        settlementReleaseFingerprint: "f".repeat(64),
        seatFlagId: flagId,
        name: "Albuquerque",
        lat: 35.0844,
        lon: -106.6504
      },
      seatFlagId: flagId,
      replayed: false
    });
    expect(replay).toMatchObject({ city: { id: first.city.id }, replayed: true });
    expect(database.calls.find((sql) => sql.includes("SET control_type = 'city_seat'")))
      .toContain("WHERE id = $1");
    expect(database.calls.some((sql) => /ST_DWithin\([\s\S]*UPDATE flags/.test(sql))).toBe(false);
    expect(database.calls.some((sql) => /population|resource_preparation/i.test(sql))).toBe(false);
    expect(first.territoryFlagIds).toHaveLength(6);
    expect(replay.territoryFlagIds).toEqual(first.territoryFlagIds);
    expect(database.generatedFlags).toHaveLength(5);
    expect(database.cityFlagHistory).toHaveLength(6);
    expect(database.cityDiscoveries).toEqual([["player-1", first.city.id]]);
    expect(database.city).toMatchObject({ hall_lat: 35.0844, hall_lon: -106.6504 });
  });

  it("returns all eight sensible compass sectors", () => {
    expect([0, 45, 90, 135, 180, 225, 270, 315].map(compassDirection)).toEqual([
      "north", "northeast", "east", "southeast",
      "south", "southwest", "west", "northwest"
    ]);
  });

  it.each([
    [0, 6],
    [1, 6],
    [2, 11],
    [3, 16],
    [4, 21]
  ])("allows %i members %i expansion flags", (memberCount, expectedLimit) => {
    expect(cityExpansionFlagLimit(memberCount)).toBe(expectedLimit);
  });
});

function service(
  database: CityDatabaseStub,
  lookupSettlement = vi.fn().mockResolvedValue(foundSettlement()),
  options: CityServiceOptions = {}
): CityService {
  return new CityService(
    database as unknown as pg.Pool,
    {
      lookupSettlement,
      lookupGameplayEnvironments: async (points: Array<{ lat: number; lon: number }>) =>
        points.map((point) => ({
          ok: true,
          contractVersion: "gameplay-environment-v1" as const,
          runtime: null,
          latitude: point.lat,
          longitude: point.lon,
          packageId: "test-land",
          elevationM: 1,
          terrainClass: "land",
          biome: "temperate",
          ecoregion: "test",
          isLand: true,
          isSaltwater: false,
          insideMajorLake: false,
          raw: {}
        }))
    } as unknown as WorldLookupClient,
    loadConfig({}),
    { info: vi.fn(), warn: vi.fn() } as unknown as AppLogger,
    { settlementAuthority: () => authority, ...options }
  );
}

function player(lat = 35.0844, lon = -106.6504): PlayerRecord {
  return {
    playerId: "player-1",
    username: "Ash",
    displayColor: "#38bdf8",
    regionCode: "NM",
    position: { lat, lon },
    anchor: { lat, lon },
    moveLeashRadiusM: 900,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date()
  };
}

class CityDatabaseStub {
  readonly calls: string[] = [];
  readonly cityFlagHistory: readonly unknown[][] = [];
  readonly cityDiscoveries: readonly unknown[][] = [];
  readonly generatedFlags: Array<Record<string, unknown>> = [];
  flag: Record<string, unknown> | null;
  city: Record<string, unknown> | null = null;

  constructor(position = { lat: 35.0844, lon: -106.6504 }) {
    this.flag = {
      id: flagId,
      owner_id: "player-1",
      owner_username: "Ash",
      owner_color: "#38bdf8",
      control_type: "personal",
      name: "Mesa Flag",
      lat: position.lat,
      lon: position.lon,
      claim_radius_m: 1_000,
      city_id: null,
      kingdom_id: null,
      distance_m: 0,
      lifecycle_revision: "1"
    };
  }

  async query(
    text: string,
    values: readonly unknown[] = []
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    return this.run(text, values);
  }

  async connect(): Promise<pg.PoolClient> {
    return {
      query: (text: string, values: readonly unknown[] = []) => this.run(text, values),
      release: () => undefined
    } as unknown as pg.PoolClient;
  }

  private async run(
    text: string,
    values: readonly unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    this.calls.push(text);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (text.includes("FROM flags flag") && text.includes("WHERE flag.id = $1")) {
      return { rows: this.flag ? [this.flag] : [], rowCount: this.flag ? 1 : 0 };
    }
    if (text.includes("AS city_name") && text.includes("FROM city_memberships")) {
      return { rows: [{ city_name: null }], rowCount: 1 };
    }
    if (text.includes("SELECT name FROM cities") && text.includes("mayor_player_id=$1")) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("canonical_municipality_id") && text.includes("SELECT 1 FROM cities")) {
      return { rows: this.city ? [{ "?column?": 1 }] : [], rowCount: this.city ? 1 : 0 };
    }
    if (text.includes("founding_request_id = $2")) {
      const matches = this.city?.founder_player_id === values[0] &&
        this.city?.founding_request_id === values[1];
      return { rows: matches && this.city ? [this.city] : [], rowCount: matches ? 1 : 0 };
    }
    if (text.includes("SELECT id FROM flags") && text.includes("control_type IN ('city_seat', 'city')")) {
      const ids = [
        ...(this.flag?.city_id ? [{ id: this.flag.id }] : []),
        ...this.generatedFlags.map(({ id }) => ({ id }))
      ];
      return { rows: ids, rowCount: ids.length };
    }
    if (text.includes("SELECT id FROM players") || text.includes("pg_advisory_xact_lock")) {
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("SELECT neighbor.id")) return { rows: [], rowCount: 0 };
    if (text.includes("FROM flags flag") && text.includes("WHERE ST_DWithin")) {
      return { rows: this.flag ? [this.flag] : [], rowCount: this.flag ? 1 : 0 };
    }
    if (text.includes("FROM kingdom_seats seat")) return { rows: [], rowCount: 0 };
    if (text.includes("INSERT INTO cities")) {
      this.city = {
        id: values[0],
        world_id: values[1],
        canonical_municipality_id: values[2],
        world_settlement_id: values[2],
        world_settlement_source: values[3],
        world_source_settlement_id: values[4],
        settlement_class: values[5],
        settlement_release_id: values[6],
        settlement_release_fingerprint: values[7],
        settlement_founding_policy_id: values[8],
        settlement_founding_policy_fingerprint: values[9],
        settlement_resolution_policy_id: values[10],
        settlement_resolution_policy_fingerprint: values[11],
        name: values[12],
        country_code: values[13],
        region_code: values[14],
        founder_player_id: values[15],
        mayor_player_id: null,
        mayor_house_deadline: null,
        mayor_confirmed_at: null,
        founding_request_id: values[16],
        seat_flag_id: values[17],
        hall_lat: values[18],
        hall_lon: values[19],
        founding_annex_radius_m: values[20],
        founder_username: values[21],
        founder_color: values[22],
        mayor_username: null,
        mayor_color: null,
        active: true,
        jumpable: false,
        construction_phase: "blueprint",
        construction_completed_at: null,
        construction_contributions: [],
        spatial_revision: "0",
        created_at: new Date("2026-07-18T00:00:00.000Z")
      };
      return { rows: [this.city], rowCount: 1 };
    }
    if (text.includes("SET control_type = 'city_seat'")) {
      this.flag = {
        ...this.flag!, control_type: "city_seat", city_id: values[1], lifecycle_revision: "2"
      };
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO flags (")) {
      const generated = {
        id: values[0],
        owner_id: values[1],
        owner_username: null,
        owner_color: values[14],
        control_type: "city",
        name: values[2],
        lat: values[3],
        lon: values[4],
        claim_radius_m: values[10],
        city_id: values[13],
        kingdom_id: null,
        distance_m: 0,
        lifecycle_revision: "1"
      };
      this.generatedFlags.push(generated);
      return { rows: [generated], rowCount: 1 };
    }
    if (
      text.includes("UPDATE normal_flag_passage_requests")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("INSERT INTO city_memberships")) return { rows: [], rowCount: 1 };
    if (text.includes("INSERT INTO player_discovered_cities")) {
      (this.cityDiscoveries as unknown[][]).push([...values]);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO city_flag_affiliation_history")) {
      (this.cityFlagHistory as unknown[][]).push([...values]);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO city_construction_contributions")) {
      if (this.city) {
        this.city.construction_contributions = [{
          playerId: values[1],
          stage: "blueprint",
          contributedAt: "2026-07-18T00:00:00.000Z"
        }];
      }
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM cities c") && text.includes("WHERE c.id=$1")) {
      const matches = this.city?.id === values[0] && this.city?.world_id === values[1];
      return { rows: matches && this.city ? [this.city] : [], rowCount: matches ? 1 : 0 };
    }
    throw new Error(`unexpected query: ${text}`);
  }
}

void CityFoundingError;
