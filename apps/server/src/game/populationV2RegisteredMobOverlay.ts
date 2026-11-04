import { destinationPoint } from "@ash-atlas/shared";

import { populationV2MobRegistry } from "./populationV2MobRegistry.js";
import { environmentSpawnPolicyMatches } from "./environmentSpawnProfiles.js";
import type {
  POPULATION_V2_MOB_DEFINITIONS,
  PopulationV2MobDefinition,
  PopulationV2MobRolloutPolicy,
  PopulationV2MobRegistry
} from "./populationV2MobRegistry.js";
import {
  populationV2SpacingConflict,
  type PopulationV2SpacingClass
} from "./populationV2MobSpacing.js";
import {
  deterministicUnit,
  hashPartsHex
} from "./populationZonesV2Identity.js";
import type {
  PopulationZoneV2Habitat,
  PopulationZoneV2HabitatCandidateSite,
  PopulationZoneV2PlanSlot
} from "./populationZonesV2Plan.js";

const FORMATION_MINIMUM_RADIUS_M = 8;
const FORMATION_MAXIMUM_RADIUS_M = 18;

type DefaultPopulationV2MobDefinition =
  (typeof POPULATION_V2_MOB_DEFINITIONS)[number];

export type PopulationV2RegisteredMobOverlayMode =
  | "next_generation"
  | "existing_generation_top_up";

export type PopulationV2RegisteredMobOccupiedSlot = Readonly<
  Omit<PopulationZoneV2PlanSlot, "entityKind"> & {
    entityKind: string;
    placementRevision?: string;
    spacingClass?: PopulationV2SpacingClass;
    persistenceCorruption?: string;
    identityCompatibility?: "exact_bad_deploy_sap";
    identityAuthorityCandidateId?: string;
  }
>;

export type PopulationV2RegisteredMobOverlaySlot<
  MobKind extends string = string
> = Readonly<
  Omit<PopulationV2RegisteredMobOccupiedSlot, "entityKind"> & {
    entityKind: MobKind;
    mobKind: MobKind;
    placementRevision: string;
    spacingClass: PopulationV2SpacingClass;
    sourceAnchorSiteId: string;
  }
>;

export type PopulationV2RegisteredMobPartialGroupDiagnostic = Readonly<{
  mobKind: string;
  placementRevision: string;
  candidateId: string;
  bodyCount: number;
  presentMemberIndexes: readonly (number | null)[];
  expectedMemberCounts: readonly number[];
  reason: "partial_or_corrupt_persisted_group";
}>;

export type PopulationV2RegisteredMobOverlayCounts = Readonly<{
  groups: number;
  bodies: number;
}>;

export type PopulationV2RegisteredMobOverlayMobResult<
  MobKind extends string = string
> = Readonly<{
  mobKind: MobKind;
  placementRevision: string;
  rolloutPolicy: PopulationV2MobRolloutPolicy;
  status:
    | "completed"
    | "completed_with_shortfall"
    | "terminal_partial_group";
  target: PopulationV2RegisteredMobOverlayCounts;
  current: PopulationV2RegisteredMobOverlayCounts;
  inserted: PopulationV2RegisteredMobOverlayCounts;
  shortfall: PopulationV2RegisteredMobOverlayCounts;
  eligibleAnchorCount: number;
  consideredAnchorCount: number;
  terminalPartialGroups:
    readonly PopulationV2RegisteredMobPartialGroupDiagnostic[];
}>;

export type PopulationV2RegisteredMobOverlayResult<
  MobKind extends string = string
> = Readonly<{
  mode: PopulationV2RegisteredMobOverlayMode;
  status:
    | "completed"
    | "completed_with_shortfall"
    | "terminal_partial_group";
  slots: readonly PopulationV2RegisteredMobOverlaySlot<MobKind>[];
  mobs: readonly PopulationV2RegisteredMobOverlayMobResult<MobKind>[];
  target: PopulationV2RegisteredMobOverlayCounts;
  current: PopulationV2RegisteredMobOverlayCounts;
  inserted: PopulationV2RegisteredMobOverlayCounts;
  shortfall: PopulationV2RegisteredMobOverlayCounts;
  terminalPartialGroups:
    readonly PopulationV2RegisteredMobPartialGroupDiagnostic[];
}>;

