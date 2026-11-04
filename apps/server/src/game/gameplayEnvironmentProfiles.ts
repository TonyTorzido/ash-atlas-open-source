import { createHash } from "node:crypto";

import { destinationPoint, type LatLon } from "@ash-atlas/shared";

import type { AppLogger } from "../logger.js";
import { spawnCellForPoint } from "./collectibles.js";
import {
  populationV2EncounterSurface,
  type PopulationV2EncounterSurface,
  type PopulationV2SurfaceAuthority
} from "./populationV2SurfaceTypes.js";
import {
  ENVIRONMENT_PROFILE_VERSION
} from "./gameplayEnvironmentProfileVersions.js";

export { ENVIRONMENT_PROFILE_VERSION };
export const CANDIDATE_SLOT_VERSION =
  "gameplay-environment-candidates-v4-riverbank-lakeshore";
export const ENVIRONMENT_CANDIDATE_SLOT_COUNT = 112;
export const ENVIRONMENT_CANDIDATE_RADIUS_M = 1_500;

const CANDIDATE_CLUSTER_COUNT = 16;
const SLOTS_PER_CLUSTER = 7;
const WOLF_MEMBER_RADIUS_M = 47;
const GOLDEN_ANGLE_DEGREES = 137.507_764_050_037_85;

export type WorldEnvironmentDataIdentity = Readonly<{
  releaseId: string;
  profileSetFingerprint: string;
  buildContractFingerprint: string;
  boundaryReleaseId: string;
}>;

export type WorldEnvironmentProfileRequest = Readonly<{
  cellId: string;
  worldIdentityKey: string;
  worldIdentity: WorldEnvironmentDataIdentity;
  profileVersion: string;
  candidateSlotVersion: string;
  sourceRuntimeSha: string;
  regionCode: string;
  center: LatLon;
  reason: string;
  priority: number;
}>;

export type CompactGameplayEnvironmentFacts = Readonly<{
  latitude: number;
  longitude: number;
  packageId: string | null;
  isLand: boolean;
  isSaltwater: boolean;
  isCoastalLand: boolean;
  isRiverbank: boolean;
  isLakeshore: boolean;
  insideMajorLake: boolean;
  waterKind?: "ocean" | "lake" | "river" | "inland_water" | null;
  riverSurface?: PopulationV2SurfaceAuthority | null;
  lakeSurface?: PopulationV2SurfaceAuthority | null;
  oceanSurface?: PopulationV2SurfaceAuthority | null;
  isCoastal: boolean | null;
  elevationM: number | null;
  elevationBand: string | null;
  terrainClass: string | null;
  landCoverClass: string | null;
  biomeId: string | null;
  biomeName: string | null;
  ecoregionId: string | null;
  ecoregionName: string | null;
  countryId: string | null;
  countryName: string | null;
  regionId: string | null;
  regionName: string | null;
  settlementId: string | null;
  settlementName: string | null;
  flagPlacementWater: unknown | null;
}>;

export type GameplayEnvironmentBatchEntry = CompactGameplayEnvironmentFacts & Readonly<{
  ok: boolean;
  warning?: string | null;
}>;

export type WorldEnvironmentCandidateSlot = Readonly<{
  slotId: string;
  latitude: number;
  longitude: number;
  eligibleLand: boolean;
  isSaltwater: boolean;
  insideMajorLake: boolean;
  isRiverbank: boolean;
  isLakeshore: boolean;
  surfaceType?: PopulationV2EncounterSurface | null;
  surfaceAuthority?: PopulationV2SurfaceAuthority | null;
  elevationM: number | null;
  elevationBand: string | null;
  terrainClass: string | null;
  landCoverClass: string | null;
  biomeId: string | null;
  biomeName: string | null;
  ecoregionId: string | null;
  ecoregionName: string | null;
  placementTags: readonly string[];
}>;

export type WorldEnvironmentCellProfile = Readonly<{
  cellId: string;
  worldIdentityKey: string;
  worldIdentity: WorldEnvironmentDataIdentity;
  profileVersion: string;
  candidateSlotVersion: string;
  sourceRuntimeSha: string;
  regionCode: string;
  centerLat: number;
  centerLon: number;
  packageId: string | null;
  countryId: string | null;
  countryName: string | null;
  regionId: string | null;
  regionName: string | null;
  settlementId: string | null;
  settlementName: string | null;
  biomeId: string | null;
  biomeName: string | null;
  ecoregionId: string | null;
  ecoregionName: string | null;
  landCoverClass: string | null;
  terrainClass: string | null;
  elevationM: number | null;
  elevationBand: string | null;
  isLand: boolean;
  isSaltwater: boolean;
  insideMajorLake: boolean;
  isRiverbank: boolean;
  isLakeshore: boolean;
  isCoastal: boolean | null;
  spawnProfileKey: string;
  spawnRulesVersion: string;
  environmentProfile: CompactGameplayEnvironmentFacts;
  candidateSlots: readonly WorldEnvironmentCandidateSlot[];
  createdAt: string;
}>;

