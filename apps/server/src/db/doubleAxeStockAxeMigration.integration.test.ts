import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateItemDefinitionCatalog } from "../game/items.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "1216_double_axe_stock_axe.sql";

type InstanceRow = {
  instance_id: string;
  definition_id: string;
  owner_player_id: string;
  location: string;
  equipped_slot: string | null;
  item_level: number;
  enchantment_identity: string | null;
  condition: number;
  manor_id: string | null;
  manor_slot_index: number | null;
  market_listing_id: string | null;
  market_collection_id: string | null;
  gift_package_id: string | null;
  inscription_name: string | null;
  metadata: Record<string, unknown>;
};

describeDatabase("double axe stock axe migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_axe_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const owner = `axe-owner-${suffix}`;
  const friend = `axe-friend-${suffix}`;
  const ids = {
    inventory: randomUUID(), equipped: randomUUID(), manor: randomUUID(), escrow: randomUUID(),
    collection: randomUUID(), gift: randomUUID(), mixedGiftA: randomUUID(), mixedGiftB: randomUUID(),
    mixedGiftDouble: randomUUID(), ground: randomUUID(), destroyed: randomUUID(), control: randomUUID()
  };
  const manorId = randomUUID();
  const venueId = randomUUID();
  const openListing = randomUUID();
  const soldListing = randomUUID();
  const collectionId = randomUUID();
  const giftPackage = randomUUID();
  const mixedPackage = randomUUID();
  const adminPackage = randomUUID();
  const dropId = randomUUID();
  const copyId = randomUUID();
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-axe-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-axe-target-"));
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

  it("converts every Axe to a Double Axe in place, keeps all instance state, and is empty on a second run", async () => {
    // Before 1216 the startup check refuses the compiled catalog (Double Axe is now stock).
    await expect(validateItemDefinitionCatalog(pool!)).rejects.toThrow();
    const before = await instances();

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);
    await expect(validateItemDefinitionCatalog(pool!)).resolves.toBeUndefined();

    const after = await instances();
    expect(after.size).toBe(before.size);
    for (const [instanceId, row] of before) {
      const converted = after.get(instanceId)!;
      expect(converted.definition_id, instanceId).toBe("double_axe");
      const { definition_id: _a, metadata: beforeMetadata, ...beforeRest } = row;
      const { definition_id: _b, metadata: afterMetadata, ...afterRest } = converted;
      expect(afterRest, instanceId).toEqual(beforeRest);
      expect(afterMetadata, instanceId).toEqual(
        row.definition_id === "double_axe"
          ? beforeMetadata
          : { ...beforeMetadata, convertedFromDefinition: "training_axe" }
      );
    }
    expect(after.get(ids.inventory)).toMatchObject({
      item_level: 7, enchantment_identity: "venomsteel", condition: 63, inscription_name: "Gnasher"
    });
    await expect(count("SELECT count(*) FROM equipment_instances WHERE definition_id='training_axe'"))
      .resolves.toBe(0);

    const definitions = await pool!.query<{ item_id: string; display_name: string; equipment_role: string }>(
      `SELECT item_id,display_name,equipment_role FROM item_definitions
       WHERE item_id IN ('training_axe','double_axe','wooden_axe','stone_axe') ORDER BY item_id`
    );
    expect(definitions.rows).toEqual([
      { item_id: "double_axe", display_name: "Double Axe", equipment_role: "stock" },
      { item_id: "stone_axe", display_name: "Stone Hatchet", equipment_role: "stock" },
      { item_id: "training_axe", display_name: "Training Axe", equipment_role: "special" },
      { item_id: "wooden_axe", display_name: "Wooden Hatchet", equipment_role: "stock" }
    ]);

    await expect(pool!.query("SELECT item_id FROM world_equipment_drops WHERE id=$1", [dropId]))
      .resolves.toMatchObject({ rows: [{ item_id: "double_axe" }] });
    const listings = await pool!.query<{ listing_id: string; snapshot: Record<string, unknown> }>(
      "SELECT listing_id::text, presentation_snapshot AS snapshot FROM market_equipment_listings ORDER BY listing_id"
    );
    expect(listings.rows).toHaveLength(2);
    for (const listing of listings.rows) {
      expect(listing.snapshot).toMatchObject({
        definitionId: "double_axe", displayName: "Double Axe", artworkKey: "double_axe", itemLevel: 7
      });
    }

    const lines = await pool!.query<{
      package_id: string; line_number: number; canonical_item_id: string;
      original_quantity: string; remaining_quantity: string;
    }>(
      `SELECT package_id::text,line_number,canonical_item_id,original_quantity::text,remaining_quantity::text
       FROM player_package_items WHERE package_id = ANY($1::uuid[]) ORDER BY package_id,line_number`,
      [[giftPackage, mixedPackage, adminPackage]]
    );
    const byPackage = (packageId: string) => lines.rows.filter((line) => line.package_id === packageId)
      .map(({ package_id: _package, ...line }) => line);
    expect(byPackage(giftPackage)).toEqual([
      { line_number: 1, canonical_item_id: "double_axe", original_quantity: "1", remaining_quantity: "1" }
    ]);
    expect(byPackage(adminPackage)).toEqual([
      { line_number: 1, canonical_item_id: "double_axe", original_quantity: "1", remaining_quantity: "1" }
    ]);
    // The mixed gift's Axe line folds into its Double Axe line, gift instances included.
    expect(byPackage(mixedPackage)).toEqual([
      { line_number: 1, canonical_item_id: "double_axe", original_quantity: "3", remaining_quantity: "3" }
    ]);
    await expect(pool!.query(
      "SELECT line_number FROM player_gift_equipment_instances WHERE package_id=$1 ORDER BY instance_id",
      [mixedPackage]
    )).resolves.toMatchObject({ rows: [{ line_number: 1 }, { line_number: 1 }, { line_number: 1 }] });

    const policies = await pool!.query<{ player_id: string; item_id: string; keep_quantity: string }>(
      `SELECT player_id,item_id,keep_quantity::text FROM player_item_keep_policies
       WHERE player_id = ANY($1::text[]) ORDER BY player_id,item_id`,
      [[owner, friend]]
    );
    expect(policies.rows).toEqual([
      { player_id: owner, item_id: "double_axe", keep_quantity: "2" },
      { player_id: friend, item_id: "double_axe", keep_quantity: "3" }
    ].sort((left, right) => left.player_id.localeCompare(right.player_id)));
    await expect(pool!.query("SELECT item_id FROM shop_item_copies WHERE copy_id=$1", [copyId]))
      .resolves.toMatchObject({ rows: [{ item_id: "double_axe" }] });

    // Second run: nothing pending, and re-applying the SQL by hand changes nothing.
    const snapshot = await instances();
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([]);
    const sql = await import("node:fs/promises").then((fs) => fs.readFile(path.join(targetDirectory, TARGET_MIGRATION), "utf8"));
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const replayed = await instances();
    for (const [instanceId, row] of snapshot) {
      const { metadata, ...rest } = replayed.get(instanceId)!;
      const { metadata: snapshotMetadata, ...snapshotRest } = row;
      expect(rest).toEqual(snapshotRest);
      expect(metadata).toEqual(snapshotMetadata);
    }
    await expect(count(
      "SELECT count(*) FROM player_package_items WHERE package_id = ANY($1::uuid[])",
      [[giftPackage, mixedPackage, adminPackage]]
    )).resolves.toBe(3);
  }, 120_000);

  async function instances(): Promise<Map<string, InstanceRow>> {
    const result = await pool!.query<InstanceRow>(
      `SELECT instance_id::text,definition_id,owner_player_id,location,equipped_slot,item_level,
              enchantment_identity,condition,manor_id::text,manor_slot_index,market_listing_id::text,
              market_collection_id::text,gift_package_id::text,inscription_name,metadata
       FROM equipment_instances WHERE owner_player_id = ANY($1::text[])`,
      [[owner, friend]]
    );
    return new Map(result.rows.map((row) => [row.instance_id, row]));
  }

  async function count(sql: string, values: unknown[] = []): Promise<number> {
    const result = await pool!.query<{ count: string }>(sql, values);
    return Number(result.rows[0]!.count);
  }

  async function seed(): Promise<void> {
    for (const [playerId, name] of [[owner, "Axe owner"], [friend, "Axe friend"]] as const) {
      await pool!.query(
        `INSERT INTO players (
           id,username,region_code,lat,lon,anchor_lat,anchor_lon,
           move_leash_radius_m,online,geom
         ) VALUES ($1,$2,'world-test',35,-106,35,-106,
           900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
        [playerId, name]
      );
    }
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      // Fixtures only: skip FK and guard triggers so every custody location can be staged
      // without building Manors, venues and campaigns. CHECK constraints still apply.
      await client.query("SET LOCAL session_replication_role = replica");
      const insert = (
        instanceId: string, definitionId: string, location: string,
        extra: Partial<Record<string, string | number | null>> = {}
      ) => client.query(
        `INSERT INTO equipment_instances (
           instance_id, definition_id, owner_player_id, location, equipped_slot, created_by_operation_key,
           item_level, enchantment_identity, condition, manor_id, manor_slot_index, market_listing_id,
           market_collection_id, gift_package_id, inscription_name, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
        [
          instanceId, definitionId, extra.owner ?? owner, location, extra.slot ?? null, `axe-fixture:${instanceId}`,
          extra.level ?? 3, extra.enchantment ?? null, extra.condition ?? 100, extra.manor ?? null,
          extra.manorSlot ?? null, extra.listing ?? null, extra.collection ?? null, extra.gift ?? null,
          extra.inscription ?? null, JSON.stringify({ fixture: instanceId })
        ]
      );
      await insert(ids.inventory, "training_axe", "inventory", {
        level: 7, enchantment: "venomsteel", condition: 63, inscription: "Gnasher"
      });
      await insert(ids.equipped, "training_axe", "equipped", { slot: "melee" });
      await insert(ids.manor, "training_axe", "manor_storage", { manor: manorId, manorSlot: 4 });
      await insert(ids.escrow, "training_axe", "market_escrow", { listing: openListing });
      await insert(ids.collection, "training_axe", "market_collection", {
        owner: friend, listing: soldListing, collection: collectionId
      });
      await insert(ids.gift, "training_axe", "gift_escrow", { gift: giftPackage });
      await insert(ids.mixedGiftA, "training_axe", "gift_escrow", { gift: mixedPackage });
      await insert(ids.mixedGiftB, "training_axe", "gift_escrow", { gift: mixedPackage });
      await insert(ids.mixedGiftDouble, "double_axe", "gift_escrow", { gift: mixedPackage });
      await insert(ids.ground, "training_axe", "world_drop");
      await insert(ids.destroyed, "training_axe", "destroyed");
      await insert(ids.control, "double_axe", "inventory", { level: 2 });

      await client.query(
        `INSERT INTO world_equipment_drops (
           id, operation_key, equipment_instance_id, item_id, dropped_by, region_code, zone_id,
           pile_id, lat, lon, geom, expires_at
         ) VALUES ($1,$2,$3,'training_axe',$4,'world-test','zone-test','pile-test',35,-106,
           ST_SetSRID(ST_MakePoint(-106,35),4326), now() + interval '1 hour')`,
        [dropId, `axe-drop:${dropId}`, ids.ground, owner]
      );
      const snapshot = (instanceId: string) => JSON.stringify({
        equipmentInstanceId: instanceId, definitionId: "training_axe", displayName: "Axe",
        artworkKey: "training_axe", category: "melee_weapon", slot: "melee", itemLevel: 7,
        maximumItemLevel: 25, balanceVersion: 2, derivedStats: {}, utilityIdentity: null,
        enchantmentIdentity: null, cosmeticIdentity: null
      });
      await client.query(
        `INSERT INTO market_equipment_listings (
           listing_id, venue_id, equipment_instance_id, seller_player_id, buyer_player_id,
           asking_price, status, presentation_snapshot
         ) VALUES ($1,$2,$3,$4,NULL,500,'open',$5::jsonb),
                  ($6,$2,$7,$4,$8,700,'sold',$9::jsonb)`,
        [openListing, venueId, ids.escrow, owner, snapshot(ids.escrow),
          soldListing, ids.collection, friend, snapshot(ids.collection)]
      );
      for (const packageId of [giftPackage, mixedPackage, adminPackage]) {
        await client.query(
          "INSERT INTO player_packages (id, campaign_id, recipient_player_id) VALUES ($1,$2,$3)",
          [packageId, randomUUID(), friend]
        );
      }
      await client.query(
        `INSERT INTO player_package_items (
           package_id, line_number, item_kind, canonical_item_id, original_quantity, remaining_quantity
         ) VALUES ($1,1,'equipment','training_axe',1,1),
                  ($2,1,'equipment','double_axe',1,1),
                  ($2,2,'equipment','training_axe',2,2),
                  ($3,1,'equipment','training_axe',1,1)`,
        [giftPackage, mixedPackage, adminPackage]
      );
      await client.query(
        `INSERT INTO player_gift_equipment_instances (instance_id, package_id, line_number)
         VALUES ($1,$2,1), ($3,$4,2), ($5,$4,2), ($6,$4,1)`,
        [ids.gift, giftPackage, ids.mixedGiftA, mixedPackage, ids.mixedGiftB, ids.mixedGiftDouble]
      );
      await client.query(
        `INSERT INTO player_item_keep_policies (player_id, item_id, variant, keep_quantity, revision)
         VALUES ($1,'training_axe','default',2,1), ($1,'double_axe','default',1,1),
                ($2,'training_axe','default',3,1)`,
        [owner, friend]
      );
      await client.query(
        `INSERT INTO shop_item_copies (copy_id, item_id, look, tag, original_buyer_player_id, original_buyer_name)
         VALUES ($1,'training_axe','default','AXE0-0001',$2,'Axe owner')`,
        [copyId, owner]
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
    throw new Error("Double axe migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