export type PopulationV2RegisteredMobOverlayInput<
  Definition extends PopulationV2MobDefinition =
    DefaultPopulationV2MobDefinition
> = Readonly<{
  generationId: string;
  habitat: PopulationZoneV2Habitat;
  occupiedSlots: readonly PopulationV2RegisteredMobOccupiedSlot[];
  spacingOccupants?: readonly PopulationV2RegisteredMobOccupiedSlot[];
  mode?: PopulationV2RegisteredMobOverlayMode;
  mobKinds?: readonly Definition["mobKind"][];
  registry?: PopulationV2MobRegistry<Definition>;
}>;

/** Returned slots are insertions only. Existing placements are immutable inputs. */
export function planPopulationV2RegisteredMobOverlay<
  Definition extends PopulationV2MobDefinition =
    DefaultPopulationV2MobDefinition
>(
  input: PopulationV2RegisteredMobOverlayInput<Definition>
): PopulationV2RegisteredMobOverlayResult<Definition["mobKind"]> {
  if (input.generationId.trim().length === 0) {
    throw new Error("registered mob overlay requires a generation ID");
  }
  const mode = input.mode ?? "next_generation";
  const registry = (
    input.registry ?? populationV2MobRegistry
  ) as PopulationV2MobRegistry<PopulationV2MobDefinition>;
  const definitions = selectedOverlayDefinitions({
    mode,
    mobKinds: input.mobKinds as readonly string[] | undefined,
    registry
  });
  const allOccupants = [
    ...input.occupiedSlots,
    ...(input.spacingOccupants ?? [])
  ];
  const occupied = occupiedPlacements(allOccupants, registry);
  const occupiedSlotIds = new Set(allOccupants.map((slot) =>
    slot.slotId
  ));
  const occupiedEntityIds = new Set(allOccupants.map((slot) =>
    slot.entityId
  ));
  const output: PopulationV2RegisteredMobOverlaySlot<string>[] = [];
  const mobResults: PopulationV2RegisteredMobOverlayMobResult<string>[] = [];

  for (const definition of definitions) {
    const result = planDefinition({
      definition,
      generationId: input.generationId,
      habitat: input.habitat,
      occupiedSlots: input.occupiedSlots,
      occupied,
      occupiedSlotIds,
      occupiedEntityIds,
      registry
    });
    output.push(...result.slots);
    mobResults.push(result.result);
  }

  const terminalPartialGroups = mobResults.flatMap((result) =>
    result.terminalPartialGroups
  );
  const aggregate = {
    target: sumCounts(mobResults.map((result) => result.target)),
    current: sumCounts(mobResults.map((result) => result.current)),
    inserted: sumCounts(mobResults.map((result) => result.inserted)),
    shortfall: sumCounts(mobResults.map((result) => result.shortfall))
  };
  const status = terminalPartialGroups.length > 0
    ? "terminal_partial_group"
    : aggregate.shortfall.groups > 0
      ? "completed_with_shortfall"
      : "completed";
  return {
    mode,
    status,
    slots: output as PopulationV2RegisteredMobOverlaySlot<
      Definition["mobKind"]
    >[],
    mobs: mobResults as PopulationV2RegisteredMobOverlayMobResult<
      Definition["mobKind"]
    >[],
    ...aggregate,
    terminalPartialGroups
  };
}