export type WorldEnvironmentProfileJobStatus =
  | "pending"
  | "leased"
  | "ready"
  | "retryable-failure"
  | "terminal-failure";

export type WorldEnvironmentProfileJobAdmission = Readonly<{
  created: boolean;
  status: WorldEnvironmentProfileJobStatus;
  admitted?: boolean;
}>;

export interface WorldEnvironmentProfilePersistence {
  findProfile(request: WorldEnvironmentProfileRequest): Promise<WorldEnvironmentCellProfile | null>;
  submitJob(request: WorldEnvironmentProfileRequest): Promise<WorldEnvironmentProfileJobAdmission>;
}

export type EnsureWorldEnvironmentProfileResult =
  | Readonly<{
      status: "ready";
      profile: WorldEnvironmentCellProfile;
      source: "memory" | "database";
    }>
  | Readonly<{
      status: "pending";
      profile: null;
      jobCreated: boolean;
      jobStatus: Exclude<WorldEnvironmentProfileJobStatus, "ready">;
    }>;

export type GameplayEnvironmentProfileMetrics = Readonly<{
  memoryHits: number;
  databaseHits: number;
  durableMisses: number;
  jobsCreated: number;
  jobsDeduplicated: number;
  jobsBackpressured: number;
  materializationsSucceeded: number;
  materializationsFailed: number;
  materializedListenerFailures: number;
  cacheEntries: number;
  inFlightResolutions: number;
}>;

export type CandidateSlotPoint = Readonly<{
  slotId: string;
  position: LatLon;
  placementTags: readonly string[];
}>;

export function worldEnvironmentIdentityKey(identity: WorldEnvironmentDataIdentity): string {
  validateWorldIdentity(identity);
  return sha256(JSON.stringify([
    identity.releaseId,
    identity.profileSetFingerprint,
    identity.buildContractFingerprint,
    identity.boundaryReleaseId
  ]));
}

export function worldEnvironmentProfileRequestForPoint(input: {
  position: LatLon;
  regionCode: string;
  worldIdentity: WorldEnvironmentDataIdentity;
  sourceRuntimeSha: string;
  profileVersion?: string;
  candidateSlotVersion?: string;
  reason?: string;
  priority?: number;
}): WorldEnvironmentProfileRequest {
  const cell = spawnCellForPoint(input.position, input.regionCode);
  const priority = input.priority ?? 2;
  if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
    throw new Error("environment profile priority must be an integer from 0 through 3");
  }
  if (input.sourceRuntimeSha.length === 0) {
    throw new Error("environment profile runtime provenance must not be empty");
  }
  return {
    cellId: cell.id,
    worldIdentityKey: worldEnvironmentIdentityKey(input.worldIdentity),
    worldIdentity: { ...input.worldIdentity },
    profileVersion: input.profileVersion ?? ENVIRONMENT_PROFILE_VERSION,
    candidateSlotVersion: input.candidateSlotVersion ?? CANDIDATE_SLOT_VERSION,
    sourceRuntimeSha: input.sourceRuntimeSha,
    regionCode: cell.regionCode,
    center: { ...cell.center },
    reason: input.reason ?? "population",
    priority
  };
}

export function worldEnvironmentProfileCacheKey(
  input: Pick<
    WorldEnvironmentProfileRequest,
    "worldIdentityKey" | "profileVersion" | "candidateSlotVersion" | "cellId"
  >
): string {
  return [
    input.worldIdentityKey,
    input.profileVersion,
    input.candidateSlotVersion,
    input.cellId
  ].join(":");
}

export function worldEnvironmentProfileJobKey(request: WorldEnvironmentProfileRequest): string {
  return sha256(worldEnvironmentProfileCacheKey(request));
}

/**
 * Sixteen durable encounter clusters are spread across the population radius. Each cluster has
 * one anchor and six nearby alternatives. Four primary members form a 47 m cardinal ring, which
 * lets a wolf pack choose three or four bodies with the existing 55 m minimum separation without
 * another World request.
 */
