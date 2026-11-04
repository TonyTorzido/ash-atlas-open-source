import { describe, expect, it, vi } from "vitest";
import {
  HOLLIN_HUT_MAX_HP,
  HOLLIN_HUT_REPAIR_DELAY_MS,
  HOLLIN_HUT_RESPAWN_MS,
  HOLLIN_GRUDGE_MS,
  HOLLIN_HIT_TRADE_BAN_MS,
  HOLLIN_MAX_DEFENDERS,
  HOLLIN_RAID_WAVES,
  hollinWaveComposition,
  HOLLIN_ORCHARD_TRADE_BAN_MS,
  HOLLIN_RAID_TRADE_BAN_MS,
  hollinHutEntityId
} from "@ash-atlas/shared";

import { MOB_DEFINITIONS, resolveMobCombatProfile } from "./combat/mobDefinitions.js";
import { HollinHutService, InMemoryHollinHutStore, hollinOrchardTreeId, type HollinHutDeps } from "./hollinHuts.js";

type Mob = { entityId: string; archetype: string; currentHealth: number; maxHealth: number; lifeState: "alive" | "dead"; targetEntityId: string | null };

function setup(rank = 0) {
  let clock = 1_000_000;
  const store = new InMemoryHollinHutStore();
  const mobs = new Map<string, Mob>();
  const combat = {
    spawnMob: vi.fn((input: { entityId: string; archetype: string }) => {
      const max = input.archetype === "hollin_hut" ? HOLLIN_HUT_MAX_HP : 60;
      mobs.set(input.entityId, { entityId: input.entityId, archetype: input.archetype, currentHealth: max, maxHealth: max, lifeState: "alive", targetEntityId: null });
      return mobs.get(input.entityId);
    }),
    despawnMob: vi.fn((id: string) => mobs.delete(id)),
    entity: vi.fn((id: string) => mobs.get(id) ?? null),
    directMobTarget: vi.fn((id: string, playerId: string) => { const m = mobs.get(id); if (m) m.targetEntityId = playerId; return true; }),
    cancelCombat: vi.fn((id: string) => { const m = mobs.get(id); if (m) m.targetEntityId = null; return true; }),
    healMob: vi.fn((id: string, amount: number) => { const m = mobs.get(id); if (!m) return 0; m.currentHealth = Math.min(m.maxHealth, m.currentHealth + Math.round(amount)); return amount; })
  };
  const inventory = {
    grantItemsForOperationInTransaction: vi.fn(async () => ({ applied: true, inventory: {} as never, grants: [] })),
    debitItemsForOperationInTransaction: vi.fn(async () => ({ applied: true, inventory: {} as never, grants: [] })),
    getInventorySnapshot: vi.fn(async () => ({ totals: {} }))
  };
  const wallet = {
    snapshot: vi.fn(async () => ({ playerId: "p", gold: "100", revision: "1" })),
    debitForOperationInTransaction: vi.fn(async () => ({ applied: true, goldBalance: 90n, version: 2n }))
  };
  const online: { playerId: string; position: { lat: number; lon: number } }[] = [];
  const ranks = new Map<string, number>([["lore", rank]]);
  const service = new HollinHutService({
    store, combat, wallet, inventory,
    ranks: { ensureLoaded: async () => undefined, rankOf: (id: string) => ranks.get(id) ?? 0 },
    transaction: async (work: (c: never) => Promise<unknown>) => work({} as never),
    onlinePlayers: () => online,
    now: () => clock
  } as unknown as HollinHutDeps);
  store.now = () => clock;
  const advance = async (ms: number) => { clock += ms; await service.tick(); };
  return { service, store, mobs, combat, inventory, ranks, online, advance, now: () => clock };
}