export function populationV2RegisteredMobFormation(
  definition: PopulationV2MobDefinition,
  candidateId: string,
  anchor: Readonly<{ lat: number; lon: number }>
): readonly Readonly<{ lat: number; lon: number }>[] {
  if (definition.spawnModel === "single") return [{ ...anchor }];
  const formation = definition.packFormation;
  if (formation === undefined) {
    throw new Error(`registered pack mob ${definition.mobKind} has no formation`);
  }
  const memberCount = formation.memberCountForCandidate(candidateId);
  if (!formation.allowedMemberCounts.includes(memberCount)) {
    throw new Error(
      `registered mob ${definition.mobKind} selected an invalid group size`
    );
  }
  const baseBearing = deterministicUnit(
    "population-v2-registered-mob-formation-bearing-v1",
    definition.mobKind,
    definition.placementRevision,
    candidateId
  ) * 360;
  const minimumRadiusM = formation.minimumRadiusM
    ?? FORMATION_MINIMUM_RADIUS_M;
  const maximumRadiusM = formation.maximumRadiusM
    ?? FORMATION_MAXIMUM_RADIUS_M;
  return Array.from({ length: memberCount }, (_, memberIndex) => {
    const radiusM = minimumRadiusM
      + deterministicUnit(
        "population-v2-registered-mob-formation-radius-v1",
        definition.mobKind,
        definition.placementRevision,
        candidateId,
        memberIndex
      ) * (maximumRadiusM - minimumRadiusM);
    return destinationPoint(
      anchor,
      radiusM,
      baseBearing + memberIndex * (360 / memberCount)
    );
  });
}

export function materializePopulationV2RegisteredMobCandidate(input: Readonly<{
  definition: PopulationV2MobDefinition;
  generationId: string;
  encounterOrigin: PopulationZoneV2HabitatCandidateSite;
  registry?: PopulationV2MobRegistry<PopulationV2MobDefinition>;
}>): readonly PopulationV2RegisteredMobOverlaySlot<string>[] {
  return buildCandidate(
    input.definition,
    input.generationId,
    input.encounterOrigin,
    input.registry ?? populationV2MobRegistry
  ).slots;
}

function planDefinition(input: Readonly<{
  definition: PopulationV2MobDefinition;
  generationId: string;
  habitat: PopulationZoneV2Habitat;
  occupiedSlots: readonly PopulationV2RegisteredMobOccupiedSlot[];
  occupied: OccupiedPlacement[];
  occupiedSlotIds: Set<string>;
  occupiedEntityIds: Set<string>;
  registry: PopulationV2MobRegistry<PopulationV2MobDefinition>;
}>): Readonly<{
  slots: PopulationV2RegisteredMobOverlaySlot<string>[];
  result: PopulationV2RegisteredMobOverlayMobResult<string>;
}> {
  const groups = persistedGroupsForDefinition(
    input.definition,
    input.occupiedSlots,
    input.generationId,
    input.registry
  );
  const completeGroups = groups.filter((group) => group.complete);
  const partialGroups = groups.filter((group) => !group.complete);
  const terminalPartialGroups = partialGroups.map((group) => ({
    mobKind: input.definition.mobKind,
    placementRevision: input.definition.placementRevision,
    candidateId: group.candidateId,
    bodyCount: group.slots.length,
    presentMemberIndexes: group.slots.map((slot) =>
      slot.packMemberIndex
    ).sort(nullableNumberOrder),
    expectedMemberCounts: group.expectedMemberCount === null
      ? input.definition.spawnModel === "single"
        ? [1]
        : [...input.definition.packFormation!.allowedMemberCounts]
      : [group.expectedMemberCount],
    reason: "partial_or_corrupt_persisted_group" as const
  }));
  const targetGroupCount = targetGroupsForDefinition(
    input.definition,
    input.generationId,
    input.habitat
  );
  const current = {
    groups: completeGroups.length,
    bodies: completeGroups.reduce(
      (total, group) => total + group.slots.length,
      0
    )
  };
  const groupDeficit = Math.max(0, targetGroupCount - current.groups);
  const anchors = eligibleAnchors(
    input.definition,
    input.habitat
  ).sort((left, right) =>
    registeredAnchorRank(
      input.generationId,
      input.definition,
      left
    ).localeCompare(registeredAnchorRank(
      input.generationId,
      input.definition,
      right
    )) || left.siteId.localeCompare(right.siteId)
  );
  const maximumCandidates = Math.min(
    anchors.length,
    Math.ceil(
      targetGroupCount
      * input.definition.density.candidateOversamplingFactor
    )
  );
  const candidates = anchors.slice(0, maximumCandidates);
  const existingCandidateIds = new Set(completeGroups.map((group) =>
    group.candidateId
  ));
  const slots: PopulationV2RegisteredMobOverlaySlot<string>[] = [];
  const rejectedBodyCounts: number[] = [];
  let insertedGroups = 0;

  if (partialGroups.length === 0) {
    for (const anchor of candidates) {
      if (insertedGroups >= groupDeficit) break;
      const candidate = buildCandidate(
        input.definition,
        input.generationId,
        anchor,
        input.registry
      );
      if (existingCandidateIds.has(candidate.identityCandidateId)) continue;
      if (candidate.slots.some((slot) =>
        input.occupiedSlotIds.has(slot.slotId)
        || input.occupiedEntityIds.has(slot.entityId)
      )) {
        rejectedBodyCounts.push(candidate.slots.length);
        continue;
      }
      if (input.occupied.some((placement) =>
        populationV2SpacingConflict(placement, candidate.placement)
      )) {
        rejectedBodyCounts.push(candidate.slots.length);
        continue;
      }
      slots.push(...candidate.slots);
      insertedGroups += 1;
      input.occupied.push(candidate.placement);
      for (const slot of candidate.slots) {
        input.occupiedSlotIds.add(slot.slotId);
        input.occupiedEntityIds.add(slot.entityId);
      }
    }
  }

  const inserted = {
    groups: insertedGroups,
    bodies: slots.length
  };
  const shortfallGroupCount = Math.max(
    0,
    groupDeficit - inserted.groups
  );
  const shortfallBodyCount = shortfallBodies({
    definition: input.definition,
    generationId: input.generationId,
    rejectedBodyCounts,
    shortfallGroupCount
  });
  const shortfall = {
    groups: shortfallGroupCount,
    bodies: shortfallBodyCount
  };
  const target = {
    groups: targetGroupCount,
    bodies: current.bodies + inserted.bodies + shortfall.bodies
  };
  return {
    slots,
    result: {
      mobKind: input.definition.mobKind,
      placementRevision: input.definition.placementRevision,
      rolloutPolicy: input.definition.defaultRolloutPolicy,
      status: terminalPartialGroups.length > 0
        ? "terminal_partial_group"
        : shortfall.groups > 0
          ? "completed_with_shortfall"
          : "completed",
      target,
      current,
      inserted,
      shortfall,
      eligibleAnchorCount: anchors.length,
      consideredAnchorCount: candidates.length,
      terminalPartialGroups
    }
  };
}

