import type { LatLon } from "./types.js";
import type { MobAppearanceVariant } from "./mobContracts.js";

/** The two host families currently supported by the shared boss layer. */
export const BOSS_HOST_KINDS = ["overworld", "dungeon"] as const;
export type BossHostKind = (typeof BOSS_HOST_KINDS)[number];

/** A boss is intentionally allowed to use a dormant or host-specific state. */
export const BOSS_LIFECYCLE_STATES = [
  "created",
  "dormant",
  "active",
  "resetting",
  "defeated",
  "cancelled",
  "despawned"
] as const;
export type BossLifecycleState = (typeof BOSS_LIFECYCLE_STATES)[number];

/**
 * Stable ownership attached to the combat projection.  The encounter handler
 * is an explicit routing key; archetypeKey remains combat/stat identity only.
 */
export type BossEntityOwnership = Readonly<{
  bossId: string;
  bossRevision: number;
  encounterHandlerId: string;
  hostKind: BossHostKind;
  hostInstanceId: string;
  encounterInstanceId: string;
  appearanceId?: string;
  appearanceVariant?: MobAppearanceVariant;
  lifeGeneration: number;
}>;

export type BossCircleGeometry = Readonly<{
  kind: "circle";
  center: LatLon;
  radiusM: number;
}>;

export type BossConeGeometry = Readonly<{
  kind: "cone";
  origin: LatLon;
  facingDegrees: number;
  rangeM: number;
  angleDegrees: number;
}>;

export type BossLineGeometry = Readonly<{
  kind: "line";
  origin: LatLon;
  facingDegrees: number;
  lengthM: number;
  widthM: number;
}>;

export type BossTelegraphGeometry =
  | BossCircleGeometry
  | BossConeGeometry
  | BossLineGeometry;

export type BossCastSnapshot = Readonly<{
  encounterId: string;
  bossId: string;
  abilityId: string;
  castInstanceId: string;
  startTime: number;
  resolveTime: number;
  /** Total warning length (resolveTime - startTime). Present on everyday-mob telegraphs. */
  durationMs?: number;
  /** Warning time left at serialization; clients anchor on receipt so clock skew and delta batching don't eat it. */
  remainingMs?: number;
  origin: LatLon;
  facingDegrees?: number;
  targetEntityId?: string;
  geometry: BossTelegraphGeometry;
  lifeGeneration: number;
}>;

export type BossEncounterProjection = Readonly<{
  encounterId: string;
  bossId: string;
  bossRevision: number;
  encounterHandlerId: string;
  hostKind: BossHostKind;
  hostInstanceId: string;
  encounterInstanceId: string;
  mobEntityId: string;
  lifecycleState: BossLifecycleState;
  phaseId: string | null;
  /** Server-owned deadline for the currently projected phase, when one exists. */
  phaseDeadlineAt?: number;
  lifeGeneration: number;
  participation: Readonly<{
    policyId: string;
    canJoin: boolean;
    participantIds: readonly string[];
  }>;
  activeCasts: readonly BossCastSnapshot[];
}>;

export type BossPoint = LatLon;