const POS = { lat: 35, lon: -106 };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function hut(t: ReturnType<typeof setup>) {
  return t.service.spawnHut({ creatorPlayerId: "dev", requestId: "r", regionCode: "r", zoneId: "z", position: POS });
}
const hit = (t: ReturnType<typeof setup>, hutId: string, playerId: string, damageApplied = 0, healthAfter: number | null = null) =>
  t.service.onCombatEvent({
    kind: "damage_applied", actorId: playerId, actorKind: "player", targetId: hollinHutEntityId(hutId, 0),
    damageApplied, targetHealthAfter: healthAfter
  });
const hitHollin = (t: ReturnType<typeof setup>, targetId: string, playerId: string) =>
  t.service.onCombatEvent({ kind: "damage_applied", actorId: playerId, actorKind: "player", targetId, damageApplied: 5 });
const defendersOf = (t: ReturnType<typeof setup>) =>
  [...t.mobs.values()].filter((m) => /^hollin_(guard|brute|elder)$/u.test(m.archetype));
const kindsOf = (t: ReturnType<typeof setup>, archetype: string) => [...t.mobs.values()].filter((m) => m.archetype === archetype);
const player = (id: string) => ({ playerId: id, position: POS });
const guardsOf = (t: ReturnType<typeof setup>) => [...t.mobs.values()].filter((m) => m.archetype === "hollin_guard");

describe("hut mob definition", () => {
  it("has 10,000 health; its food and ingredient loot is the per-contributor raid roll", () => {
    expect(resolveMobCombatProfile("hollin_hut", MOB_DEFINITIONS.hollin_hut.level).maxHealth).toBe(HOLLIN_HUT_MAX_HP);
    const rewards = MOB_DEFINITIONS.hollin_hut.rewards;
    expect(rewards.gold).toBeGreaterThan(0);
    expect(rewards.chanceItems.map((item) => item.itemId)).not.toContain("simple_food");
  });
});

describe("guarded orchard", () => {
  it("angers the hut for a player without Hollin Lore rank 2, and only for that player", async () => {
    const t = setup();
    const h = await hut(t);
    expect(t.store.orchardTrees.size).toBe(4);
    const tree = hollinOrchardTreeId(h.hutId, 0);
    expect(await t.service.onOrchardHarvestStart("thief", tree)).toBe(true);
    const standing = await t.store.getStanding(h.hutId, "thief");
    expect(standing.banReason).toBe("orchard");
    expect(standing.tradeBannedUntil!.getTime()).toBe(t.now() + HOLLIN_ORCHARD_TRADE_BAN_MS);
    await expect(t.service.buy(player("thief"), "a", { requestId: "b", hutId: h.hutId, itemId: "simple_food", quantity: 1, expectedUnitPriceGold: "30" }))
      .rejects.toMatchObject({ code: "HOLLIN_TRADE_BANNED" });
    const other = await t.service.buy(player("other"), "a", { requestId: "b2", hutId: h.hutId, itemId: "simple_food", quantity: 1, expectedUnitPriceGold: "30" });
    expect(other.itemId).toBe("simple_food");
    const guards = guardsOf(t);
    expect(guards.length).toBeGreaterThan(0);
    expect(guards.every((g) => g.targetEntityId === "thief")).toBe(true);
    expect(t.service.canMobAttack(guards[0]!.entityId, "thief")).toBe(true);
    expect(t.service.canMobAttack(guards[0]!.entityId, "other")).toBe(false);
  });

  it("lets rank 2 players harvest in peace", async () => {
    const t = setup(2);
    const h = await hut(t);
    expect(await t.service.onOrchardHarvestStart("lore", hollinOrchardTreeId(h.hutId, 1))).toBe(false);
    expect((await t.store.getStanding(h.hutId, "lore")).tradeBannedUntil).toBeNull();
    expect(guardsOf(t)).toHaveLength(0);
  });

  it("ignores non-orchard nodes and lets the ban expire", async () => {
    const t = setup();
    const h = await hut(t);
    expect(await t.service.onOrchardHarvestStart("x", "plant:dev:other")).toBe(false);
    await t.service.onOrchardHarvestStart("thief", hollinOrchardTreeId(h.hutId, 0));
    await t.advance(HOLLIN_ORCHARD_TRADE_BAN_MS + 1);
    const shop = await t.service.shopFor(player("thief"), "a", h.hutId);
    expect(shop.tradeBannedUntil).toBeNull();
  });
});

