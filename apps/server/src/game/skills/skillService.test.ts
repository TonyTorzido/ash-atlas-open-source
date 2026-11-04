import { GENERAL_SKILL_DEFINITIONS, GENERAL_SKILL_OFFERINGS, VISIBLE_GENERAL_SKILL_IDS } from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import type { SkillRequestError } from "./skillAuthority.js";
import { SkillService } from "./skillService.js";

/** The old combat skills are hidden; the dev flag (fullClassRosterEnabled) keeps their mechanics testable. */
const OLD_SKILLS = { fullClassRosterEnabled: true } as const;

describe("SkillService world knowledge and cooldown authority", () => {
  it("persists only lexicographically newer runtime snapshots and rejects invalid JSON", async () => {
    const runtime = new RuntimePersistencePool();
    const service = new SkillService(runtime.pool);
    const input = {
      cooldownEndsAt: { "general:cleanse": 123_456 },
      statusEffects: [{ id: "immune", endsAt: 123_456 }],
      counters: { cleanseUses: 1 },
      engagedTarget: { targetEntityId: "mob-1", expiresAt: 123_000 },
      combatGeneration: 4,
      revision: 7
    } as const;

    await expect(service.persistRuntime("player-1", input)).resolves.toBe(true);
    await expect(service.persistRuntime("player-1", input)).resolves.toBe(false);
    await expect(service.persistRuntime("player-1", {
      ...input,
      revision: 8,
      counters: { revisionAdvanced: true }
    })).resolves.toBe(true);
    await expect(service.persistRuntime("player-1", {
      ...input,
      combatGeneration: 3,
      revision: 99
    })).resolves.toBe(false);
    await expect(service.persistRuntime("player-1", {
      ...input,
      combatGeneration: 5,
      revision: 0,
      counters: { generationAdvanced: true }
    })).resolves.toBe(true);
    expect(runtime.persisted).toMatchObject({
      combatGeneration: 5,
      revision: 0,
      cooldownEndsAt: input.cooldownEndsAt,
      counters: { generationAdvanced: true }
    });

    await expect(service.persistRuntime("player-1", {
      ...input,
      cooldownEndsAt: { invalid: Number.POSITIVE_INFINITY }
    })).rejects.toMatchObject({ code: "SKILL_RUNTIME_COOLDOWN_INVALID" });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(service.persistRuntime("player-1", {
      ...input,
      counters: cyclic
    })).rejects.toMatchObject({ code: "SKILL_RUNTIME_JSON_INVALID" });
    expect(runtime.queryCount).toBe(5);
  });

  it("keeps discovered-only world knowledge unspendable until it is revealed", async () => {
    // Every world-knowledge branch is implemented now (no future_content entries remain), so the
    // guard that matters is the reveal requirement.
    const database = new SkillDatabase();
    const service = new SkillService(database.pool);

    await expect(service.spendWorldKnowledgePoint(
      database.playerId, "rare_beast_mastery", "world-spend", 0
    )).rejects.toMatchObject({ code: "SKILL_WORLD_REVEAL_REQUIRED" } satisfies Partial<SkillRequestError>);
    expect(database.skillRanks.get("rare_beast_mastery")).toBeUndefined();
    expect(database.totalSpent).toBe(0);
    expect(database.operations.size).toBe(0);
  });

  it("rejects a General Active slot outside the shared current-slot policy before mutation", async () => {
    const database = new SkillDatabase();
    const service = new SkillService(database.pool);

    await expect(service.equipGeneralActive(
      database.playerId,
      3 as never,
      null,
      "invalid-general-slot",
      0
    )).rejects.toMatchObject({ code: "SKILL_ACTIVE_SLOT_INVALID" } satisfies Partial<SkillRequestError>);
    expect(database.queries).toEqual([]);
  });

  it("preserves persisted General Active slot order across fresh skill snapshots", async () => {
    const database = new SkillDatabase();
    database.generalActiveLoadout = ["cleanse", "shield_charge"];

    const connected = await new SkillService(database.pool, OLD_SKILLS).getOrCreate(database.playerId);
    const reconnected = await new SkillService(database.pool, OLD_SKILLS).getOrCreate(database.playerId);

    expect(connected.generalActiveLoadout).toEqual(["cleanse", "shield_charge"]);
    expect(reconnected.generalActiveLoadout).toEqual(["cleanse", "shield_charge"]);
  });

  it("projects stale General Active assignments empty without remapping the other slot", async () => {
    const database = new SkillDatabase();
    database.generalActiveLoadout = ["retired_general_active", "cleanse"];

    const snapshot = await new SkillService(database.pool, OLD_SKILLS).getOrCreate(database.playerId);

    expect(snapshot.generalActiveLoadout).toEqual([null, "cleanse"]);
  });

  it("keeps General Active assignment and use independent from full inventory and backpack mutations", async () => {
    const database = new SkillDatabase();
    database.skillRanks.set("cleanse", { rank: 1, points_spent: 1, grandfathered: false });
    database.totalSpent = 1;
    const service = new SkillService(database.pool, OLD_SKILLS);
    const inventory = { capacity: 20, occupied: 20, revision: 1 };

    const equipped = await service.equipGeneralActive(
      database.playerId,
      1,
      "cleanse",
      "equip-with-full-inventory",
      0
    );
    expect(inventory.occupied).toBe(inventory.capacity);
    expect(equipped.snapshot.generalActiveLoadout).toEqual(["cleanse", null]);

    inventory.occupied = 19;
    inventory.revision += 1;
    const afterInventoryMutation = await service.getOrCreate(database.playerId);
    expect(afterInventoryMutation.generalActiveLoadout).toEqual(["cleanse", null]);
    await expect(service.confirmGeneralActiveUse(
      database.playerId,
      "cleanse",
      "use-with-inventory-mutation",
      afterInventoryMutation.revision
    )).resolves.toMatchObject({
      replayed: false,
      snapshot: { generalActiveLoadout: ["cleanse", null] }
    });
    expect(database.queries.some((sql) => /inventory|backpack/iu.test(sql))).toBe(false);
  });

  it("ignores stored Ultimate and Class Technique cooldown keys and never projects an Ultimate", async () => {
    const cooldownEnd = Date.now() + 60_000;
    const database = new SkillDatabase({
      activeSpecializationId: "warrior",
      specializationRanks: new Map([[
        "warrior",
        { rank: 5, points_spent: 0, grandfathered: true }
      ]]),
      ultimateUnlocks: new Map([["warrior", "warrior_mastery_trial"]]),
      cooldownEndsAt: {
        "ultimate:warrior:warrior_v2_worldbreaker": cooldownEnd,
        warrior_v2_worldbreaker: cooldownEnd,
        v3_warrior_anger_explosion: cooldownEnd,
        "general:cleanse": cooldownEnd + 1_000
      }
    });

    const snapshot = await new SkillService(database.pool).getOrCreate(database.playerId);
    expect(snapshot.cooldownEndsAt).toEqual({ "general:cleanse": cooldownEnd + 1_000 });
    expect(snapshot.equippedClassTechniqueId).toBeNull();
    expect(snapshot.ultimatesEnabled).toBe(false);
    expect(snapshot.ultimate).toBeNull();
  });

  it("repairs a committed launch specialization with a learned rank and no active state", async () => {
    const database = new SkillDatabase({
      committedSpecializationId: "warrior",
      activeSpecializationId: null,
      specializationRanks: new Map([["warrior", { rank: 1, points_spent: 1, grandfathered: false }]])
    });
    database.totalSpent = 1;

    const snapshot = await new SkillService(database.pool).getOrCreate(database.playerId);
    expect(snapshot.activeSpecializationId).toBe("warrior");
    expect(database.activeSpecializationId).toBe("warrior");
  });

  it("projects a retained full-roster active specialization when the server capability is enabled", async () => {
    const database = new SkillDatabase({
      activeSpecializationId: "knight",
      specializationRanks: new Map([["knight", { rank: 2, points_spent: 2, grandfathered: false }]])
    });
    database.totalSpent = 2;

    const snapshot = await new SkillService(database.pool, { fullClassRosterEnabled: true }).getOrCreate(database.playerId);
    expect(snapshot).toMatchObject({
      fullClassRosterEnabled: true,
      ultimatesEnabled: false,
      activeSpecializationId: "knight",
      ultimate: null
    });
  });

  it("grandfathers actual spending above level entitlement with zero available", async () => {
    const database = new SkillDatabase({
      committedSpecializationId: "warrior",
      specializationRanks: new Map([["warrior", { rank: 5, points_spent: 15, grandfathered: false }]])
    });
    database.totalSpent = 15;

    const snapshot = await new SkillService(database.pool).getOrCreate(database.playerId);
    expect(snapshot.pointState).toEqual({ totalEarned: 15, totalSpent: 15, available: 0, revision: 1 });
    expect(database).toMatchObject({ level: 10, totalEarned: 15, totalSpent: 15, revision: 1 });
  });

  it("rejects Skill Point spending on Provoke until its Cleave prerequisite is met", async () => {
    const database = new SkillDatabase();
    const service = new SkillService(database.pool, OLD_SKILLS);

    await expect(service.spendGeneralSkillPoint(
      database.playerId,
      "provoke",
      "pending-skill",
      0
    )).rejects.toMatchObject({ code: "SKILL_PREREQUISITE_REQUIRED" } satisfies Partial<SkillRequestError>);
    expect(database.totalSpent).toBe(0);
    expect(database.skillRanks.has("provoke")).toBe(false);
    expect(database.operations.size).toBe(0);
  });

  it("allows restored implemented skills to be purchased once their prerequisites are met", async () => {
    const database = new SkillDatabase();
    database.skillRanks.set("war_standard", { rank: 1, points_spent: 1, grandfathered: false });
    database.totalSpent = 1;
    await expect(new SkillService(database.pool, OLD_SKILLS).spendGeneralSkillPoint(
      database.playerId, "heroism", "restored-skill", 0
    )).resolves.toMatchObject({ replayed: false });
    expect(database.skillRanks.get("heroism")?.rank).toBe(1);
  });

  it("independently enforces every visible edge prerequisite and permits child advancement", async () => {
    const children = VISIBLE_GENERAL_SKILL_IDS.filter((id) => GENERAL_SKILL_DEFINITIONS[id].prerequisites.length > 0);
    expect(children).toHaveLength(20);

    for (const child of children) {
      const prerequisites = GENERAL_SKILL_DEFINITIONS[child].prerequisites;
      // Every single missing or under-ranked prerequisite blocks the purchase on its own.
      for (const missing of prerequisites) {
        const database = new SkillDatabase();
        const guarded = new SkillService(database.pool, OLD_SKILLS);
        for (const other of prerequisites) {
          if (other !== missing) database.skillRanks.set(other.skillId, { rank: other.rank, points_spent: other.rank, grandfathered: false });
        }
        database.totalSpent = prerequisites.filter((item) => item !== missing).reduce((sum, item) => sum + item.rank, 0);
        await expect(guarded.spendGeneralSkillPoint(
          database.playerId, child, `forged-${child}-${missing.skillId}`, 0
        )).rejects.toMatchObject({ code: "SKILL_PREREQUISITE_REQUIRED" } satisfies Partial<SkillRequestError>);
        expect(database.operations.size).toBe(0);
      }

      const database = new SkillDatabase();
      const learner = new SkillService(database.pool, OLD_SKILLS);
      for (const item of prerequisites) database.skillRanks.set(item.skillId, { rank: item.rank, points_spent: item.rank, grandfathered: false });
      database.totalSpent = prerequisites.reduce((sum, item) => sum + item.rank, 0);
      await expect(learner.spendGeneralSkillPoint(
        database.playerId, child, `learn-${child}`, 0
      )).resolves.toMatchObject({ replayed: false });
      await expect(learner.spendGeneralSkillPoint(
        database.playerId, child, `advance-${child}`, 1
      )).resolves.toMatchObject({ replayed: false });
      expect(database.skillRanks.get(child)?.rank).toBe(2);
    }
  });

  it("keeps Perfect Strike locked until its 6 Zephyr offering is made", async () => {
    const database = new SkillDatabase({ offeringsMade: false });
    const service = new SkillService(database.pool, OLD_SKILLS);
    database.skillRanks.set("martial_arts", { rank: 3, points_spent: 3, grandfathered: false });
    database.totalSpent = 3;
    await expect(service.spendGeneralSkillPoint(database.playerId, "perfect_strike", "locked-perfect-strike", 0))
      .rejects.toMatchObject({ code: "SKILL_OFFERING_REQUIRED" } satisfies Partial<SkillRequestError>);
    expect(database.operations.size).toBe(0);
  });

  it("rejects refunds that would break restored prerequisite edges", async () => {
    const database = new SkillDatabase();
    database.skillRanks.set("pierce_armor", { rank: 1, points_spent: 1, grandfathered: false });
    database.skillRanks.set("blight_strike", { rank: 1, points_spent: 1, grandfathered: false });
    database.totalSpent = 2;

    await expect(new SkillService(database.pool, { ...OLD_SKILLS, allowProductionRefunds: true }).refundGeneralSkillRank(
      database.playerId, "pierce_armor", "break-restored-edge", 0
    )).rejects.toMatchObject({ code: "SKILL_REFUND_BREAKS_PREREQUISITE" } satisfies Partial<SkillRequestError>);
    expect(database.skillRanks.get("pierce_armor")?.rank).toBe(1);
  });

  it("allows Shield Charge training without a shield while combat still enforces use equipment", async () => {
    const database = new SkillDatabase();
    database.skillRanks.set("cleave", { rank: 2, points_spent: 2, grandfathered: false });
    database.totalSpent = 2;
    const service = new SkillService(database.pool, OLD_SKILLS);

    await expect(service.spendGeneralSkillPoint(
      database.playerId, "shield_charge", "missing-shield", 0
    )).resolves.toMatchObject({ replayed: false });
    expect(database.skillRanks.get("shield_charge")?.rank).toBe(1);
  });

  it("allows Ricochet training with Archery Rank 1 and no ranged gear equipped", async () => {
    const database = new SkillDatabase();
    database.skillRanks.set("archery", { rank: 1, points_spent: 1, grandfathered: false });
    database.totalSpent = 1;
    const service = new SkillService(database.pool, OLD_SKILLS);

    await expect(service.spendGeneralSkillPoint(
      database.playerId, "ricochet", "ricochet-no-gear", 0
    )).resolves.toMatchObject({ replayed: false });
    expect(database.skillRanks.get("ricochet")?.rank).toBe(1);
  });

  it("allows Pierce Armor training with Cleave Rank 1 and no melee gear equipped", async () => {
    const database = new SkillDatabase();
    database.skillRanks.set("cleave", { rank: 1, points_spent: 1, grandfathered: false });
    database.totalSpent = 1;

    await expect(new SkillService(database.pool, OLD_SKILLS).spendGeneralSkillPoint(
      database.playerId, "pierce_armor", "pierce-no-gear", 0
    )).resolves.toMatchObject({ replayed: false });
    expect(database.skillRanks.get("pierce_armor")?.rank).toBe(1);
  });

  it("allows Cleave training without equipped gear", async () => {
    const database = new SkillDatabase();

    await expect(new SkillService(database.pool, OLD_SKILLS).spendGeneralSkillPoint(
      database.playerId, "cleave", "cleave-no-gear", 0
    )).resolves.toMatchObject({ replayed: false });
    expect(database.skillRanks.get("cleave")?.rank).toBe(1);
  });

  it("full respec removes launch build ranks while retaining backend evidence and mastery", async () => {
    const database = new SkillDatabase({
      offeringsMade: false,
      committedSpecializationId: "legionnaire",
      activeSpecializationId: "legionnaire",
      specializationRanks: new Map([
        ["legionnaire", { rank: 1, points_spent: 2, grandfathered: false }],
        ["warrior", { rank: 2, points_spent: 1, grandfathered: true }]
      ]),
      ultimateUnlocks: new Map([["warrior", "warrior_mastery_trial"]]),
      cooldownEndsAt: { "general:cleanse": Date.now() + 60_000 }
    });
    database.skillRanks.set("cleanse", { rank: 1, points_spent: 1, grandfathered: false });
    database.generalActiveLoadout = ["cleanse", null];
    database.worldUnlocks.add("grove_lore");
    database.totalSpent = 1; // Only Warrior counts: Legionnaire and Cleanse are hidden.
    const earnedBefore = database.totalEarned;
    const levelBefore = database.level;

    const result = await new SkillService(database.pool, { fullBuildRespecAvailable: true }).resetOwnDevelopmentSkillTree(
      database.playerId, "dev-reset", 0
    );

    // Legionnaire and Cleanse are hidden: their rank rows are kept untouched and their points already read as available.
    expect(database.specializationRanks.get("legionnaire")).toMatchObject({ rank: 1, points_spent: 2 });
    expect(database.specializationRanks.has("warrior")).toBe(false);
    expect(database.skillRanks.get("cleanse")).toMatchObject({ rank: 1, points_spent: 1 });
    expect(database.generalActiveLoadout).toEqual([null, null]);
    expect(database.cooldownEndsAt).toEqual({});
    expect(database.totalEarned).toBe(earnedBefore);
    expect(database.level).toBe(levelBefore);
    expect(database.worldUnlocks).toEqual(new Set(["grove_lore"]));
    expect(database.ultimateUnlocks.get("warrior")).toBe("warrior_mastery_trial");
    expect(result.snapshot).toMatchObject({
      characterLevel: levelBefore,
      committedSpecializationId: null,
      activeSpecializationId: null,
      generalActiveLoadout: [null, null],
      worldKnowledge: expect.arrayContaining([expect.objectContaining({ skillId: "grove_lore" })]),
      specializations: expect.arrayContaining([expect.objectContaining({ specializationId: "warrior", masteryQuestCompleted: false })]),
      pointState: { totalEarned: earnedBefore, totalSpent: 0, available: 10, revision: 1 }
    });
    expect(database.queries.some((sql) => /profession|inventory|equipment|currency|achievement/iu.test(sql))).toBe(false);

    const replay = await new SkillService(database.pool, { fullBuildRespecAvailable: true }).fullBuildRespec(
      database.playerId, "dev-reset", 0, { inCombat: true }
    );
    expect(replay.replayed).toBe(true);
    expect(database.revision).toBe(1);
  });

  it("full-roster respec resets all fourteen class ranks while preserving mastery history", async () => {
    const database = new SkillDatabase({
      committedSpecializationId: "knight",
      activeSpecializationId: "knight",
      specializationRanks: new Map([
        ["knight", { rank: 3, points_spent: 3, grandfathered: false }],
        ["warrior", { rank: 2, points_spent: 2, grandfathered: false }]
      ]),
      ultimateUnlocks: new Map([["warrior", "warrior_mastery_trial"]])
    });
    database.totalSpent = 5;

    const result = await new SkillService(database.pool, {
      fullBuildRespecAvailable: true,
      fullClassRosterEnabled: true
    }).fullBuildRespec(database.playerId, "full-roster-reset", 0);

    expect(database.specializationRanks.size).toBe(0);
    expect(database.ultimateUnlocks.get("warrior")).toBe("warrior_mastery_trial");
    expect(result.snapshot).toMatchObject({
      fullClassRosterEnabled: true,
      committedSpecializationId: null,
      activeSpecializationId: null,
      pointState: { totalSpent: 0 }
    });
  });

  it("rejects unavailable and transiently unsafe full respec without mutating build state", async () => {
    const database = new SkillDatabase({
      specializationRanks: new Map([["warrior", { rank: 2, points_spent: 2, grandfathered: false }]])
    });
    database.totalSpent = 2;
    await expect(new SkillService(database.pool).fullBuildRespec(database.playerId, "unavailable", 0))
      .rejects.toMatchObject({ code: "SKILL_RESPEC_UNAVAILABLE" });
    for (const [index, restriction] of [
      { inCombat: true },
      { deadOrDowned: true },
      { hasUnresolvedAction: true },
      { locationRestricted: true },
      { equipmentMutationPending: true }
    ].entries()) {
      const restrictedDatabase = new SkillDatabase({
        specializationRanks: new Map([["warrior", { rank: 2, points_spent: 2, grandfathered: false }]])
      });
      restrictedDatabase.totalSpent = 2;
      await expect(new SkillService(restrictedDatabase.pool, { fullBuildRespecAvailable: true }).fullBuildRespec(
        restrictedDatabase.playerId, `restricted-${index}`, 0, restriction
      )).rejects.toMatchObject({ code: "SKILL_RESPEC_RESTRICTED" });
      expect(restrictedDatabase.specializationRanks.get("warrior")?.rank).toBe(2);
      expect(restrictedDatabase.operations.size).toBe(0);
    }
    expect(database.specializationRanks.get("warrior")?.rank).toBe(2);
    expect(database.operations.size).toBe(0);
  });
});

