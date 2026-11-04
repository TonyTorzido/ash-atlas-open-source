import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  emptyInventoryTotals,
  type MobArchetypeKey,
  type ResourceType,
  type XpGrantResult
} from "@ash-atlas/shared";
import type { AppLogger } from "../../logger.js";
import type { ProgressionService, XpGrantInput } from "../progression.js";
import type { CombatDefeatSettlementCandidate } from "./combatEngine.js";
import {
  atlasShrineShardQuantityForOgreRoll,
  CombatRewardSettlementService,
  type CombatSettlementResult,
  calculateCombatRewardShares,
  calculateClassXpShares,
  resolveChanceBasedItemRewards,
  resolveLeatherDouble,
  resolveScavengeBonus,
  scaleChanceItemRewards,
  scaledMobGoldReward,
  rogueHumanoidGoldProc,
  scaledLegacyV2MobXpPool,
  scaledMobXpPool
} from "./rewardSettlement.js";
import {
  MOB_TARGET_BASIC_HIT_COUNTS,
  COMBAT_ITEM_REWARD_POLICY_VERSION,
  combatXpAnchor,
  MOB_DEFINITIONS
} from "./mobDefinitions.js";
import { POPULATION_V2_RUNTIME_MOB_ARCHETYPES } from "../populationV2MobRegistry.js";

const LEGACY_V2_DEER_CHANCE_REWARDS = [
  { itemId: "deer_hide", quantity: 1, probability: 0.5, rollId: "deer_hide_quantity" },
  { itemId: "deer_hide", quantity: 2, probability: 0.3, rollId: "deer_hide_quantity" },
  { itemId: "deer_hide", quantity: 3, probability: 0.2, rollId: "deer_hide_quantity" }
] as const;

