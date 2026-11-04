import { randomUUID } from "node:crypto";

import {
  STRUCTURE_WARFARE_BASE_BURN_DURATION_MS,
  STRUCTURE_WARFARE_DISRUPT_DURATION_MS,
  STRUCTURE_WARFARE_REPAIR_DURATION_MS,
  STRUCTURE_WARFARE_STONE_BURN_DURATION_MS,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { FlagService } from "./flags.js";
import { InventoryService } from "./inventory.js";
import { PERSONAL_FLAG_WARFARE_KIND } from "./structureWarfare.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("personal Flag warfare durable operations", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
  const inventory = new InventoryService(pool);
  const players = Array.from({ length: 8 }, (_, index) => `flag-warfare-player-${index}-${randomUUID()}`);
  const ownerId = players[0]!;
  const attackerIds = players.slice(1, 5);
  const freshAttackerIds = players.slice(5, 8);
  const igniterId = freshAttackerIds[0]!;
  let flags: FlagService;
  let stoneFlagId = "";
  let baseFlagId = "";

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
       ) SELECT id,'Flag warfare ' || row_number() OVER (), 'world-test',35,-106,35,-106,
                600,true,ST_SetSRID(ST_MakePoint(-106,35),4326)
       FROM unnest($1::text[]) AS fixture(id)`,
      [players]
    );
    flags = new FlagService(
      pool,
      {} as never,
      {} as never,
      { info: vi.fn(), warn: vi.fn() } as never,
      inventory
    );
    baseFlagId = await insertFlag(0, "Warfare Base");
    stoneFlagId = await insertFlag(1, "Warfare Stone");
  });

  afterAll(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await pool.end();
  });

  it.each([200, 1200])("uses the same half-max burn budget for a Tower ignited at %i HP", async (health) => {
    await pool.query("UPDATE flags SET reinforcement_level=3,health=$2,maximum_health=2700 WHERE id=$1", [stoneFlagId, health]);
    await grant(igniterId, "torch", 1, "fixed-tower-budget");
    const ignition = await ignite(stoneFlagId, igniterId, "fixed-tower-budget");
    expect((await pool.query(
      "SELECT burn_start_health,burn_damage_budget,burn_duration_ms::int FROM flag_burn_operations WHERE operation_id=$1",
      [ignition.operation.operationId]
    )).rows).toEqual([{ burn_start_health: health, burn_damage_budget: 1350, burn_duration_ms: 79200000 }]);
    await pool.query(
      `UPDATE flag_burn_operations SET started_at=clock_timestamp()-interval '121 seconds',
         completes_at=clock_timestamp()+interval '79079 seconds' WHERE operation_id=$1`, [ignition.operation.operationId]
    );
    await flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    expect(await flagHealth(stoneFlagId)).toEqual({ health: health-2, maximumHealth: 2700 });
    const deadline = (await pool.query("SELECT completes_at FROM flag_burn_operations WHERE operation_id=$1", [ignition.operation.operationId])).rows;
    await pool.query("UPDATE flags SET health=health-6 WHERE id=$1", [stoneFlagId]);
    await flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    expect(await flagHealth(stoneFlagId)).toEqual({ health: health-8, maximumHealth: 2700 });
    expect((await pool.query("SELECT completes_at FROM flag_burn_operations WHERE operation_id=$1", [ignition.operation.operationId])).rows).toEqual(deadline);
  });

  it("advances only completed active minute buckets with fractional HP carried across restart and pause", async () => {
    await pool.query("UPDATE flags SET reinforcement_level=3,health=1200,maximum_health=2700 WHERE id=$1", [stoneFlagId]);
    await grant(igniterId, "torch", 1, "minute-buckets");
    const ignition = await ignite(stoneFlagId, igniterId, "minute-buckets");
    const advanceTo = async (seconds: number) => {
      await pool.query(
        "UPDATE flag_burn_operations SET started_at=clock_timestamp()-((79200-$2::numeric)*interval '1 second'),completes_at=clock_timestamp()+($2::numeric*interval '1 second') WHERE operation_id=$1",
        [ignition.operation.operationId, 79200-seconds]
      );
      return flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    };
    // 1350 / 1320 HP per minute. Less than one completed minute owes nothing.
    for (const seconds of [10, 30, 59]) {
      const operations = await advanceTo(seconds);
      expect(operations.find((operation) => operation.structureId === stoneFlagId)?.healthChanged).toBe(false);
      expect(await flagHealth(stoneFlagId)).toEqual({ health: 1200, maximumHealth: 2700 });
    }
    for (const [seconds, health] of [[121, 1198], [179, 1198], [181, 1197], [361, 1194]]) {
      await advanceTo(seconds!);
      expect(await flagHealth(stoneFlagId)).toEqual({ health, maximumHealth: 2700 });
    }
    flags = new FlagService(pool, {} as never, {} as never, { info: vi.fn(), warn: vi.fn() } as never, inventory);
    await advanceTo(721); // Recover all twelve missed buckets, not twelve new ticks.
    await Promise.all([
      flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND),
      flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND)
    ]);
    expect(await flagHealth(stoneFlagId)).toEqual({ health: 1188, maximumHealth: 2700 });
    await grant(ownerId, "repair_kit", 1, "minute-pause");
    await grant(ownerId, "stone", 25, "minute-pause");
    const repair = await reserveRepair("minute-pause");
    await pool.query("UPDATE flag_burn_operations SET completes_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1", [ignition.operation.operationId]);
    await flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    await flags.structureWarfare.cancelRepair({
      kind: PERSONAL_FLAG_WARFARE_KIND, operationId: repair.operation.operationId,
      playerId: ownerId, structureId: stoneFlagId, reason: "test-resume"
    });
    await flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    expect(await flagHealth(stoneFlagId)).toEqual({ health: 1188, maximumHealth: 2700 });
  });

  it("keeps a Tower ignited at half health alive until the authored 22-hour deadline", async () => {
    await pool.query("UPDATE flags SET reinforcement_level=3,health=1350,maximum_health=2700 WHERE id=$1", [stoneFlagId]);
    await grant(igniterId, "torch", 1, "full-tower-duration");
    const ignition = await ignite(stoneFlagId, igniterId, "full-tower-duration");
    await pool.query(
      `UPDATE flag_burn_operations SET started_at=clock_timestamp()-interval '79190 seconds',
         completes_at=clock_timestamp()+interval '10 seconds' WHERE operation_id=$1`, [ignition.operation.operationId]
    );
    await flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    expect(await flagHealth(stoneFlagId)).toEqual({ health: 2, maximumHealth: 2700 });
    const completion = {
      kind: PERSONAL_FLAG_WARFARE_KIND, operationId: ignition.operation.operationId,
      playerId: igniterId, structureId: stoneFlagId, now: Date.now()
    };
    await expect(flags.structureWarfare.completeIgnition(completion)).resolves.toBeNull();
    await pool.query("UPDATE flag_burn_operations SET completes_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1", [ignition.operation.operationId]);
    await expect(flags.structureWarfare.completeIgnition(completion)).resolves.toMatchObject({ replayed: false });
    expect((await pool.query("SELECT id FROM flags WHERE id=$1", [stoneFlagId])).rows).toEqual([]);
  });

  it("persists additive burn ticks across concurrent retries and restart, and pauses below-half repairs", async () => {
    await damageToBreach(stoneFlagId, attackerIds, "tick-cycle");
    await grant(igniterId, "torch", 1, "tick-igniter");
    const ignition = await ignite(stoneFlagId, igniterId, "tick-ignition");
    await pool.query(
      `UPDATE flag_burn_operations SET started_at=clock_timestamp()-interval '6 hours',
         completes_at=clock_timestamp()+interval '16 hours'
       WHERE operation_id=$1::uuid`, [ignition.operation.operationId]
    );
    await Promise.all([
      flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND),
      flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND)
    ]);
    expect(await flagHealth(stoneFlagId)).toEqual({ health: 80, maximumHealth: 220 });
    // Other authoritative damage must stack with, rather than be replaced by,
    // subsequent burn damage. A new service simulates process restart.
    await pool.query("UPDATE flags SET health=health-6 WHERE id=$1::uuid", [stoneFlagId]);
    flags = new FlagService(pool, {} as never, {} as never, { info: vi.fn(), warn: vi.fn() } as never, inventory);
    await flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    expect(await flagHealth(stoneFlagId)).toEqual({ health: 74, maximumHealth: 220 });
    await pool.query(
      "UPDATE flag_burn_operations SET completes_at=clock_timestamp()+interval '12 hours' WHERE operation_id=$1::uuid",
      [ignition.operation.operationId]
    );
    const changed = await flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    expect(changed.find((operation) => operation.structureId === stoneFlagId)?.healthChanged).toBe(true);
    expect(await flagHealth(stoneFlagId)).toEqual({ health: 54, maximumHealth: 220 });
    await grant(ownerId, "repair_kit", 2, "tick-repair");
    await grant(ownerId, "stone", 10, "tick-repair");
    const repair = await reserveRepair("tick-repair-pause");
    await pool.query(
      "UPDATE flag_burn_operations SET completes_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1::uuid",
      [ignition.operation.operationId]
    );
    await flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    expect(await flagHealth(stoneFlagId)).toEqual({ health: 54, maximumHealth: 220 });
    await flags.structureWarfare.cancelRepair({
      kind: PERSONAL_FLAG_WARFARE_KIND, operationId: repair.operation.operationId,
      playerId: ownerId, structureId: stoneFlagId, reason: "test-resume"
    });
    await flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    expect(await flagHealth(stoneFlagId)).toEqual({ health: 54, maximumHealth: 220 });
    const resumedRepair = await reserveRepair("tick-repair-complete");
    await elapseRepair(resumedRepair.operation.operationId, 12);
    await expect(advanceRepair(resumedRepair.operation.operationId)).resolves.toMatchObject({ status: "completed" });
    expect(await flagHealth(stoneFlagId)).toEqual({ health: 220, maximumHealth: 220 });
    await flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    expect(await flagHealth(stoneFlagId)).toEqual({ health: 220, maximumHealth: 220 });
  });

  it("uses the half-health burn threshold for the soft Base, permits non-contributor ignition, and blocks Base repair without spending materials", async () => {
    expect(await flagHealth(baseFlagId)).toEqual({ health: 220, maximumHealth: 220 });

    await pool.query("UPDATE flags SET health=100 WHERE id=$1", [baseFlagId]);
    await grant(igniterId, "torch", 1, "base-igniter");
    const ignition = await flags.structureWarfare.reserveIgnition({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId: igniterId,
      structureId: baseFlagId,
      requestId: "base-ignition",
      player: player()
    });
    expect(ignition.operation.durationMs).toBe(STRUCTURE_WARFARE_BASE_BURN_DURATION_MS);
    await grant(ownerId, "repair_kit", 1, "base-repair-materials");
    await grant(ownerId, "stone", 5, "base-repair-materials");
    expect(await attackOperationCount(baseFlagId, igniterId)).toBe(0);
    await expect(flags.structureWarfare.reserveRepair({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId: ownerId,
      structureId: baseFlagId,
      requestId: "base-repair",
      player: player()
    })).rejects.toMatchObject({ code: "FLAG_REPAIR_TARGET_INVALID" });
    expect(await quantity(ownerId, "repair_kit")).toBe(1);
    expect(await quantity(ownerId, "stone")).toBe(5);
    await flags.structureWarfare.cancelIgnition({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      operationId: ignition.operation.operationId,
      structureId: baseFlagId,
      reason: "test-cleanup"
    });
  });

  it("preserves a structure's exact below-half health when manual burn starts", async () => {
    await pool.query("UPDATE flags SET health=25 WHERE id=$1", [baseFlagId]);
    await grant(igniterId, "torch", 1, "below-half-igniter");
    const ignition = await ignite(baseFlagId, igniterId, "below-half-ignition");

    expect(await flagHealth(baseFlagId)).toEqual({ health: 25, maximumHealth: 220 });
    await expect(flags.getMapFlag(baseFlagId)).resolves.toMatchObject({
      health: 25,
      maximumHealth: 220,
      burning: true
    });

    await flags.structureWarfare.cancelIgnition({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      operationId: ignition.operation.operationId,
      structureId: baseFlagId,
      reason: "test-cleanup"
    });
  });

  it("tracks a cycle through attacks, pauses and restores a Stone repair, without changing attack cooldowns", async () => {
    await damageToBreach(stoneFlagId, attackerIds, "repair-cycle");
    const cycle = await flagCycle(stoneFlagId);
    expect(cycle).toEqual(expect.any(String));
    expect(await attackCycleIds(stoneFlagId)).toEqual([cycle, cycle, cycle, cycle]);
    await grant(igniterId, "torch", 1, "repair-cycle-igniter");
    const ignition = await ignite(stoneFlagId, igniterId, "repair-cycle-ignition");
    expect(ignition.operation.durationMs).toBe(STRUCTURE_WARFARE_STONE_BURN_DURATION_MS);

    await grant(ownerId, "repair_kit", 1, "repair-cycle-materials");
    await grant(ownerId, "stone", 5, "repair-cycle-materials");
    const started = await flags.structureWarfare.reserveRepair({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId: ownerId,
      structureId: stoneFlagId,
      requestId: "repair-cycle-start",
      player: player()
    });
    expect(started.status).toBe("active");
    // Progressive repair is free: 110 missing HP at 5x the 22 h burn rate is 4.4 h.
    expect(started.operation.durationMs).toBe(4.4 * 60 * 60 * 1_000);
    expect(started.operation.pausedBurnRemainingMs).toBeGreaterThan(0);
    expect(await quantity(ownerId, "repair_kit")).toBe(1);
    expect(await quantity(ownerId, "stone")).toBe(5);
    expect(await burnPaused(stoneFlagId)).toBe(true);
    expect(await attackCooldownCount(stoneFlagId)).toBe(4);

    await elapseRepair(started.operation.operationId, 3);
    await expect(advanceRepair(started.operation.operationId)).resolves.toMatchObject({ status: "active", healthRestored: 75 });
    expect(await flagHealth(stoneFlagId)).toEqual({ health: 185, maximumHealth: 220 });
    await elapseRepair(started.operation.operationId, 3);
    const repaired = await advanceRepair(started.operation.operationId);
    expect(repaired).toMatchObject({ status: "completed", replayed: false });
    expect(await quantity(ownerId, "stone")).toBe(5);
    expect(await flagHealth(stoneFlagId)).toEqual({ health: 220, maximumHealth: 220 });
    expect(await flagCycle(stoneFlagId)).toBeNull();
    expect(await operationStatus("flag_repair_operations", started.operation.operationId)).toBe("completed");
    expect(await operationStatus("flag_burn_operations", ignition.operation.operationId)).toBe("cancelled");
    expect(await attackCooldownCount(stoneFlagId)).toBe(4);
  });

  it("settles concurrent contributor disruptions with one winner and preserves failed opportunities", async () => {
    await damageToBreach(stoneFlagId, attackerIds, "disrupt-cycle");
    const cycle = await flagCycle(stoneFlagId);
    await grant(igniterId, "torch", 1, "disrupt-igniter");
    await ignite(stoneFlagId, igniterId, "disrupt-ignition");
    await grant(ownerId, "repair_kit", 2, "disrupt-materials");
    await grant(ownerId, "stone", 10, "disrupt-materials");
    const firstRepair = await reserveRepair("disrupt-repair-a");

    const first = await flags.structureWarfare.reserveDisrupt({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId: attackerIds[0]!,
      structureId: stoneFlagId,
      repairOperationId: firstRepair.operation.operationId,
      requestId: "disrupt-a",
      player: player()
    });
    const second = await flags.structureWarfare.reserveDisrupt({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId: attackerIds[1]!,
      structureId: stoneFlagId,
      repairOperationId: firstRepair.operation.operationId,
      requestId: "disrupt-b",
      player: player()
    });
    expect(first.operation.durationMs).toBe(STRUCTURE_WARFARE_DISRUPT_DURATION_MS);
    await expireOperation("flag_repair_disrupt_operations", first.operation.operationId, STRUCTURE_WARFARE_DISRUPT_DURATION_MS);
    await expireOperation("flag_repair_disrupt_operations", second.operation.operationId, STRUCTURE_WARFARE_DISRUPT_DURATION_MS);
    const outcomes = await Promise.all([
      flags.structureWarfare.completeDisrupt({
        kind: PERSONAL_FLAG_WARFARE_KIND,
        operationId: first.operation.operationId,
        playerId: attackerIds[0]!,
        structureId: stoneFlagId,
        now: Date.now()
      }),
      flags.structureWarfare.completeDisrupt({
        kind: PERSONAL_FLAG_WARFARE_KIND,
        operationId: second.operation.operationId,
        playerId: attackerIds[1]!,
        structureId: stoneFlagId,
        now: Date.now()
      })
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const winnerId = attackerIds[outcomes[0] ? 0 : 1]!;
    const loserId = attackerIds[outcomes[0] ? 1 : 0]!;
    expect(await operationStatus("flag_repair_operations", firstRepair.operation.operationId)).toBe("disrupted");
    expect(await burnIsPaused(stoneFlagId)).toBe(false);
    expect(await attackCooldownCount(stoneFlagId)).toBe(4);
    expect(await attackOperationCount(stoneFlagId, attackerIds[0]!)).toBe(1);
    expect(await flagCycle(stoneFlagId)).toBe(cycle);
    expect(await successfulDisruptCount(winnerId, stoneFlagId, cycle!)).toBe(1);

    // The owner can immediately try again.  The winner is spent for this
    // cycle, while the cancelled loser retains its opportunity.
    const secondRepair = await reserveRepair("disrupt-repair-b");
    await expect(flags.structureWarfare.reserveDisrupt({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId: winnerId,
      structureId: stoneFlagId,
      repairOperationId: secondRepair.operation.operationId,
      requestId: "disrupt-a-again",
      player: player()
    })).rejects.toMatchObject({ code: "FLAG_DISRUPT_ALREADY_USED" });
    const loserRetry = await flags.structureWarfare.reserveDisrupt({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId: loserId,
      structureId: stoneFlagId,
      repairOperationId: secondRepair.operation.operationId,
      requestId: "disrupt-b-retry",
      player: player()
    });
    expect(loserRetry.status).toBe("active");
    await flags.structureWarfare.cancelDisrupt({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      operationId: loserRetry.operation.operationId,
      playerId: loserId,
      structureId: stoneFlagId,
      reason: "test-cleanup"
    });
    await flags.structureWarfare.cancelRepair({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      operationId: secondRepair.operation.operationId,
      playerId: ownerId,
      structureId: stoneFlagId,
      reason: "test-cleanup"
    });
  });

  it("moves no materials when a free repair is cancelled or interrupted by server shutdown", async () => {
    await damageToBreach(stoneFlagId, attackerIds, "cancel-cycle");
    await grant(igniterId, "torch", 1, "cancel-igniter");
    await ignite(stoneFlagId, igniterId, "cancel-ignition");
    await grant(ownerId, "repair_kit", 2, "cancel-materials");
    await grant(ownerId, "stone", 10, "cancel-materials");

    const cancelled = await reserveRepair("cancel-repair");
    const pausedRemaining = cancelled.operation.pausedBurnRemainingMs;
    await flags.structureWarfare.cancelRepair({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      operationId: cancelled.operation.operationId,
      playerId: ownerId,
      structureId: stoneFlagId,
      reason: "movement"
    });
    expect(await operationStatus("flag_repair_operations", cancelled.operation.operationId)).toBe("cancelled");
    expect(await quantity(ownerId, "repair_kit")).toBe(2);
    expect(await quantity(ownerId, "stone")).toBe(10);
    // The burn resumes with the time the structure's health buys.
    const resumed = await burnRemaining(stoneFlagId);
    expect(pausedRemaining).toBeGreaterThan(0);
    expect(resumed).toBeGreaterThan(0);
    expect(resumed).toBeLessThanOrEqual(STRUCTURE_WARFARE_STONE_BURN_DURATION_MS);

    const restarted = await reserveRepair("restart-repair");
    await flags.structureWarfare.recoverRepairsForServerShutdown(PERSONAL_FLAG_WARFARE_KIND);
    expect(await operationStatus("flag_repair_operations", restarted.operation.operationId)).toBe("server_refunded");
    // Repair is free, so neither cancellation nor shutdown moves materials.
    expect(await quantity(ownerId, "repair_kit")).toBe(2);
    expect(await quantity(ownerId, "stone")).toBe(10);
    await flags.structureWarfare.recoverRepairsForServerShutdown(PERSONAL_FLAG_WARFARE_KIND);
    expect(await quantity(ownerId, "repair_kit")).toBe(2);
    expect(await quantity(ownerId, "stone")).toBe(10);
    expect(await burnIsPaused(stoneFlagId)).toBe(false);
    expect(await burnRemaining(stoneFlagId)).toBeGreaterThan(0);
  });

  it("a Ember Bomb strike hits an enemy Flag for its fixed damage once, and never the thrower's own Flag", async () => {
    const thrower = attackerIds[0]!;
    const strike = { origin: { lat: 35, lon: -106 }, radiusM: 50, damage: 50 } as const;
    const before = await flagHealth(baseFlagId);
    const first = await flags.attackFlag(thrower, baseFlagId, "ember-bomb-1:" + baseFlagId, player(), strike);
    expect(first.replayed).toBe(false);
    expect(before.health - (await flagHealth(baseFlagId)).health).toBe(50);
    // The same throw replayed (same request id) deals nothing more.
    const replay = await flags.attackFlag(thrower, baseFlagId, "ember-bomb-1:" + baseFlagId, player(), strike);
    expect(replay.replayed).toBe(true);
    expect(before.health - (await flagHealth(baseFlagId)).health).toBe(50);
    // Your own Flag is refused.
    await expect(flags.attackFlag(ownerId, stoneFlagId, "ember-bomb-own", player(), strike)).rejects.toMatchObject({
      code: "FLAG_ATTACK_TARGET_INVALID"
    });
  });

  it("allows owner demolition after damage and terminalizes warfare without a normal refund", async () => {
    await grant(ownerId, "stone", 1, "demolition-spend");
    await pool.query(
      `INSERT INTO flag_material_spend (
         flag_id,stage,item_id,variant,quantity,paid_by_player_id,source_operation_key
       ) VALUES ($1,'stone','stone','default',1,$2,'demolition-spend')`,
      [stoneFlagId, ownerId]
    );
    await attack(stoneFlagId, attackerIds[0]!, "demolition-attack");
    const before = await quantity(ownerId, "stone");
    await flags.deleteFlag(stoneFlagId, ownerId, false, "demolition-request");
    expect(await pool.query("SELECT count(*)::int AS count FROM flags WHERE id=$1", [stoneFlagId]))
      .toMatchObject({ rows: [{ count: 0 }] });
    expect(await quantity(ownerId, "stone")).toBe(before);
    expect(await pool.query(
      `SELECT count(*)::int AS count FROM flag_attack_operations WHERE flag_id=$1`,
      [stoneFlagId]
    )).toMatchObject({ rows: [{ count: 0 }] });
  });

  async function attack(flagId: string, playerId: string, requestId: string): Promise<void> {
    await flags.structureWarfare.attack({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId,
      structureId: flagId,
      requestId,
      player: player()
    });
  }

  async function damageToBreach(flagId: string, attackers: readonly string[], prefix: string): Promise<void> {
    for (const [index, attackerId] of attackers.entries()) {
      await attack(flagId, attackerId, `${prefix}-${index}`);
    }
    // Four 25 HP hits leave 120 of 220; the breach threshold is half of max HP.
    await pool.query("UPDATE flags SET health=LEAST(health,110) WHERE id=$1", [flagId]);
  }

  async function ignite(flagId: string, playerId: string, requestId: string) {
    return flags.structureWarfare.reserveIgnition({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId,
      structureId: flagId,
      requestId,
      player: player()
    });
  }

  async function elapseRepair(operationId: string, hours: number): Promise<void> {
    await pool.query(
      "UPDATE flag_repair_operations SET started_at=started_at-($2::numeric*interval '1 hour') WHERE operation_id=$1",
      [operationId, hours]
    );
  }

  async function advanceRepair(operationId: string) {
    return flags.structureWarfare.advanceRepair({
      kind: PERSONAL_FLAG_WARFARE_KIND, operationId, playerId: ownerId, structureId: stoneFlagId
    });
  }

  async function reserveRepair(requestId: string) {
    return flags.structureWarfare.reserveRepair({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId: ownerId,
      structureId: stoneFlagId,
      requestId,
      player: player()
    });
  }

  async function insertFlag(reinforcementLevel: number, name: string): Promise<string> {
    const id = randomUUID();
    // The placement invariant rejects centers inside another flag's claim.
    // Keep both fixtures within the interaction radius of the shared player
    // position while leaving a small legal gap between their 20m claims.
    const lat = reinforcementLevel === 0 ? 35.0003 : 34.9997;
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,resource_vision_radius_m,
         control_type,anchor_kind,system_controlled,reinforcement_level,
         access_mode,geom
       ) VALUES ($1,$2,$3,$5,-106,20,650,'personal','flag',false,$4,'public',
                 ST_SetSRID(ST_MakePoint(-106,$5),4326))`,
      [id, ownerId, name, reinforcementLevel, lat]
    );
    return id;
  }

  function player() {
    return { position: { lat: 35, lon: -106 }, target: null, online: true } as const;
  }

  async function grant(playerId: string, itemId: "torch" | "repair_kit" | "stone", quantity: number, key: string): Promise<PlayerInventorySnapshot> {
    const result = await inventory.grantItemsForOperation({
      operationKey: `${key}:${playerId}:${randomUUID()}`,
      playerId,
      source: "personal_flag_warfare_test",
      sourceEntityType: "personal_flag_warfare_test",
      sourceEntityId: playerId,
      grants: [{ itemId, variant: "default", quantity }]
    });
    return result.inventory;
  }

  async function flagHealth(flagId: string): Promise<{ health: number; maximumHealth: number }> {
    const result = await pool.query<{ health: number; maximum_health: number }>(
      "SELECT health,maximum_health FROM flags WHERE id=$1",
      [flagId]
    );
    return {
      health: Number(result.rows[0]!.health),
      maximumHealth: Number(result.rows[0]!.maximum_health)
    };
  }

  async function flagCycle(flagId: string): Promise<string | null> {
    const result = await pool.query<{ damage_cycle_id: string | null }>(
      "SELECT damage_cycle_id::text FROM flags WHERE id=$1",
      [flagId]
    );
    return result.rows[0]?.damage_cycle_id ?? null;
  }

  async function attackCycleIds(flagId: string): Promise<string[]> {
    const result = await pool.query<{ damage_cycle_id: string }>(
      "SELECT damage_cycle_id::text FROM flag_attack_operations WHERE flag_id=$1 ORDER BY created_at,operation_id",
      [flagId]
    );
    return result.rows.map((row) => row.damage_cycle_id);
  }

  async function attackOperationCount(flagId: string, playerId: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM flag_attack_operations WHERE flag_id=$1 AND player_id=$2",
      [flagId, playerId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function attackCooldownCount(flagId: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM flag_attack_cooldowns WHERE flag_id=$1",
      [flagId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function quantity(playerId: string, itemId: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      "SELECT COALESCE(sum(quantity),0)::text AS quantity FROM player_inventory WHERE player_id=$1 AND resource_type=$2 AND variant='default'",
      [playerId, itemId]
    );
    return Number(result.rows[0]?.quantity ?? 0);
  }

  async function burnRemaining(flagId: string): Promise<number> {
    const result = await pool.query<{ remaining: string }>(
      `SELECT GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (completes_at-clock_timestamp()))*1000))::bigint::text AS remaining
       FROM flag_burn_operations WHERE flag_id=$1 AND status='active'`,
      [flagId]
    );
    return Number(result.rows[0]?.remaining ?? 0);
  }

  async function burnPaused(flagId: string): Promise<boolean> {
    const result = await pool.query<{ paused_at: Date | null }>(
      "SELECT paused_at FROM flag_burn_operations WHERE flag_id=$1 AND status='active'",
      [flagId]
    );
    return result.rows[0]?.paused_at !== null;
  }

  async function burnIsPaused(flagId: string): Promise<boolean> {
    return burnPaused(flagId);
  }

  async function operationStatus(table: string, operationId: string): Promise<string | null> {
    const result = await pool.query<{ status: string }>(
      `SELECT status FROM ${table} WHERE operation_id=$1`,
      [operationId]
    );
    return result.rows[0]?.status ?? null;
  }

  async function successfulDisruptCount(playerId: string, flagId: string, cycle: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM flag_repair_disrupt_operations
       WHERE contributor_player_id=$1 AND flag_id=$2 AND damage_cycle_id=$3 AND status='completed'`,
      [playerId, flagId, cycle]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function expireOperation(table: "flag_repair_operations" | "flag_repair_disrupt_operations", operationId: string, durationMs: number): Promise<void> {
    await pool.query(
      `WITH due AS (SELECT clock_timestamp()-($2::bigint*interval '1 millisecond') AS started_at)
       UPDATE ${table}
       SET started_at=due.started_at,completes_at=due.started_at+($2::bigint*interval '1 millisecond')
       FROM due WHERE operation_id=$1`,
      [operationId, durationMs]
    );
  }
});
