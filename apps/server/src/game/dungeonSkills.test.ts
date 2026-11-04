import { describe, expect, it, vi } from "vitest";
import {
  DEEPSTONE_DOUBLE_YIELD_CHANCE,
  DUNGEON_CATALOG,
  GROVE_DOUBLE_YIELD_CHANCE,
  WORLD_KNOWLEDGE_OVERWORLD_PARTS,
  WORLD_KNOWLEDGE_SKILL_DEFINITIONS,
  BASIC_ATTACK_INTERVAL_MS,
  groveAuraRadiusM,
  harvestDoubleYieldChance
} from "@ash-atlas/shared";

import { createDungeonHandler, type DungeonHandlerContext } from "../realtime/handlers/dungeonHandler.js";
import { DungeonSkillAuraRuntime } from "./dungeonSkillAura.js";
import { DungeonSkillService } from "./dungeonSkills.js";
import { SkillRequestError } from "./skills/skillAuthority.js";

function pool(ranks: Record<string, number> = {}) {
  return {
    query: vi.fn(async () => ({ rows: Object.entries(ranks).map(([skill_id, rank]) => ({ skill_id, rank })), rowCount: 0 }))
  } as never;
}

/** `have` of each dungeon token; `affordable` also stocks every overworld part. */
function inventory(have: number, affordable: boolean, extra: Record<string, number> = {}) {
  const stock: Record<string, number> = { raptor_scale: have, giant_egg: have, elder_acorn: have, wyrm_egg: have, zephyr: have, ...extra };
  if (affordable) {
    for (const part of Object.values(WORLD_KNOWLEDGE_OVERWORLD_PARTS).flatMap((offering) => offering?.parts ?? [])) {
      if (part.kind === "item") stock[part.itemId] = 99;
    }
  }
  return {
    snapshotInTransaction: vi.fn(async () => ({
      items: Object.entries(stock).map(([resourceType, quantity]) => ({ resourceType, variant: null, quantity, stackId: null }))
    }) as never),
    debitItemsForOperationInTransaction: vi.fn(async () => {
      if (!affordable) throw new Error("Inventory does not contain enough items");
      return { applied: true, inventory: { totals: {} } as never, grants: [] };
    }),
    getInventorySnapshot: vi.fn(async () => ({ totals: { raptor_scale: have, giant_egg: have, elder_acorn: have, wyrm_egg: have, zephyr: have } }) as never)
  };
}

/** A SkillService stand-in that runs the charge like the real transaction would. */
function skillsAuthority(options: { alreadyDiscovered?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    authority: {
      discoverWorldKnowledge: vi.fn(async (_playerId: string, skillId: string, _requestId: string, charge?: (client: never) => Promise<void>) => {
        if (options.alreadyDiscovered) throw new SkillRequestError("SKILL_WORLD_ALREADY_REVEALED", "already");
        if (charge) await charge({ query: async () => ({ rows: [], rowCount: 0 }) } as never);
        calls.push(skillId);
        return { requestId: "r", replayed: false, snapshot: { revision: 7 } as never };
      })
    }
  };
}

