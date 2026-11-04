import { describe, expect, it } from "vitest";

import type { LootCard, LootCardEntry } from "./lootCards.js";
import {
  aggregateDrops, dropsFromCard, isPillRarity, LootFlyState, LootGoldHold, LootPillState,
  cubicBezierEase, lootBurstPoint, lootCountStackOffset, lootLaunchLabel, lootMagnetEase, lootPillAlpha, LOOT_FLY_MAX_ACTIVE, LOOT_GOLD_HOLD_MAX_MS,
  LOOT_PILL_FADE_MS, LOOT_PILL_HOLD_MS, LOOT_PILL_MAX, LOOT_PILL_MERGE_MS, pillEntriesFromCard, planLaunches
} from "./lootFly.js";

const entry = (partial: Partial<LootCardEntry> & Pick<LootCardEntry, "key">): LootCardEntry => ({
  kind: "item", itemId: partial.key, name: partial.key, quantity: 1, rarity: "common", ...partial
});
const card = (id: string, entries: LootCardEntry[]): LootCard => ({
  id, source: "kill", boss: false, eyebrow: null, heading: "Dune Wolf", entries, createdAtMs: 0, expiresAtMs: 5_000
});

describe("drops from a card", () => {
  it("sends gold first, then items best rarity first, and never flies ground drops", () => {
    const drops = dropsFromCard(card("kill:a", [
      entry({ key: "leather", quantity: 2 }),
      entry({ key: "gold", kind: "gold", itemId: null, name: "Gold", quantity: 22 }),
      entry({ key: "fang", rarity: "uncommon" }),
      entry({ key: "pelt", kind: "ground", rarity: "rare" })
    ]));
    expect(drops.map((drop) => drop.itemId ?? "gold")).toEqual(["gold", "fang", "leather"]);
    expect(drops[0]!.holdIds).toEqual(["gold:kill:a"]);
  });

  it("aggregates the same item and gold into one icon", () => {
    const [merged] = aggregateDrops([
      { kind: "item", itemId: "leather", name: "Leather", quantity: 2, rarity: "common", holdIds: [] },
      { kind: "item", itemId: "leather", name: "Leather", quantity: 3, rarity: "common", holdIds: [] }
    ]);
    expect(merged!.quantity).toBe(5);
    expect(lootLaunchLabel({ quantity: 22, folded: 0 })).toBe("+22");
    expect(lootLaunchLabel({ quantity: 2, folded: 0 })).toBe("+2");
  });
});

describe("rarity gating", () => {
  it("gives pills only to rare and better, delivered or on the ground", () => {
    expect(["common", "uncommon", "rare", "epic", "legendary"].map((r) => isPillRarity(r as never)))
      .toEqual([false, false, true, true, true]);
    const entries = pillEntriesFromCard(card("kill:b", [
      entry({ key: "gold", kind: "gold", itemId: null, quantity: 9, rarity: "legendary" }),
      entry({ key: "leather" }), entry({ key: "fang", rarity: "uncommon" }),
      entry({ key: "ring", rarity: "rare" }), entry({ key: "crown", kind: "ground", rarity: "epic" })
    ]));
    expect(entries.map((e) => e.key)).toEqual(["ring", "crown"]);
  });
});

describe("flight cap", () => {
  const drop = (n: number) => ({
    kind: "item" as const, itemId: `i${n}`, name: `i${n}`, quantity: 1, rarity: "common" as const, holdIds: []
  });

  it("launches everything when there is room", () => {
    const { launch, waiting } = planLaunches([drop(1), drop(2)], 5);
    expect(launch).toHaveLength(2);
    expect(waiting).toEqual([]);
  });

  it("folds extras into the last icon's count label", () => {
    const drops = Array.from({ length: 15 }, (_, n) => drop(n));
    const { launch } = planLaunches(drops, LOOT_FLY_MAX_ACTIVE);
    expect(launch).toHaveLength(LOOT_FLY_MAX_ACTIVE);
    expect(LOOT_FLY_MAX_ACTIVE).toBe(6);
    expect(launch.at(-1)!.folded).toBe(9);
    expect(lootLaunchLabel(launch.at(-1)!)).toBe("+10");
  });

  it("keeps drops waiting when the air is full, then releases them as slots open", () => {
    const state = new LootFlyState(new LootGoldHold());
    state.accept(card("kill:c", [entry({ key: "leather", quantity: 2 })]), 0);
    expect(state.takeLaunches(LOOT_FLY_MAX_ACTIVE, 10)).toEqual([]);
    expect(state.queued()).toBe(1);
    state.accept(card("kill:d", [entry({ key: "leather", quantity: 3 })]), 20);
    const [launch] = state.takeLaunches(LOOT_FLY_MAX_ACTIVE - 1, 30);
    expect(launch!.quantity).toBe(5);
    expect(state.queued()).toBe(0);
  });

  it("drops stale queue entries and releases their gold hold", () => {
    const hold = new LootGoldHold();
    const state = new LootFlyState(hold);
    state.accept(card("kill:e", [entry({ key: "gold", kind: "gold", itemId: null, quantity: 40 })]), 0);
    expect(hold.held(1)).toBe(40);
    expect(state.takeLaunches(LOOT_FLY_MAX_ACTIVE, 6_000)).toEqual([]);
    expect(hold.held(6_000)).toBe(0);
  });
});

