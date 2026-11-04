import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  SPECIALIZATION_IDS,
  isSpecializationAvailable,
  requireSpecializationDefinition
} from "@ash-atlas/shared";

import type { SkillRequestError } from "./skillAuthority.js";
import { SpecializationService } from "./specializationService.js";

/** The ranked classes are hidden on the launch roster (Ronin, Warrior); these tests reach them through the full roster. */
const FULL_ROSTER = { fullClassRosterEnabled: true } as const;

describe("SpecializationService free class switch (Ronin, Warrior)", () => {
  it("equips Ronin, switches to Warrior and unequips, instantly and for free", async () => {
    const database = new SpecializationDatabase({ totalSpent: 0, characterLevel: 1, generalRanks: {} });
    const service = new SpecializationService(database.pool);

    const ronin = await service.activateSpecialization(database.playerId, "ronin", "pick-ronin", 0, { inCombat: true, hasUnresolvedAction: true });
    expect(ronin.snapshot).toMatchObject({ committedSpecializationId: "ronin", activeSpecializationId: "ronin", pointState: { totalSpent: 0 } });
    expect(database.ranks.get("ronin")).toEqual({ rank: 0, points_spent: 0, grandfathered: false });

    const warrior = await service.activateSpecialization(database.playerId, "warrior", "pick-warrior", ronin.snapshot.revision, {});
    expect(warrior.snapshot).toMatchObject({ committedSpecializationId: "warrior", activeSpecializationId: "warrior", pointState: { totalSpent: 0 } });
    expect(database.ranks.get("warrior")).toEqual({ rank: 0, points_spent: 0, grandfathered: false });

    const none = await service.activateSpecialization(database.playerId, null, "unequip", warrior.snapshot.revision, {});
    expect(none.snapshot).toMatchObject({ committedSpecializationId: null, activeSpecializationId: null, pointState: { totalSpent: 0 } });
    expect(database.totalSpent).toBe(0);

    await expect(service.activateSpecialization(database.playerId, null, "unequip", warrior.snapshot.revision, {}))
      .resolves.toMatchObject({ replayed: true });
  });

  it("keeps an existing ranked Warrior's rank and does not re-activate it after an unequip", async () => {
    const database = new SpecializationDatabase({
      committedSpecializationId: "warrior", activeSpecializationId: "warrior", totalSpent: 3,
      ranks: new Map([["warrior", { rank: 3, points_spent: 3, grandfathered: false }]])
    });
    const service = new SpecializationService(database.pool);
    const dropped = await service.activateSpecialization(database.playerId, null, "drop-warrior", 0, {});
    await expect(service.getOrCreate(database.playerId)).resolves.toMatchObject({ committedSpecializationId: null, activeSpecializationId: null });
    const back = await service.activateSpecialization(database.playerId, "warrior", "warrior-again", dropped.snapshot.revision, {});
    expect(back.snapshot).toMatchObject({ activeSpecializationId: "warrior", pointState: { totalSpent: 3 } });
    expect(database.ranks.get("warrior")).toEqual({ rank: 3, points_spent: 3, grandfathered: false });
  });

  it("reads a player on a hidden class as no class and leaves the hidden class data alone when they pick Ronin", async () => {
    const database = new SpecializationDatabase({
      committedSpecializationId: "knight", activeSpecializationId: "knight", totalSpent: 3,
      ranks: new Map([["knight", { rank: 3, points_spent: 3, grandfathered: false }]])
    });
    const service = new SpecializationService(database.pool);
    const loaded = await service.getOrCreate(database.playerId);
    expect(loaded).toMatchObject({ activeSpecializationId: null });
    expect(database.activeSpecializationId).toBe("knight");

    await expect(service.spendSpecializationPoint(database.playerId, "knight", "knight-hidden", 0))
      .rejects.toMatchObject({ code: "SPECIALIZATION_RUNTIME_UNAVAILABLE" } satisfies Partial<SkillRequestError>);
    await expect(service.activateSpecialization(database.playerId, "knight", "knight-activate", 0, {}))
      .rejects.toMatchObject({ code: "SPECIALIZATION_RUNTIME_UNAVAILABLE" } satisfies Partial<SkillRequestError>);

    const ronin = await service.activateSpecialization(database.playerId, "ronin", "knight-to-ronin", loaded.revision, {});
    // Knight is hidden, so its 3 spent points already read as available.
    expect(ronin.snapshot).toMatchObject({ committedSpecializationId: "ronin", activeSpecializationId: "ronin", pointState: { totalSpent: 0 } });
    expect(ronin.replacementAudit).toBeUndefined();
    expect(database.ranks.get("knight")).toEqual({ rank: 3, points_spent: 3, grandfathered: false });
  });
});

