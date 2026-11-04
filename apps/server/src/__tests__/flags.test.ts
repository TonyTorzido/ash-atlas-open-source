import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { loadConfig, MAX_FLAG_CLAIM_RADIUS_M, type AppConfig } from "../config.js";
import { DEFAULT_FLAG_COLOR, FlagService, nextDefaultFlagName } from "../game/flags.js";
import type { PlayerRecord } from "../game/state.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldLookupResult } from "../world/worldTypes.js";

type QueryCall = {
  text: string;
  values?: readonly unknown[];
};

type PoolStubOptions = {
  overlap?: boolean;
  existingFlagDistanceMeters?: number;
  existingFlagOwnerId?: string;
  existingFlagOwnerUsername?: string;
  existingNames?: string[];
  listRows?: Array<Record<string, unknown>>;
  getRows?: Array<Record<string, unknown>>;
  territoryRows?: Array<Record<string, unknown>>;
  insertError?: unknown;
};

const createdAt = new Date("2026-07-08T09:00:00.000Z");
const DEV_PLAYER_SPEED_MPS = 500;
const DEV_FLAG_CLAIM_RADIUS_M = 500;
const DEV_MOVE_LEASH_RADIUS_M = 600;
const DEV_FLAG_RESOURCE_VISION_RADIUS_M = 650;
const DEV_FLAG_PREPARE_BUFFER_M = 100;
const DEV_FLAG_PREPARE_RADIUS_M = 750;