describe("dungeon token turn-in discovers World Knowledge", () => {
  it("refuses with a clear message when the player lacks the tokens, and discovers nothing", async () => {
    const skills = skillsAuthority();
    const service = new DungeonSkillService(pool(), inventory(2, false), skills.authority as never);
    const result = await service.turnIn("p1", "deepstone_lore", "req-1");
    expect(result).toMatchObject({ status: "insufficient", have: 2, need: 6 });
    expect(result.message).toBe("Deepstone Lore needs 6 Raptor Scale (you have 2), 3 Troll Tooth (you have 0), 3 Earthen Core (you have 0), 5 Crude Gem (you have 0).");
    expect(skills.calls).toEqual([]);
  });

  it("consumes the tokens in the discovery transaction and returns the new skill snapshot", async () => {
    const stock = inventory(30, true);
    const skills = skillsAuthority();
    const service = new DungeonSkillService(pool(), stock, skills.authority as never);
    const result = await service.turnIn("p1", "grove_lore", "req-2");
    expect(result).toMatchObject({ status: "discovered", snapshot: { revision: 7 } });
    expect(stock.debitItemsForOperationInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      playerId: "p1", debits: [
        { itemId: "elder_acorn", variant: null, quantity: 28 },
        { itemId: "living_heartwood", variant: null, quantity: 2 },
        { itemId: "dryad_blossom", variant: null, quantity: 5 },
        { itemId: "grave_vine", variant: null, quantity: 10 }
      ]
    }));
    expect(skills.calls).toEqual(["grove_lore"]);
  });

  it("uses Giant Eggs for the temporary Hollin Lore turn-in", async () => {
    const stock = inventory(9, true);
    const service = new DungeonSkillService(pool(), stock, skillsAuthority().authority as never);
    await service.turnIn("p1", "wildkin_lore", "req-3");
    expect(stock.debitItemsForOperationInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      debits: expect.arrayContaining([{ itemId: "giant_egg", variant: null, quantity: 6 }, { itemId: "cached_nuts", variant: null, quantity: 10 }])
    }));
  });

  it("takes 6 Wyrm Eggs plus 3 different trophies (one each) to discover Rare Beast Mastery", async () => {
    const stock = inventory(6, true, { stormwing_talon: 4, chimera_horn: 1, kraken_beak: 2 });
    const skills = skillsAuthority();
    const service = new DungeonSkillService(pool(), stock, skills.authority as never);
    const result = await service.turnIn("p1", "rare_beast_mastery", "req-dragon");
    expect(result.status).toBe("discovered");
    expect(skills.calls).toEqual(["rare_beast_mastery"]);
    expect(stock.debitItemsForOperationInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      debits: [
        { itemId: "wyrm_egg", variant: null, quantity: 6 },
        { itemId: "stormwing_talon", variant: null, quantity: 1 },
        { itemId: "chimera_horn", variant: null, quantity: 1 },
        { itemId: "kraken_beak", variant: null, quantity: 1 }
      ]
    }));
  });

  it("refuses Rare Beast Mastery for three of the same trophy and spends nothing", async () => {
    const stock = inventory(5, true, { stormwing_talon: 3 });
    const skills = skillsAuthority();
    const service = new DungeonSkillService(pool(), stock, skills.authority as never);
    const result = await service.turnIn("p1", "rare_beast_mastery", "req-dragon-same");
    expect(result).toMatchObject({ status: "insufficient", message: expect.stringContaining("3 different trophies (you have 1)") });
    expect(stock.debitItemsForOperationInTransaction).not.toHaveBeenCalled();
  });

  it("does not charge again when the skill is already discovered", async () => {
    const stock = inventory(9, true);
    const service = new DungeonSkillService(pool(), stock, skillsAuthority({ alreadyDiscovered: true }).authority as never);
    const result = await service.turnIn("p1", "deepstone_lore", "req-4");
    expect(result).toMatchObject({ status: "already_discovered", message: "You have already discovered Deepstone Lore." });
    expect(stock.debitItemsForOperationInTransaction).not.toHaveBeenCalled();
  });
});

describe("Zephyr Altar discovers Perfect Strike", () => {
  it("makes the 6 Zephyr discovery offering in one transaction, and refuses without charging when short", async () => {
    const discoverGeneralSkill = vi.fn(async (_playerId: string, _skillId: string, _requestId: string, charge?: (client: never) => Promise<void>) => {
      if (charge) await charge({ query: async () => ({ rows: [], rowCount: 0 }) } as never);
      return { requestId: "r", replayed: false, snapshot: { revision: 9 } as never };
    });
    const stock = inventory(7, true);
    const service = new DungeonSkillService(pool(), stock, { discoverGeneralSkill } as never);
    const result = await service.turnIn("p1", "perfect_strike", "zephyr-1");
    expect(result).toMatchObject({ status: "discovered", message: "You offered 6 Zephyr and discovered Perfect Strike! Spend Skill Points to learn it." });
    expect(discoverGeneralSkill).toHaveBeenCalledWith("p1", "perfect_strike", "zephyr-1", expect.any(Function));
    expect(stock.debitItemsForOperationInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      operationKey: "skill-offering:p1:perfect_strike", playerId: "p1", debits: [{ itemId: "zephyr", variant: null, quantity: 6 }]
    }));

    const short = new DungeonSkillService(pool(), inventory(2, false), { discoverGeneralSkill } as never);
    await expect(short.turnIn("p1", "perfect_strike", "zephyr-2")).resolves.toMatchObject({ status: "insufficient", need: 6 });
  });

  it("puts the altar in the Monastery's Mountain Gate", () => {
    const gate = DUNGEON_CATALOG.dungeons.find((dungeon) => dungeon.id === "still_hand_monastery")!
      .rooms.find((room) => room.id === "mountain_gate")!;
    expect(gate.objects.find((object) => object.id === "zephyr-altar")).toMatchObject({ skillTurnIn: "perfect_strike", type: "shrine" });
  });
});

