import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requireEquipmentDefinition } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateItemDefinitionCatalog } from "../game/items.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "1217_hammer_family.sql";

describeDatabase("hammer family migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_hammer_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const owner = `hammer-owner-${suffix}`;
  const ids = {
    inventory: randomUUID(), equipped: randomUUID(), manor: randomUUID(), escrow: randomUUID(),
    gift: randomUUID(), ground: randomUUID(), staff: randomUUID()
  };
  const hammerListing = randomUUID();
  const staffListing = randomUUID();
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-hammer-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-hammer-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (name !== TARGET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
      }
      await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    await seed();
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("makes every owned Hammer the stock Hammer in place and is empty on a second run", async () => {
    // Before 1217 the startup check refuses the compiled catalog (the Hammer is now its own family).
    await expect(validateItemDefinitionCatalog(pool!)).rejects.toThrow();
    const before = await instances();

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);
    await expect(validateItemDefinitionCatalog(pool!)).resolves.toBeUndefined();

    // Ids, custody, levels, enchantments and condition are untouched: the item id never changed.
    await expect(instances()).resolves.toEqual(before);
    expect(requireEquipmentDefinition("hammer")).toMatchObject({
      gameplayFamilyId: "hammer", equipmentRole: "stock", weaponCategory: "hammer", twoHanded: false
    });
    await expect(pool!.query(
      "SELECT equipment_family_id, equipment_role, display_name FROM item_definitions WHERE item_id='hammer'"
    )).resolves.toMatchObject({
      rows: [{ equipment_family_id: "hammer", equipment_role: "stock", display_name: "Hammer" }]
    });

    const snapshots = await listingSnapshots();
    expect(snapshots.get(hammerListing)).toMatchObject({
      definitionId: "hammer", itemLevel: 6,
      derivedStats: { weaponCategory: "hammer", twoHanded: false, pveAttackContribution: 6 }
    });
    expect(snapshots.get(staffListing)).toMatchObject({
      definitionId: "starter_staff",
      derivedStats: { weaponCategory: "staff", twoHanded: true }
    });

    // Second run: nothing pending, and re-applying the SQL by hand changes nothing.
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([]);
    const sql = await readFile(path.join(targetDirectory, TARGET_MIGRATION), "utf8");
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await expect(instances()).resolves.toEqual(before);
    await expect(listingSnapshots()).resolves.toEqual(snapshots);
  }, 120_000);

  async function instances(): Promise<Map<string, Record<string, unknown>>> {
    const result = await pool!.query<Record<string, unknown> & { instance_id: string }>(
      `SELECT instance_id::text,definition_id,owner_player_id,location,equipped_slot,item_level,
              enchantment_identity,condition,manor_id::text,manor_slot_index,market_listing_id::text,
              gift_package_id::text,inscription_name,metadata,updated_at
       FROM equipment_instances WHERE owner_player_id=$1`,
      [owner]
    );
    return new Map(result.rows.map((row) => [row.instance_id, row]));
  }

  async function listingSnapshots(): Promise<Map<string, Record<string, unknown>>> {
    const result = await pool!.query<{ listing_id: string; snapshot: Record<string, unknown> }>(
      "SELECT listing_id::text, presentation_snapshot AS snapshot FROM market_equipment_listings"
    );
    return new Map(result.rows.map((row) => [row.listing_id, row.snapshot]));
  }

  async function seed(): Promise<void> {
    await pool!.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,'Hammer owner','world-test',35,-106,35,-106,
         900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [owner]
    );
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      // Fixtures only: skip FK and guard triggers so every custody location can be staged
      // without building Manors, venues and packages. CHECK constraints still apply.
      await client.query("SET LOCAL session_replication_role = replica");
      const insert = (
        instanceId: string, definitionId: string, location: string,
        extra: Partial<Record<string, string | number | null>> = {}
      ) => client.query(
        `INSERT INTO equipment_instances (
           instance_id, definition_id, owner_player_id, location, equipped_slot, created_by_operation_key,
           item_level, enchantment_identity, condition, manor_id, manor_slot_index, market_listing_id,
           gift_package_id, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
        [
          instanceId, definitionId, owner, location, extra.slot ?? null, `hammer-fixture:${instanceId}`,
          extra.level ?? 3, extra.enchantment ?? null, extra.condition ?? 100, extra.manor ?? null,
          extra.manorSlot ?? null, extra.listing ?? null, extra.gift ?? null,
          JSON.stringify({ fixture: instanceId })
        ]
      );
      await insert(ids.inventory, "hammer", "inventory", { level: 9, enchantment: "venomsteel", condition: 71 });
      await insert(ids.equipped, "hammer", "equipped", { slot: "melee" });
      await insert(ids.manor, "hammer", "manor_storage", { manor: randomUUID(), manorSlot: 2 });
      await insert(ids.escrow, "hammer", "market_escrow", { listing: hammerListing, level: 6 });
      await insert(ids.gift, "hammer", "gift_escrow", { gift: randomUUID() });
      await insert(ids.ground, "hammer", "world_drop");
      await insert(ids.staff, "starter_staff", "market_escrow", { listing: staffListing });
      const snapshot = (instanceId: string, definitionId: string, weaponCategory: string, level: number) =>
        JSON.stringify({
          equipmentInstanceId: instanceId, definitionId, displayName: definitionId, artworkKey: definitionId,
          category: "melee_weapon", slot: "melee", itemLevel: level, maximumItemLevel: 25, balanceVersion: 2,
          derivedStats: { weaponCategory, twoHanded: true, pveAttackContribution: level },
          utilityIdentity: null, enchantmentIdentity: null, cosmeticIdentity: null
        });
      await client.query(
        `INSERT INTO market_equipment_listings (
           listing_id, venue_id, equipment_instance_id, seller_player_id, asking_price, status, presentation_snapshot
         ) VALUES ($1,$2,$3,$4,500,'open',$5::jsonb), ($6,$2,$7,$4,400,'open',$8::jsonb)`,
        [hammerListing, randomUUID(), ids.escrow, owner, snapshot(ids.escrow, "hammer", "staff", 6),
          staffListing, ids.staff, snapshot(ids.staff, "starter_staff", "staff", 3)]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Hammer family migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