type RankRow = { rank: number; points_spent: number; grandfathered: boolean };
type OperationRow = {
  player_id: string;
  action: string;
  payload: unknown;
  result: unknown;
  completed_at: string | null;
};

describe("hidden old combat skills", () => {
  it("reads their ranks as unlearned and their spent points as available, keeping the rows", async () => {
    // The owner's account: Martial Arts 3/3 and three Ninja ranks (6 spent of 24).
    const database = new SkillDatabase({
      committedSpecializationId: "ninja",
      activeSpecializationId: "ninja",
      specializationRanks: new Map([["ninja", { rank: 3, points_spent: 3, grandfathered: false }]])
    });
    database.level = 24;
    database.totalEarned = 24;
    database.skillRanks.set("martial_arts", { rank: 3, points_spent: 3, grandfathered: false });
    database.skillRanks.set("alchemy", { rank: 1, points_spent: 1, grandfathered: false });
    database.generalActiveLoadout = ["cleanse", null];
    database.totalSpent = 7;

    const snapshot = await new SkillService(database.pool).getOrCreate(database.playerId);

    expect(snapshot.pointState).toMatchObject({ totalEarned: 24, totalSpent: 1, available: 23 });
    expect(snapshot.generalSkills.find((entry) => entry.skillId === "martial_arts")).toMatchObject({ rank: 0, pointsSpent: 0 });
    expect(snapshot.generalSkills.find((entry) => entry.skillId === "alchemy")).toMatchObject({ rank: 1, pointsSpent: 1 });
    expect(snapshot.specializations.find((entry) => entry.specializationId === "ninja")).toMatchObject({ rank: 0, pointsSpent: 0 });
    expect(snapshot.activeSpecializationId).toBeNull();
    expect(snapshot.generalActiveLoadout).toEqual([null, null]);
    expect(database.skillRanks.get("martial_arts")).toMatchObject({ rank: 3, points_spent: 3 });
    expect(database.specializationRanks.get("ninja")).toMatchObject({ rank: 3, points_spent: 3 });

    // The dev flag brings the ranks and their spent points straight back.
    const restored = await new SkillService(database.pool, OLD_SKILLS).getOrCreate(database.playerId);
    expect(restored.pointState).toMatchObject({ totalSpent: 7, available: 17 });
    expect(restored.generalSkills.find((entry) => entry.skillId === "martial_arts")).toMatchObject({ rank: 3, pointsSpent: 3 });
  });

  it("rejects points, offerings, loadout slots and uses for a hidden skill but keeps the Trades open", async () => {
    const database = new SkillDatabase();
    const service = new SkillService(database.pool);
    const hidden = { code: "SKILL_CONTENT_HIDDEN" } satisfies Partial<SkillRequestError>;
    await expect(service.spendGeneralSkillPoint(database.playerId, "cleave", "spend-cleave", 0)).rejects.toMatchObject(hidden);
    await expect(service.equipGeneralActive(database.playerId, 1, "cleanse", "equip-cleanse", 0)).rejects.toMatchObject(hidden);
    await expect(service.confirmGeneralActiveUse(database.playerId, "cleanse", "use-cleanse", 0)).rejects.toMatchObject(hidden);
    await expect(service.discoverGeneralSkill(database.playerId, "perfect_strike", "offer-strike", async () => undefined)).rejects.toMatchObject(hidden);
    await expect(service.spendGeneralSkillPoint(database.playerId, "alchemy", "spend-alchemy", 0)).resolves.toMatchObject({
      snapshot: { generalSkills: expect.arrayContaining([{ skillId: "alchemy", rank: 1, pointsSpent: 1 }]) }
    });
  });
});

