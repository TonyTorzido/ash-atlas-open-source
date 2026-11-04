import { randomUUID } from "node:crypto";

import {
  STRUCTURE_WARFARE_BASE_BURN_THRESHOLD_HEALTH,
  FLAG_BURN_INTERACTION_RADIUS_M,
  STRUCTURE_WARFARE_BASE_BURN_DURATION_MS,
  STRUCTURE_WARFARE_BURN_THRESHOLD_HEALTH,
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { FlagBurnCoordinator } from "./flagBurning.js";
import { FlagService } from "./flags.js";
import { InventoryService } from "./inventory.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Flag Burning PostgreSQL accepted-start authority", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const burnerId = `flag-burn-burner-${randomUUID()}`;
  const victimId = `flag-burn-victim-${randomUUID()}`;
  const flagId = randomUUID();
  const inventory = new InventoryService(pool);

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES
         ($1,'Burner','world-test',35,-106,35,-106,600,true,
          ST_SetSRID(ST_MakePoint(-106,35),4326)),
         ($2,'Victim','world-test',35,-106,35,-106,600,true,
          ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [burnerId, victimId]
    );
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,resource_vision_radius_m,
         control_type,anchor_kind,system_controlled,reinforcement_level,
         access_mode,health,maximum_health,geom
       ) VALUES (
         $1,$2,'North Watch',35,-106,500,650,
         'personal','flag',false,0,'public',$3,200,
         ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`,
      [flagId, victimId, STRUCTURE_WARFARE_BASE_BURN_THRESHOLD_HEALTH]
    );
    await inventory.grantItemsForOperation({
      operationKey: `flag-burn-test:${burnerId}:torch`,
      playerId: burnerId,
      source: "flag_burning_test_reward",
      sourceEntityType: "flag_burning_test",
      sourceEntityId: burnerId,
      grants: [{ itemId: "torch", variant: "default", quantity: 1 }]
    });
  });

  afterAll(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await pool.end();
  });

  it("accepts a Torch-backed burn start through the real SQL path", async () => {
    const coordinator = new FlagBurnCoordinator(
      {
        databasePool: pool,
        getFlag: vi.fn(async () => ({
          id: flagId,
          ownerId: victimId,
          controlType: "personal",
          anchorKind: "flag",
          systemControlled: false,
          reinforcementLevel: 0,
          cityId: null,
          kingdomId: null,
          upgradeTier: "base",
          health: STRUCTURE_WARFARE_BASE_BURN_THRESHOLD_HEALTH,
          maximumHealth: 220,
          lat: 35,
          lon: -106
        })),
        deleteFlagForBurnInTransaction: vi.fn()
      } as never,
      inventory,
      { info: vi.fn(), warn: vi.fn() },
      {
        currentPlayer: vi.fn(() => ({
          position: { lat: 35, lon: -106 },
          target: null,
          online: true
        })),
        isPlayerAlive: vi.fn(() => true),
        sendStarted: vi.fn(),
        sendVictimNotice: vi.fn(),
        sendCancelled: vi.fn(),
        completed: vi.fn(),
        failed: vi.fn()
      }
    );

    const started = await coordinator.start(
      burnerId,
      flagId,
      "burn-start-1",
      { position: { lat: 35, lon: -106 }, target: null, online: true }
    );

    expect(started.status).toBe("active");
    expect(started.session.position).toEqual({ lat: 35, lon: -106 });

    const operation = await pool.query(
      `SELECT burner_player_id,victim_player_id,flag_id::text,status
       FROM flag_burn_operations WHERE request_id = $1`,
      ["burn-start-1"]
    );
    expect(operation.rows).toEqual([{
      burner_player_id: burnerId,
      victim_player_id: victimId,
      flag_id: flagId,
      status: "active"
    }]);
    expect((await pool.query(
      `SELECT owner_id,target_id FROM player_enemy_marks
       WHERE owner_id = LEAST($1::text,$2::text)
         AND target_id = GREATEST($1::text,$2::text)`,
      [burnerId, victimId]
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT quantity FROM player_inventory
       WHERE player_id = $1 AND resource_type = 'torch' AND variant = 'default'`,
      [burnerId]
    )).rows[0]?.quantity).toBe("0");
    expect(FLAG_BURN_INTERACTION_RADIUS_M).toBe(50);

    coordinator.cancelPlayer(burnerId, "test-cleanup");
    await waitFor(async () => (await operationStatus(pool, "burn-start-1")) === "cancelled");
  });

  it("does not create an ignition or consume a Torch when eligibility fails", async () => {
    await debitFixtureTorch(
      pool,
      inventory,
      burnerId,
      `flag-burn-test:${burnerId}:failed-no-torch`
    );
    const { coordinator } = realCoordinator(pool);

    await expect(coordinator.start(
      burnerId,
      flagId,
      "burn-no-torch",
      { position: { lat: 35, lon: -106 }, target: null, online: true }
    )).rejects.toMatchObject({ code: "FLAG_BURN_TORCH_REQUIRED" });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM flag_burn_operations WHERE request_id=$1",
      ["burn-no-torch"]
    )).rows[0]?.count).toBe(0);
    expect(await torchQuantity(pool, burnerId)).toBe("0");
  });

  it("replays a committed ignition without consuming another Torch", async () => {
    const first = realCoordinator(pool);
    const started = await first.coordinator.start(
      burnerId,
      flagId,
      "burn-replay",
      { position: { lat: 35, lon: -106 }, target: null, online: true }
    );
    const second = realCoordinator(pool);
    const replay = await second.coordinator.start(
      burnerId,
      flagId,
      "burn-replay",
      { position: { lat: 35, lon: -106 }, target: null, online: true }
    );

    expect(started.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe("active");
    expect(await torchQuantity(pool, burnerId)).toBe("0");
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM flag_burn_operations WHERE request_id=$1",
      ["burn-replay"]
    )).rows[0]?.count).toBe(1);
    first.coordinator.cancelPlayer(burnerId, "test-cleanup");
    second.coordinator.cancelPlayer(burnerId, "test-cleanup");
    await waitFor(async () => (await operationStatus(pool, "burn-replay")) === "cancelled");
  });

  it("allows only one concurrent ignition to win and consumes one Torch", async () => {
    const first = realCoordinator(pool);
    const second = realCoordinator(pool);
    const outcomes = await Promise.allSettled([
      first.coordinator.start(
        burnerId,
        flagId,
        "burn-concurrent-a",
        { position: { lat: 35, lon: -106 }, target: null, online: true }
      ),
      second.coordinator.start(
        burnerId,
        flagId,
        "burn-concurrent-b",
        { position: { lat: 35, lon: -106 }, target: null, online: true }
      )
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await torchQuantity(pool, burnerId)).toBe("0");
    expect((await pool.query(
      `SELECT count(*)::int AS count
       FROM flag_burn_operations
       WHERE request_id IN ('burn-concurrent-a','burn-concurrent-b')`
    )).rows[0]?.count).toBe(1);
    first.coordinator.cancelPlayer(burnerId, "test-cleanup");
    second.coordinator.cancelPlayer(burnerId, "test-cleanup");
    await waitFor(async () =>
      (await pool.query(
        `SELECT count(*)::int AS count FROM flag_burn_operations
         WHERE request_id IN ('burn-concurrent-a','burn-concurrent-b') AND status='cancelled'`
      )).rows[0]?.count === 1
    );
  });

  it("reconciles and completes an overdue ignition after restart", async () => {
    const operationId = randomUUID();
    await insertOverdueBurn(pool, burnerId, victimId, flagId, operationId, "burn-overdue");
    const runtime = realCoordinator(pool);
    await runtime.coordinator.reconcile();
    const session = runtime.coordinator.activeForPlayer(burnerId);
    expect(session).not.toBeNull();
    await (runtime.coordinator as unknown as {
      complete(value: unknown): Promise<void>;
    }).complete(session);

    expect(await operationStatus(pool, "burn-overdue")).toBe("completed");
    expect((await pool.query("SELECT count(*)::int AS count FROM flags WHERE id=$1", [flagId])).rows[0]?.count).toBe(0);
    expect(await torchQuantity(pool, burnerId)).toBe("1");
  });

  it("retires a destroyed active burn before a manual retry and repairs its presentation mirror", async () => {
    const orphanOperationId = randomUUID();
    await insertActiveBurn(pool, burnerId, victimId, flagId, orphanOperationId, "burn-orphan");
    const runtime = realCoordinator(pool);
    await runtime.coordinator.reconcile();
    expect(runtime.coordinator.activeForPlayer(burnerId)).toMatchObject({
      operationId: orphanOperationId,
      flagId
    });
    expect(runtime.hooks.sendStarted).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: orphanOperationId })
    );
    expect((await pool.query(
      "SELECT burning_reason FROM flags WHERE id=$1",
      [flagId]
    )).rows[0]?.burning_reason).toBe("flag_burn");

    await pool.query(
      `UPDATE flags
       SET health=0,burning_started_at=NULL,burning_until=NULL,burning_reason=NULL
       WHERE id=$1`,
      [flagId]
    );
    const retryFlagId = await insertFlag(pool, victimId, 0, "Retry Watch", 35.01);
    const retryPosition = { lat: 35.01, lon: -106 };
    runtime.hooks.currentPlayer.mockReturnValue({
      position: retryPosition,
      target: null,
      online: true
    });

    const retry = await runtime.coordinator.start(
      burnerId,
      retryFlagId,
      "burn-orphan-retry",
      { position: retryPosition, target: null, online: true }
    );

    expect(retry.status).toBe("active");
    expect(await operationStatus(pool, "burn-orphan")).toBe("cancelled");
    expect((await pool.query(
      "SELECT cancel_reason FROM flag_burn_operations WHERE operation_id=$1",
      [orphanOperationId]
    )).rows[0]?.cancel_reason).toBe("flag-destroyed");
    // getFlag's canonical zero-health cleanup retires the destroyed row.
    expect((await pool.query("SELECT id FROM flags WHERE id=$1", [flagId])).rows).toEqual([]);
    expect((await pool.query(
      "SELECT burning_reason FROM flags WHERE id=$1",
      [retryFlagId]
    )).rows[0]?.burning_reason).toBe("flag_burn");
    expect(runtime.hooks.sendCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: orphanOperationId }),
      "reconciled"
    );

    runtime.coordinator.cancelPlayer(burnerId, "test-cleanup");
    await waitFor(async () => (await operationStatus(pool, "burn-orphan-retry")) === "cancelled");
  });

  it("completes a concurrent overdue ignition once without duplicate completion hooks", async () => {
    const operationId = randomUUID();
    await insertOverdueBurn(pool, burnerId, victimId, flagId, operationId, "burn-concurrent-complete");
    const first = realCoordinator(pool);
    const second = realCoordinator(pool);
    await Promise.all([first.coordinator.reconcile(), second.coordinator.reconcile()]);
    // The zero-delay completion timers may win while the other reconciler is
    // awaiting SQL. Assert the durable outcome and hooks, not a transient session.
    await waitFor(async () =>
      first.hooks.completed.mock.calls.length + second.hooks.completed.mock.calls.length === 1
    );

    expect(first.hooks.completed.mock.calls.length + second.hooks.completed.mock.calls.length).toBe(1);
    expect(await operationStatus(pool, "burn-concurrent-complete")).toBe("completed");
    expect((await pool.query("SELECT count(*)::int AS count FROM flags WHERE id=$1", [flagId])).rows[0]?.count).toBe(0);
    expect(await torchQuantity(pool, burnerId)).toBe("1");
  });

  it("publishes committed burn HP changes without restarting the burn presentation", async () => {
    const operationId = randomUUID();
    await insertActiveBurn(pool, burnerId, victimId, flagId, operationId, "burn-health-publication");
    await pool.query("UPDATE flags SET reinforcement_level=1,health=100,maximum_health=220 WHERE id=$1", [flagId]);
    await pool.query(
      `UPDATE flag_burn_operations SET reinforcement_level=1,burn_duration_ms=79200000,
         burn_start_health=100,started_at=clock_timestamp()-interval '6 hours',
         completes_at=clock_timestamp()+interval '16 hours' WHERE operation_id=$1`, [operationId]
    );
    const runtime = realCoordinator(pool);
    await runtime.coordinator.reconcile();
    expect(runtime.hooks.healthChanged).toHaveBeenCalledExactlyOnceWith(flagId);
    expect((await pool.query("SELECT health FROM flags WHERE id=$1", [flagId])).rows).toEqual([{ health: 70 }]);
    await runtime.coordinator.reconcile();
    expect(runtime.hooks.healthChanged).toHaveBeenCalledTimes(1);
    expect(runtime.hooks.sendStarted).toHaveBeenCalledTimes(1);
    runtime.coordinator.cancelPlayer(burnerId, "test-cleanup");
    await waitFor(async () => (await operationStatus(pool, "burn-health-publication")) === "cancelled");
  });

  it("completes a low-health Tower on a lethal fixed-rate tick before its unchanged deadline", async () => {
    const operationId = randomUUID();
    await insertActiveBurn(pool, burnerId, victimId, flagId, operationId, "burn-lethal-tick");
    await pool.query("UPDATE flags SET reinforcement_level=3,health=2,maximum_health=2700 WHERE id=$1", [flagId]);
    await pool.query(
      `UPDATE flag_burn_operations SET reinforcement_level=3,burn_duration_ms=79200000,
         burn_start_health=2,burn_damage_budget=1350,
         started_at=clock_timestamp()-interval '70 seconds',
         completes_at=clock_timestamp()+interval '79130 seconds' WHERE operation_id=$1`, [operationId]
    );
    const runtime = realCoordinator(pool);
    await runtime.coordinator.reconcile();
    expect((await pool.query("SELECT health FROM flags WHERE id=$1", [flagId])).rows).toEqual([{ health: 1 }]);
    await pool.query("UPDATE flag_burn_operations SET completes_at=completes_at-interval '60 seconds' WHERE operation_id=$1", [operationId]);
    const deadline = (await pool.query("SELECT completes_at FROM flag_burn_operations WHERE operation_id=$1", [operationId])).rows;
    const concurrent = realCoordinator(pool);
    await Promise.all([runtime.coordinator.reconcile(), concurrent.coordinator.reconcile()]);
    expect((await pool.query("SELECT health FROM flags WHERE id=$1", [flagId])).rows).toEqual([]);
    expect(await operationStatus(pool, "burn-lethal-tick")).toBe("completed");
    expect(runtime.hooks.completed.mock.calls.length + concurrent.hooks.completed.mock.calls.length).toBe(1);
    expect((await pool.query("SELECT completes_at FROM flag_burn_operations WHERE operation_id=$1", [operationId])).rows).toEqual(deadline);
    await runtime.coordinator.reconcile();
    expect(runtime.coordinator.activeForPlayer(burnerId)).toBeNull();
  });

  it("keeps the legacy repair endpoint separate from player-created burns", async () => {
    await pool.query(
      `UPDATE flags SET reinforcement_level=1,health=$2
       WHERE id=$1`,
      [flagId, STRUCTURE_WARFARE_BURN_THRESHOLD_HEALTH]
    );
    const runtime = realCoordinator(pool);
    await runtime.coordinator.start(
      burnerId,
      flagId,
      "burn-repair",
      { position: { lat: 35, lon: -106 }, target: null, online: true }
    );
    expect(await torchQuantity(pool, burnerId)).toBe("0");

    await expect(runtime.flags.repairBurningStoneFlag(
      victimId,
      flagId,
      { lat: 35, lon: -106 }
    )).rejects.toMatchObject({ code: "FLAG_REPAIR_INELIGIBLE" });
    expect(await torchQuantity(pool, burnerId)).toBe("0");
    runtime.coordinator.cancelPlayer(burnerId, "test-cleanup");
    await waitFor(async () => (await operationStatus(pool, "burn-repair")) === "cancelled");
  });
});