function buildCandidate(
  definition: PopulationV2MobDefinition,
  generationId: string,
  anchorSite: PopulationZoneV2HabitatCandidateSite,
  registry: PopulationV2MobRegistry<PopulationV2MobDefinition>
): Readonly<{
  identityCandidateId: string;
  slots: PopulationV2RegisteredMobOverlaySlot<string>[];
  placement: OccupiedPlacement;
}> {
  const deterministicCandidateId = anchorSite.siteId;
  const memberPositions = populationV2RegisteredMobFormation(
    definition,
    deterministicCandidateId,
    anchorSite.position
  );
  const candidate = definition.candidateBuilder({
    candidateId: deterministicCandidateId,
    anchor: anchorSite.position,
    memberPositions
  });
  const memberIndexes = candidate.members.map((member) =>
    member.memberIndex
  );
  const expectedMemberIndexes = definition.spawnModel === "pack"
    ? Array.from(
        { length: candidate.members.length },
        (_, memberIndex) => memberIndex
      )
    : [null];
  const memberPositionKeys = new Set(candidate.members.map((member) =>
    `${member.position.lat}/${member.position.lon}`
  ));
  if (
    candidate.candidateId !== deterministicCandidateId
    || candidate.mobKind !== definition.mobKind
    || candidate.anchor.lat !== anchorSite.position.lat
    || candidate.anchor.lon !== anchorSite.position.lon
    || candidate.members.length !== memberPositions.length
    || candidate.members.some((member) =>
      member.mobKind !== definition.mobKind
      || !Number.isFinite(member.position.lat)
      || member.position.lat < -90
      || member.position.lat > 90
      || !Number.isFinite(member.position.lon)
      || member.position.lon < -180
      || member.position.lon > 180
    )
    || JSON.stringify(memberIndexes) !==
      JSON.stringify(expectedMemberIndexes)
    || memberPositionKeys.size !== candidate.members.length
  ) {
    throw new Error(
      `registered mob ${definition.mobKind} generated a mixed or partial group`
    );
  }
  const environmentSnapshot = anchorEnvironmentSnapshot(
    definition,
    anchorSite
  );
  const slots = candidate.members.map((member) => {
    const identity = registry.registeredIdentityFor({
      generationId,
      mobKind: definition.mobKind,
      deterministicCandidateId,
      memberIndex: member.memberIndex
    });
    return {
      slotId: identity.slotId,
      entityId: identity.entityId,
      candidateId: identity.candidateId,
      entityKind: definition.mobKind,
      mobKind: definition.mobKind,
      archetype: definition.combatArchetype,
      encounterId: identity.encounterId,
      packId: identity.packId,
      packMemberIndex: identity.memberIndex,
      position: member.position,
      anchor: candidate.anchor,
      environmentSnapshot,
      suppressionClass: definition.suppressionClass,
      placementRevision: definition.placementRevision,
      spacingClass: definition.spacingClass,
      sourceAnchorSiteId: anchorSite.siteId
    };
  });
  const identityCandidateIds = new Set(slots.map((slot) =>
    slot.candidateId
  ));
  if (
    slots.length === 0
    || identityCandidateIds.size !== 1
    || (
      definition.spawnModel === "pack"
      && !definition.packFormation!.allowedMemberCounts.includes(slots.length)
    )
  ) {
    throw new Error(
      `registered mob ${definition.mobKind} generated an incomplete group`
    );
  }
  return {
    identityCandidateId: slots[0]!.candidateId,
    slots,
    placement: {
      spacingClass: definition.spacingClass,
      anchor: candidate.anchor,
      bodies: slots.map((slot) => slot.position)
    }
  };
}

