import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { FieldConsumableError, FieldConsumableService, inspirationActive } from "./fieldConsumables.js";
import { InventoryService } from "./inventory.js";
import { validateItemDefinitionCatalog } from "./items.js";
import { seedTradeSkillRank } from "./skills/tradeSkillTestSeed.js";

const databaseUrl = process.env.FIELD_CONSUMABLES_TEST_DATABASE_URL;
const describeLive = databaseUrl ? describe : describe.skip;
const MIGRATION = "1013_field_consumables.sql";

describeLive("field consumables durable use", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let clock = new Date();
  let service: FieldConsumableService;

  async function player(items: Array<[string, number]>): Promise<string> {
    const playerId = `field-${randomUUID()}`;
    await pool.query(`INSERT INTO players(id,username,lat,lon,anchor_lat,anchor_lon,geom)
      VALUES($1,$1,35,-106,35,-106,ST_SetSRID(ST_MakePoint(-106,35),4326))`, [playerId]);
    await inventory.grantItemsForOperation({
      operationKey: `field-seed:${playerId}`, playerId, source: "field-consumables-test",
      grants: items.map(([itemId, quantity]) => ({ itemId: itemId as never, variant: null, quantity }))
    });
    return playerId;
  }
  const count = async (playerId: string, itemId: string) =>
    ((await inventory.getInventorySnapshot(playerId)).totals as Record<string, number | undefined>)[itemId] ?? 0;

  beforeAll(async () => {
    const databaseName = new URL(databaseUrl!).pathname.slice(1);
    if (!databaseName.startsWith("ash_atlas_stability")) {
      throw new Error("Field consumable integration tests require a disposable database");
    }
    const baseline = await mkdtemp(path.join(os.tmpdir(), "ash-atlas-field-migrations-"));
    try {
      const source = path.resolve("../../db/migrations");
      for (const file of await readdir(source)) {
        if (file.endsWith(".sql") && file !== MIGRATION) await copyFile(path.join(source, file), path.join(baseline, file));
      }
      await runMigrations(databaseUrl!, { migrationsDirectory: baseline });
      pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
      inventory = new InventoryService(pool);
      const existing = await player([["balsam_resin", 3]]);
      expect(await runMigrations(databaseUrl!)).toEqual([MIGRATION]);
      expect(await count(existing, "balsam_resin")).toBe(3);
      // This migration is replayed out of order, so it reverts later catalog alignments.
      await pool.query(await readFile(path.join(source, "1176_utility_gear_catalog_alignment.sql"), "utf8"));
      await validateItemDefinitionCatalog(pool);
      expect(await runMigrations(databaseUrl!)).toEqual([]);
    } finally {
      await rm(baseline, { recursive: true, force: true });
    }
    service = new FieldConsumableService(pool, inventory, () => clock);
  }, 180_000);

  afterAll(async () => { await pool?.end(); });

  it("a tonic debits exactly one, replays safely and persists its hour", async () => {
    const playerId = await player([["anti_venom_tonic", 2]]);
    const first = await service.consumeBuff(playerId, "req-1", "anti_venom_tonic");
    const replay = await service.consumeBuff(playerId, "req-1", "anti_venom_tonic");
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(await count(playerId, "anti_venom_tonic")).toBe(1);
    expect(first.buffs).toEqual([{ buffId: "anti_venom", startedAt: clock.getTime(), endsAt: clock.getTime() + 3_300_000 }]);
    expect(await service.activeBuffs(playerId)).toHaveLength(1);
    clock = new Date(clock.getTime() + 3_300_001);
    expect(await service.activeBuffs(playerId)).toHaveLength(0);
    clock = new Date();
  });

  it("Spark Tonic is detectable by reward code and an empty pack is refused", async () => {
    const playerId = await player([["spark_tonic", 1]]);
    expect(await inspirationActive(pool, playerId)).toBe(false);
    await service.consumeBuff(playerId, "req-i", "spark_tonic");
    expect(await inspirationActive(pool, playerId)).toBe(true);
    await expect(service.consumeBuff(playerId, "req-j", "spark_tonic")).rejects.toBeInstanceOf(FieldConsumableError);
    expect(await count(playerId, "spark_tonic")).toBe(0);
  });

  it("instant items debit once per request and refunds are idempotent", async () => {
    const playerId = await player([["field_net", 2]]);
    expect((await service.consumeInstant(playerId, "net-1", "field_net")).replayed).toBe(false);
    expect((await service.consumeInstant(playerId, "net-1", "field_net")).replayed).toBe(true);
    expect(await service.operationApplied(playerId, "net-1")).toBe(true);
    expect(await count(playerId, "field_net")).toBe(1);
    await service.refundInstant(playerId, "net-1", "field_net");
    await service.refundInstant(playerId, "net-1", "field_net");
    expect(await count(playerId, "field_net")).toBe(2);
  });

  it("crafting Ember Bombs yields five, replay-safe, and refuses missing materials", async () => {
    const playerId = await player([["crude_oil", 2], ["sulfur", 4], ["balsam_resin", 2]]);
    await seedTradeSkillRank(pool, playerId, "alchemy", 3);
    const crafted = await service.craft(playerId, "craft-1", "ember_flask");
    expect(crafted).toMatchObject({ quantity: 5, replayed: false });
    expect((await service.craft(playerId, "craft-1", "ember_flask")).replayed).toBe(true);
    expect(await count(playerId, "ember_flask")).toBe(5);
    expect(await count(playerId, "sulfur")).toBe(0);
    await expect(service.craft(playerId, "craft-2", "ember_flask")).rejects.toMatchObject({ code: "FIELD_CRAFT_MATERIALS" });
  });

  it("crafting a Field Trap needs Blacksmithing rank 3", async () => {
    const playerId = await player([["iron_bar", 3]]);
    await expect(service.craft(playerId, "trap-0", "field_trap")).rejects.toMatchObject({
      code: "FIELD_CRAFT_SKILL_REQUIRED",
      message: "Needs Blacksmithing rank 3 to craft a Field Trap."
    });
    await seedTradeSkillRank(pool, playerId, "blacksmithing", 2);
    await expect(service.craft(playerId, "trap-1", "field_trap")).rejects.toMatchObject({ code: "FIELD_CRAFT_SKILL_REQUIRED" });
    expect(await count(playerId, "iron_bar")).toBe(3);
    await seedTradeSkillRank(pool, playerId, "blacksmithing", 3);
    expect(await service.craft(playerId, "trap-2", "field_trap")).toMatchObject({ quantity: 1, replayed: false });
    expect(await count(playerId, "field_trap")).toBe(1);
    expect(await count(playerId, "iron_bar")).toBe(1);
  });

  it("alchemy and leatherworking crafts need their ranks (allowed and denied)", async () => {
    const cases: Array<[string, Array<[string, number]>, "alchemy" | "leatherworking", 1 | 2 | 3, string]> = [
      ["spark_tonic", [["flux_plant", 7], ["chitin", 1], ["balsam_resin", 2]], "alchemy", 1, "Needs Alchemy rank 1 to craft a Spark Tonic."],
      ["battle_draught", [["crystal", 1], ["sulfur", 4], ["chitin", 2], ["balsam_resin", 1]], "alchemy", 2, "Needs Alchemy rank 2 to craft a Battle Draught."],
      ["ember_flask", [["crude_oil", 2], ["sulfur", 4], ["balsam_resin", 2]], "alchemy", 3, "Needs Alchemy rank 3 to craft Ember Bombs."]
    ];
    for (const [itemId, inputs, skillId, rank, message] of cases) {
      const playerId = await player(inputs);
      await expect(service.craft(playerId, `${itemId}-0`, itemId as never)).rejects.toMatchObject({ code: "FIELD_CRAFT_SKILL_REQUIRED", message });
      if (rank > 1) {
        await seedTradeSkillRank(pool, playerId, skillId, (rank - 1) as 1 | 2);
        await expect(service.craft(playerId, `${itemId}-1`, itemId as never)).rejects.toMatchObject({ code: "FIELD_CRAFT_SKILL_REQUIRED" });
      }
      await seedTradeSkillRank(pool, playerId, skillId, rank);
      expect(await service.craft(playerId, `${itemId}-2`, itemId as never)).toMatchObject({ replayed: false });
    }
    const netPlayer = await player([["wood", 100], ["flax_fiber", 100], ["leather", 100], ["cloth", 100], ["iron_bar", 100]]);
    await expect(service.craft(netPlayer, "net-0", "field_net")).rejects.toMatchObject({ message: "Needs Leatherworking rank 2 to craft a Field Net." });
  });

  it("a Field Net returns on use only at Leatherworking rank 3, deterministically at 70%", async () => {
    const playerId = await player([["wood", 1]]);
    expect(await service.returnNetOnUse(playerId, "net-use-0")).toBeNull();
    await seedTradeSkillRank(pool, playerId, "leatherworking", 3);
    let returned = 0;
    for (let index = 0; index < 40; index += 1) {
      const first = await service.returnNetOnUse(playerId, `net-use-${index}`);
      if (first) returned += 1;
      expect(Boolean(await service.returnNetOnUse(playerId, `net-use-${index}`))).toBe(Boolean(first));
    }
    expect(returned).toBeGreaterThan(22);
    expect(returned).toBeLessThan(40);
    expect(await count(playerId, "field_net")).toBe(returned);
  });
});