describe("raid", () => {
  it("gives damage alone raid aggro and wave 1, but no trade ban", async () => {
    const t = setup();
    const h = await hut(t);
    hit(t, h.hutId, "griefer", 500, 9_500);
    await flush();
    const standing = await t.store.getStanding(h.hutId, "griefer");
    expect(standing.tradeBannedUntil).toBeNull();
    expect(standing.grudgeUntil).toBeNull();
    expect(defendersOf(t).filter((m) => m.targetEntityId === "griefer").length).toBeGreaterThan(0);
    expect(t.service.canMobAttack(defendersOf(t)[0]!.entityId, "griefer")).toBe(true);
    expect((await t.service.shopFor(player("griefer"), "a", h.hutId)).tradeBannedUntil).toBeNull();
  });

  it("fires the four waves once each, in order of strength, and re-arms only after repair", async () => {
    const t = setup();
    const h = await hut(t);
    const strength = (index: number) => hollinWaveComposition(index, 1)
      .reduce((sum, kind) => sum + (kind === "elder" ? 5 : kind === "brute" ? 3 : 1), 0);
    const strengths = [0, 1, 2, 3].map(strength);
    expect(strengths).toEqual([...strengths].sort((x, y) => x - y));
    expect(new Set(strengths).size).toBe(4);
    hit(t, h.hutId, "a", 100, 9_900);
    await flush();
    expect(defendersOf(t)).toHaveLength(4);
    expect(kindsOf(t, "hollin_brute")).toHaveLength(0);
    hit(t, h.hutId, "a", 100, 9_800); // above 7,500: no new wave
    await flush();
    expect(defendersOf(t)).toHaveLength(4);
    hit(t, h.hutId, "a", 2_000, 7_500);
    await flush();
    expect(kindsOf(t, "hollin_brute")).toHaveLength(1);
    hit(t, h.hutId, "a", 100, 7_400); // same threshold again: fires once only
    await flush();
    expect(kindsOf(t, "hollin_brute")).toHaveLength(1);
    hit(t, h.hutId, "a", 2_500, 5_000);
    await flush();
    expect(kindsOf(t, "hollin_elder")).toHaveLength(1);
    hit(t, h.hutId, "a", 2_500, 2_500);
    await flush();
    expect(kindsOf(t, "hollin_elder")).toHaveLength(3);
    expect(kindsOf(t, "hollin_brute")).toHaveLength(6);
    expect(defendersOf(t).length).toBeLessThanOrEqual(HOLLIN_MAX_DEFENDERS);
    // Repair above 2,500 re-arms that threshold (and only it).
    const body = t.mobs.get(hollinHutEntityId(h.hutId, 0))!;
    body.currentHealth = 6_000;
    await t.advance(1_000);
    for (const defender of defendersOf(t)) defender.lifeState = "dead";
    hit(t, h.hutId, "a", 3_500, 2_500);
    await flush();
    expect(kindsOf(t, "hollin_elder").length).toBeGreaterThan(3);
  });

  it("bounds live defenders, sizes waves to the attackers and lists elites first", async () => {
    const t = setup();
    const h = await hut(t);
    for (const id of ["a", "b", "c", "d", "e", "f"]) hit(t, h.hutId, id, 100, 9_900);
    await flush();
    expect(hollinWaveComposition(1, 6)).toHaveLength(HOLLIN_RAID_WAVES[1]!.guard + 4 + HOLLIN_RAID_WAVES[1]!.brute);
    hit(t, h.hutId, "a", 2_400, 7_500);
    await flush();
    expect(defendersOf(t)).toHaveLength(HOLLIN_RAID_WAVES[0]!.guard + HOLLIN_RAID_WAVES[1]!.guard + 4 + 1);
    hit(t, h.hutId, "a", 2_500, 5_000);
    hit(t, h.hutId, "a", 2_500, 2_500);
    await flush();
    // The cap holds even with six attackers, and the final waves keep all their elites by
    // sending plain guards home.
    expect(defendersOf(t).length).toBeLessThanOrEqual(HOLLIN_MAX_DEFENDERS);
    expect(kindsOf(t, "hollin_elder")).toHaveLength(3);
    expect(kindsOf(t, "hollin_brute")).toHaveLength(6);
    expect(hollinWaveComposition(3, 1).slice(0, 2)).toEqual(["elder", "elder"]);
  });

  it("lets Elders heal wounded defenders", async () => {
    const t = setup();
    const h = await hut(t);
    hit(t, h.hutId, "a", 100, 9_900);
    hit(t, h.hutId, "a", 7_500, 2_000);
    await flush();
    const guard = kindsOf(t, "hollin_guard")[0]!;
    guard.currentHealth = 10;
    await t.advance(1_000);
    expect(guard.currentHealth).toBeGreaterThan(10);
  });

  it("bans a player 12 hours for landing a hit on any Hollin and never shortens a longer ban", async () => {
    const t = setup();
    const h = await hut(t);
    hit(t, h.hutId, "a", 100, 9_900);
    await flush();
    const guard = kindsOf(t, "hollin_guard")[0]!;
    hitHollin(t, guard.entityId, "a");
    await flush();
    const standing = await t.store.getStanding(h.hutId, "a");
    expect(standing.tradeBannedUntil!.getTime() - t.now()).toBe(HOLLIN_HIT_TRADE_BAN_MS);
    expect((await t.store.getStanding(h.hutId, "bystander")).tradeBannedUntil).toBeNull();
    hitHollin(t, `mob:hollin-farmer:${h.hutId}:0:0`, "b");
    await flush();
    expect((await t.store.getStanding(h.hutId, "b")).tradeBannedUntil!.getTime() - t.now()).toBe(HOLLIN_HIT_TRADE_BAN_MS);
    // A 24h ban from breaking the hut is not cut back by a later 12h hit ban.
    await t.service.onHutDefeated(hollinHutEntityId(h.hutId, 0));
    const broken = (await t.store.getStanding(h.hutId, "a")).tradeBannedUntil!.getTime();
    expect(broken - t.now()).toBe(HOLLIN_RAID_TRADE_BAN_MS);
    await t.advance(HOLLIN_HUT_RESPAWN_MS + 1_000);
    hitHollin(t, `mob:hollin-farmer:${h.hutId}:1:0`, "a");
    await flush();
    expect((await t.store.getStanding(h.hutId, "a")).tradeBannedUntil!.getTime()).toBe(broken);
  });

  it("on break: 24h ban and a 24h on-sight grudge for every damage contributor only", async () => {
    const t = setup();
    const h = await hut(t);
    const h2 = await t.service.spawnHut({ creatorPlayerId: "dev", requestId: "r2", regionCode: "r", zoneId: "z", position: { lat: 35.02, lon: -106 } });
    hit(t, h.hutId, "alice", 3_000, 7_000);
    hit(t, h.hutId, "bob", 10, 6_990);
    await flush();
    await t.service.onHutDefeated(hollinHutEntityId(h.hutId, 0));
    for (const id of ["alice", "bob"]) {
      const standing = await t.store.getStanding(h.hutId, id);
      expect(standing.tradeBannedUntil!.getTime() - t.now()).toBe(HOLLIN_RAID_TRADE_BAN_MS);
      expect(standing.grudgeUntil!.getTime() - t.now()).toBe(HOLLIN_GRUDGE_MS);
    }
    const mate = await t.store.getStanding(h.hutId, "partymate");
    expect(mate.tradeBannedUntil).toBeNull();
    expect(mate.grudgeUntil).toBeNull();
    // On sight at ANOTHER hut: the grudge-bearer is attacked, a party member beside them is not.
    t.online.push({ playerId: "alice", position: { lat: 35.02, lon: -106 } }, { playerId: "partymate", position: { lat: 35.02, lon: -106 } });
    await t.advance(3_000);
    await flush();
    await t.advance(3_000);
    const defenders = defendersOf(t).filter((m) => m.entityId.includes(h2.hutId));
    expect(defenders.length).toBeGreaterThan(0);
    expect(defenders.every((m) => m.targetEntityId !== "partymate")).toBe(true);
    expect(defenders.some((m) => m.targetEntityId === "alice")).toBe(true);
    expect(t.service.canMobAttack(defenders[0]!.entityId, "alice")).toBe(true);
    expect(t.service.canMobAttack(defenders[0]!.entityId, "partymate")).toBe(false);
  });

  it("grants food-heavy loot once per contributor on break", async () => {
    const t = setup();
    const h = await hut(t);
    hit(t, h.hutId, "alice", 500, 9_500);
    await flush();
    await t.service.onHutDefeated(hollinHutEntityId(h.hutId, 0));
    const grants = (t.inventory.grantItemsForOperationInTransaction.mock.calls as unknown as [unknown, { operationKey: string; grants: { itemId: string }[] }][])
      .filter(([, input]) => input.operationKey.startsWith("hollin-raid-loot:"));
    expect(grants).toHaveLength(1);
    expect(grants[0]![1].grants.length).toBeGreaterThanOrEqual(1);
  });

  it("tree chops near a hut anger its Hollins at that player only, with the short ban; Hollin Lore 2 is exempt", async () => {
    const t = setup();
    const h = await hut(t);
    await t.advance(1_000); // index the standing hut
    const near = { lat: POS.lat + 0.0005, lon: POS.lon };
    expect(await t.service.onTreeChopStart("chopper", { lat: POS.lat + 0.05, lon: POS.lon }, "tree:far")).toBe(false);
    expect(await t.service.onTreeChopStart("chopper", near, "tree:wild")).toBe(true);
    const standing = await t.store.getStanding(h.hutId, "chopper");
    expect(standing.tradeBannedUntil!.getTime() - t.now()).toBe(HOLLIN_ORCHARD_TRADE_BAN_MS);
    expect(defendersOf(t).some((m) => m.targetEntityId === "chopper")).toBe(true);
    expect((await t.store.getStanding(h.hutId, "other")).tradeBannedUntil).toBeNull();
    t.ranks.set("sage", 2);
    expect(await t.service.onTreeChopStart("sage", near, "tree:wild")).toBe(false);
    expect((await t.store.getStanding(h.hutId, "sage")).tradeBannedUntil).toBeNull();
  });

  it("repairs after a minute without attacks and stands the defenders down", async () => {
    const t = setup();
    const h = await hut(t);
    const body = t.mobs.get(hollinHutEntityId(h.hutId, 0))!;
    hit(t, h.hutId, "a");
    await flush();
    body.currentHealth = 2_000;
    await t.advance(HOLLIN_HUT_REPAIR_DELAY_MS - 1_000);
    expect(body.currentHealth).toBe(2_000);
    await t.advance(2_000);
    expect(body.currentHealth).toBeGreaterThan(2_000);
    for (let i = 0; i < 12; i += 1) await t.advance(1_000);
    expect(body.currentHealth).toBe(HOLLIN_HUT_MAX_HP);
    await t.advance(5 * 60_000);
    expect(guardsOf(t)).toHaveLength(0);
  });

  it("is destroyed, stops the defenders, and respawns as a new body after a while", async () => {
    const t = setup();
    const h = await hut(t);
    hit(t, h.hutId, "a", 500, 9_500);
    await flush();
    await t.service.onHutDefeated(hollinHutEntityId(h.hutId, 0));
    expect((await t.store.getHut(h.hutId))!.state).toBe("destroyed");
    expect(guardsOf(t)).toHaveLength(0);
    await expect(t.service.shopFor(player("p"), "a", h.hutId)).rejects.toMatchObject({ code: "HOLLIN_HUT_DESTROYED" });
    await t.advance(HOLLIN_HUT_RESPAWN_MS - 1_000);
    expect((await t.store.getHut(h.hutId))!.state).toBe("destroyed");
    await t.advance(2_000);
    const revived = (await t.store.getHut(h.hutId))!;
    expect(revived.state).toBe("standing");
    expect(revived.life).toBe(1);
    expect(t.mobs.get(hollinHutEntityId(h.hutId, 1))?.currentHealth).toBe(HOLLIN_HUT_MAX_HP);
    expect((await t.service.shopFor(player("p"), "a", h.hutId)).tradeBannedUntil).toBeNull();
    expect((await t.service.shopFor(player("a"), "a", h.hutId)).tradeBannedUntil).not.toBeNull();
  });
});