describe("FlagService", () => {
  it("defaults the exact ordinary gameplay-area radius contract", () => {
    expect(loadConfig({})).toMatchObject({
      FLAG_CLAIM_RADIUS_M: DEV_FLAG_CLAIM_RADIUS_M,
      MOVE_LEASH_RADIUS_M: DEV_MOVE_LEASH_RADIUS_M,
      FLAG_RESOURCE_VISION_RADIUS_M: DEV_FLAG_RESOURCE_VISION_RADIUS_M,
      FLAG_PREPARE_BUFFER_M: DEV_FLAG_PREPARE_BUFFER_M,
      FLAG_PREPARE_RADIUS_M: DEV_FLAG_PREPARE_RADIUS_M
    });
  });

  it("rejects non-positive authoritative world radii", () => {
    expect(() => loadConfig({ FLAG_CLAIM_RADIUS_M: "0" })).toThrow();
    expect(() => loadConfig({ MOVE_LEASH_RADIUS_M: "-1" })).toThrow();
  });

  it("retains explicit positive world-radius overrides", () => {
    const config = loadConfig({
      FLAG_CLAIM_RADIUS_M: "550",
      MOVE_LEASH_RADIUS_M: "700",
      FLAG_RESOURCE_VISION_RADIUS_M: "800",
      FLAG_PREPARE_BUFFER_M: "300",
      FLAG_PREPARE_RADIUS_M: "1100"
    });
    expect(config.FLAG_CLAIM_RADIUS_M).toBe(550);
    expect(config.MOVE_LEASH_RADIUS_M).toBe(700);
  });

  it("rejects collapsed or inconsistent ordinary geometry", () => {
    expect(() => loadConfig({ FLAG_CLAIM_RADIUS_M: "650" })).toThrow();
    expect(() => loadConfig({ MOVE_LEASH_RADIUS_M: "750" })).toThrow();
    expect(() => loadConfig({ FLAG_PREPARE_RADIUS_M: "999" })).toThrow();
  });

  it("rejects claim radii above the database-backed territory bound", () => {
    expect(() => loadConfig({
      FLAG_CLAIM_RADIUS_M: String(MAX_FLAG_CLAIM_RADIUS_M + 1)
    })).toThrow();
  });

  it("includes owner color in flag snapshots", async () => {
    const service = new FlagService(
      createPoolStub([], "0", {
        listRows: [
          {
            ...createFlagRow("flag-1", "player-1", "Color Flag"),
            owner_color: "#3366cc"
          },
          {
            ...createFlagRow("flag-2", "missing-player", "Fallback Flag"),
            owner_color: null
          }
        ]
      }),
      createWorldLookupStub({
        ok: true,
        packageId: "us_nm_v1_lat35_lon-107",
        elevationM: 1514,
        terrainClass: "flat",
        biome: "Deserts & Xeric Shrublands",
        ecoregion: "Colorado Plateau shrublands",
        raw: { ok: true }
      }),
      createConfig(),
      createLoggerStub()
    );

    await expect(service.listFlags()).resolves.toMatchObject([
      {
        id: "flag-1",
        ownerColor: "#3366cc"
      },
      {
        id: "flag-2",
        ownerColor: DEFAULT_FLAG_COLOR
      }
    ]);
  });

  it("enumerates global flags without requiring spatial metadata", async () => {
    const calls: QueryCall[] = [];
    const service = new FlagService(
      createPoolStub(calls, "0", {
        listRows: [createFlagRow("flag-global", "player-1", "Global Flag")]
      }),
      createWorldLookupStub({
        ok: true,
        packageId: "nm-core",
        elevationM: 1_500,
        terrainClass: "flat",
        biome: "desert",
        ecoregion: "Chihuahuan Desert",
        raw: {}
      }),
      createConfig(),
      createLoggerStub()
    );

    await expect(
      service.listFlags(undefined, 250, undefined, undefined, true)
    ).resolves.toMatchObject([{ id: "flag-global" }]);
    const query = calls.find(({ text }) =>
      text.includes("ORDER BY f.id ASC")
    )?.text ?? "";
    expect(query).not.toContain("ST_MakeEnvelope");
    expect(query).not.toContain("f.geom");
    expect(query).toContain("f.lat");
    expect(query).toContain("f.lon");
  });

  it("keeps every city-controlled flag black", async () => {
    const service = new FlagService(
      createPoolStub([], "0", {
        listRows: [
          {
            ...createFlagRow("city-flag", "player-1", "City Flag"),
            control_type: "city",
            owner_color: "#d83a3a"
          },
          {
            ...createFlagRow("city-seat", "player-1", "City Center"),
            control_type: "city_seat",
            owner_color: "#7c3aed"
          }
        ]
      }),
      createWorldLookupStub({
        ok: true,
        packageId: "us_nm_v1_lat35_lon-107",
        elevationM: 1514,
        terrainClass: "flat",
        biome: "Deserts & Xeric Shrublands",
        ecoregion: "Colorado Plateau shrublands",
        raw: { ok: true }
      }),
      createConfig(),
      createLoggerStub()
    );

    await expect(service.listFlags()).resolves.toMatchObject([
      { id: "city-flag", ownerColor: "#000000" },
      { id: "city-seat", ownerColor: "#000000" }
    ]);
  });

  it("includes active Castles as source-flag snapshots", async () => {
    const calls: QueryCall[] = [];
    const service = new FlagService(
      createPoolStub(calls, "0", {
        listRows: [{
          ...createFlagRow("source-flag", "founder", "Founding Flag"),
          control_type: "kingdom_seat",
          kingdom_id: "kingdom-a",
          kingdom_name: "Green Realm",
          kingdom_color: "#22c55e",
          kingdom_seat_id: "seat-a",
          kingdom_seat_construction_state: "under_construction",
          claim_radius_m: 200
        }]
      }),
      createWorldLookupStub({
        ok: true,
        packageId: "nm-core",
        elevationM: 1_500,
        terrainClass: "urban",
        biome: "desert",
        ecoregion: "Chihuahuan Desert",
        raw: {}
      }),
      createConfig(),
      createLoggerStub()
    );

    await expect(service.listFlags()).resolves.toMatchObject([{
      id: "source-flag",
      controlType: "kingdom_seat",
      kingdomId: "kingdom-a",
      kingdomName: "Green Realm",
      kingdomColor: "#22c55e",
      kingdomSeatId: "seat-a",
      kingdomSeatConstructionState: "under_construction",
      claimRadiusM: 200
    }]);
    const listQuery = calls.find(({ text }) => text.includes("ORDER BY f.created_at"))?.text ?? "";
    expect(listQuery).toContain("LEFT JOIN kingdom_seats seat");
    expect(listQuery).toContain("seat.territory_radius_m");
    expect(listQuery).not.toContain(
      "f.control_type <> 'kingdom_seat' OR (k.id IS NOT NULL AND seat.id IS NOT NULL)"
    );
  });

  it("keeps a durable Castle visible when its control joins are missing", async () => {
    const calls: QueryCall[] = [];
    const seatRow = {
      ...createFlagRow("source-flag", "founder", "Founding Flag"),
      control_type: "kingdom_seat",
      kingdom_id: null,
      kingdom_seat_id: null,
      kingdom_seat_construction_state: null
    };
    const service = new FlagService(
      createPoolStub(calls, "0", {
        getRows: [seatRow],
        listRows: [seatRow]
      }),
      createWorldLookupStub({
        ok: true,
        packageId: "nm-core",
        elevationM: 1_500,
        terrainClass: "urban",
        biome: "desert",
        ecoregion: "Chihuahuan Desert",
        raw: {}
      }),
      createConfig(),
      createLoggerStub()
    );

    await expect(service.listFlags()).resolves.toMatchObject([{
      id: "source-flag",
      controlType: "kingdom_seat",
      kingdomId: null,
      kingdomSeatId: null,
      claimRadiusM: DEV_FLAG_CLAIM_RADIUS_M
    }]);
    await expect(service.getFlag("source-flag")).resolves.toMatchObject({
      id: "source-flag",
      controlType: "kingdom_seat",
      kingdomId: null,
      kingdomSeatId: null
    });
    await expect(service.getMapFlag("source-flag")).resolves.toMatchObject({
      id: "source-flag",
      controlType: "kingdom_seat",
      kingdomId: null,
      kingdomSeatId: null
    });
    expect(calls.filter(({ text }) => text.includes("WHERE f.id = $1")).map(({ values }) => values))
      .toEqual([["source-flag", DEFAULT_FLAG_COLOR], ["source-flag", DEFAULT_FLAG_COLOR]]);
  });

  it("creates a flag at the server-owned player position with degraded world data allowed", async () => {
    const calls: QueryCall[] = [];
    const service = new FlagService(
      createPoolStub(calls, "0"),
      createWorldLookupStub({
        ok: false,
        packageId: null,
        elevationM: null,
        terrainClass: null,
        biome: null,
        ecoregion: null,
        raw: { warning: "world API unavailable" },
        warning: "world API unavailable"
      }),
      createConfig({ ALLOW_UNRESOLVED_FLAGS_IN_DEV: true }),
      createLoggerStub()
    );

    const result = await service.createForPlayer(createPlayer(), "Mesa Claim");

    expect(result.warning).toBe("world API unavailable");
    expect(result.flag).toMatchObject({
      anchorKind: "flag",
      ownerId: "player-1",
      name: "Mesa Claim",
      lat: 35.0844,
      lon: -106.6504,
      packageId: null,
      claimRadiusM: DEV_FLAG_CLAIM_RADIUS_M,
      createdAt: createdAt.toISOString()
    });

    const insertValues = calls.find((call) => call.text.includes("INSERT INTO flags"))?.values;
    if (!insertValues) {
      throw new Error("expected insert query values");
    }
    expect(insertValues[1]).toBe("flag");
    expect(insertValues[2]).toBe("player-1");
    expect(insertValues[4]).toBe(35.0844);
    expect(insertValues[5]).toBe(-106.6504);
    expect(JSON.parse(String(insertValues[13]))).toEqual({
      warning: "world API unavailable"
    });
    expect(calls.some(({ text }) => text.includes("UPDATE players")))
      .toBe(false);
  });

  it("rejects unresolved world data when dev fallback is disabled", async () => {
    const calls: QueryCall[] = [];
    const service = new FlagService(
      createPoolStub(calls, "0"),
      createWorldLookupStub({
        ok: false,
        packageId: null,
        elevationM: null,
        terrainClass: null,
        biome: null,
        ecoregion: null,
        raw: { warning: "world API unavailable" },
        warning: "world API unavailable"
      }),
      createConfig({ ALLOW_UNRESOLVED_FLAGS_IN_DEV: false }),
      createLoggerStub()
    );

    await expect(service.createForPlayer(createPlayer(), "Mesa Claim")).rejects.toThrow(
      "World validation could not be completed. Try again shortly."
    );
    expect(calls).toHaveLength(3);
  });

  it("rejects authoritative water with the player-facing reason", async () => {
    const service = new FlagService(
      createPoolStub([], "0"),
      createWorldLookupStub({
        ok: true,
        packageId: "water-package",
        elevationM: 0,
        terrainClass: "flat",
        biome: null,
        ecoregion: null,
        isLand: false,
        isSaltwater: false,
        raw: {}
      }),
      createConfig(),
      createLoggerStub()
    );

    await expect(service.createForPlayer(createPlayer())).rejects.toThrow(
      "Cannot place flag on water"
    );
  });

  it("reports the stable canonical river-water rejection", async () => {
    const service = new FlagService(
      createPoolStub([], "0"),
      createWorldLookupStub({
        ok: true,
        packageId: "river-package",
        elevationM: 0,
        terrainClass: "flat",
        biome: null,
        ecoregion: null,
        isLand: false,
        isSaltwater: false,
        surfaceKind: "water",
        waterKind: "river",
        raw: {}
      }),
      createConfig(),
      createLoggerStub()
    );

    await expect(service.createForPlayer(createPlayer())).rejects.toThrow(
      "Cannot build on river water."
    );
  });

  it.each([
    {
      label: "major lakes",
      world: { isLand: true, isSaltwater: false, insideMajorLake: true }
    },
    {
      label: "authoritative inland-water land cover",
      world: {
        isLand: true,
        isSaltwater: false,
        insideMajorLake: false,
        landCoverClass: "inland_water"
      }
    },
    {
      label: "authoritative river corridor",
      world: {
        isLand: true,
        isSaltwater: false,
        insideMajorLake: false,
        landCoverClass: "forest",
        flagPlacementWater: {
          blocked: true,
          kind: "river" as const,
          sourceId: "70591949",
          sourceName: null,
          distanceM: 10,
          corridorRadiusM: 16.608,
          reason: "inside authoritative supporting-river corridor",
          resolution: "water-placement-surface-v1",
          releaseId: "world-packages-v1"
        }
      }
    }
  ])("rejects freshwater identified by $label", async ({ world }) => {
    const service = new FlagService(
      createPoolStub([], "0"),
      createWorldLookupStub({
        ok: true,
        packageId: "freshwater-package",
        elevationM: 0,
        terrainClass: "flat",
        biome: null,
        ecoregion: null,
        ...world,
        raw: {}
      }),
      createConfig(),
      createLoggerStub()
    );

    await expect(service.createPlacementQuote(createPlayer())).rejects.toThrow(
      "Cannot place flag on water"
    );
  });

  it("prepares valid authoritative land for a build", async () => {
    const worldLookup = createWorldLookupStub({
      ok: true,
      packageId: "land-package",
      elevationM: 1_500,
      terrainClass: "flat",
      biome: "desert",
      ecoregion: "Chihuahuan Desert",
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      landCoverClass: "shrubland",
      raw: {}
    });
    const service = new FlagService(
      createPoolStub([], "0"),
      worldLookup,
      createConfig(),
      createLoggerStub()
    );

    const player = createPlayer();
    const { quote } = await service.createPlacementQuote(player);
    await expect(service.prepareForPlayer(player, undefined, quote.quoteId)).resolves.toMatchObject({
      ownerId: "player-1",
      world: { packageId: "land-package" }
    });
    expect(worldLookup.lookupGameplayEnvironment).toHaveBeenCalledOnce();
    expect(worldLookup.lookup).not.toHaveBeenCalled();
  });

  it("does not enforce the old per-player flag limit", async () => {
    const calls: QueryCall[] = [];
    const service = new FlagService(
      createPoolStub(calls, "10"),
      createWorldLookupStub({
        ok: true,
        packageId: "us_nm_v1_lat35_lon-107",
        elevationM: 1514,
        terrainClass: "flat",
        biome: "Deserts & Xeric Shrublands",
        ecoregion: "Colorado Plateau shrublands",
        raw: { ok: true }
      }),
      createConfig(),
      createLoggerStub()
    );

    const result = await service.createForPlayer(createPlayer());

    expect(result.flag.name).toBe("Flag 11");
    expect(calls.some(({ text }) => text.includes("WHERE owner_id"))).toBe(true);
    expect(calls.some(({ text }) => text.includes("INSERT INTO flags"))).toBe(true);
  });

  it("chooses the next unused default flag name", async () => {
    expect(nextDefaultFlagName(["Flag 1", "Flag 3", "Mesa Claim"])).toBe("Flag 2");
    expect(nextDefaultFlagName(["Flag 1", "Flag 2"])).toBe("Flag 3");
  });

  it("rejects flag placement inside own effective territory", async () => {
    const calls: QueryCall[] = [];
    const worldLookup = createWorldLookupStub({
      ok: true,
      packageId: "us_nm_v1_lat35_lon-107",
      elevationM: 1514,
      terrainClass: "flat",
      biome: "Deserts & Xeric Shrublands",
      ecoregion: "Colorado Plateau shrublands",
      raw: { ok: true }
    });
    const service = new FlagService(
      createPoolStub(calls, "2", { existingFlagDistanceMeters: 499 }),
      worldLookup,
      createConfig(),
      createLoggerStub()
    );

    await expect(service.createForPlayer(createPlayer())).rejects.toThrow(
      /inside your claimed territory/
    );
    expect(worldLookup.lookupGameplayEnvironment).not.toHaveBeenCalled();
    expect(calls.some((call) => call.text.includes("INSERT INTO flags"))).toBe(false);
    expect(calls.some((call) => call.text.includes("ST_Distance"))).toBe(false);
    expect(calls.some((call) => call.text.includes("ST_DWithin"))).toBe(true);
  });

  it("rejects flag placement on the existing claimed territory boundary", async () => {
    const calls: QueryCall[] = [];
    const worldLookup = createWorldLookupStub({
      ok: true,
      packageId: "us_nm_v1_lat35_lon-107",
      elevationM: 1514,
      terrainClass: "flat",
      biome: "Deserts & Xeric Shrublands",
      ecoregion: "Colorado Plateau shrublands",
      raw: { ok: true }
    });
    const service = new FlagService(
      createPoolStub(calls, "2", { existingFlagDistanceMeters: DEV_FLAG_CLAIM_RADIUS_M }),
      worldLookup,
      createConfig(),
      createLoggerStub()
    );

    await expect(service.createForPlayer(createPlayer())).rejects.toThrow(
      /inside your claimed territory/
    );
    expect(worldLookup.lookupGameplayEnvironment).not.toHaveBeenCalled();
    expect(calls.some((call) => call.text.includes("INSERT INTO flags"))).toBe(false);
  });

  it("rejects flag placement inside enemy effective territory", async () => {
    const service = new FlagService(
      createPoolStub([], "2", {
        existingFlagDistanceMeters: 120,
        existingFlagOwnerId: "player-2",
        existingFlagOwnerUsername: "Bex"
      }),
      createWorldLookupStub({
        ok: true,
        packageId: "us_nm_v1_lat35_lon-107",
        elevationM: 1514,
        terrainClass: "flat",
        biome: "Deserts & Xeric Shrublands",
        ecoregion: "Colorado Plateau shrublands",
        raw: { ok: true }
      }),
      createConfig(),
      createLoggerStub()
    );

    await expect(service.createForPlayer(createPlayer())).rejects.toThrow(
      /inside Bex's claimed territory/
    );
  });

  it("rejects overlapping effective territory without a nearest-distance query", async () => {
    const service = new FlagService(
      createPoolStub([], "2", {
        territoryRows: [
          createTerritoryFlagRow("owned-far", "player-1", 500, "Ash"),
          createTerritoryFlagRow("enemy-near", "player-2", 100, "Bex")
        ]
      }),
      createWorldLookupStub({
        ok: true,
        packageId: "us_nm_v1_lat35_lon-107",
        elevationM: 1514,
        terrainClass: "flat",
        biome: "Deserts & Xeric Shrublands",
        ecoregion: "Colorado Plateau shrublands",
        raw: { ok: true }
      }),
      createConfig(),
      createLoggerStub()
    );

    await expect(service.createForPlayer(createPlayer())).rejects.toThrow(
      /inside Bex's claimed territory/
    );
  });

  it("allows flag placement just outside 500m from an existing flag", async () => {
    const calls: QueryCall[] = [];
    const service = new FlagService(
      createPoolStub(calls, "2", { existingFlagDistanceMeters: 501 }),
      createWorldLookupStub({
        ok: true,
        packageId: "us_nm_v1_lat35_lon-107",
        elevationM: 1514,
        terrainClass: "flat",
        biome: "Deserts & Xeric Shrublands",
        ecoregion: "Colorado Plateau shrublands",
        raw: { profile: { is_land: true, is_saltwater: false } }
      }),
      createConfig(),
      createLoggerStub()
    );

    const result = await service.createForPlayer(createPlayer());

    expect(result.flag).toMatchObject({
      name: "Flag 3",
      claimRadiusM: DEV_FLAG_CLAIM_RADIUS_M,
      packageId: "us_nm_v1_lat35_lon-107"
    });
    expect(calls.some((call) => call.text.includes("ST_Distance"))).toBe(false);
  });

  it("allows flag placement well outside 500m from an existing flag", async () => {
    const calls: QueryCall[] = [];
    const service = new FlagService(
      createPoolStub(calls, "2", { existingFlagDistanceMeters: 600 }),
      createWorldLookupStub({
        ok: true,
        packageId: "us_nm_v1_lat35_lon-107",
        elevationM: 1514,
        terrainClass: "flat",
        biome: "Deserts & Xeric Shrublands",
        ecoregion: "Colorado Plateau shrublands",
        raw: { profile: { is_land: true, is_saltwater: false } }
      }),
      createConfig(),
      createLoggerStub()
    );

    const result = await service.createForPlayer(createPlayer());

    expect(result.flag).toMatchObject({
      name: "Flag 3",
      claimRadiusM: DEV_FLAG_CLAIM_RADIUS_M,
      packageId: "us_nm_v1_lat35_lon-107"
    });
    expect(calls.some((call) => call.text.includes("ST_Distance"))).toBe(false);
  });

  it("maps the database placement fence to a public placement conflict", async () => {
    const service = new FlagService(
      createPoolStub([], "0", {
        insertError: {
          code: "23514",
          constraint: "flags_center_outside_existing_claim"
        }
      }),
      createWorldLookupStub({
        ok: true,
        packageId: "us_nm_v1_lat35_lon-107",
        elevationM: 1514,
        terrainClass: "flat",
        biome: "Deserts & Xeric Shrublands",
        ecoregion: "Colorado Plateau shrublands",
        raw: { profile: { is_land: true, is_saltwater: false } }
      }),
      createConfig(),
      createLoggerStub()
    );

    await expect(service.createForPlayer(createPlayer())).rejects.toMatchObject({
      name: "FlagPlacementError",
      message: "Cannot build here: inside claimed territory"
    });
  });
});