describe("token-discovered World Knowledge (Deepstone, Hollin and Grove Lore)", () => {
  it("discovers a skill once, charging inside the same transaction", async () => {
    const database = new SkillDatabase();
    const service = new SkillService(database.pool);
    const charge = vi.fn(async () => undefined);
    const result = await service.discoverWorldKnowledge(database.playerId, "deepstone_lore", "discover-1", charge);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(database.worldUnlocks.has("deepstone_lore")).toBe(true);
    expect(result.replayed).toBe(false);
    expect(database.totalSpent).toBe(0);
  });

  it("rejects an already-discovered skill before charging anything", async () => {
    const database = new SkillDatabase();
    database.worldUnlocks.add("grove_lore");
    const service = new SkillService(database.pool);
    const charge = vi.fn(async () => undefined);
    await expect(service.discoverWorldKnowledge(database.playerId, "grove_lore", "discover-2", charge))
      .rejects.toMatchObject({ code: "SKILL_WORLD_ALREADY_REVEALED" } satisfies Partial<SkillRequestError>);
    expect(charge).not.toHaveBeenCalled();
  });

  it("rolls the discovery back when the token charge fails", async () => {
    const database = new SkillDatabase();
    const service = new SkillService(database.pool);
    await expect(service.discoverWorldKnowledge(database.playerId, "wildkin_lore", "discover-3", async () => {
      throw new Error("Inventory does not contain enough items");
    })).rejects.toThrow(/enough items/u);
    expect(database.worldUnlocks.has("wildkin_lore")).toBe(false);
  });

  it("requires discovery before ranks, then costs 1 Skill Point per rank up to rank 3", async () => {
    const database = new SkillDatabase();
    const service = new SkillService(database.pool);
    await expect(service.spendWorldKnowledgePoint(database.playerId, "deepstone_lore", "rank-0", 0))
      .rejects.toMatchObject({ code: "SKILL_WORLD_REVEAL_REQUIRED" } satisfies Partial<SkillRequestError>);
    await service.discoverWorldKnowledge(database.playerId, "deepstone_lore", "discover-4");
    for (const [index, spent] of [1, 2, 3].entries()) {
      await service.spendWorldKnowledgePoint(database.playerId, "deepstone_lore", `rank-${index + 1}`, database.revision);
      expect(database.skillRanks.get("deepstone_lore")?.rank).toBe(index + 1);
      expect(database.totalSpent).toBe(spent);
    }
    await expect(service.spendWorldKnowledgePoint(database.playerId, "deepstone_lore", "rank-4", database.revision))
      .rejects.toMatchObject({ code: "SKILL_RANK_MAXIMUM" } satisfies Partial<SkillRequestError>);
  });
});