function selectedOverlayDefinitions(input: Readonly<{
  mode: PopulationV2RegisteredMobOverlayMode;
  mobKinds: readonly string[] | undefined;
  registry: PopulationV2MobRegistry<PopulationV2MobDefinition>;
}>): PopulationV2MobDefinition[] {
  const registered = input.registry.definitions.filter((definition) =>
    definition.generationPlacement === "registered_overlay"
  );
  if (input.mode === "next_generation") {
    if (input.mobKinds === undefined) return [...registered];
  } else if (input.mobKinds === undefined || input.mobKinds.length === 0) {
    throw new Error(
      "existing-generation mob top-up requires explicit mob kinds"
    );
  }
  const requested = new Set(input.mobKinds);
  const selected = registered.filter((definition) =>
    requested.has(definition.mobKind)
  );
  if (selected.length !== requested.size) {
    const selectedKinds = new Set(selected.map((definition) =>
      definition.mobKind
    ));
    const unsupported = [...requested].filter((kind) =>
      !selectedKinds.has(kind)
    );
    throw new Error(
      `unsupported registered mob overlay kinds ${unsupported.join(", ")}`
    );
  }
  if (
    input.mode === "existing_generation_top_up"
    && selected.some((definition) =>
      !definition.existingGenerationRolloutEligible
    )
  ) {
    throw new Error(
      "requested registered mob is not eligible for existing-generation rollout"
    );
  }
  return selected;
}

function targetGroupsForDefinition(
  definition: PopulationV2MobDefinition,
  generationId: string,
  habitat: PopulationZoneV2Habitat
): number {
  const eligibleAreaKm2 = definition.eligibleAreaKm2(habitat);
  if (!Number.isFinite(eligibleAreaKm2) || eligibleAreaKm2 < 0) {
    throw new Error(
      `registered mob ${definition.mobKind} eligible area is invalid`
    );
  }
  const expected = definition.density.model === "common"
    ? eligibleAreaKm2 * definition.density.densityPerEligibleKm2
    : eligibleAreaKm2 / definition.density.targetAreaKm2;
  if (!Number.isFinite(expected) || expected > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `registered mob ${definition.mobKind} target density is invalid`
    );
  }
  const whole = Math.floor(expected);
  const fraction = expected - whole;
  return whole + (
    deterministicUnit(
      "population-v2-registered-mob-density-round-v1",
      generationId,
      definition.mobKind,
      definition.placementRevision
    ) < fraction
      ? 1
      : 0
  );
}

