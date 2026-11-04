import { distanceMeters } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  BoundedWorldEnvironmentProfileCache,
  CANDIDATE_SLOT_VERSION,
  ENVIRONMENT_CANDIDATE_SLOT_COUNT,
  ENVIRONMENT_PROFILE_VERSION,
  GameplayEnvironmentProfileService,
  generateWorldEnvironmentCandidateSlots,
  persistableCandidateSlots,
  worldEnvironmentIdentityKey,
  worldEnvironmentProfileCacheKey,
  worldEnvironmentProfileRequestForPoint,
  type GameplayEnvironmentBatchEntry,
  type WorldEnvironmentCellProfile,
  type WorldEnvironmentProfilePersistence,
  type WorldEnvironmentProfileRequest
} from "./gameplayEnvironmentProfiles.js";

const IDENTITY = {
  releaseId: "world-packages-v1",
  profileSetFingerprint: "a".repeat(64),
  buildContractFingerprint: "b".repeat(64),
  boundaryReleaseId: "global-boundaries-v1"
};

describe("gameplay environment profiles", () => {
  it("keys durable identity to immutable World data rather than runtime provenance", () => {
    const first = request({ sourceRuntimeSha: "a".repeat(40) });
    const runtimeOnlyChange = request({ sourceRuntimeSha: "b".repeat(40) });
    const changedData = request({
      worldIdentity: { ...IDENTITY, boundaryReleaseId: "global-boundaries-v2" }
    });

    expect(first.worldIdentityKey).toBe(runtimeOnlyChange.worldIdentityKey);
    expect(worldEnvironmentProfileCacheKey(first))
      .toBe(worldEnvironmentProfileCacheKey(runtimeOnlyChange));
    expect(changedData.worldIdentityKey).not.toBe(first.worldIdentityKey);
    expect(worldEnvironmentIdentityKey(IDENTITY)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps multiple callers in one stable cell to one reusable profile identity", () => {
    const first = request({ position: { lat: 35.0844, lon: -106.6504 } });
    const second = request({ position: { lat: 35.08445, lon: -106.65035 } });

    expect(second.cellId).toBe(first.cellId);
    expect(worldEnvironmentProfileCacheKey(second)).toBe(worldEnvironmentProfileCacheKey(first));
  });

  it("generates stable clustered slots that can place separated wolf bodies", () => {
    const profileRequest = request();
    const first = generateWorldEnvironmentCandidateSlots(profileRequest);
    const second = generateWorldEnvironmentCandidateSlots(profileRequest);

    expect(first).toEqual(second);
    expect(first).toHaveLength(ENVIRONMENT_CANDIDATE_SLOT_COUNT);
    expect(new Set(first.map((slot) => slot.slotId))).toHaveLength(first.length);
    expect(first.filter((slot) => slot.placementTags.includes("cluster-anchor"))).toHaveLength(16);
    expect(first.filter((slot) => slot.placementTags.includes("cluster-member"))).toHaveLength(96);

    for (let cluster = 0; cluster < 16; cluster += 1) {
      const tag = `cluster:${cluster.toString().padStart(2, "0")}`;
      const members = first.filter(
        (slot) => slot.placementTags.includes(tag) &&
          slot.placementTags.includes("cluster-primary")
      );
      expect(members).toHaveLength(4);
      for (let left = 0; left < members.length; left += 1) {
        for (let right = left + 1; right < members.length; right += 1) {
          expect(distanceMeters(members[left]!.position, members[right]!.position))
            .toBeGreaterThan(64);
        }
      }
    }
  });

  it("persists compact facts and explicit placement tags for every slot", () => {
    const points = generateWorldEnvironmentCandidateSlots(request());
    const rows = points.map((slot, index): GameplayEnvironmentBatchEntry => ({
      ...facts(slot.position.lat, slot.position.lon),
      isCoastalLand: index === 0,
      ok: true
    }));
    const slots = persistableCandidateSlots(points, rows);

    expect(slots).toHaveLength(112);
    expect(slots[0]).toMatchObject({
      eligibleLand: true,
      elevationBand: "lowland",
      biomeId: "temperate-forest"
    });
    expect(slots[0]!.placementTags).toEqual(expect.arrayContaining([
      "eligible-land",
      "land",
      "coastal-land",
      "cluster-anchor",
      "biome:temperate-forest"
    ]));
  });

  it("keeps additive shoreline facts independent from surface membership and land eligibility", () => {
    const points = generateWorldEnvironmentCandidateSlots(request()).slice(0, 2);
    const rows: GameplayEnvironmentBatchEntry[] = [
      {
        ...facts(points[0]!.position.lat, points[0]!.position.lon),
        isCoastalLand: true,
        isRiverbank: true,
        isLakeshore: true,
        waterKind: null
      },
      {
        ...facts(points[1]!.position.lat, points[1]!.position.lon),
        isLand: false,
        isSaltwater: false,
        isCoastalLand: true,
        isRiverbank: true,
        isLakeshore: true,
        waterKind: "river",
        riverSurface: {
          releaseId: "river-surface-v1",
          manifestSha256: "a".repeat(64),
          cellSizeM: 125,
          rowId: 1,
          columnId: 2
        }
      }
    ];
    const slots = persistableCandidateSlots(points, rows);

    expect(slots[0]).toMatchObject({
      eligibleLand: true,
      isRiverbank: true,
      isLakeshore: true,
      placementTags: expect.arrayContaining([
        "coastal-land",
        "riverbank",
        "lakeshore"
      ])
    });
    expect(slots[1]).toMatchObject({
      eligibleLand: false,
      isRiverbank: true,
      isLakeshore: true,
      surfaceType: "river",
      placementTags: expect.arrayContaining(["riverbank", "lakeshore", "surface:river"])
    });
  });

  it("evicts least-recently-used immutable profiles at a fixed bound", () => {
    const cache = new BoundedWorldEnvironmentProfileCache(2);
    const first = profile(request(), "first");
    const second = profile(request({ position: { lat: 35.2, lon: -106.6 } }), "second");
    const third = profile(request({ position: { lat: 35.4, lon: -106.6 } }), "third");
    cache.set(worldEnvironmentProfileCacheKey(first), first);
    cache.set(worldEnvironmentProfileCacheKey(second), second);
    expect(cache.get(worldEnvironmentProfileCacheKey(first))?.packageId).toBe("first");
    cache.set(worldEnvironmentProfileCacheKey(third), third);

    expect(cache.get(worldEnvironmentProfileCacheKey(second))).toBeUndefined();
    expect(cache.size).toBe(2);
    expect(Object.isFrozen(cache.get(worldEnvironmentProfileCacheKey(first))?.candidateSlots)).toBe(true);
  });

  it("reuses PostgreSQL then memory without submitting a World materialization job", async () => {
    const profileRequest = request();
    const persisted = profile(profileRequest);
    const persistence = new MemoryPersistence([[worldEnvironmentProfileCacheKey(profileRequest), persisted]]);
    const service = new GameplayEnvironmentProfileService(persistence, 4);

    const database = await service.ensureProfile(profileRequest);
    const memory = await service.ensureProfile(profileRequest);

    expect(database).toMatchObject({ status: "ready", source: "database" });
    expect(memory).toMatchObject({ status: "ready", source: "memory" });
    expect(persistence.submissions).toBe(0);
    expect(service.metricsSnapshot()).toMatchObject({
      databaseHits: 1,
      memoryHits: 1,
      durableMisses: 0
    });
  });

  it("collapses one hundred same-cell callers into one durable job", async () => {
    const persistence = new MemoryPersistence();
    const service = new GameplayEnvironmentProfileService(persistence, 4);
    const profileRequest = request();
    const notifier = vi.fn();
    service.setJobNotifier(notifier);

    const results = await Promise.all(
      Array.from({ length: 100 }, () => service.ensureProfile(profileRequest))
    );

    expect(results.filter((result) => result.status === "pending" && result.jobCreated))
      .toHaveLength(1);
    expect(persistence.submissions).toBe(1);
    expect(notifier).toHaveBeenCalledOnce();
    expect(service.metricsSnapshot()).toMatchObject({
      durableMisses: 1,
      jobsCreated: 1,
      jobsDeduplicated: 99
    });
  });

  it("does not reuse a profile across different immutable World identities", async () => {
    const firstRequest = request();
    const persisted = profile(firstRequest);
    const persistence = new MemoryPersistence([[worldEnvironmentProfileCacheKey(firstRequest), persisted]]);
    const service = new GameplayEnvironmentProfileService(persistence);
    await expect(service.ensureProfile(firstRequest)).resolves.toMatchObject({ status: "ready" });

    const changedIdentity = request({
      worldIdentity: { ...IDENTITY, releaseId: "world-packages-v2" }
    });
    await expect(service.ensureProfile(changedIdentity)).resolves.toMatchObject({
      status: "pending",
      jobCreated: true
    });
  });

  it("keeps a ready profile accepted when a materialized listener fails", async () => {
    const persisted = profile(request());
    const logger = { warn: vi.fn() };
    const service = new GameplayEnvironmentProfileService(
      new MemoryPersistence(),
      4,
      logger as never
    );
    service.onMaterialized(async () => {
      await Promise.resolve();
      throw new Error("population refresh failed");
    });

    await expect(service.acceptMaterializedProfile(persisted)).resolves.toBeUndefined();
    await expect(service.readyProfile(request())).resolves.toMatchObject({
      cellId: persisted.cellId
    });
    expect(service.metricsSnapshot()).toMatchObject({
      materializationsSucceeded: 1,
      materializationsFailed: 0,
      materializedListenerFailures: 1
    });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("reports a terminal durable job without waking workers that cannot claim it", async () => {
    const logger = { warn: vi.fn() };
    const service = new GameplayEnvironmentProfileService({
      findProfile: vi.fn(async () => null),
      submitJob: vi.fn(async () => ({
        created: false,
        status: "terminal-failure" as const
      }))
    }, 4, logger as never);
    const notifier = vi.fn();
    service.setJobNotifier(notifier);

    await expect(service.ensureProfile(request())).resolves.toMatchObject({
      status: "pending",
      jobCreated: false,
      jobStatus: "terminal-failure"
    });
    expect(notifier).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

class MemoryPersistence implements WorldEnvironmentProfilePersistence {
  readonly profiles: Map<string, WorldEnvironmentCellProfile>;
  readonly jobs = new Set<string>();
  submissions = 0;

  constructor(profiles: Array<[string, WorldEnvironmentCellProfile]> = []) {
    this.profiles = new Map(profiles);
  }

  async findProfile(request: WorldEnvironmentProfileRequest) {
    await Promise.resolve();
    return this.profiles.get(worldEnvironmentProfileCacheKey(request)) ?? null;
  }

  async submitJob(request: WorldEnvironmentProfileRequest) {
    this.submissions += 1;
    const key = worldEnvironmentProfileCacheKey(request);
    if (this.jobs.has(key)) return { created: false, status: "pending" as const };
    this.jobs.add(key);
    return { created: true, status: "pending" as const };
  }
}

function request(overrides: Partial<{
  position: { lat: number; lon: number };
  worldIdentity: typeof IDENTITY;
  sourceRuntimeSha: string;
}> = {}) {
  return worldEnvironmentProfileRequestForPoint({
    position: overrides.position ?? { lat: 35.0844, lon: -106.6504 },
    regionCode: "GLOBAL",
    worldIdentity: overrides.worldIdentity ?? IDENTITY,
    sourceRuntimeSha: overrides.sourceRuntimeSha ?? "1".repeat(40)
  });
}

function facts(latitude: number, longitude: number): GameplayEnvironmentBatchEntry {
  return {
    ok: true,
    latitude,
    longitude,
    packageId: "package-1",
    isLand: true,
    isSaltwater: false,
    isCoastalLand: false,
    isRiverbank: false,
    isLakeshore: false,
    insideMajorLake: false,
    isCoastal: false,
    elevationM: 125,
    elevationBand: "lowland",
    terrainClass: "forest",
    landCoverClass: "forest",
    biomeId: "temperate-forest",
    biomeName: "Temperate Forest",
    ecoregionId: "ecoregion-1",
    ecoregionName: "Test Ecoregion",
    countryId: "country-1",
    countryName: "Test Country",
    regionId: "region-1",
    regionName: "Test Region",
    settlementId: null,
    settlementName: null,
    flagPlacementWater: { allowed: true }
  };
}

function profile(
  profileRequest: WorldEnvironmentProfileRequest,
  packageId = "package-1"
): WorldEnvironmentCellProfile {
  const environment = facts(profileRequest.center.lat, profileRequest.center.lon);
  const points = generateWorldEnvironmentCandidateSlots(profileRequest);
  return {
    cellId: profileRequest.cellId,
    worldIdentityKey: profileRequest.worldIdentityKey,
    worldIdentity: profileRequest.worldIdentity,
    profileVersion: ENVIRONMENT_PROFILE_VERSION,
    candidateSlotVersion: CANDIDATE_SLOT_VERSION,
    sourceRuntimeSha: profileRequest.sourceRuntimeSha,
    regionCode: profileRequest.regionCode,
    centerLat: profileRequest.center.lat,
    centerLon: profileRequest.center.lon,
    packageId,
    countryId: environment.countryId,
    countryName: environment.countryName,
    regionId: environment.regionId,
    regionName: environment.regionName,
    settlementId: environment.settlementId,
    settlementName: environment.settlementName,
    biomeId: environment.biomeId,
    biomeName: environment.biomeName,
    ecoregionId: environment.ecoregionId,
    ecoregionName: environment.ecoregionName,
    landCoverClass: environment.landCoverClass,
    terrainClass: environment.terrainClass,
    elevationM: environment.elevationM,
    elevationBand: environment.elevationBand,
    isLand: environment.isLand,
    isSaltwater: environment.isSaltwater,
    insideMajorLake: environment.insideMajorLake,
    isRiverbank: environment.isRiverbank,
    isLakeshore: environment.isLakeshore,
    isCoastal: environment.isCoastal,
    spawnProfileKey: "temperate_forest",
    spawnRulesVersion: "environment-spawn-rules-v2-riverbank-lakeshore",
    environmentProfile: environment,
    candidateSlots: persistableCandidateSlots(
      points,
      points.map((point) => facts(point.position.lat, point.position.lon))
    ),
    createdAt: "2026-07-18T00:00:00.000Z"
  };
}