function createPoolStub(
  calls: QueryCall[],
  ownedCount: string,
  options: PoolStubOptions = {}
): pg.Pool {
  const query = async <T>(text: string, values?: readonly unknown[]) => {
      calls.push(values ? { text, values } : { text });
      if (text.includes("WHERE owner_id")) {
        const existingNames =
          options.existingNames ??
          Array.from({ length: Number(ownedCount) }, (_, index) => `Flag ${index + 1}`);
        return {
          rows: existingNames.map((name) => ({ name })) as T[],
          rowCount: existingNames.length
        };
      }
      if (text.includes("FROM flags f") && text.includes("ORDER BY f.")) {
        return {
          rows: (options.listRows ?? []) as T[],
          rowCount: options.listRows?.length ?? 0
        };
      }
      if (text.includes("FROM flags f") && text.includes("WHERE f.id = $1")) {
        const rows = options.getRows ?? [];
        return { rows: rows as T[], rowCount: rows.length };
      }
      if (text.includes("FROM flags flag") && text.includes("ST_DWithin")) {
        const candidates = options.territoryRows
          ? [...options.territoryRows].sort((left, right) =>
              String(left.id).localeCompare(String(right.id)))
          : options.existingFlagDistanceMeters !== undefined &&
              options.existingFlagDistanceMeters <= DEV_FLAG_CLAIM_RADIUS_M + 0.05
            ? [
                createTerritoryFlagRow(
                  "existing-flag",
                  options.existingFlagOwnerId ?? "player-1",
                  options.existingFlagDistanceMeters,
                  options.existingFlagOwnerUsername ?? "Ash"
                )
              ]
            : [];
        return {
          rows: candidates.slice(0, 1) as T[],
          rowCount: Math.min(candidates.length, 1)
        };
      }
      if (text.includes("ST_Distance") && text.includes("FROM flags f")) {
        if (options.territoryRows) {
          return {
            rows: options.territoryRows as T[],
            rowCount: options.territoryRows.length
          };
        }
        const overlaps =
          options.existingFlagDistanceMeters !== undefined || Boolean(options.overlap);
        return {
          rows: (overlaps
            ? [
                createTerritoryFlagRow(
                  "existing-flag",
                  options.existingFlagOwnerId ?? "player-1",
                  options.existingFlagDistanceMeters ?? 0,
                  options.existingFlagOwnerUsername ?? "Ash"
                )
              ]
            : []) as T[],
          rowCount: overlaps ? 1 : 0
        };
      }
      if (text.includes("INSERT INTO flags")) {
        if (options.insertError) throw options.insertError;
        return {
          rows: [rowFromInsert(values)] as T[],
          rowCount: 1
        };
      }
      return {
        rows: [] as T[],
        rowCount: 0
      };
    };
  return {
    query,
    connect: async () => ({ query, release: vi.fn() })
  } as unknown as pg.Pool;
}