describe("combat reward distribution", () => {
  it("doubles leather only at Leatherworking rank 3, on a leather drop, under the current policy, at a 22% chance", () => {
    const roll = (rank: number, unit: number, droppedLeather = true, itemRewardPolicyVersion = 13) =>
      resolveLeatherDouble({ settlementKey: "settlement", rank, droppedLeather, itemRewardPolicyVersion, unit });
    expect(roll(3, 0.219999)).toBe(true);
    expect(roll(3, 0.22)).toBe(false);
    expect(roll(2, 0)).toBe(false);
    expect(roll(0, 0)).toBe(false);
    expect(roll(3, 0, false)).toBe(false);
    expect(roll(3, 0, true, 12)).toBe(false);
    const keyed = (key: string) => resolveLeatherDouble({ settlementKey: key, rank: 3, droppedLeather: true, itemRewardPolicyVersion: 13 });
    expect(keyed("same")).toBe(keyed("same"));
    const hits = Array.from({ length: 2000 }, (_, index) => keyed(`settlement-${index}`)).filter(Boolean).length;
    expect(hits / 2000).toBeGreaterThan(0.16);
    expect(hits / 2000).toBeLessThan(0.24);
  });

  it("resolves exact Scavenge thresholds, pools, and boss exclusion", () => {
    const resolve = (
      rank: number,
      procUnit: number,
      poolUnit: number,
      boss = false,
      mobArchetype: MobArchetypeKey = "wolf"
    ) => resolveScavengeBonus({
      settlementKey: "settlement", mobArchetype, rank, procUnit, poolUnit, boss, droppedItem: true
    });
    expect(resolve(0, 0, 0)).toBeNull();
    expect(resolve(1, 0.039999, 0)).toEqual({ itemId: "wood", quantity: 1 });
    expect(resolve(1, 0.04, 0)).toBeNull();
    expect(resolve(1, 0, 0.999999)).toEqual({ itemId: "balsam_resin", quantity: 1 });
    expect(resolveScavengeBonus({
      settlementKey: "settlement", mobArchetype: "wolf", rank: 3, procUnit: 0, poolUnit: 0, boss: false, droppedItem: false
    })).toBeNull();
    expect(resolveScavengeBonus({
      settlementKey: "settlement", mobArchetype: "wolf", rank: 1,
      procUnit: 0, poolUnit: 0.999999, boss: false, droppedItem: true, itemRewardPolicyVersion: 4
    })).toEqual({ itemId: "raw_meat", quantity: 1 });
    // V11 and older settlements keep rolling on every kill and keep the earlier pool.
    expect(resolveScavengeBonus({
      settlementKey: "settlement", mobArchetype: "wolf", rank: 1,
      procUnit: 0, poolUnit: 0.999999, boss: false, droppedItem: false, itemRewardPolicyVersion: 11
    })).toEqual({ itemId: "wild_meat", quantity: 1 });
    expect(resolveScavengeBonus({
      settlementKey: "settlement", mobArchetype: "wolf", rank: 3,
      procUnit: 0, poolUnit: 0.8, boss: false, droppedItem: true, itemRewardPolicyVersion: 11
    })).toEqual({ itemId: "stone", quantity: 1 });
    expect(resolve(2, 0.089999, 0.999999)).toEqual({ itemId: "iron", quantity: 1 });
    expect(resolve(2, 0.09, 0)).toBeNull();
    expect(resolve(3, 0.139999, 0.999999)).toEqual({ itemId: "stone", quantity: 1 });
    expect(resolve(3, 0, 0.8)).toEqual({ itemId: "sulfur", quantity: 1 });
    expect(resolve(3, 0.15, 0)).toBeNull();
    expect(resolve(3, 0, 0, true)).toBeNull();
    expect(resolve(3, 0, 0, false, "training_dummy")).toBeNull();
  });

  it.each([[1, 2], [2, 4], [3, 6], [5, 10], [8, 16], [12, 24], [20, 40]])(
    "awards %i-hit PvE work as %i Warrior XP without mob-level scaling",
    (hitCount, expected) => {
      const shares = calculateClassXpShares(hitCount * 2, [{ entityId: "warrior", damage: 100 }]);
      expect(shares.get("warrior")).toBe(expected);
    }
  );

  it("apportions Warrior XP deterministically without minimum-one inflation", () => {
    expect([...calculateClassXpShares(6, [
      { entityId: "a", damage: 50 }, { entityId: "b", damage: 50 }
    ])]).toEqual([["a", 3], ["b", 3]]);
    expect([...calculateClassXpShares(2, [
      { entityId: "a", damage: 999 }, { entityId: "b", damage: 1 }
    ])]).toEqual([["a", 2], ["b", 0]]);
  });
  it.each([0, 5, 6, 10, 11, 15, 16, 20, 21, 25])(
    "scales level %i V2 gold by 1.02^level with deterministic integer rounding",
    (mobLevel) => {
      const input = {
        baseGold: 7,
        mobLevel,
        settlementKey: `gold-boundary-${mobLevel}`
      };
      const exact = input.baseGold * (1.02 ** mobLevel);
      const rounded = scaledMobGoldReward(input);

      expect([Math.floor(exact), Math.ceil(exact)]).toContain(rounded);
      expect(scaledMobGoldReward(input)).toBe(rounded);
    }
  );

  it("uses unbiased deterministic gold rounding across immutable settlement identities", () => {
    const baseGold = 3;
    const mobLevel = 25;
    const sampleSize = 4_096;
    const average = Array.from({ length: sampleSize }, (_, index) =>
      scaledMobGoldReward({
        baseGold,
        mobLevel,
        settlementKey: `unbiased-gold-${index}`
      })
    ).reduce((sum, reward) => sum + reward, 0) / sampleSize;

    expect(average).toBeCloseTo(baseGold * (1.02 ** mobLevel), 1);
    expect(scaledMobGoldReward({
      baseGold: 0,
      mobLevel,
      settlementKey: "zero-gold"
    })).toBe(0);
  });

  it.each([0, 1, 5, 10, 20, 25])(
    "scales level %i V3 XP by 1.02^level with deterministic integer rounding",
    (mobLevel) => {
      const input = {
        baseXpPool: 75,
        mobLevel,
        settlementKey: `xp-boundary-${mobLevel}`
      };
      const exact = input.baseXpPool * (1.02 ** mobLevel);
      const rounded = scaledMobXpPool(input);
      expect([Math.floor(exact), Math.ceil(exact)]).toContain(rounded);
      expect(scaledMobXpPool(input)).toBe(rounded);
    }
  );

  it("uses unbiased deterministic XP rounding across immutable settlement identities", () => {
    const baseXpPool = 15;
    const mobLevel = 25;
    const sampleSize = 4_096;
    const average = Array.from({ length: sampleSize }, (_, index) =>
      scaledMobXpPool({
        baseXpPool,
        mobLevel,
        settlementKey: `unbiased-xp-${index}`
      })
    ).reduce((sum, reward) => sum + reward, 0) / sampleSize;
    expect(average).toBeCloseTo(baseXpPool * (1.02 ** mobLevel), 1);
    expect(scaledMobXpPool({
      baseXpPool: 0,
      mobLevel,
      settlementKey: "zero-xp"
    })).toBe(0);
  });

  it("keeps the V2 XP formula available only for historical candidates", () => {
    const input = { baseXpPool: 75, mobLevel: 5, settlementKey: "legacy-v2" };
    const exact = input.baseXpPool * (1.05 ** input.mobLevel);
    expect([Math.floor(exact), Math.ceil(exact)])
      .toContain(scaledLegacyV2MobXpPool(input));
    expect(scaledLegacyV2MobXpPool(input)).toBe(scaledLegacyV2MobXpPool(input));
  });

  it("uses hit-count anchors for the V3 baseline and keeps the dummy at zero", () => {
    expect(combatXpAnchor("frog").baseXpPool).toBe(12);
    expect(combatXpAnchor("wolf").baseXpPool).toBe(36);
    // Ogre health is 4 hits, but its XP anchor keeps the historical 20 hits.
    expect(combatXpAnchor("ogre")).toMatchObject({ targetBasicHitCount: 20, baseXpPool: 240 });
    expect(MOB_TARGET_BASIC_HIT_COUNTS.ogre).toBe(4);
    expect(combatXpAnchor("training_dummy").baseXpPool).toBe(0);
  });

  it.each([
    [0, 0],
    [0.499999, 0],
    [0.5, 1],
    [0.899999, 1],
    [0.9, 2],
    [0.999999, 2]
  ] as const)("maps ogre shard roll %s to %s shards", (roll, expected) => {
    expect(atlasShrineShardQuantityForOgreRoll(roll)).toBe(expected);
  });

  it("rejects invalid ogre shard random values", () => {
    expect(() => atlasShrineShardQuantityForOgreRoll(-0.01)).toThrow();
    expect(() => atlasShrineShardQuantityForOgreRoll(1)).toThrow();
  });

  it("resolves independent Resin Crawler item thresholds exactly", () => {
    const rewards = MOB_DEFINITIONS.sap_crawler.rewards.chanceItems;
    const resolve = (resin: number, wood: number) =>
      resolveChanceBasedItemRewards({
        settlementKey: "sap-crawler:settlement",
        mobArchetype: "sap_crawler",
        mobBalanceVersion: MOB_DEFINITIONS.sap_crawler.balanceVersion,
        rewards,
        unitForRoll: (reward) => reward.rollId === "resin" ? resin : wood
      });
    expect(resolve(0.499999, 0.1)).toEqual([
      { itemId: "balsam_resin", quantity: 1 }
    ]);
    expect(resolve(0.5, 0.099999)).toEqual([
      { itemId: "wood", quantity: 1 }
    ]);
    expect(resolve(0, 0)).toEqual([
      { itemId: "balsam_resin", quantity: 1 },
      { itemId: "wood", quantity: 1 },
      { itemId: "crawler_flesh", quantity: 1 }
    ]);
    expect(resolve(0.5, 0.1)).toEqual([]);
  });

  it.each([
    [0, 1],
    [0.499999, 1],
    [0.5, 2],
    [0.799999, 2],
    [0.8, 3],
    [0.999999, 3]
  ] as const)("resolves Deer Leather quantity roll %s to %s", (roll, quantity) => {
    expect(resolveChanceBasedItemRewards({
      settlementKey: "deer:settlement",
      mobArchetype: "deer",
      mobBalanceVersion: MOB_DEFINITIONS.deer.balanceVersion,
      rewards: MOB_DEFINITIONS.deer.rewards.chanceItems.filter(
        (reward) => reward.rollId === "leather_quantity"
      ),
      unitForRoll: () => roll
    })).toEqual([{ itemId: "leather", quantity }]);
  });

  it.each([
    ["deer", "deer_hide"],
    ["wolf", "wolf_pelt"],
    ["hog", "hog_hide"],
    ["bear", "bear_hide"],
    ["alligator", "alligator_hide"]
  ] as const)("resolves the exact %s rare-hide boundary", (mobArchetype, itemId) => {
    const rewards = MOB_DEFINITIONS[mobArchetype].rewards.chanceItems.filter(
      (reward) => reward.rollId === "rare_hide"
    );
    const resolve = (roll: number) => resolveChanceBasedItemRewards({
      settlementKey: `${mobArchetype}:rare-hide-boundary`,
      mobArchetype,
      mobBalanceVersion: MOB_DEFINITIONS[mobArchetype].balanceVersion,
      rewards,
      unitForRoll: () => roll
    });

    expect(resolve(0.000009999999)).toEqual([{ itemId, quantity: 1 }]);
    expect(resolve(0.00001)).toEqual([]);
  });

  it("resolves Deer Leather, Deer Hide, and universal food as independent rolls", () => {
    const resolve = (hideRoll: number) => resolveChanceBasedItemRewards({
      settlementKey: "deer:independent-rolls",
      mobArchetype: "deer",
      mobBalanceVersion: MOB_DEFINITIONS.deer.balanceVersion,
      rewards: MOB_DEFINITIONS.deer.rewards.chanceItems,
      unitForRoll: (reward) => reward.rollId === "leather_quantity"
        ? 0.8
        : reward.rollId === "rare_hide" ? hideRoll : 0
    });

    expect(resolve(0.000009999999)).toEqual([
      { itemId: "leather", quantity: 3 },
      { itemId: "deer_hide", quantity: 1 },
      { itemId: "deer_cut", quantity: 1 },
      { itemId: "antler", quantity: 1 }
    ]);
    expect(resolve(0.00001)).toEqual([
      { itemId: "leather", quantity: 3 },
      { itemId: "deer_cut", quantity: 1 },
      { itemId: "antler", quantity: 1 }
    ]);
  });

  it.each(["coastal_crab", "squid", "jellyfish"] as const)(
    "resolves the exact %s Crude Oil boundary",
    (mobArchetype) => {
      const resolve = (roll: number) => resolveChanceBasedItemRewards({
        settlementKey: `${mobArchetype}:crude-oil-boundary`,
        mobArchetype,
        mobBalanceVersion: MOB_DEFINITIONS[mobArchetype].balanceVersion,
        rewards: MOB_DEFINITIONS[mobArchetype].rewards.chanceItems,
        unitForRoll: (reward) => reward.rollId === "crude_oil" ? roll : 0.999999
      });

      expect(resolve(0.049999999999)).toEqual([{ itemId: "crude_oil", quantity: 1 }]);
      expect(resolve(0.05)).toEqual([]);
    }
  );

  it("resolves the exact Jellyfish Pearl boundary", () => {
    const resolve = (roll: number) => resolveChanceBasedItemRewards({
      settlementKey: "jellyfish:pearl-boundary",
      mobArchetype: "jellyfish",
      mobBalanceVersion: MOB_DEFINITIONS.jellyfish.balanceVersion,
      rewards: MOB_DEFINITIONS.jellyfish.rewards.chanceItems,
      unitForRoll: (reward) => reward.rollId === "pearl" ? roll : 0.999999
    });

    expect(resolve(0.499999999999)).toEqual([{ itemId: "pearl", quantity: 1 }]);
    expect(resolve(0.5)).toEqual([]);
  });

  it("keeps Pearl out of replayed V7 Jellyfish settlements and drops it under live V8", async () => {
    const database = createSettlementDatabase();
    const completed = vi.fn();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger(),
      completed,
      undefined,
      new FakeInventory() as never,
      undefined,
      new FakeWallet() as never
    );
    for (let index = 0; index < 8; index += 1) {
      for (const version of [7, 8] as const) {
        await service.accept({
          ...candidate(100 + index, "jellyfish"),
          settlementKey: `mob:pearl-policy-${version}-${index}:defeat:1`,
          itemRewardPolicyVersion: version,
          lootLocation: { regionCode: "GLOBAL", zoneId: "world:GLOBAL", position: { lat: 40, lon: -105 } }
        });
      }
    }
    await service.flush();

    const pearls = (version: number) => completed.mock.calls
      .map(([entry]) => entry as CombatSettlementResult)
      .filter((entry) => entry.itemRewardPolicyVersion === version)
      .map((entry) => entry.mobReward?.items.some(({ itemId }) => itemId === "pearl") ?? false);
    expect(pearls(7)).toHaveLength(8);
    expect(pearls(7)).not.toContain(true);
    expect(pearls(8)).toHaveLength(8);
    expect(pearls(8)).toContain(true);
  });

  it("pays Brood Silk as a 35% mob drop only in player-built cistern warrens", async () => {
    const database = createSettlementDatabase();
    const completed = vi.fn();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger(),
      completed,
      undefined,
      new FakeInventory() as never,
      undefined,
      new FakeWallet() as never
    );
    const regions = { sewer: "interior:sewer:structure-1", run: "interior:dungeon:entrance-1:run-1" };
    const kills = 200;
    for (const [name, regionCode] of Object.entries(regions)) {
      for (let kill = 0; kill < kills; kill += 1) {
        await service.accept({
          ...candidate(200, "brood_matriarch"),
          settlementKey: `mob:brood-${name}:defeat:${kill}`,
          itemRewardPolicyVersion: COMBAT_ITEM_REWARD_POLICY_VERSION,
          lootLocation: { regionCode, zoneId: `${regionCode}:room`, position: { lat: 40, lon: -105 } }
        });
      }
    }
    await service.flush();

    const silk = (name: string, kill: number) => completed.mock.calls
      .map(([entry]) => entry as CombatSettlementResult)
      .find((entry) => entry.settlementKey === `mob:brood-${name}:defeat:${kill}`)
      ?.mobReward?.items.some(({ itemId }) => itemId === "brood_silk") ?? false;
    const sewerDrops = Array.from({ length: kills }, (_, kill) => silk("sewer", kill));
    const rate = sewerDrops.filter(Boolean).length / kills;
    expect(rate).toBeGreaterThan(0.25);
    expect(rate).toBeLessThan(0.45);
    // Deterministic per settlement key: the same kill always resolves the same way.
    expect(Array.from({ length: kills }, (_, kill) => silk("sewer", kill))).toEqual(sewerDrops);
    expect(Array.from({ length: kills }, (_, kill) => silk("run", kill)).some(Boolean)).toBe(false);
  });

  it("replays V8 Brood Matriarch settlements without the V9 pet egg roll", async () => {
    const { combatItemRewardPolicyForTest } = await import("./rewardSettlement.js");
    const v8 = combatItemRewardPolicyForTest("brood_matriarch", 8);
    const v9 = combatItemRewardPolicyForTest("brood_matriarch", 9);
    expect(v8.chanceItems.map((reward) => reward.itemId)).not.toContain("brood_egg");
    expect(v9.chanceItems.map((reward) => reward.itemId)).toContain("brood_egg");
  });

  it("replays V9 and V10 settlements without the V11 mob value drops or Feather basics", async () => {
    const { combatItemRewardPolicyForTest } = await import("./rewardSettlement.js");
    const ids = (version: number, mob: "wolf" | "skeleton" | "mute_swan") => {
      const policy = combatItemRewardPolicyForTest(mob, version);
      return [...policy.items.map((item) => item.itemId), ...policy.chanceItems.map((reward) => reward.itemId)];
    };
    expect(ids(11, "wolf")).toContain("fang");
    expect(ids(11, "mute_swan")).toEqual(expect.arrayContaining(["feather", "down_feather"]));
    for (const version of [9, 10]) {
      expect(ids(version, "wolf")).not.toContain("fang");
      expect(ids(version, "mute_swan")).not.toContain("feather");
      expect(ids(version, "mute_swan")).not.toContain("down_feather");
      expect(ids(version, "skeleton")).not.toContain("ancient_coin");
    }
    // V10 added the metal material rolls; V9 predates them.
    expect(ids(10, "skeleton")).toContain("umbral_essence");
    expect(ids(9, "skeleton")).not.toContain("umbral_essence");
  });

  it("replays frozen V3 and V4 aquatic policies while V9 remains a separate live policy", async () => {
    const database = createSettlementDatabase();
    const completed = vi.fn();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger(),
      completed,
      undefined,
      new FakeInventory() as never,
      undefined,
      new FakeWallet() as never
    );
    const v3 = {
      ...candidate(4, "jellyfish"),
      settlementKey: "mob:aquatic-policy-4:defeat:1",
      itemRewardPolicyVersion: 3 as const,
      lootLocation: {
        regionCode: "GLOBAL",
        zoneId: "world:GLOBAL",
        position: { lat: 40, lon: -105 }
      }
    };
    const v4 = {
      ...candidate(0, "jellyfish"),
      settlementKey: "mob:aquatic-policy-0:defeat:1",
      itemRewardPolicyVersion: 4 as const,
      lootLocation: {
        regionCode: "GLOBAL",
        zoneId: "world:GLOBAL",
        position: { lat: 40, lon: -105 }
      }
    };
    const v5 = {
      ...candidate(5, "squid"),
      settlementKey: "mob:aquatic-policy-5:defeat:1",
      itemRewardPolicyVersion: 5 as const,
      lootLocation: {
        regionCode: "GLOBAL",
        zoneId: "world:GLOBAL",
        position: { lat: 40, lon: -105 }
      }
    };
    const v6 = {
      ...candidate(6, "squid"),
      settlementKey: "mob:aquatic-policy-6:defeat:1",
      itemRewardPolicyVersion: 6 as const,
      lootLocation: {
        regionCode: "GLOBAL",
        zoneId: "world:GLOBAL",
        position: { lat: 40, lon: -105 }
      }
    };

    await service.accept(v3);
    await service.accept(v4);
    await service.accept(v5);
    await service.accept(v6);
    await service.flush();

    const result = (version: number) => completed.mock.calls
      .map(([entry]) => entry as CombatSettlementResult)
      .find((entry) => entry.itemRewardPolicyVersion === version);
    expect(result(3)?.mobReward?.items).toEqual([
      { itemId: "jellyfish_venom", quantity: 1 },
      { itemId: "crude_oil", quantity: 1 }
    ]);
    expect(result(4)?.mobReward?.items).toEqual([
      { itemId: "jellyfish_venom", quantity: 1 }
    ]);
    expect(result(5)?.mobReward?.items).toEqual(expect.arrayContaining([
      { itemId: "squid_flesh", quantity: 1 }
    ]));
    expect(result(6)?.mobReward?.items.map(({ itemId }) => itemId)).not.toContain("squid_flesh");
    expect(COMBAT_ITEM_REWARD_POLICY_VERSION).toBe(13);
  });

  it("keeps deterministic chance items stable per immutable settlement identity", () => {
    const input = {
      settlementKey: "sap-crawler:entity-1:life-3",
      mobArchetype: "sap_crawler" as const,
      mobBalanceVersion: MOB_DEFINITIONS.sap_crawler.balanceVersion,
      rewards: MOB_DEFINITIONS.sap_crawler.rewards.chanceItems
    };
    expect(resolveChanceBasedItemRewards(input))
      .toEqual(resolveChanceBasedItemRewards(input));
    expect(() => resolveChanceBasedItemRewards({
      ...input,
      unitForRoll: () => 1
    })).toThrow("must be in [0, 1)");
  });

  it("distributes one pool proportionally with deterministic remainder", () => {
    const result = calculateCombatRewardShares(
      140,
      10,
      [
        { entityId: "b", damage: 25 },
        { entityId: "a", damage: 75 },
        { entityId: "zero", damage: 0 }
      ],
      new Map([["a", 10], ["b", 10], ["zero", 10]])
    );
    expect(result.calculatedPool).toBe(154);
    expect(result.shares.map((share) => [share.playerId, share.requestedXp])).toEqual([
      ["a", 116],
      ["b", 38]
    ]);
    expect(result.shares.reduce((sum, share) => sum + share.requestedXp, 0)).toBe(154);
  });

  it("caps group bonus at thirty percent and never duplicates the solo pool", () => {
    const contributions = Array.from({ length: 6 }, (_, index) => ({
      entityId: `p${index}`,
      damage: 10
    }));
    const levels = new Map(contributions.map((entry) => [entry.entityId, 10]));
    const result = calculateCombatRewardShares(140, 10, contributions, levels);
    expect(result.calculatedPool).toBe(182);
    expect(result.shares.every((share) => share.requestedXp < 140)).toBe(true);
    expect(result.shares.reduce((sum, share) => sum + share.requestedXp, 0)).toBe(182);
  });

  it("applies level modifiers before distribution and returns zero for a dummy", () => {
    expect(calculateCombatRewardShares(0, 0, [{ entityId: "p1", damage: 10 }], new Map([["p1", 0]])))
      .toEqual({ calculatedPool: 0, shares: [] });
    const trivial = calculateCombatRewardShares(
      100,
      0,
      [{ entityId: "p1", damage: 10 }],
      new Map([["p1", 10]])
    );
    expect(trivial.calculatedPool).toBe(10);
    expect(trivial.shares[0]?.levelMultiplier).toBe(0.1);
  });

  it("does not let a high-level participant inherit a low-level participant's modifier", () => {
    const result = calculateCombatRewardShares(
      100,
      10,
      [{ entityId: "on-tier", damage: 50 }, { entityId: "over-level", damage: 50 }],
      new Map([["on-tier", 10], ["over-level", 20]])
    );
    expect(result.shares.find((share) => share.playerId === "on-tier")!.requestedXp)
      .toBeGreaterThan(result.shares.find((share) => share.playerId === "over-level")!.requestedXp);
    expect(result.shares.reduce((sum, share) => sum + share.requestedXp, 0))
      .toBe(result.calculatedPool);
  });
});

