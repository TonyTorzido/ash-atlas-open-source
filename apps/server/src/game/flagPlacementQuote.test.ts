import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldLookupResult } from "../world/worldTypes.js";
import { WORLD_RUNTIME_CONTRACT } from "../runtime/authorityIdentity.js";
import {
  BUOY_BUILD_COST,
  FLAG_BUILD_COST,
  FlagPlacementError,
  FlagService,
  adjustedFlagBuildDuration
} from "./flags.js";
import type { InventoryService } from "./inventory.js";
import type { MasteryService } from "./masteries.js";
import type { PlayerRecord } from "./state.js";

describe("authoritative flag placement quotes", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the land flag recipe and defines the exact additive buoy recipe", () => {
    expect(FLAG_BUILD_COST).toEqual({ wood: 3, leather: 2 });
    expect(BUOY_BUILD_COST).toEqual({ wood: 3, leather: 3, crude_oil: 1 });
  });

  it.each(["river", "lake", "coastal-ocean", "deep-ocean"] as const)(
    "accepts a buoy on authoritative %s water",
    async (control) => {
      const harness = quoteHarness(authoritativeWater(control));
      const { quote } = await harness.service.createPlacementQuote(harness.player, {
        anchorKind: "buoy"
      });

      await expect(harness.service.prepareForPlayer(
        harness.player,
        undefined,
        quote.quoteId,
        "buoy"
      )).resolves.toMatchObject({
        anchorKind: "buoy",
        buildDurationMs: 10_000,
        materialAffordable: true
      });
      expect(harness.canAfford).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ["authoritative land", undefined],
    ["unavailable World", { ok: false, raw: {} } as WorldLookupResult],
    ["mismatched lake authority", {
      ...authoritativeWater("lake"),
      lakeSurface: {
        ...authoritativeWater("lake").lakeSurface!,
        sourceReleaseId: "stale-lake-surface"
      }
    }]
  ])("fails buoy placement closed for %s", async (_label, override) => {
    const harness = quoteHarness(override);
    const result = await harness.service.tryCreatePlacementQuote(harness.player, {
      anchorKind: "buoy"
    });
    expect(result.placementQuote).toBeUndefined();
    expect(result.failure).toBeDefined();
  });

  it.each([
    [0, 10_000],
    [1, 9_800],
    [2, 9_400],
    [4, 9_200],
    [7, 9_000],
    [8, 8_400]
  ])("applies Builder rank %i to the flag duration", (builderRank, expectedDurationMs) => {
    expect(adjustedFlagBuildDuration(10_000, builderRank)).toBe(expectedDurationMs);
  });

  it("reuses a valid quote with the authoritative base duration at Builder rank zero", async () => {
    const harness = quoteHarness();
    const { quote } = await harness.service.createPlacementQuote(harness.player);
    const prepared = await harness.service.prepareForPlayer(
      harness.player,
      undefined,
      quote.quoteId
    );

    expect(prepared.admissionTimings.quoteState).toBe("hit");
    expect(harness.config.FLAG_BUILD_DURATION_MS).toBe(10_000);
    expect(prepared.buildDurationMs).toBe(10_000);
    expect(harness.lookup).toHaveBeenCalledOnce();
    expect(harness.richLookup).not.toHaveBeenCalled();
    expect(harness.professionRank).toHaveBeenCalledOnce();
    expect(harness.canAfford).toHaveBeenCalledOnce();
  });

  it("preserves the max-rank Builder duration through placement quote consumption", async () => {
    const harness = quoteHarness(undefined, false, 8);
    const { quote } = await harness.service.createPlacementQuote(harness.player);
    const prepared = await harness.service.prepareForPlayer(
      harness.player,
      undefined,
      quote.quoteId
    );

    expect(prepared.builderRank).toBe(8);
    expect(prepared.buildDurationMs).toBe(8_400);
    expect(harness.professionRank).toHaveBeenCalledOnce();
  });

  it("returns a classified failed preview without a duplicate World lookup", async () => {
    const harness = quoteHarness({
      ok: false,
      packageId: null,
      elevationM: null,
      terrainClass: null,
      biome: null,
      ecoregion: null,
      failure: {
        code: "WORLD_LOOKUP_TIMEOUT",
        message: "World validation timed out. Try again shortly.",
        retryable: true,
        retryAfterMs: 2_000
      },
      raw: {}
    });

    await expect(harness.service.tryCreatePlacementQuote(harness.player)).resolves.toMatchObject({
      world: { ok: false, failure: { code: "WORLD_LOOKUP_TIMEOUT" } },
      failure: {
        code: "WORLD_LOOKUP_TIMEOUT",
        retryable: true,
        retryAfterMs: 2_000
      }
    });
    expect(harness.lookup).toHaveBeenCalledOnce();
  });

  it("rejects an expired quote without a World fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00Z"));
    const harness = quoteHarness();
    const { quote } = await harness.service.createPlacementQuote(harness.player);

    vi.setSystemTime(Date.now() + 60_001);
    const error = await rejectedPlacement(harness.service.prepareForPlayer(
      harness.player,
      undefined,
      quote.quoteId
    ));

    expect(error.quoteDiagnostic?.quoteState).toBe("expired");
    expect(harness.lookup).toHaveBeenCalledOnce();
  });

  it.each([
    ["movement-revision-mismatch", (player: PlayerRecord) => { player.movementRevision += 1; }],
    ["position-mismatch", (player: PlayerRecord) => { player.position = { ...player.position, lon: player.position.lon + 0.001 }; }],
    ["world release identity", (_player: PlayerRecord, config: ReturnType<typeof loadConfig>) => {
      (config as { WORLD_REQUIRED_RELEASE_ID: string }).WORLD_REQUIRED_RELEASE_ID = "replacement-release";
    }]
  ])("classifies %s without refreshing inside Build", async (expected, mutate) => {
    const harness = quoteHarness();
    const { quote } = await harness.service.createPlacementQuote(harness.player);
    mutate(harness.player, harness.config);

    const error = await rejectedPlacement(harness.service.prepareForPlayer(
      harness.player,
      undefined,
      quote.quoteId
    ));

    expect(error.quoteDiagnostic?.quoteState).toBe(
      expected === "world release identity" ? "release-mismatch" : expected
    );
    expect(harness.lookup).toHaveBeenCalledOnce();
  });

  it("rejects a missing quote without invoking World", async () => {
    const harness = quoteHarness();

    const error = await rejectedPlacement(
      harness.service.prepareForPlayer(harness.player)
    );

    expect(error.code).toBe("FLAG_QUOTE_NOT_READY");
    expect(error.quoteDiagnostic?.quoteState).toBe("missing");
    expect(harness.lookup).not.toHaveBeenCalled();
  });

  it("uses the latest valid server quote when the client omits its ID", async () => {
    const harness = quoteHarness();
    await harness.service.createPlacementQuote(harness.player);

    const prepared = await harness.service.prepareForPlayer(harness.player);

    expect(prepared.quoteDiagnostic?.quoteState).toBe("hit");
    expect(harness.lookup).toHaveBeenCalledOnce();
  });

  it("returns the same valid server quote for sequential requests with one binding", async () => {
    const harness = quoteHarness();
    const first = await harness.service.createPlacementQuote(harness.player);
    const second = await harness.service.createPlacementQuote(harness.player);

    expect(second.quote.quoteId).toBe(first.quote.quoteId);
    await expect(
      harness.service.prepareForPlayer(harness.player, undefined, first.quote.quoteId)
    ).resolves.toMatchObject({
      quoteDiagnostic: {
        quoteIdPresent: true,
        quoteState: "hit",
        quoteMismatchReason: null
      }
    });
    expect(harness.lookup).toHaveBeenCalledOnce();
    expect(harness.service.placementQuoteMetrics()).toMatchObject({
      quoteCreated: 1,
      quoteReused: 1,
      validQuoteReplacement: 0
    });
  });

  it("does not substitute a latest quote whose binding is stale", async () => {
    const harness = quoteHarness();
    await harness.service.createPlacementQuote(harness.player);
    harness.player.movementRevision += 1;

    const error = await rejectedPlacement(
      harness.service.prepareForPlayer(harness.player, undefined, "replaced-quote-id")
    );

    expect(error.quoteDiagnostic?.quoteState).toBe("unknown-id");
    expect(harness.lookup).toHaveBeenCalledOnce();
  });

  it("does not consume a quote until every binding validates", async () => {
    const harness = quoteHarness();
    const originalPosition = harness.player.position;
    const { quote } = await harness.service.createPlacementQuote(harness.player);
    harness.player.position = { ...originalPosition, lon: originalPosition.lon + 0.001 };

    await expect(
      harness.service.prepareForPlayer(harness.player, undefined, quote.quoteId)
    ).rejects.toMatchObject({
      quoteDiagnostic: { quoteState: "position-mismatch" }
    });
    harness.player.position = originalPosition;

    await expect(
      harness.service.prepareForPlayer(harness.player, undefined, quote.quoteId)
    ).resolves.toMatchObject({
      quoteDiagnostic: { quoteState: "hit" }
    });
  });

  it("records consumed IDs distinctly", async () => {
    const harness = quoteHarness();
    const { quote } = await harness.service.createPlacementQuote(harness.player);
    await harness.service.prepareForPlayer(harness.player, undefined, quote.quoteId);

    const error = await rejectedPlacement(
      harness.service.prepareForPlayer(harness.player, undefined, quote.quoteId)
    );

    expect(error.quoteDiagnostic?.quoteState).toBe("consumed");
  });

  it("replaces an invalid latest quote and retries cleanly", async () => {
    const harness = quoteHarness();
    const first = await harness.service.createPlacementQuote(harness.player);
    harness.player.movementRevision += 1;
    const second = await harness.service.createPlacementQuote(harness.player);

    expect(second.quote.quoteId).not.toBe(first.quote.quoteId);
    await expect(harness.service.prepareForPlayer(harness.player)).resolves.toMatchObject({
      quoteDiagnostic: { quoteState: "hit" }
    });
  });

  it("singleflights concurrent quote preparation for the same binding", async () => {
    const harness = quoteHarness();

    const [first, second] = await Promise.all([
      harness.service.createPlacementQuote(harness.player),
      harness.service.createPlacementQuote(harness.player)
    ]);

    expect(first.quote.quoteId).toBe(second.quote.quoteId);
    expect(harness.lookup).toHaveBeenCalledOnce();
    expect(harness.service.placementQuoteMetrics()).toMatchObject({
      quoteCreated: 1,
      quoteSingleflightJoined: 1,
      validQuoteReplacement: 0
    });
  });

  it("keeps the server-owned quote flight alive after the initiating client aborts", async () => {
    const harness = quoteHarness();
    let resolveLookup!: (value: WorldLookupResult) => void;
    const deferredLookup = new Promise<WorldLookupResult>((resolve) => {
      resolveLookup = resolve;
    });
    harness.lookup.mockImplementationOnce(() => deferredLookup);
    const abort = new AbortController();

    const initiating = harness.service.createPlacementQuote(harness.player, {
      signal: abort.signal
    });
    await vi.waitFor(() => expect(harness.lookup).toHaveBeenCalledOnce());
    abort.abort();
    const joined = harness.service.createPlacementQuote(harness.player);
    resolveLookup({
      ok: true,
      packageId: harness.player.regionCode,
      latitude: harness.player.position.lat,
      longitude: harness.player.position.lon,
      elevationM: 1_600,
      terrainClass: "land",
      biome: "plains",
      ecoregion: "test",
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      worldReleaseId: harness.config.WORLD_REQUIRED_RELEASE_ID,
      raw: {}
    });

    const [first, second] = await Promise.all([initiating, joined]);

    expect(first.quote.quoteId).toBe(second.quote.quoteId);
    expect(harness.lookup).toHaveBeenCalledOnce();
    expect(harness.service.placementQuoteMetrics()).toMatchObject({
      quoteCreated: 1,
      quoteSingleflightJoined: 1
    });
  });

  it("preserves authoritative territory rejection without invoking World", async () => {
    const harness = quoteHarness(undefined, true);

    const result = await harness.service.tryCreatePlacementQuote(harness.player);
    expect(result).toMatchObject({
      failure: {
        code: "FLAG_PLACEMENT_REJECTED",
        domainCode: "FLAG_PLACEMENT_REJECTED",
        failureStage: "territory",
        errorClass: "FlagPlacementError",
        retryable: false
      }
    });
    expect(result.world).toBeUndefined();
    expect(harness.lookup).not.toHaveBeenCalled();
  });
});