describe("World Knowledge definitions", () => {
  it("map to the World Knowledge skills with three ranks of 1 Skill Point each", () => {
    expect(WORLD_KNOWLEDGE_SKILL_DEFINITIONS.deepstone_lore).toMatchObject({ displayName: "Deepstone Lore", status: "implemented" });
    expect(WORLD_KNOWLEDGE_SKILL_DEFINITIONS.wildkin_lore).toMatchObject({ displayName: "Hollin Lore", status: "implemented" });
    expect(WORLD_KNOWLEDGE_SKILL_DEFINITIONS.grove_lore).toMatchObject({ displayName: "Grove Lore", status: "implemented" });
    for (const id of ["deepstone_lore", "wildkin_lore", "grove_lore"] as const) {
      expect(WORLD_KNOWLEDGE_SKILL_DEFINITIONS[id].ranks.map((r) => r.cost)).toEqual([1, 1, 1]);
    }
    // Huts, orchards, berries and the helper minion are all implemented.
    expect(WORLD_KNOWLEDGE_SKILL_DEFINITIONS.wildkin_lore.ranks.map((rank) => (rank.pending?.length ?? 0) > 0)).toEqual([false, false, false]);
  });
});

describe("rank effects", () => {
  it("scales Deepstone Lore double-yield 12% / 22% / 28% on mined resources only", () => {
    expect(DEEPSTONE_DOUBLE_YIELD_CHANCE).toEqual([0, 0.12, 0.22, 0.28]);
    for (const [rank, chance] of [[1, 0.12], [2, 0.22], [3, 0.28]] as const) {
      for (const resource of ["stone", "ore", "sulfur", "coal", "iron"]) {
        expect(harvestDoubleYieldChance({ deepstone_lore: rank }, resource)).toBe(chance);
      }
      expect(harvestDoubleYieldChance({ deepstone_lore: rank }, "wood")).toBe(0);
    }
    expect(harvestDoubleYieldChance({}, "stone")).toBe(0);
  });

  it("scales Grove Lore double-yield 6% / 11% / 17% on wood and plants", () => {
    expect(GROVE_DOUBLE_YIELD_CHANCE).toEqual([0, 0.06, 0.11, 0.17]);
    for (const [rank, chance] of [[1, 0.06], [2, 0.11], [3, 0.17]] as const) {
      expect(harvestDoubleYieldChance({ grove_lore: rank }, "wood")).toBe(chance);
      expect(harvestDoubleYieldChance({ grove_lore: rank }, "flax_fiber")).toBe(chance);
      expect(harvestDoubleYieldChance({ grove_lore: rank }, "stone")).toBe(0);
    }
  });

  it("rolls the double yield from the cached rank, and the rare find only at Deepstone rank 3", async () => {
    const rank2 = new DungeonSkillService(pool({ deepstone_lore: 2 }), inventory(0, true), skillsAuthority().authority as never, () => 0.15);
    expect(await rank2.rollHarvestBonus("p1", "stone")).toEqual({ extraUnit: true, rareItemId: null });
    const rank2Miss = new DungeonSkillService(pool({ deepstone_lore: 2 }), inventory(0, true), skillsAuthority().authority as never, () => 0.25);
    expect((await rank2Miss.rollHarvestBonus("p1", "stone")).extraUnit).toBe(false);
    const rank3 = new DungeonSkillService(pool({ deepstone_lore: 3 }), inventory(0, true), skillsAuthority().authority as never, () => 0.005);
    expect(await rank3.rollHarvestBonus("p1", "ore")).toEqual({ extraUnit: true, rareItemId: "lichen" });
    const rank3Unlucky = new DungeonSkillService(pool({ deepstone_lore: 3 }), inventory(0, true), skillsAuthority().authority as never, () => 0.02);
    expect((await rank3Unlucky.rollHarvestBonus("p1", "ore")).rareItemId).toBeNull();
    const none = new DungeonSkillService(pool(), inventory(0, true), skillsAuthority().authority as never, () => 0);
    expect(await none.rollHarvestBonus("p1", "food")).toEqual({ extraUnit: false, rareItemId: null });
  });

  it("scales the Grove Lore aura 165 / 240 / 380 m, with the Grove giving rank 1 temporarily", () => {
    expect([0, 1, 2, 3].map((rank) => groveAuraRadiusM(rank, false))).toEqual([0, 165, 240, 380]);
    expect(groveAuraRadiusM(0, true)).toBe(165);
    expect(groveAuraRadiusM(2, true)).toBe(240);
  });
});

