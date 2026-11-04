import { describe, expect, it, vi } from "vitest";
import {
  GOBLIN_MARKET_RESOURCE_UNIT_PRICES,
  HOLLIN_BIOME_INGREDIENT_POOLS,
  HOLLIN_GIVING_BERRY_LINE,
  HOLLIN_HEAL_COST_GOLD,
  HOLLIN_HUT_MAX_LIFETIME_MS,
  HOLLIN_HUT_MIN_LIFETIME_MS,
  HOLLIN_INGREDIENT_POOL,
  HOLLIN_RAID_LOOT_MIN_DAMAGE,
  HOLLIN_STAPLE_POOL,
  HOLLIN_STOCK_MAX_INGREDIENTS,
  HOLLIN_STOCK_OTHER_STAPLES,
  INVENTORY_CATALOG,
  destinationPoint,
  hollinHutEntityId,
  hollinHutLifetimeMs,
  hollinIngredientPoolForBiome,
  hollinStockEpoch,
  hollinStockForHut,
  rollHollinRaidLoot,
  type LatLon,
  type WorldZoneBiome
} from "@ash-atlas/shared";

import { HollinHutError, HollinHutService, InMemoryHollinHutStore, type HollinHutDeps } from "./hollinHuts.js";

const CENTER: LatLon = { lat: 35, lon: -106 };
const DAY = 24 * 60 * 60_000;

type Entity = { currentHealth: number; maxHealth: number; lifeState: "alive" | "dead" };

function setup(options: {
  turnIn?: (playerId: string, skillId: string, requestId: string) => Promise<unknown>;
  failMarkDestroyedOnce?: boolean;
} = {}) {
  let clock = 5 * DAY + 1_000;
  const store = new InMemoryHollinHutStore();
  if (options.failMarkDestroyedOnce) {
    const original = store.markDestroyed.bind(store);
    let failed = false;
    store.markDestroyed = async (hutId, respawnAt) => {
      if (!failed) { failed = true; throw new Error("db blip"); }
      await original(hutId, respawnAt);
    };
  }
  const entities = new Map<string, Entity>();
  const combat = {
    spawnMob: vi.fn((input: { entityId: string }) => { entities.set(input.entityId, { currentHealth: 100, maxHealth: 100, lifeState: "alive" }); return input; }),
    despawnMob: vi.fn((id: string) => entities.delete(id)),
    despawnPopulationManagedMob: vi.fn((id: string) => entities.delete(id)),
    entity: vi.fn((id: string) => entities.get(id) ?? null),
    directMobTarget: vi.fn(() => true),
    cancelCombat: vi.fn(() => true),
    healMob: vi.fn(() => 0),
    healEntity: vi.fn((id: string, amount: number) => {
      const entity = entities.get(id);
      if (entity) entity.currentHealth = Math.min(entity.maxHealth, entity.currentHealth + amount);
      return amount;
    })
  };
  const seenWallet = new Set<string>();
  const wallet = {
    snapshot: vi.fn(async () => ({ playerId: "p", gold: "100", revision: "1" })),
    debitForOperationInTransaction: vi.fn(async (_client: unknown, input: { operationKey: string }) => {
      const applied = !seenWallet.has(input.operationKey);
      seenWallet.add(input.operationKey);
      return { applied, goldBalance: 90n, version: 2n };
    })
  };
  const seenGrants = new Set<string>();
  const granted: { operationKey: string; playerId: string; grants: unknown }[] = [];
  const inventory = {
    grantItemsForOperationInTransaction: vi.fn(async (_client: unknown, input: { operationKey: string; playerId: string; grants: unknown }) => {
      const applied = !seenGrants.has(input.operationKey);
      seenGrants.add(input.operationKey);
      if (applied) granted.push(input);
      return { applied, inventory: { totals: {} } as never, grants: [] };
    }),
    debitItemsForOperationInTransaction: vi.fn(async () => ({ applied: true, inventory: {} as never, grants: [] })),
    getInventorySnapshot: vi.fn(async () => ({ totals: { giant_egg: 2 } }))
  };
  const onRaidLoot = vi.fn();
  const deps = {
    store, combat, wallet, inventory,
    ranks: {
      ensureLoaded: async () => undefined,
      rankOf: () => 0,
      ...(options.turnIn ? { turnIn: options.turnIn } : {})
    },
    transaction: async (work: (client: never) => Promise<unknown>) => work({} as never),
    now: () => clock,
    onRaidLoot
  };
  const service = new HollinHutService(deps as unknown as HollinHutDeps);
  return { service, deps, store, entities, combat, wallet, inventory, granted, onRaidLoot, setClock: (value: number) => { clock = value; }, now: () => clock };
}

