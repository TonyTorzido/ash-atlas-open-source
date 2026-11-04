import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PLAYER_SPEED_MPS,
  destinationPoint,
  distanceMeters,
  MILITARY_FOLLOW_DISTANCE_M,
  MILITARY_UNIT_RECIPES,
  MILITARY_FOLLOW_SPEED_RATIO,
  MILITARY_BALLISTA_VOLLEY_CADENCE_MS,
  MILITARY_FUSION_RANGE_M,
  SIEGE_ATTACK_RANGE_METERS,
  SIEGE_PACK_UP_DURATION_MS
} from "@ash-atlas/shared";
import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { deleteFlagForBurnInTransaction, FlagService } from "./flags.js";
import { InventoryService } from "./inventory.js";
import {
  MilitaryIndustryService
} from "./militaryIndustry.js";
import type { CombatEngine } from "./combat/combatEngine.js";
import type { PlayerRecord } from "./state.js";
import { PERSONAL_FLAG_WARFARE_KIND } from "./structureWarfare.js";
import { WalletService } from "./wallet.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

type MilitaryPlayer = Pick<
  PlayerRecord,
  "playerId" | "position" | "regionCode" | "anchor" | "moveLeashRadiusM"
> & Partial<Pick<PlayerRecord, "resourceVision">>;

type Fixture = {
  playerId: string;
  accountId: string;
  enemyId: string;
  cityId: string;
  facilityId: string;
  lodgeId: string;
  campId: string;
  targetFlagId: string;
  position: { lat: number; lon: number };
  player: MilitaryPlayer;
  inventory: InventoryService;
  wallet: WalletService;
  service: MilitaryIndustryService;
};

