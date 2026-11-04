import { hash } from "node:crypto";

import { POPULATION_ZONE_V2_GEOMETRY_VERSION } from "./populationZonesV2Geometry.js";

export const POPULATION_PLAN_VERSION =
  "population-zone-plan-compiler-v6-stone-snapshot-compat";
export const POPULATION_SPAWN_RULES_VERSION =
  "population-spawn-rules-v4-uniform-tree-varieties";
export const POPULATION_CANDIDATE_LAYOUT_VERSION =
  "compact-owner-surface-origins-v5";
export const POPULATION_RESPAWN_POLICY_VERSION =
  "population-generation-48h-v1";
export const POPULATION_STONE_PLACEMENT_VERSION =
  "population-permanent-stone-placement-v1";
export const POPULATION_PERMANENT_MINE_KIND_NAMESPACE =
  "population-permanent-mine-kind-v1";
export const PERMANENT_MINE_KINDS = ["stone", "coal", "iron"] as const;
export type PermanentMineKind = (typeof PERMANENT_MINE_KINDS)[number];

export const POPULATION_PLAN_CACHE_TRANSITION = {
  populationPlanVersion:
    "population-zone-plan-compiler-v6-stone-snapshot-compat",
  spawnRulesVersion: "population-spawn-rules-v4-uniform-tree-varieties",
  candidateLayoutVersion: "compact-owner-surface-origins-v5",
  strategy: "destination_backfill_required"
} as const satisfies Readonly<{
  populationPlanVersion: typeof POPULATION_PLAN_VERSION;
  spawnRulesVersion: typeof POPULATION_SPAWN_RULES_VERSION;
  candidateLayoutVersion: typeof POPULATION_CANDIDATE_LAYOUT_VERSION;
  strategy:
    | "compatible_adoption"
    | "lazy_rebuild_acceptable"
    | "destination_backfill_required";
}>;

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | Readonly<{ [key: string]: CanonicalJsonValue }>;

export type PopulationZoneV2PlanIdentity = Readonly<{
  zoneId: string;
  geometryVersion: typeof POPULATION_ZONE_V2_GEOMETRY_VERSION;
  worldEnvironmentIdentityKey: string;
  populationPlanVersion: typeof POPULATION_PLAN_VERSION;
  spawnRulesVersion: typeof POPULATION_SPAWN_RULES_VERSION;
  environmentProfileVersion: string;
  candidateLayoutVersion: typeof POPULATION_CANDIDATE_LAYOUT_VERSION;
  respawnPolicyVersion: typeof POPULATION_RESPAWN_POLICY_VERSION;
}>;

export type PopulationEnvironmentArtifactIdentity = Readonly<{
  zoneId: string;
  geometryVersion: typeof POPULATION_ZONE_V2_GEOMETRY_VERSION;
  worldEnvironmentIdentityKey: string;
  environmentProfileVersion: string;
}>;

export type PopulationGenerationRecipeIdentity = Readonly<{
  populationPlanVersion: typeof POPULATION_PLAN_VERSION;
  spawnRulesVersion: typeof POPULATION_SPAWN_RULES_VERSION;
  candidateLayoutVersion: typeof POPULATION_CANDIDATE_LAYOUT_VERSION;
  respawnPolicyVersion: typeof POPULATION_RESPAWN_POLICY_VERSION;
}>;

export function populationEnvironmentArtifactIdentity(
  identity: PopulationZoneV2PlanIdentity
): PopulationEnvironmentArtifactIdentity {
  return {
    zoneId: identity.zoneId,
    geometryVersion: identity.geometryVersion,
    worldEnvironmentIdentityKey: identity.worldEnvironmentIdentityKey,
    environmentProfileVersion: identity.environmentProfileVersion
  };
}

export function populationGenerationRecipeIdentity(
  identity: PopulationZoneV2PlanIdentity
): PopulationGenerationRecipeIdentity {
  return {
    populationPlanVersion: identity.populationPlanVersion,
    spawnRulesVersion: identity.spawnRulesVersion,
    candidateLayoutVersion: identity.candidateLayoutVersion,
    respawnPolicyVersion: identity.respawnPolicyVersion
  };
}

export function populationZoneV2PlanIdentity(input: Readonly<{
  zoneId: string;
  worldEnvironmentIdentityKey: string;
  environmentProfileVersion: string;
}>): PopulationZoneV2PlanIdentity {
  if (input.zoneId.length === 0) {
    throw new Error("population zone id is required");
  }
  assertSha256(input.worldEnvironmentIdentityKey, "World environment identity");
  if (input.environmentProfileVersion.length === 0) {
    throw new Error("environment profile version is required");
  }
  return {
    zoneId: input.zoneId,
    geometryVersion: POPULATION_ZONE_V2_GEOMETRY_VERSION,
    worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
    populationPlanVersion: POPULATION_PLAN_VERSION,
    spawnRulesVersion: POPULATION_SPAWN_RULES_VERSION,
    environmentProfileVersion: input.environmentProfileVersion,
    candidateLayoutVersion: POPULATION_CANDIDATE_LAYOUT_VERSION,
    respawnPolicyVersion: POPULATION_RESPAWN_POLICY_VERSION
  };
}