/** Scavenge is a hidden old skill; the dev flag (fullClassRosterEnabled) brings it back for these tests. */
const OLD_SKILLS_ON = { fullClassRosterEnabled: true, ultimatesEnabled: false } as const;

describe("durable combat settlement service", () => {
  it("ignores a stored Scavenge rank while the old skills are hidden", async () => {
    const database = createSettlementDatabase(3);
    const settlement = candidate();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger()
    );
    await service.accept(settlement);
    expect(database.candidate(settlement.settlementKey)).toMatchObject({ scavengeRank: 0 });
  });

  it("freezes Scavenge rank in the durable candidate across later rank changes", async () => {
    const database = createSettlementDatabase(3);
    const settlement = candidate();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger()
    );
    service.setSkillSystemV3Capabilities(OLD_SKILLS_ON);
    await service.accept(settlement);
    expect(database.candidate(settlement.settlementKey)).toMatchObject({ scavengeRank: 3 });
    database.setScavengeRank(0);
    await service.accept(settlement);
    expect(database.candidate(settlement.settlementKey)).toMatchObject({ scavengeRank: 3 });
  });

  it.each([1, 2, 3, 4] as const)(
    "normalizes pending V%i Scavenge compatibility rewards without active Raw Meat",
    async (itemRewardPolicyVersion) => {
      const expectedSelection = "raw_meat";
      const settlementKey = findScavengeSettlementKey(
        itemRewardPolicyVersion,
        expectedSelection
      );
      const database = createSettlementDatabase(1);
      const inventory = new FakeInventory();
      const completed = vi.fn();
      const service = new CombatRewardSettlementService(
        database.pool,
        new FakeProgression() as unknown as ProgressionService,
        logger(),
        completed,
        undefined,
        inventory as never,
        undefined,
        new FakeWallet() as never
      );
      service.setSkillSystemV3Capabilities(OLD_SKILLS_ON);
      const rewardCandidate = {
        ...candidate(10_000 + itemRewardPolicyVersion, "wolf"),
        settlementKey,
        itemRewardPolicyVersion,
        ...(itemRewardPolicyVersion === 1
          ? {}
          : {
              lootLocation: {
                regionCode: "GLOBAL",
                zoneId: "world:GLOBAL",
                position: { lat: 40, lon: -105 }
              }
            })
      };

      await service.accept(rewardCandidate);
      await service.accept(rewardCandidate);
      await service.flush();

      const grants = inventory.grantsForOperation(`combat-items:${settlementKey}`);
      expect(grants.map((grant) => grant.itemId)).toContain("wild_meat");
      expect(grants.map((grant) => grant.itemId)).not.toContain("raw_meat");
      expect(completed).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({
        itemRewardPolicyVersion,
        mobReward: expect.objectContaining({
          items: expect.arrayContaining([expect.objectContaining({ itemId: "wild_meat" })])
        })
      }));
      expect(database.result(settlementKey)).toMatchObject({
        mobReward: {
        items: expect.arrayContaining([expect.objectContaining({ itemId: "wild_meat" })])
        }
      });
    }
  );

  it("retries a normalized legacy Scavenge reward without duplicating inventory or Gold", async () => {
    const itemRewardPolicyVersion = 4 as const;
    const settlementKey = findScavengeSettlementKey(itemRewardPolicyVersion, "raw_meat");
    const database = createSettlementDatabase(1);
    const inventory = new FakeInventory();
    const wallet = new FakeWallet();
    const completed = vi.fn();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger(),
      completed,
      undefined,
      inventory as never,
      undefined,
      wallet as never
    );
    service.setSkillSystemV3Capabilities(OLD_SKILLS_ON);
    const rewardCandidate = {
      ...candidate(10_004, "wolf"),
      settlementKey,
      itemRewardPolicyVersion,
      lootLocation: {
        regionCode: "GLOBAL",
        zoneId: "world:GLOBAL",
        position: { lat: 40, lon: -105 }
      }
    };

    await service.accept(rewardCandidate);
    database.failNext("SET status = 'completed'");
    await service.flush();
    expect(database.status(settlementKey)).toBe("failed");
    expect(inventory.operationCount()).toBe(1);
    expect(inventory.grantsForOperation(`combat-items:${settlementKey}`)
      .map((grant) => grant.itemId)).toEqual(expect.arrayContaining(["wild_meat"]));
    expect(inventory.grantsForOperation(`combat-items:${settlementKey}`)
      .map((grant) => grant.itemId)).not.toContain("raw_meat");

    await expect(service.recoverIncomplete()).resolves.toBe(1);
    expect(database.status(settlementKey)).toBe("completed");
    expect(inventory.operationCount()).toBe(1);
    expect(wallet.operationCount()).toBe(1);
    expect(completed).toHaveBeenCalledOnce();
  });

  it("leaves a completed historical Raw Meat result unchanged on duplicate delivery", async () => {
    const historicalCandidate = {
      ...candidate(10_005, "wolf"),
      itemRewardPolicyVersion: 4 as const,
      scavengeRank: 1
    };
    const historicalResult = historicalCombatResult(historicalCandidate);
    const database = createSettlementDatabase();
    database.seedCompleted(historicalCandidate, historicalResult);
    const inventory = new FakeInventory();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger(),
      undefined,
      undefined,
      inventory as never,
      undefined,
      new FakeWallet() as never
    );

    await service.accept(historicalCandidate);
    await service.flush();

    expect(inventory.operationCount()).toBe(0);
    expect(database.result(historicalCandidate.settlementKey)).toEqual(historicalResult);
  });

  it("runs a bounded retry supervisor and exposes its health", async () => {
    const database = createSettlementDatabase();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger()
    );
    await service.accept(candidate());
    service.startSupervisor(5);
    expect(service.workerState()).toMatchObject({ running: true, intervalMs: 5 });

    await waitForCondition(() => database.status(candidate().settlementKey) === "completed");

    expect(service.workerState()).toMatchObject({
      running: true,
      lastError: null
    });
    expect(service.workerState().lastSuccessfulRunAt).not.toBeNull();
    await service.stopSupervisor();
    expect(service.workerState()).toMatchObject({ running: false, intervalMs: null });
  });

  it("durably accepts more than the former 1,024-candidate process limit", async () => {
    const database = createSettlementDatabase();
    const progression = new FakeProgression();
    const service = new CombatRewardSettlementService(
      database.pool,
      progression as unknown as ProgressionService,
      logger()
    );
    await Promise.all(Array.from({ length: 1_025 }, (_, index) => service.accept(candidate(index))));
    await expect(service.refreshMetricsSnapshot()).resolves.toMatchObject({ queueDepth: 1_025 });
    expect(database.count()).toBe(1_025);
  });

  it("rejects acceptance when Postgres is unavailable without inventing durable state", async () => {
    const database = createSettlementDatabase();
    database.failNext("INSERT INTO combat_reward_settlements");
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger()
    );
    await expect(service.accept(candidate())).rejects.toThrow("injected database failure");
    expect(database.count()).toBe(0);
  });

  it("completes once after duplicate durable delivery", async () => {
    const database = createSettlementDatabase();
    const progression = new FakeProgression();
    const completed = vi.fn();
    const service = new CombatRewardSettlementService(
      database.pool,
      progression as unknown as ProgressionService,
      logger(),
      completed
    );
    await service.accept(candidate());
    await service.accept(candidate());
    await service.flush();
    expect(progression.operationCount()).toBe(1);
    expect(completed).toHaveBeenCalledOnce();
    expect(database.status(candidate().settlementKey)).toBe("completed");
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ xpPolicyVersion: 2 }));
  });

  it("uses the frozen active class and never grants Warrior XP to another class", async () => {
    const database = createSettlementDatabase();
    const classes = new FakeClasses();
    const alternate = { ...candidate(), participantClassIds: { p1: "hunter" as const } };
    const service = new CombatRewardSettlementService(
      database.pool, new FakeProgression() as unknown as ProgressionService, logger(), undefined, classes as never
    );
    await service.accept(alternate);
    await service.flush();
    expect(classes.operationCount()).toBe(0);
    expect(database.status(alternate.settlementKey)).toBe("completed");
  });

  it("settles a frozen V3 hit-count anchor without consulting the live mob XP definition", async () => {
    const database = createSettlementDatabase();
    const completed = vi.fn();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger(),
      completed
    );
    const rewardCandidate = v3Candidate({ targetBasicHitCount: 99 });
    const exact = 99 * 12 * (1.02 ** 5);

    await service.accept(rewardCandidate);
    await service.flush();

    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      xpPolicyVersion: 3,
      targetBasicHitCount: 99,
      baseXpPool: 1_188
    }));
    const result = completed.mock.calls[0]?.[0] as CombatSettlementResult;
    expect([Math.floor(exact), Math.ceil(exact)]).toContain(result.calculatedXpPool);
  });

  it("settles a frozen V3 XP anchor for every Population V2 mob archetype", async () => {
    const database = createSettlementDatabase();
    const completed = vi.fn();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger(),
      completed
    );

    for (const [index, archetype] of POPULATION_V2_RUNTIME_MOB_ARCHETYPES.entries()) {
      const anchor = combatXpAnchor(archetype);
      await service.accept({
        ...candidate(20_000 + index, archetype),
        mobLevel: MOB_DEFINITIONS[archetype].level,
        xpPolicyVersion: 3,
        targetBasicHitCount: anchor.targetBasicHitCount,
        baseXpPool: anchor.baseXpPool
      });
    }
    await service.flush();

    expect(POPULATION_V2_RUNTIME_MOB_ARCHETYPES).toContain("alligator");
    expect(completed).toHaveBeenCalledTimes(POPULATION_V2_RUNTIME_MOB_ARCHETYPES.length);
    for (const archetype of POPULATION_V2_RUNTIME_MOB_ARCHETYPES) {
      const anchor = combatXpAnchor(archetype);
      const result = completed.mock.calls
        .map(([entry]) => entry as CombatSettlementResult)
        .find((entry) => entry.mobArchetype === archetype);
      expect(result).toMatchObject({
        mobArchetype: archetype,
        xpPolicyVersion: 3,
        targetBasicHitCount: anchor.targetBasicHitCount,
        baseXpPool: anchor.baseXpPool
      });
      expect(result?.shares[0]?.requestedXp).toBeGreaterThan(0);
      expect(result?.shares[0]?.grant.grantedXp).toBeGreaterThan(0);
    }
  });

  it("accepts durably inside a caller-owned transaction without controlling the client", async () => {
    const database = createSettlementDatabase();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger()
    );
    const client = await database.pool.connect();
    const query = vi.spyOn(client, "query");
    const release = vi.spyOn(client, "release");

    await service.acceptInTransaction(client, candidate(30_000, "alligator"));

    const transactionCommands = query.mock.calls.map(([text]) => text)
      .filter((text) => text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK");
    expect(transactionCommands).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    expect(database.count()).toBe(1);
    client.release();
  });

  it.each([
    ["wolf", "leather", 2],
    ["ogre", "stone", 1],
    ["mysterious_traveler", "balsam_resin", 25]
  ] as const)(
    "awards exact %s items and Gold once after duplicate durable delivery",
    async (archetype, itemId, quantity) => {
      const database = createSettlementDatabase();
      const inventory = new FakeInventory();
      const wallet = new FakeWallet();
      const completed = vi.fn();
      const service = new CombatRewardSettlementService(
        database.pool,
        new FakeProgression() as unknown as ProgressionService,
        logger(),
        completed,
        undefined,
        inventory as never,
        undefined,
        wallet as never
      );
      const rewardCandidate = candidate(0, archetype);
      const definition = MOB_DEFINITIONS[archetype];
      const gold = scaledMobGoldReward({
        baseGold: definition.rewards.gold,
        mobLevel: definition.level,
        settlementKey: rewardCandidate.settlementKey
      });
      await service.accept(rewardCandidate);
      await service.accept(rewardCandidate);
      await service.flush();
      expect(inventory.operationCount()).toBe(1);
      expect(wallet.operationCount()).toBe(1);
      expect(completed).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({
        mobReward: expect.objectContaining({
          playerId: "p1",
          items: [{ itemId, quantity }],
          gold,
          walletGold: String(gold),
          walletVersion: "1"
        })
      }));
    }
  );

  it("preserves the frozen V2 weighted Deer Hide payout after duplicate delivery", async () => {
    const database = createSettlementDatabase();
    const inventory = new FakeInventory();
    const wallet = new FakeWallet();
    const completed = vi.fn();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger(),
      completed,
      undefined,
      inventory as never,
      undefined,
      wallet as never
    );
    const rewardCandidate = {
      ...candidate(0, "deer"),
      itemRewardPolicyVersion: 2 as const,
      lootLocation: {
        regionCode: "GLOBAL",
        zoneId: "world:GLOBAL",
        position: { lat: 40, lon: -105 }
      }
    };
    const definition = MOB_DEFINITIONS.deer;
    const gold = scaledMobGoldReward({
      baseGold: definition.rewards.gold,
      mobLevel: definition.level,
      settlementKey: rewardCandidate.settlementKey
    });
    const expectedItems = resolveChanceBasedItemRewards({
      settlementKey: rewardCandidate.settlementKey,
      mobArchetype: "deer",
      mobBalanceVersion: definition.balanceVersion,
      rewards: LEGACY_V2_DEER_CHANCE_REWARDS
    });
    await service.accept(rewardCandidate);
    await service.accept(rewardCandidate);
    await service.flush();
    expect(inventory.operationCount()).toBe(1);
    expect(wallet.operationCount()).toBe(1);
    expect(completed).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      mobReward: expect.objectContaining({
        playerId: "p1",
        items: expectedItems,
        gold,
        walletGold: String(gold),
        walletVersion: "1"
      })
    }));
  });

  it.each([
    ["wolf", "wolf_pelt"],
    ["hog", "hog_hide"],
    ["bear", "bear_hide"],
    ["alligator", "alligator_hide"],
    ["coastal_crab", "crab_carapace"],
    ["squid", "squid_flesh"],
    ["jellyfish", "jellyfish_venom"]
  ] as const)("preserves the frozen V2 %s item payout", async (mobArchetype, itemId) => {
    const database = createSettlementDatabase();
    const completed = vi.fn();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger(),
      completed,
      undefined,
      new FakeInventory() as never,
      undefined,
      new FakeWallet() as never
    );
    const rewardCandidate = {
      ...candidate(0, mobArchetype),
      itemRewardPolicyVersion: 2 as const,
      lootLocation: {
        regionCode: "GLOBAL",
        zoneId: "world:GLOBAL",
        position: { lat: 40, lon: -105 }
      }
    };

    await service.accept(rewardCandidate);
    await service.flush();

    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      itemRewardPolicyVersion: 2,
      mobReward: expect.objectContaining({
        items: [{ itemId, quantity: 1 }]
      })
    }));
  });

  it("aggregates matching committed item grants into one settlement result", async () => {
    const database = createSettlementDatabase();
    const completed = vi.fn();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger(),
      completed,
      undefined,
      new FakeInventory([
        { itemId: "stone", grantedQuantity: 1 },
        { itemId: "stone", grantedQuantity: 2 }
      ]) as never,
      undefined,
      new FakeWallet() as never
    );
    await service.accept(candidate(17, "ogre"));
    await service.flush();

    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      mobReward: expect.objectContaining({
        items: [{ itemId: "stone", quantity: 3 }]
      })
    }));
  });

  it.each([
    "goblin",
    "bandit",
    "orc_brute",
    "sap_crawler"
  ] as const)("publishes the scaled configured %s Gold reward", async (archetype) => {
    const database = createSettlementDatabase();
    const completed = vi.fn();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger(),
      completed,
      undefined,
      new FakeInventory() as never,
      undefined,
      new FakeWallet() as never
    );
    const rewardCandidate = candidate(0, archetype);
    const definition = MOB_DEFINITIONS[archetype];
    const gold = scaledMobGoldReward({
      baseGold: definition.rewards.gold,
      mobLevel: definition.level,
      settlementKey: rewardCandidate.settlementKey
    });
    await service.accept(rewardCandidate);
    await service.flush();
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      mobReward: expect.objectContaining({
        gold,
        walletGold: String(gold),
        walletVersion: "1"
      })
    }));
  });

  it("grants an item-only zero-Gold reward without fabricating a wallet update", async () => {
    const database = createSettlementDatabase();
    const inventory = new FakeInventory();
    const wallet = new FakeWallet(47n);
    const completed = vi.fn();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger(),
      completed,
      undefined,
      inventory as never,
      undefined,
      wallet as never
    );
    const rewardCandidate = {
      ...candidate(0, "deer"),
      itemRewardPolicyVersion: COMBAT_ITEM_REWARD_POLICY_VERSION,
      lootLocation: {
        regionCode: "GLOBAL",
        zoneId: "world:GLOBAL",
        position: { lat: 40, lon: -105 }
      }
    };
    const expectedItems = resolveChanceBasedItemRewards({
      settlementKey: rewardCandidate.settlementKey,
      mobArchetype: "deer",
      mobBalanceVersion: MOB_DEFINITIONS.deer.balanceVersion,
      rewards: MOB_DEFINITIONS.deer.rewards.chanceItems
    });
    const originalGold = MOB_DEFINITIONS.deer.rewards.gold;
    MOB_DEFINITIONS.deer.rewards.gold = 0;
    try {
      await service.accept(rewardCandidate);
      await service.accept(rewardCandidate);
      await service.flush();

      expect(inventory.operationCount()).toBe(1);
      expect(wallet.operationCount()).toBe(0);
      expect(wallet.balance()).toBe(47n);
      expect(completed).toHaveBeenCalledOnce();
      const reward = completed.mock.calls[0]?.[0].mobReward;
      expect(reward).toMatchObject({
        items: expectedItems,
        gold: 0
      });
      expect(reward).not.toHaveProperty("walletGold");
      expect(reward).not.toHaveProperty("walletVersion");
    } finally {
      MOB_DEFINITIONS.deer.rewards.gold = originalGold;
    }
  });

  it("awards independently rounded Gold for each individual wolf settlement", async () => {
    const database = createSettlementDatabase();
    const wallet = new FakeWallet();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger(),
      undefined,
      undefined,
      new FakeInventory() as never,
      undefined,
      wallet as never
    );
    const first = candidate(1, "wolf");
    const second = candidate(2, "wolf");
    await service.accept(first);
    await service.accept(second);
    await service.flush();
    expect(wallet.operationCount()).toBe(2);
    expect(wallet.balance()).toBe(BigInt(
      scaledMobGoldReward({
        baseGold: MOB_DEFINITIONS.wolf.rewards.gold,
        mobLevel: MOB_DEFINITIONS.wolf.level,
        settlementKey: first.settlementKey
      })
      + scaledMobGoldReward({
        baseGold: MOB_DEFINITIONS.wolf.rewards.gold,
        mobLevel: MOB_DEFINITIONS.wolf.level,
        settlementKey: second.settlementKey
      })
    ));
  });

  it("multiplies mob Gold by the frozen Golem Forge group bonus once, and a replay pays nothing more", async () => {
    for (const multiplier of [1.4, 1.8, 2.2, 2.55]) {
      const database = createSettlementDatabase();
      const wallet = new FakeWallet();
      const service = new CombatRewardSettlementService(
        database.pool, new FakeProgression() as unknown as ProgressionService, logger(), undefined,
        undefined, new FakeInventory() as never, undefined, wallet as never
      );
      const forgeKill = { ...candidate(7, "wolf"), groupGoldMultiplier: multiplier };
      const base = scaledMobGoldReward({
        baseGold: MOB_DEFINITIONS.wolf.rewards.gold, mobLevel: MOB_DEFINITIONS.wolf.level, settlementKey: forgeKill.settlementKey
      });
      await service.accept(forgeKill);
      await service.flush();
      expect(database.candidate(forgeKill.settlementKey)).toMatchObject({ groupGoldMultiplier: multiplier });
      expect(wallet.balance()).toBe(BigInt(Math.round(base * multiplier)));
      // A redelivered defeat (even one carrying another multiplier) settles nothing twice.
      await service.accept({ ...forgeKill, groupGoldMultiplier: 2.55 });
      await service.flush();
      expect(wallet.operationCount()).toBe(1);
      expect(wallet.balance()).toBe(BigInt(Math.round(base * multiplier)));
    }
  });

  it("fails closed for a generated world mob without V2 authority", async () => {
    const database = createSettlementDatabase();
    const service = new CombatRewardSettlementService(
      database.pool,
      new FakeProgression() as unknown as ProgressionService,
      logger()
    );
    const legacy = {
      ...candidate(),
      settlementKey: "legacy-generated-mob:defeat:1",
      defeatedEntityId: "legacy-generated-mob"
    };
    await expect(service.accept(legacy))
      .rejects.toThrow("lacks Population v2 authority");
  });

  it("denies a stale population-v2 fence and accepts the exact current lease once", async () => {
    const entityId = "00000000-0000-8000-8000-000000000321";
    const authority = {
      ownerToken: "00000000-0000-4000-8000-000000000322",
      fencingGeneration: 4,
      cutoverRevision: 2
    };
    const v2Candidate = {
      ...candidate(0, "deer"),
      settlementKey: `${entityId}:defeat:8`,
      defeatedEntityId: entityId,
      defeatGeneration: 8,
      populationAuthority: authority
    };
    const staleCandidate = {
      ...v2Candidate,
      populationAuthority: {
        ...authority,
        fencingGeneration: authority.fencingGeneration - 1
      }
    };
    let state: "ready" | "dead" = "ready";
    let stateRevision = 7;
    const queries: Array<{
      text: string;
      values: readonly unknown[] | undefined;
    }> = [];
    const query = async <T>(text: string, values?: readonly unknown[]) => {
      queries.push({ text, values });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return empty<T>();
      }
      if (text.includes("SELECT rank FROM player_skill_ranks")) return empty<T>();
      if (text.includes("INSERT INTO combat_reward_settlements")) {
        return empty<T>();
      }
      if (text.includes("SELECT settlement_key, defeated_mob_instance_id")) {
        return one<T>({
          settlement_key: v2Candidate.settlementKey,
          defeated_mob_instance_id: entityId,
          mob_life_generation: 8
        });
      }
      if (text.includes("UPDATE population_entity_state_v2 AS state")) {
        expect(values?.slice(0, 3)).toEqual([entityId, 7, "p1"]);
        const hasCurrentAuthority =
          values?.[3] === authority.ownerToken
          && values?.[4] === authority.fencingGeneration
          && values?.[5] === authority.cutoverRevision;
        if (
          !hasCurrentAuthority
          || state !== "ready"
          || stateRevision !== Number(values?.[1])
        ) {
          return empty<T>();
        }
        state = "dead";
        stateRevision += 1;
        return one<T>({ state_revision: stateRevision });
      }
      if (text.includes("SELECT projection.population_v2_entity_id::text")) {
        return one<T>({
          population_v2_entity_id: entityId,
          state,
          state_revision: stateRevision,
          authority_valid:
            values?.[1] === authority.ownerToken
            && values?.[2] === authority.fencingGeneration
            && values?.[3] === authority.cutoverRevision
            && values?.[4] === 7
        });
      }
      throw new Error(`Unexpected population-v2 settlement query: ${text}`);
    };
    const client = { query, release: () => undefined };
    const service = new CombatRewardSettlementService(
      { connect: async () => client } as never,
      new FakeProgression() as unknown as ProgressionService,
      logger()
    );

    await expect(service.accept(staleCandidate)).rejects.toThrow(
      "lost its runtime authority lease"
    );
    expect(state).toBe("ready");
    expect(stateRevision).toBe(7);

    await service.accept(v2Candidate);
    await service.accept(v2Candidate);

    expect(state).toBe("dead");
    expect(stateRevision).toBe(8);
    expect(queries.filter((entry) =>
      entry.text.includes("UPDATE population_entity_state_v2")
    )).toHaveLength(3);
    expect(queries.some((entry) =>
      entry.text.includes("population_runtime_entity_leases_v2")
      && entry.text.includes("lease.lease_expires_at > clock_timestamp()")
    )).toBe(true);
    expect(queries.some((entry) =>
      entry.text.includes("UPDATE generated_world_mobs")
    )).toBe(false);
  });

  it("reconciles a crash after durable acceptance on restart", async () => {
    const database = createSettlementDatabase();
    const progression = new FakeProgression();
    const first = new CombatRewardSettlementService(
      database.pool,
      progression as unknown as ProgressionService,
      logger()
    );
    await first.accept(candidate());

    const restarted = new CombatRewardSettlementService(
      database.pool,
      progression as unknown as ProgressionService,
      logger()
    );
    await expect(restarted.recoverIncomplete()).resolves.toBe(1);
    expect(progression.operationCount()).toBe(1);
    expect(database.status(candidate().settlementKey)).toBe("completed");
  });

  it.each(["preparation", "xp", "class", "completion"] as const)(
    "recovers idempotently after a crash during %s",
    async (failurePoint) => {
      const database = createSettlementDatabase();
      const progression = new FakeProgression();
      const classes = new FakeClasses();
      if (failurePoint === "preparation") progression.failNextPreparation = true;
      if (failurePoint === "xp") progression.failNextGrant = true;
      if (failurePoint === "class") classes.failNextGrant = true;
      if (failurePoint === "completion") database.failNext("SET status = 'completed'");
      const completed = vi.fn();
      const first = new CombatRewardSettlementService(
        database.pool,
        progression as unknown as ProgressionService,
        logger(),
        completed,
        classes as never
      );
      await first.accept(candidate());
      await first.flush();
      expect(database.status(candidate().settlementKey)).toBe("failed");
      expect(completed).not.toHaveBeenCalled();

      const restarted = new CombatRewardSettlementService(
        database.pool,
        progression as unknown as ProgressionService,
        logger(),
        completed,
        classes as never
      );
      await expect(restarted.recoverIncomplete()).resolves.toBe(1);
      expect(progression.operationCount()).toBe(1);
      expect(classes.operationCount()).toBe(1);
      expect(database.status(candidate().settlementKey)).toBe("completed");
      expect(completed).toHaveBeenCalledOnce();
    }
  );

  it("uses leased SKIP LOCKED claims safely across two settlement services", async () => {
    const database = createSettlementDatabase();
    const progression = new FakeProgression();
    const first = new CombatRewardSettlementService(
      database.pool,
      progression as unknown as ProgressionService,
      logger()
    );
    const second = new CombatRewardSettlementService(
      database.pool,
      progression as unknown as ProgressionService,
      logger()
    );
    await Promise.all(Array.from({ length: 20 }, (_, index) => first.accept(candidate(index))));
    await Promise.all([first.flush(), second.flush()]);
    expect(progression.operationCount()).toBe(20);
    expect(database.completedCount()).toBe(20);
  });
});

