import { createServer, type IncomingMessage } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppLogger } from "../logger.js";
import type { WorldBatchBackpressureError } from "./worldLookupClient.js";
import {
  normalizeGameplayEnvironment,
  normalizeWorldLookup,
  WorldLookupClient
} from "./worldLookupClient.js";

describe("normalizeWorldLookup", () => {
  it("normalizes the exact nested global release contract", () => {
    const raw = {
      ok: true,
      covered: true,
      release: {
        release_id: "world-packages-v1",
        profile_set_fingerprint: "profile-fingerprint",
        build_contract_fingerprint: "contract-fingerprint",
        boundary_release_id: "world-boundaries-v1",
        package_count: 64800
      },
      selected_package: {
        package_id: "world_v1_lat35_lon-107"
      },
      profile: {
        environment_schema_version: "world-profile-v2",
        latitude: 35.0844,
        longitude: -106.6504,
        administrative: {
          country_id: "country-id",
          country_name: "United States",
          country_code: "US",
          region_id: "region-id",
          region_name: "New Mexico",
          region_code: "US-NM",
          city_id: "city-id",
          city_name: "Albuquerque",
          inside_city: true,
          city_boundary_distance_m: 1200
        },
        environment: {
          elevation_m: 1513,
          terrain_class: "flat",
          land_cover_class: "urban",
          source_land_cover_code: 50,
          biome_id: "13",
          biome_name: "Deserts & Xeric Shrublands",
          ecoregion_id: "321",
          ecoregion_name: "Colorado Plateau shrublands",
          is_land: true,
          is_saltwater: false,
          is_coastal: false,
          is_coastal_land: true,
          is_riverbank: true,
          is_lakeshore: true,
          coastline_distance_m: 10600,
          land_cover_conflict: false,
          ecology_resolution: "exact",
          ecology_distance_m: 0,
          ecology_source_package_id: "world_v1_lat35_lon-107",
          ecology_fallback_max_m: 10000
        },
        water: {
          inside_major_lake: false,
          nearest_named_river_id: "river-id",
          nearest_named_river_name: "Rio Grande",
          river_class: "major_named_river",
          river_distance_m: 2085,
          nearest_supporting_river_id: 20287927,
          supporting_river_flow_order: 6,
          supporting_river_discharge_cms: 2.692,
          supporting_river_drainage_area_sq_km: 9.36,
          supporting_river_distance_m: 1200,
          nearest_water_source_type: "supporting_river",
          nearest_water_source_id: 20287927,
          nearest_water_source_kind: "fresh",
          nearest_water_source_distance_m: 1200,
          nearest_water_resolution: "within_search_radius",
          nearest_water_search_radius_m: 25000,
          nearest_water_search_complete: true,
          ocean_depth_class: "not_applicable"
        },
        flag_placement_water: {
          blocked: false,
          kind: "land",
          source_id: null,
          source_name: null,
          distance_m: null,
          corridor_radius_m: null,
          reason: "authoritative land",
          resolution: "water-placement-surface-v1",
          release_id: "world-packages-v1"
        },
        derived_tags: ["inside_city", "near_major_river"],
        source_versions: {
          ecoregions: "2017",
          elevation: "GMTED2010_mean_30s"
        },
        warnings: []
      }
    };

    expect(normalizeWorldLookup(raw, { latitude: 35.0844, longitude: -106.6504 })).toMatchObject({
      ok: true,
      packageId: "world_v1_lat35_lon-107",
      countryCode: "US",
      regionCode: "US-NM",
      cityName: "Albuquerque",
      insideCity: true,
      elevationM: 1513,
      terrainClass: "flat",
      landCoverClass: "urban",
      sourceLandCoverCode: 50,
      biome: "Deserts & Xeric Shrublands",
      ecoregion: "Colorado Plateau shrublands",
      isLand: true,
      isSaltwater: false,
      isCoastal: false,
      isCoastalLand: true,
      isRiverbank: true,
      isLakeshore: true,
      coastlineDistanceM: 10600,
      ecologyResolution: "exact",
      ecologyDistanceM: 0,
      ecologySourcePackageId: "world_v1_lat35_lon-107",
      insideMajorLake: false,
      namedRiverName: "Rio Grande",
      riverDistanceM: 2085,
      supportingRiverId: "20287927",
      supportingRiverFlowOrder: 6,
      nearestWaterSourceType: "supporting_river",
      nearestWaterSourceId: "20287927",
      nearestWaterSourceKind: "fresh",
      nearestWaterSourceDistanceM: 1200,
      nearestWaterResolution: "within_search_radius",
      flagPlacementWater: {
        blocked: false,
        kind: "land",
        reason: "authoritative land",
        releaseId: "world-packages-v1"
      },
      environmentSchemaVersion: "world-profile-v2",
      derivedTags: ["inside_city", "near_major_river"],
      worldReleaseId: "world-packages-v1",
      sourceVersions: {
        ecoregions: "2017",
        elevation: "GMTED2010_mean_30s"
      },
      raw
    });
  });

  it("normalizes additive shoreline facts without deriving them from distance or surface membership", () => {
    const point = { lat: 35, lon: -106 };
    const payload = gameplayEnvironment(point.lat, point.lon);
    Object.assign(payload.result, {
      isLand: true,
      isSaltwater: false,
      isCoastalLand: true,
      isRiverbank: true,
      isLakeshore: true,
      isCoastal: true,
      riverDistanceM: 12,
      majorLakeDistanceM: 24,
      surfaceKind: "land",
      waterKind: null,
      riverSurface: {
        surface_kind: null,
        water_kind: null,
        is_river: false,
        cell_size_m: 125,
        row_id: 10,
        column_id: 20,
        source_release_id: "river-surface-v1",
        source_manifest_sha256: "a".repeat(64)
      },
      lakeSurface: {
        surface_kind: null,
        water_kind: null,
        is_lake: false,
        cell_size_m: 125,
        row_id: 10,
        column_id: 20,
        source_release_id: "lake-surface-v1",
        source_manifest_sha256: "b".repeat(64)
      }
    });

    expect(normalizeGameplayEnvironment(payload, { point })).toMatchObject({
      ok: true,
      isCoastalLand: true,
      isRiverbank: true,
      isLakeshore: true,
      riverDistanceM: 12,
      majorLakeDistanceM: 24,
      riverSurface: { isRiver: false },
      lakeSurface: { isLake: false }
    });

    (payload.result as Record<string, unknown>).isRiverbank = false;
    (payload.result as Record<string, unknown>).isLakeshore = false;
    (payload.result as Record<string, unknown>).riverDistanceM = 501;
    (payload.result as Record<string, unknown>).majorLakeDistanceM = 501;
    expect(normalizeGameplayEnvironment(payload, { point })).toMatchObject({
      ok: true,
      isRiverbank: false,
      isLakeshore: false,
      riverDistanceM: 501,
      majorLakeDistanceM: 501
    });

    const missingFact = gameplayEnvironment(point.lat, point.lon);
    delete (missingFact.result as Record<string, unknown>).isRiverbank;
    expect(normalizeGameplayEnvironment(missingFact, { point })).toMatchObject({
      ok: false,
      failure: { code: "WORLD_RESPONSE_INVALID" }
    });
  });

  it("fails closed when the authority reports a point outside active coverage", () => {
    const requiredRelease = {
      releaseId: "world-packages-v1",
      profileSetFingerprint: "profile-fingerprint",
      buildContractFingerprint: "contract-fingerprint",
      boundaryReleaseId: "world-boundaries-v1"
    };
    expect(normalizeWorldLookup({
      ok: true,
      covered: false,
      release: health().release,
      selected_package: null,
      profile: {
        latitude: 35.0844,
        longitude: -106.6504,
        is_land: null,
        is_saltwater: null,
        terrain_class: "unknown",
        warnings: ["coordinate is outside all active regional packages"]
      }
    }, {
      latitude: 35.0844,
      longitude: -106.6504,
      requiredRelease
    })).toMatchObject({
      ok: false,
      packageId: null,
      isLand: null,
      isSaltwater: null,
      failure: {
        code: "WORLD_COORDINATE_UNCOVERED",
        retryable: false
      },
      warning: "This location is outside available world coverage."
    });

    const mismatched = health().release;
    mismatched.release_id = "replacement-release";
    expect(normalizeWorldLookup({
      ok: true,
      covered: false,
      release: mismatched,
      selected_package: null,
      profile: {
        latitude: 35.0844,
        longitude: -106.6504
      }
    }, {
      latitude: 35.0844,
      longitude: -106.6504,
      requiredRelease
    })).toMatchObject({
      ok: false,
      failure: {
        code: "WORLD_RELEASE_MISMATCH",
        retryable: true
      }
    });
  });
});