const spawn = (t: ReturnType<typeof setup>) =>
  t.service.spawnHut({ creatorPlayerId: "dev", requestId: "r", regionCode: "us", zoneId: "z", position: CENTER });
const hit = (t: ReturnType<typeof setup>, hutId: string, playerId: string, damageApplied: number) =>
  t.service.onCombatEvent({ kind: "damage_applied", actorId: playerId, actorKind: "player", targetId: hollinHutEntityId(hutId, 0), damageApplied });

describe("Population V2 huts", () => {
  const ENTITY = "7e1c9a52-3a0e-8a4b-9f55-0c1d2e3f4a5b";
  const adopt = (t: ReturnType<typeof setup>, entityId = ENTITY, position = CENTER) =>
    t.service.onPopulationBodySpawned({ entityId, regionCode: "us", zoneId: "z", position });

  it("adopts the Population V2 body as a hut keyed by its stable entity id, idempotently", async () => {
    const t = setup();
    await adopt(t);
    await adopt(t); // re-wake of the same body
    expect(t.store.huts.size).toBe(1);
    const hut = [...t.store.huts.values()][0]!;
    expect(hut).toMatchObject({ hutId: `hollin-hut:${ENTITY}`, source: "population", populationEntityId: ENTITY, life: 0 });
    // Population V2 owns the body; the service builds only the farmers and the orchard.
    expect(t.combat.spawnMob.mock.calls.some(([input]) => (input as unknown as { archetype: string }).archetype === "hollin_hut")).toBe(false);
    expect(t.combat.spawnMob.mock.calls.filter(([input]) => (input as unknown as { archetype: string }).archetype === "hollin_farmer")).toHaveLength(3);
    expect(t.store.orchardTrees.size).toBe(4);
    expect(t.service.ownsHutEntity(ENTITY)).toBe(true);
    expect(t.service.ownsHutEntity("7e1c9a52-0000-8a4b-9f55-0c1d2e3f4a5b")).toBe(false);
  });

  it("keeps the same identity across a restart", async () => {
    const t = setup();
    await adopt(t);
    const restarted = new HollinHutService({ ...(t.deps as object), now: () => t.now() } as unknown as HollinHutDeps);
    expect(restarted.ownsHutEntity(ENTITY)).toBe(false);
    await restarted.recover();
    expect(restarted.ownsHutEntity(ENTITY)).toBe(true);
    await adopt(t); // the body wakes again under the restarted server
    expect([...t.store.huts.keys()]).toEqual([`hollin-hut:${ENTITY}`]);
  });

  it("sends a body that landed inside claimed territory away instead of adopting it", async () => {
    const t = setup();
    t.store.claimedTerritory = () => true;
    const despawn = vi.fn();
    (t.deps as { combat: { despawnPopulationManagedMob?: unknown } }).combat.despawnPopulationManagedMob = despawn;
    await adopt(t);
    expect(t.store.huts.size).toBe(0);
    expect(despawn).toHaveBeenCalledWith(ENTITY);
    expect(t.service.ownsHutEntity(ENTITY)).toBe(false);
  });

  it("recognizes the V2 body in combat, then respawns in place as a service-owned body after 30 minutes", async () => {
    const t = setup();
    await adopt(t);
    t.entities.set(ENTITY, { currentHealth: 10_000, maxHealth: 10_000, lifeState: "alive" });
    const hutId = `hollin-hut:${ENTITY}`;
    expect(t.service.canPlayerAttack("p", ENTITY)).toBe(true);
    t.service.onCombatEvent({ kind: "damage_applied", actorId: "alice", actorKind: "player", targetId: ENTITY, damageApplied: 500, targetHealthAfter: 9_500 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.service.onHutDefeated(ENTITY);
    expect((await t.store.getHut(hutId))!.state).toBe("destroyed");
    t.setClock(t.now() + 30 * 60_000 + 1_000);
    await t.service.tick();
    const revived = (await t.store.getHut(hutId))!;
    expect(revived).toMatchObject({ state: "standing", life: 1, position: CENTER });
    expect(t.entities.has(hollinHutEntityId(hutId, 1))).toBe(true);
    expect(t.service.ownsHutEntity(hollinHutEntityId(hutId, 1))).toBe(true);
  });

});

describe("hut lifetime", () => {
  const ENTITY = "7e1c9a52-3a0e-8a4b-9f55-0c1d2e3f4a5b";
  const NEXT_GENERATION = "9a0b1c2d-3e4f-8a5b-9c6d-7e8f9a0b1c2d";
  const hutId = `hollin-hut:${ENTITY}`;
  const adopt = (t: ReturnType<typeof setup>, entityId = ENTITY, position = CENTER) =>
    t.service.onPopulationBodySpawned({ entityId, regionCode: "us", zoneId: "z", position });

  it("stands 6 to 8 days, deterministically per hut id", async () => {
    const lifetimes = Array.from({ length: 400 }, (_, index) => hollinHutLifetimeMs(`hollin-hut:${index}`));
    expect(lifetimes.every((ms) => ms >= HOLLIN_HUT_MIN_LIFETIME_MS && ms <= HOLLIN_HUT_MAX_LIFETIME_MS)).toBe(true);
    expect(lifetimes.some((ms) => ms < HOLLIN_HUT_MIN_LIFETIME_MS + 0.5 * DAY)).toBe(true);
    expect(lifetimes.some((ms) => ms > HOLLIN_HUT_MAX_LIFETIME_MS - 0.5 * DAY)).toBe(true);
    expect(hollinHutLifetimeMs(hutId)).toBe(hollinHutLifetimeMs(hutId));
    const t = setup();
    await adopt(t);
    expect((await t.store.getHut(hutId))!.expiresAt!.getTime()).toBe(t.now() + hollinHutLifetimeMs(hutId));
    const developer = await t.service.spawnHut({ creatorPlayerId: "dev", requestId: "far", regionCode: "us", zoneId: "z", position: { lat: 0, lon: 0 } });
    expect(developer.expiresAt).toBeNull();
  });

  it("keeps standing with a service-owned body after its generation is cleaned up, never doubled", async () => {
    const t = setup();
    await adopt(t);
    await t.store.setStanding(hutId, "alice", { tradeBannedUntil: null, banReason: null, angryUntil: null, grudgeUntil: new Date(t.now() + DAY) });
    t.entities.set(ENTITY, { currentHealth: 10_000, maxHealth: 10_000, lifeState: "alive" });
    t.store.orphanedPopulationEntities.add(ENTITY);
    t.setClock(t.now() + 61_000);
    await t.service.tick();
    const hut = (await t.store.getHut(hutId))!;
    expect(hut).toMatchObject({ state: "standing", life: 1, position: CENTER });
    expect(t.entities.has(ENTITY)).toBe(false);
    expect(t.entities.has(hollinHutEntityId(hutId, 1))).toBe(true);
    expect(t.entities.has(`mob:hollin-farmer:${hutId}:1:0`)).toBe(true);
    expect(t.entities.has(`mob:hollin-farmer:${hutId}:0:0`)).toBe(false);
    expect(t.store.orchardTrees.size).toBe(4);
    expect(t.store.standings.size).toBe(1);
    expect(t.service.ownsHutEntity(ENTITY)).toBe(false);
    expect(t.service.ownsHutEntity(hollinHutEntityId(hutId, 1))).toBe(true);
    // A second sweep finds nothing left to hand over.
    t.setClock(t.now() + 61_000);
    await t.service.tick();
    expect((await t.store.getHut(hutId))!.life).toBe(1);

    // The same slot coming back with the same entity id is sent away: one hut, one body.
    await adopt(t);
    expect(t.combat.despawnPopulationManagedMob).toHaveBeenLastCalledWith(ENTITY);
    expect(t.store.huts.size).toBe(1);
    expect(t.service.ownsHutEntity(ENTITY)).toBe(false);
    // A new generation in that cell rolls a new entity id: the 30 km rule rejects it while the hut stands.
    await adopt(t, NEXT_GENERATION, destinationPoint(CENTER, 300, 90));
    expect(t.combat.despawnPopulationManagedMob).toHaveBeenLastCalledWith(NEXT_GENERATION);
    expect([...t.store.huts.keys()]).toEqual([hutId]);
  });

  it("retires at expiry with its Hollins, orchard and standings, and the area may roll again", async () => {
    const t = setup();
    await adopt(t);
    await t.store.setStanding(hutId, "alice", { tradeBannedUntil: new Date(t.now() + DAY), banReason: "raid", angryUntil: null, grudgeUntil: null });
    const expiresAt = (await t.store.getHut(hutId))!.expiresAt!.getTime();
    t.setClock(expiresAt - 1);
    await t.service.tick();
    expect(t.store.huts.size).toBe(1);
    t.setClock(expiresAt);
    await expect(t.service.shopFor({ playerId: "p1", position: CENTER }, "acct", hutId)).rejects.toMatchObject({ code: "HOLLIN_HUT_NOT_FOUND" });
    await t.service.tick();
    expect(t.store.huts.size).toBe(0);
    expect(t.store.orchardTrees.size).toBe(0);
    expect(t.store.standings.size).toBe(0);
    expect([...t.entities.keys()].some((id) => id.includes(hutId) || id === ENTITY)).toBe(false);
    expect(t.service.ownsHutEntity(ENTITY)).toBe(false);
    await adopt(t, NEXT_GENERATION);
    expect([...t.store.huts.keys()]).toEqual([`hollin-hut:${NEXT_GENERATION}`]);
  });

  it("retires an expired hut whose old body wakes, and sends the body away instead of adopting it again", async () => {
    const t = setup();
    await adopt(t);
    t.setClock((await t.store.getHut(hutId))!.expiresAt!.getTime() + 1);
    await adopt(t);
    expect(t.store.huts.size).toBe(0);
    expect(t.combat.despawnPopulationManagedMob).toHaveBeenLastCalledWith(ENTITY);
  });
});

describe("30 km exclusion", () => {
  const entity = (index: number) => `00000000-0000-8000-8000-${String(index).padStart(12, "0")}`;
  const adoptAt = (t: ReturnType<typeof setup>, index: number, distanceM: number) =>
    t.service.onPopulationBodySpawned({ entityId: entity(index), regionCode: "us", zoneId: "z", position: destinationPoint(CENTER, distanceM, 45) });

  it("rejects a hut within 30 km of a developer hut, which never expires, and admits one beyond", async () => {
    const t = setup();
    const developer = await spawn(t);
    t.setClock(t.now() + 30 * DAY);
    await t.service.tick();
    expect(await t.store.getHut(developer.hutId)).not.toBeNull();
    await adoptAt(t, 1, 29_000);
    expect(t.store.huts.size).toBe(1);
    expect(t.combat.despawnPopulationManagedMob).toHaveBeenCalledWith(entity(1));
    expect(t.service.ownsHutEntity(entity(1))).toBe(false);
    await adoptAt(t, 2, 31_000);
    expect(t.store.huts.size).toBe(2);
  });

  it("lets exactly one of several concurrent nearby adoptions win", async () => {
    const t = setup();
    await Promise.all([adoptAt(t, 3, 0), adoptAt(t, 4, 10_000), adoptAt(t, 5, 20_000)]);
    expect(t.store.huts.size).toBe(1);
    expect(t.combat.despawnPopulationManagedMob).toHaveBeenCalledTimes(2);
  });
});

describe("rotating stock", () => {
  it("is deterministic per hut and day, varies across days and huts, and mixes staples with ingredients", () => {
    const epoch = hollinStockEpoch(5 * DAY + 1_000);
    const ids = (hutId: string, day: number) => hollinStockForHut(hutId, day).map((line) => line.itemId);
    expect(ids("hollin-hut:a", epoch)).toEqual(ids("hollin-hut:a", epoch));
    expect(ids("hollin-hut:a", epoch).length).toBeGreaterThanOrEqual(1 + HOLLIN_STOCK_OTHER_STAPLES);
    expect(ids("hollin-hut:a", epoch).length).toBeLessThanOrEqual(1 + HOLLIN_STOCK_OTHER_STAPLES + HOLLIN_STOCK_MAX_INGREDIENTS);
    expect(new Set(ids("hollin-hut:a", epoch)).size).toBe(ids("hollin-hut:a", epoch).length);
    expect(ids("hollin-hut:a", epoch)[0]).toBe("simple_food");
    const days = new Set(Array.from({ length: 12 }, (_, index) => ids("hollin-hut:a", epoch + index).join(",")));
    expect(days.size).toBeGreaterThan(1);
    const huts = new Set(Array.from({ length: 12 }, (_, index) => ids(`hollin-hut:${index}`, epoch).join(",")));
    expect(huts.size).toBeGreaterThan(1);
  });

  it("sells only today's stock and rotates when the day changes", async () => {
    const t = setup();
    const hut = await spawn(t);
    const player = { playerId: "p1", position: CENTER };
    const stock = () => hollinStockForHut(hut.hutId, hollinStockEpoch(t.now())).map((line) => line.itemId);
    const todays = stock()[1]!;
    const notToday = ["wheat_seed", "frog_legs", "bear_cut", "giving_berry", "hearty_ration"].find((id) => !stock().includes(id))!;
    const shop = await t.service.shopFor(player, "acct", hut.hutId);
    expect(shop.lines.map((line) => line.itemId)).toEqual(stock());
    await expect(t.service.buy(player, "acct", { requestId: "b1", hutId: hut.hutId, itemId: notToday, quantity: 1, expectedUnitPriceGold: "1" }))
      .rejects.toMatchObject({ code: "HOLLIN_ITEM_UNAVAILABLE" });
    const line = shop.lines.find((entry) => entry.itemId === todays)!;
    await expect(t.service.buy(player, "acct", { requestId: "b2", hutId: hut.hutId, itemId: todays, quantity: 1, expectedUnitPriceGold: line.unitPriceGold }))
      .resolves.toMatchObject({ itemId: todays });
    t.setClock(t.now() + DAY);
    expect((await t.service.shopFor(player, "acct", hut.hutId)).lines.map((entry) => entry.itemId))
      .toEqual(hollinStockForHut(hut.hutId, hollinStockEpoch(t.now())).map((entry) => entry.itemId));
  });
});

describe("biome stock", () => {
  const ENTITY = "7e1c9a52-3a0e-8a4b-9f55-0c1d2e3f4a5b";
  const player = { playerId: "p1", position: CENTER };
  const ingredients = (lines: readonly { itemId: string }[]) => lines.slice(1 + HOLLIN_STOCK_OTHER_STAPLES).map((line) => line.itemId);
  const adoptWithBiome = async (biomeAt: ((position: LatLon) => Promise<WorldZoneBiome>) | undefined) => {
    const t = setup();
    if (biomeAt) (t.deps as { biomeAt?: unknown }).biomeAt = biomeAt;
    await t.service.onPopulationBodySpawned({ entityId: ENTITY, regionCode: "us", zoneId: "z", position: CENTER });
    return { t, hutId: `hollin-hut:${ENTITY}` };
  };

  it("sells a jungle hut's ingredients from the jungle pool, deterministically per hut and day", async () => {
    const biomeAt = vi.fn(async () => "jungle" as const);
    const { t, hutId } = await adoptWithBiome(biomeAt);
    const jungle = new Set(hollinIngredientPoolForBiome("jungle").map((line) => line.itemId));
    const first = await t.service.shopFor(player, "acct", hutId);
    const again = await t.service.shopFor(player, "acct", hutId);
    expect(first.lines.map((line) => line.itemId)).toEqual(again.lines.map((line) => line.itemId));
    expect(first.lines.map((line) => line.itemId))
      .toEqual(hollinStockForHut(hutId, hollinStockEpoch(t.now()), "jungle").map((line) => line.itemId));
    expect(ingredients(first.lines).length).toBeLessThanOrEqual(HOLLIN_STOCK_MAX_INGREDIENTS);
    expect(ingredients(first.lines).every((id) => jungle.has(id))).toBe(true);
    expect(first.lines[0]!.itemId).toBe("simple_food");
    expect(biomeAt).toHaveBeenCalledTimes(1); // resolved once, then remembered
    t.setClock(t.now() + DAY);
    const tomorrow = await t.service.shopFor(player, "acct", hutId);
    expect(ingredients(tomorrow.lines).every((id) => jungle.has(id))).toBe(true);
  });

  it("falls back to the generic pool for developer huts, a missing lookup and a failed lookup", async () => {
    const generic = new Set(HOLLIN_INGREDIENT_POOL.map((line) => line.itemId));
    const expectGeneric = (lines: readonly { itemId: string }[]) =>
      expect(ingredients(lines).every((id) => generic.has(id))).toBe(true);

    const noLookup = await adoptWithBiome(undefined);
    expectGeneric((await noLookup.t.service.shopFor(player, "acct", noLookup.hutId)).lines);

    const failing = await adoptWithBiome(vi.fn(async () => { throw new Error("world down"); }));
    const lines = (await failing.t.service.shopFor(player, "acct", failing.hutId)).lines;
    expect(lines.map((line) => line.itemId))
      .toEqual(hollinStockForHut(failing.hutId, hollinStockEpoch(failing.t.now())).map((line) => line.itemId));

    const developer = setup();
    const biomeAt = vi.fn(async () => "jungle" as const);
    (developer.deps as { biomeAt?: unknown }).biomeAt = biomeAt;
    const hut = await spawn(developer);
    expectGeneric((await developer.service.shopFor(player, "acct", hut.hutId)).lines);
    expect(biomeAt).not.toHaveBeenCalled();
    expect(hollinIngredientPoolForBiome(null)).toBe(HOLLIN_INGREDIENT_POOL);
    expect(hollinIngredientPoolForBiome("wilds")).toBe(HOLLIN_INGREDIENT_POOL);
  });

  it("prices every regional line above its Goblin Market buyback, with real items only", () => {
    for (const [biome, pool] of Object.entries(HOLLIN_BIOME_INGREDIENT_POOLS)) {
      expect(pool!.length, biome).toBeGreaterThanOrEqual(HOLLIN_STOCK_MAX_INGREDIENTS + 3);
      expect(new Set(pool!.map((line) => line.itemId)).size, biome).toBe(pool!.length);
      for (const line of pool!) {
        const buyback = GOBLIN_MARKET_RESOURCE_UNIT_PRICES[line.itemId];
        expect(buyback, `${biome}/${line.itemId} has a buyback`).toBeGreaterThan(0);
        expect(line.basePriceGold, `${biome}/${line.itemId}`).toBeGreaterThan(buyback!);
        expect(INVENTORY_CATALOG[line.itemId as keyof typeof INVENTORY_CATALOG], `${biome}/${line.itemId}`).toBeDefined();
      }
    }
    for (const line of [...HOLLIN_STAPLE_POOL, ...HOLLIN_INGREDIENT_POOL]) {
      const buyback = GOBLIN_MARKET_RESOURCE_UNIT_PRICES[line.itemId] ?? 0;
      expect(line.basePriceGold, line.itemId).toBeGreaterThan(buyback);
    }
  });
});

describe("ingredients and berries", () => {
  const ingredientIds = (lines: readonly { itemId: string }[]) => {
    const staples = new Set(HOLLIN_STAPLE_POOL.map((line) => line.itemId));
    return lines.map((line) => line.itemId).filter((id) => !staples.has(id) && id !== "giving_berry");
  };

  it("shows 0, 1 or 2 biome ingredient lines, each about a third of hut-days, deterministically", () => {
    const counts = [0, 0, 0];
    const samples = 3_000;
    for (let index = 0; index < samples; index += 1) {
      const hutId = `hollin-hut:${index % 300}`;
      const epoch = 20_000 + Math.floor(index / 300);
      const lines = hollinStockForHut(hutId, epoch, "jungle");
      expect(lines).toEqual(hollinStockForHut(hutId, epoch, "jungle"));
      counts[ingredientIds(lines).length]! += 1;
    }
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(samples);
    for (const count of counts) {
      expect(count / samples).toBeGreaterThan(0.29);
      expect(count / samples).toBeLessThan(0.38);
    }
  });

  it("lists Giving Berries every day only where Giving Trees grow, 20 gold each, up to 20 per purchase", async () => {
    expect(HOLLIN_STAPLE_POOL.some((line) => line.itemId === "giving_berry")).toBe(false);
    expect(HOLLIN_GIVING_BERRY_LINE).toMatchObject({ itemId: "giving_berry", basePriceGold: 20, maxQuantity: 20 });
    for (let day = 0; day < 30; day += 1) {
      const berries = hollinStockForHut("hollin-hut:w", 20_000 + day, "greenwood", true).filter((line) => line.itemId === "giving_berry");
      expect(berries).toEqual([HOLLIN_GIVING_BERRY_LINE]);
      expect(hollinStockForHut("hollin-hut:w", 20_000 + day, "greenwood").some((line) => line.itemId === "giving_berry")).toBe(false);
    }

    const player = { playerId: "p1", position: CENTER };
    const treeless = setup();
    const bareHut = await spawn(treeless);
    const bareShop = await treeless.service.shopFor(player, "acct", bareHut.hutId);
    expect(bareShop.lines.some((line) => line.itemId === "giving_berry")).toBe(false);
    await expect(treeless.service.buy(player, "acct", { requestId: "b0", hutId: bareHut.hutId, itemId: "giving_berry", quantity: 1, expectedUnitPriceGold: "20" }))
      .rejects.toMatchObject({ code: "HOLLIN_ITEM_UNAVAILABLE" });

    const wooded = setup();
    const lookups = vi.fn(() => true);
    wooded.store.givingTrees = lookups;
    const hut = await spawn(wooded);
    const berry = (await wooded.service.shopFor(player, "acct", hut.hutId)).lines.find((line) => line.itemId === "giving_berry")!;
    expect(berry).toMatchObject({ baseUnitPriceGold: "20", unitPriceGold: "20", maxQuantity: 20 });
    await expect(wooded.service.buy(player, "acct", { requestId: "b1", hutId: hut.hutId, itemId: "giving_berry", quantity: 13, expectedUnitPriceGold: "20" }))
      .resolves.toMatchObject({ quantity: 13, totalGold: "260" });
    await expect(wooded.service.buy(player, "acct", { requestId: "b2", hutId: hut.hutId, itemId: "giving_berry", quantity: 20, expectedUnitPriceGold: "20" }))
      .resolves.toMatchObject({ quantity: 20, totalGold: "400" });
    await expect(wooded.service.buy(player, "acct", { requestId: "b3", hutId: hut.hutId, itemId: "giving_berry", quantity: 21, expectedUnitPriceGold: "20" }))
      .rejects.toMatchObject({ code: "HOLLIN_INVALID_QUANTITY" });
    expect(lookups).toHaveBeenCalledTimes(1); // resolved once per hut, then remembered
  });
});

describe("heal service", () => {
  it("debits the flat price once per request and restores full health, replay-safe", async () => {
    const t = setup();
    const hut = await spawn(t);
    t.entities.set("p1", { currentHealth: 40, maxHealth: 100, lifeState: "alive" });
    const player = { playerId: "p1", position: CENTER };
    const first = await t.service.heal(player, "acct", { requestId: "heal-1", hutId: hut.hutId });
    expect(first.message).toMatch(/tend/iu);
    expect(t.entities.get("p1")!.currentHealth).toBe(100);
    expect(t.wallet.debitForOperationInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      amount: BigInt(HOLLIN_HEAL_COST_GOLD), operationKey: "hollin-heal:p1:heal-1"
    }));
    // Hurt again, replay the same request: no second charge, no second heal.
    t.entities.get("p1")!.currentHealth = 30;
    const replay = await t.service.heal(player, "acct", { requestId: "heal-1", hutId: hut.hutId });
    expect(replay.message).toMatch(/already/iu);
    expect(t.combat.healEntity).toHaveBeenCalledTimes(1);
    expect(t.entities.get("p1")!.currentHealth).toBe(30);
  });

  it("refuses when not hurt, when too far, and without charging", async () => {
    const t = setup();
    const hut = await spawn(t);
    t.entities.set("p1", { currentHealth: 100, maxHealth: 100, lifeState: "alive" });
    await expect(t.service.heal({ playerId: "p1", position: CENTER }, "acct", { requestId: "h", hutId: hut.hutId }))
      .rejects.toMatchObject({ code: "HOLLIN_NOT_HURT" });
    t.entities.get("p1")!.currentHealth = 10;
    await expect(t.service.heal({ playerId: "p1", position: { lat: 36, lon: -106 } }, "acct", { requestId: "h2", hutId: hut.hutId }))
      .rejects.toBeInstanceOf(HollinHutError);
    expect(t.wallet.debitForOperationInTransaction).not.toHaveBeenCalled();
  });
});