function candidate(index = 0, mobArchetype: MobArchetypeKey = "wolf"): CombatDefeatSettlementCandidate {
  return {
    settlementKey: `mob:test:${index}:defeat:1`,
    defeatedEntityId: `mob:test:${index}`,
    defeatGeneration: 1,
    eligibleParticipantIds: ["p1"],
    contributions: [{ entityId: "p1", damage: 90 }],
    serverTick: 10,
    mobArchetype,
    participantClassIds: { p1: "warrior" },
    classXpPolicyVersion: 1,
    baseClassXpPool: mobArchetype === "training_dummy" ? 0 : 6,
    defeatingPlayerId: "p1"
  };
}

function findScavengeSettlementKey(
  itemRewardPolicyVersion: number,
  expectedItemId: "raw_meat" | "wild_meat"
): string {
  for (let index = 0; index < 100_000; index += 1) {
    const settlementKey = `mob:scavenge-compat:${itemRewardPolicyVersion}:${index}:defeat:1`;
    const reward = resolveScavengeBonus({
      settlementKey,
      mobArchetype: "wolf",
      rank: 1,
      boss: false,
      droppedItem: true,
      itemRewardPolicyVersion
    });
    if (reward?.itemId === expectedItemId) return settlementKey;
  }
  throw new Error(`Unable to find deterministic Scavenge ${expectedItemId} selection`);
}

