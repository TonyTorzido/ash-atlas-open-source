import {
  POPULATION_PREPARATION_REASONS,
  assertGameplayAreaContract,
  type GameplayAreaContract,
  type PopulationPreparationReason
} from "@ash-atlas/shared";
import type { EquipmentChallengeProfile } from "@ash-atlas/shared";

export {
  POPULATION_PREPARATION_REASONS,
  type PopulationPreparationReason
};

export const POPULATION_PREPARATION_STAGES = [
  "PLAN_READY",
  "DURABLE_READY",
  "SIMULATION_READY",
  "PUBLISHED"
] as const;

export type PopulationPreparationStage =
  (typeof POPULATION_PREPARATION_STAGES)[number];

export const POPULATION_STREAMING_SOURCE_KINDS = [
  "player-visible",
  "player-prepared-envelope",
  "world-entry",
  "reconnect",
  "flag-build",
  "flag-travel",
  "shrine-travel",
  "city-travel",
  "kingdom-travel",
  "party-travel",
  "separate-space-exit",
  "administrative-relocation",
  "optional-neighbor-preload",
  "explicit-recovery"
] as const;

export type PopulationStreamingSourceKind =
  (typeof POPULATION_STREAMING_SOURCE_KINDS)[number];

export type PopulationPreparationPriority = 0 | 1 | 2 | 3;

export type PopulationZoneAuthorityFingerprint = Readonly<{
  zoneId: string;
  selectedPlanId: string;
  generationId: string | null;
  cutoverRevision: number;
  commonSchemaRevision: string;
  registryRevision: string;
  stateRevisionFingerprint: string;
  ownershipToken: string;
}>;

export type PopulationStreamingSource = Readonly<{
  sourceId: string;
  kind: PopulationStreamingSourceKind;
  targetStage: PopulationPreparationStage;
  priority: PopulationPreparationPriority;
  createdAtMs: number;
  playerId?: string;
  connectionId?: string;
  connectionGeneration?: number;
  requestId?: string;
  buildId?: string;
  travelId?: string;
  expiresAtMs?: number;
  authorityToken: string;
  /** Present only for an authoritative foreground simulation claim. */
  challengeProfile?: EquipmentChallengeProfile;
}>;

export type PopulationAreaPreparationRequest = Readonly<{
  area: GameplayAreaContract;
  source: PopulationStreamingSource;
  signal?: AbortSignal;
}>;

export type PopulationZonePreparationOutcome = Readonly<{
  zoneId: string;
  requestedStage: PopulationPreparationStage;
  completedStage: PopulationPreparationStage | null;
  status: "ready" | "pending" | "deferred" | "failed" | "cancelled" | "stale";
  reason: PopulationPreparationReason;
  authority: PopulationZoneAuthorityFingerprint | null;
  durationMs: number;
}>;

const STAGE_RANK: Readonly<Record<PopulationPreparationStage, number>> = {
  PLAN_READY: 0,
  DURABLE_READY: 1,
  SIMULATION_READY: 2,
  PUBLISHED: 3
};

const SOURCE_KINDS = new Set<string>(POPULATION_STREAMING_SOURCE_KINDS);

export function populationStageRank(stage: PopulationPreparationStage): number {
  return STAGE_RANK[stage];
}

export function populationStageAtLeast(
  completed: PopulationPreparationStage | null,
  requested: PopulationPreparationStage
): boolean {
  return completed !== null &&
    populationStageRank(completed) >= populationStageRank(requested);
}

export function maximumPopulationStage(
  left: PopulationPreparationStage,
  right: PopulationPreparationStage
): PopulationPreparationStage {
  return populationStageRank(left) >= populationStageRank(right)
    ? left
    : right;
}

export function assertPopulationAreaPreparationRequest(
  input: PopulationAreaPreparationRequest
): void {
  assertGameplayAreaContract(input.area);
  const source = input.source;
  if (
    source.sourceId.trim().length === 0 ||
    source.authorityToken.trim().length === 0 ||
    !SOURCE_KINDS.has(source.kind) ||
    !Number.isSafeInteger(source.createdAtMs) ||
    source.createdAtMs < 0 ||
    !Number.isSafeInteger(source.priority) ||
    source.priority < 0 ||
    source.priority > 3
  ) {
    throw new Error("invalid population streaming source");
  }
  if (
    source.connectionGeneration !== undefined &&
    (
      !Number.isSafeInteger(source.connectionGeneration) ||
      source.connectionGeneration < 0
    )
  ) {
    throw new Error("invalid population streaming connection generation");
  }
  if (
    source.expiresAtMs !== undefined &&
    (
      !Number.isSafeInteger(source.expiresAtMs) ||
      source.expiresAtMs <= source.createdAtMs
    )
  ) {
    throw new Error("invalid population streaming source expiration");
  }
  if (
    source.targetStage === "PUBLISHED" &&
    (
      source.playerId === undefined ||
      source.connectionId === undefined ||
      source.connectionGeneration === undefined
    )
  ) {
    throw new Error(
      "published population source requires player and connection authority"
    );
  }
}
