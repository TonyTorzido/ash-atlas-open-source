import worldRuntimeLock from "../../../../config/world-runtime.lock.json" with { type: "json" };

declare const gameReleaseShaBrand: unique symbol;
declare const worldPipelineShaBrand: unique symbol;
declare const worldEnvironmentIdentityKeyBrand: unique symbol;
declare const populationPlanIdBrand: unique symbol;
declare const populationZoneIdBrand: unique symbol;
declare const settlementReleaseIdBrand: unique symbol;
declare const settlementReleaseFingerprintBrand: unique symbol;
declare const settlementFoundingPolicyIdBrand: unique symbol;
declare const settlementFoundingPolicyFingerprintBrand: unique symbol;
declare const settlementResolutionPolicyIdBrand: unique symbol;
declare const settlementResolutionPolicyFingerprintBrand: unique symbol;

export type GameReleaseSha = string & { readonly [gameReleaseShaBrand]: true };
export type WorldPipelineSha = string & { readonly [worldPipelineShaBrand]: true };
export type WorldEnvironmentIdentityKey = string & {
  readonly [worldEnvironmentIdentityKeyBrand]: true;
};
export type PopulationPlanId = string & { readonly [populationPlanIdBrand]: true };
export type PopulationZoneId = string & { readonly [populationZoneIdBrand]: true };
export type SettlementReleaseId = string & { readonly [settlementReleaseIdBrand]: true };
export type SettlementReleaseFingerprint = string & {
  readonly [settlementReleaseFingerprintBrand]: true;
};
export type SettlementFoundingPolicyId = string & {
  readonly [settlementFoundingPolicyIdBrand]: true;
};
export type SettlementFoundingPolicyFingerprint = string & {
  readonly [settlementFoundingPolicyFingerprintBrand]: true;
};
export type SettlementResolutionPolicyId = string & {
  readonly [settlementResolutionPolicyIdBrand]: true;
};
export type SettlementResolutionPolicyFingerprint = string & {
  readonly [settlementResolutionPolicyFingerprintBrand]: true;
};

export const REQUIRED_WORLD_PIPELINE_SHA =
  "d2efd6b4966e25646f41f988ece6b6ef1c882bc5";

export const REQUIRED_RIVERBANK_LAKESHORE_PIPELINE_SHA =
  "4d3448ae3f719e678d864e04679008294f72df8c";

const APPROVED_SETTLEMENT_AUTHORITY = Object.freeze({
  releaseId: "world-settlements-v2",
  releaseFingerprint: "462688b612b6929be93955f3e2976d19bd22d703fea24db1c5f4fa74e663ee26",
  foundingPolicyId: "settlement-founding-v2",
  foundingPolicyFingerprint: "cbc6f31242142c2a04059ca39a29a8a4f84b752edd84dfd516830c11458255b1",
  resolutionPolicyId: "primary-settlement-resolution-v1",
  resolutionPolicyFingerprint: "6e422725266126827aab6c10cdd52ca0391c2aeb05243b076b9156ffadc6d371"
});

export const WORLD_RUNTIME_CONTRACT = readWorldRuntimeContract();

export function gameReleaseSha(value: string): GameReleaseSha {
  return sha1(value, "game release SHA") as GameReleaseSha;
}

export function worldEnvironmentIdentityKeyValue(
  value: string
): WorldEnvironmentIdentityKey {
  return sha256(value, "World environment identity key") as WorldEnvironmentIdentityKey;
}

export function populationPlanId(value: string): PopulationPlanId {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)) {
    throw new Error("Population plan ID must be a lowercase UUIDv8");
  }
  return value as PopulationPlanId;
}

export function populationZoneId(value: string): PopulationZoneId {
  if (!/^ppz2-eag1\/[a-z0-9]+\/[a-z0-9]+$/u.test(value)) {
    throw new Error("Population zone ID is invalid");
  }
  return value as PopulationZoneId;
}

export function assertWorldReleaseIdentity(required: Readonly<{
  releaseId: string;
  profileSetFingerprint: string;
  buildContractFingerprint: string;
  boundaryReleaseId: string;
}>): WorldPipelineSha {
  const actual = WORLD_RUNTIME_CONTRACT.worldRelease;
  if (
    actual.releaseId !== required.releaseId
    || actual.profileSetFingerprint !== required.profileSetFingerprint
    || actual.buildContractFingerprint !== required.buildContractFingerprint
    || actual.boundaryReleaseId !== required.boundaryReleaseId
  ) {
    throw new Error("World pipeline lock and required release identity differ");
  }
  return WORLD_RUNTIME_CONTRACT.worldPipelineSha;
}

