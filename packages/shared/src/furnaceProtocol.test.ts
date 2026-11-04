import { describe, expect, it } from "vitest";

import {
  FURNACE_METAL_BAR_DURATION_MS,
  FURNACE_RECIPES,
  FURNACE_RECIPE_IDS,
  startableFurnaceRecipes
} from "./furnace.js";
import { parseClientMessage, parseServerMessage } from "./protocol.js";

const requestId = "00000000-0000-4000-8000-000000000001";
const furnaceId = "00000000-0000-4000-8000-000000000002";
const manorId = "00000000-0000-4000-8000-000000000003";
const jobId = "00000000-0000-4000-8000-000000000004";

describe("Furnace protocol", () => {
  it("gates every metal bar by Metallurgy rank 1/3/5 and retires core recipes", () => {
    const ranks = Object.fromEntries(
      startableFurnaceRecipes().map((recipe) => [recipe.recipeId, recipe.minimumMetallurgyRank])
    );
    expect(ranks).toMatchObject({
      revenant_bar: 1, expel_bar: 1, mirage_bar: 1, gale_bar: 1, fleet_bar: 1,
      venomsteel_bar: 3, whetted_bar: 3, lightning_bar: 3, vengeance_bar: 3,
      gloom_bar: 5, fire_bar: 5, ice_bar: 5, vital_bar: 5
    });
    expect(ranks.skyrise_bar).toBe(5);
    for (const core of ["venomsteel_core", "fire_core", "lightning_core", "ice_core"] as const) {
      expect(FURNACE_RECIPES[core].retired).toBe(true);
      expect(ranks).not.toHaveProperty(core);
    }
    expect(FURNACE_RECIPES.revenant_bar.durationMs).toBe(FURNACE_METAL_BAR_DURATION_MS);
    expect(FURNACE_RECIPES.revenant_bar.inputs.map((input) => [input.itemId, input.quantity])).toEqual([
      ["lichen", 1], ["umbral_essence", 4], ["iron_bar", 4]
    ]);
    expect(FURNACE_RECIPES.revenant_bar.categoryInputs?.map((input) => [input.category.label, input.quantity]))
      .toEqual([["any Bones", 9]]);
  });

  it("accepts the four authoritative client commands and bounds batches", () => {
    expect(parseClientMessage(JSON.stringify({ type: "BUILD_FURNACE", requestId })).type)
      .toBe("BUILD_FURNACE");
    expect(parseClientMessage(JSON.stringify({ type: "OPEN_FURNACE", requestId, furnaceId })).type)
      .toBe("OPEN_FURNACE");
    expect(parseClientMessage(JSON.stringify({
      type: "START_FURNACE_SMELT", requestId, furnaceId, recipeId: "venomsteel_bar", quantity: 5
    })).type).toBe("START_FURNACE_SMELT");
    expect(parseClientMessage(JSON.stringify({
      type: "COLLECT_FURNACE_OUTPUT", requestId, furnaceId
    })).type).toBe("COLLECT_FURNACE_OUTPUT");
    for (const recipeId of FURNACE_RECIPE_IDS) {
      expect(parseClientMessage(JSON.stringify({
        type: "START_FURNACE_SMELT", requestId, furnaceId, recipeId, quantity: 1
      })).type).toBe("START_FURNACE_SMELT");
    }
    expect(() => parseClientMessage(JSON.stringify({
      type: "START_FURNACE_SMELT", requestId, furnaceId, recipeId: "venomsteel_bar", quantity: 26
    }))).toThrow();
    // Smelt batches above 5 are refused by the server; breakdown ids take up to 25.
    expect(parseClientMessage(JSON.stringify({
      type: "START_FURNACE_SMELT", requestId, furnaceId, recipeId: "mana_shard", quantity: 25,
      confirmHighGrade: false
    })).type).toBe("START_FURNACE_SMELT");
  });

  it("validates authoritative Furnace state and inventory results", () => {
    const state = {
      furnace: {
        furnaceId,
        manorId,
        ownerPlayerId: "owner",
        ownerUsername: "Ash",
        regionCode: "world-test",
        lat: 35,
        lon: -106,
        builtAt: "2026-01-01T00:00:00.000Z",
        placementRevision: 1
      },
      jobs: [{
        jobId,
        recipeId: "iron_bar",
        outputItemId: "iron_bar",
        outputDisplayName: "Iron Bar",
        requestedQuantity: 3,
        completedQuantity: 1,
        collectedQuantity: 0,
        readyQuantity: 1,
        readySuccessQuantity: 1,
        readyFailureQuantity: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
        nextCompletesAt: "2026-01-01T01:00:00.000Z",
        productionFinished: false
      }],
      queueCapacity: 5,
      occupiedSlots: 3,
      metallurgyRank: 2,
      serverTime: 1
    };
    const inventory = {
      playerId: "owner",
      revision: 1,
      items: [],
      totals: {
        wood: 0, stone: 0, coal: 0, iron: 0, sulfur: 0, slag: 0, iron_bar: 1, venomsteel_bar: 0, venomsteel_core: 0,
        food: 0, ore: 0, water: 0, leather: 0,
        giving_berry: 0,
        balsam_resin: 0, crude_oil: 0, crystal: 0, pearl: 0, atlas_shrine_shard: 0, enchantment_stone: 0
      },
      unlockedSlots: 40
    };
    expect(parseServerMessage(JSON.stringify({
      type: "FURNACE_BUILD_STARTED",
      requestId,
      build: {
        buildId: jobId,
        position: { lat: 35, lon: -106 },
        startedAt: 1_000,
        completesAt: 31_000,
        durationMs: 30_000
      },
      inventory,
      serverTime: 1_000,
      replayed: false
    })).type).toBe("FURNACE_BUILD_STARTED");
    expect(parseServerMessage(JSON.stringify({
      type: "FURNACE_BUILD_RESULT",
      requestId,
      furnace: state.furnace,
      inventory,
      replayed: false
    })).type).toBe("FURNACE_BUILD_RESULT");
    expect(parseServerMessage(JSON.stringify({
      type: "FURNACE_BUILD_CANCELLED",
      requestId,
      buildId: jobId,
      inventory,
      droppedItems: [],
      message: "Cancelled by movement."
    })).type).toBe("FURNACE_BUILD_CANCELLED");
    expect(parseServerMessage(JSON.stringify({
      type: "FURNACE_OUTPUT_COLLECTED",
      requestId,
      state,
      inventory,
      collectedQuantity: 1,
      replayed: false
    })).type).toBe("FURNACE_OUTPUT_COLLECTED");
    expect(parseServerMessage(JSON.stringify({
      type: "FURNACES_SNAPSHOT",
      furnaces: [state.furnace]
    })).type).toBe("FURNACES_SNAPSHOT");
  });
});