function createTerritoryFlagRow(
  id: string,
  ownerId: string,
  distanceMeters: number,
  ownerUsername: string
): Record<string, unknown> {
  return {
    id,
    owner_id: ownerId,
    owner_username: ownerUsername,
    owner_color: ownerId === "player-1" ? "#38bdf8" : "#3366cc",
    name: `${ownerUsername} Flag`,
    lat: 35.0844 + distanceMeters / 111_195,
    lon: -106.6504,
    claim_radius_m: DEV_FLAG_CLAIM_RADIUS_M
  };
}

function createFlagRow(
  id: string,
  ownerId: string,
  name: string
): Record<string, unknown> {
  return {
    id,
    owner_id: ownerId,
    name,
    lat: 35.0844,
    lon: -106.6504,
    package_id: "nm-core",
    elevation_m: 1500,
    terrain_class: "urban",
    biome: "desert",
    ecoregion: "Chihuahuan Desert",
    claim_radius_m: DEV_FLAG_CLAIM_RADIUS_M,
    created_at: createdAt
  };
}

function rowFromInsert(values: readonly unknown[] | undefined): Record<string, unknown> {
  if (!values) {
    throw new Error("expected insert values");
  }
  return {
    id: String(values[0]),
    anchor_kind: String(values[1]),
    owner_id: String(values[2]),
    name: String(values[3]),
    lat: Number(values[4]),
    lon: Number(values[5]),
    package_id: nullableString(values[6]),
    elevation_m: nullableNumber(values[7]),
    terrain_class: nullableString(values[8]),
    biome: nullableString(values[9]),
    ecoregion: nullableString(values[10]),
    claim_radius_m: Number(values[11]),
    resource_vision_radius_m: Number(values[12]),
    created_at: createdAt
  };
}