function eligibleAnchors(
  definition: PopulationV2MobDefinition,
  habitat: PopulationZoneV2Habitat
): PopulationZoneV2HabitatCandidateSite[] {
  if (habitat.candidateSites === undefined) return [];
  const unique = new Map<string, PopulationZoneV2HabitatCandidateSite>();
  for (const site of habitat.candidateSites) {
    if (
      !definition.isEligibleAnchor(site)
      || !candidateSiteHabitatPolicyMatches(definition, site)
      || site.isSaltwater
      || site.insideMajorLake
    ) continue;
    const existing = unique.get(site.siteId);
    if (
      existing !== undefined
      && (
        existing.position.lat !== site.position.lat
        || existing.position.lon !== site.position.lon
      )
    ) {
      throw new Error(
        `persisted habitat candidate anchor ${site.siteId} is ambiguous`
      );
    }
    unique.set(site.siteId, site);
  }
  return [...unique.values()];
}

function candidateSiteHabitatPolicyMatches(
  definition: PopulationV2MobDefinition,
  site: PopulationZoneV2HabitatCandidateSite
): boolean {
  if (definition.habitatPolicy === undefined) return true;
  return environmentSpawnPolicyMatches({
    isLand: site.surfaceType === "land"
      || (
        site.surfaceType === undefined
        && !site.isSaltwater
        && !site.insideMajorLake
        && site.weights.eligibleLand > 0
      ),
    isSaltwater: site.isSaltwater,
    isCoastalLand: site.placementTags.includes("coastal-land"),
    isRiverbank: site.isRiverbank ?? null,
    isLakeshore: site.isLakeshore ?? null,
    insideMajorLake: site.insideMajorLake,
    biomeId: site.biomeId,
    ecoregionId: site.ecoregionId,
    landCoverClass: site.landCoverClass,
    elevationBand: site.elevationBand,
    terrainClass: site.terrainClass,
    placementTags: site.placementTags
  }, definition.habitatPolicy);
}

function registeredAnchorRank(
  generationId: string,
  definition: PopulationV2MobDefinition,
  site: PopulationZoneV2HabitatCandidateSite
): string {
  return hashPartsHex(
    "population-v2-registered-mob-anchor-rank-v1",
    generationId,
    definition.mobKind,
    definition.placementRevision,
    site.siteId
  );
}

function anchorEnvironmentSnapshot(
  definition: PopulationV2MobDefinition,
  site: PopulationZoneV2HabitatCandidateSite
): PopulationZoneV2PlanSlot["environmentSnapshot"] {
  return {
    registeredMobAnchorVersion:
      "population-v2-registered-mob-flat-anchor-v1",
    mobKind: definition.mobKind,
    placementRevision: definition.placementRevision,
    generationPlacement: definition.generationPlacement,
    encounterSurface: definition.encounterSurface ?? null,
    sourceAnchorSiteId: site.siteId,
    source: site.source,
    sourceSampleId: site.sourceSampleId,
    sourceCellId: site.sourceCellId,
    sourceSlotId: site.sourceSlotId,
    candidateSlotVersion: site.candidateSlotVersion,
    placementTags: site.placementTags,
    spawnProfileKey: site.spawnProfileKey,
    surfaceType: site.surfaceType ?? null,
    surfaceAuthority: site.surfaceAuthority ?? null,
    eligibleLandWeight: site.weights.eligibleLand
  };
}

type PersistedGroup = Readonly<{
  candidateId: string;
  slots: readonly PopulationV2RegisteredMobOccupiedSlot[];
  complete: boolean;
  expectedMemberCount: number | null;
}>;