export function populationZoneV2CanonicalPlanKey(
  identity: PopulationZoneV2PlanIdentity
): string {
  return canonicalJson(identity);
}

export function samePopulationZoneV2PlanAuthority(
  left: PopulationZoneV2PlanIdentity,
  right: PopulationZoneV2PlanIdentity
): boolean {
  return populationZoneV2CanonicalPlanKey(left)
    === populationZoneV2CanonicalPlanKey(right);
}

export function assertSamePopulationZoneV2PlanAuthority(
  left: PopulationZoneV2PlanIdentity,
  right: PopulationZoneV2PlanIdentity
): void {
  if (!samePopulationZoneV2PlanAuthority(left, right)) {
    throw new Error("population plan identities differ");
  }
}

export function populationZoneV2PlanId(
  identity: PopulationZoneV2PlanIdentity
): string {
  return deterministicUuidV8(
    "population-plan-id-v2",
    populationZoneV2CanonicalPlanKey(identity)
  );
}

export function populationZoneV2AdvisoryLockKey(
  identity: PopulationZoneV2PlanIdentity
): bigint {
  const digest = hash(
    "sha256",
    `population-plan-v2-lock\0${populationZoneV2CanonicalPlanKey(identity)}`,
    "buffer"
  );
  return digest.readBigInt64BE(0);
}

export function stablePlanScopedUuid(
  namespace: string,
  identity: PopulationZoneV2PlanIdentity,
  fields: Readonly<Record<string, CanonicalJsonValue>>
): string {
  return deterministicUuidV8(namespace, {
    ...fields,
    candidateLayoutVersion: identity.candidateLayoutVersion,
    environmentProfileVersion: identity.environmentProfileVersion,
    geometryVersion: identity.geometryVersion,
    populationPlanVersion: identity.populationPlanVersion,
    respawnPolicyVersion: identity.respawnPolicyVersion,
    spawnRulesVersion: identity.spawnRulesVersion,
    worldEnvironmentIdentityKey: identity.worldEnvironmentIdentityKey
  });
}

export function permanentPopulationStoneIdentity(input: Readonly<{
  identity: PopulationZoneV2PlanIdentity;
  candidateId: string;
  ownerZoneId: string;
}>): Readonly<{ slotId: string; entityId: string }> {
  if (input.candidateId.length === 0 || input.ownerZoneId.length === 0) {
    throw new Error("permanent stone candidate and owner zone are required");
  }
  const authority = {
    candidateId: input.candidateId,
    ownerZoneId: input.ownerZoneId,
    stonePlacementVersion: POPULATION_STONE_PLACEMENT_VERSION,
    worldEnvironmentIdentityKey:
      input.identity.worldEnvironmentIdentityKey
  };
  const slotId = deterministicUuidV8(
    "population-permanent-stone-slot-id-v1",
    authority
  );
  return {
    slotId,
    entityId: deterministicUuidV8(
      "population-permanent-stone-entity-id-v1",
      { ...authority, slotId }
    )
  };
}

export function permanentMineKindForSlot(slotId: string): PermanentMineKind {
  if (slotId.length === 0) {
    throw new Error("permanent mine slot id is required");
  }
  const digest = hash(
    "md5",
    `${POPULATION_PERMANENT_MINE_KIND_NAMESPACE}\0${slotId}`,
    "buffer"
  );
  const unit = digest.readUInt32BE(0) / 0x1_0000_0000;
  return unit < 1 / 3 ? "stone" : unit < 2 / 3 ? "coal" : "iron";
}

export function deterministicUuidV8(
  namespace: string,
  value: CanonicalJsonValue
): string {
  if (namespace.length === 0) {
    throw new Error("UUID namespace is required");
  }
  const digest = hash(
    "sha256",
    `${namespace}\0${canonicalJson(value)}`,
    "buffer"
  );
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join("-");
}

export function canonicalJson(value: CanonicalJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical JSON numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as Readonly<Record<string, CanonicalJsonValue>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`;
}

export function sha256Hex(value: CanonicalJsonValue | string): string {
  const serialized = typeof value === "string" ? value : canonicalJson(value);
  return hash("sha256", serialized, "hex");
}

export function hashPartsHex(
  ...parts: readonly (string | number)[]
): string {
  let serialized = "";
  for (const part of parts) {
    const value = String(part);
    serialized += `${Buffer.byteLength(value)}:${value}|`;
  }
  return hash("sha256", serialized, "hex");
}

export function deterministicUnit(
  ...parts: readonly (string | number)[]
): number {
  const hex = hashPartsHex(...parts).slice(0, 13);
  return Number.parseInt(hex, 16) / 0x10_0000_0000_0000;
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex string`);
  }
}