function createWorldLookupStub(result: WorldLookupResult): WorldLookupClient {
  const releasedResult = result.ok && !result.worldReleaseId && !result.release?.releaseId
    ? { ...result, worldReleaseId: "world-packages-v1" }
    : result;
  return {
    lookup: vi.fn(async () => releasedResult),
    lookupGameplayEnvironment: vi.fn(async () => releasedResult)
  } as unknown as WorldLookupClient;
}

function createLoggerStub(): AppLogger {
  return {
    info: vi.fn(),
    warn: vi.fn()
  } as unknown as AppLogger;
}

function createPlayer(): PlayerRecord {
  return {
    playerId: "player-1",
    username: "Ash",
    displayColor: "#38bdf8",
    regionCode: "NM",
    position: {
      lat: 35.0844,
      lon: -106.6504
    },
    anchor: {
      lat: 35.0844,
      lon: -106.6504
    },
    moveLeashRadiusM: DEV_MOVE_LEASH_RADIUS_M,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date("2026-07-08T09:00:00.000Z")
  };
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      NODE_ENV: "test",
      PLAYER_SPEED_MPS: String(DEV_PLAYER_SPEED_MPS),
      FLAG_CLAIM_RADIUS_M: String(DEV_FLAG_CLAIM_RADIUS_M),
      MOVE_LEASH_RADIUS_M: String(DEV_MOVE_LEASH_RADIUS_M)
    }),
    ...overrides
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