describeDatabase("Military Industry service/database integration", () => {
  const databaseName = `ash_atlas_stability_military_service_${randomUUID().replaceAll("-", "")}`;
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let pool: DisposableTestPool;
  let fixtureSequence = 0;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!parsed.pathname.includes("ash_atlas_stability")) {
      throw new Error("Military service integration requires an ash_atlas_stability admin database");
    }
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: migrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 8 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
  });

  beforeEach(async () => {
    // Reconciliation scans all owners, including previously idle groups.
    // Each test owns a fresh fixture in this suite's disposable database.
    await pool.query("TRUNCATE players CASCADE");
  });

  it("serializes the final Lodge slot and settles exactly one training job", async () => {
    const fixture = await seedFixture({ lodgeReservedCapacity: 1 });
    const results = await Promise.allSettled([
      fixture.service.startMilitaryUnitTraining(
        fixture.player,
        fixture.accountId,
        fixture.facilityId,
        "infantry",
        "training-final-slot-a"
      ),
      fixture.service.startMilitaryUnitTraining(
        fixture.player,
        fixture.accountId,
        fixture.facilityId,
        "infantry",
        "training-final-slot-b"
      )
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
      code: "LODGE_CAPACITY_FULL"
    });

    await pool.query(
      `UPDATE military_facility_jobs
       SET started_at=clock_timestamp()-interval '2 seconds',
           completes_at=clock_timestamp()-interval '1 second'
       WHERE owner_player_id=$1 AND cleared_at IS NULL`,
      [fixture.playerId]
    );
    await expect(fixture.service.reconcileDueTrainingJobs()).resolves.toBe(1);
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM military_units WHERE owner_player_id=$1",
      [fixture.playerId]
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool.query<{ reserved_capacity: number }>(
      "SELECT reserved_capacity FROM player_lodges WHERE lodge_id=$1",
      [fixture.lodgeId]
    )).resolves.toMatchObject({ rows: [{ reserved_capacity: 1 }] });
  }, 30_000);

  it("debits each military recipe exactly once and keeps an insufficient retry atomic", async () => {
    const cases = [
      {
        unitType: "infantry" as const,
        materials: [
          { itemId: "simple_food", quantity: 50 },
          { itemId: "wood", quantity: 50 },
          { itemId: "leather", quantity: 25 }
        ] as const
      },
      {
        unitType: "archer" as const,
        materials: [
          { itemId: "simple_food", quantity: 50 },
          { itemId: "wood", quantity: 75 },
          { itemId: "cloth", quantity: 25 }
        ] as const
      },
      {
        unitType: "bomber" as const,
        materials: [
          { itemId: "sulfur", quantity: 6 },
          { itemId: "crude_oil", quantity: 55 },
          { itemId: "simple_food", quantity: 100 }
        ] as const
      },
      {
        unitType: "field_ballista" as const,
        materials: [
          { itemId: "iron_bar", quantity: 25 },
          { itemId: "wood", quantity: 150 },
          { itemId: "cloth", quantity: 75 }
        ] as const
      }
    ] as const;

    for (const recipe of cases) {
      const fixture = await seedFixture();
      if (recipe.unitType === "bomber") {
        await fixture.inventory.grantItemsForOperation({
          operationKey: `military-recipe-sulfur-seed:${fixture.playerId}`,
          playerId: fixture.playerId,
          source: "military_recipe_test_seed",
          grants: [
            { itemId: "sulfur", variant: "default", quantity: 10 },
            { itemId: "crude_oil", variant: "default", quantity: 150 }
          ]
        });
      }
      if (recipe.unitType === "field_ballista") {
        await fixture.inventory.grantItemsForOperation({
          operationKey: `military-recipe-siege-seed:${fixture.playerId}`,
          playerId: fixture.playerId,
          source: "military_recipe_test_seed",
          grants: [
            { itemId: "iron_bar", variant: "default", quantity: 5 },
            { itemId: "wood", variant: "default", quantity: 50 },
            { itemId: "cloth", variant: "default", quantity: 25 }
          ]
        });
      }
      if (recipe.unitType === "bomber" || recipe.unitType === "field_ballista") {
        await pool.query(
          "UPDATE city_structures SET structure_type='demolition_factory' WHERE structure_id=$1::uuid",
          [fixture.facilityId]
        );
      }
      const before = await fixture.inventory.getInventorySnapshot(fixture.playerId);
      const requestId = `military-recipe-${recipe.unitType}-${fixture.playerId}`;
      const start = () => recipe.unitType === "field_ballista"
        ? fixture.service.manufactureFieldBallista(fixture.player, fixture.accountId, fixture.facilityId, requestId)
        : fixture.service.startMilitaryUnitTraining(fixture.player, fixture.accountId, fixture.facilityId, recipe.unitType, requestId);
      const first = await start();
      expect(first.replayed).toBe(false);
      expect(first.inventory).toBeDefined();
      const after = first.inventory!;
      for (const material of recipe.materials) {
        expect(after.totals[material.itemId]).toBe(
          (before.totals[material.itemId] ?? 0) - material.quantity
        );
      }
      expect(first.walletGold).toBe(String(5000 - MILITARY_UNIT_RECIPES[recipe.unitType].gold));

      const replay = await start();
      expect(replay.replayed).toBe(true);
      expect(replay.inventory?.totals).toEqual(after.totals);
    }

    const insufficientFixture = await seedFixture();
    const infantryRequestId = `military-recipe-insufficient-infantry-${insufficientFixture.playerId}`;
    const infantry = await insufficientFixture.service.startMilitaryUnitTraining(
      insufficientFixture.player,
      insufficientFixture.accountId,
      insufficientFixture.facilityId,
      "infantry",
      infantryRequestId
    );
    const beforeInsufficient = infantry.inventory!;
    await expect(insufficientFixture.service.startMilitaryUnitTraining(
      insufficientFixture.player,
      insufficientFixture.accountId,
      insufficientFixture.facilityId,
      "archer",
      `military-recipe-insufficient-archer-${insufficientFixture.playerId}`
    )).rejects.toMatchObject({ code: "MILITARY_MATERIALS_REQUIRED" });
    await expect(insufficientFixture.inventory.getInventorySnapshot(insufficientFixture.playerId))
      .resolves.toMatchObject({ totals: beforeInsufficient.totals });
  }, 120_000);

  it("charges rising crude oil for parallel bomber trains exactly once each", async () => {
    const fixture = await seedFixture();
    await pool.query(
      "UPDATE city_structures SET structure_type='demolition_factory' WHERE structure_id=$1::uuid",
      [fixture.facilityId]
    );
    await fixture.inventory.grantItemsForOperation({
      operationKey: `military-bomber-seed:${fixture.playerId}`,
      playerId: fixture.playerId,
      source: "military_recipe_test_seed",
      grants: [
        { itemId: "sulfur", variant: "default", quantity: 12 },
        { itemId: "crude_oil", variant: "default", quantity: 155 },
        { itemId: "simple_food", variant: "default", quantity: 100 }
      ]
    });
    const train = (requestId: string) => fixture.service.startMilitaryUnitTraining(
      fixture.player, fixture.accountId, fixture.facilityId, "bomber", requestId
    );
    const results = await Promise.all([train("bomber-oil-a"), train("bomber-oil-b")]);
    expect(results.every((result) => !result.replayed)).toBe(true);
    const oil = (await fixture.inventory.getInventorySnapshot(fixture.playerId)).totals.crude_oil;
    expect(oil).toBe(0);
    await expect(train("bomber-oil-a")).resolves.toMatchObject({ replayed: true });
    expect((await fixture.inventory.getInventorySnapshot(fixture.playerId)).totals.crude_oil).toBe(0);
    expect((await fixture.service.snapshot(fixture.player.playerId)).bomberCrudeOilPrice).toBe(145);
  }, 60_000);

  it("keeps fusion/split idempotent while attacks aggregate surviving members", async () => {
    const fixture = await seedFixture();
    const first = await insertGroup(fixture, "infantry", 1, "STATIONED_CITY");
    const second = await insertGroup(fixture, "infantry", 1, "STATIONED_CITY");
    const combined = await fixture.service.combineMilitaryGroups(
      fixture.player,
      [first.groupId, second.groupId],
      "combine-once"
    );
    expect(combined.replayed).toBe(false);
    await expect(fixture.service.combineMilitaryGroups(
      fixture.player,
      [first.groupId, second.groupId],
      "combine-once"
    )).resolves.toMatchObject({ replayed: true });
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM military_unit_groups WHERE owner_player_id=$1",
      [fixture.playerId]
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const split = await fixture.service.splitMilitaryGroup(
      fixture.playerId,
      first.groupId,
      [1, 1],
      "split-once"
    );
    expect(split.replayed).toBe(false);
    await expect(fixture.service.splitMilitaryGroup(
      fixture.playerId,
      first.groupId,
      [1, 1],
      "split-once"
    )).resolves.toMatchObject({ replayed: true });
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM military_unit_groups WHERE owner_player_id=$1",
      [fixture.playerId]
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });

    const fusedSiege = await insertGroup(fixture, "field_ballista", 2, "STATIONED_CITY");
    await expect(fixture.service.splitMilitaryGroup(
      fixture.playerId,
      fusedSiege.groupId,
      [1, 1],
      "split-fused-siege-rejected"
    )).rejects.toMatchObject({ code: "MILITARY_SPLIT_INVALID" });
    const fusedBomber = await insertGroup(fixture, "bomber", 2, "STATIONED_CITY");
    await expect(fixture.service.splitMilitaryGroup(
      fixture.playerId,
      fusedBomber.groupId,
      [1, 1],
      "split-fused-bomber-rejected"
    )).rejects.toMatchObject({ code: "MILITARY_SPLIT_INVALID" });

    const attackGroup = await insertGroup(fixture, "infantry", 2, "DEPLOYED_FIELD");
    const applyMilitaryAttack = vi.fn(({ damage }: { damage: number }) => damage);
    const combat = { applyMilitaryAttack } as unknown as Pick<CombatEngine, "applyMilitaryAttack">;
    await expect(fixture.service.attackMilitaryGroup(
      fixture.player,
      attackGroup.groupId,
      "enemy-personal-target",
      "attack-once",
      combat
    )).resolves.toMatchObject({ damage: 22, replayed: false });
    await expect(fixture.service.attackMilitaryGroup(
      fixture.player,
      attackGroup.groupId,
      "enemy-personal-target",
      "attack-once",
      combat
    )).resolves.toMatchObject({ damage: 22, replayed: true });
    expect(applyMilitaryAttack).toHaveBeenCalledOnce();

    await fixture.service.applyUnitDamage(fixture.playerId, attackGroup.unitIds[0]!, 100);
    await expect(fixture.service.attackMilitaryGroup(
      fixture.player,
      attackGroup.groupId,
      "enemy-personal-target",
      "attack-after-member-loss",
      combat
    )).resolves.toMatchObject({ damage: 11, replayed: false });
    expect(applyMilitaryAttack).toHaveBeenCalledTimes(2);
    await expect(pool.query<{ status: string; location_state: string }>(
      "SELECT status,location_state FROM military_units WHERE unit_id=$1",
      [attackGroup.unitIds[0]]
    )).resolves.toMatchObject({ rows: [{ status: "recovering", location_state: "RECOVERING" }] });
  }, 30_000);

  it("merges Siege groups into the first clicked destination within the fusion range", async () => {
    const fixture = await seedFixture();
    const destinationPosition = fixture.position;
    const sourcePosition = destinationPoint(fixture.position, 900, 90);
    const destination = await insertGroup(fixture, "field_ballista", 2, "DEPLOYED_FIELD", {
      position: destinationPosition
    });
    const source = await insertGroup(fixture, "field_ballista", 2, "DEPLOYED_FIELD", {
      position: sourcePosition
    });
    const commandPlayer: MilitaryPlayer = {
      ...fixture.player,
      resourceVision: {
        flagId: `fusion-vision-${fixture.playerId}`,
        flagName: "Fusion test vision",
        destinationKind: "area",
        center: fixture.position,
        movementLeashRadiusM: 2_000,
        paddingM: 0,
        radiusM: 2_000
      }
    };

    const merged = await fixture.service.combineMilitaryGroups(
      commandPlayer,
      [destination.groupId, source.groupId],
      "siege-merge-destination"
    );
    expect(merged.replayed).toBe(false);
    const mergedGroup = merged.snapshot.groups.find((group) => group.groupId === destination.groupId);
    expect(mergedGroup).toMatchObject({
      groupId: destination.groupId,
      memberCount: 4,
      currentHp: 600,
      maxHp: 600,
      locationState: "DEPLOYED_FIELD",
      lat: destinationPosition.lat,
      lon: destinationPosition.lon
    });
    expect(merged.snapshot.groups.some((group) => group.groupId === source.groupId)).toBe(false);
    await expect(pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM military_units
       WHERE owner_player_id=$1 AND group_id=$2::uuid AND status='available' AND lat=$3 AND lon=$4`,
      [fixture.playerId, destination.groupId, destinationPosition.lat, destinationPosition.lon]
    )).resolves.toMatchObject({ rows: [{ count: 4 }] });
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM military_unit_groups WHERE group_id=$1::uuid",
      [source.groupId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(fixture.service.combineMilitaryGroups(
      commandPlayer,
      [destination.groupId, source.groupId],
      "siege-merge-destination"
    )).resolves.toMatchObject({ replayed: true });
  }, 30_000);

  it("keeps fusion cap, range, kind, and concurrent merge failures atomic", async () => {
    const fixture = await seedFixture();
    const commandPlayer: MilitaryPlayer = {
      ...fixture.player,
      resourceVision: {
        flagId: `fusion-vision-${fixture.playerId}`,
        flagName: "Fusion test vision",
        destinationKind: "area",
        center: fixture.position,
        movementLeashRadiusM: 2_000,
        paddingM: 0,
        radiusM: 2_000
      }
    };
    const capDestination = await insertGroup(fixture, "field_ballista", 5, "DEPLOYED_FIELD");
    const capSource = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    await expect(fixture.service.combineMilitaryGroups(
      commandPlayer,
      [capDestination.groupId, capSource.groupId],
      "siege-merge-cap"
    )).resolves.toMatchObject({ replayed: false });
    const overCapSource = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    await expect(fixture.service.combineMilitaryGroups(
      commandPlayer,
      [capDestination.groupId, overCapSource.groupId],
      "siege-merge-over-cap"
    )).rejects.toMatchObject({ code: "MILITARY_FUSION_INVALID_SIZE" });
    await expect(pool.query<{ group_count: number; member_count: number }>(
      `SELECT count(DISTINCT group_row.group_id)::int AS group_count,
              count(unit.unit_id)::int AS member_count
       FROM military_unit_groups group_row
       LEFT JOIN military_units unit ON unit.group_id=group_row.group_id AND unit.status='available'
       WHERE group_row.owner_player_id=$1 AND group_row.group_id=ANY($2::uuid[])`,
      [fixture.playerId, [capDestination.groupId, overCapSource.groupId]]
    )).resolves.toMatchObject({ rows: [{ group_count: 2, member_count: 7 }] });

    const farSource = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD", {
      position: destinationPoint(fixture.position, MILITARY_FUSION_RANGE_M + 1, 0)
    });
    await expect(fixture.service.combineMilitaryGroups(
      commandPlayer,
      [capDestination.groupId, farSource.groupId],
      "siege-merge-out-of-range"
    )).rejects.toMatchObject({ code: "MILITARY_GROUP_INCOMPATIBLE" });
    const wrongKind = await insertGroup(fixture, "infantry", 1, "DEPLOYED_FIELD");
    await expect(fixture.service.combineMilitaryGroups(
      commandPlayer,
      [capDestination.groupId, wrongKind.groupId],
      "siege-merge-wrong-kind"
    )).rejects.toMatchObject({ code: "MILITARY_GROUP_INCOMPATIBLE" });
    await expect(fixture.service.combineMilitaryGroups(
      commandPlayer,
      [capDestination.groupId, capDestination.groupId],
      "siege-merge-self"
    )).rejects.toMatchObject({ code: "MILITARY_FUSION_INVALID_SIZE" });

    const concurrentDestination = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    const concurrentSource = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    const concurrent = await Promise.allSettled([
      fixture.service.combineMilitaryGroups(commandPlayer, [concurrentDestination.groupId, concurrentSource.groupId], "siege-merge-concurrent-a"),
      fixture.service.combineMilitaryGroups(commandPlayer, [concurrentDestination.groupId, concurrentSource.groupId], "siege-merge-concurrent-b")
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    const concurrentFailure = concurrent.find((result) => result.status === "rejected");
    expect(concurrentFailure?.status === "rejected" ? concurrentFailure.reason : null).toMatchObject({
      code: "MILITARY_GROUP_NOT_FOUND"
    });
  }, 30_000);

  it("preserves Bomber fusion HP and spends one charge per successful bomb", async () => {
    const fixture = await seedFixture();
    const bomberPosition = destinationPoint(fixture.position, 200, 90);
    const bomberDestination = await insertGroup(fixture, "bomber", 2, "DEPLOYED_FIELD", {
      position: bomberPosition
    });
    const bomberSource = await insertGroup(fixture, "bomber", 2, "DEPLOYED_FIELD", {
      position: bomberPosition
    });
    const merged = await fixture.service.combineMilitaryGroups(
      fixture.player,
      [bomberDestination.groupId, bomberSource.groupId],
      "bomber-merge-once"
    );
    const mergedGroup = merged.snapshot.groups.find((group) => group.groupId === bomberDestination.groupId);
    expect(mergedGroup).toMatchObject({ memberCount: 4, currentHp: 240, maxHp: 240 });
    await moveTargetTower(fixture.targetFlagId, bomberPosition, 2_700);
    await expect(fixture.service.demolishFlag(
      fixture.player,
      bomberDestination.groupId,
      fixture.targetFlagId,
      "bomber-merge-bomb-a"
    )).resolves.toMatchObject({ replayed: false });
    await pool.query(
      `UPDATE military_siege_operations
       SET started_at=clock_timestamp()-interval '2 seconds',
           completes_at=clock_timestamp()-interval '1 second'
       WHERE player_id=$1 AND request_id='bomber-merge-bomb-a'`,
      [fixture.playerId]
    );
    await expect(fixture.service.reconcileDueBomberDemolitions()).resolves.toBe(1);
    await expect(pool.query<{ health: number }>(
      "SELECT health FROM flags WHERE id=$1::uuid",
      [fixture.targetFlagId]
    )).resolves.toMatchObject({ rows: [{ health: 1_550 }] });

    await expect(fixture.service.demolishFlag(
      fixture.player,
      bomberDestination.groupId,
      fixture.targetFlagId,
      "bomber-merge-bomb-b"
    )).resolves.toMatchObject({ replayed: false });
    await pool.query(
      `UPDATE military_siege_operations
       SET started_at=clock_timestamp()-interval '2 seconds',
           completes_at=clock_timestamp()-interval '1 second'
       WHERE player_id=$1 AND request_id='bomber-merge-bomb-b'`,
      [fixture.playerId]
    );
    await expect(fixture.service.reconcileDueBomberDemolitions()).resolves.toBe(1);
    await expect(pool.query<{ health: number; burning_reason: string | null }>(
      "SELECT health,burning_reason FROM flags WHERE id=$1::uuid",
      [fixture.targetFlagId]
    )).resolves.toMatchObject({ rows: [{ health: 400, burning_reason: null }] });
    await expect(pool.query<{ available: number; destroyed: number }>(
      `SELECT count(*) FILTER (WHERE status='available')::int AS available,
              count(*) FILTER (WHERE status='destroyed')::int AS destroyed
       FROM military_units WHERE owner_player_id=$1 AND group_id=$2::uuid`,
      [fixture.playerId, bomberDestination.groupId]
    )).resolves.toMatchObject({ rows: [{ available: 2, destroyed: 0 }] });
  }, 30_000);

  it("queues an owned Siege to an exact planned point, progresses without teleporting, and replays safely", async () => {
    const fixture = await seedFixture();
    const siege = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    const destination = destinationPoint(fixture.position, SIEGE_ATTACK_RANGE_METERS, 0);
    const before = await pool.query<{ lat: number; lon: number }>(
      "SELECT lat,lon FROM military_unit_groups WHERE group_id=$1",
      [siege.groupId]
    );
    const moved = await fixture.service.moveMilitaryGroupToPosition(
      fixture.player,
      siege.groupId,
      destination,
      "move-siege-once"
    );
    expect(moved.replayed).toBe(false);
    const queued = moved.snapshot.groups.find((group) => group.groupId === siege.groupId);
    expect(queued).toMatchObject({
      locationState: "DEPLOYED_FIELD",
      movementOrder: "MOVE_TO_COORDINATE",
      movementTarget: destination
    });
    await expect(pool.query<{ lat: number; lon: number }>(
      "SELECT lat,lon FROM military_unit_groups WHERE group_id=$1",
      [siege.groupId]
    )).resolves.toMatchObject({
      rows: [{ lat: expect.closeTo(Number(before.rows[0]!.lat), 10), lon: expect.closeTo(Number(before.rows[0]!.lon), 10) }]
    });
    await expect(fixture.service.moveMilitaryGroupToPosition(
      fixture.player,
      siege.groupId,
      destination,
      "move-siege-once"
    )).resolves.toMatchObject({ replayed: true });
    await expect(fixture.service.packUpMilitaryGroup(
      fixture.player,
      siege.groupId,
      "pack-while-moving"
    )).rejects.toMatchObject({ code: "MILITARY_GROUP_MOVING" });
    await expect(fixture.service.reconcileFollowingMilitaryGroups([], 10)).resolves.toBe(1);
    await expect(pool.query<{ lat: number; lon: number }>(
      "SELECT lat,lon FROM military_unit_groups WHERE group_id=$1",
      [siege.groupId]
    )).resolves.toMatchObject({
      rows: [{ lat: expect.closeTo(destination.lat, 10), lon: expect.closeTo(destination.lon, 10) }]
    });
    await expect(pool.query<{ location_state: string; movement_order: string; movement_target_lat: number | null; movement_target_lon: number | null }>(
      "SELECT location_state,movement_order,movement_target_lat,movement_target_lon FROM military_unit_groups WHERE group_id=$1",
      [siege.groupId]
    )).resolves.toMatchObject({
      rows: [{ location_state: "PACKED_FIELD", movement_order: "NONE", movement_target_lat: null, movement_target_lon: null }]
    });

    const infantry = await insertGroup(fixture, "infantry", 1, "DEPLOYED_FIELD");
    const infantryBeforeMove = await pool.query<{ lat: number; lon: number }>(
      "SELECT lat,lon FROM military_unit_groups WHERE group_id=$1",
      [infantry.groupId]
    );
    await expect(fixture.service.moveMilitaryGroupToPosition(
      fixture.player,
      infantry.groupId,
      destination,
      "move-infantry-once"
    )).resolves.toMatchObject({ replayed: false, snapshot: { groups: expect.arrayContaining([
      expect.objectContaining({ groupId: infantry.groupId, movementOrder: "MOVE_TO_COORDINATE" })
    ]) } });
    await expect(pool.query<{ lat: number; lon: number }>(
      "SELECT lat,lon FROM military_unit_groups WHERE group_id=$1",
      [infantry.groupId]
    )).resolves.toMatchObject({
      rows: [{
        lat: expect.closeTo(Number(infantryBeforeMove.rows[0]!.lat), 10),
        lon: expect.closeTo(Number(infantryBeforeMove.rows[0]!.lon), 10)
      }]
    });
    await expect(fixture.service.reconcileFollowingMilitaryGroups([], 1)).resolves.toBe(1);
    const infantryAfterTick = await pool.query<{ lat: number; lon: number }>(
      "SELECT lat,lon FROM military_unit_groups WHERE group_id=$1",
      [infantry.groupId]
    );
    expect(distanceMeters(
      { lat: Number(infantryBeforeMove.rows[0]!.lat), lon: Number(infantryBeforeMove.rows[0]!.lon) },
      { lat: Number(infantryAfterTick.rows[0]!.lat), lon: Number(infantryAfterTick.rows[0]!.lon) }
    )).toBeGreaterThan(0);
  }, 30_000);

  it("authorizes a remote visible own group but rejects an out-of-scope group", async () => {
    const fixture = await seedFixture();
    const siege = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    const remotePosition = destinationPoint(fixture.position, 120, 0);
    await pool.query(
      "UPDATE military_unit_groups SET lat=$2,lon=$3 WHERE group_id=$1::uuid",
      [siege.groupId, remotePosition.lat, remotePosition.lon]
    );
    await pool.query(
      "UPDATE military_units SET lat=$2,lon=$3 WHERE group_id=$1::uuid",
      [siege.groupId, remotePosition.lat, remotePosition.lon]
    );
    const remoteVisiblePlayer = {
      ...fixture.player,
      position: fixture.position,
      anchor: fixture.position,
      resourceVision: null
    };
    await expect(fixture.service.moveMilitaryGroupToPosition(
      remoteVisiblePlayer,
      siege.groupId,
      fixture.position,
      "move-remote-visible"
    )).resolves.toMatchObject({ replayed: false });

    const outOfScope = destinationPoint(fixture.position, 800, 0);
    await pool.query(
      "UPDATE military_unit_groups SET lat=$2,lon=$3,movement_order='NONE',movement_target_lat=NULL,movement_target_lon=NULL WHERE group_id=$1::uuid",
      [siege.groupId, outOfScope.lat, outOfScope.lon]
    );
    await pool.query(
      "UPDATE military_units SET lat=$2,lon=$3,movement_order='NONE',movement_target_lat=NULL,movement_target_lon=NULL WHERE group_id=$1::uuid",
      [siege.groupId, outOfScope.lat, outOfScope.lon]
    );
    await expect(fixture.service.moveMilitaryGroupToPosition(
      remoteVisiblePlayer,
      siege.groupId,
      fixture.position,
      "move-out-of-scope"
    )).rejects.toMatchObject({ code: "MILITARY_GROUP_OUT_OF_SCOPE" });
  }, 30_000);

  it("follows a Siege at 70% speed, holds a 125m trail, and cancels through Stay/Deploy", async () => {
    const fixture = await seedFixture();
    const siege = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    const startingPosition = destinationPoint(fixture.position, 250, 180);
    await pool.query(
      "UPDATE military_unit_groups SET lat=$2,lon=$3 WHERE group_id=$1::uuid",
      [siege.groupId, startingPosition.lat, startingPosition.lon]
    );
    await pool.query(
      "UPDATE military_units SET lat=$2,lon=$3 WHERE group_id=$1::uuid",
      [siege.groupId, startingPosition.lat, startingPosition.lon]
    );

    await fixture.service.setMilitaryGroupState(
      fixture.player,
      siege.groupId,
      "FOLLOWING_PLAYER",
      "follow-siege"
    );
    const movingOwner = {
      playerId: fixture.playerId,
      position: fixture.position,
      target: destinationPoint(fixture.position, 1_000, 0),
      online: true,
      worldPresent: true
    };
    await expect(fixture.service.reconcileFollowingMilitaryGroups([movingOwner], 1)).resolves.toBe(1);
    const afterOneTick = await pool.query<{ lat: number; lon: number; location_state: string }>(
      "SELECT lat,lon,location_state FROM military_unit_groups WHERE group_id=$1::uuid",
      [siege.groupId]
    );
    const firstPosition = {
      lat: Number(afterOneTick.rows[0]!.lat),
      lon: Number(afterOneTick.rows[0]!.lon)
    };
    expect(afterOneTick.rows[0]?.location_state).toBe("FOLLOWING_PLAYER");
    expect(distanceMeters(startingPosition, firstPosition)).toBeCloseTo(
      DEFAULT_PLAYER_SPEED_MPS * MILITARY_FOLLOW_SPEED_RATIO,
      0
    );
    expect(distanceMeters(fixture.position, firstPosition)).toBeGreaterThan(MILITARY_FOLLOW_DISTANCE_M);

    await expect(fixture.service.reconcileFollowingMilitaryGroups([movingOwner], 100)).resolves.toBe(1);
    const afterCatchup = await pool.query<{ lat: number; lon: number }>(
      "SELECT lat,lon FROM military_unit_groups WHERE group_id=$1::uuid",
      [siege.groupId]
    );
    const trailingPosition = {
      lat: Number(afterCatchup.rows[0]!.lat),
      lon: Number(afterCatchup.rows[0]!.lon)
    };
    expect(distanceMeters(fixture.position, trailingPosition)).toBeCloseTo(MILITARY_FOLLOW_DISTANCE_M, 0);

    await expect(fixture.service.setMilitaryGroupState(
      fixture.player,
      siege.groupId,
      "PACKED_FIELD",
      "stay-siege"
    )).resolves.toMatchObject({ replayed: false });
    await expect(fixture.service.setMilitaryGroupState(
      fixture.player,
      siege.groupId,
      "PACKED_FIELD",
      "stay-siege"
    )).resolves.toMatchObject({ replayed: true });
    await expect(pool.query<{ lat: number; lon: number; location_state: string; next_fire_at: Date | null }>(
      "SELECT lat,lon,location_state,next_fire_at FROM military_unit_groups WHERE group_id=$1::uuid",
      [siege.groupId]
    )).resolves.toMatchObject({
      rows: [{
        lat: expect.closeTo(trailingPosition.lat, 10),
        lon: expect.closeTo(trailingPosition.lon, 10),
        location_state: "PACKED_FIELD",
        next_fire_at: null
      }]
    });

    await fixture.service.setMilitaryGroupState(fixture.player, siege.groupId, "DEPLOYED_FIELD", "deploy-siege");
    await fixture.service.setMilitaryGroupState(fixture.player, siege.groupId, "FOLLOWING_PLAYER", "follow-again");
    await fixture.service.setMilitaryGroupState(fixture.player, siege.groupId, "DEPLOYED_FIELD", "deploy-cancels-follow");
    await expect(pool.query<{ location_state: string; next_fire_at: Date | null }>(
      "SELECT location_state,next_fire_at FROM military_unit_groups WHERE group_id=$1::uuid",
      [siege.groupId]
    )).resolves.toMatchObject({ rows: [{ location_state: "DEPLOYED_FIELD", next_fire_at: expect.any(Date) }] });

    await expect(fixture.service.setMilitaryGroupState(
      { playerId: fixture.enemyId, position: fixture.position },
      siege.groupId,
      "FOLLOWING_PLAYER",
      "enemy-follow"
    )).rejects.toMatchObject({ code: "MILITARY_GROUP_NOT_FOUND" });

    const infantry = await insertGroup(fixture, "infantry", 1, "FOLLOWING_PLAYER");
    const infantryPosition = destinationPoint(fixture.position, 10, 90);
    await pool.query(
      "UPDATE military_unit_groups SET lat=$2,lon=$3 WHERE group_id=$1::uuid",
      [infantry.groupId, infantryPosition.lat, infantryPosition.lon]
    );
    await expect(fixture.service.reconcileFollowingMilitaryGroups([movingOwner], 1)).resolves.toBe(1);
    const infantryAfterFollowTick = await pool.query<{ lat: number; lon: number }>(
      "SELECT lat,lon FROM military_unit_groups WHERE group_id=$1::uuid",
      [infantry.groupId]
    );
    expect(distanceMeters(infantryPosition, {
      lat: Number(infantryAfterFollowTick.rows[0]!.lat),
      lon: Number(infantryAfterFollowTick.rows[0]!.lon)
    })).toBeGreaterThan(0);
    await expect(pool.query<{ lat: number; lon: number; location_state: string }>(
      "SELECT lat,lon,location_state FROM military_unit_groups WHERE group_id=$1::uuid",
      [infantry.groupId]
    )).resolves.toMatchObject({
      rows: [{
        lat: expect.closeTo(infantryPosition.lat, 10),
        lon: expect.closeTo(infantryPosition.lon, 10),
        location_state: "FOLLOWING_PLAYER"
      }]
    });
  }, 30_000);

  it("packs a deployed Siege exactly once, blocks incompatible orders, and reconciles on the server deadline", async () => {
    const fixture = await seedFixture();
    const siege = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    const before = Date.now();
    const started = await fixture.service.packUpMilitaryGroup(
      fixture.player,
      siege.groupId,
      "pack-up-once"
    );
    expect(started.replayed).toBe(false);
    const startedGroup = started.snapshot.groups.find((group) => group.groupId === siege.groupId);
    const packingDeadline = startedGroup?.packingCompletesAt;
    expect(startedGroup?.locationState).toBe("PACKING_UP");
    expect(packingDeadline).toEqual(expect.any(String));
    expect(new Date(packingDeadline!).getTime() - before).toBeGreaterThanOrEqual(SIEGE_PACK_UP_DURATION_MS - 2_000);
    expect(new Date(packingDeadline!).getTime() - before).toBeLessThanOrEqual(SIEGE_PACK_UP_DURATION_MS + 2_000);

    await expect(fixture.service.packUpMilitaryGroup(
      fixture.player,
      siege.groupId,
      "pack-up-once"
    )).resolves.toMatchObject({ replayed: true, snapshot: { groups: expect.arrayContaining([
      expect.objectContaining({ groupId: siege.groupId, locationState: "PACKING_UP", packingCompletesAt: packingDeadline })
    ]) } });
    await expect(fixture.service.setMilitaryGroupState(
      fixture.player,
      siege.groupId,
      "FOLLOWING_PLAYER",
      "pack-up-follow-blocked"
    )).rejects.toMatchObject({ code: "MILITARY_GROUP_UNAVAILABLE" });
    await expect(fixture.service.moveMilitaryGroupToPosition(
      fixture.player,
      siege.groupId,
      fixture.position,
      "pack-up-move-blocked"
    )).rejects.toMatchObject({ code: "MILITARY_GROUP_UNAVAILABLE" });
    await expect(fixture.service.fireBallistaVolley(
      fixture.player,
      siege.groupId,
      fixture.targetFlagId,
      "pack-up-fire-blocked"
    )).rejects.toMatchObject({ code: "MILITARY_BALLISTA_UNAVAILABLE" });
    await expect(fixture.service.reconcileDueMilitarySiegePacking()).resolves.toBe(0);
    await expect(fixture.service.snapshot(fixture.playerId)).resolves.toMatchObject({
      groups: expect.arrayContaining([
        expect.objectContaining({ groupId: siege.groupId, locationState: "PACKING_UP", packingCompletesAt: packingDeadline })
      ])
    });

    const positionBeforeCompletion = await pool.query<{ lat: number; lon: number }>(
      "SELECT lat,lon FROM military_unit_groups WHERE group_id=$1::uuid",
      [siege.groupId]
    );
    await pool.query(
      `UPDATE military_unit_groups
       SET packing_completes_at=clock_timestamp()-interval '1 millisecond'
       WHERE group_id=$1::uuid`,
      [siege.groupId]
    );
    await pool.query(
      `UPDATE military_units
       SET packing_completes_at=clock_timestamp()-interval '1 millisecond'
       WHERE group_id=$1::uuid`,
      [siege.groupId]
    );
    await expect(fixture.service.reconcileDueMilitarySiegePacking()).resolves.toBe(1);
    const completedRows = await pool.query<{
      lat: number;
      lon: number;
      location_state: string;
      packing_completes_at: Date | null;
    }>(
      `SELECT lat,lon,location_state,packing_completes_at
       FROM military_unit_groups WHERE group_id=$1::uuid`,
      [siege.groupId]
    );
    expect(completedRows.rows[0]).toMatchObject({
      lat: expect.closeTo(Number(positionBeforeCompletion.rows[0]!.lat), 10),
      lon: expect.closeTo(Number(positionBeforeCompletion.rows[0]!.lon), 10),
      location_state: "PACKED_FIELD",
      packing_completes_at: null
    });
    await expect(fixture.service.snapshot(fixture.playerId)).resolves.toMatchObject({
      groups: expect.arrayContaining([
        expect.objectContaining({ groupId: siege.groupId, locationState: "PACKED_FIELD", packingCompletesAt: null })
      ])
    });

    const stationed = await insertGroup(fixture, "field_ballista", 1, "STATIONED_CITY");
    await expect(fixture.service.packUpMilitaryGroup(fixture.player, stationed.groupId, "pack-up-not-deployed"))
      .rejects.toMatchObject({ code: "MILITARY_GROUP_NOT_DEPLOYED" });
    const infantry = await insertGroup(fixture, "infantry", 1, "DEPLOYED_FIELD");
    await expect(fixture.service.packUpMilitaryGroup(fixture.player, infantry.groupId, "pack-up-not-siege"))
      .rejects.toMatchObject({ code: "MILITARY_GROUP_TYPE_INVALID" });
    await expect(fixture.service.packUpMilitaryGroup(
      { playerId: fixture.enemyId, position: fixture.position },
      siege.groupId,
      "pack-up-enemy"
    )).rejects.toMatchObject({ code: "MILITARY_GROUP_NOT_FOUND" });

    const concurrent = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    const concurrentResults = await Promise.allSettled([
      fixture.service.packUpMilitaryGroup(fixture.player, concurrent.groupId, "pack-up-concurrent-a"),
      fixture.service.packUpMilitaryGroup(fixture.player, concurrent.groupId, "pack-up-concurrent-b")
    ]);
    expect(concurrentResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrentResults.filter((result) => result.status === "rejected")).toHaveLength(1);
    const concurrentFailure = concurrentResults.find((result) => result.status === "rejected");
    expect(concurrentFailure?.status === "rejected" ? concurrentFailure.reason : null).toMatchObject({
      code: "MILITARY_GROUP_UNAVAILABLE"
    });
    const concurrentOther = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    await expect(fixture.service.combineMilitaryGroups(
      fixture.player,
      [concurrent.groupId, concurrentOther.groupId],
      "pack-up-merge-blocked"
    )).rejects.toMatchObject({ code: "MILITARY_GROUP_UNAVAILABLE" });
    await expect(fixture.service.splitMilitaryGroup(
      fixture.playerId,
      concurrent.groupId,
      [1, 1],
      "pack-up-split-blocked"
    )).rejects.toMatchObject({ code: "MILITARY_GROUP_UNAVAILABLE" });
    await expect(fixture.service.setMilitaryGroupState(
      fixture.player,
      concurrent.groupId,
      "DEPLOYED_FIELD",
      "pack-up-deploy-blocked"
    )).rejects.toMatchObject({ code: "MILITARY_GROUP_UNAVAILABLE" });
  }, 30_000);

  it("replays Bomber demolition channels and consumes exactly one fused member", async () => {
    const fixture = await seedFixture();
    const bomberGroup = await insertGroup(fixture, "bomber", 6, "STATIONED_CITY");
    await fixture.service.setMilitaryGroupState(fixture.player, bomberGroup.groupId, "FOLLOWING_PLAYER", "follow-bombers");
    await fixture.service.setMilitaryGroupState(fixture.player, bomberGroup.groupId, "DEPLOYED_FIELD", "deploy-bombers");
    const bomberPosition = await pool.query<{ lat: number; lon: number }>(
      "SELECT lat,lon FROM military_unit_groups WHERE group_id=$1::uuid",
      [bomberGroup.groupId]
    );
    await moveTargetFlag(fixture.targetFlagId, {
      lat: Number(bomberPosition.rows[0]!.lat),
      lon: Number(bomberPosition.rows[0]!.lon)
    }, 200);
    await expect(fixture.service.demolishFlag(
      fixture.player,
      bomberGroup.groupId,
      fixture.targetFlagId,
      "bomber-demolition-once"
    )).resolves.toMatchObject({ replayed: false });
    await expect(fixture.service.demolishFlag(
      fixture.player,
      bomberGroup.groupId,
      fixture.targetFlagId,
      "bomber-demolition-once"
    )).resolves.toMatchObject({ replayed: true });
    expect(fixture.service.takeReconciledBomberDetonationCues()).toEqual([]);

    await pool.query(
      `UPDATE military_siege_operations
       SET started_at=clock_timestamp()-interval '2 seconds',
           completes_at=clock_timestamp()-interval '1 second'
       WHERE player_id=$1 AND request_id='bomber-demolition-once'`,
      [fixture.playerId]
    );
    await expect(fixture.service.reconcileDueBomberDemolitions()).resolves.toBe(1);
    expect(fixture.service.takeReconciledBallistaFlagIds()).toContain(fixture.targetFlagId);
    expect(fixture.service.takeReconciledBomberDetonationCues()).toEqual([{
      playerId: fixture.playerId,
      cue: {
        requestId: "bomber-demolition-once", groupId: bomberGroup.groupId,
        occurredAt: expect.any(Number),
        position: { lat: Number(bomberPosition.rows[0]!.lat), lon: Number(bomberPosition.rows[0]!.lon) },
        targetPosition: { lat: Number(bomberPosition.rows[0]!.lat), lon: Number(bomberPosition.rows[0]!.lon) }
      }
    }]);
    await expect(fixture.service.reconcileDueBomberDemolitions()).resolves.toBe(0);
    expect(fixture.service.takeReconciledBomberDetonationCues()).toEqual([]);
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM flags WHERE id=$1",
      [fixture.targetFlagId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(pool.query<{ status: string; damage: number; consumed_unit_id: string; }>(
      `SELECT status,damage,consumed_unit_id::text
       FROM military_siege_operations
       WHERE player_id=$1 AND request_id='bomber-demolition-once'`,
      [fixture.playerId]
    )).resolves.toMatchObject({ rows: [{ status: "complete", damage: 1_150, consumed_unit_id: expect.any(String) }] });
    await expect(pool.query<{ available: number; destroyed: number }>(
      `SELECT count(*) FILTER (WHERE status='available')::int AS available,
              count(*) FILTER (WHERE status='destroyed')::int AS destroyed
       FROM military_units WHERE owner_player_id=$1 AND group_id=$2`,
      [fixture.playerId, bomberGroup.groupId]
    )).resolves.toMatchObject({ rows: [{ available: 5, destroyed: 0 }] });
    await expect(pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM military_units
       WHERE owner_player_id=$1 AND status='destroyed' AND group_id IS NULL`,
      [fixture.playerId]
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(fixture.service.demolishFlag(
      fixture.player,
      bomberGroup.groupId,
      fixture.targetFlagId,
      "bomber-demolition-once"
    )).resolves.toMatchObject({ replayed: true, damage: 1_150 });
    expect(fixture.service.takeReconciledBomberDetonationCues()).toEqual([]);
    await expect(pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM military_siege_operations
       WHERE player_id=$1 AND request_id='bomber-demolition-once'`,
      [fixture.playerId]
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM flags WHERE id=$1",
      [fixture.targetFlagId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  }, 30_000);

  it("does not emit Bomber detonation cues for an interrupted channel", async () => {
    const fixture = await seedFixture();
    const position = destinationPoint(fixture.position, 200, 90);
    const group = await insertGroup(fixture, "bomber", 1, "DEPLOYED_FIELD", { position });
    await moveTargetFlag(fixture.targetFlagId, position, 200);
    await fixture.service.demolishFlag(fixture.player, group.groupId, fixture.targetFlagId, "bomber-interrupted-cue");
    await pool.query("UPDATE military_unit_groups SET revision=revision+1 WHERE group_id=$1", [group.groupId]);
    await pool.query("UPDATE military_siege_operations SET completes_at=clock_timestamp()-interval '1 second' WHERE player_id=$1", [fixture.playerId]);
    await expect(fixture.service.reconcileDueBomberDemolitions()).resolves.toBe(0);
    expect(fixture.service.takeReconciledBomberDetonationCues()).toEqual([]);
    await expect(pool.query("SELECT status FROM military_siege_operations WHERE player_id=$1 AND request_id=$2",
      [fixture.playerId, "bomber-interrupted-cue"])).resolves.toMatchObject({ rows: [{ status: "cancelled" }] });
    await expect(pool.query("SELECT status FROM military_units WHERE group_id=$1", [group.groupId]))
      .resolves.toMatchObject({ rows: [{ status: "available" }] });
  }, 30_000);

  it("spawns durable developer units and routes every marked Flag tier through warfare", async () => {
    const fixture = await seedFixture();
    const siege = await fixture.service.spawnDeveloperUnit(
      fixture.player,
      "field_ballista",
      "developer-siege-once"
    );
    expect(siege.replayed).toBe(false);
    await expect(fixture.service.spawnDeveloperUnit(
      fixture.player,
      "field_ballista",
      "developer-siege-once"
    )).resolves.toMatchObject({ replayed: true, unitId: siege.unitId, groupId: siege.groupId });
    await expect(pool.query<{
      unit_type: string;
      current_hp: number;
      max_hp: number;
      status: string;
      location_state: string;
      group_unit_type: string;
      group_location_state: string;
    }>(
      `SELECT unit.unit_type,unit.current_hp,unit.max_hp,unit.status,unit.location_state,
              group_row.unit_type AS group_unit_type,group_row.location_state AS group_location_state
       FROM military_units unit
       JOIN military_unit_groups group_row ON group_row.group_id=unit.group_id
       WHERE unit.unit_id=$1::uuid`,
      [siege.unitId]
    )).resolves.toMatchObject({ rows: [{
      unit_type: "field_ballista",
      current_hp: 150,
      max_hp: 150,
      status: "available",
      location_state: "PACKED_FIELD",
      group_unit_type: "field_ballista",
      group_location_state: "PACKED_FIELD"
    }] });

    const towerId = await insertDeveloperTestFlag(fixture, "tower", 0);
    await expect(fixture.service.setMilitaryGroupState(
      fixture.player,
      siege.groupId,
      "DEPLOYED_FIELD",
      "developer-siege-deploy"
    )).resolves.toMatchObject({ replayed: false });
    await pool.query(
      `UPDATE military_unit_groups
       SET next_fire_at=clock_timestamp()-interval '1 second'
       WHERE group_id=$1::uuid`,
      [siege.groupId]
    );
    await pool.query(
      `UPDATE military_units
       SET next_fire_at=clock_timestamp()-interval '1 second'
       WHERE group_id=$1::uuid`,
      [siege.groupId]
    );
    await expect(fixture.service.fireBallistaVolley(
      fixture.player,
      siege.groupId,
      towerId,
      "developer-tower-volley"
    )).resolves.toMatchObject({ damage: 7, replayed: false });
    await expect(pool.query<{ reinforcement_level: number; health: number; maximum_health: number }>(
      "SELECT reinforcement_level,health,maximum_health FROM flags WHERE id=$1::uuid",
      [towerId]
    )).resolves.toMatchObject({ rows: [{ reinforcement_level: 3, health: 2693, maximum_health: 2700 }] });

    for (const [index, targetKind] of (["soft_flag", "bastion_flag", "tower"] as const).entries()) {
      const targetId = await insertDeveloperTestFlag(fixture, targetKind, index + 1);
      const bomber = await fixture.service.spawnDeveloperUnit(
        fixture.player,
        "bomber",
        `developer-bomber-${targetKind}`
      );
      await expect(fixture.service.demolishFlag(
        fixture.player,
        bomber.groupId,
        targetId,
        `developer-demolition-${targetKind}`
      )).resolves.toMatchObject({ replayed: false });
      await pool.query(
        `UPDATE military_siege_operations
         SET started_at=clock_timestamp()-interval '2 seconds',
             completes_at=clock_timestamp()-interval '1 second'
         WHERE player_id=$1 AND request_id=$2`,
        [fixture.playerId, `developer-demolition-${targetKind}`]
      );
      await expect(fixture.service.reconcileDueBomberDemolitions()).resolves.toBe(1);
      if (targetKind === "tower") {
        await expect(pool.query<{ health: number; maximum_health: number }>(
          "SELECT health,maximum_health FROM flags WHERE id=$1::uuid",
          [targetId]
        )).resolves.toMatchObject({ rows: [{ health: 1550, maximum_health: 2700 }] });
        for (const [towerIndex, expectedHealth] of [[2, 400]] as const) {
          const followUpBomber = await fixture.service.spawnDeveloperUnit(
            fixture.player,
            "bomber",
            `developer-bomber-tower-${towerIndex}`
          );
          const followUpRequest = `developer-demolition-tower-${towerIndex}`;
          await expect(fixture.service.demolishFlag(
            fixture.player,
            followUpBomber.groupId,
            targetId,
            followUpRequest
          )).resolves.toMatchObject({ replayed: false });
          await pool.query(
            `UPDATE military_siege_operations
             SET started_at=clock_timestamp()-interval '2 seconds',
                 completes_at=clock_timestamp()-interval '1 second'
             WHERE player_id=$1 AND request_id=$2`,
            [fixture.playerId, followUpRequest]
          );
          await expect(fixture.service.reconcileDueBomberDemolitions()).resolves.toBe(1);
          if (expectedHealth > 0) {
            await expect(pool.query<{ health: number }>(
              "SELECT health FROM flags WHERE id=$1::uuid",
              [targetId]
            )).resolves.toMatchObject({ rows: [{ health: expectedHealth }] });
          } else {
            await expect(pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM flags WHERE id=$1::uuid",
              [targetId]
            )).resolves.toMatchObject({ rows: [{ count: 0 }] });
          }
        }
        const rejectedBomber = await fixture.service.spawnDeveloperUnit(
          fixture.player,
          "bomber",
          "developer-bomber-tower-rejected"
        );
        await expect(fixture.service.demolishFlag(
          fixture.player,
          rejectedBomber.groupId,
          targetId,
          "developer-demolition-tower-rejected"
        )).resolves.toMatchObject({ replayed: false });
        await expect(pool.query<{ available: number; destroyed: number }>(
          `SELECT count(*) FILTER (WHERE status='available')::int AS available,
                  count(*) FILTER (WHERE status='destroyed')::int AS destroyed
           FROM military_units WHERE group_id=$1::uuid`,
          [rejectedBomber.groupId]
        )).resolves.toMatchObject({ rows: [{ available: 1, destroyed: 0 }] });
      } else if (targetKind === "soft_flag") {
        await expect(pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM flags WHERE id=$1::uuid",
          [targetId]
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });
      } else {
        await expect(pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM flags WHERE id=$1::uuid",
          [targetId]
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });
      }
    }
  }, 30_000);

  it("accepts Bomber charges below half health without automatically igniting the Tower", async () => {
    const fixture = await seedFixture();
    const towerId = await insertDeveloperTestFlag(fixture, "tower", 0);
    const bomberGroup = await insertGroup(fixture, "bomber", 2, "DEPLOYED_FIELD");

    await expect(fixture.service.demolishFlag(
      fixture.player,
      bomberGroup.groupId,
      towerId,
      "bomber-health-boundary"
    )).resolves.toMatchObject({ replayed: false });
    await pool.query("UPDATE flags SET health=1_200 WHERE id=$1::uuid", [towerId]);
    await pool.query(
      `UPDATE military_siege_operations
       SET started_at=clock_timestamp()-interval '2 seconds',
           completes_at=clock_timestamp()-interval '1 second'
       WHERE player_id=$1 AND request_id='bomber-health-boundary'`,
      [fixture.playerId]
    );
    await expect(fixture.service.reconcileDueBomberDemolitions()).resolves.toBe(1);
    await expect(pool.query<{ status: string; damage: number; consumed_unit_id: string | null }>(
      `SELECT status,damage,consumed_unit_id::text
       FROM military_siege_operations
       WHERE player_id=$1 AND request_id='bomber-health-boundary'`,
      [fixture.playerId]
    )).resolves.toMatchObject({ rows: [{ status: "complete", damage: 1_150, consumed_unit_id: expect.any(String) }] });
    await expect(pool.query<{ health: number; burning_reason: string | null }>(
      "SELECT health,burning_reason FROM flags WHERE id=$1::uuid",
      [towerId]
    )).resolves.toMatchObject({ rows: [{ health: 50, burning_reason: null }] });
    await expect(pool.query<{ available: number; destroyed: number }>(
      `SELECT count(*) FILTER (WHERE status='available')::int AS available,
              count(*) FILTER (WHERE status='destroyed')::int AS destroyed
       FROM military_units WHERE owner_player_id=$1 AND group_id=$2::uuid`,
      [fixture.playerId, bomberGroup.groupId]
    )).resolves.toMatchObject({ rows: [{ available: 1, destroyed: 0 }] });

    await expect(fixture.service.demolishFlag(
      fixture.player,
      bomberGroup.groupId,
      towerId,
      "bomber-health-boundary-followup"
    )).resolves.toMatchObject({ replayed: false });
    await expect(pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM military_siege_operations
       WHERE player_id=$1 AND group_id=$2::uuid`,
      [fixture.playerId, bomberGroup.groupId]
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    await expect(pool.query<{ available: number; destroyed: number }>(
      `SELECT count(*) FILTER (WHERE status='available')::int AS available,
              count(*) FILTER (WHERE status='destroyed')::int AS destroyed
       FROM military_units WHERE owner_player_id=$1 AND group_id=$2::uuid`,
      [fixture.playerId, bomberGroup.groupId]
    )).resolves.toMatchObject({ rows: [{ available: 1, destroyed: 0 }] });
  }, 30_000);

  it("requires a manual Torch after a Bomber breach, including replay and canonical damage paths", async () => {
    const fixture = await seedFixture();
    const towerId = await insertDeveloperTestFlag(fixture, "tower", 0);
    await pool.query("UPDATE flags SET health=1_300 WHERE id=$1::uuid", [towerId]);
    const bomberGroup = await insertGroup(fixture, "bomber", 1, "DEPLOYED_FIELD");

    await expect(fixture.service.demolishFlag(
      fixture.player,
      bomberGroup.groupId,
      towerId,
      "bomber-auto-breach"
    )).resolves.toMatchObject({ replayed: false });
    await pool.query(
      `UPDATE military_siege_operations
       SET started_at=clock_timestamp()-interval '2 seconds',
           completes_at=clock_timestamp()-interval '1 second'
       WHERE player_id=$1 AND request_id='bomber-auto-breach'`,
      [fixture.playerId]
    );
    await expect(fixture.service.reconcileDueBomberDemolitions()).resolves.toBe(1);
    await expect(pool.query("SELECT health,burning_reason FROM flags WHERE id=$1::uuid", [towerId]))
      .resolves.toMatchObject({ rows: [{ health: 150, burning_reason: null }] });
    await expect(fixture.service.demolishFlag(fixture.player, bomberGroup.groupId, towerId, "bomber-auto-breach"))
      .resolves.toMatchObject({ replayed: true });
    await expect(pool.query("SELECT operation_id FROM flag_burn_operations WHERE flag_id=$1::uuid", [towerId]))
      .resolves.toMatchObject({ rows: [] });
    const flagService = new FlagService(pool, {} as never, {} as never, { info: vi.fn(), warn: vi.fn() } as never, fixture.inventory);
    const manualInput = {
      kind: PERSONAL_FLAG_WARFARE_KIND, playerId: fixture.playerId, structureId: towerId,
      requestId: "bomber-manual-ignition", player: { position: fixture.position, target: null, online: true }
    };
    await expect(flagService.structureWarfare.reserveIgnition(manualInput))
      .rejects.toMatchObject({ code: "FLAG_BURN_TORCH_REQUIRED" });

    const canonicalTower = await insertDeveloperTestFlag(fixture, "tower", 1);
    await pool.query("UPDATE flags SET health=1300 WHERE id=$1::uuid", [canonicalTower]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await flagService.deleteFlagForBomberInTransaction(client, canonicalTower, fixture.playerId);
      await client.query("COMMIT");
    } finally { client.release(); }
    await flagService.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    await expect(pool.query("SELECT health,burning_reason FROM flags WHERE id=$1::uuid", [canonicalTower]))
      .resolves.toMatchObject({ rows: [{ health: 150, burning_reason: null }] });
    await expect(pool.query("SELECT operation_id FROM flag_burn_operations WHERE flag_id=$1::uuid", [canonicalTower]))
      .resolves.toMatchObject({ rows: [] });

    await fixture.inventory.grantItemsForOperation({
      operationKey: `military-service-bomber-auto-torch:${fixture.playerId}`,
      playerId: fixture.playerId,
      source: "military_service_test_seed",
      grants: [{ itemId: "torch", variant: "default", quantity: 1 }]
    });
    const retry = await flagService.structureWarfare.reserveIgnition({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId: fixture.playerId,
      structureId: towerId,
      requestId: "bomber-auto-manual-retry",
      player: { position: fixture.position, target: null, online: true }
    });
    expect(retry.replayed).toBe(false);
    await expect(pool.query<{ health: number; burning_reason: string | null }>(
      "SELECT health,burning_reason FROM flags WHERE id=$1::uuid",
      [towerId]
    )).resolves.toMatchObject({ rows: [{ health: 150, burning_reason: "flag_burn" }] });
    await expect(pool.query<{ quantity: string }>(
      `SELECT COALESCE(sum(quantity),0)::text AS quantity
       FROM player_inventory WHERE player_id=$1 AND resource_type='torch' AND variant='default'`,
      [fixture.playerId]
    )).resolves.toMatchObject({ rows: [{ quantity: "0" }] });

    await flagService.structureWarfare.cancelIgnition({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      operationId: retry.operation.operationId,
      structureId: towerId,
      reason: "test-cleanup"
    });
  }, 30_000);

  it("keeps Bomber hostility aligned for developer test targets and owned ordinary Flags", async () => {
    const fixture = await seedFixture();
    const developerTargetId = await insertDeveloperTestFlag(fixture, "tower", 0);
    const bomber = await insertGroup(fixture, "bomber", 1, "DEPLOYED_FIELD");
    await pool.query(
      "UPDATE military_unit_groups SET owner_player_id=$2 WHERE group_id=$1::uuid",
      [bomber.groupId, fixture.enemyId]
    );
    await pool.query(
      "UPDATE military_units SET owner_player_id=$2 WHERE group_id=$1::uuid",
      [bomber.groupId, fixture.enemyId]
    );
    const enemyPlayer = {
      playerId: fixture.enemyId,
      position: fixture.position,
      regionCode: "NM",
      anchor: fixture.position,
      moveLeashRadiusM: 900
    } satisfies MilitaryPlayer;

    await expect(fixture.service.demolishFlag(
      enemyPlayer,
      bomber.groupId,
      developerTargetId,
      "developer-target-from-enemy"
    )).resolves.toMatchObject({ replayed: false });

    await moveTargetFlag(
      fixture.targetFlagId,
      destinationPoint(fixture.position, 1_500, 180),
      200
    );
    const friendlyFlagId = await insertOrdinaryFriendlyFlag(fixture, 21, fixture.enemyId);
    await expect(fixture.service.demolishFlag(
      enemyPlayer,
      bomber.groupId,
      friendlyFlagId,
      "friendly-target-from-enemy"
    )).rejects.toMatchObject({ code: "MILITARY_FLAG_TARGET_INVALID" });
  }, 30_000);

  it("arms a Siege deployed over a hostile test Tower for the existing cadence path", async () => {
    const fixture = await seedFixture();
    const siege = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    await moveTargetFlag(
      fixture.targetFlagId,
      destinationPoint(fixture.position, SIEGE_ATTACK_RANGE_METERS + 1_500, 180),
      200
    );
    const towerId = await insertDeveloperTestFlag(fixture, "tower", 0);
    const towerPosition = destinationPoint(fixture.position, 28, 0);

    const deployed = await fixture.service.setMilitaryGroupState(
      fixture.player,
      siege.groupId,
      "DEPLOYED_FIELD",
      "deploy-test-tower-cadence",
      towerPosition
    );
    expect(deployed.replayed).toBe(false);
    await expect(pool.query<{ target_flag_id: string | null; next_fire_at: Date | null; remaining_ms: number }>(
      `SELECT target_flag_id::text,next_fire_at,
              FLOOR(EXTRACT(EPOCH FROM (next_fire_at-clock_timestamp()))*1000)::int AS remaining_ms
       FROM military_unit_groups WHERE group_id=$1::uuid`,
      [siege.groupId]
    )).resolves.toMatchObject({
      rows: [{
        target_flag_id: towerId,
        next_fire_at: expect.any(Date),
        remaining_ms: expect.any(Number)
      }]
    });
    const armed = await pool.query<{ remaining_ms: number }>(
      `SELECT FLOOR(EXTRACT(EPOCH FROM (next_fire_at-clock_timestamp()))*1000)::int AS remaining_ms
       FROM military_unit_groups WHERE group_id=$1::uuid`,
      [siege.groupId]
    );
    expect(armed.rows[0]?.remaining_ms).toBeGreaterThan(MILITARY_BALLISTA_VOLLEY_CADENCE_MS - 2_000);

    await pool.query(
      `UPDATE military_unit_groups SET next_fire_at=clock_timestamp()-interval '1 second'
       WHERE group_id=$1::uuid`,
      [siege.groupId]
    );
    await pool.query(
      `UPDATE military_units SET next_fire_at=clock_timestamp()-interval '1 second'
       WHERE group_id=$1::uuid`,
      [siege.groupId]
    );
    await expect(fixture.service.reconcileDueBallistaVolleys()).resolves.toBe(1);
    await expect(pool.query<{ health: number }>(
      "SELECT health FROM flags WHERE id=$1::uuid",
      [towerId]
    )).resolves.toMatchObject({ rows: [{ health: 2693 }] });
  }, 30_000);

  it("holds automatic Siege fire while the hostile-action gate refuses the owner, without recalling the group", async () => {
    const fixture = await seedFixture();
    await moveTargetFlag(fixture.targetFlagId, destinationPoint(fixture.position, 2_000, 180), 200);
    const siege = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    const towerId = await insertDeveloperTestFlag(fixture, "tower", 3);
    await pool.query("UPDATE flags SET health=200 WHERE id=$1::uuid", [towerId]);
    // Arms the target and countdown (no damage yet).
    await expect(fixture.service.reconcileDueBallistaVolleys()).resolves.toBe(1);
    let allowed = false;
    const policy = vi.fn(async () => allowed);
    fixture.service.setAutomaticFirePolicy(policy);
    const makeDue = () => pool.query(
      "UPDATE military_unit_groups SET next_fire_at=clock_timestamp()-interval '1 second' WHERE group_id=$1::uuid",
      [siege.groupId]
    );

    await makeDue();
    await expect(fixture.service.reconcileDueBallistaVolleys()).resolves.toBe(0);
    expect(policy).toHaveBeenCalledWith(fixture.playerId);
    await expect(pool.query("SELECT health FROM flags WHERE id=$1::uuid", [towerId]))
      .resolves.toMatchObject({ rows: [{ health: 200 }] });
    const held = await pool.query<{ location_state: string; target_flag_id: string; due: boolean }>(
      `SELECT location_state,target_flag_id::text,next_fire_at>clock_timestamp() AS due
       FROM military_unit_groups WHERE group_id=$1::uuid`,
      [siege.groupId]
    );
    expect(held.rows[0]).toEqual({ location_state: "DEPLOYED_FIELD", target_flag_id: towerId, due: true });
    // Re-armed one cadence later, so the next pass does not spin on it.
    await expect(fixture.service.reconcileDueBallistaVolleys()).resolves.toBe(0);

    allowed = true;
    await makeDue();
    await expect(fixture.service.reconcileDueBallistaVolleys()).resolves.toBe(1);
    await expect(pool.query("SELECT health FROM flags WHERE id=$1::uuid", [towerId]))
      .resolves.toMatchObject({ rows: [{ health: 193 }] });
  }, 30_000);

  it("reacquires a newly available Tower after a deployed Siege lost its target and timer", async () => {
    const fixture = await seedFixture();
    await moveTargetFlag(fixture.targetFlagId, destinationPoint(fixture.position, 2_000, 180), 200);
    const siege = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    await expect(fixture.service.reconcileDueBallistaVolleys()).resolves.toBe(0);
    const towerId = await insertDeveloperTestFlag(fixture, "tower", 3);
    await pool.query("UPDATE flags SET health=200 WHERE id=$1::uuid", [towerId]);
    await expect(fixture.service.reconcileDueBallistaVolleys()).resolves.toBe(1);
    await expect(pool.query(
      "SELECT target_flag_id::text,next_fire_at FROM military_unit_groups WHERE group_id=$1::uuid",
      [siege.groupId]
    )).resolves.toMatchObject({ rows: [{ target_flag_id: towerId, next_fire_at: expect.any(Date) }] });
    // Reconciliation must not fire early or reset an already armed countdown.
    await expect(fixture.service.reconcileDueBallistaVolleys()).resolves.toBe(0);
    await pool.query(
      "UPDATE military_unit_groups SET next_fire_at=clock_timestamp()-interval '1 second' WHERE group_id=$1::uuid",
      [siege.groupId]
    );
    await expect(fixture.service.reconcileDueBallistaVolleys()).resolves.toBe(1);
    await expect(pool.query("SELECT health,burning_reason FROM flags WHERE id=$1::uuid", [towerId]))
      .resolves.toMatchObject({ rows: [{ health: 193, burning_reason: null }] });
    await expect(fixture.service.reconcileDueBallistaVolleys()).resolves.toBe(0);
    await fixture.inventory.grantItemsForOperation({
      operationKey: `reacquired-tower-torch:${fixture.playerId}`, playerId: fixture.playerId,
      source: "military_service_test_seed", grants: [{ itemId: "torch", variant: "default", quantity: 1 }]
    });
    const flags = new FlagService(pool, {} as never, {} as never, { info: vi.fn(), warn: vi.fn() } as never, fixture.inventory);
    await flags.structureWarfare.reserveIgnition({
      kind: PERSONAL_FLAG_WARFARE_KIND, playerId: fixture.playerId, structureId: towerId,
      requestId: "reacquired-tower-manual", player: { position: fixture.position, target: null, online: true }
    });
    await pool.query(
      `UPDATE flag_burn_operations SET started_at=clock_timestamp()-interval '121 seconds',
         completes_at=clock_timestamp()+interval '79079 seconds' WHERE flag_id=$1::uuid`, [towerId]
    );
    await flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    await expect(pool.query("SELECT health FROM flags WHERE id=$1::uuid", [towerId]))
      .resolves.toMatchObject({ rows: [{ health: 191 }] });
    const burn = (await pool.query("SELECT started_at,completes_at,burn_damage_budget FROM flag_burn_operations WHERE flag_id=$1", [towerId])).rows;
    expect(burn[0].burn_damage_budget).toBe(1350);
    await pool.query("UPDATE military_unit_groups SET next_fire_at=clock_timestamp()-interval '1 second' WHERE group_id=$1::uuid", [siege.groupId]);
    await fixture.service.reconcileDueBallistaVolleys();
    await expect(pool.query("SELECT health FROM flags WHERE id=$1::uuid", [towerId]))
      .resolves.toMatchObject({ rows: [{ health: 184 }] });
    expect((await pool.query("SELECT started_at,completes_at,burn_damage_budget FROM flag_burn_operations WHERE flag_id=$1", [towerId])).rows).toEqual(burn);
    await flags.structureWarfare.reconcileIgnitions(PERSONAL_FLAG_WARFARE_KIND);
    await expect(pool.query("SELECT health FROM flags WHERE id=$1::uuid", [towerId]))
      .resolves.toMatchObject({ rows: [{ health: 184 }] });
  }, 30_000);

  it("fires an expired deployment countdown even when it had no original Tower anchor", async () => {
    const fixture = await seedFixture();
    await moveTargetFlag(fixture.targetFlagId, destinationPoint(fixture.position, 2_000, 180), 200);
    const siege = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD", {
      nextFireAt: "clock_timestamp()-interval '1 second'"
    });
    await pool.query("UPDATE military_unit_groups SET target_flag_id=NULL WHERE group_id=$1::uuid", [siege.groupId]);
    const towerId = await insertDeveloperTestFlag(fixture, "tower", 0);
    const concurrent = await Promise.all([
      fixture.service.reconcileDueBallistaVolleys(), fixture.service.reconcileDueBallistaVolleys()
    ]);
    expect(concurrent[0]! + concurrent[1]!).toBe(1);
    await expect(pool.query("SELECT health FROM flags WHERE id=$1::uuid", [towerId]))
      .resolves.toMatchObject({ rows: [{ health: 2693 }] });
  }, 30_000);

  it("keeps flat Siege volleys across half health without starting a burn", async () => {
    const fixture = await seedFixture();
    await moveTargetFlag(
      fixture.targetFlagId,
      destinationPoint(fixture.position, SIEGE_ATTACK_RANGE_METERS + 1_500, 180),
      200
    );
    const towerId = await insertDeveloperTestFlag(fixture, "tower", 3);
    await pool.query("UPDATE flags SET health=1_203 WHERE id=$1::uuid", [towerId]);
    const siege = await insertGroup(fixture, "field_ballista", 1, "FOLLOWING_PLAYER");
    await expect(fixture.service.setMilitaryGroupState(
      fixture.player,
      siege.groupId,
      "DEPLOYED_FIELD",
      "deploy-low-health-tower"
    )).resolves.toMatchObject({ replayed: false });
    await pool.query(
      "UPDATE military_units SET next_fire_at=clock_timestamp()-interval '1 second' WHERE group_id=$1::uuid",
      [siege.groupId]
    );
    await pool.query(
      "UPDATE military_unit_groups SET next_fire_at=clock_timestamp()-interval '1 second' WHERE group_id=$1::uuid",
      [siege.groupId]
    );
    await expect(pool.query<{ target_flag_id: string | null }>(
      "SELECT target_flag_id::text FROM military_unit_groups WHERE group_id=$1::uuid",
      [siege.groupId]
    )).resolves.toMatchObject({ rows: [{ target_flag_id: towerId }] });

    await expect(fixture.service.reconcileDueBallistaVolleys()).resolves.toBe(1);
    await expect(pool.query<{ health: number; burning_reason: string | null }>(
      "SELECT health,burning_reason FROM flags WHERE id=$1::uuid",
      [towerId]
    )).resolves.toMatchObject({ rows: [{ health: 1_196, burning_reason: null }] });
    await expect(pool.query<{ next_fire_at: Date | null; target_flag_id: string | null }>(
      "SELECT next_fire_at,target_flag_id::text FROM military_unit_groups WHERE group_id=$1::uuid",
      [siege.groupId]
    )).resolves.toMatchObject({ rows: [{ next_fire_at: expect.any(Date), target_flag_id: towerId }] });

    await pool.query(
      "UPDATE military_units SET next_fire_at=clock_timestamp()-interval '1 second' WHERE group_id=$1::uuid",
      [siege.groupId]
    );
    await pool.query(
      "UPDATE military_unit_groups SET next_fire_at=clock_timestamp()-interval '1 second' WHERE group_id=$1::uuid",
      [siege.groupId]
    );
    await expect(fixture.service.reconcileDueBallistaVolleys()).resolves.toBe(1);
    await expect(pool.query<{ health: number }>(
      "SELECT health FROM flags WHERE id=$1::uuid",
      [towerId]
    )).resolves.toMatchObject({ rows: [{ health: 1_189 }] });
    await expect(pool.query("SELECT operation_id FROM flag_burn_operations WHERE flag_id=$1::uuid", [towerId]))
      .resolves.toMatchObject({ rows: [] });
  }, 30_000);

  it("adds 35% Siege damage for an owner whose kingdom chose Unyielding Assault", async () => {
    const fixture = await seedFixture();
    await moveTargetFlag(
      fixture.targetFlagId,
      destinationPoint(fixture.position, SIEGE_ATTACK_RANGE_METERS + 1_500, 180),
      200
    );
    const towerId = await insertDeveloperTestFlag(fixture, "tower", 3);
    await pool.query("UPDATE flags SET health=1_203 WHERE id=$1::uuid", [towerId]);
    const kingdomId = randomUUID();
    await pool.query(
      `INSERT INTO kingdoms (id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id)
       VALUES ($1,$2,'Siegecraft',$3,$3,$4)`,
      [kingdomId, `siegecraft-${kingdomId.slice(0, 8)}`, fixture.playerId, randomUUID()]
    );
    await pool.query(
      `INSERT INTO kingdom_memberships (id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at)
       VALUES (gen_random_uuid(),$1,$2,'leader','active',now() - interval '1 day',now() - interval '1 hour')`,
      [kingdomId, fixture.playerId]
    );
    await pool.query(
      "INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id) VALUES ($1, 5, 'unyielding_assault')",
      [kingdomId]
    );
    const siege = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    await fixture.service.fireBallistaVolley(fixture.player, siege.groupId, towerId, "relentless-volley");
    // A fusion level 1 Siege deals 7; Unyielding Assault makes it 9 (7 x 1.35, rounded).
    await expect(pool.query<{ health: number }>("SELECT health FROM flags WHERE id=$1::uuid", [towerId]))
      .resolves.toMatchObject({ rows: [{ health: 1_194 }] });
  }, 30_000);

  it("applies one full Siege damage to every eligible nearby Flag and replays the area result", async () => {
    const fixture = await seedFixture();
    const siege = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    // Keep the fixture's ordinary target available for the existing
    // single-target contract without making it part of this area assertion.
    await moveTargetFlag(
      fixture.targetFlagId,
      destinationPoint(fixture.position, SIEGE_ATTACK_RANGE_METERS + 1_500, 180),
      200
    );
    const friendlyFlagId = await insertOrdinaryFriendlyFlag(fixture, 4);
    const softFlagId = await insertDeveloperTestFlag(fixture, "soft_flag", 0);
    const testFlags = await Promise.all([
      insertDeveloperTestFlag(fixture, "bastion_flag", 1),
      insertDeveloperTestFlag(fixture, "tower", 2)
    ]);

    const first = await fixture.service.fireBallistaVolley(
      fixture.player,
      siege.groupId,
      testFlags[1]!,
      "area-volley-once"
    );
    expect(first).toMatchObject({ damage: 7, replayed: false });
    expect(first.siegeVolleys).toEqual([{
      groupId: siege.groupId,
      occurredAt: expect.any(Number)
    }]);
    expect(first.affectedFlagIds).toEqual([testFlags[1]]);
    await expect(pool.query<{ id: string; health: number }>(
      `SELECT id::text,health FROM flags WHERE id=$1::uuid`,
      [testFlags[1]]
    )).resolves.toMatchObject({ rows: [{ id: testFlags[1]!, health: 2693 }] });
    await expect(pool.query<{ health: number }>(
      "SELECT health FROM flags WHERE id=$1::uuid",
      [testFlags[0]]
    )).resolves.toMatchObject({ rows: [{ health: 200 }] });
    await expect(pool.query<{ health: number }>(
      "SELECT health FROM flags WHERE id=$1::uuid",
      [softFlagId]
    )).resolves.toMatchObject({ rows: [{ health: 100 }] });
    await expect(pool.query<{ health: number }>(
      "SELECT health FROM flags WHERE id=$1::uuid",
      [friendlyFlagId]
    )).resolves.toMatchObject({ rows: [{ health: 100 }] });

    await expect(fixture.service.fireBallistaVolley(
      fixture.player,
      siege.groupId,
      testFlags[1]!,
      "area-volley-once"
    )).resolves.toMatchObject({ damage: 7, replayed: true, affectedFlagIds: [testFlags[1]] });
    await expect(pool.query<{ target_results: Array<{ flagId: string; damage: number }> }>(
      `SELECT target_results FROM military_siege_operations
       WHERE player_id=$1 AND request_id='area-volley-once'`,
      [fixture.playerId]
    )).resolves.toMatchObject({
      rows: [{ target_results: [expect.objectContaining({ flagId: testFlags[1], damage: 7 })] }]
    });

    await pool.query("UPDATE flags SET health=100 WHERE id=$1::uuid", [testFlags[0]]);
    await pool.query(
      "UPDATE military_unit_groups SET next_fire_at=clock_timestamp()-interval '1 second' WHERE group_id=$1::uuid",
      [siege.groupId]
    );
    await pool.query(
      "UPDATE military_units SET next_fire_at=clock_timestamp()-interval '1 second' WHERE group_id=$1::uuid",
      [siege.groupId]
    );
    const newlyEligible = await insertDeveloperTestFlag(fixture, "tower", 3);
    await expect(fixture.service.fireBallistaVolley(
      fixture.player,
      siege.groupId,
      testFlags[1]!,
      "area-volley-after-change"
    )).resolves.toMatchObject({ damage: 7, replayed: false });
    await expect(pool.query<{ id: string; health: number }>(
      `SELECT id::text,health FROM flags WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[testFlags[0], testFlags[1], newlyEligible]]
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([
        { id: testFlags[0], health: 100 },
        { id: testFlags[1], health: 2686 },
        { id: newlyEligible, health: 2693 }
      ])
    });
  }, 30_000);

  it("keeps burning Towers targetable for full independent volleys while excluding burning base and Stone Flags", async () => {
    const fixture = await seedFixture();
    const burningTowerId = await insertDeveloperTestFlag(fixture, "tower", 50);
    await pool.query(
      `UPDATE flags
       SET health=375,burning_started_at=clock_timestamp(),
           burning_until=clock_timestamp()+interval '1 day',
           burning_reason='flag_burn',damage_cycle_id=gen_random_uuid()
       WHERE id=$1::uuid`,
      [burningTowerId]
    );
    const burningTowerPosition = {
      lat: fixture.position.lat + 0.00025 + 50 * 0.00005,
      lon: fixture.position.lon
    };
    const deploymentPreview = await insertGroup(fixture, "field_ballista", 1, "FOLLOWING_PLAYER");
    await expect(fixture.service.setMilitaryGroupState(
      fixture.player,
      deploymentPreview.groupId,
      "DEPLOYED_FIELD",
      "burning-tower-deploy-preview",
      burningTowerPosition
    )).resolves.toMatchObject({ replayed: false });
    await expect(pool.query<{ target_flag_id: string | null }>(
      "SELECT target_flag_id::text FROM military_unit_groups WHERE group_id=$1::uuid",
      [deploymentPreview.groupId]
    )).resolves.toMatchObject({ rows: [{ target_flag_id: burningTowerId }] });

    const twoBallistas = await insertGroup(fixture, "field_ballista", 2, "DEPLOYED_FIELD");
    await expect(fixture.service.fireBallistaVolley(
      fixture.player,
      twoBallistas.groupId,
      burningTowerId,
      "burning-tower-volley-two"
    )).resolves.toMatchObject({ damage: 14, affectedFlagIds: [burningTowerId], replayed: false });
    await expect(pool.query<{ health: number }>(
      "SELECT health FROM flags WHERE id=$1::uuid",
      [burningTowerId]
    )).resolves.toMatchObject({ rows: [{ health: 361 }] });

    const threeBallistas = await insertGroup(fixture, "field_ballista", 3, "DEPLOYED_FIELD");
    await expect(fixture.service.fireBallistaVolley(
      fixture.player,
      threeBallistas.groupId,
      burningTowerId,
      "burning-tower-volley-three"
    )).resolves.toMatchObject({ damage: 21, affectedFlagIds: [burningTowerId], replayed: false });
    await expect(pool.query<{ health: number }>(
      "SELECT health FROM flags WHERE id=$1::uuid",
      [burningTowerId]
    )).resolves.toMatchObject({ rows: [{ health: 340 }] });

    for (const [index, targetKind] of (["soft_flag", "bastion_flag"] as const).entries()) {
      const targetId = await insertDeveloperTestFlag(fixture, targetKind, 60 + index);
      await pool.query(
        `UPDATE flags
         SET health=50,burning_started_at=clock_timestamp(),
             burning_until=clock_timestamp()+interval '1 day',
             burning_reason='flag_burn',damage_cycle_id=gen_random_uuid()
         WHERE id=$1::uuid`,
        [targetId]
      );
      const siege = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
      await expect(fixture.service.fireBallistaVolley(
        fixture.player,
        siege.groupId,
        targetId,
        `burning-${targetKind}-siege-rejected`
      )).rejects.toMatchObject({ code: "MILITARY_FLAG_TARGET_INVALID" });
      await expect(pool.query<{ health: number }>(
        "SELECT health FROM flags WHERE id=$1::uuid",
        [targetId]
      )).resolves.toMatchObject({ rows: [{ health: 50 }] });
    }
  }, 30_000);

  it("retires an unlit Tower on a lethal flat Siege hit without creating a burn", async () => {
    const fixture = await seedFixture();
    await moveTargetFlag(fixture.targetFlagId, destinationPoint(fixture.position, 2_000, 180), 200);
    const towerId = await insertDeveloperTestFlag(fixture, "tower", 0);
    await pool.query("UPDATE flags SET health=7 WHERE id=$1::uuid", [towerId]);
    const siege = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
    await expect(fixture.service.fireBallistaVolley(fixture.player, siege.groupId, towerId, "unlit-lethal-volley"))
      .resolves.toMatchObject({ damage: 7, replayed: false });
    await expect(pool.query("SELECT id FROM flags WHERE id=$1::uuid", [towerId])).resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT operation_id FROM flag_burn_operations WHERE flag_id=$1::uuid", [towerId]))
      .resolves.toMatchObject({ rows: [] });
  }, 30_000);

  it("retires a burning Tower on the lethal Siege hit and clears all durable targets", async () => {
    const fixture = await seedFixture();
    const towerId = await insertDeveloperTestFlag(fixture, "tower", 70);
    const operationId = randomUUID();
    await pool.query(
      `UPDATE flags
       SET health=7,burning_started_at=now(),
           burning_until=now()+interval '12 hours',
           burning_reason='flag_burn',damage_cycle_id=gen_random_uuid()
       WHERE id=$1::uuid`,
      [towerId]
    );
    await pool.query(
      `INSERT INTO flag_burn_operations (
         operation_id,burner_player_id,victim_player_id,flag_id,request_id,
         flag_name,flag_lat,flag_lon,notice_message,started_at,completes_at,
         status,reinforcement_level,burn_duration_ms,damage_cycle_id,remaining_duration_ms,
         source_kind,developer_test_creator_id
       )
       SELECT $1::uuid,$2,$2,flags.id,'siege-lethal-burn',flags.name,flags.lat,flags.lon,
              'Test Tower burn',now(),now()+interval '24 hours',
              'active',3,79200000,flags.damage_cycle_id,79200000,'developer_test',$2
       FROM flags WHERE flags.id=$3::uuid`,
      [operationId, fixture.playerId, towerId]
    );
    const siege = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD", {
      nextFireAt: "clock_timestamp()-interval '1 second'"
    });
    await pool.query(
      `UPDATE military_units SET target_flag_id=$2::uuid WHERE unit_id=$1::uuid`,
      [siege.unitIds[0], towerId]
    );
    await pool.query(
      `UPDATE military_unit_groups SET target_flag_id=$2::uuid WHERE group_id=$1::uuid`,
      [siege.groupId, towerId]
    );

    await expect(fixture.service.fireBallistaVolley(
      fixture.player,
      siege.groupId,
      towerId,
      "siege-lethal-tower"
    )).resolves.toMatchObject({
      damage: 7,
      affectedFlagIds: [towerId],
      replayed: false
    });
    await expect(pool.query("SELECT 1 FROM flags WHERE id=$1::uuid", [towerId]))
      .resolves.toMatchObject({ rows: [] });
    await expect(pool.query<{ status: string; cancel_reason: string | null }>(
      `SELECT status,cancel_reason FROM flag_burn_operations WHERE operation_id=$1::uuid`,
      [operationId]
    )).resolves.toMatchObject({ rows: [{ status: "cancelled", cancel_reason: "flag-destroyed" }] });
    await expect(pool.query<{ target_flag_id: string | null }>(
      `SELECT target_flag_id::text FROM military_units WHERE unit_id=$1::uuid`,
      [siege.unitIds[0]]
    )).resolves.toMatchObject({ rows: [{ target_flag_id: null }] });
    await expect(pool.query<{ target_flag_id: string | null }>(
      `SELECT target_flag_id::text FROM military_unit_groups WHERE group_id=$1::uuid`,
      [siege.groupId]
    )).resolves.toMatchObject({ rows: [{ target_flag_id: null }] });
  }, 30_000);

  it("reconciles legacy zero-health Towers before they can reappear in Flag snapshots", async () => {
    const fixture = await seedFixture();
    const legacyTowerId = await insertDeveloperTestFlag(fixture, "tower", 71);
    const liveTowerId = await insertDeveloperTestFlag(fixture, "tower", 72);
    const burnOperationId = randomUUID();
    const repairOperationId = randomUUID();
    const bomber = await insertGroup(fixture, "bomber", 1, "DEPLOYED_FIELD");
    const demolitionOperationKey = `military-siege:${fixture.playerId}:legacy-zero-health`;

    await pool.query(
      `UPDATE flags
       SET health=0,damage_cycle_id=gen_random_uuid(),
           burning_started_at=now(),burning_until=now()+interval '24 hours',
           burning_reason='flag_burn'
       WHERE id=$1::uuid`,
      [legacyTowerId]
    );
    await pool.query(
      `INSERT INTO flag_burn_operations (
         operation_id,burner_player_id,victim_player_id,flag_id,request_id,
         flag_name,flag_lat,flag_lon,notice_message,started_at,completes_at,
         status,reinforcement_level,burn_duration_ms,damage_cycle_id,remaining_duration_ms,
         source_kind,developer_test_creator_id
       )
       SELECT $1::uuid,$2,$2,flags.id,'legacy-zero-health-burn',flags.name,flags.lat,flags.lon,
              'Legacy Test Tower burn',now(),now()+interval '24 hours',
              'active',3,79200000,flags.damage_cycle_id,79200000,'developer_test',$2
       FROM flags WHERE flags.id=$3::uuid`,
      [burnOperationId, fixture.playerId, legacyTowerId]
    );
    await pool.query(
      `INSERT INTO flag_repair_operations (
         operation_id,owner_player_id,flag_id,burn_operation_id,damage_cycle_id,
         request_id,flag_name,flag_lat,flag_lon,started_at,completes_at,
         paused_burn_remaining_ms,repair_kit_quantity,stone_quantity,status
       )
       SELECT $1::uuid,$2,flags.id,$3::uuid,flags.damage_cycle_id,
              'legacy-zero-health-repair',flags.name,flags.lat,flags.lon,
              now(),now()+interval '60 seconds',79200000,1,25,'active'
       FROM flags WHERE flags.id=$4::uuid`,
      [repairOperationId, fixture.playerId, burnOperationId, legacyTowerId]
    );
    await pool.query(
      `INSERT INTO military_siege_operations (
         operation_key,player_id,request_id,action,group_id,flag_id,damage,
         group_revision,member_revisions,target_lat,target_lon,status,started_at,completes_at
       )
       SELECT $1,$2,'legacy-zero-health-bomber','demolish_flag',$3::uuid,flags.id,0,
              1,'{}'::jsonb,flags.lat,flags.lon,'pending',now(),now()+interval '1 minute'
       FROM flags WHERE flags.id=$4::uuid`,
      [demolitionOperationKey, fixture.playerId, bomber.groupId, legacyTowerId]
    );
    await pool.query(
      `UPDATE military_units
       SET target_flag_id=$2::uuid
       WHERE unit_id=$1::uuid`,
      [bomber.unitIds[0], legacyTowerId]
    );
    await pool.query(
      `UPDATE military_unit_groups
       SET target_flag_id=$2::uuid
       WHERE group_id=$1::uuid`,
      [bomber.groupId, legacyTowerId]
    );

    const flags = new FlagService(
      pool,
      {} as never,
      {} as never,
      { info: vi.fn(), warn: vi.fn() } as never,
      fixture.inventory
    );
    await expect(flags.reconcileZeroHealthFlags()).resolves.toMatchObject([
      { flagId: legacyTowerId }
    ]);
    await expect(pool.query("SELECT 1 FROM flags WHERE id=$1::uuid", [legacyTowerId]))
      .resolves.toMatchObject({ rows: [] });
    await expect(pool.query<{ health: number }>(
      "SELECT health FROM flags WHERE id=$1::uuid",
      [liveTowerId]
    )).resolves.toMatchObject({ rows: [{ health: 2_700 }] });
    await expect(pool.query<{ status: string; cancel_reason: string | null }>(
      `SELECT status,cancel_reason FROM flag_burn_operations WHERE operation_id=$1::uuid`,
      [burnOperationId]
    )).resolves.toMatchObject({ rows: [{ status: "cancelled", cancel_reason: "flag-destroyed" }] });
    await expect(pool.query<{ status: string; cancel_reason: string | null }>(
      `SELECT status,cancel_reason FROM flag_repair_operations WHERE operation_id=$1::uuid`,
      [repairOperationId]
    )).resolves.toMatchObject({ rows: [{ status: "cancelled", cancel_reason: "flag-destroyed" }] });
    await expect(pool.query<{ status: string }>(
      `SELECT status FROM military_siege_operations WHERE operation_key=$1`,
      [demolitionOperationKey]
    )).resolves.toMatchObject({ rows: [{ status: "cancelled" }] });
    await expect(pool.query<{ target_flag_id: string | null }>(
      `SELECT target_flag_id::text FROM military_units WHERE unit_id=$1::uuid`,
      [bomber.unitIds[0]]
    )).resolves.toMatchObject({ rows: [{ target_flag_id: null }] });
    await expect(pool.query<{ target_flag_id: string | null }>(
      `SELECT target_flag_id::text FROM military_unit_groups WHERE group_id=$1::uuid`,
      [bomber.groupId]
    )).resolves.toMatchObject({ rows: [{ target_flag_id: null }] });
    await expect(flags.getMapFlag(legacyTowerId)).resolves.toBeNull();
    await expect(flags.listFlags()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: liveTowerId })])
    );
    await expect(flags.listFlags()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: legacyTowerId })])
    );
  }, 30_000);

  it("excludes destroyed Ballistas, replays volleys, and serializes overdue restart fire", async () => {
    const fixture = await seedFixture();
    const ballistaGroup = await insertGroup(fixture, "field_ballista", 2, "DEPLOYED_FIELD", {
      nextFireAt: "clock_timestamp()-interval '1 second'"
    });
    const targetFlagId = await insertDeveloperTestFlag(fixture, "tower", 10);
    await pool.query(
      `UPDATE military_units
       SET status='destroyed',current_hp=0,group_id=$2::uuid
       WHERE unit_id=$1`,
      [ballistaGroup.unitIds[1], ballistaGroup.groupId]
    );

    await expect(fixture.service.fireBallistaVolley(
      fixture.player,
      ballistaGroup.groupId,
      targetFlagId,
      "ballista-volley-once"
    )).resolves.toMatchObject({ damage: 7, replayed: false });
    await expect(fixture.service.fireBallistaVolley(
      fixture.player,
      ballistaGroup.groupId,
      targetFlagId,
      "ballista-volley-once"
    )).resolves.toMatchObject({ damage: 7, replayed: true });

    await pool.query(
      `UPDATE military_units SET next_fire_at=clock_timestamp()-interval '1 second'
       WHERE unit_id=$1 AND status='available'`,
      [ballistaGroup.unitIds[0]]
    );
    await pool.query(
      `UPDATE military_unit_groups SET next_fire_at=clock_timestamp()-interval '1 second'
       WHERE group_id=$1::uuid`,
      [ballistaGroup.groupId]
    );
    const reconciled = await Promise.all([
      fixture.service.reconcileDueBallistaVolleys(),
      fixture.service.reconcileDueBallistaVolleys()
    ]);
    expect(reconciled[0]! + reconciled[1]!).toBe(1);
    await expect(pool.query<{ health: number }>(
      "SELECT health FROM flags WHERE id=$1",
      [targetFlagId]
    )).resolves.toMatchObject({ rows: [{ health: 2_686 }] });
    await expect(pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM military_siege_operations
       WHERE player_id=$1 AND action='ballista_volley'`,
      [fixture.playerId]
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });

    const damagedBallista = await insertStandaloneUnit(fixture, "field_ballista", 100, "STATIONED_CITY");
    await expect(fixture.service.repairBallista(
      fixture.player,
      damagedBallista,
      "repair-ballista-once"
    )).resolves.toMatchObject({ replayed: false });
    await expect(fixture.service.repairBallista(
      fixture.player,
      damagedBallista,
      "repair-ballista-once"
    )).resolves.toMatchObject({ replayed: true });
    await expect(pool.query<{ current_hp: number }>(
      "SELECT current_hp FROM military_units WHERE unit_id=$1",
      [damagedBallista]
    )).resolves.toMatchObject({ rows: [{ current_hp: 150 }] });

    const destroyedBallista = await insertStandaloneUnit(fixture, "field_ballista", 0, "DEPLOYED_FIELD", "destroyed");
    await expect(fixture.service.repairBallista(
      fixture.player,
      destroyedBallista,
      "repair-destroyed-ballista"
    )).rejects.toMatchObject({ code: "MILITARY_BALLISTA_UNAVAILABLE" });
  }, 30_000);

  it("enforces the canonical Siege range at every boundary before changing state", async () => {
    const fixture = await seedFixture();
    const targetFlagId = await insertDeveloperTestFlag(fixture, "tower", 40);
    const allowedDistances = [499, 500, 500.1, 574, 574.9, SIEGE_ATTACK_RANGE_METERS];
    for (const [index, distance] of allowedDistances.entries()) {
      const group = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
      const target = destinationPoint(fixture.position, distance, 90);
      await moveTargetTower(targetFlagId, target, 2_700);
      const result = await fixture.service.fireBallistaVolley(
        { ...fixture.player, position: destinationPoint(fixture.position, 10, 180) },
        group.groupId,
        targetFlagId,
        `ballista-range-allowed-${index}`
      );
      expect(result).toMatchObject({ damage: 7, replayed: false });
      expect(distanceMeters(fixture.position, target)).toBeCloseTo(distance, 5);
    }

    const rejectedDistances = [575.1, 576, 600];
    for (const [index, distance] of rejectedDistances.entries()) {
      const group = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD");
      const target = destinationPoint(fixture.position, distance, 90);
      await moveTargetTower(targetFlagId, target, 2_700);
      const before = await pool.query<{
        health: number;
        group_target_flag_id: string | null;
        group_next_fire_at: Date | null;
        unit_target_flag_id: string | null;
        unit_next_fire_at: Date | null;
      }>(
        `SELECT flags.health,
                group_row.target_flag_id::text AS group_target_flag_id,
                group_row.next_fire_at AS group_next_fire_at,
                unit.target_flag_id::text AS unit_target_flag_id,
                unit.next_fire_at AS unit_next_fire_at
         FROM flags
         LEFT JOIN military_unit_groups group_row ON group_row.group_id=$2::uuid
         LEFT JOIN military_units unit ON unit.group_id=group_row.group_id
         WHERE flags.id=$1::uuid`,
        [targetFlagId, group.groupId]
      );
      const operationsBefore = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM military_siege_operations
         WHERE player_id=$1 AND group_id=$2::uuid`,
        [fixture.playerId, group.groupId]
      );

      await expect(fixture.service.fireBallistaVolley(
        { ...fixture.player, position: destinationPoint(fixture.position, 10, 180) },
        group.groupId,
        targetFlagId,
        `ballista-range-rejected-${index}`
      )).rejects.toMatchObject({
        code: "MILITARY_SIEGE_OUT_OF_RANGE",
        message: "Target is out of siege range."
      });

      const after = await pool.query<{
        health: number;
        group_target_flag_id: string | null;
        group_next_fire_at: Date | null;
        unit_target_flag_id: string | null;
        unit_next_fire_at: Date | null;
      }>(
        `SELECT flags.health,
                group_row.target_flag_id::text AS group_target_flag_id,
                group_row.next_fire_at AS group_next_fire_at,
                unit.target_flag_id::text AS unit_target_flag_id,
                unit.next_fire_at AS unit_next_fire_at
         FROM flags
         LEFT JOIN military_unit_groups group_row ON group_row.group_id=$2::uuid
         LEFT JOIN military_units unit ON unit.group_id=group_row.group_id
         WHERE flags.id=$1::uuid`,
        [targetFlagId, group.groupId]
      );
      const operationsAfter = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM military_siege_operations
         WHERE player_id=$1 AND group_id=$2::uuid`,
        [fixture.playerId, group.groupId]
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
      expect(operationsAfter.rows[0]?.count).toBe(operationsBefore.rows[0]?.count);
    }

    const cadenceGroup = await insertGroup(fixture, "field_ballista", 1, "DEPLOYED_FIELD", {
      nextFireAt: "clock_timestamp()-interval '1 second'"
    });
    const cadenceTarget = destinationPoint(fixture.position, SIEGE_ATTACK_RANGE_METERS + 1, 90);
    await moveTargetTower(targetFlagId, cadenceTarget, 2_700);
    await pool.query(
      `UPDATE military_unit_groups
       SET target_flag_id=$2::uuid
       WHERE group_id=$1::uuid`,
      [cadenceGroup.groupId, targetFlagId]
    );
    await pool.query(
      `UPDATE military_units
       SET target_flag_id=$2::uuid
       WHERE group_id=$1::uuid`,
      [cadenceGroup.groupId, targetFlagId]
    );
    const cadenceBefore = await pool.query<{ health: number }>(
      "SELECT health FROM flags WHERE id=$1::uuid",
      [targetFlagId]
    );
    expect(await fixture.service.reconcileDueBallistaVolleys()).toBe(0);
    const cadenceAfter = await pool.query<{ health: number }>(
      "SELECT health FROM flags WHERE id=$1::uuid",
      [targetFlagId]
    );
    expect(cadenceAfter.rows[0]?.health).toBe(cadenceBefore.rows[0]?.health);
    await expect(pool.query<{
      group_target_flag_id: string | null;
      group_next_fire_at: Date | null;
      unit_target_flag_id: string | null;
      unit_next_fire_at: Date | null;
    }>(
      `SELECT group_row.target_flag_id::text AS group_target_flag_id,
              group_row.next_fire_at AS group_next_fire_at,
              unit.target_flag_id::text AS unit_target_flag_id,
              unit.next_fire_at AS unit_next_fire_at
       FROM military_unit_groups group_row
       JOIN military_units unit ON unit.group_id=group_row.group_id
       WHERE group_row.group_id=$1::uuid`,
      [cadenceGroup.groupId]
    )).resolves.toMatchObject({ rows: [{
      group_target_flag_id: null,
      group_next_fire_at: null,
      unit_target_flag_id: null,
      unit_next_fire_at: null
    }] });
  }, 30_000);

  it("keeps a pending rally from moving/removing its War Camp and then rallies atomically", async () => {
    const fixture = await seedFixture();
    const group = await insertGroup(fixture, "infantry", 1, "STATIONED_CITY");
    await expect(fixture.service.callTroops(fixture.player, "rally-once"))
      .resolves.toMatchObject({ replayed: false });
    await expect(fixture.service.setMilitaryGroupState(
      fixture.player,
      group.groupId,
      "DEPLOYED_FIELD",
      "deploy-during-rally"
    )).rejects.toMatchObject({ code: "MILITARY_RALLY_PENDING" });
    await expect(fixture.service.removeWarCamp(fixture.playerId, "remove-during-rally"))
      .rejects.toMatchObject({ code: "WAR_CAMP_GARRISON_PRESENT" });

    await pool.query(
      `UPDATE military_rally_operations
       SET started_at=clock_timestamp()-interval '2 seconds',
           completes_at=clock_timestamp()-interval '1 second'
       WHERE player_id=$1 AND request_id='rally-once'`,
      [fixture.playerId]
    );
    await expect(fixture.service.reconcileDueRallies()).resolves.toBe(1);
    await expect(pool.query<{ location_state: string; war_camp_id: string }>(
      "SELECT location_state,war_camp_id::text FROM military_units WHERE group_id=$1",
      [group.groupId]
    )).resolves.toMatchObject({ rows: [{ location_state: "STATIONED_WAR_CAMP", war_camp_id: fixture.campId }] });

    await expect(fixture.service.removeWarCamp(fixture.playerId, "remove-with-garrison"))
      .rejects.toMatchObject({ code: "WAR_CAMP_GARRISON_PRESENT" });
    await fixture.service.setMilitaryGroupState(fixture.player, group.groupId, "STATIONED_CITY", "return-to-city");
    await expect(fixture.service.removeWarCamp(fixture.playerId, "remove-after-return"))
      .resolves.toMatchObject({ replayed: false });
    await expect(pool.query<{ removed_at: Date | null }>(
      "SELECT removed_at FROM war_camps WHERE camp_id=$1",
      [fixture.campId]
    )).resolves.toMatchObject({ rows: [{ removed_at: expect.anything() }] });
  }, 30_000);

  it("recovers a human member through the due recovery reconciler", async () => {
    const fixture = await seedFixture();
    const unitId = await insertStandaloneUnit(fixture, "archer", 0, "RECOVERING", "recovering");
    await pool.query(
      `UPDATE military_units
       SET next_recovery_at=clock_timestamp()-interval '1 second'
       WHERE unit_id=$1`,
      [unitId]
    );
    await expect(fixture.service.reconcileDueRecovery()).resolves.toBe(1);
    await expect(pool.query<{ current_hp: number; status: string; location_state: string; station_city_id: string }>(
      `SELECT current_hp,status,location_state,station_city_id::text
       FROM military_units WHERE unit_id=$1`,
      [unitId]
    )).resolves.toMatchObject({
      rows: [{ current_hp: 80, status: "available", location_state: "STATIONED_CITY", station_city_id: fixture.cityId }]
    });
  }, 30_000);

  async function seedFixture(options: { lodgeReservedCapacity?: number } = {}): Promise<Fixture> {
    const playerId = `military-service-${randomUUID()}`;
    const enemyId = `military-enemy-${randomUUID()}`;
    const accountId = randomUUID();
    const position = { lat: 35 + fixtureSequence++ * 0.03, lon: -106 };
    const player = {
      playerId,
      position,
      regionCode: "NM",
      anchor: position,
      moveLeashRadiusM: 900
    } satisfies MilitaryPlayer;
    await createPlayer(playerId, accountId, `military-service-player-${playerId}`, position);
    await createPlayer(enemyId, randomUUID(), `military-service-enemy-${enemyId}`, position);
    const cityId = randomUUID();
    const seatFlagId = randomUUID();
    await pool.query(
      `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
       VALUES ($1,$2,'Military Service City Flag',$3,$4,1,ST_SetSRID(ST_MakePoint($4,$3),4326))`,
      [seatFlagId, playerId, position.lat, position.lon]
    );
    await pool.query(
      `INSERT INTO cities (
         id,world_id,canonical_municipality_id,world_settlement_id,
         world_settlement_source,world_source_settlement_id,name,country_code,
         region_code,founder_player_id,mayor_player_id,founding_request_id,
         seat_flag_id,hall_lat,hall_lon,hall_geom,founding_annex_radius_m
       ) VALUES ($1,'main',$2,$2,'test',$2,'Military Service City','US','NM',$3,NULL,$4,
         $5,$6,$7,ST_SetSRID(ST_MakePoint($7,$6),4326),1000)`,
      [cityId, `military-settlement-${cityId}`, playerId, `military-found-${cityId}`, seatFlagId, position.lat, position.lon]
    );
    const houseId = randomUUID();
    await pool.query(
      `INSERT INTO city_structures (
         structure_id,city_id,structure_type,tier,owner_player_id,world_id,region_code,
         lat,lon,geom,footprint_geom,footprint_radius_m,placement_revision,
         state,build_operation_key,built_at
       ) VALUES ($1,$2,'city_house',1,$3,'main','NM',$4,$5,
         ST_SetSRID(ST_MakePoint($5,$4),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint($5,$4),4326)::geography,20)::geometry,
         20,1,'active',$6,clock_timestamp())`,
      [houseId, cityId, playerId, position.lat, position.lon, `military-house-${houseId}`]
    );
    await pool.query(
      `INSERT INTO city_memberships (city_id,player_id,role,world_id,house_structure_id)
       VALUES ($1,$2,'founder','main',$3)`,
      [cityId, playerId, houseId]
    );
    await pool.query(
      `UPDATE flags
       SET control_type='city_seat',city_id=$2,city_affiliated_at=clock_timestamp()
       WHERE id=$1`,
      [seatFlagId, cityId]
    );
    const facilityId = randomUUID();
    await pool.query(
      `INSERT INTO city_structures (
         structure_id,city_id,structure_type,tier,world_id,region_code,
         lat,lon,geom,footprint_geom,footprint_radius_m,placement_revision,
         state,build_operation_key,built_at
       ) VALUES ($1,$2,'barracks',1,'main','NM',$3,$4,
         ST_SetSRID(ST_MakePoint($4,$3),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,20)::geometry,
         20,1,'active',$5,clock_timestamp())`,
      [facilityId, cityId, position.lat, position.lon, `military-facility-${facilityId}`]
    );
    const lodgeId = randomUUID();
    await pool.query(
      `INSERT INTO player_lodges (
         lodge_id,owner_player_id,world_id,region_code,lat,lon,geom,footprint_geom,
         footprint_radius_m,level,reserved_capacity,placement_revision
       ) VALUES ($1,$2,'main','NM',$3,$4,
         ST_SetSRID(ST_MakePoint($4,$3),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,8)::geometry,
         8,1,$5,1)`,
      [lodgeId, playerId, position.lat, position.lon, options.lodgeReservedCapacity ?? 0]
    );
    const campId = randomUUID();
    await pool.query(
      `INSERT INTO war_camps (
         camp_id,owner_player_id,world_id,region_code,lat,lon,geom,footprint_geom,
         footprint_radius_m,placement_revision
       ) VALUES ($1,$2,'main','NM',$3,$4,
         ST_SetSRID(ST_MakePoint($4,$3),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,8)::geometry,
         8,1)`,
      [campId, playerId, position.lat, position.lon]
    );
    const targetFlagId = randomUUID();
    await pool.query(
      `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
       VALUES ($1,$2,'Enemy Ordinary Flag',$3,$4,700,ST_SetSRID(ST_MakePoint($4,$3),4326))`,
      [targetFlagId, enemyId, position.lat + 0.0003, position.lon]
    );
    await pool.query(
      `UPDATE flags
       SET control_type='personal',anchor_kind='flag',system_controlled=false,
           reinforcement_level=1,health=200,maximum_health=200
       WHERE id=$1`,
      [targetFlagId]
    );

    const inventory = new InventoryService(pool);
    await inventory.grantItemsForOperation({
      operationKey: `military-service-seed:${playerId}`,
      playerId,
      source: "military_service_test_seed",
      grants: [
        { itemId: "simple_food", variant: "default", quantity: 100 },
        { itemId: "cloth", variant: "default", quantity: 50 },
        { itemId: "leather", variant: "default", quantity: 50 },
        { itemId: "wood", variant: "default", quantity: 100 },
        { itemId: "iron_bar", variant: "default", quantity: 20 },
        { itemId: "repair_kit", variant: "default", quantity: 3 },
      ]
    });
    const wallet = new WalletService(pool);
    const walletClient = await pool.connect();
    try {
      await walletClient.query("BEGIN");
      await wallet.creditForOperationInTransaction(walletClient, {
        playerId,
        accountId,
        amount: 5_000n,
        operationKey: `military-service-wallet-seed:${playerId}`,
        reason: "military_service_test_seed"
      });
      await walletClient.query("COMMIT");
    } catch (error) {
      await walletClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      walletClient.release();
    }
    return {
      playerId,
      accountId,
      enemyId,
      cityId,
      facilityId,
      lodgeId,
      campId,
      targetFlagId,
      position,
      player,
      inventory,
      wallet,
      service: new MilitaryIndustryService(
        pool, "main", inventory, wallet, undefined, DEFAULT_PLAYER_SPEED_MPS, deleteFlagForBurnInTransaction
      )
    };
  }

  async function createPlayer(
    playerId: string,
    accountId: string,
    username: string,
    position: { lat: number; lon: number }
  ): Promise<void> {
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,$3,$3,'#38bdf8','NM',$4,$5,$4,$5,900,false,
         ST_SetSRID(ST_MakePoint($5,$4),4326))`,
      [playerId, accountId, username, position.lat, position.lon]
    );
  }

  async function insertGroup(
    fixture: Fixture,
    unitType: "infantry" | "archer" | "bomber" | "field_ballista",
    count: number,
    locationState: "STATIONED_CITY" | "STATIONED_WAR_CAMP" | "FOLLOWING_PLAYER" | "DEPLOYED_FIELD",
    options: { nextFireAt?: string; position?: { lat: number; lon: number } } = {}
  ): Promise<{ groupId: string; unitIds: string[] }> {
    const groupId = randomUUID();
    const stationCityId = locationState === "STATIONED_CITY" ? fixture.cityId : null;
    const warCampId = locationState === "STATIONED_WAR_CAMP" ? fixture.campId : null;
    const lat = locationState === "STATIONED_CITY" ? null : options.position?.lat ?? fixture.position.lat;
    const lon = locationState === "STATIONED_CITY" ? null : options.position?.lon ?? fixture.position.lon;
    await pool.query(
      `INSERT INTO military_unit_groups (
         group_id,owner_player_id,unit_type,location_state,station_city_id,war_camp_id,
         lat,lon,next_fire_at,revision
       ) VALUES ($1,$2,$3,$4,$5::uuid,$6::uuid,$7,$8,
         CASE WHEN $9::text IS NULL THEN NULL ELSE clock_timestamp()-interval '1 second' END,1)`,
      [groupId, fixture.playerId, unitType, locationState, stationCityId, warCampId, lat, lon, options.nextFireAt ?? null]
    );
    const maxHp = unitType === "infantry" ? 100 : unitType === "archer" ? 80 : unitType === "bomber" ? 60 : 150;
    const unitIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const unitId = randomUUID();
      unitIds.push(unitId);
      await pool.query(
        `INSERT INTO military_units (
           unit_id,owner_player_id,unit_type,home_city_id,current_hp,max_hp,status,
           location_state,station_city_id,war_camp_id,lat,lon,group_id,
           next_fire_at,revision
         ) VALUES ($1,$2,$3,$4::uuid,$5,$6,'available',$7,$8::uuid,$9::uuid,$10,$11,$12::uuid,
           CASE WHEN $13::text IS NULL THEN NULL ELSE clock_timestamp()-interval '1 second' END,1)`,
        [unitId, fixture.playerId, unitType, fixture.cityId, maxHp, maxHp, locationState, stationCityId, warCampId, lat, lon, groupId, options.nextFireAt ?? null]
      );
    }
    return { groupId, unitIds };
  }

  async function insertStandaloneUnit(
    fixture: Fixture,
    unitType: "archer" | "field_ballista",
    currentHp: number,
    locationState: "STATIONED_CITY" | "DEPLOYED_FIELD" | "RECOVERING",
    status: "available" | "recovering" | "destroyed" = "available"
  ): Promise<string> {
    const unitId = randomUUID();
    const maxHp = unitType === "archer" ? 80 : 150;
    const stationedCityId = locationState === "STATIONED_CITY" || locationState === "RECOVERING" ? fixture.cityId : null;
    const lat = locationState === "DEPLOYED_FIELD" ? fixture.position.lat : null;
    const lon = locationState === "DEPLOYED_FIELD" ? fixture.position.lon : null;
    await pool.query(
      `INSERT INTO military_units (
         unit_id,owner_player_id,unit_type,home_city_id,current_hp,max_hp,status,
         location_state,station_city_id,lat,lon,next_recovery_at,revision
       ) VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9::uuid,$10,$11,
         CASE WHEN $12::text IS NULL THEN NULL ELSE clock_timestamp()-interval '1 second' END,1)`,
      [unitId, fixture.playerId, unitType, fixture.cityId, currentHp, maxHp, status, locationState, stationedCityId, lat, lon, status === "recovering" ? "due" : null]
    );
    return unitId;
  }

  async function moveTargetFlag(
    flagId: string,
    target: { lat: number; lon: number },
    health: number
  ): Promise<void> {
    await pool.query(
      `UPDATE flags
       SET lat=$2,lon=$3,geom=ST_SetSRID(ST_MakePoint($3,$2),4326),
           health=$4,maximum_health=200,control_type='personal',anchor_kind='flag',
           system_controlled=false,city_id=NULL,kingdom_id=NULL,reinforcement_level=1,
           burning_reason=NULL
       WHERE id=$1::uuid`,
      [flagId, target.lat, target.lon, health]
    );
  }

  async function moveTargetTower(
    flagId: string,
    target: { lat: number; lon: number },
    health: number
  ): Promise<void> {
    await pool.query(
      `UPDATE flags
       SET lat=$2,lon=$3,geom=ST_SetSRID(ST_MakePoint($3,$2),4326),
           health=$4,maximum_health=2_700,control_type='personal',anchor_kind='flag',
           system_controlled=false,city_id=NULL,kingdom_id=NULL,reinforcement_level=3,
           burning_reason=NULL
       WHERE id=$1::uuid`,
      [flagId, target.lat, target.lon, health]
    );
  }

  async function insertDeveloperTestFlag(
    fixture: Fixture,
    targetKind: "soft_flag" | "bastion_flag" | "tower",
    index: number,
    creatorPlayerId = fixture.playerId
  ): Promise<string> {
    const flagId = randomUUID();
    const reinforcementLevel = targetKind === "soft_flag" ? 0 : targetKind === "bastion_flag" ? 1 : 3;
    const position = {
      lat: fixture.position.lat + 0.00025 + index * 0.00005,
      lon: fixture.position.lon
    };
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,geom,
         control_type,anchor_kind,system_controlled,city_id,kingdom_id,
         reinforcement_level,health,maximum_health,developer_test_target
       ) VALUES ($1,$2,$3,$4,$5,1,ST_SetSRID(ST_MakePoint($5,$4),4326),
         'personal','flag',false,NULL,NULL,$6,
         CASE WHEN $6::smallint=0 THEN 100 WHEN $6::smallint=1 THEN 200 ELSE 2700 END,
         CASE WHEN $6::smallint=0 THEN 100 WHEN $6::smallint=1 THEN 200 ELSE 2700 END,true)`,
      [flagId, fixture.playerId, `Developer ${targetKind}`, position.lat, position.lon, reinforcementLevel]
    );
    await pool.query(
      `INSERT INTO developer_spawned_test_flags (
         flag_id,creator_player_id,request_id,target_kind,spawn_lat,spawn_lon
       ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [flagId, creatorPlayerId, `developer-flag-${targetKind}-${index}`, targetKind, position.lat, position.lon]
    );
    return flagId;
  }

  async function insertOrdinaryFriendlyFlag(
    fixture: Fixture,
    index: number,
    ownerPlayerId = fixture.playerId
  ): Promise<string> {
    const flagId = randomUUID();
    const position = {
      lat: fixture.position.lat,
      lon: fixture.position.lon + 0.00005 * (index + 1)
    };
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,geom,
         control_type,anchor_kind,system_controlled,city_id,kingdom_id,
         reinforcement_level,health,maximum_health,developer_test_target
       ) VALUES ($1,$2,$3,$4,$5,1,ST_SetSRID(ST_MakePoint($5,$4),4326),
         'personal','flag',false,NULL,NULL,0,100,100,false)`,
      [flagId, ownerPlayerId, "Friendly Ordinary Flag", position.lat, position.lon]
    );
    return flagId;
  }
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