export function generateWorldEnvironmentCandidateSlots(
  request: Pick<WorldEnvironmentProfileRequest, "cellId" | "candidateSlotVersion" | "center">,
  count = ENVIRONMENT_CANDIDATE_SLOT_COUNT,
  radiusM = ENVIRONMENT_CANDIDATE_RADIUS_M
): CandidateSlotPoint[] {
  if (count !== CANDIDATE_CLUSTER_COUNT * SLOTS_PER_CLUSTER) {
    throw new Error(
      `environment candidate count must be ${CANDIDATE_CLUSTER_COUNT * SLOTS_PER_CLUSTER}`
    );
  }
  if (!Number.isFinite(radiusM) || radiusM <= WOLF_MEMBER_RADIUS_M + 20) {
    throw new Error("environment candidate radius is too small for clustered placement slots");
  }
  const rotation = hashUnit(`${request.cellId}:${request.candidateSlotVersion}:rotation`) * 360;
  const slots: CandidateSlotPoint[] = [];
  for (let clusterIndex = 0; clusterIndex < CANDIDATE_CLUSTER_COUNT; clusterIndex += 1) {
    const anchorSlotIndex = clusterIndex * SLOTS_PER_CLUSTER;
    const anchorSeed = slotSeed(request, anchorSlotIndex);
    const radialUnit = (clusterIndex + 0.35 + hashUnit(`${anchorSeed}:radius`) * 0.3) /
      CANDIDATE_CLUSTER_COUNT;
    const anchorDistance = 100 +
      Math.sqrt(radialUnit) * (radiusM - WOLF_MEMBER_RADIUS_M - 130);
    const anchorBearing = (
      rotation +
      clusterIndex * GOLDEN_ANGLE_DEGREES +
      (hashUnit(`${anchorSeed}:bearing`) - 0.5) * 18
    ) % 360;
    const anchor = destinationPoint(request.center, anchorDistance, anchorBearing);
    const clusterTag = `cluster:${clusterIndex.toString().padStart(2, "0")}`;
    slots.push({
      slotId: slotId(anchorSeed),
      position: anchor,
      placementTags: ["general", "cluster-anchor", clusterTag]
    });

    const clusterRotation = hashUnit(`${anchorSeed}:member-rotation`) * 360;
    const memberOffsets = [0, 90, 180, 270, 45, 225] as const;
    for (let memberIndex = 0; memberIndex < memberOffsets.length; memberIndex += 1) {
      const memberOffset = memberOffsets[memberIndex];
      if (memberOffset === undefined) continue;
      const slotIndex = anchorSlotIndex + memberIndex + 1;
      const seed = slotSeed(request, slotIndex);
      const bearing = clusterRotation + memberOffset +
        (hashUnit(`${seed}:jitter`) - 0.5) * 2;
      const position = destinationPoint(anchor, WOLF_MEMBER_RADIUS_M, bearing);
      slots.push({
        slotId: slotId(seed),
        position,
        placementTags: [
          "general",
          "cluster-member",
          memberIndex < 4 ? "cluster-primary" : "cluster-backup",
          clusterTag
        ]
      });
    }
  }
  return slots;
}

export function persistableCandidateSlots(
  points: readonly CandidateSlotPoint[],
  environments: readonly GameplayEnvironmentBatchEntry[]
): WorldEnvironmentCandidateSlot[] {
  if (points.length !== environments.length) {
    throw new Error(
      `gameplay environment batch returned ${environments.length} rows for ${points.length} slots`
    );
  }
  return points.map((point, index) => {
    const environment = environments[index]!;
    if (!environment.ok) {
      throw new Error(
        `gameplay environment batch failed for slot ${point.slotId}: ` +
        (environment.warning ?? "unknown World failure")
      );
    }
    const surfaceType = populationV2EncounterSurface(environment);
    // Surface membership is the final water exclusion. Proximity facts remain
    // additive and may be true on a nearby land slot without making water land.
    const eligibleLand = surfaceType === "land";
    const surfaceAuthority = surfaceType === "river"
      ? environment.riverSurface ?? null
      : surfaceType === "lake"
        ? environment.lakeSurface ?? null
        : surfaceType === "ocean"
          ? environment.oceanSurface ?? null
          : null;
    return {
      slotId: point.slotId,
      latitude: environment.latitude,
      longitude: environment.longitude,
      eligibleLand,
      isSaltwater: environment.isSaltwater,
      insideMajorLake: environment.insideMajorLake,
      isRiverbank: environment.isRiverbank,
      isLakeshore: environment.isLakeshore,
      surfaceType,
      surfaceAuthority,
      elevationM: environment.elevationM,
      elevationBand: environment.elevationBand,
      terrainClass: environment.terrainClass,
      landCoverClass: environment.landCoverClass,
      biomeId: environment.biomeId,
      biomeName: environment.biomeName,
      ecoregionId: environment.ecoregionId,
      ecoregionName: environment.ecoregionName,
      placementTags: placementTags(point.placementTags, environment, eligibleLand)
    };
  });
}