function authoritativeWater(
  control: "river" | "lake" | "coastal-ocean" | "deep-ocean"
): WorldLookupResult {
  const kind = control === "river" ? "river" : control === "lake" ? "lake" : "ocean";
  const base: WorldLookupResult = {
    ok: true,
    packageId: "world_v1_lat35_lon-107",
    latitude: 35.0844,
    longitude: -106.6504,
    elevationM: 0,
    terrainClass: "water",
    biome: "water",
    ecoregion: "test",
    surfaceKind: "water",
    waterKind: kind,
    isLand: false,
    isSaltwater: kind === "ocean",
    insideMajorLake: kind === "lake",
    worldReleaseId: "world-packages-v1",
    raw: {}
  };
  if (kind === "river") return {
    ...base,
    riverSurface: {
      surfaceKind: "water", waterKind: "river", isRiver: true,
      cellSizeM: WORLD_RUNTIME_CONTRACT.riverSurface.cellSizeM,
      rowId: 1, columnId: 1,
      sourceReleaseId: WORLD_RUNTIME_CONTRACT.riverSurface.releaseId,
      sourceManifestSha256: WORLD_RUNTIME_CONTRACT.riverSurface.manifestSha256
    }
  };
  if (kind === "lake") return {
    ...base,
    lakeSurface: {
      surfaceKind: "water", waterKind: "lake", isLake: true,
      cellSizeM: WORLD_RUNTIME_CONTRACT.lakeSurface.cellSizeM,
      rowId: 1, columnId: 1,
      sourceReleaseId: WORLD_RUNTIME_CONTRACT.lakeSurface.releaseId,
      sourceManifestSha256: WORLD_RUNTIME_CONTRACT.lakeSurface.manifestSha256
    }
  };
  return {
    ...base,
    oceanCoastSurface: {
      surfaceKind: control === "coastal-ocean" ? "water" : null,
      waterKind: control === "coastal-ocean" ? "ocean" : null,
      isOceanCoast: control === "coastal-ocean",
      cellSizeM: WORLD_RUNTIME_CONTRACT.oceanCoastSurface.cellSizeM,
      rowId: 1, columnId: 1,
      sourceReleaseId: WORLD_RUNTIME_CONTRACT.oceanCoastSurface.releaseId,
      sourceManifestSha256: WORLD_RUNTIME_CONTRACT.oceanCoastSurface.manifestSha256
    }
  };
}