describe("Grove Lore aura and the Healing Spring", () => {
  type Entity = { lat: number; lon: number; maxHealth: number; currentHealth: number; lifeState: string };
  function world(options: {
    ranks?: Record<string, number>;
    grove?: string[];
    inCombat?: string[];
    spring?: string[];
    party?: string[];
    entities: Record<string, Partial<Entity>>;
  }) {
    const entities = Object.fromEntries(Object.entries(options.entities).map(([id, e]) => [id,
      { lat: 35, lon: -106, maxHealth: 1_000, currentHealth: 500, lifeState: "alive", ...e }])) as Record<string, Entity>;
    const healed: Array<[string, number]> = [];
    let clock = 10_000;
    const runtime = new DungeonSkillAuraRuntime({
      activePlayerIds: () => Object.keys(entities),
      skills: { ensureLoaded: async () => undefined, rankOf: (id) => options.ranks?.[id] ?? 0 },
      combat: {
        entity: (id) => entities[id] ?? null,
        healEntity: (id, amount) => { healed.push([id, amount]); return amount; },
        isInCombat: (id) => options.inCombat?.includes(id) ?? false
      },
      dungeon: {
        dungeonIdFor: (id) => options.grove?.includes(id) ? "blightwood_grove" : null,
        isInHealZone: (id) => options.spring?.includes(id) ?? false
      },
      partyMemberIds: () => options.party ?? [],
      now: () => clock
    });
    return { runtime, healed, advance: (ms: number) => { clock += ms; } };
  }

  // ~0.0005 degrees of latitude is about 55 m; 0.0018 is about 200 m; 0.0030 is about 330 m.
  const party = { a: {}, near: { lat: 35.0005 }, mid: { lat: 35.0018 }, far: { lat: 35.0030 } };

  it("scales the radius with rank: 165 m, 240 m, 380 m", () => {
    const heard = (rank: number) => {
      const { runtime, healed } = world({ ranks: { a: rank }, party: ["a", "near", "mid", "far"], entities: party });
      runtime.tick();
      return healed.map(([id]) => id).sort();
    };
    expect(heard(1)).toEqual(["a", "near"]);
    expect(heard(2)).toEqual(["a", "mid", "near"].sort());
    expect(heard(3)).toEqual(["a", "far", "mid", "near"].sort());
  });

  it("does not heal anyone in combat and needs the skill", () => {
    const fighting = world({ ranks: { a: 1 }, inCombat: ["a"], entities: { a: {} } });
    fighting.runtime.tick();
    expect(fighting.healed).toEqual([]);
    const none = world({ entities: { a: {} } });
    none.runtime.tick();
    expect(none.healed).toEqual([]);
  });

  it("gives everyone inside Blightwood Grove the rank 1 aura without the skill", () => {
    const { runtime, healed } = world({ grove: ["a", "b"], entities: { a: {}, b: {} } });
    runtime.tick();
    expect(healed.map(([id]) => id).sort()).toEqual(["a", "b"]);
  });

  it("heals 2.3% of max health per beat while standing in the Healing Spring, even without the skill", () => {
    const { runtime, healed, advance } = world({ spring: ["a"], entities: { a: {}, b: {} } });
    runtime.tick();
    expect(healed).toEqual([["a", 23]]);
    runtime.tick();
    expect(healed).toHaveLength(1);
    advance(BASIC_ATTACK_INTERVAL_MS);
    runtime.tick();
    expect(healed).toHaveLength(2);
  });

  it("carries the fraction of a per-beat heal so healing per second holds on small health pools", () => {
    const { runtime, healed, advance } = world({ ranks: { a: 1 }, entities: { a: { maxHealth: 100, currentHealth: 10 } } });
    for (let beat = 0; beat < 10; beat += 1) {
      runtime.tick();
      advance(BASIC_ATTACK_INTERVAL_MS);
    }
    // 0.8% of 100 HP per beat: ten beats heal exactly 8 in total (never one point per beat).
    expect(healed.reduce((total, [, amount]) => total + amount, 0)).toBe(8);
  });
});