describe("WorldLookupClient.isReachable", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires both successful HTTP and an authoritative healthy body", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => response(health()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().isReachable()).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8765/api/health");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports degraded when HTTP is 200 but the World database is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ok: false, release: health().release })));

    await expect(client().isReachable()).resolves.toBe(false);
  });

  it("reports unreachable for non-ok HTTP, malformed JSON, or transport failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true }, 503))
      .mockResolvedValueOnce(response("not a health object"))
      .mockRejectedValueOnce(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);
    const world = client();

    await expect(world.isReachable()).resolves.toBe(false);
    await expect(world.isReachable()).resolves.toBe(false);
    await expect(world.isReachable()).resolves.toBe(false);
  });

  it("requires the pinned waterbody identity overlay authority when configured", async () => {
    const expected = {
      ...health(),
      runtime: {
        sha: "bd9432f46436402d8edb8b914dd2300c997508fb",
        branch: "main"
      },
      waterbody_identity_overlay: {
        release_id: "waterbody-identity-overlay-v4",
        manifest_sha256: "d".repeat(64),
        schema: "waterbody-identity-overlay-v1",
        schema_version: "waterbody-identity-overlay-v1",
        policy: "existing-cell-candidate-precedence-v1",
        policy_version: "existing-cell-candidate-precedence-v1"
      },
      capabilities: { waterbodyIdentityV1: true }
    };
    const required = {
      runtimeSha: expected.runtime.sha,
      releaseId: "waterbody-identity-overlay-v4",
      manifestSha256: "d".repeat(64),
      schema: "waterbody-identity-overlay-v1",
      schemaVersion: "waterbody-identity-overlay-v1",
      policy: "existing-cell-candidate-precedence-v1",
      policyVersion: "existing-cell-candidate-precedence-v1"
    };
    const fetchMock = vi.fn(async () => response(expected));
    vi.stubGlobal("fetch", fetchMock);
    const world = new WorldLookupClient(
      "http://127.0.0.1:8765",
      { warn: vi.fn(), info: vi.fn() } as unknown as AppLogger,
      2_000,
      undefined,
      10_000,
      { maxEntries: 2, maxBytes: 100_000, ttlMs: 60_000 },
      undefined,
      undefined,
      undefined,
      required
    );

    await expect(world.verifyRequiredRelease()).resolves.toMatchObject({
      releaseId: "world-packages-v1"
    });
    expected.waterbody_identity_overlay.manifest_sha256 = "e".repeat(64);
    await expect(world.verifyRequiredRelease()).rejects.toThrow(/waterbody identity authority/u);
  });
});

describe("WorldLookupClient.lookupMany", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the bounded batch endpoint and preserves exact response order", async () => {
    const points = [{ lat: 35, lon: -106 }, { lat: 36, lon: 140 }];
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => response({
      ok: true,
      release: health().release,
      results: points.map((point) => exactLookup(point.lat, point.lon))
    }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await client().lookupMany(points);
    expect(results.map((result) => [result.latitude, result.longitude])).toEqual([
      [35, -106],
      [36, 140]
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8765/api/lookup-batch"
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      points: [
        { latitude: 35, longitude: -106 },
        { latitude: 36, longitude: 140 }
      ]
    });
  });

  it("rejects count, coordinate, and release-correspondence mismatches", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true, release: health().release, results: [] }))
      .mockResolvedValueOnce(response({
        ok: true,
        release: health().release,
        results: [exactLookup(1, 2)]
      }));
    vi.stubGlobal("fetch", fetchMock);
    const world = client();
    await expect(world.lookupMany([{ lat: 1, lon: 2 }])).rejects.toThrow(/count/);
    await expect(world.lookupMany([{ lat: 2, lon: 1 }])).rejects.toThrow(/coordinate/);
  });

  it("aborts the active fetch when the caller cancels", async () => {
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), {
          once: true
        });
      })));
    const controller = new AbortController();
    const pending = client().lookupMany([{ lat: 35, lon: -106 }], {
      signal: controller.signal
    });
    controller.abort(new Error("session canceled"));
    await expect(pending).rejects.toThrow("session canceled");
  });
});

describe("WorldLookupClient interactive lookup cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("singleflights concurrent exact lookups and reuses the bounded TTL entry", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const world = client();

    const first = world.lookup(35, -106);
    const shared = world.lookup(35, -106);
    resolveFetch(response(exactLookup(35, -106)));
    await Promise.all([first, shared]);
    await world.lookup(35, -106);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(world.interactiveLookupCacheMetrics()).toMatchObject({
      entries: 1,
      hits: 1,
      misses: 1,
      builds: 1,
      sharedWaits: 1,
      evictions: 0
    });
  });

  it("briefly caches classified failures, then retries after expiration", async () => {
    let now = 100;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: false }, 503))
      .mockResolvedValueOnce(response(exactLookup(35, -106)));
    vi.stubGlobal("fetch", fetchMock);
    const world = cacheClient({
      maxEntries: 2,
      maxBytes: 100_000,
      ttlMs: 60_000,
      now: () => now
    });

    const failed = await world.lookup(35, -106);
    const cached = await world.lookup(35, -106);
    expect(failed.failure).toMatchObject({
      code: "WORLD_AUTHORITY_OVERLOADED",
      retryable: true,
      retryAfterMs: 2_000
    });
    expect(cached).toEqual(failed);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(world.interactiveLookupCacheMetrics()).toMatchObject({
      negativeEntries: 1,
      negativeHits: 1,
      upstreamAttempts: 1,
      failureClassifications: { WORLD_AUTHORITY_OVERLOADED: 1 }
    });

    now += 2_001;
    await expect(world.lookup(35, -106)).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(world.interactiveLookupCacheMetrics()).toMatchObject({
      negativeEntries: 0,
      negativeExpirations: 1,
      upstreamAttempts: 2
    });
  });

  it("preserves timeout, release mismatch, and malformed-response classifications", async () => {
    vi.useFakeTimers();
    const timeoutFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      }));
    vi.stubGlobal("fetch", timeoutFetch);
    const timed = client();
    const pending = timed.lookup(35, -106);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({
      failure: { code: "WORLD_LOOKUP_TIMEOUT", retryable: true }
    });
    vi.useRealTimers();

    const mismatched = exactLookup(35, -106);
    mismatched.release.release_id = "replacement-release";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(mismatched))
      .mockResolvedValueOnce(response("not-an-object"));
    vi.stubGlobal("fetch", fetchMock);
    const required = clientWithRequiredRelease();
    await expect(required.lookup(35, -106)).resolves.toMatchObject({
      failure: { code: "WORLD_RELEASE_MISMATCH", retryable: true }
    });
    await expect(required.lookup(36, -106)).resolves.toMatchObject({
      failure: { code: "WORLD_RESPONSE_INVALID", retryable: true }
    });
  });

  it("does not cache a lookup abandoned by its only caller", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        }))
      .mockResolvedValueOnce(response(exactLookup(35, -106)));
    vi.stubGlobal("fetch", fetchMock);
    const world = client();
    const controller = new AbortController();
    const abandoned = world.lookup(35, -106, { signal: controller.signal });
    controller.abort(new Error("preview disconnected"));
    await expect(abandoned).rejects.toThrow("preview disconnected");
    await expect(world.lookup(35, -106)).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(world.interactiveLookupCacheMetrics()).toMatchObject({
      entries: 1,
      upstreamAttempts: 2
    });
  });
});