function historicalCombatResult(
  settlementCandidate: CombatDefeatSettlementCandidate
): CombatSettlementResult {
  const definition = MOB_DEFINITIONS[settlementCandidate.mobArchetype];
  const baseXpPool = settlementCandidate.baseXpPool ?? 0;
  return {
    settlementKey: settlementCandidate.settlementKey,
    mobArchetype: settlementCandidate.mobArchetype,
    mobLevel: settlementCandidate.mobLevel ?? definition.level,
    mobBalanceVersion: settlementCandidate.mobBalanceVersion ?? definition.balanceVersion,
    xpPolicyVersion: settlementCandidate.xpPolicyVersion ?? 2,
    itemRewardPolicyVersion: settlementCandidate.itemRewardPolicyVersion ?? 4,
    targetBasicHitCount: settlementCandidate.targetBasicHitCount ?? 1,
    baseXpPool,
    calculatedXpPool: baseXpPool,
    classXpPolicyVersion: settlementCandidate.classXpPolicyVersion ?? 0,
    baseClassXpPool: settlementCandidate.baseClassXpPool ?? 0,
    groupSize: 0,
    shares: [],
    mobReward: {
      playerId: settlementCandidate.defeatingPlayerId ?? "p1",
      items: [{ itemId: "raw_meat", quantity: 1 }],
      gold: 0,
      inventory: {
        playerId: settlementCandidate.defeatingPlayerId ?? "p1",
        revision: 0,
        items: [],
        totals: emptyInventoryTotals()
      },
      cityCoins: 0,
      cityId: null,
      cityTreasuryBalance: null,
      cityContribution: null
    },
    replayed: false
  };
}

