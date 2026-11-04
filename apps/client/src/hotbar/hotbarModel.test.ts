import {
  FIELD_CONSUMABLE_ITEM_IDS,
  emptyInventoryTotals,
  INVENTORY_CATALOG,
  type PlayerInventoryItem,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  defaultHotbarSlots,
  hotbarBindingForInventoryItem,
  hotbarHealEffectFromServer,
  hotbarHealNextTickAt,
  hotbarHealTicksDone,
  hotbarItemChoices,
  HOTBAR_SLOT_LAYOUT,
  normalizeHotbarSlots,
  resolveHotbarBinding
} from "./hotbarModel.js";

function inventoryItem(
  resourceType: PlayerInventoryItem["resourceType"],
  overrides: Partial<PlayerInventoryItem> = {}
): PlayerInventoryItem {
  return {
    playerId: "player-1",
    resourceType,
    variant: "default",
    quantity: 1,
    ...overrides
  };
}

function snapshot(items: PlayerInventoryItem[]): PlayerInventorySnapshot {
  return {
    playerId: "player-1",
    revision: 1,
    items,
    totals: emptyInventoryTotals()
  };
}

describe("hotbar model", () => {
  it("keeps exactly ten player slots and ignores the reserved core slot", () => {
    expect(defaultHotbarSlots().map((slot) => slot.slotId)).toEqual([
      "left-1", "left-2", "left-3", "left-4", "left-5",
      "right-1", "right-2", "right-3", "right-4", "right-5"
    ]);
    expect(normalizeHotbarSlots([
      { slotId: "core", binding: { kind: "consumable", itemId: "simple_food", variant: "default" } },
      { slotId: "left-1", binding: { kind: "consumable", itemId: "simple_food", variant: "default" } }
    ])[0]?.binding).toEqual({ kind: "consumable", itemId: "simple_food", variant: "default" });
    expect(normalizeHotbarSlots([
      { slotId: "core", binding: { kind: "consumable", itemId: "simple_food", variant: "default" } }
    ]).every((slot) => (slot.slotId as string) !== "core")).toBe(true);
  });

  it("normalizes persisted six-slot rows into the new left-5 and right-5 slots", () => {
    const legacy = [
      { slotId: "left-1" as const, binding: { kind: "consumable" as const, itemId: "simple_food", variant: "default" } },
      { slotId: "left-2" as const, binding: null },
      { slotId: "left-3" as const, binding: null },
      { slotId: "right-1" as const, binding: null },
      { slotId: "right-2" as const, binding: null },
      { slotId: "right-3" as const, binding: null }
    ];
    expect(normalizeHotbarSlots(legacy).map((slot) => slot.slotId)).toEqual([
      "left-1", "left-2", "left-3", "left-4", "left-5",
      "right-1", "right-2", "right-3", "right-4", "right-5"
    ]);
    expect(normalizeHotbarSlots(legacy)[0]?.binding).toEqual(legacy[0]!.binding);
    expect(normalizeHotbarSlots(legacy)[3]?.binding).toBeNull();
    expect(normalizeHotbarSlots(legacy)[9]?.binding).toBeNull();
  });

  it("keeps five vertical slots per rail with sequential 1-9,0 labels", () => {
    expect(HOTBAR_SLOT_LAYOUT.filter((slot) => slot.side === "left").map((slot) => [slot.slotId, slot.keyLabel])).toEqual([
      ["left-1", "1"], ["left-2", "2"], ["left-3", "3"], ["left-4", "4"], ["left-5", "5"]
    ]);
    expect(HOTBAR_SLOT_LAYOUT.filter((slot) => slot.side === "right").map((slot) => [slot.slotId, slot.keyLabel])).toEqual([
      ["right-1", "6"], ["right-2", "7"], ["right-3", "8"], ["right-4", "9"], ["right-5", "0"]
    ]);
  });

  it("offers Giving Berry, the field consumables and owned usable rod identities", () => {
    const consumables = Object.values(INVENTORY_CATALOG)
      .filter((entry) => entry.kind === "consumable")
      .map((entry) => inventoryItem(entry.itemId as PlayerInventoryItem["resourceType"]));
    expect(hotbarBindingForInventoryItem(inventoryItem("balsam_resin"))).toBeNull();
    const choices = hotbarItemChoices(snapshot([
      ...consumables,
      inventoryItem("fishing_rod", { entryId: "rod-1", rodId: "rod-1", usesRemaining: 12 }),
      inventoryItem("fishing_rod", { entryId: "rod-empty", rodId: "rod-empty", usesRemaining: 0 }),
      inventoryItem("giving_berry", { quantity: 0 })
    ]));

    expect(choices.map((choice) => choice.binding.kind === "consumable"
      ? choice.binding.itemId
      : choice.binding.kind === "fishing_rod" ? choice.binding.rodId
        : choice.binding.kind === "gear_scroll" ? choice.binding.scrollId : choice.binding.actionId).sort())
      .toEqual(["rod-1", "giving_berry", ...FIELD_CONSUMABLE_ITEM_IDS].sort());
    expect(choices.some((choice) => choice.binding.kind === "fishing_rod" && choice.binding.rodId === "rod-empty")).toBe(false);
    expect(choices.find((choice) => choice.binding.kind === "consumable" && choice.binding.itemId === "giving_berry")?.actionable).toBe(true);
  });

  it("resolves quantity, durability, disappearance, and reacquisition from fresh snapshots", () => {
    const balsamBinding = { kind: "consumable" as const, itemId: "giving_berry", variant: "default" };
    const rodBinding = { kind: "fishing_rod" as const, rodId: "rod-1" };
    const absent = resolveHotbarBinding(balsamBinding, snapshot([]));
    expect(absent).toMatchObject({ available: false, actionable: false });
    expect(absent?.reason).toMatch(/inventory/i);

    const reacquired = resolveHotbarBinding(balsamBinding, snapshot([inventoryItem("giving_berry", { entryId: "balsam-1", quantity: 3 })]));
    expect(reacquired).toMatchObject({ available: true, actionable: true, item: { entryId: "balsam-1", quantity: 3 } });

    const depleted = resolveHotbarBinding(rodBinding, snapshot([inventoryItem("fishing_rod", { entryId: "rod-1", rodId: "rod-1", usesRemaining: 0 })]));
    expect(depleted).toMatchObject({ available: false, actionable: false });
    expect(depleted?.reason).toMatch(/casts/i);
    expect(resolveHotbarBinding(rodBinding, snapshot([inventoryItem("fishing_rod", { entryId: "rod-1", rodId: "rod-1", usesRemaining: 4 })])))
      .toMatchObject({ available: true, actionable: true });
  });

  it("uses durable item and rod identities rather than stack indexes", () => {
    expect(hotbarBindingForInventoryItem(inventoryItem("giving_berry", { entryId: "stack-a", slotIndex: 4 })))
      .toEqual({ kind: "consumable", itemId: "giving_berry", variant: "default" });
    expect(hotbarBindingForInventoryItem(inventoryItem("fishing_rod", { entryId: "rod-a", rodId: "rod-a", slotIndex: 2, usesRemaining: 8 })))
      .toEqual({ kind: "fishing_rod", rodId: "rod-a" });
  });
});