class SkillDatabase {
  readonly playerId = "player-1";
  readonly pool: pg.Pool;
  readonly skillRanks = new Map<string, RankRow>();
  readonly worldUnlocks = new Set<string>();
  readonly operations = new Map<string, OperationRow>();
  readonly specializationRanks: Map<string, RankRow>;
  readonly ultimateUnlocks: Map<string, string>;
  readonly cooldownEndsAt: Record<string, number>;
  readonly queries: string[] = [];
  generalActiveLoadout: [string | null, string | null] = [null, null];
  activeSpecializationId: string | null;
  committedSpecializationId: string | null;
  level = 10;
  totalEarned = 10;

  /** VISIBLE_SPENT_POINTS_SQL: points on rank rows that are not hidden ($2 general ids, $3 class ids). */
  visibleSpent(values: readonly unknown[]): number {
    const hiddenGeneral = new Set((values[1] ?? []) as readonly string[]);
    const hiddenClasses = new Set((values[2] ?? []) as readonly string[]);
    return [...this.skillRanks].filter(([id]) => !hiddenGeneral.has(id))
      .concat([...this.specializationRanks].filter(([id]) => !hiddenClasses.has(id)))
      .reduce((sum, [, row]) => sum + row.points_spent, 0);
  }
  totalSpent = 0;
  revision = 0;
  private transactionBackup: ReturnType<SkillDatabase["backup"]> | null = null;

