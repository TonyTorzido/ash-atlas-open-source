import { randomUUID } from "node:crypto";

import {
  gameInboxEntryKey,
  LEGENDARY_BIRD_INBOX_EVENT_KIND
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CombatEngine } from "./combat/combatEngine.js";
import {
  COMBAT_ITEM_REWARD_POLICY_VERSION,
  combatXpAnchor,
  MOB_DEFINITIONS
} from "./combat/mobDefinitions.js";
import {
  CombatRewardSettlementService,
  type CombatSettlementResult
} from "./combat/rewardSettlement.js";
import { FlagDestructionError, FlagService } from "./flags.js";
import { InventoryService } from "./inventory.js";
import { LegendaryBirdEventService } from "./legendaryBirdEvents.js";
import { ProgressionService } from "./progression.js";
import { packageIdForPosition, zoneIdForPosition } from "./spatialZones.js";
import { WalletService } from "./wallet.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("legendary bird event durable authority", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const accountId = randomUUID();
  const ownerId = `legendary-owner-${suffix}`;
  const farAccountId = randomUUID();
  const farOwnerId = `legendary-far-owner-${suffix}`;
  const stoneFlagId = randomUUID();
  const developerFlagId = randomUUID();
  const completedCycleFlagId = randomUUID();
  const clearFlagId = randomUUID();
  const softFlagId = randomUUID();
  const farSeatFlagId = randomUUID();
  const nearCityId = randomUUID();
  const farCityId = randomUUID();
  let now = new Date("2099-08-24T12:00:00.000Z");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const entities = new Set<string>();
  const spawnMob = vi.fn((input: Parameters<CombatEngine["spawnMob"]>[0]) => {
    entities.add(input.entityId!);
  });
  const send = vi.fn();
  const warn = vi.fn();
  const completedSettlements: CombatSettlementResult[] = [];
  const combat = {
    entity: (entityId: string) => entities.has(entityId) ? { entityId } : undefined,
    spawnMob,
    despawnMob: vi.fn()
  } as unknown as CombatEngine;
  const getFlag = vi.fn(async () => null);
  const flags = {
    getFlag,
    currentFlagSetRevision: vi.fn(async () => "1"),
    deleteFlagForBurnInTransaction: vi.fn(async (client: pg.PoolClient, flagId: string) => {
      const deleted = await client.query<{ id: string }>(
        "DELETE FROM flags WHERE id=$1 RETURNING id::text",
        [flagId]
      );
      if (deleted.rowCount !== 1) throw new Error("flag does not exist");
      return { flagId, affectedFlagIds: [], notificationPlayerIds: [] };
    })
  } as unknown as FlagService;
  const inventory = new InventoryService(pool);
  const rewardSettlements = new CombatRewardSettlementService(
    pool,
    new ProgressionService(pool),
    { warn } as never,
    (result) => completedSettlements.push(result),
    undefined,
    inventory,
    undefined,
    new WalletService()
  );
  const service = new LegendaryBirdEventService(
    pool,
    combat,
    rewardSettlements,
    flags,
    { send, broadcast: vi.fn() } as never,
    { warn } as never,
    () => 0,
    () => now
  );

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO accounts (id,status,trust_tier) VALUES
         ($1,'active','standard'),($2,'active','standard')`,
      [accountId, farAccountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,$3,$3,'#38bdf8','NM',35,-106,35,-106,900,false,
                 ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [ownerId, accountId, `legendary${suffix}`]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,$3,$3,'#f59e0b','NM',36,-107,36,-107,900,false,
                 ST_SetSRID(ST_MakePoint(-107,36),4326))`,
      [farOwnerId, farAccountId, `legendaryfar${suffix}`]
    );
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,reinforcement_level,health,maximum_health,access_mode,geom
       ) VALUES
         ($1,$4,'Legendary Stone',35,-106,100,1,200,200,'private',ST_SetSRID(ST_MakePoint(-106,35),4326)),
         ($2,$4,'Legendary Soft',35.01,-106.01,100,0,NULL,NULL,'public',ST_SetSRID(ST_MakePoint(-106.01,35.01),4326)),
         ($3,$5,'Far City Center',36,-107,100,0,NULL,NULL,'public',ST_SetSRID(ST_MakePoint(-107,36),4326))`,
      [stoneFlagId, softFlagId, farSeatFlagId, ownerId, farOwnerId]
    );
    await pool.query(
      `INSERT INTO cities (
         id,world_id,canonical_municipality_id,world_settlement_id,world_settlement_source,
         world_source_settlement_id,name,country_code,founder_player_id,mayor_player_id,
         founding_request_id,seat_flag_id,hall_lat,hall_lon,hall_geom,founding_annex_radius_m
       ) VALUES
         ($1,'global',$3,$3,'test',$3,'Nearmere','US',$5,$5,$4,$6,
          35,-106.001,ST_SetSRID(ST_MakePoint(-106.001,35),4326),750),
         ($2,'global',$7,$7,'test',$7,'Farwatch','US',$10,$10,$8,$9,
          36,-107,ST_SetSRID(ST_MakePoint(-107,36),4326),750)`,
      [nearCityId, farCityId, `near-${suffix}`, `near-request-${suffix}`, ownerId, softFlagId,
        `far-${suffix}`, `far-request-${suffix}`, farSeatFlagId, farOwnerId]
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("selects only the Stone Flag, marks it once, and keeps the bird unspawned", async () => {
    getFlag.mockRejectedValueOnce(new Error("injected flag publication failure"));
    await service.rotateCycle();
    await service.rotateCycle();

    const event = await pool.query<{
      flag_id: string;
      status: string;
      health: number;
      burning_reason: string;
    }>(
      `SELECT event.flag_id::text,event.status,flag.health,flag.burning_reason
       FROM legendary_bird_events event JOIN flags flag ON flag.id=event.flag_id
       WHERE event.owner_player_id=$1`,
      [ownerId]
    );
    expect(event.rows).toEqual([{
      flag_id: stoneFlagId,
      status: "pending",
      health: 110,
      burning_reason: "flag_burn"
    }]);
    const birdBurn = await pool.query<{
      source_kind: string;
      legendary_event_id: string;
      status: string;
      burn_duration_ms: string;
      damage_cycle_id: string;
      flag_damage_cycle_id: string;
    }>(
      `SELECT operation.source_kind,operation.legendary_event_id::text,operation.status,
              operation.burn_duration_ms::text AS burn_duration_ms,
              operation.damage_cycle_id::text,
              flag.damage_cycle_id::text AS flag_damage_cycle_id
       FROM flag_burn_operations operation JOIN flags flag ON flag.id=operation.flag_id
       WHERE operation.flag_id=$1`,
      [stoneFlagId]
    );
    expect(birdBurn.rows).toMatchObject([{
      source_kind: "legendary_bird",
      legendary_event_id: expect.any(String),
      status: "active",
      burn_duration_ms: "79200000",
      damage_cycle_id: expect.any(String),
      flag_damage_cycle_id: expect.any(String)
    }]);
    expect(birdBurn.rows[0]?.damage_cycle_id).toBe(birdBurn.rows[0]?.flag_damage_cycle_id);
    expect(spawnMob).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      message: expect.stringContaining("Nearmere")
    });
    expect(send.mock.calls[0]?.[1]?.message).not.toContain("Farwatch");
    const notices = await pool.query<{
      event_kind: string;
      event_id: string;
      message: string;
      created_at: Date;
      selected_at: Date;
    }>(
      `SELECT inbox.event_kind,inbox.event_id::text,inbox.message,inbox.created_at,event.selected_at
       FROM player_inbox_entries inbox
       JOIN legendary_bird_events event ON event.event_id=inbox.event_id
       WHERE inbox.player_id=$1 AND inbox.entry_kind='game_notice'`,
      [ownerId]
    );
    expect(notices.rows).toHaveLength(1);
    expect(notices.rows[0]).toMatchObject({
      event_kind: "legendary_bird_event",
      message: send.mock.calls[0]?.[1]?.message,
      created_at: notices.rows[0]?.selected_at
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ flagId: stoneFlagId }),
      "failed to publish legendary bird flag change"
    );

    const deletionFlags = new FlagService(
      pool,
      {} as never,
      {} as never,
      { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      new InventoryService(pool)
    );
    await expect(deletionFlags.deleteFlag(
      stoneFlagId,
      ownerId,
      false,
      `legendary-delete-${suffix}`
    )).rejects.toBeInstanceOf(FlagDestructionError);
    await expect(pool.query("SELECT 1 FROM flags WHERE id=$1", [stoneFlagId]))
      .resolves.toMatchObject({ rowCount: 1 });
    const cycle = await pool.query<{ cycle_started_at: Date; expires_at: Date }>(
      `SELECT cycle_started_at,expires_at FROM legendary_bird_cycles`
    );
    expect(cycle.rows).toHaveLength(1);
    expect(new Date(cycle.rows[0]!.cycle_started_at)).toEqual(now);
    expect(new Date(cycle.rows[0]!.expires_at).getTime() - now.getTime()).toBe(86_400_000);
  });

  it("rejects public arrival and atomically activates exactly once for owner access", async () => {
    const unauthorizedClient = await pool.connect();
    await unauthorizedClient.query("BEGIN");
    await expect(service.activateForCommittedArrival(
      unauthorizedClient, stoneFlagId, ownerId, "ALLOWED_PUBLIC"
    )).resolves.toBeNull();
    await unauthorizedClient.query("COMMIT");
    unauthorizedClient.release();

    const firstClient = await pool.connect();
    await firstClient.query("BEGIN");
    const eventId = await service.activateForCommittedArrival(
      firstClient, stoneFlagId, ownerId, "ALLOWED_OWNER"
    );
    await firstClient.query("COMMIT");
    firstClient.release();
    expect(eventId).toEqual(expect.any(String));

    const activated = await pool.query<{
      bird_species: "fire" | "lightning" | "ice";
      cycle_started_at: Date;
      selected_at: Date;
      expires_at: Date;
    }>(
      `SELECT bird_species,cycle_started_at,selected_at,expires_at
       FROM legendary_bird_events WHERE event_id=$1`,
      [eventId]
    );
    const species = activated.rows[0]!.bird_species;
    await expect(pool.query(
      `SELECT bird_species,last_activated_at,available_at
       FROM legendary_bird_species_cooldowns WHERE bird_species=$1`,
      [species]
    )).resolves.toMatchObject({ rows: [{
      bird_species: species,
      last_activated_at: now,
      available_at: new Date(now.getTime() + 86_400_000)
    }] });

    await pool.query(
      `UPDATE flag_burn_operations
       SET status='cancelled',cancel_reason='repaired',completed_at=clock_timestamp()
       WHERE flag_id=$1 AND source_kind='legendary_bird' AND status='active'`,
      [stoneFlagId]
    );
    await pool.query(
      `UPDATE flags SET burning_started_at=NULL,burning_until=NULL,burning_reason=NULL,damage_cycle_id=NULL WHERE id=$1`,
      [stoneFlagId]
    );
    send.mockClear();
    await service.sendCurrentAlerts(ownerId);
    expect(send).toHaveBeenCalledWith(ownerId, expect.objectContaining({
      eventId,
      selectedAt: activated.rows[0]!.selected_at.toISOString(),
      message: expect.stringMatching(/is no longer burning\. The (Phoenix|Thunderbird|Ice Phoenix) encounter remains available/)
    }));
    expect(send.mock.calls[0]?.[1]?.message).not.toContain("is burning");

    const entryKey = gameInboxEntryKey(LEGENDARY_BIRD_INBOX_EVENT_KIND, eventId!);
    await pool.query(
      `INSERT INTO player_inbox_read_receipts (player_id,entry_key,read_revision)
       VALUES ($1,$2,$3)`,
      [ownerId, entryKey, "stale-revision"]
    );
    send.mockClear();
    await service.sendCurrentAlerts(ownerId);
    expect(send).toHaveBeenCalledWith(ownerId, expect.objectContaining({ eventId }));
    await pool.query(
      `UPDATE player_inbox_read_receipts SET read_revision=$3
       WHERE player_id=$1 AND entry_key=$2`,
      [ownerId, entryKey, activated.rows[0]!.selected_at.toISOString()]
    );
    send.mockClear();
    await service.sendCurrentAlerts(ownerId);
    expect(send).not.toHaveBeenCalled();

    const laterEventId = randomUUID();
    await pool.query(
      `INSERT INTO legendary_bird_events (
         event_id,cycle_started_at,bird_species,flag_id,owner_player_id,selected_at,expires_at
       ) VALUES ($1,$2,$3,$4,$5,$2,$6)`,
      [laterEventId, activated.rows[0]!.cycle_started_at, species, softFlagId, ownerId,
        activated.rows[0]!.expires_at]
    );
    send.mockClear();
    await service.sendCurrentAlerts(ownerId);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(ownerId, expect.objectContaining({ eventId: laterEventId }));
    now = new Date(now.getTime() + 60 * 60_000);
    const laterClient = await pool.connect();
    await laterClient.query("BEGIN");
    await expect(service.activateForCommittedArrival(
      laterClient, softFlagId, ownerId, "ALLOWED_OWNER"
    )).resolves.toBe(laterEventId);
    await laterClient.query("COMMIT");
    laterClient.release();
    const latestAvailability = new Date(now.getTime() + 86_400_000);
    await expect(pool.query(
      `SELECT last_activated_at,available_at
       FROM legendary_bird_species_cooldowns WHERE bird_species=$1`,
      [species]
    )).resolves.toMatchObject({ rows: [{
      last_activated_at: now,
      available_at: latestAvailability
    }] });

    const replayClient = await pool.connect();
    await replayClient.query("BEGIN");
    await expect(service.activateForCommittedArrival(
      replayClient, softFlagId, ownerId, "ALLOWED_OWNER"
    )).resolves.toBeNull();
    await replayClient.query("COMMIT");
    replayClient.release();
    await pool.query(`DELETE FROM legendary_bird_events WHERE event_id=$1`, [laterEventId]);
    await pool.query(
      `DELETE FROM player_inbox_read_receipts WHERE player_id=$1 AND entry_key=$2`,
      [ownerId, entryKey]
    );
    await expect(pool.query(
      `SELECT available_at FROM legendary_bird_species_cooldowns WHERE bird_species=$1`,
      [species]
    )).resolves.toMatchObject({ rows: [{ available_at: latestAvailability }] });
    now = new Date("2099-08-24T12:00:00.000Z");

    await service.spawnActivation(eventId!);
    await service.publishActivation(eventId!);
    await service.publishActivation(eventId!);
    expect(spawnMob).toHaveBeenCalledTimes(1);
    const expectedPosition = { lat: 35, lon: -106 };
    expect(spawnMob).toHaveBeenCalledWith(expect.objectContaining({
      position: expectedPosition,
      regionCode: packageIdForPosition(expectedPosition),
      zoneId: zoneIdForPosition(expectedPosition),
      originFlagId: stoneFlagId
    }));
    entities.clear();
    await service.rotateCycle();
    expect(spawnMob).toHaveBeenCalledTimes(2);
    await expect(pool.query(
      `SELECT status FROM legendary_bird_events WHERE event_id=$1`, [eventId]
    )).resolves.toMatchObject({ rows: [{ status: "active" }] });
  });

  it("excludes completed current-cycle flags and creates an idempotent event without a species cooldown", async () => {
    await pool.query(
      `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,reinforcement_level,health,maximum_health,access_mode,geom)
       VALUES
         ($1,$3,'Developer Stone',35.002,-106,100,1,175,200,'private',ST_SetSRID(ST_MakePoint(-106,35.002),4326)),
         ($2,$3,'Completed Cycle Stone',35.003,-106,100,1,175,200,'private',ST_SetSRID(ST_MakePoint(-106,35.003),4326))`,
      [developerFlagId, completedCycleFlagId, ownerId]
    );
    const cycleBefore = await pool.query(`SELECT cycle_started_at,expires_at FROM legendary_bird_cycles`);
    const completedEventId = randomUUID();
    await pool.query(
      `INSERT INTO legendary_bird_events (
         event_id,cycle_started_at,bird_species,flag_id,owner_player_id,status,
         selected_at,expires_at,completed_at
       ) VALUES ($1,$2,'ice',$3,$4,'completed',$2,$5,$2)`,
      [completedEventId, cycleBefore.rows[0]!.cycle_started_at, completedCycleFlagId,
        ownerId, cycleBefore.rows[0]!.expires_at]
    );
    await expect(service.searchDeveloperPlayers(`legendary${suffix}`)).resolves.toEqual({
      players: [{
        playerId: ownerId,
        playerName: `legendary${suffix}`,
        eligibleBastionFlagCount: 1
      }]
    });
    send.mockClear();
    const first = await service.triggerDeveloperEvent({ playerId: ownerId, birdSpecies: "lightning", operationKey: `developer-bird-${suffix}` });
    const replay = await service.triggerDeveloperEvent({ playerId: ownerId, birdSpecies: "ice", operationKey: `developer-bird-${suffix}` });
    expect(first).toMatchObject({ flagId: developerFlagId, birdSpecies: "lightning", replayed: false });
    expect(replay).toMatchObject({ eventId: first.eventId, flagId: developerFlagId, birdSpecies: "lightning", replayed: true });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(pool.query(
      `SELECT message,created_at
       FROM player_inbox_entries
       WHERE player_id=$1 AND entry_kind='game_notice' AND event_kind='legendary_bird_event' AND event_id=$2`,
      [ownerId, first.eventId]
    )).resolves.toMatchObject({
      rows: [{ message: send.mock.calls[0]?.[1]?.message, created_at: now }]
    });
    await expect(pool.query(`SELECT health,burning_reason FROM flags WHERE id=$1`, [developerFlagId]))
      .resolves.toMatchObject({ rows: [{ health: 110, burning_reason: "flag_burn" }] });
    await expect(pool.query(
      `SELECT source_kind,legendary_event_id::text,status
       FROM flag_burn_operations WHERE flag_id=$1`,
      [developerFlagId]
    )).resolves.toMatchObject({ rows: [{
      source_kind: "legendary_bird",
      legendary_event_id: first.eventId,
      status: "active"
    }] });
    await expect(pool.query(`SELECT cycle_started_at,expires_at FROM legendary_bird_cycles`))
      .resolves.toMatchObject({ rows: cycleBefore.rows });
    const cooldownBefore = await pool.query(`SELECT bird_species,last_activated_at,available_at FROM legendary_bird_species_cooldowns ORDER BY bird_species`);
    const activationClient = await pool.connect();
    await activationClient.query("BEGIN");
    await expect(service.activateForCommittedArrival(activationClient, developerFlagId, ownerId, "ALLOWED_OWNER")).resolves.toBe(first.eventId);
    await activationClient.query("COMMIT"); activationClient.release();
    await expect(pool.query(`SELECT bird_species,last_activated_at,available_at FROM legendary_bird_species_cooldowns ORDER BY bird_species`))
      .resolves.toMatchObject({ rows: cooldownBefore.rows });
    await pool.query(`DELETE FROM legendary_bird_events WHERE event_id=$1`, [first.eventId]);
    await pool.query(`DELETE FROM legendary_bird_events WHERE event_id=$1`, [completedEventId]);
    await pool.query(`DELETE FROM flags WHERE id=ANY($1::uuid[])`, [[developerFlagId, completedCycleFlagId]]);
  });

  it("settles canonical XP and one contestable Feather without replay duplication", async () => {
    const event = await pool.query<{
      event_id: string;
      combat_entity_id: string;
      bird_species: "fire" | "lightning" | "ice";
    }>(
      `SELECT event_id::text,combat_entity_id::text,bird_species
       FROM legendary_bird_events WHERE owner_player_id=$1`,
      [ownerId]
    );
    const row = event.rows[0]!;
    const archetype = `${row.bird_species}_bird` as const;
    const xpAnchor = combatXpAnchor(archetype);
    const candidate = {
      settlementKey: `legendary-defeat-${suffix}`,
      defeatedEntityId: row.combat_entity_id,
      defeatGeneration: 1,
      eligibleParticipantIds: [ownerId],
      contributions: [{ entityId: ownerId, damage: 1_200 }],
      serverTick: 100,
      mobArchetype: archetype,
      mobLevel: MOB_DEFINITIONS[archetype].level,
      xpPolicyVersion: xpAnchor.xpPolicyVersion,
      itemRewardPolicyVersion: COMBAT_ITEM_REWARD_POLICY_VERSION,
      targetBasicHitCount: xpAnchor.targetBasicHitCount,
      baseXpPool: xpAnchor.baseXpPool,
      defeatingPlayerId: ownerId,
      bossOwnership: {
        bossId: `legendary_${row.bird_species}`,
        bossRevision: 1,
        encounterHandlerId: "legendary-bird",
        hostKind: "overworld" as const,
        hostInstanceId: row.event_id,
        encounterInstanceId: row.event_id,
        appearanceId: `legendary_${row.bird_species}`,
        lifeGeneration: 0
      },
      lootLocation: {
        regionCode: "NM",
        zoneId: "legendary-test-zone",
        position: { lat: 35, lon: -106 }
      }
    };

    vi.mocked(flags.getFlag).mockRejectedValueOnce(new Error("flag publication unavailable"));
    await expect(service.acceptDefeat(candidate)).resolves.toBe(true);
    await rewardSettlements.flush();
    await expect(service.acceptDefeat(candidate)).resolves.toBe(true);
    await rewardSettlements.flush();
    const settlements = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM combat_reward_settlements
       WHERE settlement_key=$1`,
      [candidate.settlementKey]
    );
    expect(settlements.rows[0]?.count).toBe("1");
    const characterXp = await pool.query<{ count: string; xp: string }>(
      `SELECT count(*)::text AS count,coalesce(sum(granted_xp),0)::text AS xp
       FROM xp_operations WHERE operation_key=$1`,
      [`combat-settlement:${candidate.settlementKey}:${ownerId}`]
    );
    expect(characterXp.rows[0]?.count).toBe("1");
    expect(Number(characterXp.rows[0]?.xp)).toBeGreaterThan(0);
    const drops = await pool.query<{ item_id: string; quantity: string }>(
      `SELECT item_id,remaining_quantity::text AS quantity
       FROM world_item_drops WHERE pile_id=$1`,
      [`combat:${candidate.settlementKey}`]
    );
    expect(drops.rows).toEqual(expect.arrayContaining([{
      item_id: (row.bird_species === "lightning" ? "tempest_quill" : `${row.bird_species}_feather`),
      quantity: "1"
    }]));
    expect(completedSettlements).toHaveLength(1);
    expect(completedSettlements[0]).toMatchObject({
      settlementKey: candidate.settlementKey,
      shares: [expect.objectContaining({ requestedXp: expect.any(Number) })],
      mobReward: expect.objectContaining({
        drops: [expect.objectContaining({
          itemId: "tempest_quill",
          quantity: 1,
          status: "active"
        })]
      })
    });
    expect((await pool.query(
      `SELECT quantity FROM player_inventory WHERE player_id=$1 AND resource_type=$2`,
      [ownerId, (row.bird_species === "lightning" ? "tempest_quill" : `${row.bird_species}_feather`)]
    )).rowCount).toBe(0);
  });

  it("starts only one replacement cycle after downtime and expires missed encounters at 24 hours", async () => {
    const initialCycleStart = new Date("2099-08-24T12:00:00.000Z");
    const initialCycleExpiry = new Date(initialCycleStart.getTime() + 86_400_000);
    await pool.query(
      `INSERT INTO legendary_bird_events (
         event_id,cycle_started_at,bird_species,flag_id,owner_player_id,status,
         selected_at,expires_at,completed_at
       ) VALUES ($1,$2,'ice',$3,$4,'completed',$2,$5,$5)`,
      [randomUUID(), initialCycleStart, softFlagId, ownerId, initialCycleExpiry]
    );
    await pool.query(
      `UPDATE flags SET burning_started_at=$2,burning_until=$3,burning_reason='legendary_event'
       WHERE id=$1`,
      [softFlagId, initialCycleStart, initialCycleExpiry]
    );
    getFlag.mockClear();
    now = new Date("2099-08-27T12:00:00.000Z");
    await service.rotateCycle();
    expect(getFlag).toHaveBeenCalledWith(softFlagId);
    const cyclesAfterDowntime = await pool.query<{ cycle_started_at: Date; expires_at: Date }>(
      `SELECT cycle_started_at,expires_at FROM legendary_bird_cycles ORDER BY cycle_started_at`
    );
    expect(cyclesAfterDowntime.rows).toHaveLength(2);
    expect(new Date(cyclesAfterDowntime.rows[1]!.cycle_started_at)).toEqual(now);
    expect(new Date(cyclesAfterDowntime.rows[1]!.expires_at).getTime() - now.getTime()).toBe(86_400_000);
    const missed = await pool.query<{ event_id: string; flag_id: string }>(
      `SELECT event_id::text,flag_id::text FROM legendary_bird_events
       WHERE cycle_started_at=$1 AND status='pending'`,
      [now]
    );
    expect(missed.rows).toHaveLength(1);

    now = new Date(now.getTime() + 86_400_000);
    await service.rotateCycle();
    await expect(pool.query(
      `SELECT status FROM legendary_bird_events WHERE event_id=$1`,
      [missed.rows[0]!.event_id]
    )).resolves.toMatchObject({ rows: [] });
    await expect(pool.query(
      `SELECT status FROM flag_burn_operations
       WHERE flag_id=$1 AND source_kind='legendary_bird' AND status='completed'`,
      [missed.rows[0]!.flag_id]
    )).resolves.toMatchObject({ rows: [{ status: "completed" }] });
    expect((await pool.query(`SELECT 1 FROM legendary_bird_cycles`)).rowCount).toBe(3);
  });

  it("returns exact active legendary entity ids when the developer clear removes flags", async () => {
    const activeCycle = await pool.query<{ cycle_started_at: Date; expires_at: Date }>(
      `SELECT cycle_started_at,expires_at FROM legendary_bird_cycles
       WHERE cycle_started_at<=$1 AND expires_at>$1
       ORDER BY cycle_started_at DESC LIMIT 1`,
      [now]
    );
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,reinforcement_level,health,maximum_health,access_mode,geom
       ) VALUES ($1,$2,'Clear Fixture Stone',35.04,-106.04,100,1,200,200,'private',
                 ST_SetSRID(ST_MakePoint(-106.04,35.04),4326))`,
      [clearFlagId, ownerId]
    );
    const clearEventId = randomUUID();
    await pool.query(
      `INSERT INTO legendary_bird_events (
         event_id,cycle_started_at,bird_species,flag_id,owner_player_id,status,
         selected_at,expires_at
       ) VALUES ($1,$2,'fire',$3,$4,'pending',$5,$6)`,
      [clearEventId, activeCycle.rows[0]!.cycle_started_at, clearFlagId, ownerId, now, activeCycle.rows[0]!.expires_at]
    );
    const pending = await pool.query<{ event_id: string; flag_id: string; combat_entity_id: string }>(
      `SELECT event_id::text,flag_id::text,combat_entity_id::text
       FROM legendary_bird_events WHERE event_id=$1`,
      [clearEventId]
    );
    const row = pending.rows[0]!;
    const client = await pool.connect();
    await client.query("BEGIN");
    await expect(service.activateForCommittedArrival(
      client, row.flag_id, ownerId, "ALLOWED_OWNER"
    )).resolves.toBe(row.event_id);
    await client.query("COMMIT");
    client.release();

    const deletionFlags = new FlagService(
      pool,
      {} as never,
      {} as never,
      { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      new InventoryService(pool)
    );
    await expect(deletionFlags.clearFlags()).resolves.toMatchObject({
      legendaryCombatEntityIds: [row.combat_entity_id]
    });
    expect((await pool.query(
      `SELECT 1 FROM legendary_bird_events WHERE flag_id=$1`,
      [clearFlagId]
    )).rowCount).toBe(0);
  });
});