describe("SpecializationService hidden-class replacement", () => {
  it("buys a Warrior rank over a hidden class without refunding its points twice or touching its row", async () => {
    // The owner's account: committed to Ninja (hidden) with 3 points in it, level 24.
    const database = new SpecializationDatabase({
      committedSpecializationId: "ninja", activeSpecializationId: "ninja", totalSpent: 3, characterLevel: 24,
      ranks: new Map([["ninja", { rank: 3, points_spent: 3, grandfathered: false }]])
    });
    const service = new SpecializationService(database.pool);
    const before = await service.getOrCreate(database.playerId);
    expect(before.pointState).toMatchObject({ totalEarned: 24, totalSpent: 0, available: 24 });

    const warrior = await service.spendSpecializationPoint(database.playerId, "warrior", "ninja-to-warrior", before.revision);
    expect(warrior.snapshot).toMatchObject({
      committedSpecializationId: "warrior", activeSpecializationId: "warrior",
      pointState: { totalSpent: 1, available: 23 }
    });
    expect(warrior.replacementAudit).toEqual({ priorClassId: "ninja", refundedPoints: 3 });
    expect(database.ranks.get("ninja")).toEqual({ rank: 3, points_spent: 3, grandfathered: false });
  });
});

describe("SpecializationService single-class commitment authority", () => {
  it("gates class ranks by character level, then reports the gateway", async () => {
    const lowLevelStarter = new SpecializationDatabase({ totalSpent: 0, characterLevel: 8 });
    await expect(new SpecializationService(lowLevelStarter.pool).spendSpecializationPoint(
      lowLevelStarter.playerId, "warrior", "starter-rank-1-early", 0
    )).rejects.toMatchObject({ code: "SPECIALIZATION_LEVEL_REQUIRED", message: expect.stringContaining("level 9") } satisfies Partial<SkillRequestError>);
    lowLevelStarter.characterLevel = 9;
    await expect(new SpecializationService(lowLevelStarter.pool).spendSpecializationPoint(
      lowLevelStarter.playerId, "warrior", "starter-rank-1", 0
    )).resolves.toMatchObject({ snapshot: { committedSpecializationId: "warrior" } });

    const belowRankTwo = new SpecializationDatabase({
      totalSpent: 3, characterLevel: 13,
      committedSpecializationId: "warrior", activeSpecializationId: "warrior",
      ranks: new Map([["warrior", { rank: 1, points_spent: 1, grandfathered: false }]])
    });
    await expect(new SpecializationService(belowRankTwo.pool).spendSpecializationPoint(
      belowRankTwo.playerId, "warrior", "rank-2-early", 0
    )).rejects.toMatchObject({ code: "SPECIALIZATION_LEVEL_REQUIRED", message: expect.stringContaining("level 14") } satisfies Partial<SkillRequestError>);
    belowRankTwo.characterLevel = 14;
    await expect(new SpecializationService(belowRankTwo.pool).spendSpecializationPoint(
      belowRankTwo.playerId, "warrior", "rank-2-ok", 0
    )).resolves.toMatchObject({ snapshot: { committedSpecializationId: "warrior" } });

    const belowRankOneLevel = new SpecializationDatabase({
      totalSpent: 3, characterLevel: 8, generalRanks: { cleave: 3, archery: 3, martial_arts: 3, tactics: 3 }
    });
    await expect(new SpecializationService(belowRankOneLevel.pool, FULL_ROSTER).spendSpecializationPoint(
      belowRankOneLevel.playerId, "knight", "knight-low-level", 0
    )).rejects.toMatchObject({ code: "SPECIALIZATION_LEVEL_REQUIRED", message: expect.stringContaining("level 9") } satisfies Partial<SkillRequestError>);

    const belowGateway = new SpecializationDatabase({
      totalSpent: 3,
      characterLevel: 10,
      generalRanks: { cleave: 2, archery: 3, martial_arts: 3, tactics: 3 }
    });
    await expect(new SpecializationService(belowGateway.pool, FULL_ROSTER).spendSpecializationPoint(
      belowGateway.playerId, "knight", "gateway", 0
    )).rejects.toMatchObject({ code: "SPECIALIZATION_GATEWAY_REQUIRED" } satisfies Partial<SkillRequestError>);
  });

  it("lets starters commit without their gateway skill and requires it for every other class", async () => {
    for (const starter of ["warrior", "ranger"] as const) {
      const database = new SpecializationDatabase({ totalSpent: 3, characterLevel: 10, generalRanks: { cleave: 0, archery: 0 } });
      await expect(new SpecializationService(database.pool, FULL_ROSTER).spendSpecializationPoint(database.playerId, starter, "starter-" + starter, 0))
        .resolves.toMatchObject({ snapshot: { committedSpecializationId: starter, activeSpecializationId: starter } });
    }
    for (const [id, skill] of [["knight", "cleave"], ["sentinel", "archery"], ["mercenary", "archery"], ["monk", "martial_arts"], ["ninja", "martial_arts"], ["druid", "tactics"], ["legionnaire", "cleave"], ["assassin", "martial_arts"], ["rogue", "martial_arts"], ["merchant", "tactics"], ["artificer", "tactics"], ["voyager", "tactics"]] as const) {
      const blocked = new SpecializationDatabase({ totalSpent: 3, characterLevel: 10, generalRanks: { [skill]: 2 } });
      await expect(new SpecializationService(blocked.pool, FULL_ROSTER).spendSpecializationPoint(blocked.playerId, id, "blocked-" + id, 0))
        .rejects.toMatchObject({ code: "SPECIALIZATION_GATEWAY_REQUIRED" } satisfies Partial<SkillRequestError>);
      expect(blocked.committedSpecializationId).toBeNull();
      const open = new SpecializationDatabase({ totalSpent: 3, characterLevel: 10, generalRanks: { [skill]: 3 } });
      await expect(new SpecializationService(open.pool, FULL_ROSTER).spendSpecializationPoint(open.playerId, id, "open-" + id, 0))
        .resolves.toMatchObject({ snapshot: { committedSpecializationId: id } });
    }
  });

  it("loads existing players committed to each previously launched class with their data unchanged", async () => {
    for (const id of ["warrior", "ranger", "knight", "ninja", "druid"] as const) {
      const database = new SpecializationDatabase({
        committedSpecializationId: id, activeSpecializationId: id, totalSpent: 7,
        ranks: new Map([[id, { rank: 3, points_spent: 3, grandfathered: false }]])
      });
      // Only Warrior is still on the roster; a hidden class reads as no active class with no ranks (row kept below).
      await expect(new SpecializationService(database.pool).getOrCreate(database.playerId)).resolves.toMatchObject({
        committedSpecializationId: id, activeSpecializationId: id === "warrior" ? id : null,
        specializations: expect.arrayContaining([expect.objectContaining(
          id === "warrior" ? { specializationId: id, rank: 3, pointsSpent: 3 } : { specializationId: id, rank: 0, pointsSpent: 0 }
        )])
      });
      expect(database.ranks.get(id)).toEqual({ rank: 3, points_spent: 3, grandfathered: false });
    }
  });

  it("rejects custom class techniques for the first five classes", async () => {
    const database = new SpecializationDatabase({
      committedSpecializationId: "warrior",
      activeSpecializationId: "warrior",
      ranks: new Map([["warrior", { rank: 3, points_spent: 3, grandfathered: false }]])
    });
    const service = new SpecializationService(database.pool);

    await expect(service.equipClassTechnique(
      database.playerId, "v3_warrior_anger_explosion", "equip", 0, {}
    )).rejects.toMatchObject({ code: "CLASS_TECHNIQUES_DISABLED" });
    await expect(service.equipClassTechnique(
      database.playerId, "v3_warrior_is_that_it", "restricted", 0, { inCombat: true }
    )).rejects.toMatchObject({ code: "CLASS_TECHNIQUES_DISABLED" } satisfies Partial<SkillRequestError>);
  });

  it("commits and activates the first Rank-1 purchase and immediately locks spending in other classes", async () => {
    const database = new SpecializationDatabase({ totalSpent: 20, characterLevel: 33 });
    const service = new SpecializationService(database.pool, FULL_ROSTER);

    const result = await service.spendSpecializationPoint(database.playerId, "warrior", "spend-warrior", 0);
    expect(result.snapshot).toMatchObject({
      committedSpecializationId: "warrior",
      activeSpecializationId: "warrior",
      pointState: { totalSpent: 21, revision: 1 }
    });
    expect(database.ranks.get("warrior")).toMatchObject({ rank: 1, points_spent: 1 });
    await expect(service.spendSpecializationPoint(
      database.playerId, "warrior", "spend-warrior", 0
    )).resolves.toMatchObject({ replayed: true, snapshot: { committedSpecializationId: "warrior" } });
    expect(database.totalSpent).toBe(21);
    expect(database.revision).toBe(1);
    await expect(service.spendSpecializationPoint(
      database.playerId, "knight", "spend-knight", 1
    )).rejects.toMatchObject({ code: "SPECIALIZATION_COMMITMENT_LOCKED" } satisfies Partial<SkillRequestError>);
    expect(database.totalSpent).toBe(21);
    expect(database.ranks.has("knight")).toBe(false);

    await service.spendSpecializationPoint(database.playerId, "warrior", "spend-warrior-2", 1);
    await service.spendSpecializationPoint(database.playerId, "warrior", "spend-warrior-3", 2);
    await service.spendSpecializationPoint(database.playerId, "warrior", "spend-warrior-4", 3);
    const maximum = await service.spendSpecializationPoint(database.playerId, "warrior", "spend-warrior-5", 4);
    expect(maximum.snapshot).toMatchObject({ committedSpecializationId: "warrior" });
    expect(database.ranks.get("warrior")?.rank).toBe(5);
  });

  it("rejects activation of a ranked class outside the commitment", async () => {
    const database = new SpecializationDatabase({
      committedSpecializationId: "warrior",
      activeSpecializationId: "warrior",
      ranks: new Map([["warrior", { rank: 1, points_spent: 0, grandfathered: true }]])
    });
    const service = new SpecializationService(database.pool, FULL_ROSTER);

    database.ranks.set("ranger", { rank: 1, points_spent: 0, grandfathered: true });
    await expect(service.activateSpecialization(
      database.playerId, "ranger", "activate-ranger", 0, {}
    )).rejects.toMatchObject({ code: "SPECIALIZATION_COMMITMENT_LOCKED" } satisfies Partial<SkillRequestError>);
    expect(database.activeSpecializationId).toBe("warrior");
  });

  it("rejects an initial class commitment under an activation restriction without spending", async () => {
    const database = new SpecializationDatabase({ totalSpent: 20 });
    await expect(new SpecializationService(database.pool).spendSpecializationPoint(
      database.playerId, "warrior", "restricted-commitment", 0, { inCombat: true }
    )).rejects.toMatchObject({ code: "SPECIALIZATION_ACTIVATION_RESTRICTED" } satisfies Partial<SkillRequestError>);
    expect(database.committedSpecializationId).toBeNull();
    expect(database.activeSpecializationId).toBeNull();
    expect(database.ranks.has("warrior")).toBe(false);
    expect(database.totalSpent).toBe(20);
  });

  it("repairs a committed launch class with a learned rank and no active class", async () => {
    const database = new SpecializationDatabase({
      committedSpecializationId: "warrior",
      ranks: new Map([["warrior", { rank: 1, points_spent: 1, grandfathered: false }]])
    });
    await expect(new SpecializationService(database.pool).getOrCreate(database.playerId))
      .resolves.toMatchObject({ committedSpecializationId: "warrior", activeSpecializationId: "warrior" });
    expect(database.activeSpecializationId).toBe("warrior");
  });

  it("rejects non-null activation while uncommitted even when a retained class rank exists", async () => {
    const database = new SpecializationDatabase({
      ranks: new Map([
        ["warrior", { rank: 2, points_spent: 0, grandfathered: true }],
        ["ranger", { rank: 1, points_spent: 0, grandfathered: true }]
      ])
    });
    await expect(new SpecializationService(database.pool, FULL_ROSTER).activateSpecialization(
      database.playerId, "ranger", "activate-uncommitted", 0, {}
    )).rejects.toMatchObject({ code: "SPECIALIZATION_COMMITMENT_LOCKED" } satisfies Partial<SkillRequestError>);
    expect(database.activeSpecializationId).toBeNull();
    expect(database.committedSpecializationId).toBeNull();
  });

  it("commits and activates a full-roster class at Rank 1", async () => {
    const database = new SpecializationDatabase({ totalSpent: 20 });
    const service = new SpecializationService(database.pool, { fullClassRosterEnabled: true });

    const committed = await service.spendSpecializationPoint(database.playerId, "knight", "knight-1", 0);
    expect(committed.snapshot).toMatchObject({
      fullClassRosterEnabled: true,
      committedSpecializationId: "knight",
      activeSpecializationId: "knight",
      ultimatesEnabled: false,
      ultimate: null
    });

  });

  it("commits and trains every capability-enabled class through Rank 5", async () => {
    for (const specializationId of SPECIALIZATION_IDS.filter((id) =>
      isSpecializationAvailable(id, { fullClassRosterEnabled: true, ultimatesEnabled: false })
      && requireSpecializationDefinition(id).ranks.length > 0
    )) {
      const database = new SpecializationDatabase({
        totalSpent: 16,
        characterLevel: 33,
        generalRanks: { cleave: 3, archery: 3, martial_arts: 3, tactics: 3 }
      });
      const service = new SpecializationService(database.pool, { fullClassRosterEnabled: true });
      const definition = requireSpecializationDefinition(specializationId);

      const activated = await service.spendSpecializationPoint(database.playerId, specializationId, `${specializationId}-rank-1`, 0);
      expect(activated.snapshot).toMatchObject({
        committedSpecializationId: specializationId,
        activeSpecializationId: specializationId
      });

      await service.spendSpecializationPoint(database.playerId, specializationId, `${specializationId}-rank-2`, 1);
      await service.spendSpecializationPoint(
        database.playerId,
        specializationId,
        `${specializationId}-rank-3`,
        2
      );
      await service.spendSpecializationPoint(database.playerId, specializationId, `${specializationId}-rank-4`, 3);
      const maximum = await service.spendSpecializationPoint(
        database.playerId,
        specializationId,
        `${specializationId}-rank-5`,
        4
      );

      expect(maximum.snapshot).toMatchObject({
        activeSpecializationId: specializationId,
        committedSpecializationId: specializationId,
        fullClassRosterEnabled: true
      });
      expect(database.ranks.get(specializationId)).toEqual({
        rank: 5,
        points_spent: definition.ranks.reduce((total, rank) => total + rank.cost, 0),
        grandfathered: false
      });
    }
  });

  it("loads a player with stored Ultimate and Class Technique references as if they were never set", async () => {
    const database = new SpecializationDatabase({
      committedSpecializationId: "warrior",
      activeSpecializationId: "warrior",
      equippedTechniqueId: "v3_warrior_anger_explosion",
      ranks: new Map([["warrior", { rank: 5, points_spent: 0, grandfathered: true }]])
    });
    database.ultimateUnlocks.set("warrior", { masteryQuestId: "warrior_mastery_trial", completionIdentity: "trial:warrior:1" });
    const service = new SpecializationService(database.pool);
    await expect(service.getOrCreate(database.playerId)).resolves.toMatchObject({
      equippedClassTechniqueId: null,
      ultimatesEnabled: false,
      ultimate: null,
      specializations: expect.arrayContaining([expect.objectContaining({
        specializationId: "warrior", rank: 5, masteryQuestCompleted: false
      })])
    });
  });
});