function v3Candidate(
  input: { targetBasicHitCount?: number } = {}
): CombatDefeatSettlementCandidate {
  const targetBasicHitCount = input.targetBasicHitCount ?? 3;
  return {
    ...candidate(9_999, "wolf"),
    mobLevel: 5,
    xpPolicyVersion: 3,
    targetBasicHitCount,
    baseXpPool: targetBasicHitCount * 12
  };
}

class FakeProgression {
  private readonly grants = new Map<string, XpGrantResult>();
  failNextPreparation = false;
  failNextGrant = false;

  operationCount(): number {
    return this.grants.size;
  }

  async getOrCreate(playerId: string) {
    if (this.failNextPreparation) {
      this.failNextPreparation = false;
      throw new Error("injected preparation crash");
    }
    return progressionSnapshot(playerId, 5, 10_000);
  }

  async grantXp(input: XpGrantInput): Promise<XpGrantResult> {
    if (this.failNextGrant) {
      this.failNextGrant = false;
      throw new Error("injected XP crash");
    }
    const existing = this.grants.get(input.operationKey);
    if (existing) return { ...existing, replayed: true };
    const result: XpGrantResult = {
      operationKey: input.operationKey,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      requestedXp: input.requestedXp,
      grantedXp: input.requestedXp,
      discardedXp: 0,
      previousXp: 10_000,
      resultingXp: 10_000 + input.requestedXp,
      previousLevel: 5,
      resultingLevel: 5,
      levelsGained: [],
      replayed: false,
      progression: progressionSnapshot(input.playerId, 5, 10_000 + input.requestedXp)
    };
    this.grants.set(input.operationKey, result);
    return result;
  }
}

class FakeClasses {
  private readonly grants = new Map<string, { snapshot: { playerId: string } }>();
  failNextGrant = false;

  operationCount(): number {
    return this.grants.size;
  }

  async grantCombatMastery(playerId: string, _classId: "warrior", _requestedXp: number, operationKey: string) {
    if (this.failNextGrant) {
      this.failNextGrant = false;
      throw new Error("injected class grant crash");
    }
    const result = this.grants.get(operationKey) ?? { snapshot: { playerId } };
    this.grants.set(operationKey, result);
    return result;
  }
}

class FakeInventory {
  private readonly operations = new Map<string, {
    playerId: string;
    grants: Array<{
      itemId: ResourceType;
      variant: string | null;
      quantity: bigint;
    }>;
  }>();

  constructor(
    private readonly committedGrantOverride: readonly Readonly<{
      itemId: ResourceType;
      grantedQuantity: number;
    }>[] | null = null
  ) {}

  operationCount(): number {
    return this.operations.size;
  }

  grantsForOperation(operationKey: string) {
    return this.operations.get(operationKey)?.grants ?? [];
  }

  async grantItemsForOperationInTransaction(
    _queryable: unknown,
    input: {
      operationKey: string;
      playerId: string;
      grants: Array<{
        itemId: ResourceType;
        variant: string | null;
        quantity: bigint;
      }>;
    }
  ) {
    const existing = this.operations.get(input.operationKey);
    if (existing) {
      return {
        applied: false,
        inventory: {
          playerId: input.playerId,
          items: existing.grants.map((grant) => ({
            playerId: input.playerId,
            resourceType: grant.itemId,
            variant: grant.variant,
            quantity: Number(grant.quantity)
          })),
          totals: existing.grants.reduce((totals, grant) => {
            totals[grant.itemId] += Number(grant.quantity);
            return totals;
          }, emptyInventoryTotals())
        },
        grants: existing.grants.map((grant) => ({
          itemId: grant.itemId,
          variant: grant.variant,
          requestedQuantity: Number(grant.quantity),
          grantedQuantity: Number(grant.quantity),
          remainderQuantity: 0
        }))
      };
    }
    this.operations.set(input.operationKey, { playerId: input.playerId, grants: input.grants });
    const committedGrants = this.committedGrantOverride?.map((grant) => ({
      itemId: grant.itemId,
      variant: null,
      requestedQuantity: grant.grantedQuantity,
      grantedQuantity: grant.grantedQuantity,
      remainderQuantity: 0
    })) ?? input.grants.map((grant) => ({
      itemId: grant.itemId,
      variant: grant.variant,
      requestedQuantity: Number(grant.quantity),
      grantedQuantity: Number(grant.quantity),
      remainderQuantity: 0
    }));
    const totals = emptyInventoryTotals();
    for (const grant of committedGrants) {
      totals[grant.itemId] += grant.grantedQuantity;
    }
    return {
      applied: true,
      inventory: {
        playerId: input.playerId,
        items: committedGrants.map((grant) => ({
          playerId: input.playerId,
          resourceType: grant.itemId,
          variant: null,
          quantity: grant.grantedQuantity
        })),
        totals
      },
      grants: committedGrants
    };
  }