describe("burst around the source", () => {
  const origin = { x: 200, y: 300 };

  it("spreads icons evenly around the source, 30-40px out, in every direction", () => {
    const points = [0, 1, 2, 3].map((i) => lootBurstPoint(origin, i, 4, () => 0.5));
    for (const point of points) {
      const radius = Math.hypot(point.x - origin.x, point.y - origin.y);
      expect(radius).toBeGreaterThanOrEqual(30);
      expect(radius).toBeLessThanOrEqual(40);
    }
    expect(points[0]!.y).toBeLessThan(origin.y);
    expect(points[1]!.x).toBeGreaterThan(origin.x);
    expect(points[2]!.y).toBeGreaterThan(origin.y);
    expect(points[3]!.x).toBeLessThan(origin.x);
  });

  it("ignores where the player stands (no away rule)", () => {
    const a = lootBurstPoint(origin, 0, 1, () => 0.5);
    const b = lootBurstPoint(origin, 0, 1, () => 0.5);
    expect(a).toEqual(b);
  });
});

describe("magnet easing", () => {
  it("starts slow and finishes fast, ending exactly on 1", () => {
    expect(lootMagnetEase(0)).toBe(0);
    expect(lootMagnetEase(1)).toBe(1);
    expect(lootMagnetEase(0.5)).toBeLessThan(0.3);
    expect(lootMagnetEase(0.9)).toBeGreaterThan(lootMagnetEase(0.5));
    expect(cubicBezierEase(0, 0, 1, 1)(0.5)).toBeCloseTo(0.5, 2);
  });
});

describe("arrival count stacking", () => {
  it("lifts landings inside 150ms apart and resets after the window", () => {
    expect(lootCountStackOffset([], 100)).toBe(0);
    expect(lootCountStackOffset([90], 100)).toBe(14);
    expect(lootCountStackOffset([60, 90], 100)).toBe(28);
    expect(lootCountStackOffset([60, 90], 400)).toBe(0);
  });
});

describe("pills", () => {
  const rare = { itemId: "ring", name: "Prime Ring", rarity: "rare" as const, quantity: 1 };

  it("merges the same drop inside one second and stacks different ones", () => {
    const pills = new LootPillState();
    pills.push([rare], 0);
    pills.push([rare], LOOT_PILL_MERGE_MS - 1);
    pills.push([{ ...rare, itemId: "blade", name: "Blade", rarity: "epic" }], 500);
    const active = pills.active(600);
    expect(active.map((pill) => [pill.name, pill.quantity])).toEqual([["Prime Ring", 2], ["Blade", 1]]);
  });

  it("starts a new pill once the merge window has passed", () => {
    const pills = new LootPillState();
    pills.push([rare], 0);
    pills.push([rare], LOOT_PILL_MERGE_MS + 1);
    expect(pills.active(LOOT_PILL_MERGE_MS + 2)).toHaveLength(2);
  });

  it("holds, fades, expires on its own and caps the stack", () => {
    const pills = new LootPillState();
    pills.push([rare], 0);
    const [pill] = pills.active(0);
    expect(lootPillAlpha(pill!, LOOT_PILL_HOLD_MS - 1)).toBe(1);
    expect(lootPillAlpha(pill!, LOOT_PILL_HOLD_MS + LOOT_PILL_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(pills.active(LOOT_PILL_HOLD_MS + LOOT_PILL_FADE_MS)).toEqual([]);
    for (let n = 0; n < LOOT_PILL_MAX + 3; n += 1) pills.push([{ ...rare, itemId: `x${n}`, name: `x${n}` }], 10_000);
    expect(pills.active(10_001)).toHaveLength(LOOT_PILL_MAX);
  });
});

describe("gold hold", () => {
  it("holds until released and lapses by itself", () => {
    const hold = new LootGoldHold();
    let changes = 0;
    hold.subscribe(() => { changes += 1; });
    hold.add("a", 22, 0);
    hold.add("b", 8, 0);
    expect(hold.held(10)).toBe(30);
    hold.release(["a"]);
    expect(hold.held(10)).toBe(8);
    expect(hold.held(LOOT_GOLD_HOLD_MAX_MS + 1)).toBe(0);
    expect(changes).toBe(3);
  });
});
