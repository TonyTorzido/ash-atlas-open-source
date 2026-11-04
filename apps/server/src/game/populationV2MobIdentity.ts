import {
  deterministicUuidV8,
  hashPartsHex,
  stablePlanScopedUuid,
  type PopulationZoneV2PlanIdentity
} from "./populationZonesV2Identity.js";

const LEGACY_ENTITY_ID_VERSION = "population-entity-id-v2";
const LEGACY_SLOT_ID_VERSION = "population-slot-id-v2";
const LEGACY_ENCOUNTER_ID_VERSION = "population-encounter-id-v2";
const LEGACY_PACK_ID_VERSION = "population-pack-id-v2";
const LEGACY_SAP_GENERATION_CANDIDATE_VERSION =
  "population-generation-sap-crawler-template-candidate-v1";
const LEGACY_SAP_GENERATION_SLOT_VERSION =
  "population-generation-sap-crawler-template-slot-v1";
const LEGACY_SAP_GENERATION_ENTITY_VERSION =
  "population-generation-sap-crawler-template-entity-v1";
const LEGACY_SAP_GENERATION_ENCOUNTER_VERSION =
  "population-generation-sap-crawler-template-encounter-v1";
const LEGACY_SAP_GENERATION_PACK_VERSION =
  "population-generation-sap-crawler-template-pack-v1";

export type PopulationV2MobSpawnModel = "single" | "pack";

export type RegisteredPopulationV2MobIdentity = Readonly<{
  candidateId: string;
  encounterId: string;
  packId: string | null;
  slotId: string;
  entityId: string;
  memberIndex: number | null;
}>;

export function registeredPopulationV2MobIdentity(input: Readonly<{
  generationId: string;
  mobKind: string;
  placementRevision: string;
  deterministicCandidateId: string;
  spawnModel: PopulationV2MobSpawnModel;
  memberIndex?: number | null;
}>): RegisteredPopulationV2MobIdentity {
  assertRegisteredIdentityInput(input);
  const memberIndex = input.spawnModel === "pack"
    ? input.memberIndex!
    : null;
  const authority = {
    deterministicCandidateId: input.deterministicCandidateId,
    generationId: input.generationId,
    mobKind: input.mobKind,
    placementRevision: input.placementRevision
  };
  const candidateId = deterministicUuidV8(
    "population-v2-registered-mob-candidate-v1",
    authority
  );
  const encounterId = deterministicUuidV8(
    "population-v2-registered-mob-encounter-v1",
    { ...authority, candidateId }
  );
  const packId = input.spawnModel === "pack"
    ? deterministicUuidV8(
        "population-v2-registered-mob-pack-v1",
        { ...authority, candidateId }
      )
    : null;
  const slotId = deterministicUuidV8(
    "population-v2-registered-mob-slot-v1",
    { ...authority, candidateId, memberIndex }
  );
  return {
    candidateId,
    encounterId,
    packId,
    slotId,
    entityId: deterministicUuidV8(
      "population-v2-registered-mob-entity-v1",
      { ...authority, candidateId, memberIndex, slotId }
    ),
    memberIndex
  };
}

export type LegacyPopulationV2MobPlanKind =
  | "deer"
  | "wolf_pack"
  | "ogre"
  | "sap_crawler_group";

export type LegacyPopulationV2MobEntityKind =
  | "deer"
  | "wolf"
  | "ogre"
  | "sap_crawler";

export type LegacyPopulationV2MobCandidateIdentity = Readonly<{
  candidateId: string;
  encounterId: string;
  packId: string | null;
  members: readonly Readonly<{
    memberIndex: number | null;
    slotId: string;
    entityId: string;
  }>[];
}>;

export type LegacyPopulationV2MobIdentityAdapter = Readonly<{
  mode: "legacy-plan-scoped";
  planKind: LegacyPopulationV2MobPlanKind;
  entityKind: LegacyPopulationV2MobEntityKind;
  spawnModel: PopulationV2MobSpawnModel;
  candidate(input: Readonly<{
    planIdentity: PopulationZoneV2PlanIdentity;
    candidateId: string;
    sourceOwnerId: string;
    memberCount?: number;
  }>): LegacyPopulationV2MobCandidateIdentity;
  materializeGeneration?: (
    input: Readonly<{
      templateCandidateId: string;
      generationId: string;
      generationNumber: number;
      memberIndex: number;
    }>
  ) => RegisteredPopulationV2MobIdentity;
}>;

export function createLegacyPopulationV2MobIdentityAdapter(input: Readonly<{
  planKind: LegacyPopulationV2MobPlanKind;
  entityKind: LegacyPopulationV2MobEntityKind;
  spawnModel: PopulationV2MobSpawnModel;
  sapGenerationMaterialization?: boolean;
}>): LegacyPopulationV2MobIdentityAdapter {
  if (
    input.sapGenerationMaterialization === true
    && (
      input.planKind !== "sap_crawler_group"
      || input.entityKind !== "sap_crawler"
      || input.spawnModel !== "pack"
    )
  ) {
    throw new Error(
      "legacy Resin Crawler generation materialization requires the Resin Crawler pack identity"
    );
  }
  return {
    mode: "legacy-plan-scoped",
    planKind: input.planKind,
    entityKind: input.entityKind,
    spawnModel: input.spawnModel,
    candidate: (candidateInput) => legacyPopulationV2MobCandidateIdentity({
      ...candidateInput,
      planKind: input.planKind,
      entityKind: input.entityKind,
      spawnModel: input.spawnModel
    }),
    ...(input.sapGenerationMaterialization === true
      ? { materializeGeneration: legacySapCrawlerGenerationIdentity }
      : {})
  };
}