describe("WorldLookupClient compact gameplay environments", () => {
  it("normalizes canonical waterbody metadata with explicit resolution states", () => {
    const point = { lat: 35.0844, lon: -106.6504 };
    const cases = [
      {
        identity: {
          canonical_waterbody_id: "canonical-river-1",
          gameplay_water_type: "river",
          display_name: "Rio Grande",
          resolution_status: "mapped",
          candidate_count: 1
        },
        status: "resolved"
      },
      {
        identity: {
          canonical_waterbody_id: "canonical-river-compact-1",
          gameplay_water_type: "river",
          display_name: "Rio Grande",
          resolution_state: "mapped",
          candidate_count: 1
        },
        status: "resolved"
      },
      {
        identity: {
          canonical_waterbody_id: null,
          gameplay_water_type: "lake",
          display_name: null,
          resolution_status: "unresolved",
          candidate_count: 1
        },
        status: "unresolved"
      },
      {
        identity: {
          canonical_waterbody_id: null,
          gameplay_water_type: "lake",
          display_name: null,
          resolution_status: "ambiguous_same_precedence",
          candidate_count: 2
        },
        status: "ambiguous"
      },
      {
        identity: {
          canonical_waterbody_id: "raw-source-id",
          gameplay_water_type: "lake",
          display_name: "Bad",
          resolution_status: "unrecognized",
          candidate_count: 1
        },
        status: "invalid"
      }
    ] as const;

    for (const testCase of cases) {
      const payload = gameplayEnvironment(point.lat, point.lon);
      (payload.result as Record<string, unknown>).waterbodyIdentity = testCase.identity;
      const normalized = normalizeGameplayEnvironment(payload, { point });
      expect(normalized.ok).toBe(true);
      expect(normalized.waterbodyIdentity).toMatchObject({
        resolutionStatus: testCase.status
      });
    }
  });

  it("keeps water-name fallback metadata presentation-only", () => {
    const point = { lat: 35.0844, lon: -106.6504 };
    const payload = gameplayEnvironment(point.lat, point.lon);
    (payload.result as Record<string, unknown>).waterbodyIdentity = {
      canonical_waterbody_id: null,
      gameplay_water_type: "river",
      display_name: null,
      resolution_status: "unresolved",
      candidate_count: 1
    };
    (payload.result as Record<string, unknown>).water_name_fallback = {
      name: "Grand River",
      water_class: "river",
      distance_m: 8,
      authority: "water-names-v1",
      reference_id: "grand-river-name"
    };
    const normalized = normalizeGameplayEnvironment(payload, { point });
    expect(normalized.waterbodyIdentity).toMatchObject({
      canonicalWaterbodyId: null,
      resolutionStatus: "unresolved"
    });
    expect(normalized.waterNameFallback).toEqual({
      name: "Grand River",
      waterClass: "river",
      distanceM: 8,
      authority: "water-names-v1",
      referenceId: "grand-river-name"
    });
  });

  it.each([
    {
      kind: "lake" as const,
      isSaltwater: false,
      displayName: "Lake Superior",
      canonicalId: "lake-canonical-1",
      surfaceKey: "lakeSurface" as const,
      surface: {
        surface_kind: "water",
        water_kind: "lake",
        is_lake: true,
        cell_size_m: 125,
        row_id: 100,
        column_id: 101,
        source_release_id: "lake-surface-v1",
        source_manifest_sha256: "b".repeat(64),
        lake_id: "legacy-lake-id",
        lake_name: "Legacy Lake Name"
      }
    },
    {
      kind: "ocean" as const,
      isSaltwater: true,
      displayName: "Atlantic Ocean",
      canonicalId: "ocean-canonical-1",
      surfaceKey: "oceanCoastSurface" as const,
      surface: {
        surface_kind: "water",
        water_kind: "ocean",
        is_ocean_coast: true,
        cell_size_m: 125,
        row_id: 100,
        column_id: 101,
        source_release_id: "ocean-coast-surface-v1",
        source_manifest_sha256: "c".repeat(64)
      }
    }
  ])("reads canonical $kind metadata without legacy IDs", ({
    kind,
    isSaltwater,
    displayName,
    canonicalId,
    surfaceKey,
    surface
  }) => {
    const point = { lat: 35.0844, lon: -106.6504 };
    const payload = gameplayEnvironment(point.lat, point.lon);
    Object.assign(payload.result, {
      isLand: false,
      isSaltwater,
      isCoastalLand: false,
      insideMajorLake: kind === "lake",
      surfaceKind: "water",
      waterKind: kind,
      waterbodyIdentity: {
        canonical_waterbody_id: canonicalId,
        gameplay_water_type: kind,
        display_name: displayName,
        resolution_status: "resolved",
        candidate_count: 1,
        parent_canonical_waterbody_id: kind === "ocean" ? "broad-ocean-parent" : null
      },
      [surfaceKey]: surface,
      flagPlacementWater: {
        blocked: true,
        kind,
        source_id: "legacy-source-id",
        source_name: "Legacy source name",
        distance_m: 0,
        corridor_radius_m: null,
        reason: `canonical ${kind}`,
        resolution: "water-placement-surface-v2",
        release_id: payload.release.release_id
      }
    });

    const normalized = normalizeGameplayEnvironment(payload, { point });
    expect(normalized).toMatchObject({
      ok: true,
      waterKind: kind,
      waterbodyIdentity: {
        canonicalWaterbodyId: canonicalId,
        gameplayWaterType: kind,
        displayName,
        resolutionStatus: "resolved",
        candidateCount: 1,
        parentCanonicalWaterbodyId: kind === "ocean" ? "broad-ocean-parent" : null
      }
    });
  });

  it("preserves legacy river-corridor blocks outside canonical river cells", () => {
    const point = { lat: 35.0644, lon: -106.6694 };
    const payload = gameplayEnvironment(point.lat, point.lon);
    const normalized = normalizeGameplayEnvironment({
      ...payload,
      result: {
        ...payload.result,
        surfaceKind: "land",
        waterKind: null,
        riverSurface: {
          surface_kind: null,
          water_kind: null,
          is_river: false,
          cell_size_m: 125,
          row_id: 126918,
          column_id: 65305,
          source_release_id: "river-surface-v1",
          source_manifest_sha256: "a".repeat(64)
        },
        flagPlacementWater: {
          blocked: true,
          kind: "river",
          source_id: "legacy-river-corridor",
          source_name: null,
          distance_m: 0,
          corridor_radius_m: 50,
          reason: "inside legacy river corridor",
          release_id: payload.release.release_id,
          resolution: "water-placement-surface-v1"
        }
      }
    }, {
      point,
      requiredRelease: {
        releaseId: payload.release.release_id,
        profileSetFingerprint: payload.release.profile_set_fingerprint,
        buildContractFingerprint: payload.release.build_contract_fingerprint,
        boundaryReleaseId: payload.release.boundary_release_id
      },
      requiredRiverAuthority: {
        runtimeSha: payload.runtime.sha,
        releaseId: "river-surface-v1",
        manifestSha256: "a".repeat(64),
        policy: "osm-medium-plus-v1",
        cellSizeM: 125
      }
    });

    expect(normalized.ok).toBe(true);
    expect(normalized.waterKind).toBeNull();
    expect(normalized.riverSurface).toMatchObject({
      isRiver: false,
      rowId: 126918,
      columnId: 65305,
      sourceReleaseId: "river-surface-v1"
    });
    expect(normalized.flagPlacementWater?.kind).toBe("river");
  });

  it("finds a qualifying adjacent final river cell without legacy river distance", async () => {
    const radius = 6_378_137;
    const halfWorld = Math.PI * radius;
    const x = -halfWorld + (100.5 * 125);
    const y = halfWorld - (100.5 * 125);
    const point = {
      lat: (Math.atan(Math.exp(y / radius)) * 2 - Math.PI / 2) * (180 / Math.PI),
      lon: (x / radius) * (180 / Math.PI)
    };
    const originPayload = gameplayEnvironment(point.lat, point.lon);
    Object.assign(originPayload.result, {
      surfaceKind: "land",
      waterKind: null,
      riverSurface: {
        surface_kind: null,
        water_kind: null,
        is_river: false,
        cell_size_m: 125,
        row_id: 100,
        column_id: 100,
        source_release_id: "river-surface-v1",
        source_manifest_sha256: "a".repeat(64)
      },
      lakeSurface: {
        surface_kind: null,
        water_kind: null,
        is_lake: false,
        cell_size_m: 125,
        row_id: 100,
        column_id: 100,
        source_release_id: "lake-surface-v1",
        source_manifest_sha256: "b".repeat(64)
      },
      oceanCoastSurface: {
        surface_kind: null,
        water_kind: null,
        is_ocean_coast: false,
        cell_size_m: 125,
        row_id: 100,
        column_id: 100,
        source_release_id: "ocean-coast-surface-v1",
        source_manifest_sha256: "c".repeat(64)
      }
    });
    const origin = normalizeGameplayEnvironment(originPayload, { point });
    expect(origin.ok).toBe(true);

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        points: Array<{ latitude: number; longitude: number }>;
      };
      const rows = body.points.map((candidatePoint, index) => {
        const candidate = index === 61; // row offset 0, column offset +1 in the bounded grid.
        const payload = gameplayEnvironment(candidatePoint.latitude, candidatePoint.longitude);
        Object.assign(payload.result, {
          isLand: !candidate,
          isSaltwater: false,
          surfaceKind: candidate ? "water" : "land",
          waterKind: candidate ? "river" : null,
          namedRiverId: null,
          namedRiverName: null,
          riverDistanceM: null,
          riverSurface: {
            surface_kind: candidate ? "water" : null,
            water_kind: candidate ? "river" : null,
            is_river: candidate,
            cell_size_m: 125,
            row_id: 100,
            column_id: candidate ? 101 : 100,
            source_release_id: "river-surface-v1",
            source_manifest_sha256: "a".repeat(64),
            ...(candidate ? { canonical_feature_id: "river-grid-1" } : {})
          },
          lakeSurface: {
            surface_kind: null,
            water_kind: null,
            is_lake: false,
            cell_size_m: 125,
            row_id: 100,
            column_id: candidate ? 101 : 100,
            source_release_id: "lake-surface-v1",
            source_manifest_sha256: "b".repeat(64)
          },
          oceanCoastSurface: {
            surface_kind: null,
            water_kind: null,
            is_ocean_coast: false,
            cell_size_m: 125,
            row_id: 100,
            column_id: candidate ? 101 : 100,
            source_release_id: "ocean-coast-surface-v1",
            source_manifest_sha256: "c".repeat(64)
          },
          waterbodyIdentity: candidate
            ? {
                canonicalWaterbodyId: "canonical-river-id",
                gameplayWaterType: "river",
                displayName: "Rio Grande",
                resolutionStatus: "resolved",
                candidateCount: 1
              }
            : null,
          flagPlacementWater: candidate
            ? {
                blocked: true,
                kind: "river",
                source_id: "river-surface-v1:100:101",
                source_name: null,
                distance_m: 0,
                corridor_radius_m: null,
                reason: "canonical river",
                resolution: "water-placement-surface-v2",
                release_id: "world-packages-v1"
              }
            : payload.result.flagPlacementWater
        });
        return payload.result;
      });
      return response({
        ok: true,
        contract_version: "gameplay-environment-v1",
        release: health().release,
        runtime: gameplayEnvironment(0, 0).runtime,
        results: rows
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await client().lookupCanonicalWaterbodyNear(point, origin, 500);
    expect(result).toMatchObject({
      kind: "river",
      sourceId: "canonical-river-id",
      sourceName: "Rio Grande",
      distanceM: 62.5,
      searchComplete: true
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("searches canonical water cells across the antimeridian", async () => {
    const radius = 6_378_137;
    const halfWorld = Math.PI * radius;
    const lastFullColumn = Math.floor((2 * halfWorld) / 125) - 1;
    const x = -halfWorld + ((lastFullColumn + 0.5) * 125);
    const y = halfWorld - (100.5 * 125);
    const point = {
      lat: (Math.atan(Math.exp(y / radius)) * 2 - Math.PI / 2) * (180 / Math.PI),
      lon: (x / radius) * (180 / Math.PI)
    };
    const surface = (kind: "river" | "lake" | "ocean_coast", columnId: number, water: boolean) => ({
      surface_kind: water ? "water" : null,
      water_kind: water ? "ocean" : null,
      [`is_${kind}`]: water,
      cell_size_m: 125,
      row_id: 100,
      column_id: columnId,
      source_release_id: `${kind}-surface-v1`,
      source_manifest_sha256: "a".repeat(64)
    });
    const originPayload = gameplayEnvironment(point.lat, point.lon);
    Object.assign(originPayload.result, {
      surfaceKind: "land",
      waterKind: null,
      riverSurface: surface("river", lastFullColumn, false),
      lakeSurface: surface("lake", lastFullColumn, false),
      oceanCoastSurface: surface("ocean_coast", lastFullColumn, false)
    });
    const origin = normalizeGameplayEnvironment(originPayload, { point });
    const requestedColumns = new Set<number>();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        points: Array<{ latitude: number; longitude: number }>;
      };
      const rows = body.points.map((candidatePoint) => {
        const columnId = Math.floor(
          (radius * candidatePoint.longitude * (Math.PI / 180) + halfWorld) / 125
        );
        requestedColumns.add(columnId);
        const candidate = columnId === 0;
        const payload = gameplayEnvironment(candidatePoint.latitude, candidatePoint.longitude);
        Object.assign(payload.result, {
          isLand: !candidate,
          surfaceKind: candidate ? "water" : "land",
          waterKind: candidate ? "ocean" : null,
          riverSurface: surface("river", columnId, false),
          lakeSurface: surface("lake", columnId, false),
          oceanCoastSurface: surface("ocean_coast", columnId, candidate),
          waterbodyIdentity: candidate
            ? {
                canonicalWaterbodyId: "canonical-pacific",
                gameplayWaterType: "ocean",
                displayName: "Pacific Ocean",
                resolutionStatus: "resolved",
                candidateCount: 1
              }
            : null
        });
        return payload.result;
      });
      return response({
        ok: true,
        contract_version: "gameplay-environment-v1",
        release: health().release,
        runtime: gameplayEnvironment(0, 0).runtime,
        results: rows
      });
    }));
    const result = await client().lookupCanonicalWaterbodyNear(point, origin, 500);
    expect(requestedColumns.has(0)).toBe(true);
    expect(result).toMatchObject({ kind: "ocean", sourceId: "canonical-pacific", searchComplete: true });
    expect(result?.distanceM).toBeGreaterThan(50);
    expect(result?.distanceM).toBeLessThan(150);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("uses the compact endpoint, singleflights subscribers, and never calls rich lookup", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn<
      (_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>
    >(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const world = client();

    const first = world.lookupGameplayEnvironment(29.9511, -90.0715);
    const shared = world.lookupGameplayEnvironment(29.9511, -90.0715);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8765/api/gameplay-environment?lat=29.9511&lon=-90.0715"
    );
    resolveFetch(response(gameplayEnvironment(29.9511, -90.0715)));

    await expect(Promise.all([first, shared])).resolves.toEqual([
      expect.objectContaining({
        ok: true,
        packageId: "world_v1_lat29_lon-091",
        isCoastal: true,
        isCoastalLand: true,
        flagPlacementWater: expect.objectContaining({ blocked: false, kind: "land" })
      }),
      expect.objectContaining({ ok: true })
    ]);
    await world.lookupGameplayEnvironment(29.9511, -90.0715);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(world.gameplayEnvironmentMetrics()).toMatchObject({
      entries: 1,
      hits: 1,
      misses: 2,
      builds: 1,
      upstreamAttempts: 1,
      sharedWaits: 1
    });
  });

  it("returns defensive compact authority copies to subscribers and cache readers", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));
    const world = client();

    const firstPromise = world.lookupGameplayEnvironment(29.9511, -90.0715);
    const secondPromise = world.lookupGameplayEnvironment(29.9511, -90.0715);
    resolveFetch(response(gameplayEnvironment(29.9511, -90.0715)));
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    (first.flagPlacementWater as { blocked: boolean }).blocked = true;
    first.release!.releaseId = "mutated-release";
    (first.raw as { result: { packageId: string } }).result.packageId = "mutated-package";
    expect(second).toMatchObject({
      packageId: "world_v1_lat29_lon-091",
      release: { releaseId: "world-packages-v1" },
      flagPlacementWater: { blocked: false }
    });

    await expect(world.lookupGameplayEnvironment(29.9511, -90.0715)).resolves.toMatchObject({
      packageId: "world_v1_lat29_lon-091",
      release: { releaseId: "world-packages-v1" },
      flagPlacementWater: { blocked: false }
    });
  });

  it("keeps an upstream request alive while another subscriber remains", async () => {
    let resolveFetch!: (response: Response) => void;
    let upstreamAborted = false;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
        init?.signal?.addEventListener("abort", () => {
          upstreamAborted = true;
        }, { once: true });
      })));
    const world = client();
    const controller = new AbortController();
    const canceled = world.lookupGameplayEnvironment(35, -106, {
      signal: controller.signal
    });
    const remaining = world.lookupGameplayEnvironment(35, -106);

    controller.abort(new Error("preview moved"));
    await expect(canceled).rejects.toThrow("preview moved");
    expect(upstreamAborted).toBe(false);
    resolveFetch(response(gameplayEnvironment(35, -106)));
    await expect(remaining).resolves.toMatchObject({ ok: true });
  });

  it("briefly caches classified failures and retries after the negative TTL", async () => {
    let now = 100;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: false }, 503))
      .mockResolvedValueOnce(response(gameplayEnvironment(35, -106)));
    vi.stubGlobal("fetch", fetchMock);
    const world = cacheClient({
      maxEntries: 2,
      maxBytes: 100_000,
      ttlMs: 60_000,
      now: () => now
    });

    await expect(world.lookupGameplayEnvironment(35, -106)).resolves.toMatchObject({
      failure: { code: "WORLD_AUTHORITY_OVERLOADED" }
    });
    await world.lookupGameplayEnvironment(35, -106);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(world.gameplayEnvironmentMetrics()).toMatchObject({
      negativeEntries: 1,
      negativeHits: 1
    });

    now += 2_001;
    await expect(world.lookupGameplayEnvironment(35, -106)).resolves.toMatchObject({
      ok: true
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(world.gameplayEnvironmentMetrics()).toMatchObject({
      negativeEntries: 0,
      negativeExpirations: 1
    });
  });

  it("invalidates compact entries when the verified immutable release identity changes", async () => {
    const replacementHealth = health();
    replacementHealth.release.release_id = "world-packages-v2";
    const replacementEnvironment = gameplayEnvironment(35, -106);
    replacementEnvironment.release.release_id = "world-packages-v2";
    replacementEnvironment.result.flagPlacementWater = {
      blocked: false,
      kind: "land",
      source_id: null,
      source_name: null,
      distance_m: null,
      corridor_radius_m: null,
      reason: "authoritative land",
      resolution: "water-placement-surface-v1",
      release_id: "world-packages-v2"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(gameplayEnvironment(35, -106)))
      .mockResolvedValueOnce(response(replacementHealth))
      .mockResolvedValueOnce(response(replacementEnvironment));
    vi.stubGlobal("fetch", fetchMock);
    const world = client();

    await world.lookupGameplayEnvironment(35, -106);
    await world.verifyRequiredRelease();
    await expect(world.lookupGameplayEnvironment(35, -106)).resolves.toMatchObject({
      worldReleaseId: "world-packages-v2"
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(world.gameplayEnvironmentMetrics()).toMatchObject({
      entries: 1,
      authorityInvalidations: 1
    });
  });

  it("uses the compact batch endpoint, preserves order and duplicates, and seeds point cache", async () => {
    const points = [
      { lat: 35, lon: -106 },
      { lat: 29.9511, lon: -90.0715 },
      { lat: 35, lon: -106 }
    ];
    const fetchMock = vi.fn<
      (_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>
    >(async () => response(gameplayEnvironmentBatch(points)));
    vi.stubGlobal("fetch", fetchMock);
    const world = client();

    const results = await world.lookupGameplayEnvironments(points);
    expect(results.map((result) => [result.latitude, result.longitude])).toEqual([
      [35, -106],
      [29.9511, -90.0715],
      [35, -106]
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8765/api/gameplay-environment-batch"
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      points: [
        { latitude: 35, longitude: -106 },
        { latitude: 29.9511, longitude: -90.0715 },
        { latitude: 35, longitude: -106 }
      ]
    });

    await world.lookupGameplayEnvironment(35, -106);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(world.gameplayEnvironmentMetrics()).toMatchObject({
      entries: 2,
      batchBuilds: 1,
      batchUpstreamAttempts: 1,
      batchPoints: 3,
      hits: 1
    });
  });

  it("does not let global warming evict protected interactive environments", async () => {
    const protectedPoint = { lat: 39.7392, lon: -104.9903 };
    const globalPoints = Array.from({ length: 150 }, (_, index) => ({
      lat: 20 + index / 1_000,
      lon: -110
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(gameplayEnvironmentBatch([protectedPoint])))
      .mockResolvedValueOnce(response(gameplayEnvironmentBatch(globalPoints)));
    vi.stubGlobal("fetch", fetchMock);
    const world = client();

    await world.lookupGameplayEnvironments([protectedPoint], {
      cacheClass: "protected"
    });
    await world.lookupGameplayEnvironments(globalPoints, {
      cacheClass: "probationary"
    });
    await world.lookupGameplayEnvironments([protectedPoint], {
      cacheClass: "protected"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(world.gameplayEnvironmentMetrics()).toMatchObject({
      protectedEntries: 1,
      probationaryEntries: 128,
      probationaryEvictions: 22,
      hits: 1
    });
  });

  it("serializes distinct expensive batches against a real local World endpoint", async () => {
    let active = 0;
    let maximumActive = 0;
    let upstreamCalls = 0;
    const server = createServer(async (request, response) => {
      upstreamCalls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const body = await readRequestBody(request);
      const points = (JSON.parse(body) as {
        points: Array<{ latitude: number; longitude: number }>;
      }).points.map(({ latitude, longitude }) => ({
        lat: latitude,
        lon: longitude
      }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(gameplayEnvironmentBatch(points)));
      active -= 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("local World fake did not bind a TCP port");
    }
    const world = new WorldLookupClient(
      `http://127.0.0.1:${address.port}`,
      { warn: vi.fn(), info: vi.fn() } as unknown as AppLogger
    );
    try {
      const callers = [
        "population-plan",
        "travel",
        "flag",
        "city",
        "wildlife",
        "profile"
      ] as const;
      const distinct = Array.from({ length: 20 }, (_, index) =>
        world.lookupGameplayEnvironments(
          [{ lat: 30 + index / 100, lon: -105 }],
          { caller: callers[index % callers.length] }
        )
      );
      const identicalPoints = [{ lat: 55, lon: -110 }] as const;
      const identicalA = world.lookupGameplayEnvironments(
        identicalPoints,
        { caller: "population-plan" }
      );
      const identicalB = world.lookupGameplayEnvironments(
        identicalPoints,
        { caller: "travel" }
      );
      await Promise.all([...distinct, identicalA, identicalB]);

      expect(upstreamCalls).toBe(21);
      expect(maximumActive).toBe(1);
      expect(world.worldBatchAdmissionMetrics()).toMatchObject({
        concurrency: 1,
        active: 0,
        queueDepth: 0,
        maximumActive: 1,
        maximumQueueDepth: 20
      });
    } finally {
      world.shutdownBatchAdmission();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("parses HTTP and structured World backpressure retry timing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ retry_after_ms: 1_250 }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "1"
        }
      }
    )));
    const world = client();

    await expect(world.lookupGameplayEnvironments(
      [{ lat: 35, lon: -106 }],
      { caller: "population-plan" }
    )).rejects.toMatchObject({
      retryAfterMs: 1_250,
      statusCode: 503
    } satisfies Partial<WorldBatchBackpressureError>);
    expect(world.worldBatchAdmissionMetrics()).toMatchObject({
      active: 0,
      queueDepth: 0,
      callers: {
        "population-plan": {
          admitted: 1,
          failed: 1
        }
      }
    });
  });

  it("fails closed when compact authority or release binding is malformed", () => {
    const malformed = gameplayEnvironment(35, -106);
    malformed.result.flagPlacementWater = null;
    expect(normalizeGameplayEnvironment(malformed, {
      point: { lat: 35, lon: -106 }
    })).toMatchObject({
      ok: false,
      failure: { code: "WORLD_RESPONSE_INVALID" }
    });

    const mismatch = gameplayEnvironment(35, -106);
    mismatch.release.release_id = "replacement-release";
    expect(normalizeGameplayEnvironment(mismatch, {
      point: { lat: 35, lon: -106 },
      requiredRelease: {
        releaseId: "world-packages-v1",
        profileSetFingerprint: "profile-fingerprint",
        buildContractFingerprint: "contract-fingerprint",
        boundaryReleaseId: "world-boundaries-v1"
      }
    })).toMatchObject({
      ok: false,
      failure: { code: "WORLD_RELEASE_MISMATCH" }
    });

    const canonicalRiver = gameplayEnvironment(35, -106);
    Object.assign(canonicalRiver.result, {
      isLand: false,
      isSaltwater: false,
      surfaceKind: "water",
      waterKind: "river",
      riverSurface: {
        surface_kind: "water",
        water_kind: "river",
        is_river: true,
        cell_size_m: 125,
        row_id: 10,
        column_id: 20,
        source_release_id: "river-surface-v1",
        source_manifest_sha256: "a".repeat(64)
      },
      flagPlacementWater: {
        blocked: true,
        kind: "river",
        source_id: "river-surface-v1:10:20",
        source_name: null,
        distance_m: 0,
        corridor_radius_m: null,
        reason: "canonical river surface",
        resolution: "river-surface-v1",
        release_id: "world-packages-v1"
      }
    });
    expect(normalizeGameplayEnvironment(canonicalRiver, {
      point: { lat: 35, lon: -106 },
      requiredRiverAuthority: {
        runtimeSha: "bd9432f46436402d8edb8b914dd2300c997508fb",
        releaseId: "river-surface-v1",
        manifestSha256: "a".repeat(64),
        policy: "osm-medium-plus-v1",
        cellSizeM: 125
      }
    })).toMatchObject({
      ok: true,
      surfaceKind: "water",
      waterKind: "river",
      riverSurface: { rowId: 10, columnId: 20 }
    });
    (canonicalRiver.result as unknown as {
      riverSurface: { source_manifest_sha256: string };
    }).riverSurface.source_manifest_sha256 = "b".repeat(64);
    expect(normalizeGameplayEnvironment(canonicalRiver, {
      point: { lat: 35, lon: -106 },
      requiredRiverAuthority: {
        runtimeSha: "bd9432f46436402d8edb8b914dd2300c997508fb",
        releaseId: "river-surface-v1",
        manifestSha256: "a".repeat(64),
        policy: "osm-medium-plus-v1",
        cellSizeM: 125
      }
    })).toMatchObject({
      ok: false,
      failure: { code: "WORLD_RESPONSE_INVALID" }
    });
  });

  it("binds deep-ocean gameplay results to the exact lake and coastal-ocean authorities", () => {
    const deepOcean = gameplayEnvironment(20, -140);
    Object.assign(deepOcean.result, {
      isLand: false,
      isSaltwater: true,
      surfaceKind: "water",
      waterKind: "ocean",
      lakeSurface: {
        surface_kind: null,
        water_kind: null,
        is_lake: false,
        cell_size_m: 125,
        row_id: 10,
        column_id: 20,
        source_release_id: "lake-surface-v1",
        source_manifest_sha256: "b".repeat(64)
      },
      oceanCoastSurface: {
        surface_kind: null,
        water_kind: null,
        is_ocean_coast: false,
        cell_size_m: 125,
        row_id: 10,
        column_id: 20,
        source_release_id: "ocean-coast-surface-v1",
        source_manifest_sha256: "c".repeat(64)
      }
    });
    const authorities = {
      point: { lat: 20, lon: -140 },
      requiredLakeAuthority: {
        runtimeSha: "bd9432f46436402d8edb8b914dd2300c997508fb",
        releaseId: "lake-surface-v1",
        manifestSha256: "b".repeat(64),
        policy: "hydrolakes-center-membership-v1",
        cellSizeM: 125
      },
      requiredOceanCoastAuthority: {
        runtimeSha: "bd9432f46436402d8edb8b914dd2300c997508fb",
        releaseId: "ocean-coast-surface-v1",
        manifestSha256: "c".repeat(64),
        policy: "ocean-coast-center-membership-v1",
        cellSizeM: 125
      }
    } as const;

    expect(normalizeGameplayEnvironment(deepOcean, authorities)).toMatchObject({
      ok: true,
      surfaceKind: "water",
      waterKind: "ocean",
      lakeSurface: { isLake: false, sourceReleaseId: "lake-surface-v1" },
      oceanCoastSurface: {
        isOceanCoast: false,
        sourceReleaseId: "ocean-coast-surface-v1"
      }
    });

    (deepOcean.result as unknown as {
      oceanCoastSurface: { source_manifest_sha256: string };
    }).oceanCoastSurface.source_manifest_sha256 = "d".repeat(64);
    expect(normalizeGameplayEnvironment(deepOcean, authorities)).toMatchObject({
      ok: false,
      failure: { code: "WORLD_RESPONSE_INVALID" }
    });
  });
});

describe("WorldLookupClient.lookupResourceEnvironments", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the compact endpoint once, validates order, and shares identical in-flight work", async () => {
    const points = [{ lat: 35, lon: -106 }, { lat: 75, lon: -118 }];
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const world = client();
    const first = world.lookupResourceEnvironments(points);
    const second = world.lookupResourceEnvironments(points);
    expect(fetchMock).toHaveBeenCalledOnce();
    resolveFetch(response(resourceBatch(points)));
    const [firstResults, secondResults] = await Promise.all([first, second]);
    expect(secondResults).toBe(firstResults);
    expect(firstResults.map((result) => [result.latitude, result.longitude])).toEqual([
      [35, -106],
      [75, -118]
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8765/api/resource-environment-batch"
    );
  });

  it("aborts unobserved work, does not cache failure, and permits a clean retry", async () => {
    let aborted = false;
    const fetchMock = vi.fn()
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("fetch aborted"));
          }, { once: true });
        }))
      .mockResolvedValueOnce(response(resourceBatch([{ lat: 35, lon: -106 }])));
    vi.stubGlobal("fetch", fetchMock);
    const world = client();
    const controller = new AbortController();
    const canceled = world.lookupResourceEnvironments([{ lat: 35, lon: -106 }], {
      signal: controller.signal
    });
    controller.abort(new Error("flag moved"));
    await expect(canceled).rejects.toThrow("flag moved");
    await vi.waitFor(() => expect(aborted).toBe(true));
    await expect(
      world.lookupResourceEnvironments([{ lat: 35, lon: -106 }])
    ).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("WorldLookupClient shared subscription ownership", () => {
  afterEach(() => vi.unstubAllGlobals());

  const cases: Array<{
    name: string;
    request(world: WorldLookupClient, signal?: AbortSignal): Promise<unknown>;
    payload(): unknown;
    copies: boolean;
  }> = [
    {
      name: "interactive lookup",
      request: (world, signal) => world.lookup(35, -106, { signal }),
      payload: () => exactLookup(35, -106),
      copies: false
    },
    {
      name: "resource environment batch",
      request: (world, signal) => world.lookupResourceEnvironments([{ lat: 35, lon: -106 }], { signal }),
      payload: () => resourceBatch([{ lat: 35, lon: -106 }]),
      copies: false
    },
    {
      name: "gameplay environment lookup",
      request: (world, signal) => world.lookupGameplayEnvironment(35, -106, { signal }),
      payload: () => gameplayEnvironment(35, -106),
      copies: true
    },
    {
      name: "gameplay environment batch",
      request: (world, signal) => world.lookupGameplayEnvironments([{ lat: 35, lon: -106 }], { signal }),
      payload: () => gameplayEnvironmentBatch([{ lat: 35, lon: -106 }]),
      copies: true
    }
  ];

  it.each(cases)("preserves $name result ownership and removes settled listeners", async ({ request, payload, copies }) => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const world = client();
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const first = request(world, controller.signal);
    const second = request(world);
    expect(fetchMock).toHaveBeenCalledOnce();
    resolveFetch(response(payload()));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    if (copies) {
      expect(secondResult).not.toBe(firstResult);
      if (Array.isArray(firstResult) && Array.isArray(secondResult)) {
        expect(secondResult[0]).not.toBe(firstResult[0]);
      }
    } else {
      expect(secondResult).toBe(firstResult);
    }
    const abortListener = added.mock.calls.find(([type]) => type === "abort")?.[1];
    expect(abortListener).toBeDefined();
    expect(removed).toHaveBeenCalledWith("abort", abortListener);
  });

  it.each(cases)("cancels $name upstream only after its last subscriber leaves", async ({ name, request }) => {
    let upstreamSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener("abort", () => reject(upstreamSignal?.reason), { once: true });
      });
    }));
    const world = client();
    const firstController = new AbortController();
    const lastController = new AbortController();
    const removed = vi.spyOn(lastController.signal, "removeEventListener");
    const first = request(world, firstController.signal);
    const last = request(world, lastController.signal);
    firstController.abort(new Error("first subscriber left"));
    await expect(first).rejects.toThrow("first subscriber left");
    expect(upstreamSignal?.aborted).toBe(false);
    lastController.abort(new Error("last subscriber left"));
    await expect(last).rejects.toThrow("last subscriber left");
    expect(upstreamSignal?.aborted).toBe(true);
    expect(upstreamSignal?.reason).toEqual(new Error(name + " has no active subscribers"));
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each(cases)("rejects an already cancelled $name before creating upstream work", async ({ request }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(request(client(), controller.signal)).rejects.toThrow("already cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("WorldLookupClient.collectibleWaterSourcesNear cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serves defensive copies from a bounded LRU cache", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return response(waterCollection(Number(url.searchParams.get("lat"))));
    });
    vi.stubGlobal("fetch", fetchMock);
    const world = cacheClient({ maxEntries: 2, maxBytes: 100_000, ttlMs: 60_000 });

    const first = await world.collectibleWaterSourcesNear({ lat: 1, lon: 0 }, 5_000);
    first[0]!.name = "caller mutation";
    await world.collectibleWaterSourcesNear({ lat: 2, lon: 0 }, 5_000);
    const cachedFirst = await world.collectibleWaterSourcesNear({ lat: 1, lon: 0 }, 5_000);
    await world.collectibleWaterSourcesNear({ lat: 3, lon: 0 }, 5_000);
    await world.collectibleWaterSourcesNear({ lat: 2, lon: 0 }, 5_000);

    expect(cachedFirst[0]?.name).toBe("water-1");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(world.waterHighlightCacheMetrics()).toMatchObject({
      entries: 2,
      hits: 1,
      misses: 4,
      evictions: 2
    });
  });

  it("expires stale entries and never retains an oversized response", async () => {
    let now = 100;
    const fetchMock = vi.fn(async () => response(waterCollection(1)));
    vi.stubGlobal("fetch", fetchMock);
    const expiring = cacheClient({
      maxEntries: 2,
      maxBytes: 100_000,
      ttlMs: 10,
      now: () => now
    });
    await expiring.collectibleWaterSourcesNear({ lat: 1, lon: 0 }, 5_000);
    now = 110;
    await expiring.collectibleWaterSourcesNear({ lat: 1, lon: 0 }, 5_000);
    expect(expiring.waterHighlightCacheMetrics()).toMatchObject({
      entries: 1,
      misses: 2,
      staleExpirations: 1
    });

    const oversized = cacheClient({ maxEntries: 2, maxBytes: 32, ttlMs: 10 });
    await oversized.collectibleWaterSourcesNear({ lat: 2, lon: 0 }, 5_000);
    await oversized.collectibleWaterSourcesNear({ lat: 2, lon: 0 }, 5_000);
    expect(oversized.waterHighlightCacheMetrics()).toMatchObject({
      entries: 0,
      misses: 2,
      oversizedResponses: 2
    });
  });

  it("does not cache malformed GeoJSON or transport failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ type: "FeatureCollection", features: "invalid" }))
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(response(waterCollection(1)));
    vi.stubGlobal("fetch", fetchMock);
    const world = cacheClient({ maxEntries: 2, maxBytes: 100_000, ttlMs: 60_000 });

    await expect(world.collectibleWaterSourcesNear({ lat: 1, lon: 0 }, 5_000)).resolves.toEqual([]);
    await expect(world.collectibleWaterSourcesNear({ lat: 1, lon: 0 }, 5_000)).resolves.toEqual([]);
    await expect(world.collectibleWaterSourcesNear({ lat: 1, lon: 0 }, 5_000)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(world.waterHighlightCacheMetrics()).toMatchObject({ entries: 1, misses: 3 });
  });

  it("invalidates cached locations when verified authority identity changes", async () => {
    const changedHealth = health();
    changedHealth.release.release_id = "world-packages-v2";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(waterCollection(1)))
      .mockResolvedValueOnce(response(health()))
      .mockResolvedValueOnce(response(waterCollection(1)))
      .mockResolvedValueOnce(response(changedHealth));
    vi.stubGlobal("fetch", fetchMock);
    const world = cacheClient({ maxEntries: 2, maxBytes: 100_000, ttlMs: 60_000 });

    await world.collectibleWaterSourcesNear({ lat: 1, lon: 0 }, 5_000);
    await world.verifyRequiredRelease();
    expect(world.waterHighlightCacheMetrics()).toMatchObject({
      entries: 0,
      authorityInvalidations: 1
    });
    await world.collectibleWaterSourcesNear({ lat: 1, lon: 0 }, 5_000);
    await world.verifyRequiredRelease();
    expect(world.waterHighlightCacheMetrics()).toMatchObject({
      entries: 0,
      authorityInvalidations: 2
    });
  });
});