export class BoundedWorldEnvironmentProfileCache {
  private readonly entries = new Map<string, WorldEnvironmentCellProfile>();

  constructor(private readonly maximumEntries: number) {
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("environment profile cache maximumEntries must be a positive integer");
    }
  }

  get(key: string): WorldEnvironmentCellProfile | undefined {
    const profile = this.entries.get(key);
    if (!profile) return undefined;
    this.entries.delete(key);
    this.entries.set(key, profile);
    return profile;
  }

  set(key: string, profile: WorldEnvironmentCellProfile): WorldEnvironmentCellProfile {
    const immutable = immutableProfile(profile);
    this.entries.delete(key);
    while (this.entries.size >= this.maximumEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, immutable);
    return immutable;
  }

  get size(): number {
    return this.entries.size;
  }
}

export class GameplayEnvironmentProfileService {
  private readonly cache: BoundedWorldEnvironmentProfileCache;
  private readonly inFlight = new Map<string, Promise<EnsureWorldEnvironmentProfileResult>>();
  private readonly materializedListeners = new Set<
    (profile: WorldEnvironmentCellProfile) => void | Promise<void>
  >();
  private readonly metrics = {
    memoryHits: 0,
    databaseHits: 0,
    durableMisses: 0,
    jobsCreated: 0,
    jobsDeduplicated: 0,
    jobsBackpressured: 0,
    materializationsSucceeded: 0,
    materializationsFailed: 0,
    materializedListenerFailures: 0
  };
  private jobNotifier: (() => void) | null = null;

  constructor(
    private readonly persistence: WorldEnvironmentProfilePersistence,
    maximumCacheEntries = 512,
    private readonly logger?: Pick<AppLogger, "warn">
  ) {
    this.cache = new BoundedWorldEnvironmentProfileCache(maximumCacheEntries);
  }

  async ensureProfile(
    request: WorldEnvironmentProfileRequest
  ): Promise<EnsureWorldEnvironmentProfileResult> {
    validateRequestIdentity(request);
    const key = worldEnvironmentProfileCacheKey(request);
    const cached = this.cache.get(key);
    if (cached) {
      this.metrics.memoryHits += 1;
      return { status: "ready", profile: cached, source: "memory" };
    }
    const shared = this.inFlight.get(key);
    if (shared) {
      const result = await shared;
      if (result.status === "pending") {
        this.metrics.jobsDeduplicated += 1;
        return { ...result, jobCreated: false };
      }
      return result;
    }
    const resolution = this.resolve(request, key);
    this.inFlight.set(key, resolution);
    try {
      return await resolution;
    } finally {
      if (this.inFlight.get(key) === resolution) this.inFlight.delete(key);
    }
  }

  async readyProfile(
    request: WorldEnvironmentProfileRequest
  ): Promise<WorldEnvironmentCellProfile | null> {
    validateRequestIdentity(request);
    const key = worldEnvironmentProfileCacheKey(request);
    const cached = this.cache.get(key);
    if (cached) {
      this.metrics.memoryHits += 1;
      return cached;
    }
    const persisted = await this.persistence.findProfile(request);
    if (!persisted) return null;
    this.metrics.databaseHits += 1;
    return this.cache.set(key, persisted);
  }

  onMaterialized(
    listener: (profile: WorldEnvironmentCellProfile) => void | Promise<void>
  ): () => void {
    this.materializedListeners.add(listener);
    return () => this.materializedListeners.delete(listener);
  }

  setJobNotifier(notifier: (() => void) | null): void {
    this.jobNotifier = notifier;
  }

  async acceptMaterializedProfile(profile: WorldEnvironmentCellProfile): Promise<void> {
    this.metrics.materializationsSucceeded += 1;
    this.cache.set(worldEnvironmentProfileCacheKey(profile), profile);
    const outcomes = await Promise.allSettled(
      [...this.materializedListeners].map((listener) => Promise.resolve(listener(profile)))
    );
    for (const outcome of outcomes) {
      if (outcome.status !== "rejected") continue;
      this.metrics.materializedListenerFailures += 1;
      this.logger?.warn({
        err: outcome.reason,
        cellId: profile.cellId
      }, "gameplay environment profile listener failed");
    }
  }