describe("turn-in objects and the interaction handler", () => {
  it("places the Scale Shrine, Giant Egg nest and Grove Hermit as turn-ins for the World Knowledge skills, plus the Healing Spring", () => {
    const find = (dungeonId: string, roomId: string) =>
      DUNGEON_CATALOG.dungeons.find((d) => d.id === dungeonId)!.rooms.find((r) => r.id === roomId)!;
    expect(find("fangrock_cavern", "chieftain_throne").objects.find((o) => o.id === "scale-shrine")?.skillTurnIn).toBe("deepstone_lore");
    expect(find("the_eyrie", "nest_crown").objects.find((o) => o.id === "egg-nest")?.skillTurnIn).toBe("wildkin_lore");
    const clearing = find("blightwood_grove", "hermit_clearing");
    expect(clearing.objects.find((o) => o.id === "grove-hermit")).toMatchObject({ skillTurnIn: "grove_lore", prefabId: "grove_hermit" });
    expect(clearing.zones.find((z) => z.id === "healing_spring_zone")?.purpose).toBe("heal");
    const hatchery = find("wyrm_hollow", "hatchery");
    expect(hatchery.objects.find((o) => o.id === "wyrm-nest")).toMatchObject({ skillTurnIn: "rare_beast_mastery", prefabId: "wyrm_hollow_nest" });
    expect(find("wyrm_hollow", "ember_tunnels").zones.filter((z) => z.purpose === "damage")).toHaveLength(5);
  });

  async function interact(result: unknown) {
    const send = vi.fn();
    const turnIn = vi.fn(async () => result);
    const announceToPlayer = vi.fn(() => ({ announced: true }));
    const handler = createDungeonHandler({
      state: { playerId: "p1", connectionId: "c1" },
      registry: { send },
      gameState: {},
      dungeon: { skillTurnInFor: vi.fn(() => "deepstone_lore"), announceToPlayer },
      dungeonSkills: { turnIn }
    } as unknown as DungeonHandlerContext);
    await handler({ type: "DUNGEON_INTERACT", requestId: "r1", sessionId: "s1", objectId: "scale-shrine" } as never);
    return { send, turnIn, announceToPlayer };
  }

  it("shows the discovery message and refreshes the inventory and skill tree on success", async () => {
    const { send, announceToPlayer } = await interact({
      status: "discovered", message: "You discovered Deepstone Lore!", inventory: { totals: {} }, snapshot: { revision: 3 }
    });
    expect(send).toHaveBeenCalledWith("p1", expect.objectContaining({ type: "SKILL_TREE_SNAPSHOT", snapshot: { revision: 3 } }));
    expect(send).toHaveBeenCalledWith("p1", expect.objectContaining({ type: "INVENTORY_STACK_UPDATED", message: "You discovered Deepstone Lore!" }));
    expect(announceToPlayer).toHaveBeenCalledWith("p1", "s1", "You discovered Deepstone Lore!", "success");
  });

  it("shows a clear warning when the player lacks tokens and info when already discovered", async () => {
    const lacking = await interact({ status: "insufficient", message: "Deepstone Lore needs 6 Raptor Scale. You have 2." });
    expect(lacking.announceToPlayer).toHaveBeenCalledWith("p1", "s1", "Deepstone Lore needs 6 Raptor Scale. You have 2.", "warning");
    expect(lacking.send).not.toHaveBeenCalledWith("p1", expect.objectContaining({ type: "INVENTORY_STACK_UPDATED" }));
    const known = await interact({ status: "already_discovered", message: "You have already discovered Deepstone Lore." });
    expect(known.announceToPlayer).toHaveBeenCalledWith("p1", "s1", "You have already discovered Deepstone Lore.", "info");
  });
});