  constructor(options: {
    activeSpecializationId?: string | null;
    committedSpecializationId?: string | null;
    specializationRanks?: Map<string, RankRow>;
    ultimateUnlocks?: Map<string, string>;
    cooldownEndsAt?: Record<string, number>;
    /** Pretend every Advanced skill's discovery offering was already made (the gate has its own tests). */
    offeringsMade?: boolean;
  } = {}) {
    if (options.offeringsMade ?? true) for (const id of Object.keys(GENERAL_SKILL_OFFERINGS)) this.worldUnlocks.add(id);
    this.activeSpecializationId = options.activeSpecializationId ?? null;
    this.committedSpecializationId = options.committedSpecializationId ?? this.activeSpecializationId;
    this.specializationRanks = options.specializationRanks ?? new Map();
    this.ultimateUnlocks = options.ultimateUnlocks ?? new Map();
    this.cooldownEndsAt = options.cooldownEndsAt ?? {};
    const client = {
      query: this.query.bind(this),
      release: () => undefined
    };
    this.pool = {
      connect: async () => client
    } as unknown as pg.Pool;
  }

  private async query<T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<pg.QueryResult<T>> {
    const sql = query.replace(/\s+/gu, " ").trim();
    this.queries.push(sql);
    if (sql === "BEGIN") {
      this.transactionBackup = this.backup();
      return result();
    }
    if (sql === "COMMIT") {
      this.transactionBackup = null;
      return result();
    }
    if (sql === "ROLLBACK") {
      if (this.transactionBackup) this.restore(this.transactionBackup);
      this.transactionBackup = null;
      return result();
    }
    if (sql.startsWith("INSERT INTO player_skill_point_state")
      || sql.startsWith("INSERT INTO player_specialization_state")
      || sql.startsWith("INSERT INTO player_general_active_loadouts")
      || sql.startsWith("INSERT INTO player_skill_runtime")) return result();
    if (sql.includes("FROM skill_point_operations WHERE operation_key = $1")) {
      const row = this.operations.get(String(values[0]));
      return result(row ? [row as unknown as T] : []);
    }
    if (sql.startsWith("INSERT INTO skill_point_operations")) {
      const key = String(values[0]);
      if (this.operations.has(key)) return result();
      this.operations.set(key, {
        player_id: String(values[1]),
        action: String(values[2]),
        payload: JSON.parse(String(values[3])),
        result: null,
        completed_at: null
      });
      return result([{ operation_key: key } as unknown as T]);
    }
    if (sql.startsWith("UPDATE skill_point_operations SET result")) {
      const operation = this.operations.get(String(values[0]));
      if (operation) {
        operation.result = JSON.parse(String(values[1]));
        operation.completed_at = new Date().toISOString();
      }
      return result(operation ? [{} as T] : []);
    }
    if (sql.includes("FROM player_skill_point_state AS state")) {
      return result([{
        player_id: this.playerId,
        total_earned: this.totalEarned,
        total_spent: this.totalSpent,
        revision: this.revision,
        character_level: this.level
      } as unknown as T]);
    }
    if (sql.startsWith("SELECT ( COALESCE((SELECT SUM(points_spent)")) {
      return result([{ total_spent: this.visibleSpent(values) } as unknown as T]);
    }
    if (sql.startsWith("UPDATE player_specialization_state AS state")) {
      const launchIds = values[1] as readonly string[];
      if (this.activeSpecializationId === null && this.committedSpecializationId !== null
        && launchIds.includes(this.committedSpecializationId)
        && (this.specializationRanks.get(this.committedSpecializationId)?.rank ?? 0) > 0) {
        this.activeSpecializationId = this.committedSpecializationId;
      }
      return result();
    }
    if (sql.startsWith("UPDATE player_skill_point_state SET total_earned = $2")) {
      this.totalEarned = Number(values[1]);
      this.totalSpent = Number(values[2]);
      this.revision += 1;
      return result([{
        player_id: this.playerId,
        total_earned: this.totalEarned,
        total_spent: this.totalSpent,
        revision: this.revision
      } as unknown as T]);
    }
    if (sql.includes("FROM player_skill_world_unlocks") && sql.includes("skill_id = $2")) {
      return result(this.worldUnlocks.has(String(values[1])) ? [{} as T] : []);
    }
    if (sql.includes("FROM player_skill_world_unlocks WHERE player_id = $1")) {
      return result([...this.worldUnlocks].map((skill_id) => ({ skill_id }) as unknown as T));
    }
    if (sql.includes("FROM player_skill_ranks") && sql.includes("skill_id = $2 FOR UPDATE")) {
      const row = this.skillRanks.get(String(values[1]));
      return result(row ? [{ ...row } as unknown as T] : []);
    }
    if (sql.startsWith("INSERT INTO player_skill_world_unlocks")) {
      this.worldUnlocks.add(String(values[1]));
      return result();
    }
    if (sql.startsWith("INSERT INTO player_skill_ranks")) {
      const skillId = String(values[1]);
      const cost = Number(values[2]);
      const current = this.skillRanks.get(skillId);
      this.skillRanks.set(skillId, {
        rank: (current?.rank ?? 0) + 1,
        points_spent: (current?.points_spent ?? 0) + cost,
        grandfathered: current?.grandfathered ?? false
      });
      return result([{} as T]);
    }
    if (sql.startsWith("UPDATE player_general_active_loadouts")) {
      if (sql.includes("slot_one_skill_id = NULL")) this.generalActiveLoadout = [null, null];
      else {
        const slotIndex = sql.includes("slot_one_skill_id = $2") ? 0 : 1;
        this.generalActiveLoadout[slotIndex] = values[1] === null ? null : String(values[1]);
      }
      return result([{} as T]);
    }
    if (sql.startsWith("DELETE FROM player_skill_ranks")) {
      for (const id of values[1] as readonly string[]) this.skillRanks.delete(id);
      return result();
    }
    if (sql.startsWith("UPDATE player_skill_ranks SET points_spent")) {
      for (const row of this.skillRanks.values()) if (row.grandfathered) row.points_spent = 0;
      return result();
    }
    if (sql.startsWith("SELECT 1 FROM player_general_active_loadouts")) {
      const skillId = values[1] === null || values[1] === undefined ? null : String(values[1]);
      return result(skillId !== null && this.generalActiveLoadout.includes(skillId) ? [{} as T] : []);
    }
    if (sql.startsWith("UPDATE player_specialization_state SET active_specialization_id = NULL")) {
      this.activeSpecializationId = null; this.committedSpecializationId = null; return result([{} as T]);
    }
    if (sql.startsWith("DELETE FROM player_specialization_ranks")) {
      for (const id of values[1] as readonly string[]) this.specializationRanks.delete(id);
      return result();
    }
    if (sql.startsWith("UPDATE player_specialization_ranks") && sql.includes("points_spent = 0")) {
      const launchIds = new Set(values[1] as readonly string[]);
      for (const [id, row] of this.specializationRanks) {
        if (!launchIds.has(id)) row.points_spent = 0;
      }
      return result();
    }
    if (sql.startsWith("UPDATE player_skill_runtime SET cooldown_ends_at")) {
      for (const key of Object.keys(this.cooldownEndsAt)) delete this.cooldownEndsAt[key];
      return result([{} as T]);
    }
    if (sql.startsWith("UPDATE player_skill_point_state AS state")) {
      this.totalSpent = this.visibleSpent(values);
      this.revision += 1;
      return result([{} as T]);
    }
    if (sql.startsWith("UPDATE player_specialization_ranks AS ranks")) return result();
    if (sql.startsWith("SELECT specialization_id FROM player_specialization_ranks") && sql.includes("grandfathered AND rank > 0")) {
      return result([...this.specializationRanks].filter(([, row]) => row.grandfathered && row.rank > 0).map(([specialization_id]) => ({ specialization_id }) as unknown as T));
    }
    if (sql.startsWith("UPDATE player_specialization_state SET committed_specialization_id = $2")) {
      this.committedSpecializationId = values[1] === null ? null : String(values[1]);
      this.activeSpecializationId = values[2] === null ? null : String(values[2]);
      return result([{} as T]);
    }
    if (sql.startsWith("UPDATE player_skill_point_state SET total_spent = 0")) {
      this.totalSpent = 0; this.revision += 1; return result([{} as T]);
    }
    if (sql.startsWith("UPDATE player_skill_point_state SET total_spent")) {
      this.totalSpent += Number(values[1]);
      this.revision += 1;
      return result([{ player_id: this.playerId } as unknown as T]);
    }
    if (sql.startsWith("SELECT player_id, total_earned, total_spent, revision FROM player_skill_point_state")) {
      return result([{
        player_id: this.playerId,
        total_earned: this.totalEarned,
        total_spent: this.totalSpent,
        revision: this.revision
      } as unknown as T]);
    }
    if (sql.startsWith("SELECT skill_id, rank, points_spent, grandfathered FROM player_skill_ranks")) {
      return result([...this.skillRanks].map(([skill_id, row]) => ({ skill_id, ...row }) as unknown as T));
    }
    if (sql.startsWith("SELECT specialization_id, rank, points_spent, grandfathered")) {
      return result([...this.specializationRanks].map(([specialization_id, row]) => ({ specialization_id, ...row }) as unknown as T));
    }
    if (sql.startsWith("SELECT specialization_id, mastery_quest_id FROM player_specialization_ultimate_unlocks")) {
      return result([...this.ultimateUnlocks].map(([specialization_id, mastery_quest_id]) => ({ specialization_id, mastery_quest_id }) as unknown as T));
    }
    if (sql.startsWith("SELECT committed_specialization_id, active_specialization_id")) {
      return result([{ committed_specialization_id: this.committedSpecializationId, active_specialization_id: this.activeSpecializationId, equipped_class_technique_id: null } as unknown as T]);
    }
    if (sql.startsWith("SELECT slot_one_skill_id, slot_two_skill_id")) {
      return result([{
        slot_one_skill_id: this.generalActiveLoadout[0],
        slot_two_skill_id: this.generalActiveLoadout[1]
      } as unknown as T]);
    }
    if (sql.startsWith("SELECT level FROM player_progression_profiles")) {
      return result([{ level: this.level } as unknown as T]);
    }
    if (sql.startsWith("SELECT cooldown_ends_at FROM player_skill_runtime")) {
      return result([{ cooldown_ends_at: this.cooldownEndsAt } as unknown as T]);
    }
    throw new Error(`Unhandled SkillDatabase query: ${sql}`);
  }