  async snapshotInTransaction(_queryable: unknown, playerId: string) {
    return {
      playerId,
      items: [],
      totals: emptyInventoryTotals()
    };
  }
}

class FakeWallet {
  private readonly operations = new Map<string, bigint>();

  constructor(private readonly openingBalance = 0n) {}

  operationCount(): number {
    return this.operations.size;
  }

  balance(): bigint {
    return this.openingBalance
      + [...this.operations.values()].reduce((sum, amount) => sum + amount, 0n);
  }

  async creditForOperationInTransaction(
    _queryable: unknown,
    input: { operationKey: string; amount: bigint }
  ) {
    if (!this.operations.has(input.operationKey)) this.operations.set(input.operationKey, input.amount);
    return {
      applied: true,
      goldBalance: this.balance(),
      version: BigInt(this.operations.size)
    };
  }
}

type SettlementRow = {
    key: string;
    defeatedEntityId: string;
    defeatGeneration: number;
    mobArchetype: MobArchetypeKey;
    candidate: CombatDefeatSettlementCandidate;
    status: string;
    attemptCount: number;
    failureCount: number;
    prepared: boolean;
    retryReady: boolean;
    leaseExpired: boolean;
    locked: boolean;
    baseXpPool: number;
    calculatedXpPool: number;
    classXpPolicyVersion: number;
    baseClassXpPool: number;
    rewardPlayerId: string | null;
    rewardCityId: string | null;
    rewardMembershipId: string | null;
    result: unknown;
    createdOrder: number;
};

type SettlementState = {
  settlements: Map<string, SettlementRow>;
  participants: Map<string, Array<{
    playerId: string;
    damage: number;
    playerLevel: number;
    multiplier: number;
    contribution: number;
    requestedXp: number;
    activeClassId: "warrior" | null;
    requestedClassXp: number;
    grantedXp: number;
  }>>;
};

function createSettlementDatabase(initialScavengeRank = 0, initialRogueRank = 0) {
  const state: SettlementState = { settlements: new Map(), participants: new Map() };
  let scavengeRank = initialScavengeRank;
  let rogueRank = initialRogueRank;
  const failures: string[] = [];
  const maybeFail = (text: string) => {
    const index = failures.findIndex((pattern) => text.includes(pattern));
    if (index >= 0) {
      failures.splice(index, 1);
      throw new Error("injected database failure");
    }
  };
  const pool = {
    query: async <T>(text: string, values?: readonly unknown[]) => {
      maybeFail(text);
      if (text.includes("SELECT rank FROM player_skill_ranks")) {
        return scavengeRank > 0 ? one<T>({ rank: scavengeRank }) : empty<T>();
      }
      if (text.includes("FROM player_specialization_state state")) {
        return rogueRank > 0 ? one<T>({ rank: rogueRank }) : empty<T>();
      }
      return querySettlement<T>(state, text, values);
    },
    connect: async () => {
      let lockedKey: string | null = null;
      return {
        query: async <T>(text: string, values?: readonly unknown[]) => {
          maybeFail(text);
          if (text.includes("SELECT rank FROM player_skill_ranks")) {
            return scavengeRank > 0 ? one<T>({ rank: scavengeRank }) : empty<T>();
          }
          if (text.includes("FROM player_specialization_state state")) {
            return rogueRank > 0 ? one<T>({ rank: rogueRank }) : empty<T>();
          }
          if (text === "BEGIN") return empty<T>();
          if (text === "COMMIT") {
            if (lockedKey) state.settlements.get(lockedKey)!.locked = false;
            lockedKey = null;
            return empty<T>();
          }
          if (text === "ROLLBACK") {
            if (lockedKey) state.settlements.get(lockedKey)!.locked = false;
            lockedKey = null;
            return empty<T>();
          }
          if (text.includes("FOR UPDATE SKIP LOCKED")) {
            const row = [...state.settlements.values()]
              .sort((left, right) => left.createdOrder - right.createdOrder)
              .find((entry) => !entry.locked && (
                ((entry.status === "pending" || entry.status === "failed") && entry.retryReady) ||
                (entry.status === "processing" && entry.leaseExpired)
              ));
            if (!row) return empty<T>();
            row.locked = true;
            lockedKey = row.key;
            return one<T>({ settlement_key: row.key, candidate: row.candidate });
          }
          return querySettlement<T>(state, text, values);
        },
        release: () => undefined
      };
    }
  } as unknown as pg.Pool;
  return {
    pool,
    failNext: (pattern: string) => failures.push(pattern),
    count: () => state.settlements.size,
    completedCount: () => [...state.settlements.values()].filter((row) => row.status === "completed").length,
    status: (key: string) => state.settlements.get(key)?.status ?? null,
    candidate: (key: string) => state.settlements.get(key)?.candidate ?? null,
    result: (key: string) => state.settlements.get(key)?.result ?? null,
    seedCompleted: (
      settlementCandidate: CombatDefeatSettlementCandidate,
      result: CombatSettlementResult
    ) => {
      state.settlements.set(settlementCandidate.settlementKey, {
        key: settlementCandidate.settlementKey,
        defeatedEntityId: settlementCandidate.defeatedEntityId,
        defeatGeneration: settlementCandidate.defeatGeneration,
        mobArchetype: settlementCandidate.mobArchetype,
        candidate: settlementCandidate,
        status: "completed",
        attemptCount: 1,
        failureCount: 0,
        prepared: true,
        retryReady: false,
        leaseExpired: false,
        locked: false,
        baseXpPool: result.baseXpPool,
        calculatedXpPool: result.calculatedXpPool,
        classXpPolicyVersion: result.classXpPolicyVersion,
        baseClassXpPool: result.baseClassXpPool,
        rewardPlayerId: settlementCandidate.defeatingPlayerId ?? null,
        rewardCityId: null,
        rewardMembershipId: null,
        result,
        createdOrder: state.settlements.size
      });
    },
    setScavengeRank: (rank: number) => { scavengeRank = rank; }
  };
}

