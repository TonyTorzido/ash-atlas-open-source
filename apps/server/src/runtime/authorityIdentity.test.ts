import { describe, expect, expectTypeOf, it } from "vitest";

import {
  canonicalWorldSurfaceCellSizeM,
  REQUIRED_RIVERBANK_LAKESHORE_PIPELINE_SHA,
  REQUIRED_WORLD_PIPELINE_SHA,
  WORLD_RUNTIME_CONTRACT,
  type GameReleaseSha,
  type SettlementFoundingPolicyId,
  type SettlementReleaseId,
  type SettlementResolutionPolicyId,
  type WorldPipelineSha
} from "./authorityIdentity.js";

describe("canonical authority identity", () => {
  it("keeps game and World release SHAs non-interchangeable", () => {
    expectTypeOf<GameReleaseSha>().not.toEqualTypeOf<WorldPipelineSha>();
    expect(WORLD_RUNTIME_CONTRACT.worldPipelineSha).toBe(REQUIRED_WORLD_PIPELINE_SHA);
  });

  it("keeps each Settlement Authority identity type distinct", () => {
    expectTypeOf<SettlementReleaseId>()
      .not.toEqualTypeOf<SettlementFoundingPolicyId>();
    expectTypeOf<SettlementFoundingPolicyId>()
      .not.toEqualTypeOf<SettlementResolutionPolicyId>();
  });

  it("preserves the current World and exact t086 Settlement Authority contract", () => {
    expect(WORLD_RUNTIME_CONTRACT).toEqual({
      worldPipelineSha: "d2efd6b4966e25646f41f988ece6b6ef1c882bc5",
      surfaceCellSizeM: 125,
      worldRelease: {
        releaseId: "world-packages-v1",
        profileSetFingerprint: "36dc3eb8bd36e32f7dc92084f1520d3180e6ce1a6c4f06354f7c1b34d6014553",
        buildContractFingerprint: "db08e6eb96caa4755f58780f952588efc90c3e644f867d77c87b2955b51d38bd",
        boundaryReleaseId: "world-boundaries-v1"
      },
      riverSurface: {
        releaseId: "river-surface-v1",
        manifestSha256: "c605631193ff786e33182fb8b6d7cfa3ab868b35d0a47fec5e1aa717ace447d5",
        policy: "osm-medium-plus-v1",
        cellSizeM: 125
      },
      lakeSurface: {
        releaseId: "lake-surface-v1",
        manifestSha256: "d0c25c2b6a4e9349091a5f483a294fac7988cd098a1f77e354343cb2f27f42b9",
        policy: "hydrolakes-center-membership-v1",
        cellSizeM: 125
      },
      oceanCoastSurface: {
        releaseId: "ocean-coast-surface-v1",
        manifestSha256: "b8319476532112ef6076d56819a89a9551ea88c4b55f52a06c80b8bae8fa3954",
        policy: "three-cell-canonical-ocean-coast-v1",
        cellSizeM: 125,
        bandCells: 3,
        precedencePolicy: "river>lake>ocean>land"
      },
      riverbankLakeshore: {
        releaseId: "riverbank-lakeshore-v1",
        manifestSha256: "c3a2823f759271abb77bf23220e33cb1146d9a3ecb2615f79d3e173189a2344f",
        schema: "riverbank-lakeshore-row-spans-v1",
        policy: "canonical-water-surface-land-within-500m-v1",
        pipelineSha: REQUIRED_RIVERBANK_LAKESHORE_PIPELINE_SHA,
        contractFingerprint: "32572021050b078ba856469a705631902e8036c8bf4512334d056732b35000ce",
        distanceM: 500,
        cellSizeM: 125,
        gridFingerprint: "44e1b2d53f5b3d38b6f5370d30c94403d6d4f90a6207f12ccdee799713a6229b",
        inventorySha256: "2f6048b8cee3c73031ec0e58b01f870e6318d7d8cdc902aae7cf5289b9aa74a0",
        selectedPackageCount: 20542,
        positivePackageCount: 14627,
        emptyPackageCount: 5915,
        sourcePackageCount: 14598,
        spanCount: 59122237,
        membershipCellCount: 391536663,
        sourcePackageFingerprint: "f92da45fcd830d2191cd015db54193b72ff0307f5ce3125e4406de0681792680",
        selectedPackageFingerprint: "aab9bbdf505dda7fe1037fcb31d36e8260422307cc88edb66ed184e40f4c968e",
        deterministicFingerprint: "63b63551b99514f4db818ce324005f0476663133651f6b9bba040154180422e6"
      },
      waterbodyIdentity: {
        releaseId: "waterbody-identity-overlay-v4",
        manifestSha256: "f81deb9fb441ec5644095b1d4ea8f430c652948f5e7a64e9beac5a6ea005020c",
        schema: "waterbody-identity-overlay-v1",
        schemaVersion: "waterbody-identity-overlay-v1",
        policy: "existing-cell-candidate-precedence-v1",
        policyVersion: "existing-cell-candidate-precedence-v1"
      },
      settlementAuthority: {
        releaseId: "world-settlements-v2",
        releaseFingerprint: "462688b612b6929be93955f3e2976d19bd22d703fea24db1c5f4fa74e663ee26",
        foundingPolicyId: "settlement-founding-v2",
        foundingPolicyFingerprint: "cbc6f31242142c2a04059ca39a29a8a4f84b752edd84dfd516830c11458255b1",
        resolutionPolicyId: "primary-settlement-resolution-v1",
        resolutionPolicyFingerprint: "6e422725266126827aab6c10cdd52ca0391c2aeb05243b076b9156ffadc6d371"
      }
    });
  });

  it("derives one canonical cell size from all approved World surface identities", () => {
    expect(canonicalWorldSurfaceCellSizeM({
      riverCellSizeM: 125,
      lakeCellSizeM: 125,
      oceanCoastCellSizeM: 125
    })).toBe(125);
  });

  it.each([
    {
      riverCellSizeM: 125,
      lakeCellSizeM: 250,
      oceanCoastCellSizeM: 125
    },
    {
      riverCellSizeM: undefined,
      lakeCellSizeM: 125,
      oceanCoastCellSizeM: 125
    },
    {
      riverCellSizeM: 0,
      lakeCellSizeM: 0,
      oceanCoastCellSizeM: 0
    }
  ])("fails closed for unavailable, invalid, or mismatched surface geometry", (identity) => {
    expect(() => canonicalWorldSurfaceCellSizeM(identity)).toThrow(/World surface cell/u);
  });
});