export function legacyPopulationV2MobCandidateIdentity(input: Readonly<{
  planIdentity: PopulationZoneV2PlanIdentity;
  planKind: LegacyPopulationV2MobPlanKind;
  entityKind: LegacyPopulationV2MobEntityKind;
  spawnModel: PopulationV2MobSpawnModel;
  candidateId: string;
  sourceOwnerId: string;
  memberCount?: number;
}>): LegacyPopulationV2MobCandidateIdentity {
  if (input.candidateId.length === 0 || input.sourceOwnerId.length === 0) {
    throw new Error("legacy population mob candidate authority is required");
  }
  const memberCount = input.spawnModel === "pack"
    ? input.memberCount
    : 1;
  if (
    !Number.isSafeInteger(memberCount)
    || memberCount === undefined
    || memberCount <= 0
  ) {
    throw new Error("legacy population mob member count must be positive");
  }
  if (input.spawnModel === "single" && input.memberCount !== undefined
    && input.memberCount !== 1) {
    throw new Error("legacy single-mob identity must contain one member");
  }
  const authority = {
    candidateId: input.candidateId,
    sourceOwnerId: input.sourceOwnerId
  };
  const encounterId = stablePlanScopedUuid(
    LEGACY_ENCOUNTER_ID_VERSION,
    input.planIdentity,
    { ...authority, encounterKind: input.planKind }
  );
  const packId = input.spawnModel === "pack"
    ? stablePlanScopedUuid(
        LEGACY_PACK_ID_VERSION,
        input.planIdentity,
        authority
      )
    : null;
  return {
    candidateId: input.candidateId,
    encounterId,
    packId,
    members: Array.from({ length: memberCount }, (_, index) => {
      const memberIndex = input.spawnModel === "pack" ? index : null;
      const slotId = stablePlanScopedUuid(
        LEGACY_SLOT_ID_VERSION,
        input.planIdentity,
        {
          ...authority,
          kind: input.entityKind,
          memberIndex
        }
      );
      return {
        memberIndex,
        slotId,
        entityId: stablePlanScopedUuid(
          LEGACY_ENTITY_ID_VERSION,
          input.planIdentity,
          {
            kind: input.entityKind,
            slotId,
            sourceOwnerId: input.sourceOwnerId
          }
        )
      };
    })
  };
}

export function legacySapCrawlerGenerationIdentity(input: Readonly<{
  templateCandidateId: string;
  generationId: string;
  generationNumber: number;
  memberIndex: number;
}>): RegisteredPopulationV2MobIdentity {
  if (input.templateCandidateId.length === 0 || input.generationId.length === 0) {
    throw new Error("legacy Resin Crawler generation candidate authority is required");
  }
  if (
    !Number.isSafeInteger(input.generationNumber)
    || input.generationNumber <= 0
    || !Number.isSafeInteger(input.memberIndex)
    || input.memberIndex < 0
  ) {
    throw new Error("legacy Resin Crawler generation identity revisions are invalid");
  }
  const candidateId = `${input.templateCandidateId}/${hashPartsHex(
    LEGACY_SAP_GENERATION_CANDIDATE_VERSION,
    input.generationId,
    input.generationNumber,
    input.templateCandidateId
  ).slice(0, 16)}`;
  const authority = {
    generationCandidateId: candidateId,
    generationId: input.generationId,
    generationNumber: input.generationNumber,
    templateCandidateId: input.templateCandidateId
  };
  const encounterId = deterministicUuidV8(
    LEGACY_SAP_GENERATION_ENCOUNTER_VERSION,
    authority
  );
  const packId = deterministicUuidV8(
    LEGACY_SAP_GENERATION_PACK_VERSION,
    authority
  );
  const slotId = deterministicUuidV8(
    LEGACY_SAP_GENERATION_SLOT_VERSION,
    { ...authority, memberIndex: input.memberIndex }
  );
  return {
    candidateId,
    encounterId,
    packId,
    slotId,
    entityId: deterministicUuidV8(
      LEGACY_SAP_GENERATION_ENTITY_VERSION,
      { ...authority, memberIndex: input.memberIndex, slotId }
    ),
    memberIndex: input.memberIndex
  };
}

function assertRegisteredIdentityInput(input: Readonly<{
  generationId: string;
  mobKind: string;
  placementRevision: string;
  deterministicCandidateId: string;
  spawnModel: PopulationV2MobSpawnModel;
  memberIndex?: number | null;
}>): void {
  if (
    input.generationId.length === 0
    || !/^[a-z][a-z0-9_]*$/u.test(input.mobKind)
    || input.placementRevision.trim().length === 0
    || input.deterministicCandidateId.length === 0
  ) {
    throw new Error("registered population mob identity authority is invalid");
  }
  if (
    input.spawnModel === "pack"
    && (
      !Number.isSafeInteger(input.memberIndex)
      || input.memberIndex === null
      || input.memberIndex === undefined
      || input.memberIndex < 0
    )
  ) {
    throw new Error(
      "registered pack-mob identity requires a nonnegative member index"
    );
  }
  if (
    input.spawnModel === "single"
    && input.memberIndex !== undefined
    && input.memberIndex !== null
  ) {
    throw new Error("registered single-mob identity cannot have a member index");
  }
}