function persistedGroupsForDefinition(
  definition: PopulationV2MobDefinition,
  slots: readonly PopulationV2RegisteredMobOccupiedSlot[],
  generationId: string,
  registry: PopulationV2MobRegistry<PopulationV2MobDefinition>
): PersistedGroup[] {
  const byCandidate = new Map<
    string,
    PopulationV2RegisteredMobOccupiedSlot[]
  >();
  for (const slot of slots) {
    if (
      slot.entityKind !== definition.mobKind
      || slot.placementRevision !== definition.placementRevision
    ) continue;
    const group = byCandidate.get(slot.candidateId) ?? [];
    group.push(slot);
    byCandidate.set(slot.candidateId, group);
  }
  return [...byCandidate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([candidateId, group]) => {
      const expectedMemberCount = persistedExpectedMemberCount(
        definition,
        group
      );
      return {
        candidateId,
        slots: group,
        complete: persistedGroupIsComplete(
          definition,
          group,
          generationId,
          registry,
          expectedMemberCount
        ),
        expectedMemberCount
      };
    });
}

function persistedGroupIsComplete(
  definition: PopulationV2MobDefinition,
  slots: readonly PopulationV2RegisteredMobOccupiedSlot[],
  generationId: string,
  registry: PopulationV2MobRegistry<PopulationV2MobDefinition>,
  expectedMemberCount: number | null
): boolean {
  if (
    slots.some((slot) => slot.persistenceCorruption !== undefined)
    || expectedMemberCount === null
    || slots.length !== expectedMemberCount
  ) return false;
  const identityCompatibility = new Set(slots.map((slot) =>
    slot.identityCompatibility ?? "registered"
  ));
  const authorityCandidateIds = new Set(slots.map((slot) =>
    persistedIdentityAuthorityCandidateId(slot)
  ));
  if (
    identityCompatibility.size !== 1
    || authorityCandidateIds.size !== 1
    || authorityCandidateIds.has(null)
  ) return false;
  const authorityCandidateId = [...authorityCandidateIds][0]!;
  if (definition.spawnModel === "single") {
    return expectedMemberCount === 1
      && slots[0]!.packMemberIndex === null
      && slots[0]!.packId === null
      && persistedIdentityMatches({
        definition,
        generationId,
        registry,
        slot: slots[0]!,
        authorityCandidateId,
        compatibleLegacyIdentity:
          identityCompatibility.has("exact_bad_deploy_sap")
      });
  }
  const indexes = slots.map((slot) => slot.packMemberIndex)
    .sort(nullableNumberOrder);
  const expected = Array.from(
    { length: expectedMemberCount },
    (_, index) => index
  );
  return definition.packFormation!.allowedMemberCounts.includes(
    expectedMemberCount
  )
    && JSON.stringify(indexes) === JSON.stringify(expected)
    && slots.every((slot) =>
      slot.packId !== null
      && slot.encounterId !== null
      && slot.packId === slots[0]!.packId
      && slot.encounterId === slots[0]!.encounterId
      && persistedIdentityMatches({
        definition,
        generationId,
        registry,
        slot,
        authorityCandidateId,
        compatibleLegacyIdentity:
          identityCompatibility.has("exact_bad_deploy_sap")
      })
    );
}

function persistedExpectedMemberCount(
  definition: PopulationV2MobDefinition,
  slots: readonly PopulationV2RegisteredMobOccupiedSlot[]
): number | null {
  if (definition.spawnModel === "single") return 1;
  const authorityCandidateIds = new Set(slots.map((slot) =>
    persistedIdentityAuthorityCandidateId(slot)
  ));
  if (
    authorityCandidateIds.size !== 1
    || authorityCandidateIds.has(null)
  ) return null;
  const expected = definition.packFormation!.memberCountForCandidate(
    [...authorityCandidateIds][0]!
  );
  return definition.packFormation!.allowedMemberCounts.includes(expected)
    ? expected
    : null;
}

