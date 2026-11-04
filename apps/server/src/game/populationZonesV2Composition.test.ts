import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createPopulationZonesV2Composition,
  populationV2WorldPipelineSha,
  REQUIRED_POPULATION_V2_WORLD_PIPELINE_SHA
} from "./populationZonesV2Composition.js";
import type { WorldEnvironmentDataIdentity } from "./gameplayEnvironmentProfiles.js";

const WORLD_IDENTITY: WorldEnvironmentDataIdentity = {
  releaseId: "world-packages-v1",
  profileSetFingerprint:
    "36dc3eb8bd36e32f7dc92084f1520d3180e6ce1a6c4f06354f7c1b34d6014553",
  buildContractFingerprint:
    "db08e6eb96caa4755f58780f952588efc90c3e644f867d77c87b2955b51d38bd",
  boundaryReleaseId: "world-boundaries-v1"
};

describe("Population v2 service composition", () => {
  it("pins planner provenance to the approved checked-in World pipeline lock", () => {
    expect(populationV2WorldPipelineSha(WORLD_IDENTITY))
      .toBe(REQUIRED_POPULATION_V2_WORLD_PIPELINE_SHA);
  });

  it("rejects a release identity that differs from the checked-in lock", () => {
    expect(() => populationV2WorldPipelineSha({
      ...WORLD_IDENTITY,
      releaseId: "another-world-release"
    })).toThrow("release identity differ");
  });

  it("fails closed without an exact game SHA", () => {
    expect(() => createPopulationZonesV2Composition({
      pool: {} as pg.Pool,
      config: {
        REGION_CODE: "GLOBAL"
      },
      worldIdentity: WORLD_IDENTITY,
      worldLookup: {
        lookupGameplayEnvironments: vi.fn()
      },
      combat: {
        entity: vi.fn(() => null),
        spawnMob: vi.fn(),
        despawnMob: vi.fn(),
        despawnPopulationManagedMob: vi.fn(),
        rebindPopulationAuthority: vi.fn()
      },
      logger: { warn: vi.fn() }
    })).toThrow("production composition requires an exact game RUNTIME_SHA");
  });
});