async function rejectedPlacement(
  promise: Promise<unknown>
): Promise<FlagPlacementError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FlagPlacementError);
    return error as FlagPlacementError;
  }
  throw new Error("Expected placement to be rejected");
}

function quoteHarness(
  lookupOverride?: WorldLookupResult,
  coveringTerritory = false,
  builderRank = 0
) {
  const config = loadConfig({
    NODE_ENV: "test",
    ALLOW_UNRESOLVED_FLAGS_IN_DEV: "false"
  });
  const player: PlayerRecord = {
    playerId: "quote-player",
    username: "Quote Player",
    displayColor: "#38bdf8",
    regionCode: "world_v1_lat35_lon-107",
    position: { lat: 35.0844, lon: -106.6504 },
    anchor: { lat: 35.0844, lon: -106.6504 },
    moveLeashRadiusM: 1_250,
    movementRevision: 4,
    relocationRevision: 2,
    target: null,
    online: true,
    updatedAt: new Date()
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("generate_series")) return { rows: [{ name: "Flag 1" }] };
    if (coveringTerritory && sql.includes("ST_DWithin")) {
      return {
        rows: [{
          id: "existing-flag",
          owner_id: player.playerId,
          owner_username: player.username,
          name: "Existing Flag"
        }]
      };
    }
    return { rows: [] };
  });
  const lookupResult = {
    ok: true,
    packageId: player.regionCode,
    latitude: player.position.lat,
    longitude: player.position.lon,
    elevationM: 1_600,
    terrainClass: "land",
    biome: "plains",
    ecoregion: "test",
    isLand: true,
    isSaltwater: false,
    insideMajorLake: false,
    worldReleaseId: config.WORLD_REQUIRED_RELEASE_ID,
    raw: {}
  } as WorldLookupResult;
  const lookup = vi.fn(async () => lookupOverride ?? lookupResult);
  const richLookup = vi.fn();
  const professionRank = vi.fn(async () => builderRank);
  const canAfford = vi.fn(async () => true);
  const service = new FlagService(
    { query } as never,
    {
      lookup: richLookup,
      lookupGameplayEnvironment: lookup,
      gameplayEnvironmentMetrics: () => ({
        entries: 1,
        negativeEntries: 0,
        inFlight: 0,
        inFlightBatches: 0,
        hits: 1,
        negativeHits: 0,
        misses: 1,
        builds: 1,
        upstreamAttempts: 1,
        sharedWaits: 0,
        batchBuilds: 0,
        batchUpstreamAttempts: 0,
        batchSharedWaits: 0,
        batchPoints: 0,
        evictions: 0,
        staleExpirations: 0,
        negativeExpirations: 0,
        authorityInvalidations: 0,
        failureClassifications: {}
      })
    } as unknown as WorldLookupClient,
    config,
    { info: vi.fn(), warn: vi.fn() } as unknown as AppLogger,
    { canAfford } as unknown as InventoryService,
    { professionRank } as unknown as MasteryService
  );
  return { service, player, config, lookup, richLookup, professionRank, canAfford };
}