function realCoordinator(databasePool: pg.Pool, now: () => number = Date.now) {
  const inventory = new InventoryService(databasePool);
  const flags = new FlagService(databasePool, {} as never, {} as never, { info: vi.fn(), warn: vi.fn() } as never, inventory);
  const hooks = {
    currentPlayer: vi.fn(() => ({
      position: { lat: 35, lon: -106 },
      target: null,
      online: true
    })),
    isPlayerAlive: vi.fn(() => true),
    sendStarted: vi.fn(),
    sendVictimNotice: vi.fn(),
    sendCancelled: vi.fn(),
    healthChanged: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn()
  };
  return {
    flags,
    hooks,
    coordinator: new FlagBurnCoordinator(
      flags,
      inventory,
      { info: vi.fn(), warn: vi.fn() },
      hooks,
      now,
      flags.structureWarfare
    )
  };
}

async function torchQuantity(databasePool: pg.Pool, playerId: string): Promise<string> {
  const result = await databasePool.query<{ quantity: string }>(
    `SELECT COALESCE(quantity,0)::text AS quantity FROM player_inventory
     WHERE player_id=$1 AND resource_type='torch' AND variant='default'`,
    [playerId]
  );
  return result.rows[0]?.quantity ?? "0";
}

async function debitFixtureTorch(
  databasePool: pg.Pool,
  inventory: InventoryService,
  playerId: string,
  operationKey: string
): Promise<void> {
  const client = await databasePool.connect();
  try {
    await client.query("BEGIN");
    await inventory.debitItemsForOperationInTransaction(client, {
      operationKey,
      playerId,
      source: "flag_burning_test_spend",
      sourceEntityType: "flag_burning_test",
      sourceEntityId: operationKey,
      debits: [{ itemId: "torch", variant: "default", quantity: 1 }]
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function operationStatus(databasePool: pg.Pool, requestId: string): Promise<string | null> {
  const result = await databasePool.query<{ status: string }>(
    "SELECT status FROM flag_burn_operations WHERE request_id=$1",
    [requestId]
  );
  return result.rows[0]?.status ?? null;
}

async function insertFlag(
  databasePool: pg.Pool,
  ownerId: string,
  reinforcementLevel: number,
  name: string,
  lat: number
): Promise<string> {
  const id = randomUUID();
  await databasePool.query(
    `INSERT INTO flags (
       id,owner_id,name,lat,lon,claim_radius_m,resource_vision_radius_m,
       control_type,anchor_kind,system_controlled,reinforcement_level,
       access_mode,health,maximum_health,geom
     ) VALUES ($1,$2,$3,$4,-106,500,650,
       'personal','flag',false,$5,'public',$6,100,
       ST_SetSRID(ST_MakePoint(-106,$4),4326))`,
    [id, ownerId, name, lat, reinforcementLevel, STRUCTURE_WARFARE_BASE_BURN_THRESHOLD_HEALTH]
  );
  return id;
}

async function insertOverdueBurn(
  databasePool: pg.Pool,
  burnerPlayerId: string,
  victimPlayerId: string,
  targetFlagId: string,
  operationId: string,
  requestId: string
): Promise<void> {
  await databasePool.query(
    `UPDATE flags
     SET health=$2,burning_started_at=now()-interval '30 seconds',
         burning_until=now()-interval '5 seconds',burning_reason='flag_burn'
     WHERE id=$1`,
    [targetFlagId, STRUCTURE_WARFARE_BASE_BURN_THRESHOLD_HEALTH]
  );
  await databasePool.query(
    `INSERT INTO flag_burn_operations (
       operation_id,burner_player_id,victim_player_id,flag_id,request_id,
       flag_name,flag_lat,flag_lon,notice_message,started_at,completes_at,
       status,reinforcement_level,burn_duration_ms
     ) VALUES ($1,$2,$3,$4,$5,'Overdue',35,-106,'Overdue burn',
               now()-interval '30 seconds',now()-interval '5 seconds',
               'active',0,$6)`,
    [operationId, burnerPlayerId, victimPlayerId, targetFlagId, requestId, STRUCTURE_WARFARE_BASE_BURN_DURATION_MS]
  );
}

async function insertActiveBurn(
  databasePool: pg.Pool,
  burnerPlayerId: string,
  victimPlayerId: string,
  targetFlagId: string,
  operationId: string,
  requestId: string
): Promise<void> {
  await databasePool.query(
    `UPDATE flags
     SET health=$2,burning_started_at=NULL,burning_until=NULL,burning_reason=NULL
     WHERE id=$1`,
    [targetFlagId, STRUCTURE_WARFARE_BASE_BURN_THRESHOLD_HEALTH]
  );
  await databasePool.query(
    `INSERT INTO flag_burn_operations (
       operation_id,burner_player_id,victim_player_id,flag_id,request_id,
       flag_name,flag_lat,flag_lon,notice_message,started_at,completes_at,
       status,reinforcement_level,burn_duration_ms
     ) VALUES ($1,$2,$3,$4,$5,'Active',35,-106,'Active burn',
               now(),now()+interval '1 hour','active',0,$6)`,
    [operationId, burnerPlayerId, victimPlayerId, targetFlagId, requestId, STRUCTURE_WARFARE_BASE_BURN_DURATION_MS]
  );
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition did not become true");
}
