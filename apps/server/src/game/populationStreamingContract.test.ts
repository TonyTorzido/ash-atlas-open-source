import {
  DEFAULT_FLAG_PREPARE_RADIUS_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  assertPopulationAreaPreparationRequest,
  maximumPopulationStage,
  populationStageAtLeast,
  populationStageRank,
  type PopulationAreaPreparationRequest
} from "./populationStreamingContract.js";

describe("population streaming contract", () => {
  it("orders preparation stages monotonically", () => {
    expect(populationStageRank("PLAN_READY")).toBeLessThan(
      populationStageRank("DURABLE_READY")
    );
    expect(populationStageAtLeast("SIMULATION_READY", "DURABLE_READY")).toBe(
      true
    );
    expect(populationStageAtLeast("DURABLE_READY", "SIMULATION_READY")).toBe(
      false
    );
    expect(maximumPopulationStage("PLAN_READY", "PUBLISHED")).toBe(
      "PUBLISHED"
    );
  });

  it("requires complete publication authority", () => {
    const request = preparationRequest();
    expect(() => assertPopulationAreaPreparationRequest(request)).not.toThrow();
    const sourceWithoutConnection = { ...request.source };
    Reflect.deleteProperty(sourceWithoutConnection, "connectionId");
    expect(() => assertPopulationAreaPreparationRequest({
      ...request,
      source: sourceWithoutConnection
    })).toThrow("published population source requires");
  });

  it("rejects invalid expiration and priority without changing area geometry", () => {
    const request = preparationRequest();
    expect(() => assertPopulationAreaPreparationRequest({
      ...request,
      source: {
        ...request.source,
        targetStage: "DURABLE_READY",
        priority: 4 as never
      }
    })).toThrow("invalid population streaming source");
    expect(() => assertPopulationAreaPreparationRequest({
      ...request,
      source: {
        ...request.source,
        expiresAtMs: request.source.createdAtMs
      }
    })).toThrow("invalid population streaming source expiration");
  });
});

function preparationRequest(): PopulationAreaPreparationRequest {
  return {
    area: {
      center: { lat: 35, lon: -106 },
      certifiedVisibleRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
      preparedRadiusM: DEFAULT_FLAG_PREPARE_RADIUS_M,
      sourceType: "flag",
      sourceId: "flag-1",
      generation: 3
    },
    source: {
      sourceId: "player-visible:player-1:connection-1:3",
      kind: "player-visible",
      targetStage: "PUBLISHED",
      priority: 0,
      createdAtMs: 1_000,
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 3,
      authorityToken: "relocation:5:vision:7:view:3"
    }
  };
}
