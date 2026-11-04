import { describe, expect, it } from "vitest";

import {
  BACKPACK_DEFINITIONS,
  BACKPACK_LEVELS,
  calculatePlayerInventorySlots
} from "./backpacks.js";
import { clientMessageSchema } from "./protocol/clientMessages.js";
import { SERVER_MESSAGE_VALIDATION_ROUTES } from "./protocol/serverMessageValidation.js";

describe("backpack capacity and crafting definitions", () => {
  it("defines the authoritative craft and upgrade recipes", () => {
    expect(BACKPACK_DEFINITIONS.starter_backpack.cost).toEqual({
      leather: 50,
      gold: 100
    });
    expect(BACKPACK_DEFINITIONS.traveler_backpack.cost).toEqual({
      leather: 100,
      gold: 500
    });
    expect(BACKPACK_DEFINITIONS.explorer_backpack.cost).toEqual({
      leather: 250,
      gold: 1_000
    });
    expect(BACKPACK_DEFINITIONS.trailblazer_backpack.cost).toEqual({
      leather: 500,
      gold: 5_000
    });
  });

  it("uses cumulative tier bonuses and never exceeds 100 slots", () => {
    expect(calculatePlayerInventorySlots(40, [])).toBe(40);
    expect(calculatePlayerInventorySlots(40, [
      "starter_backpack",
      "starter_backpack",
      "starter_backpack",
      "starter_backpack"
    ])).toBe(44);
    expect(calculatePlayerInventorySlots(40, [
      "starter_backpack",
      "starter_backpack",
      "starter_backpack",
      "traveler_backpack"
    ])).toBe(46);
    expect(calculatePlayerInventorySlots(40, [
      "traveler_backpack",
      "traveler_backpack",
      "traveler_backpack",
      "traveler_backpack"
    ])).toBe(52);
    expect(calculatePlayerInventorySlots(40, [
      "explorer_backpack",
      "explorer_backpack",
      "explorer_backpack",
      "explorer_backpack"
    ])).toBe(68);
    expect(calculatePlayerInventorySlots(40, [
      "trailblazer_backpack",
      "trailblazer_backpack",
      "trailblazer_backpack",
      "trailblazer_backpack"
    ])).toBe(100);
    expect(calculatePlayerInventorySlots(100, [
      "trailblazer_backpack",
      "trailblazer_backpack",
      "trailblazer_backpack",
      "trailblazer_backpack"
    ])).toBe(100);
  });

  it("rejects malformed backpack tiers and equipped slots at the protocol boundary", () => {
    const valid = {
      type: "BACKPACK_SNAPSHOT",
      backpacks: {
        playerId: "player-1",
        revision: 1,
        baseSlots: 40,
        backpackBonusSlots: 1,
        effectiveSlots: 41,
        maximumSlots: 100,
        equipped: [null, null, null, null],
        instances: [{
          instanceId: "00000000-0000-4000-8000-000000000709",
          ownerPlayerId: "player-1",
          definitionId: "starter_backpack",
          displayName: "Starter Pack",
          location: "equipped",
          capacityBonus: 1,
          equippedSlot: 0,
          inventorySlotIndex: null,
          manorId: null,
          manorSlotIndex: null,
          version: 1,
          createdAt: "2026-07-29T00:00:00.000Z",
          updatedAt: "2026-07-29T00:00:00.000Z"
        }]
      }
    };
    const schema = SERVER_MESSAGE_VALIDATION_ROUTES.BACKPACK_SNAPSHOT;
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({
      ...valid,
      backpacks: {
        ...valid.backpacks,
        instances: [{ ...valid.backpacks.instances[0], definitionId: "cargo_backpack" }]
      }
    }).success).toBe(false);
    expect(schema.safeParse({
      ...valid,
      backpacks: {
        ...valid.backpacks,
        instances: [{ ...valid.backpacks.instances[0], equippedSlot: 4 }]
      }
    }).success).toBe(false);
  });

  it("keeps the canonical +0 craft and one-level enhancement costs centralized", () => {
    expect(BACKPACK_LEVELS.map(({ level, capacityBonusGrams, upgradeCost }) => [
      level,
      capacityBonusGrams,
      upgradeCost.leather,
      upgradeCost.gold
    ])).toEqual([
      [0, 5_000, 80, 2_000],
      [1, 10_000, 20, 500],
      [2, 15_000, 35, 1_000],
      [3, 20_000, 50, 1_500],
      [4, 25_000, 80, 2_500],
      [5, 30_000, 120, 4_000],
      [6, 35_000, 180, 6_500],
      [7, 40_000, 260, 10_000],
      [8, 45_000, 375, 15_000],
      [9, 50_000, 550, 22_500],
      [10, 55_000, 800, 35_000]
    ]);
  });

  it("accepts only the canonical Crafting backpack request", () => {
    const request = { type: "CRAFT_BACKPACK", requestId: "craft-backpack-1" };
    expect(clientMessageSchema.safeParse(request).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...request, targetEquippedSlot: 0 }).success)
      .toBe(false);
  });

  it("does not accept client-supplied enhancement economics", () => {
    const request = {
      type: "UPGRADE_BACKPACK",
      requestId: "upgrade-backpack-1",
      instanceId: "00000000-0000-4000-8000-000000000709"
    };
    expect(clientMessageSchema.safeParse(request).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      ...request,
      upgradeLevel: 10,
      capacityBonusGrams: 55_000,
      leatherCost: 0,
      goldCost: 0
    }).success).toBe(false);
  });
});