function client(): WorldLookupClient {
  return new WorldLookupClient(
    "http://127.0.0.1:8765",
    { warn: vi.fn(), info: vi.fn() } as unknown as AppLogger
  );
}

function clientWithRequiredRelease(): WorldLookupClient {
  const release = health().release;
  return new WorldLookupClient(
    "http://127.0.0.1:8765",
    { warn: vi.fn(), info: vi.fn() } as unknown as AppLogger,
    2_000,
    {
      releaseId: release.release_id,
      profileSetFingerprint: release.profile_set_fingerprint,
      buildContractFingerprint: release.build_contract_fingerprint,
      boundaryReleaseId: release.boundary_release_id
    }
  );
}

function cacheClient(options: ConstructorParameters<typeof WorldLookupClient>[5]): WorldLookupClient {
  return new WorldLookupClient(
    "http://127.0.0.1:8765",
    { warn: vi.fn(), info: vi.fn() } as unknown as AppLogger,
    2_000,
    undefined,
    10_000,
    options
  );
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function readRequestBody(
  request: IncomingMessage
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function health() {
  return {
    ok: true,
    release: {
      release_id: "world-packages-v1",
      profile_set_fingerprint: "profile-fingerprint",
      build_contract_fingerprint: "contract-fingerprint",
      boundary_release_id: "world-boundaries-v1",
      package_count: 64800
    }
  };
}

function exactLookup(latitude: number, longitude: number) {
  return {
    ok: true,
    covered: true,
    release: health().release,
    selected_package: { package_id: "world_v1_lat0_lon0" },
    profile: {
      latitude,
      longitude,
      administrative: {},
      environment: {},
      water: {},
      derived_tags: [],
      source_versions: {},
      warnings: []
    }
  };
}

function gameplayEnvironment(latitude: number, longitude: number) {
  const packageLatitude = Math.floor(latitude);
  const packageLongitude = Math.floor(longitude);
  const packageLongitudeLabel = packageLongitude < 0
    ? `-${String(Math.abs(packageLongitude)).padStart(3, "0")}`
    : String(packageLongitude).padStart(3, "0");
  return {
    ok: true,
    contract_version: "gameplay-environment-v1",
    release: health().release,
    runtime: {
      sha: "bd9432f46436402d8edb8b914dd2300c997508fb",
      branch: "main"
    },
    result: {
      latitude,
      longitude,
      packageId: `world_v1_lat${packageLatitude}_lon${packageLongitudeLabel}`,
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      isCoastal: true,
      isCoastalLand: true,
      isRiverbank: false,
      isLakeshore: false,
      majorLakeId: null,
      majorLakeName: null,
      majorLakeDistanceM: null,
      elevationM: 100,
      elevationBand: "lowland",
      terrainClass: "flat",
      landCoverClass: "forest",
      biomeId: "biome-1",
      biomeName: "Temperate forest",
      ecoregionId: "ecoregion-1",
      ecoregionName: "Test woodland",
      countryId: "country-1",
      countryName: "United States",
      regionId: "region-1",
      regionName: "Test Region",
      settlementId: null,
      settlementName: null,
      countryCode: "US",
      regionCode: "US-TS",
      namedRiverId: null,
      namedRiverName: null,
      riverClass: null,
      riverDistanceM: null,
      supportingRiverId: null,
      supportingRiverFlowOrder: null,
      supportingRiverDischargeCms: null,
      supportingRiverDrainageAreaSqKm: null,
      supportingRiverDistanceM: null,
      flagPlacementWater: {
        blocked: false,
        kind: "land",
        source_id: null,
        source_name: null,
        distance_m: null,
        corridor_radius_m: null,
        reason: "authoritative land",
        resolution: "water-placement-surface-v1",
        release_id: "world-packages-v1"
      } as unknown
    }
  };
}

function gameplayEnvironmentBatch(points: Array<{ lat: number; lon: number }>) {
  return {
    ok: true,
    contract_version: "gameplay-environment-v1",
    release: health().release,
    runtime: {
      sha: "bd9432f46436402d8edb8b914dd2300c997508fb",
      branch: "main"
    },
    results: points.map((point) => gameplayEnvironment(point.lat, point.lon).result),
    timing: {
      lookup_ms: 1,
      cache: "miss",
      point_count: points.length,
      unique_point_count: new Set(points.map((point) => `${point.lat}:${point.lon}`)).size,
      package_count: 1
    }
  };
}

function resourceBatch(points: Array<{ lat: number; lon: number }>) {
  return {
    ok: true,
    contract_version: "resource-environment-v1",
    release: health().release,
    results: points.map((point) => ({
      ok: true,
      latitude: point.lat,
      longitude: point.lon,
      package_id: "world_v1_lat0_lon0",
      is_land: true,
      is_saltwater: false,
      inside_major_lake: false,
      elevation_m: 100,
      terrain_class: "flat",
      land_cover_class: "forest",
      source_land_cover_code: 50,
      biome: "Temperate forest",
      ecoregion: "Test woodland",
      ecology_resolution: "exact",
      near_named_river: false,
      river_distance_m: null,
      major_lake_distance_m: null,
      warning: null
    }))
  };
}

function waterCollection(latitude: number) {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: `water-${latitude}`,
        properties: {
          source_id: `water-${latitude}`,
          source_name: `water-${latitude}`,
          source_dataset: "stability-test",
          water_source_type: "river",
          water_kind: "fresh",
          collectible: true
        },
        geometry: { type: "Point", coordinates: [0, latitude] }
      }
    ]
  };
}