  private backup() {
    return {
      totalEarned: this.totalEarned,
      totalSpent: this.totalSpent,
      revision: this.revision,
      skillRanks: structuredClone(this.skillRanks),
      specializationRanks: structuredClone(this.specializationRanks),
      committedSpecializationId: this.committedSpecializationId,
      activeSpecializationId: this.activeSpecializationId,
      operations: structuredClone(this.operations)
    };
  }

  private restore(backup: ReturnType<SkillDatabase["backup"]>): void {
    this.totalEarned = backup.totalEarned;
    this.totalSpent = backup.totalSpent;
    this.revision = backup.revision;
    this.skillRanks.clear();
    for (const entry of backup.skillRanks) this.skillRanks.set(...entry);
    this.specializationRanks.clear();
    for (const entry of backup.specializationRanks) this.specializationRanks.set(...entry);
    this.committedSpecializationId = backup.committedSpecializationId;
    this.activeSpecializationId = backup.activeSpecializationId;
    this.operations.clear();
    for (const entry of backup.operations) this.operations.set(...entry);
  }
}

function result<T extends pg.QueryResultRow>(rows: T[] = []): pg.QueryResult<T> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows
  };
}

class RuntimePersistencePool {
  readonly pool: pg.Pool;
  queryCount = 0;
  persisted: {
    cooldownEndsAt: Record<string, number>;
    statusEffects: unknown[];
    counters: Record<string, unknown>;
    engagedTarget: Record<string, unknown> | null;
    combatGeneration: number;
    revision: number;
  } | null = null;

  constructor() {
    this.pool = {
      query: async (_sql: string, values: readonly unknown[] = []) => {
        this.queryCount += 1;
        const combatGeneration = Number(values[5]);
        const revision = Number(values[6]);
        const current = this.persisted;
        const newer = current === null
          || combatGeneration > current.combatGeneration
          || (combatGeneration === current.combatGeneration && revision > current.revision);
        if (!newer) return result();
        this.persisted = {
          cooldownEndsAt: JSON.parse(String(values[1])),
          statusEffects: JSON.parse(String(values[2])),
          counters: JSON.parse(String(values[3])),
          engagedTarget: values[4] === null ? null : JSON.parse(String(values[4])),
          combatGeneration,
          revision
        };
        return result([{ player_id: String(values[0]) }]);
      }
    } as unknown as pg.Pool;
  }
}