function persistedIdentityAuthorityCandidateId(
  slot: PopulationV2RegisteredMobOccupiedSlot
): string | null {
  if (slot.identityAuthorityCandidateId !== undefined) {
    return slot.identityAuthorityCandidateId.length > 0
      ? slot.identityAuthorityCandidateId
      : null;
  }
  const sourceAnchorSiteId =
    slot.environmentSnapshot.sourceAnchorSiteId;
  return typeof sourceAnchorSiteId === "string"
    && sourceAnchorSiteId.length > 0
    ? sourceAnchorSiteId
    : null;
}

function persistedIdentityMatches(input: Readonly<{
  definition: PopulationV2MobDefinition;
  generationId: string;
  registry: PopulationV2MobRegistry<PopulationV2MobDefinition>;
  slot: PopulationV2RegisteredMobOccupiedSlot;
  authorityCandidateId: string;
  compatibleLegacyIdentity: boolean;
}>): boolean {
  if (input.compatibleLegacyIdentity) {
    return input.slot.identityCompatibility === "exact_bad_deploy_sap";
  }
  const expected = input.registry.registeredIdentityFor({
    generationId: input.generationId,
    mobKind: input.definition.mobKind,
    deterministicCandidateId: input.authorityCandidateId,
    memberIndex: input.slot.packMemberIndex
  });
  return input.slot.identityCompatibility === undefined
    && input.slot.candidateId === expected.candidateId
    && input.slot.encounterId === expected.encounterId
    && input.slot.packId === expected.packId
    && input.slot.packMemberIndex === expected.memberIndex
    && input.slot.slotId === expected.slotId
    && input.slot.entityId === expected.entityId;
}

type OccupiedPlacement = Readonly<{
  spacingClass: PopulationV2SpacingClass;
  anchor: Readonly<{ lat: number; lon: number }>;
  bodies: readonly Readonly<{ lat: number; lon: number }>[];
}>;

function occupiedPlacements(
  slots: readonly PopulationV2RegisteredMobOccupiedSlot[],
  registry: PopulationV2MobRegistry<PopulationV2MobDefinition>
): OccupiedPlacement[] {
  const groups = new Map<
    string,
    PopulationV2RegisteredMobOccupiedSlot[]
  >();
  for (const slot of slots) {
    const key = `${slot.entityKind}\0${slot.candidateId}`;
    const group = groups.get(key) ?? [];
    group.push(slot);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const spacingClass = first.spacingClass
      ?? resourceSpacingClass(first.entityKind)
      ?? registry.definitionForKind(first.entityKind)?.spacingClass;
    if (spacingClass === undefined) {
      throw new Error(
        `occupied Population V2 kind ${first.entityKind} has no spacing class`
      );
    }
    return {
      spacingClass,
      anchor: first.anchor,
      bodies: group.map((slot) => slot.position)
    };
  });
}

function resourceSpacingClass(
  entityKind: string
): PopulationV2SpacingClass | undefined {
  if (entityKind === "tree" || entityKind === "flax") return "scenery_tree";
  if (entityKind === "stone") return "permanent_stone";
  return undefined;
}

function shortfallBodies(input: Readonly<{
  definition: PopulationV2MobDefinition;
  generationId: string;
  rejectedBodyCounts: readonly number[];
  shortfallGroupCount: number;
}>): number {
  let total = 0;
  for (let index = 0; index < input.shortfallGroupCount; index += 1) {
    const rejected = input.rejectedBodyCounts[index];
    if (rejected !== undefined) {
      total += rejected;
      continue;
    }
    total += input.definition.spawnModel === "single"
      ? 1
      : input.definition.packFormation!.memberCountForCandidate([
        input.generationId,
        input.definition.mobKind,
        input.definition.placementRevision,
        "unplaced",
        index
      ].join("/"));
  }
  return total;
}

function sumCounts(
  counts: readonly PopulationV2RegisteredMobOverlayCounts[]
): PopulationV2RegisteredMobOverlayCounts {
  return counts.reduce((sum, entry) => ({
    groups: sum.groups + entry.groups,
    bodies: sum.bodies + entry.bodies
  }), { groups: 0, bodies: 0 });
}

function nullableNumberOrder(
  left: number | null,
  right: number | null
): number {
  return (left ?? -1) - (right ?? -1);
}