export function canonicalWorldSurfaceCellSizeM(surfaceIdentity: Readonly<{
  riverCellSizeM: unknown;
  lakeCellSizeM: unknown;
  oceanCoastCellSizeM: unknown;
}>): number {
  const { riverCellSizeM, lakeCellSizeM, oceanCoastCellSizeM } = surfaceIdentity;
  if (
    !isPositiveInteger(riverCellSizeM)
    || !isPositiveInteger(lakeCellSizeM)
    || !isPositiveInteger(oceanCoastCellSizeM)
  ) {
    throw new Error("World surface cell geometry is missing or invalid");
  }
  if (riverCellSizeM !== lakeCellSizeM || riverCellSizeM !== oceanCoastCellSizeM) {
    throw new Error("World surface cell geometries do not share one canonical grid");
  }
  return riverCellSizeM;
}

function readWorldRuntimeContract() {
  if (worldRuntimeLock.schema_version !== 1) {
    throw new Error("World runtime lock schema is unsupported");
  }
  if (worldRuntimeLock.pipeline.sha !== REQUIRED_WORLD_PIPELINE_SHA) {
    throw new Error("World pipeline lock does not match its approved exact SHA");
  }
  const settlement = worldRuntimeLock.settlement_authority;
  const actualSettlement = {
    releaseId: settlement.release_id,
    releaseFingerprint: settlement.release_fingerprint,
    foundingPolicyId: settlement.founding_policy_id,
    foundingPolicyFingerprint: settlement.founding_policy_fingerprint,
    resolutionPolicyId: settlement.resolution_policy_id,
    resolutionPolicyFingerprint: settlement.resolution_policy_fingerprint
  };
  if (JSON.stringify(actualSettlement) !== JSON.stringify(APPROVED_SETTLEMENT_AUTHORITY)) {
    throw new Error("Settlement Authority lock does not match the approved t086 identity");
  }
  const surfaceCellSizeM = canonicalWorldSurfaceCellSizeM({
    riverCellSizeM: worldRuntimeLock.river_surface.cell_size_m,
    lakeCellSizeM: worldRuntimeLock.lake_surface.cell_size_m,
    oceanCoastCellSizeM: worldRuntimeLock.ocean_coast_surface.cell_size_m
  });
  const riverbankLakeshore = worldRuntimeLock.riverbank_lakeshore;
  if (
    riverbankLakeshore.release_id !== "riverbank-lakeshore-v1"
    || riverbankLakeshore.manifest_sha256 !== "c3a2823f759271abb77bf23220e33cb1146d9a3ecb2615f79d3e173189a2344f"
    || riverbankLakeshore.schema !== "riverbank-lakeshore-row-spans-v1"
    || riverbankLakeshore.policy !== "canonical-water-surface-land-within-500m-v1"
    || riverbankLakeshore.pipeline_sha !== REQUIRED_RIVERBANK_LAKESHORE_PIPELINE_SHA
    || riverbankLakeshore.contract_fingerprint !== "32572021050b078ba856469a705631902e8036c8bf4512334d056732b35000ce"
    || riverbankLakeshore.distance_m !== 500
    || riverbankLakeshore.cell_size_m !== surfaceCellSizeM
    || riverbankLakeshore.grid_fingerprint !== "44e1b2d53f5b3d38b6f5370d30c94403d6d4f90a6207f12ccdee799713a6229b"
    || riverbankLakeshore.inventory_sha256 !== "2f6048b8cee3c73031ec0e58b01f870e6318d7d8cdc902aae7cf5289b9aa74a0"
    || riverbankLakeshore.selected_package_count !== 20542
    || riverbankLakeshore.positive_package_count !== 14627
    || riverbankLakeshore.empty_package_count !== 5915
    || riverbankLakeshore.source_package_count !== 14598
    || riverbankLakeshore.span_count !== 59122237
    || riverbankLakeshore.membership_cell_count !== 391536663
    || riverbankLakeshore.source_package_fingerprint !== "f92da45fcd830d2191cd015db54193b72ff0307f5ce3125e4406de0681792680"
    || riverbankLakeshore.selected_package_fingerprint !== "aab9bbdf505dda7fe1037fcb31d36e8260422307cc88edb66ed184e40f4c968e"
    || riverbankLakeshore.deterministic_fingerprint !== "63b63551b99514f4db818ce324005f0476663133651f6b9bba040154180422e6"
  ) {
    throw new Error("Riverbank/lakeshore release lock does not match the approved v1 identity");
  }
  return Object.freeze({
    worldPipelineSha: sha1(worldRuntimeLock.pipeline.sha, "World pipeline SHA") as WorldPipelineSha,
    surfaceCellSizeM,
    worldRelease: Object.freeze({
      releaseId: worldRuntimeLock.release.release_id,
      profileSetFingerprint: sha256(
        worldRuntimeLock.release.profile_set_fingerprint,
        "World profile-set fingerprint"
      ),
      buildContractFingerprint: sha256(
        worldRuntimeLock.release.build_contract_fingerprint,
        "World build-contract fingerprint"
      ),
      boundaryReleaseId: worldRuntimeLock.release.boundary_release_id
    }),
    riverSurface: Object.freeze({
      releaseId: worldRuntimeLock.river_surface.release_id,
      manifestSha256: sha256(
        worldRuntimeLock.river_surface.manifest_sha256,
        "river surface manifest SHA-256"
      ),
      policy: worldRuntimeLock.river_surface.policy,
      cellSizeM: worldRuntimeLock.river_surface.cell_size_m
    }),
    lakeSurface: Object.freeze({
      releaseId: worldRuntimeLock.lake_surface.release_id,
      manifestSha256: sha256(
        worldRuntimeLock.lake_surface.manifest_sha256,
        "lake surface manifest SHA-256"
      ),
      policy: worldRuntimeLock.lake_surface.policy,
      cellSizeM: worldRuntimeLock.lake_surface.cell_size_m
    }),
    oceanCoastSurface: Object.freeze({
      releaseId: worldRuntimeLock.ocean_coast_surface.release_id,
      manifestSha256: sha256(
        worldRuntimeLock.ocean_coast_surface.manifest_sha256,
        "ocean coast surface manifest SHA-256"
      ),
      policy: worldRuntimeLock.ocean_coast_surface.policy,
      cellSizeM: worldRuntimeLock.ocean_coast_surface.cell_size_m,
      bandCells: worldRuntimeLock.ocean_coast_surface.band_cells,
      precedencePolicy: worldRuntimeLock.ocean_coast_surface.precedence_policy
    }),
    riverbankLakeshore: Object.freeze({
      releaseId: riverbankLakeshore.release_id,
      manifestSha256: sha256(
        riverbankLakeshore.manifest_sha256,
        "riverbank/lakeshore manifest SHA-256"
      ),
      schema: riverbankLakeshore.schema,
      policy: riverbankLakeshore.policy,
      pipelineSha: sha1(riverbankLakeshore.pipeline_sha, "riverbank/lakeshore pipeline SHA") as WorldPipelineSha,
      contractFingerprint: sha256(
        riverbankLakeshore.contract_fingerprint,
        "riverbank/lakeshore contract fingerprint"
      ),
      distanceM: riverbankLakeshore.distance_m,
      cellSizeM: riverbankLakeshore.cell_size_m,
      gridFingerprint: sha256(
        riverbankLakeshore.grid_fingerprint,
        "riverbank/lakeshore grid fingerprint"
      ),
      inventorySha256: sha256(
        riverbankLakeshore.inventory_sha256,
        "riverbank/lakeshore inventory SHA-256"
      ),
      selectedPackageCount: riverbankLakeshore.selected_package_count,
      positivePackageCount: riverbankLakeshore.positive_package_count,
      emptyPackageCount: riverbankLakeshore.empty_package_count,
      sourcePackageCount: riverbankLakeshore.source_package_count,
      spanCount: riverbankLakeshore.span_count,
      membershipCellCount: riverbankLakeshore.membership_cell_count,
      sourcePackageFingerprint: sha256(
        riverbankLakeshore.source_package_fingerprint,
        "riverbank/lakeshore source package fingerprint"
      ),
      selectedPackageFingerprint: sha256(
        riverbankLakeshore.selected_package_fingerprint,
        "riverbank/lakeshore selected package fingerprint"
      ),
      deterministicFingerprint: sha256(
        riverbankLakeshore.deterministic_fingerprint,
        "riverbank/lakeshore deterministic fingerprint"
      )
    }),
    waterbodyIdentity: Object.freeze({
      releaseId: worldRuntimeLock.waterbody_identity_overlay.release_id,
      manifestSha256: sha256(
        worldRuntimeLock.waterbody_identity_overlay.manifest_sha256,
        "waterbody identity overlay manifest SHA-256"
      ),
      schema: worldRuntimeLock.waterbody_identity_overlay.schema,
      schemaVersion: worldRuntimeLock.waterbody_identity_overlay.schema_version,
      policy: worldRuntimeLock.waterbody_identity_overlay.policy,
      policyVersion: worldRuntimeLock.waterbody_identity_overlay.policy_version
    }),
    settlementAuthority: Object.freeze({
      releaseId: settlement.release_id as SettlementReleaseId,
      releaseFingerprint: sha256(
        settlement.release_fingerprint,
        "settlement release fingerprint"
      ) as SettlementReleaseFingerprint,
      foundingPolicyId: settlement.founding_policy_id as SettlementFoundingPolicyId,
      foundingPolicyFingerprint: sha256(
        settlement.founding_policy_fingerprint,
        "settlement founding-policy fingerprint"
      ) as SettlementFoundingPolicyFingerprint,
      resolutionPolicyId: settlement.resolution_policy_id as SettlementResolutionPolicyId,
      resolutionPolicyFingerprint: sha256(
        settlement.resolution_policy_fingerprint,
        "settlement resolution-policy fingerprint"
      ) as SettlementResolutionPolicyFingerprint
    })
  });
}

function sha1(value: string, label: string): string {
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character SHA`);
  }
  return value;
}

function sha256(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 fingerprint`);
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
