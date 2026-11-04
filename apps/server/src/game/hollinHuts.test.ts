import { describe, expect, it, vi } from "vitest";
import { HOLLIN_INTERACTION_RADIUS_M, distanceMeters, hollinDiscountedUnitPrice, hollinHutEntityId, hollinHutIdFromEntityId } from "@ash-atlas/shared";

import { HollinHutError, HollinHutService, InMemoryHollinHutStore, type HollinHutDeps } from "./hollinHuts.js";

const CENTER = { lat: 35, lon: -106 };

export function harness(options: { rank?: number; now?: () => number; gold?: bigint } = {}) {
  const store = new InMemoryHollinHutStore();
  const entities = new Map<string, unknown>();
  const combat = {
    spawnMob: vi.fn((input: { entityId: string; archetype?: string }) => { entities.set(input.entityId, input); return input; }),
    despawnMob: vi.fn((id: string) => entities.delete(id)),
    entity: vi.fn((id: string) => entities.get(id) ?? null)
  };
  const wallet = {
    snapshot: vi.fn(async () => ({ playerId: "p", gold: "1000", revision: "1" })),
    debitForOperationInTransaction: vi.fn(async (_client: unknown, input: { operationKey: string; amount: bigint }) => ({
      applied: !seen.has(input.operationKey) && !!seen.add(input.operationKey), goldBalance: (options.gold ?? 1000n) - input.amount, version: 2n
    }))
  };
  const seen = new Set<string>();
  const inventory = {
    grantItemsForOperationInTransaction: vi.fn(async () => ({ applied: true, inventory: { totals: {} } as never, grants: [] })),
    debitItemsForOperationInTransaction: vi.fn(async () => ({ applied: true, inventory: { totals: {} } as never, grants: [] })),
    getInventorySnapshot: vi.fn(async () => ({ totals: {} }))
  };
  let rank = options.rank ?? 0;
  const deps = {
    store, combat, wallet, inventory,
    ranks: { ensureLoaded: async () => undefined, rankOf: () => rank },
    transaction: async (work: (client: never) => Promise<unknown>) => work({} as never),
    ...(options.now ? { now: options.now } : {})
  } as unknown as HollinHutDeps;
  const service = new HollinHutService(deps);
  return { service, store, combat, wallet, inventory, entities, setRank: (value: number) => { rank = value; } };
}

const player = { playerId: "p1", position: CENTER };

async function spawn(h: ReturnType<typeof harness>) {
  return h.service.spawnHut({ creatorPlayerId: "dev", requestId: "r1", regionCode: "r", zoneId: "z", position: CENTER });
}

describe("Hollin Hut structure and shop", () => {
  it("spawns a hut body with idle Hollins, idempotently per request", async () => {
    const h = harness();
    const hut = await spawn(h);
    expect(h.entities.has(hollinHutEntityId(hut.hutId, 0))).toBe(true);
    expect(h.combat.spawnMob.mock.calls.filter(([m]) => m.archetype === "hollin_farmer")).toHaveLength(3);
    const again = await spawn(h);
    expect(again.hutId).toBe(hut.hutId);
    expect(h.combat.spawnMob).toHaveBeenCalledTimes(4);
    expect(hollinHutIdFromEntityId(hollinHutEntityId(hut.hutId, 0))).toBe(hut.hutId);
  });

  it("discounts the shop by Hollin Lore rank and charges the discounted price", async () => {
    const h = harness();
    const hut = await spawn(h);
    for (const [rank, percent] of [[0, 0], [1, 4], [2, 9], [3, 9]] as const) {
      h.setRank(rank);
      const shop = await h.service.shopFor(player, "a1", hut.hutId);
      expect(shop.discountPercent).toBe(percent);
      const food = shop.lines.find((line) => line.itemId === "simple_food")!;
      expect(food.unitPriceGold).toBe(String(hollinDiscountedUnitPrice(30, rank)));
    }
    h.setRank(1);
    const result = await h.service.buy(player, "a1", { requestId: "b1", hutId: hut.hutId, itemId: "simple_food", quantity: 2, expectedUnitPriceGold: "29" });
    expect(result.totalGold).toBe("58");
    expect(h.wallet.debitForOperationInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: 58n, operationKey: "hollin-purchase:p1:b1" }));
    const replay = await h.service.buy(player, "a1", { requestId: "b1", hutId: hut.hutId, itemId: "simple_food", quantity: 2, expectedUnitPriceGold: "29" });
    expect(replay.replayed).toBe(true);
  });

  it("rejects stale prices, unknown items and distant players", async () => {
    const h = harness();
    const hut = await spawn(h);
    await expect(h.service.buy(player, "a1", { requestId: "b", hutId: hut.hutId, itemId: "simple_food", quantity: 1, expectedUnitPriceGold: "1" }))
      .rejects.toMatchObject({ code: "HOLLIN_PRICE_CHANGED" });
    await expect(h.service.buy(player, "a1", { requestId: "b", hutId: hut.hutId, itemId: "iron_bar", quantity: 1, expectedUnitPriceGold: "1" }))
      .rejects.toMatchObject({ code: "HOLLIN_ITEM_UNAVAILABLE" });
    await expect(h.service.shopFor({ playerId: "p1", position: { lat: 36, lon: -106 } }, "a1", hut.hutId))
      .rejects.toBeInstanceOf(HollinHutError);
  });
});

describe("Hollin Lore rank 1 world map and visits", () => {
  async function twoHuts(h: ReturnType<typeof harness>) {
    const standing = await h.service.spawnHut({ creatorPlayerId: "dev", requestId: "a", regionCode: "r", zoneId: "z", position: CENTER });
    const ruined = await h.service.spawnHut({ creatorPlayerId: "dev", requestId: "b", regionCode: "r", zoneId: "z", position: { lat: 36, lon: -106 } });
    await h.store.markDestroyed(ruined.hutId, new Date(Date.now() + 60_000));
    return { standing, ruined };
  }

  it("rank 0 sees no destinations and cannot visit", async () => {
    const h = harness({ rank: 0 });
    const { standing } = await twoHuts(h);
    expect(await h.service.visibleDestinations("p1")).toEqual([]);
    await expect(h.service.visitTarget("p1", standing.hutId)).rejects.toMatchObject({ code: "HOLLIN_LORE_REQUIRED" });
  });

  it("rank 1 lists standing huts only, however far, and can visit one", async () => {
    const h = harness({ rank: 1 });
    const { standing, ruined } = await twoHuts(h);
    expect(await h.service.visibleDestinations("p1")).toEqual([
      { kind: "hollin_hut", id: standing.hutId, name: "Hollin Hut", lat: CENTER.lat, lon: CENTER.lon, visible: true }
    ]);
    const target = await h.service.visitTarget("p1", standing.hutId);
    expect(distanceMeters(target, standing.position)).toBeGreaterThan(0);
    expect(distanceMeters(target, standing.position)).toBeLessThan(HOLLIN_INTERACTION_RADIUS_M);
    await expect(h.service.visitTarget("p1", ruined.hutId)).rejects.toMatchObject({ code: "HOLLIN_HUT_DESTROYED" });
    await expect(h.service.visitTarget("p1", "hollin-hut:missing")).rejects.toMatchObject({ code: "HOLLIN_HUT_NOT_FOUND" });
  });
});
