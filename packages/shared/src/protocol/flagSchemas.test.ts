import { describe, expect, it } from "vitest";

import {
  commitVisibleFlagVisitMessageSchema,
  craftTorchesMessageSchema,
  prepareVisibleFlagVisitMessageSchema,
  reinforceFlagMessageSchema,
  startFlagBurnMessageSchema
} from "./flagSchemas.js";

const authority = {
  expectedConnectionGeneration: 3,
  expectedGameplayViewGeneration: 5,
  expectedResourceVisionRevision: 7,
  expectedFlagSetRevision: 11,
  expectedDestination: {
    lat: 39.7392,
    lon: -104.9903,
    claimRadiusM: 700,
    resourceVisionRadiusM: 1_000,
    personalFlagId: "00000000-0000-4000-8000-000000000010"
  }
};

describe("visible flag destination authority schemas", () => {
  it("accepts destination-scoped authority for preparation and commit", () => {
    expect(prepareVisibleFlagVisitMessageSchema.parse({
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId: "prepare-1",
      flagId: authority.expectedDestination.personalFlagId,
      ...authority
    }).expectedDestination).toEqual(authority.expectedDestination);

    expect(commitVisibleFlagVisitMessageSchema.parse({
      type: "COMMIT_VISIBLE_FLAG_VISIT",
      requestId: "commit-1",
      preparationId: "prepare-1",
      flagId: authority.expectedDestination.personalFlagId,
      ...authority
    }).expectedDestination).toEqual(authority.expectedDestination);
  });

  it("rejects out-of-range destination coordinates", () => {
    expect(() => prepareVisibleFlagVisitMessageSchema.parse({
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId: "prepare-invalid",
      flagId: authority.expectedDestination.personalFlagId,
      ...authority,
      expectedDestination: {
        ...authority.expectedDestination,
        lat: 91
      }
    })).toThrow();
  });
});

describe("flag reinforcement commands", () => {
  it("defaults legacy commands to stone and accepts tower", () => {
    const base = {
      type: "REINFORCE_FLAG" as const,
      requestId: "upgrade-1",
      flagId: "00000000-0000-4000-8000-000000000010"
    };
    expect(reinforceFlagMessageSchema.parse(base).targetTier).toBe("stone");
    expect(reinforceFlagMessageSchema.parse({ ...base, targetTier: "tower" }).targetTier)
      .toBe("tower");
  });
});

describe("Flag burn commands", () => {
  it("requires a request ID and target Flag for starts, and a request ID for crafting", () => {
    expect(startFlagBurnMessageSchema.parse({
      type: "START_FLAG_BURN",
      requestId: "burn-1",
      flagId: "00000000-0000-4000-8000-000000000010"
    })).toMatchObject({ type: "START_FLAG_BURN", requestId: "burn-1" });
    expect(craftTorchesMessageSchema.parse({
      type: "CRAFT_TORCH",
      requestId: "craft-1"
    })).toEqual({ type: "CRAFT_TORCH", requestId: "craft-1" });
  });
});