describe("heal-over-time ring ticks", () => {
  const make = (tickMs: number) => hotbarHealEffectFromServer(
    { effectId: "e1", startedAt: "2026-10-02T12:00:00.000Z", endsAt: "2026-10-02T12:00:09.600Z" },
    Date.parse("2026-10-02T12:00:00.000Z"),
    1_000_000,
    7,
    tickMs
  )!;
  const effect = make(1_600);
  it("rebases server timestamps onto the client clock", () => {
    expect(effect).toMatchObject({ startMs: 1_000_000, endMs: 1_009_600, tickCount: 7, tickMs: 1_600 });
  });
  it("lands the first tick at use, one per interval, and the seventh at the end", () => {
    expect(hotbarHealTicksDone(effect, 1_000_000)).toBe(1);
    expect(hotbarHealTicksDone(effect, 1_001_599)).toBe(1);
    expect(hotbarHealTicksDone(effect, 1_001_600)).toBe(2);
    expect(hotbarHealTicksDone(effect, 1_008_000)).toBe(6);
    expect(hotbarHealTicksDone(effect, 1_009_600)).toBe(7);
    expect(hotbarHealTicksDone(effect, 1_050_000)).toBe(7);
    expect(hotbarHealNextTickAt(effect, 1_000_100)).toBe(1_001_600);
    expect(hotbarHealNextTickAt(effect, 1_009_600)).toBeNull();
  });
  it("follows the Monk double cadence and still ends on the seventh tick", () => {
    const fast = make(800);
    expect(fast.endMs).toBe(1_004_800);
    expect(hotbarHealTicksDone(fast, 1_000_800)).toBe(2);
    expect(hotbarHealTicksDone(fast, 1_004_800)).toBe(7);
  });
});