type RankRow = { rank: number; points_spent: number; grandfathered: boolean };
type OperationRow = { player_id: string; action: string; payload: unknown; result: unknown; completed_at: string | null };

class SpecializationDatabase {
  readonly playerId = "player-1";
  readonly pool: pg.Pool;
  readonly ranks: Map<string, RankRow>;
  readonly operations = new Map<string, OperationRow>();
  readonly ultimateUnlocks = new Map<string, { masteryQuestId: string; completionIdentity: string }>();
  readonly completionBindings = new Map<string, { specializationId: string; masteryQuestId: string }>();
  committedSpecializationId: string | null;
  activeSpecializationId: string | null;
  equippedTechniqueId: string | null;
  characterLevel: number;
  generalRanks: Record<string, number>;
  totalSpent: number;
  readonly generalSpent: number;
  revision = 0;
  private transactionBackup: ReturnType<SpecializationDatabase["backup"]> | null = null;

  constructor(options: {
    committedSpecializationId?: string | null;
    activeSpecializationId?: string | null;
    totalSpent?: number;
    equippedTechniqueId?: string | null;
    characterLevel?: number;
    generalRanks?: Record<string, number>;
    ranks?: Map<string, RankRow>;
  } = {}) {
    this.committedSpecializationId = options.committedSpecializationId ?? null;
    this.activeSpecializationId = options.activeSpecializationId ?? null;
    this.totalSpent = options.totalSpent ?? 0;
    this.equippedTechniqueId = options.equippedTechniqueId ?? null;
    this.characterLevel = options.characterLevel ?? 25;
    this.generalRanks = options.generalRanks ?? {
      cleave: 3, archery: 3, martial_arts: 3, tactics: 3
    };
    this.ranks = options.ranks ?? new Map();
    // Points the fixture's total holds outside class ranks (general skills, which this fake does not itemize).
    this.generalSpent = Math.max(0, this.totalSpent - [...this.ranks.values()].reduce((sum, row) => sum + row.points_spent, 0));
    this.pool = { connect: async () => ({ query: this.query.bind(this), release: () => undefined }) } as unknown as pg.Pool;
  }

