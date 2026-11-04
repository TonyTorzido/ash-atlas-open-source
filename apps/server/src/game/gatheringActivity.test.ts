import { describe, expect, it } from "vitest";
import type { EquipmentInstanceV2, FishingEncounterSnapshot, HarvestSessionSnapshot } from "@ash-atlas/shared";

import {
  gatheringActivityForFishing,
  gatheringActivityForHarvest,
  gatheringKindForHarvest
} from "./gatheringActivity.js";

const session = (resourceType: string): HarvestSessionSnapshot => ({
  sessionId: "s1", playerId: "p1", nodeId: "n1", resourceType: resourceType as never,
  operationKey: "k", status: "active",
  startedAt: "2030-01-01T00:00:00.000Z", completesAt: "2030-01-01T00:00:04.000Z",
  expiresAt: "2030-01-01T00:00:14.000Z", completedAt: null, cancelledAt: null
});
const SLOT_FOR: Record<string, string> = {
  stone_axe: "tool_axe", stone_pickaxe: "tool_pickaxe", starter_fishing_pole: "tool_fishing_pole"
};
const withTools = (...definitionIds: string[]) => ({
  active: Object.fromEntries(definitionIds.map((definitionId) =>
    [SLOT_FOR[definitionId], { definitionId } as EquipmentInstanceV2])) as never
});
const withTool = (definitionId: string) => withTools(definitionId);
const target = { lat: 1, lon: 2 };

describe("gathering activity", () => {
  it("maps wood to chop, stone and mines to mine, and leaves plants and resin out", () => {
    expect(gatheringKindForHarvest("wood", "collectible")).toBe("chop");
    expect(gatheringKindForHarvest("stone", "collectible")).toBe("mine");
    expect(gatheringKindForHarvest("iron", "mine")).toBe("mine");
    expect(gatheringKindForHarvest("wood", "resin")).toBeNull();
    expect(gatheringKindForHarvest("flax_fiber", "collectible")).toBeNull();
  });

  it("names the equipped tool only when it matches the action", () => {
    expect(gatheringActivityForHarvest({
      session: session("wood"), source: "collectible", target, equipment: withTool("stone_axe")
    })).toEqual({
      kind: "chop", toolDefinitionId: "stone_axe", targetLat: 1, targetLon: 2,
      startedAt: "2030-01-01T00:00:00.000Z", completesAt: "2030-01-01T00:00:04.000Z"
    });
    expect(gatheringActivityForHarvest({
      session: session("stone"), source: "collectible", target, equipment: withTool("stone_axe")
    })?.toolDefinitionId).toBeNull();
    expect(gatheringActivityForHarvest({
      session: session("wood"), source: "collectible", target: null, equipment: null
    })).toBeNull();
  });

  it("picks the tool from the slot matching the action when all three are equipped", () => {
    const all = withTools("stone_axe", "stone_pickaxe", "starter_fishing_pole");
    expect(gatheringActivityForHarvest({ session: session("wood"), source: "collectible", target, equipment: all })
      ?.toolDefinitionId).toBe("stone_axe");
    expect(gatheringActivityForHarvest({ session: session("iron"), source: "mine", target, equipment: all })
      ?.toolDefinitionId).toBe("stone_pickaxe");
    const bite = { phase: "bite", castPoint: target, serverTime: 0 } as unknown as FishingEncounterSnapshot;
    expect(gatheringActivityForFishing(bite, all, null)?.toolDefinitionId).toBe("starter_fishing_pole");
    // A mismatched item in a slot (never allowed by validation) is still ignored.
    const wrong = { active: { tool_pickaxe: { definitionId: "stone_axe" } as EquipmentInstanceV2 } as never };
    expect(gatheringActivityForHarvest({ session: session("stone"), source: "collectible", target, equipment: wrong })
      ?.toolDefinitionId).toBeNull();
  });

  it("shows fishing from the accepted cast until the encounter ends", () => {
    const encounter = (phase: FishingEncounterSnapshot["phase"], castPoint: { lat: number; lon: number } | null) =>
      ({ phase, castPoint, serverTime: Date.parse("2030-01-01T00:00:00.000Z") }) as FishingEncounterSnapshot;
    expect(gatheringActivityForFishing(encounter("cast", null), null, null)).toBeNull();
    const started = gatheringActivityForFishing(encounter("bite", target), withTool("starter_fishing_pole"), null);
    expect(started).toMatchObject({ kind: "fish", toolDefinitionId: "starter_fishing_pole", completesAt: null });
    const later = { ...encounter("fighting", target), serverTime: Date.parse("2030-01-01T00:00:09.000Z") };
    expect(gatheringActivityForFishing(later, null, started)?.startedAt).toBe(started?.startedAt);
    expect(gatheringActivityForFishing(encounter("landed", target), null, started)).toBeNull();
  });
});
