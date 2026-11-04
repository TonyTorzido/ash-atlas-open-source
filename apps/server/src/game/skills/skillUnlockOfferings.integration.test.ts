import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CLASS_WRITS, GENERAL_SKILL_OFFERINGS, WORLD_KNOWLEDGE_OVERWORLD_PARTS, type ResourceType } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { DungeonSkillService } from "../dungeonSkills.js";
import { InventoryService } from "../inventory.js";
import { offerGeneralSkill } from "./skillOfferings.js";
import { SkillService } from "./skillService.js";
import { SpecializationService } from "./specializationService.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "1061_skill_unlock_offering_grandfather.sql";

/**
 * Mob value pass step C against PostgreSQL: the grandfather migration (populated upgrade plus an
 * empty second run), then one allowed and one denied check per unlock mechanism, a grandfather
 * check and a double-submit check.
 */
describeDatabase("Skill unlock offerings PostgreSQL integration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_unlocks_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: pg.Pool;
  let inventory: InventoryService;
  let skills: SkillService;
  let specializations: SpecializationService;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-unlocks-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-unlocks-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (name !== TARGET_MIGRATION) await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
      await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    inventory = new InventoryService(pool);
    skills = new SkillService(pool, { fullBuildRespecAvailable: true });
    specializations = new SpecializationService(pool, { inventory });
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("grandfathers held ranks on a populated upgrade, is empty on a second run, and never charges them", async () => {
    const veteran = await createPlayer();
    const newcomer = await createPlayer();
    await skills.getOrCreate(veteran);
    await skills.getOrCreate(newcomer);
    await setRanks(veteran, { cleave: [3, 3], pierce_armor: [1, 1] }, { knight: [1, 1] });
    await setRanks(newcomer, { cleave: [1, 1] }, {});

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([TARGET_MIGRATION]);
    await expect(unlockKeys(veteran)).resolves.toEqual(["class_writ:knight", "pierce_armor"]);
    await expect(unlockKeys(newcomer)).resolves.toEqual([]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([]);

    // After a full respec the veteran relearns Pierce Armor and Knight with no items at all.
    await skills.fullBuildRespec(veteran, "respec-1", await revisionOf(veteran));
    await expect(unlockKeys(veteran)).resolves.toEqual(["class_writ:knight", "pierce_armor"]);
    for (const step of ["cleave-a", "cleave-b", "cleave-c"]) {
      await skills.spendGeneralSkillPoint(veteran, "cleave", step, await revisionOf(veteran));
    }
    await skills.spendGeneralSkillPoint(veteran, "pierce_armor", "pierce-again", await revisionOf(veteran));
    await expect(specializations.spendSpecializationPoint(veteran, "knight", "knight-again", await revisionOf(veteran)))
      .resolves.toMatchObject({ snapshot: { committedSpecializationId: "knight" } });
    await expect(itemEvents(veteran)).resolves.toBe(0);
  });

  it("General skill offering: refuses without the items and spends nothing, then discovers once", async () => {
    const player = await createPlayer();
    await skills.getOrCreate(player);
    await setRanks(player, { cleave: [1, 1] }, {});
    const parts = GENERAL_SKILL_OFFERINGS.pierce_armor!.parts;

    // Denied: SP purchase without the offering, then an offering missing one part.
    await expect(skills.spendGeneralSkillPoint(player, "pierce_armor", "early", (await skills.getOrCreate(player)).revision))
      .rejects.toMatchObject({ code: "SKILL_OFFERING_REQUIRED" });
    await grant(player, "fang", 6);
    await expect(offerGeneralSkill(skills, inventory, player, "pierce_armor", "offer-short"))
      .rejects.toMatchObject({ code: "SKILL_OFFERING_ITEMS_REQUIRED", message: expect.stringContaining("2 Shark Tooth (you have 0)") });
    await expect(quantity(player, "fang")).resolves.toBe(6);
    await expect(unlockKeys(player)).resolves.toEqual([]);

    // Allowed, and a concurrent double-submit with a different request id charges exactly once.
    await grant(player, "shark_tooth", 2);
    const results = await Promise.allSettled([
      offerGeneralSkill(skills, inventory, player, "pierce_armor", "offer-a"),
      offerGeneralSkill(skills, inventory, player, "pierce_armor", "offer-b")
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason)
      .toMatchObject({ code: "SKILL_WORLD_ALREADY_REVEALED" });
    for (const part of parts) if (part.kind === "item") await expect(quantity(player, part.itemId)).resolves.toBe(0);
    await expect(unlockKeys(player)).resolves.toEqual(["pierce_armor"]);

    // Replaying the winning request id returns the stored result and charges nothing.
    const winner = results[0]!.status === "fulfilled" ? "offer-a" : "offer-b";
    await grant(player, "fang", 6);
    await grant(player, "shark_tooth", 2);
    await expect(offerGeneralSkill(skills, inventory, player, "pierce_armor", winner)).resolves.toMatchObject({ result: { replayed: true } });
    await expect(quantity(player, "fang")).resolves.toBe(6);

    const snapshot = await skills.getOrCreate(player);
    await expect(skills.spendGeneralSkillPoint(player, "pierce_armor", "learn", snapshot.revision))
      .resolves.toMatchObject({ snapshot: { generalSkills: expect.arrayContaining([{ skillId: "pierce_armor", rank: 1, pointsSpent: 1 }]) } });
  });

  it("Heroism takes any grade 4+ trophy, lowest grade first", async () => {
    const player = await createPlayer();
    await skills.getOrCreate(player);
    await expect(offerGeneralSkill(skills, inventory, player, "heroism", "hero-none"))
      .rejects.toMatchObject({ code: "SKILL_OFFERING_ITEMS_REQUIRED" });
    await grant(player, "stormwing_talon", 1);
    await grant(player, "chimera_horn", 1);
    await offerGeneralSkill(skills, inventory, player, "heroism", "hero-ok");
    await expect(quantity(player, "chimera_horn")).resolves.toBe(0);
    await expect(quantity(player, "stormwing_talon")).resolves.toBe(1);
  });

  it("World Knowledge: the dungeon token alone is refused; token plus overworld part discovers", async () => {
    const player = await createPlayer();
    await skills.getOrCreate(player);
    const dungeonSkills = new DungeonSkillService(pool, inventory, skills);
    await grant(player, "raptor_scale", 6);
    const denied = await dungeonSkills.turnIn(player, "deepstone_lore", "deep-short");
    expect(denied).toMatchObject({ status: "insufficient", message: expect.stringContaining("3 Troll Tooth (you have 0)") });
    await expect(quantity(player, "raptor_scale")).resolves.toBe(6);

    for (const part of WORLD_KNOWLEDGE_OVERWORLD_PARTS.deepstone_lore!.parts) {
      if (part.kind === "item") await grant(player, part.itemId, part.quantity);
    }
    await expect(dungeonSkills.turnIn(player, "deepstone_lore", "deep-ok")).resolves.toMatchObject({ status: "discovered" });
    await expect(quantity(player, "raptor_scale")).resolves.toBe(0);
    await expect(quantity(player, "crude_gem")).resolves.toBe(0);
    await expect(unlockKeys(player)).resolves.toEqual(["deepstone_lore"]);
  });

  it("Rare Beast Mastery: rejects 3 of one trophy, accepts 3 different, debits one each plus 6 Wyrm Eggs", async () => {
    const player = await createPlayer();
    await skills.getOrCreate(player);
    const dungeonSkills = new DungeonSkillService(pool, inventory, skills);
    await grant(player, "wyrm_egg", 6);
    await grant(player, "stormwing_talon", 3);
    await expect(dungeonSkills.turnIn(player, "rare_beast_mastery", "rbm-same")).resolves.toMatchObject({ status: "insufficient" });
    await expect(quantity(player, "wyrm_egg")).resolves.toBe(6);
    await expect(quantity(player, "stormwing_talon")).resolves.toBe(3);

    await grant(player, "chimera_horn", 1);
    await grant(player, "kraken_beak", 2);
    await expect(dungeonSkills.turnIn(player, "rare_beast_mastery", "rbm-ok")).resolves.toMatchObject({ status: "discovered" });
    await expect(quantity(player, "wyrm_egg")).resolves.toBe(0);
    await expect(quantity(player, "stormwing_talon")).resolves.toBe(2);
    await expect(quantity(player, "chimera_horn")).resolves.toBe(0);
    await expect(quantity(player, "kraken_beak")).resolves.toBe(1);
    await expect(unlockKeys(player)).resolves.toEqual(["rare_beast_mastery"]);
  });

  it("Class writ: refused without the writ (no SP, rank or items spent), debited with Rank 1 when held", async () => {
    const player = await createPlayer();
    await skills.getOrCreate(player);
    await setRanks(player, { cleave: [3, 3] }, {});
    await grant(player, "rusted_legion_blade", 5);
    const before = await skills.getOrCreate(player);
    await expect(specializations.spendSpecializationPoint(player, "knight", "knight-short", before.revision))
      .rejects.toMatchObject({ code: "SKILL_OFFERING_ITEMS_REQUIRED" });
    const after = await skills.getOrCreate(player);
    expect(after.pointState.totalSpent).toBe(before.pointState.totalSpent);
    expect(after.committedSpecializationId).toBeNull();
    await expect(quantity(player, "rusted_legion_blade")).resolves.toBe(5);

    await grant(player, "barrow_torc", 3);
    await grant(player, "rimed_draugr_mail", 3);
    await expect(specializations.spendSpecializationPoint(player, "knight", "knight-ok", after.revision))
      .resolves.toMatchObject({ snapshot: { committedSpecializationId: "knight" } });
    for (const part of CLASS_WRITS.knight!.parts) if (part.kind === "item") await expect(quantity(player, part.itemId)).resolves.toBe(0);
    await expect(unlockKeys(player)).resolves.toEqual(["class_writ:knight"]);
    // Rank 2 never asks for the writ again: only its character-level gate (level 15) applies.
    await pool.query("UPDATE player_progression_profiles SET level = 12 WHERE player_id = $1", [player]);
    await expect(specializations.spendSpecializationPoint(player, "knight", "knight-2", await revisionOf(player)))
      .rejects.toMatchObject({ code: "SPECIALIZATION_LEVEL_REQUIRED" });
  });

  async function revisionOf(playerId: string): Promise<number> {
    return (await skills.getOrCreate(playerId)).revision;
  }

  async function createPlayer(): Promise<string> {
    const id = `unlocks-${randomUUID()}`;
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,$1,'world-test',35,-106,35,-106,900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [id]
    );
    await pool.query(
      `INSERT INTO player_progression_profiles (player_id, total_xp, level) VALUES ($1, 1000000, 25)
       ON CONFLICT (player_id) DO UPDATE SET total_xp = EXCLUDED.total_xp, level = EXCLUDED.level`,
      [id]
    );
    return id;
  }

  async function setRanks(
    playerId: string,
    general: Record<string, [number, number]>,
    classes: Record<string, [number, number]>
  ): Promise<void> {
    for (const [skillId, [rank, spent]] of Object.entries(general)) {
      await pool.query(
        `INSERT INTO player_skill_ranks (player_id, skill_id, rank, points_spent, grandfathered, revision)
         VALUES ($1,$2,$3,$4,false,1)`,
        [playerId, skillId, rank, spent]
      );
    }
    for (const [classId, [rank, spent]] of Object.entries(classes)) {
      await pool.query(
        `INSERT INTO player_specialization_ranks (player_id, specialization_id, rank, points_spent, grandfathered, revision)
         VALUES ($1,$2,$3,$4,false,1)`,
        [playerId, classId, rank, spent]
      );
      await pool.query(
        `UPDATE player_specialization_state SET committed_specialization_id = $2, active_specialization_id = $2 WHERE player_id = $1`,
        [playerId, classId]
      );
    }
  }

  async function grant(playerId: string, itemId: string, amount: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `unlocks-test:${playerId}:${randomUUID()}`,
      playerId,
      source: "unlocks_test",
      sourceEntityType: "unlocks_test",
      sourceEntityId: playerId,
      grants: [{ itemId: itemId as ResourceType, variant: "default", quantity: amount }]
    });
  }

  async function quantity(playerId: string, itemId: string): Promise<number> {
    const snapshot = await inventory.getInventorySnapshot(playerId);
    return snapshot.items.filter((item) => item.resourceType === itemId).reduce((sum, item) => sum + Number(item.quantity), 0);
  }

  async function unlockKeys(playerId: string): Promise<string[]> {
    const result = await pool.query<{ skill_id: string }>(
      `SELECT skill_id FROM player_skill_world_unlocks WHERE player_id = $1 ORDER BY skill_id`, [playerId]
    );
    return result.rows.map((row) => row.skill_id);
  }

  async function itemEvents(playerId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events WHERE player_id = $1`, [playerId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Skill unlock offering test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) throw new Error("Unsafe disposable stability database name");
  return `"${value}"`;
}