describe("Hollin Lore egg hand-in", () => {
  const discovered = { status: "discovered", skillId: "wildkin_lore", message: "You discovered Hollin Lore!", inventory: { totals: {} }, snapshot: { revision: 3 } };

  it("discovers wildkin_lore through the shared turn-in and passes the skill snapshot on", async () => {
    const turnIn = vi.fn(async () => discovered);
    const t = setup({ turnIn });
    const hut = await spawn(t);
    const result = await t.service.turnInEggs({ playerId: "p1", position: CENTER }, "acct", { requestId: "egg-1", hutId: hut.hutId });
    expect(turnIn).toHaveBeenCalledWith("p1", "wildkin_lore", "egg-1");
    expect(result).toMatchObject({ service: "turn_in_eggs", skills: { revision: 3 } });
  });

  it("is denied without enough eggs and when the lore is already known", async () => {
    const insufficient = setup({ turnIn: async () => ({ status: "insufficient", skillId: "wildkin_lore", message: "Hollin Lore needs 6 Giant Eggs. You have 2.", have: 2, need: 6 }) });
    const hut = await spawn(insufficient);
    await expect(insufficient.service.turnInEggs({ playerId: "p1", position: CENTER }, "acct", { requestId: "e", hutId: hut.hutId }))
      .rejects.toMatchObject({ code: "HOLLIN_NOT_ENOUGH_EGGS" });
    const known = setup({ turnIn: async () => ({ status: "already_discovered", skillId: "wildkin_lore", message: "You have already discovered Hollin Lore." }) });
    const knownHut = await spawn(known);
    await expect(known.service.turnInEggs({ playerId: "p1", position: CENTER }, "acct", { requestId: "e", hutId: knownHut.hutId }))
      .rejects.toMatchObject({ code: "HOLLIN_LORE_KNOWN" });
  });

  it("reports eggs held and needed in the shop snapshot", async () => {
    const t = setup();
    const hut = await spawn(t);
    const shop = await t.service.shopFor({ playerId: "p1", position: CENTER }, "acct", hut.hutId);
    expect(shop.eggs).toEqual({ have: 2, need: 5, discovered: false });
  });
});

