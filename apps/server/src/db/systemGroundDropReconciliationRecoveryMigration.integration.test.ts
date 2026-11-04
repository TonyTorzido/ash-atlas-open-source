import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { createSystemGroundDropsInTransaction } from "../game/droppedItems.js";
import { reconcileDroppedItemCustody } from "../game/droppedItemReconciliation.js";
import { applyMarketReconciliationFailure } from "../game/marketReconciliationProtection.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const migration = "0737_system_ground_drop_reconciliation_recovery.sql";

describeDatabase("system ground-drop reconciliation recovery migration", () => {
  const sourceMigrations = fileURLToPath(
    new URL("../../../../db/migrations", import.meta.url)
  );
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const databaseName = `ash_atlas_stability_drop_recovery_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    assertDisposableDatabase(adminUrl!);
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-drop-recovery-"));
    for (const name of await readdir(sourceMigrations)) {
      if (!name.endsWith(".sql") || name === migration) continue;
      await copyFile(path.join(sourceMigrations, name), path.join(precedingMigrations, name));
    }
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 3 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("restores the exact controls after verifying the false-positive system drop", async () => {
    const accountId = randomUUID();
    const playerId = `drop-recovery-${randomUUID()}`;
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,$2,'DropRecovery','GLOBAL',40,-105,40,-105,600,false,
         ST_SetSRID(ST_MakePoint(-105,40),4326))`,
      [playerId, accountId]
    );

    const client = await pool.connect();
    let dropId = "";
    try {
      await client.query("BEGIN");
      const [drop] = await createSystemGroundDropsInTransaction(client, {
        operationKey: "migration-test-system-drop",
        droppedByPlayerId: playerId,
        regionCode: "GLOBAL",
        zoneId: "world:GLOBAL",
        sourceEntityType: "combat_settlement",
        sourceEntityId: "migration-test-combat",
        position: { lat: 40, lon: -105 },
        reason: "combat_deer_loot",
        lines: [{ itemId: "leather", variant: null, quantity: 3 }]
      });
      dropId = drop!.dropId;
      await applyMarketReconciliationFailure(client, {
        ok: false,
        checkedAt: "2026-08-08T19:11:47.906Z",
        orderCount: 0,
        tradeCount: 0,
        ledgerGroupCount: 0,
        collectionCount: 0,
        issues: [{
          code: "DROPPED_ITEM_CUSTODY_MISMATCH",
          scope: "world_item_drop",
          entityId: dropId,
          details: {
            status: "active",
            creationCount: "0",
            requestCount: "0"
          }
        }]
      }, {
        recordCriticalAudit: true,
        freezeMode: "affected_books"
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await expect(reconcileDroppedItemCustody(pool)).resolves.toEqual([]);
    await expect(marketControls(pool)).resolves.toEqual({
      read_only: true,
      new_orders_enabled: false,
      matching_enabled: false
    });
    const custodyBefore = await systemDropCustody(pool, dropId);

    await expect(runMigrations(databaseUrl)).resolves.toEqual([migration]);
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);

    await expect(marketControls(pool)).resolves.toEqual({
      read_only: false,
      new_orders_enabled: true,
      matching_enabled: true
    });
    await expect(systemDropCustody(pool, dropId)).resolves.toEqual(custodyBefore);
    await expect(reconcileDroppedItemCustody(pool)).resolves.toEqual([]);
    const recoveryAudit = await pool.query<{ operator: string }>(
      `SELECT evidence->>'operatorIdentity' AS operator
       FROM market_audit_events
       WHERE event_type='market_control_changed'
       ORDER BY audit_event_id DESC LIMIT 1`
    );
    expect(recoveryAudit.rows[0]?.operator)
      .toBe("system:migration:0737-system-ground-drop-reconciliation-recovery");
  }, 120_000);
});

async function marketControls(pool: pg.Pool): Promise<{
  read_only: boolean;
  new_orders_enabled: boolean;
  matching_enabled: boolean;
}> {
  const result = await pool.query(
    `SELECT read_only,new_orders_enabled,matching_enabled
     FROM market_global_controls WHERE singleton`
  );
  return result.rows[0];
}

async function systemDropCustody(pool: pg.Pool, dropId: string): Promise<unknown> {
  const result = await pool.query(
    `SELECT d.id::text,d.operation_key,d.original_quantity::text,d.remaining_quantity::text,
            source.operation_key AS source_operation_key,
            movement.movement_kind,movement.quantity::text,movement.reason
     FROM world_item_drops d
     JOIN world_item_system_drop_sources source ON source.drop_id=d.id
     JOIN world_item_movements movement ON movement.drop_id=d.id
     WHERE d.id=$1
     ORDER BY movement.movement_id`,
    [dropId]
  );
  return result.rows;
}

function assertDisposableDatabase(value: string): void {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error("ground-drop recovery verification requires ash_atlas_stability");
  }
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
