import { describe, expect, it } from "vitest";

import { GREENHOUSE_STAGE_ART_IDS, plantGreenhouseMessageSchema } from "@ash-atlas/shared";

import {
  GREENHOUSE_CROP_CATALOG,
  enabledGreenhouseCropDefinition,
  greenhouseCropCatalogForPack,
  greenhouseCropSupportsInventoryIdentity
} from "./greenhouseCrops.js";
import type { GreenhouseCropDefinition } from "./greenhouseCrops.js";
import { greenhouseCropCatalogForClientPack } from "./greenhouseCropContent.js";

describe("server-owned greenhouse crop catalog", () => {
  it("keeps wheat on its existing inventory IDs and uses the authored four-stage art IDs", () => {
    expect(Object.keys(GREENHOUSE_CROP_CATALOG)).toEqual(["wheat", "giving_berry_tree"]);
    expect(enabledGreenhouseCropDefinition("wheat")).toMatchObject({
      cropId: "wheat",
      enabled: true,
      seed: { itemId: "wheat_seed", variant: null, quantity: 1 },
      maxStage: 4,
      clippingYieldByStage: { 3: 3 },
      harvest: { itemId: "wheat", variant: null, quantity: 5 }
    });
    expect(enabledGreenhouseCropDefinition("carrot")).toBeNull();
    expect(enabledGreenhouseCropDefinition("giving_berry_tree")).toMatchObject({
      stageArtIds: { 3: "giving_berry_tree_fruiting", 4: "giving_berry_tree_mature" },
      clippingYieldByStage: { 3: 3 }
    });
  });

  it("accepts generic item variants only when the crop data assigns those identities", () => {
    const secondCrop = {
      moonbean: {
        cropId: "moonbean",
        seed: { itemId: "seed" as const, variant: "moonbean", quantity: 1 },
        harvest: { itemId: "produce" as const, variant: "moonbean", quantity: 3 }
      }
    };
    expect(greenhouseCropSupportsInventoryIdentity("seed", "moonbean", secondCrop)).toBe(true);
    expect(greenhouseCropSupportsInventoryIdentity("produce", "moonbean", secondCrop)).toBe(true);
    expect(greenhouseCropSupportsInventoryIdentity("seed", "unknown", secondCrop)).toBe(false);
    expect(greenhouseCropSupportsInventoryIdentity("seed", "moonbean", {
      moonbean: {
        cropId: "moonbean",
        seed: { itemId: "seed", variant: "other_crop", quantity: 1 },
        harvest: { itemId: "produce", variant: "moonbean", quantity: 3 }
      }
    })).toBe(false);
    expect(greenhouseCropSupportsInventoryIdentity("wheat_seed", "wheat", secondCrop)).toBe(false);
  });

  it("resolves a generic second-crop presentation from pack data without a client variant list", () => {
    const moonbean: GreenhouseCropDefinition = {
      cropId: "moonbean",
      enabled: true,
      displayName: "Moonbean",
      seedDisplayName: "Moonbean Seed",
      seed: { itemId: "seed", variant: "moonbean", quantity: 1 },
      starterSeedQuantity: 8,
      maxStage: 4,
      stageDurationMs: { riverbank: 1_000, inland: 2_000 },
      stageArtIds: {
        1: "moonbean_seedling",
        2: "moonbean_middle_2",
        3: "moonbean_middle_3",
        4: "moonbean_full"
      },
      clippingYieldByStage: { 2: 1 },
      harvest: { itemId: "produce", variant: "moonbean", quantity: 3 }
    };
    const presentation = {
      cropId: moonbean.cropId,
      displayName: moonbean.displayName,
      seedDisplayName: moonbean.seedDisplayName,
      seedItemId: "seed" as const,
      seedVariant: "moonbean",
      stages: [1, 2, 3, 4].map((stage) => ({
        stage,
        artId: moonbean.stageArtIds[stage as 1 | 2 | 3 | 4],
        assetId: `moonbean-stage-${stage}`,
        pivotX: 0.5,
        pivotY: 0.5,
        offsetX: 0,
        offsetY: 0,
        scale: 0.68
      }))
    };

    expect(greenhouseCropCatalogForPack([presentation], { moonbean: { ...moonbean, cropId: "moonbean" } }))
      .toMatchObject([{
        cropId: "moonbean",
        seed: { itemId: "seed", variant: "moonbean" },
        plantingAvailable: true,
        stageArtIds: ["moonbean_seedling", "moonbean_middle_2", "moonbean_middle_3", "moonbean_full"]
      }]);
    expect(greenhouseCropCatalogForPack([], { moonbean: { ...moonbean, cropId: "moonbean" } })[0]?.plantingAvailable)
      .toBe(false);
  });

  it("exposes plantable crop art only to clients holding the selected pack", () => {
    const presentation = {
      cropId: "wheat",
      displayName: "Wheat",
      seedDisplayName: "Wheat Seed",
      seedItemId: "wheat_seed" as const,
      seedVariant: null,
      stages: [1, 2, 3, 4].map((stage) => ({
        stage,
        artId: GREENHOUSE_STAGE_ART_IDS[stage as 1 | 2 | 3 | 4],
        assetId: `wheat-stage-${stage}`,
        pivotX: 0.5,
        pivotY: 0.5,
        offsetX: 0,
        offsetY: 0,
        scale: 0.68
      }))
    };
    const activePackId = "a".repeat(64);

    expect(greenhouseCropCatalogForClientPack(activePackId, [presentation], activePackId))
      .toMatchObject({ packId: activePackId, crops: expect.arrayContaining([expect.objectContaining({ cropId: "wheat", plantingAvailable: true })]) });
    expect(greenhouseCropCatalogForClientPack(activePackId, [presentation], "b".repeat(64)))
      .toMatchObject({ packId: null, crops: expect.arrayContaining([expect.objectContaining({ cropId: "wheat", plantingAvailable: false })]) });
  });

  it("parses future crop IDs as data instead of a compiled enum", () => {
    expect(plantGreenhouseMessageSchema.safeParse({
      type: "PLANT_GREENHOUSE",
      requestId: "plant-moonbean",
      greenhouseSessionId: "00000000-0000-4000-8000-000000900008",
      anchorId: "greenhouse-main-anchor:greenhouse_main_room:0:0",
      cropId: "moonbean",
      packId: "a".repeat(64)
    }).success).toBe(true);
    expect(plantGreenhouseMessageSchema.safeParse({
      type: "PLANT_GREENHOUSE",
      requestId: "plant-invalid",
      greenhouseSessionId: "00000000-0000-4000-8000-000000900008",
      anchorId: "greenhouse-main-anchor:greenhouse_main_room:0:0",
      cropId: "../moonbean",
      packId: "a".repeat(64)
    }).success).toBe(false);
    expect(plantGreenhouseMessageSchema.safeParse({
      type: "PLANT_GREENHOUSE",
      requestId: "plant-too-long",
      greenhouseSessionId: "00000000-0000-4000-8000-000000900008",
      anchorId: "greenhouse-main-anchor:greenhouse_main_room:0:0",
      cropId: `a${"b".repeat(48)}`,
      packId: "a".repeat(64)
    }).success).toBe(false);
    expect(plantGreenhouseMessageSchema.safeParse({
      type: "PLANT_GREENHOUSE",
      requestId: "plant-missing-pack",
      greenhouseSessionId: "00000000-0000-4000-8000-000000900008",
      anchorId: "greenhouse-main-anchor:greenhouse_main_room:0:0",
      cropId: "wheat"
    }).success).toBe(false);
  });
});