describe("raid loot", () => {
  it("rolls deterministically and always includes one common item", () => {
    expect(rollHollinRaidLoot("seed")).toEqual(rollHollinRaidLoot("seed"));
    expect(rollHollinRaidLoot("seed").length).toBeGreaterThanOrEqual(1);
    const seeds = Array.from({ length: 400 }, (_, index) => rollHollinRaidLoot(`s${index}`));
    expect(seeds.every((loot) => loot.length >= 1 && loot.length <= 3)).toBe(true);
    expect(seeds.some((loot) => loot.some((entry) => ["giant_egg", "bear_cut", "alligator_tail", "zappy_bird_meat"].includes(entry.itemId)))).toBe(true);
    // Food-heavy: everything on the common table is food or a cooking ingredient.
    expect(seeds.every((loot) => loot[0]!.quantity >= 3)).toBe(true);
  });

  it("grants each qualifying contributor exactly one roll, even when the defeat is retried", async () => {
    const t = setup({ failMarkDestroyedOnce: true });
    const hut = await spawn(t);
    hit(t, hut.hutId, "alice", HOLLIN_RAID_LOOT_MIN_DAMAGE);
    hit(t, hut.hutId, "bob", HOLLIN_RAID_LOOT_MIN_DAMAGE * 5);
    hit(t, hut.hutId, "bob", 50);
    hit(t, hut.hutId, "drive-by", HOLLIN_RAID_LOOT_MIN_DAMAGE - 1);
    await expect(t.service.onHutDefeated(hollinHutEntityId(hut.hutId, 0))).rejects.toThrow("db blip");
    await t.service.onHutDefeated(hollinHutEntityId(hut.hutId, 0));
    // A third, late callback sees the destroyed hut and does nothing.
    await t.service.onHutDefeated(hollinHutEntityId(hut.hutId, 0));
    expect(t.granted.map((entry) => entry.playerId).sort()).toEqual(["alice", "bob"]);
    expect(t.granted.map((entry) => entry.operationKey).sort()).toEqual([
      `hollin-raid-loot:${hut.hutId}:0:alice`, `hollin-raid-loot:${hut.hutId}:0:bob`
    ]);
    expect(t.onRaidLoot).toHaveBeenCalledTimes(2);
    expect((await t.store.getHut(hut.hutId))!.state).toBe("destroyed");
  });
});