  private async query<T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<pg.QueryResult<T>> {
    const sql = query.replace(/\s+/gu, " ").trim();
    if (sql === "BEGIN") { this.transactionBackup = this.backup(); return result(); }
    if (sql === "COMMIT") { this.transactionBackup = null; return result(); }
    if (sql === "ROLLBACK") { if (this.transactionBackup) this.restore(this.transactionBackup); this.transactionBackup = null; return result(); }
    if (sql.startsWith("INSERT INTO player_skill_point_state") || sql.startsWith("INSERT INTO player_specialization_state")
      || sql.startsWith("INSERT INTO player_general_active_loadouts") || sql.startsWith("INSERT INTO player_skill_runtime")) return result();
    if (sql.includes("FROM skill_point_operations WHERE operation_key = $1")) {
      const row = this.operations.get(String(values[0]));
      return result(row ? [row as unknown as T] : []);
    }
    if (sql.startsWith("INSERT INTO skill_point_operations")) {
      const key = String(values[0]);
      if (this.operations.has(key)) return result();
      this.operations.set(key, { player_id: this.playerId, action: String(values[2]), payload: JSON.parse(String(values[3])), result: null, completed_at: null });
      return result([{ operation_key: key } as unknown as T]);
    }
    if (sql.startsWith("UPDATE skill_point_operations SET result")) {
      const row = this.operations.get(String(values[0]))!;
      row.result = JSON.parse(String(values[1])); row.completed_at = new Date().toISOString();
      return result([{} as T]);
    }
    if (sql.includes("FROM player_skill_point_state AS state")) return result([{
      player_id: this.playerId, total_earned: Math.max(this.characterLevel, this.totalSpent), total_spent: this.totalSpent, revision: this.revision, character_level: this.characterLevel
    } as unknown as T]);
    if (sql.startsWith("UPDATE player_skill_point_state SET total_earned = $2, total_spent = $3")) {
      this.totalSpent = Number(values[2]);
      this.revision += 1;
      return result([{ player_id: this.playerId, total_earned: Number(values[1]), total_spent: this.totalSpent, revision: this.revision } as unknown as T]);
    }
    if (sql.startsWith("SELECT ( COALESCE((SELECT SUM(points_spent)")) {
      // VISIBLE_SPENT_POINTS_SQL: rank rows of hidden classes ($3) do not count.
      const hiddenClasses = new Set((values[2] ?? []) as readonly string[]);
      const classSpent = [...this.ranks].filter(([id]) => !hiddenClasses.has(id)).reduce((sum, [, row]) => sum + row.points_spent, 0);
      return result([{ total_spent: this.generalSpent + classSpent } as unknown as T]);
    }
    if (sql.startsWith("UPDATE player_specialization_state AS state")) {
      const launchIds = values[1] as readonly string[];
      if (this.activeSpecializationId === null && this.committedSpecializationId !== null
        && launchIds.includes(this.committedSpecializationId)
        && (this.ranks.get(this.committedSpecializationId)?.rank ?? 0) > 0) {
        this.activeSpecializationId = this.committedSpecializationId;
      }
      return result();
    }
    if (sql.startsWith("SELECT committed_specialization_id FROM player_specialization_state")) {
      return result([{ committed_specialization_id: this.committedSpecializationId } as unknown as T]);
    }
    if (sql.startsWith("INSERT INTO specialization_ultimate_completion_identities")) {
      const identity = String(values[0]);
      if (!this.completionBindings.has(identity)) this.completionBindings.set(identity, { specializationId: String(values[2]), masteryQuestId: String(values[3]) });
      return result([{} as T]);
    }
    if (sql.startsWith("SELECT player_id, specialization_id, mastery_quest_id FROM specialization_ultimate_completion_identities")) {
      const row = this.completionBindings.get(String(values[0]));
      return result(row ? [{ player_id: this.playerId, specialization_id: row.specializationId, mastery_quest_id: row.masteryQuestId } as unknown as T] : []);
    }
    if (sql.startsWith("SELECT mastery_quest_id, completion_identity FROM player_specialization_ultimate_unlocks")) {
      const row = this.ultimateUnlocks.get(String(values[1]));
      return result(row ? [{ mastery_quest_id: row.masteryQuestId, completion_identity: row.completionIdentity } as unknown as T] : []);
    }
    if (sql.startsWith("SELECT specialization_id FROM player_specialization_ranks") && sql.includes("rank > 0 FOR UPDATE")) {
      return result([...this.ranks].filter(([, row]) => row.rank > 0).map(([specialization_id]) => ({ specialization_id }) as unknown as T));
    }
    if (sql.startsWith("SELECT rank, points_spent, grandfathered FROM player_specialization_ranks")) {
      const row = this.ranks.get(String(values[1])); return result(row ? [{ ...row } as unknown as T] : []);
    }
    if (sql.startsWith("SELECT points_spent FROM player_specialization_ranks")) {
      const row = this.ranks.get(String(values[1])); return result(row ? [{ points_spent: row.points_spent } as unknown as T] : []);
    }
    if (sql.startsWith("SELECT rank, grandfathered FROM player_specialization_ranks")) {
      const row = this.ranks.get(String(values[1])); return result(row?.rank ? [{ rank: row.rank, grandfathered: row.grandfathered } as unknown as T] : []);
    }
    if (sql.startsWith("SELECT rank FROM player_specialization_ranks")) {
      const row = this.ranks.get(String(values[1])); return result(row ? [{ rank: row.rank } as unknown as T] : []);
    }
    if (sql.startsWith("SELECT level FROM player_progression_profiles")) return result([{ level: this.characterLevel } as unknown as T]);
    if (sql.startsWith("SELECT skill_id, rank FROM player_skill_ranks")) return result(
      Object.entries(this.generalRanks).map(([skill_id, rank]) => ({ skill_id, rank })) as unknown as T[]
    );
    if (sql.startsWith("INSERT INTO player_specialization_ranks") && sql.includes("DO NOTHING")) {
      const id = String(values[1]);
      if (!this.ranks.has(id)) this.ranks.set(id, { rank: 0, points_spent: 0, grandfathered: false });
      return result();
    }
    if (sql.startsWith("INSERT INTO player_specialization_ranks")) {
      const id = String(values[1]), cost = Number(values[2]), current = this.ranks.get(id);
      this.ranks.set(id, { rank: (current?.rank ?? 0) + 1, points_spent: (current?.points_spent ?? 0) + cost, grandfathered: current?.grandfathered ?? false });
      return result([{} as T]);
    }
    if (sql.startsWith("UPDATE player_specialization_ranks SET points_spent = 0")) {
      const row = this.ranks.get(String(values[1])); if (row) row.points_spent = 0; return result([{} as T]);
    }
    if (sql.startsWith("UPDATE player_specialization_state SET committed_specialization_id")) {
      if (this.committedSpecializationId === null || this.committedSpecializationId === values[2] || !sql.includes("$3")) {
        this.committedSpecializationId = values[1] === null ? null : String(values[1]);
        this.activeSpecializationId = values[1] === null ? null : String(values[1]);
      }
      return result([{} as T]);
    }
    if (sql.startsWith("UPDATE player_skill_point_state SET total_spent")) {
      this.totalSpent += Number(values[1]); this.revision += 1; return result([{ player_id: this.playerId } as unknown as T]);
    }
    if (sql.startsWith("INSERT INTO player_specialization_ultimate_unlocks")) {
      this.ultimateUnlocks.set(String(values[1]), { masteryQuestId: String(values[2]), completionIdentity: String(values[3]) });
      return result([{} as T]);
    }
    if (sql.startsWith("SELECT committed_specialization_id, active_specialization_id") || sql.startsWith("SELECT active_specialization_id, committed_specialization_id")) {
      return result([{ committed_specialization_id: this.committedSpecializationId, active_specialization_id: this.activeSpecializationId, equipped_class_technique_id: this.equippedTechniqueId } as unknown as T]);
    }
    if (sql.startsWith("SELECT 1 FROM player_specialization_ranks")) return result((this.ranks.get(String(values[1]))?.rank ?? 0) > 0 ? [{} as T] : []);
    if (sql.startsWith("UPDATE player_specialization_state SET active_specialization_id")) {
      this.activeSpecializationId = values[1] === null ? null : String(values[1]); return result([{} as T]);
    }
    if (sql.startsWith("SELECT active_specialization_id FROM player_specialization_state")) {
      return result([{ active_specialization_id: this.activeSpecializationId } as unknown as T]);
    }
    if (sql.startsWith("UPDATE player_specialization_state SET equipped_class_technique_id = $2")) {
      this.equippedTechniqueId = String(values[1]); return result([{} as T]);
    }
    if (sql.startsWith("UPDATE player_specialization_state SET equipped_class_technique_id = NULL")) {
      this.equippedTechniqueId = null; return result([{} as T]);
    }
    if (sql.startsWith("SELECT player_id, total_earned, total_spent, revision FROM player_skill_point_state")) {
      return result([{ player_id: this.playerId, total_earned: Math.max(this.characterLevel, this.totalSpent), total_spent: this.totalSpent, revision: this.revision } as unknown as T]);
    }
    if (sql.startsWith("SELECT skill_id, rank, points_spent, grandfathered FROM player_skill_ranks")) return result();
    if (sql.startsWith("SELECT specialization_id, rank, points_spent, grandfathered")) {
      return result([...this.ranks].map(([specialization_id, row]) => ({ specialization_id, ...row }) as unknown as T));
    }
    if (sql.startsWith("SELECT specialization_id, mastery_quest_id FROM player_specialization_ultimate_unlocks")) {
      return result([...this.ultimateUnlocks].map(([specialization_id, row]) => ({ specialization_id, mastery_quest_id: row.masteryQuestId }) as unknown as T));
    }
    if (sql.startsWith("SELECT slot_one_skill_id, slot_two_skill_id")) return result([{ slot_one_skill_id: null, slot_two_skill_id: null } as unknown as T]);
    // Class writs are covered by the PostgreSQL integration test; here every writ counts as paid.
    if (sql.includes("FROM player_skill_world_unlocks WHERE player_id = $1 AND skill_id = $2")) return result([{} as T]);
    if (sql.includes("FROM player_skill_world_unlocks WHERE player_id = $1")) return result();
    if (sql.startsWith("SELECT cooldown_ends_at FROM player_skill_runtime")) return result([{ cooldown_ends_at: {} } as unknown as T]);
    throw new Error(`Unhandled SpecializationDatabase query: ${sql}`);
  }

  private backup() { return { committed: this.committedSpecializationId, active: this.activeSpecializationId, equippedTechniqueId: this.equippedTechniqueId, totalSpent: this.totalSpent, revision: this.revision, ranks: structuredClone(this.ranks), operations: structuredClone(this.operations), ultimateUnlocks: structuredClone(this.ultimateUnlocks), completionBindings: structuredClone(this.completionBindings) }; }
  private restore(backup: ReturnType<SpecializationDatabase["backup"]>): void {
    this.committedSpecializationId = backup.committed; this.activeSpecializationId = backup.active; this.equippedTechniqueId = backup.equippedTechniqueId; this.totalSpent = backup.totalSpent; this.revision = backup.revision;
    this.ranks.clear(); for (const entry of backup.ranks) this.ranks.set(...entry);
    this.operations.clear(); for (const entry of backup.operations) this.operations.set(...entry);
    this.ultimateUnlocks.clear(); for (const entry of backup.ultimateUnlocks) this.ultimateUnlocks.set(...entry);
    this.completionBindings.clear(); for (const entry of backup.completionBindings) this.completionBindings.set(...entry);
  }
}

function result<T extends pg.QueryResultRow>(rows: T[] = []): pg.QueryResult<T> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}