  recordMaterializationFailure(): void {
    this.metrics.materializationsFailed += 1;
  }

  metricsSnapshot(): GameplayEnvironmentProfileMetrics {
    return {
      ...this.metrics,
      cacheEntries: this.cache.size,
      inFlightResolutions: this.inFlight.size
    };
  }

  private async resolve(
    request: WorldEnvironmentProfileRequest,
    key: string
  ): Promise<EnsureWorldEnvironmentProfileResult> {
    const persisted = await this.persistence.findProfile(request);
    if (persisted) {
      this.metrics.databaseHits += 1;
      return { status: "ready", profile: this.cache.set(key, persisted), source: "database" };
    }
    this.metrics.durableMisses += 1;
    const admission = await this.persistence.submitJob(request);
    if (admission.admitted === false) {
      this.metrics.jobsBackpressured += 1;
      return {
        status: "pending",
        profile: null,
        jobCreated: false,
        jobStatus: "pending"
      };
    }
    if (admission.created) this.metrics.jobsCreated += 1;
    else this.metrics.jobsDeduplicated += 1;
    if (admission.status === "pending" || admission.status === "retryable-failure") {
      this.jobNotifier?.();
    } else if (admission.status === "terminal-failure") {
      this.logger?.warn({
        cellId: request.cellId,
        worldIdentityKey: request.worldIdentityKey,
        profileVersion: request.profileVersion,
        candidateSlotVersion: request.candidateSlotVersion
      }, "gameplay environment profile job is terminally failed");
    }
    if (admission.status === "ready") {
      const completed = await this.persistence.findProfile(request);
      if (!completed) {
        throw new Error(`ready environment profile job ${worldEnvironmentProfileJobKey(request)} has no profile`);
      }
      this.metrics.databaseHits += 1;
      return { status: "ready", profile: this.cache.set(key, completed), source: "database" };
    }
    return {
      status: "pending",
      profile: null,
      jobCreated: admission.created,
      jobStatus: admission.status
    };
  }
}

function validateWorldIdentity(identity: WorldEnvironmentDataIdentity): void {
  if (
    identity.releaseId.length === 0 ||
    identity.profileSetFingerprint.length === 0 ||
    identity.buildContractFingerprint.length === 0 ||
    identity.boundaryReleaseId.length === 0
  ) {
    throw new Error("World environment identity fields must not be empty");
  }
}

function validateRequestIdentity(request: WorldEnvironmentProfileRequest): void {
  const expected = worldEnvironmentIdentityKey(request.worldIdentity);
  if (request.worldIdentityKey !== expected) {
    throw new Error("World environment identity key does not match immutable identity fields");
  }
}

function slotSeed(
  request: Pick<WorldEnvironmentProfileRequest, "cellId" | "candidateSlotVersion">,
  slotIndex: number
): string {
  return `${request.cellId}:${request.candidateSlotVersion}:${slotIndex}`;
}

function slotId(seed: string): string {
  return `slot:${sha256(seed).slice(0, 32)}`;
}

function placementTags(
  base: readonly string[],
  environment: CompactGameplayEnvironmentFacts,
  eligibleLand: boolean
): string[] {
  const tags = new Set(base);
  tags.add(eligibleLand ? "eligible-land" : "ineligible");
  tags.add(environment.isLand ? "land" : "water");
  if (environment.isSaltwater) tags.add("saltwater");
  if (environment.insideMajorLake) tags.add("major-lake");
  if (environment.waterKind) tags.add(`surface:${environment.waterKind}`);
  if (environment.isCoastal) tags.add("coastal");
  if (environment.isCoastalLand) tags.add("coastal-land");
  if (environment.isRiverbank) tags.add("riverbank");
  if (environment.isLakeshore) tags.add("lakeshore");
  addClassTag(tags, "elevation", environment.elevationBand);
  addClassTag(tags, "terrain", environment.terrainClass);
  addClassTag(tags, "land-cover", environment.landCoverClass);
  addClassTag(tags, "biome", environment.biomeId ?? environment.biomeName);
  addClassTag(tags, "ecoregion", environment.ecoregionId ?? environment.ecoregionName);
  return [...tags].sort();
}

function addClassTag(tags: Set<string>, prefix: string, value: string | null): void {
  if (!value) return;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (normalized) tags.add(`${prefix}:${normalized}`);
}

function hashUnit(value: string): number {
  return createHash("sha256").update(value, "utf8").digest().readUInt32BE(0) / 4_294_967_296;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function immutableProfile(profile: WorldEnvironmentCellProfile): WorldEnvironmentCellProfile {
  return deepFreeze(structuredClone(profile));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