describe("berry pacify (Hollin Lore rank 3)", () => {
  it("lifts the ban and anger at that hut only, spending one berry", async () => {
    const t = setup(3);
    const h1 = await hut(t);
    const h2 = await t.service.spawnHut({ creatorPlayerId: "dev", requestId: "r2", regionCode: "r", zoneId: "z", position: POS });
    hit(t, h1.hutId, "lore", 100, 9_900);
    hit(t, h2.hutId, "lore", 100, 9_900);
    await flush();
    hitHollin(t, `mob:hollin-farmer:${h1.hutId}:0:0`, "lore");
    hitHollin(t, `mob:hollin-farmer:${h2.hutId}:0:0`, "lore");
    await flush();
    const result = await t.service.pacify(player("lore"), "a", { requestId: "q", hutId: h1.hutId });
    expect(result.snapshot.tradeBannedUntil).toBeNull();
    expect(t.inventory.debitItemsForOperationInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      debits: [{ itemId: "giving_berry", variant: null, quantity: 1 }]
    }));
    const first = guardsOf(t).filter((m) => m.entityId.includes(h1.hutId));
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((g) => g.targetEntityId === null)).toBe(true);
    expect(t.service.canMobAttack(first[0]!.entityId, "lore")).toBe(false);
    expect((await t.store.getStanding(h2.hutId, "lore")).tradeBannedUntil).not.toBeNull();
  });

  it("also clears the on-sight grudge, so the Hollins stop attacking that player", async () => {
    const t = setup(3);
    const h = await hut(t);
    await t.store.setStanding(h.hutId, "lore", {
      tradeBannedUntil: new Date(t.now() + 1e7), banReason: "raid", angryUntil: null, grudgeUntil: new Date(t.now() + 1e7)
    });
    t.online.push({ playerId: "lore", position: POS });
    await t.advance(3_000);
    await flush();
    expect(defendersOf(t).some((m) => m.targetEntityId === "lore")).toBe(true);
    await t.service.pacify(player("lore"), "a", { requestId: "q", hutId: h.hutId });
    expect(await t.store.getGrudgeUntil("lore")).toBeNull();
    expect(defendersOf(t).every((m) => m.targetEntityId !== "lore")).toBe(true);
    expect(t.service.canMobAttack(defendersOf(t)[0]!.entityId, "lore")).toBe(false);
    for (let i = 0; i < 3; i += 1) await t.advance(3_000);
    expect(defendersOf(t).every((m) => m.targetEntityId !== "lore")).toBe(true);
  });

  it("requires rank 3 and an angry hut", async () => {
    const t = setup(2);
    const h = await hut(t);
    hit(t, h.hutId, "lore");
    await flush();
    await expect(t.service.pacify(player("lore"), "a", { requestId: "q", hutId: h.hutId })).rejects.toMatchObject({ code: "HOLLIN_LORE_REQUIRED" });
    t.ranks.set("lore", 3); t.ranks.set("calm", 3);
    await expect(t.service.pacify(player("calm"), "a", { requestId: "q2", hutId: h.hutId })).rejects.toMatchObject({ code: "HOLLIN_NOT_ANGRY" });
  });
});