async function querySettlement<T>(state: SettlementState, text: string, values?: readonly unknown[]) {
  if (text.includes("SELECT rank FROM player_skill_ranks")) return empty<T>();
  if (text.includes("INSERT INTO combat_reward_settlements")) {
    const key = String(values?.[0]);
    if (!state.settlements.has(key)) state.settlements.set(key, {
      key,
      defeatedEntityId: String(values?.[1]),
      defeatGeneration: Number(values?.[2]),
      mobArchetype: String(values?.[3]) as "wolf",
      candidate: JSON.parse(String(values?.[5])) as CombatDefeatSettlementCandidate,
      status: "pending",
      attemptCount: 0,
      failureCount: 0,
      prepared: false,
      retryReady: true,
      leaseExpired: false,
      locked: false,
      baseXpPool: 0,
      calculatedXpPool: 0,
      classXpPolicyVersion: 0,
      baseClassXpPool: 0,
      rewardPlayerId: values?.[6] ? String(values[6]) : null,
      rewardCityId: values?.[7] ? String(values[7]) : null,
      rewardMembershipId: values?.[8] ? String(values[8]) : null,
      result: null,
      createdOrder: state.settlements.size
    });
    return empty<T>();
  }
  if (text.includes("SELECT settlement_key, defeated_mob_instance_id")) {
    const row = state.settlements.get(String(values?.[0])) ?? [...state.settlements.values()].find(
      (entry) => entry.defeatedEntityId === values?.[1] && entry.defeatGeneration === values?.[2]
    );
    return row ? one<T>({
      settlement_key: row.key,
      defeated_mob_instance_id: row.defeatedEntityId,
      mob_life_generation: row.defeatGeneration
    }) : empty<T>();
  }
  if (text.includes("UPDATE population_entity_state_v2 AS state")) {
    return empty<T>();
  }
  if (text.includes("SELECT projection.population_v2_entity_id::text")) {
    return values?.[0] === "legacy-generated-mob"
      ? one<T>({
          population_v2_entity_id: null,
          state: null,
          state_revision: null,
          authority_valid: false
        })
      : empty<T>();
  }
  if (text.includes("SELECT account_id FROM players")) {
    return one<T>({ account_id: "account-p1" });
  }
  if (text.includes("WHERE status IN ('processing', 'failed')")) {
    for (const row of state.settlements.values()) {
      if (row.status === "processing" || row.status === "failed") {
        row.status = "failed";
        row.retryReady = true;
        row.leaseExpired = false;
      }
    }
    return empty<T>();
  }
  if (text.includes("COUNT(*) FILTER")) {
    const rows = [...state.settlements.values()];
    return one<T>({
      queue_depth: rows.filter((row) => row.status === "pending" || row.status === "failed").length,
      oldest_pending_age_ms: 0,
      processing_count: rows.filter((row) => row.status === "processing").length,
      retry_count: rows.reduce((sum, row) => sum + Math.max(0, row.attemptCount - 1), 0),
      failure_count: rows.reduce((sum, row) => sum + row.failureCount, 0),
      completed_count: rows.filter((row) => row.status === "completed").length
    });
  }
  if (text.includes("SET status = 'processing'")) {
    const row = state.settlements.get(String(values?.[0]))!;
    row.status = "processing";
    row.attemptCount += 1;
    row.retryReady = false;
    row.leaseExpired = false;
    return empty<T>();
  }
  if (
    text.includes("SELECT status,result,prepared_at,candidate,reward_player_id")
  ) {
    const row = state.settlements.get(String(values?.[0]));
    return row ? one<T>({
      status: row.status,
      result: row.result,
      prepared_at: row.prepared ? new Date() : null,
      candidate: row.candidate,
      reward_player_id: row.rewardPlayerId,
      reward_city_id: row.rewardCityId,
      reward_membership_id: row.rewardMembershipId
    }) : empty<T>();
  }
  if (text.includes("INSERT INTO combat_reward_participants")) {
    const key = String(values?.[0]);
    const participants = state.participants.get(key) ?? [];
    if (!participants.some((entry) => entry.playerId === String(values?.[1]))) participants.push({
      playerId: String(values?.[1]),
      damage: Number(values?.[2]),
      playerLevel: Number(values?.[3]),
      multiplier: Number(values?.[4]),
      contribution: Number(values?.[5]),
      requestedXp: Number(values?.[6]),
      activeClassId: values?.[7] === "warrior" ? "warrior" : null,
      requestedClassXp: Number(values?.[8]),
      grantedXp: 0
    });
    state.participants.set(key, participants);
    return empty<T>();
  }
  if (text.includes("SET base_xp_pool")) {
    const row = state.settlements.get(String(values?.[0]))!;
    row.baseXpPool = Number(values?.[1]);
    row.calculatedXpPool = Number(values?.[2]);
    row.baseClassXpPool = Number(values?.[3]);
    row.classXpPolicyVersion = Number(values?.[4]);
    row.prepared = true;
    return empty<T>();
  }
  if (text.includes("SET status = 'failed'")) {
    const row = state.settlements.get(String(values?.[0]));
    if (row?.status !== "completed") {
      row!.status = "failed";
      row!.failureCount += 1;
      row!.retryReady = false;
    }
    return empty<T>();
  }
  if (text.includes("LEFT JOIN combat_reward_participants")) {
    const row = state.settlements.get(String(values?.[0]));
    if (!row) return empty<T>();
    const base = {
      mob_archetype: row.mobArchetype,
      base_xp_pool: row.baseXpPool,
      calculated_xp_pool: row.calculatedXpPool,
      class_xp_policy_version: row.classXpPolicyVersion,
      base_class_xp_pool: row.baseClassXpPool,
      candidate: row.candidate,
      reward_player_id: row.rewardPlayerId,
      reward_city_id: row.rewardCityId,
      reward_membership_id: row.rewardMembershipId
    };
    const participants = state.participants.get(row.key) ?? [];
    return participants.length === 0
      ? one<T>({ ...base, player_id: null })
      : many<T>(participants.map((participant) => ({
          ...base,
          player_id: participant.playerId,
          authoritative_damage: participant.damage,
          player_level: participant.playerLevel,
          level_multiplier: participant.multiplier,
          contribution_share: participant.contribution,
          requested_xp: participant.requestedXp,
          active_class_id: participant.activeClassId,
          requested_class_xp: participant.requestedClassXp
        })));
  }
  if (text.includes("UPDATE combat_reward_participants")) {
    const participant = state.participants.get(String(values?.[0]))?.find(
      (entry) => entry.playerId === values?.[1]
    );
    if (participant) participant.grantedXp = Number(values?.[2]);
    return empty<T>();
  }
  if (
    text.includes("INSERT INTO creature_book_kill_occurrences")
    || text.includes("INSERT INTO creature_book_sightings")
    || text.includes("INSERT INTO creature_book_drop_occurrences")
  ) {
    return empty<T>();
  }
  if (text.includes("SET status = 'completed'")) {
    const row = state.settlements.get(String(values?.[0]))!;
    row.status = "completed";
    row.result = JSON.parse(String(values?.[2]));
    return empty<T>();
  }
  // The land owner bonus runs inside its own savepoint; the fake has no land
  // owner, so its lookup fails and rolls back to the savepoint as designed.
  if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) /.test(text.trim())) return empty<T>();
  throw new Error(`Unhandled settlement test query: ${text}`);
}

function progressionSnapshot(playerId: string, level: number, totalXp: number) {
  return {
    playerId,
    totalXp,
    level,
    curveVersion: 1,
    persistenceVersion: 1,
    xpIntoLevel: 0,
    xpForNextLevel: 5_000,
    nextLevelTotalXp: 15_000,
    atCap: false,
    pveStats: { maxHealth: 120, attackPower: 11, defense: 1, attackIntervalMs: 800, attackRangeM: 75 }
  };
}

function logger(): AppLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as AppLogger;
}

function one<T>(row: unknown) { return { rows: [row as T], rowCount: 1 }; }
function many<T>(rows: unknown[]) { return { rows: rows as T[], rowCount: rows.length }; }
function empty<T>() { return { rows: [] as T[], rowCount: 0 }; }

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for settlement supervisor");
}

describe("drop-chance multiplier", () => {
  it("never pushes a weighted roll past certainty", () => {
    for (const key of ["deer", "stormwing", "mammoth_patriarch", "griffin"] as const) {
      const rewards = scaleChanceItemRewards(MOB_DEFINITIONS[key].rewards.chanceItems, 1.5);
      for (let unit = 0; unit < 1; unit += 0.125) {
        expect(() => resolveChanceBasedItemRewards({
          settlementKey: "s", mobArchetype: key, mobBalanceVersion: 1, rewards, unitForRoll: () => unit
        })).not.toThrow();
      }
    }
  });

  it("still raises single rolls", () => {
    const [scaled] = scaleChanceItemRewards([{ itemId: "bone", quantity: 1, probability: 0.2, rollId: "drop:bone" }], 1.5);
    expect(scaled!.probability).toBeCloseTo(0.3);
  });
});

describe("Rogue humanoid Gold proc", () => {
  const procIndex = (() => {
    for (let index = 0; index < 100_000; index += 1) {
      if (rogueHumanoidGoldProc({ settlementKey: `mob:test:${index}:defeat:1`, playerId: "p1", mobArchetype: "bandit", rank: 5, killGold: 10 }) > 0) return index;
    }
    throw new Error("no proc key found");
  })();
  const missIndex = procIndex === 0 ? 1 : 0;
  const amounts = [450, 450, 900, 900, 1_350];

  it("rolls 2.5% from an injected roll, by rank, only for humanoids that pay Gold", () => {
    const base = { settlementKey: "k", playerId: "p1", mobArchetype: "bandit", killGold: 10 };
    for (const rank of [1, 2, 3, 4, 5]) {
      expect(rogueHumanoidGoldProc({ ...base, rank, roll: 0.0249 })).toBe(amounts[rank - 1]);
      expect(rogueHumanoidGoldProc({ ...base, rank, roll: 0.025 })).toBe(0);
    }
    expect(rogueHumanoidGoldProc({ ...base, rank: 0, roll: 0 })).toBe(0);
    expect(rogueHumanoidGoldProc({ ...base, rank: 5, roll: 0, mobArchetype: "wolf" })).toBe(0);
    expect(rogueHumanoidGoldProc({ ...base, rank: 5, roll: 0, mobArchetype: "training_dummy" })).toBe(0);
    expect(rogueHumanoidGoldProc({ ...base, rank: 5, roll: 0, mobArchetype: "risen_skeleton" })).toBe(0);
    expect(rogueHumanoidGoldProc({ ...base, rank: 5, roll: 0, summoned: true })).toBe(0);
    expect(rogueHumanoidGoldProc({ ...base, rank: 5, roll: 0, killGold: 0 })).toBe(0);
    // Without an injected roll the result is a pure function of the settlement and player.
    expect(rogueHumanoidGoldProc({ ...base, rank: 5 })).toBe(rogueHumanoidGoldProc({ ...base, rank: 5 }));
  });

  for (const rank of [1, 2, 3, 4, 5]) {
    it(`rank ${rank} pays ${amounts[rank - 1]} extra Gold on a proc kill, once, on its own ledger key`, async () => {
      const database = createSettlementDatabase(0, rank);
      const wallet = new FakeWallet();
      const completed = vi.fn();
      const service = new CombatRewardSettlementService(
        database.pool, new FakeProgression() as unknown as ProgressionService, logger(), completed,
        undefined, new FakeInventory() as never, undefined, wallet as never
      );
      const rewardCandidate = candidate(procIndex, "bandit");
      const gold = scaledMobGoldReward({
        baseGold: MOB_DEFINITIONS.bandit.rewards.gold, mobLevel: MOB_DEFINITIONS.bandit.level, settlementKey: rewardCandidate.settlementKey
      });
      await service.accept(rewardCandidate);
      await service.flush();
      expect(database.candidate(rewardCandidate.settlementKey)).toMatchObject({ rogueGoldProcRank: rank });
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({
        mobReward: expect.objectContaining({ gold, rogueBonusGold: amounts[rank - 1], walletGold: String(BigInt(gold) + BigInt(amounts[rank - 1]!)) })
      }));
      expect(wallet.operationCount()).toBe(2);
      // Replaying the same defeat settles nothing twice.
      await service.accept(rewardCandidate);
      await service.flush();
      expect(wallet.operationCount()).toBe(2);
    });
  }

  it("pays nothing without an active Rogue, on a miss roll, or for a non-humanoid mob", async () => {
    const run = async (rank: number, index: number, archetype: MobArchetypeKey) => {
      const database = createSettlementDatabase(0, rank);
      const completed = vi.fn();
      const service = new CombatRewardSettlementService(
        database.pool, new FakeProgression() as unknown as ProgressionService, logger(), completed,
        undefined, new FakeInventory() as never, undefined, new FakeWallet() as never
      );
      await service.accept(candidate(index, archetype));
      await service.flush();
      return completed.mock.calls[0]?.[0]?.mobReward;
    };
    expect((await run(0, procIndex, "bandit"))?.rogueBonusGold).toBeUndefined();
    expect((await run(5, missIndex, "bandit"))?.rogueBonusGold).toBeUndefined();
    expect((await run(5, procIndex, "wolf"))?.rogueBonusGold).toBeUndefined();
  });
});
