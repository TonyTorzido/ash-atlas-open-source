import { randomUUID } from "node:crypto";

import {
  LEGENDARY_BIRD_INBOX_EVENT_KIND,
  structureWarfareBreachThresholdForReinforcementLevel,
  structureWarfareBurnDurationForReinforcementLevel,
  type FlagAccessDecision
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppLogger } from "../logger.js";
import type { CombatDefeatSettlementCandidate, CombatEngine } from "./combat/combatEngine.js";
import type { BossEncounterManager } from "./bossFramework.js";
import type { OverworldBossEventHandler, OverworldBossEventPublisher } from "./overworldBossEvents.js";
import { formatFlagRelativeCity } from "./flagPresentation.js";
import type { LegendaryFlagService } from "./flagServiceContracts.js";
import { packageIdForPosition, zoneIdForPosition } from "./spatialZones.js";

export const LEGENDARY_EVENT_CYCLE_MS = 24 * 60 * 60_000;
export const LEGENDARY_EVENT_POLL_INTERVAL_MS = 60_000;
export const LEGENDARY_EVENT_QUOTAS = Object.freeze({ fire: 1, lightning: 1, ice: 3 });
export const LEGENDARY_FLAG_MAX_HEALTH = 200;
export const LEGENDARY_FLAG_SELECTED_HEALTH = 100;

export type LegendaryBirdSpecies = "fire" | "lightning" | "ice";
type LiveStatus = "pending" | "active";

type EventRow = {
  event_id: string;
  bird_species: LegendaryBirdSpecies;
  flag_id: string;
  owner_player_id: string;
  status: LiveStatus | "completed" | "expired";
  selected_at: Date | string;
  expires_at: Date | string;
  combat_entity_id: string;
  defeat_settlement_key: string | null;
  lat: number;
  lon: number;
  region_code: string | null;
  event_source: "daily" | "developer";
};

type AlertEventRow = EventRow & {
  burning_reason: string | null;
  burning_until: Date | string | null;
  read_revision: string | null;
};

type LegendaryBirdBurnTargetRow = {
  flag_name: string;
  flag_lat: number;
  flag_lon: number;
  owner_player_id: string;
  reinforcement_level: number;
  tower_level: number | null;
  health: number;
  maximum_health: number;
  damage_cycle_id: string | null;
};

export type EligibleLegendaryFlag = {
  flag_id: string;
  owner_player_id: string;
  lat: number;
  lon: number;
  region_code: string | null;
  city_name: string | null;
  city_lat: number | null;
  city_lon: number | null;
};
export type EligibleFlag = EligibleLegendaryFlag;

const EVENT_SELECT = `SELECT event.event_id::text,event.bird_species,event.flag_id::text,
  event.owner_player_id,event.status,event.selected_at,event.expires_at,
  event.combat_entity_id::text,event.defeat_settlement_key,flag.lat,flag.lon,flag.package_id AS region_code,
  event.event_source
  FROM legendary_bird_events event JOIN flags flag ON flag.id=event.flag_id`;

export class LegendaryBirdDeveloperError extends Error {
  constructor(
    readonly code: "LEGENDARY_BIRD_PLAYER_NOT_FOUND" | "LEGENDARY_BIRD_NO_ACTIVE_CYCLE" | "LEGENDARY_BIRD_NO_ELIGIBLE_FLAG",
    message: string,
    readonly statusCode: 404 | 409
  ) {
    super(message);
    this.name = "LegendaryBirdDeveloperError";
  }
}
export type LegendaryBirdDeveloperPlayer = Readonly<{
  playerId: string;
  playerName: string;
  eligibleBastionFlagCount: number;
}>;

export type LegendaryBirdDeveloperTriggerResult = Readonly<{
  eventId: string;
  playerId: string;
  playerName: string;
  flagId: string;
  birdSpecies: LegendaryBirdSpecies;
  expiresAt: string;
  replayed: boolean;
}>;

type LegendaryBirdRewardSettlements = Readonly<{
  acceptInTransaction: (
    client: pg.PoolClient,
    candidate: CombatDefeatSettlementCandidate
  ) => Promise<void>;
  flush: () => Promise<void>;
}>;

export class LegendaryBirdEventService implements OverworldBossEventHandler {
  readonly handlerId = "legendary-bird";
  readonly rewardSettlementPolicy = "canonical";
  private timer: NodeJS.Timeout | null = null;
  private rotating = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly combat: CombatEngine,
    private readonly rewardSettlements: LegendaryBirdRewardSettlements,
    private readonly flags: LegendaryFlagService,
    private readonly registry: OverworldBossEventPublisher,
    private readonly logger: AppLogger,
    private readonly random: () => number = Math.random,
    private readonly now: () => Date = () => new Date(),
    /**
     * Production composition supplies the shared encounter manager so legacy
     * archetype routing is disabled. Unit fixtures may omit it while they
     * exercise the durable settlement path without a full encounter host.
     */
    private readonly bossEncounters: BossEncounterManager | null = null
  ) {}

  async recover(): Promise<void> {
    await this.rotateCycle();
    this.timer = setInterval(() => {
      void this.rotateCycle().catch((error: unknown) =>
        this.logger.warn({ err: error }, "failed to rotate legendary bird cycle"));
    }, LEGENDARY_EVENT_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isLegendaryBird(entityId: string): boolean {
    const entity = this.combat.entity(entityId);
    return entity?.archetypeKey === "fire_bird" ||
      entity?.archetypeKey === "lightning_bird" || entity?.archetypeKey === "ice_bird";
  }

  ownsEntity(entityId: string): boolean {
    return this.isLegendaryBird(entityId);
  }

  ownsDefeatCandidate(candidate: CombatDefeatSettlementCandidate): boolean {
    return candidate.bossOwnership?.hostKind === "overworld" &&
      candidate.bossOwnership.encounterHandlerId === this.handlerId &&
      candidate.bossOwnership.bossId.startsWith("legendary_");
  }

  canPlayerAttack(playerId: string, entityId: string): boolean {
    void playerId;
    return this.isLegendaryBird(entityId);
  }

  canMobAttack(entityId: string, playerId: string): boolean {
    void playerId;
    return this.isLegendaryBird(entityId);
  }

  isSharedCombat(entityId: string): boolean {
    return this.isLegendaryBird(entityId);
  }

  async rotateCycle(): Promise<void> {
    if (this.rotating) return;
    this.rotating = true;
    const now = this.now();
    let client: pg.PoolClient | null = null;
    let transactionOpen = false;
    const expiredEntityIds: string[] = [];
    const changedFlagIds = new Set<string>();
    const alerts: Array<{ row: EventRow; flag: EligibleFlag }> = [];
    let activeRows: EventRow[] = [];
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext('legendary-bird-daily-cycle-v1'))");
      const expired = await client.query<{ combat_entity_id: string; flag_id: string }>(
        `UPDATE legendary_bird_events SET status='expired',completed_at=$1
         WHERE status IN ('pending','active') AND expires_at<=$1
         RETURNING combat_entity_id::text,flag_id::text`,
        [now]
      );
      for (const row of expired.rows) {
        expiredEntityIds.push(row.combat_entity_id);
        changedFlagIds.add(row.flag_id);
      }
      const expiredBirdBurns = await client.query<{
        operation_id: string;
        flag_id: string;
      }>(
        `SELECT operation.operation_id::text,operation.flag_id::text
         FROM flag_burn_operations operation
         WHERE operation.source_kind='legendary_bird'
           AND operation.status='active'
           AND operation.completes_at<=$1
         ORDER BY operation.completes_at,operation.operation_id
         FOR UPDATE`,
        [now]
      );
      for (const operation of expiredBirdBurns.rows) {
        const target = await client.query(
          "SELECT 1 FROM flags WHERE id=$1 FOR UPDATE",
          [operation.flag_id]
        );
        if (target.rowCount !== 1) {
          await client.query(
            `UPDATE flag_burn_operations
             SET status='cancelled',completed_at=$2,result=$3::jsonb
             WHERE operation_id=$1 AND status='active'`,
            [
              operation.operation_id,
              now,
              JSON.stringify({ source: "legendary_bird", flagId: operation.flag_id, reason: "flag-missing" })
            ]
          );
          continue;
        }
        await this.flags.deleteFlagForBurnInTransaction(
          client,
          operation.flag_id,
          null
        );
        await client.query(
          `UPDATE flag_burn_operations
           SET status='completed',completed_at=$2,result=$3::jsonb
           WHERE operation_id=$1 AND status='active'`,
          [
            operation.operation_id,
            now,
            JSON.stringify({ source: "legendary_bird", flagId: operation.flag_id })
          ]
        );
        changedFlagIds.add(operation.flag_id);
      }
      const extinguished = await client.query<{ id: string }>(
        `UPDATE flags flag SET burning_started_at=NULL,burning_until=NULL,burning_reason=NULL
         WHERE burning_reason='legendary_event' AND burning_until<=$1
           AND NOT EXISTS (
             SELECT 1 FROM legendary_bird_events event
             WHERE event.flag_id=flag.id AND event.status IN ('pending','active')
           )
         RETURNING flag.id::text`,
        [now]
      );
      for (const row of extinguished.rows) changedFlagIds.add(row.id);
      const currentCycle = await client.query<{ cycle_started_at: Date | string; expires_at: Date | string }>(
        `SELECT cycle_started_at,expires_at FROM legendary_bird_cycles
         WHERE cycle_started_at<=$1 AND expires_at>$1
         ORDER BY cycle_started_at DESC LIMIT 1`,
        [now]
      );
      const cycleStart = currentCycle.rows[0]
        ? new Date(currentCycle.rows[0].cycle_started_at)
        : now;
      const expiresAt = currentCycle.rows[0]
        ? new Date(currentCycle.rows[0].expires_at)
        : new Date(now.getTime() + LEGENDARY_EVENT_CYCLE_MS);
      if (currentCycle.rowCount === 0) {
        await client.query(
          `INSERT INTO legendary_bird_cycles (cycle_started_at,expires_at) VALUES ($1,$2)`,
          [cycleStart, expiresAt]
        );
        const eligible = await client.query<EligibleFlag>(
          `SELECT flag.id::text AS flag_id,flag.owner_id AS owner_player_id,
                  flag.lat,flag.lon,flag.package_id AS region_code,
                  nearest.name AS city_name,nearest.hall_lat AS city_lat,nearest.hall_lon AS city_lon
           FROM flags flag
           LEFT JOIN LATERAL (
             SELECT city.name,city.hall_lat,city.hall_lon
             FROM cities city WHERE city.active
             ORDER BY ST_Distance(city.hall_geom::geography,flag.geom::geography),city.id LIMIT 1
           ) nearest ON true
           WHERE flag.control_type='personal' AND flag.anchor_kind='flag'
             AND flag.reinforcement_level IN (1,3) AND flag.health>0
             AND (flag.burning_until IS NULL OR flag.burning_until<=$1)
             AND NOT EXISTS (
               SELECT 1 FROM legendary_bird_events live
               WHERE live.flag_id=flag.id AND live.status IN ('pending','active')
             )
           ORDER BY flag.id
           FOR UPDATE OF flag`,
          [now]
        );
        const unavailable = await client.query<{ bird_species: LegendaryBirdSpecies }>(
          `SELECT bird_species FROM legendary_bird_species_cooldowns WHERE available_at>$1`,
          [now]
        );
        const unavailableSpecies = new Set(unavailable.rows.map((row) => row.bird_species));
        const availableSpecies = (["fire", "lightning", "ice"] as const)
          .filter((species) => !unavailableSpecies.has(species));
        for (const { flag, bird } of selectDailyLegendaryAssignments(
          eligible.rows,
          this.random,
          availableSpecies
        )) {
          const inserted = await client.query<EventRow>(
            `INSERT INTO legendary_bird_events (
               event_id,cycle_started_at,bird_species,flag_id,owner_player_id,selected_at,expires_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING event_id::text,bird_species,flag_id::text,owner_player_id,status,
                       selected_at,expires_at,combat_entity_id::text,NULL::text AS defeat_settlement_key,$8::float8 AS lat,
                       $9::float8 AS lon,$10::text AS region_code,'daily'::text AS event_source`,
            [randomUUID(), cycleStart, bird, flag.flag_id, flag.owner_player_id, now, expiresAt,
              flag.lat, flag.lon, flag.region_code]
          );
          const row = inserted.rows[0]!;
          await this.applyLegendaryBirdBurn(
            client,
            row.event_id,
            row.flag_id,
            row.owner_player_id,
            row.bird_species,
            now,
            expiresAt
          );
          changedFlagIds.add(flag.flag_id);
          alerts.push({ row, flag });
        }
      }
      const active = await client.query<EventRow>(
        `${EVENT_SELECT} WHERE event.status='active' AND event.expires_at>$1 ORDER BY event.event_id`,
        [now]
      );
      activeRows = active.rows;
      const noticeEvents = await client.query<EventRow & {
        city_name: string | null;
        city_lat: number | null;
        city_lon: number | null;
      }>(
        `SELECT event.event_id::text,event.bird_species,event.flag_id::text,
          event.owner_player_id,event.status,event.selected_at,event.expires_at,
          event.combat_entity_id::text,event.defeat_settlement_key,
          flag.lat,flag.lon,flag.package_id AS region_code,event.event_source,
          nearest.name AS city_name,nearest.hall_lat AS city_lat,nearest.hall_lon AS city_lon
         FROM legendary_bird_events event JOIN flags flag ON flag.id=event.flag_id
         LEFT JOIN LATERAL (
           SELECT city.name,city.hall_lat,city.hall_lon
           FROM cities city WHERE city.active
           ORDER BY ST_Distance(city.hall_geom::geography,flag.geom::geography),city.id LIMIT 1
         ) nearest ON true
         WHERE event.status IN ('pending','active') AND event.expires_at>$1
         ORDER BY event.selected_at,event.event_id`,
        [now]
      );
      for (const noticeEvent of noticeEvents.rows) {
        await ensureLegendaryBirdInboxNotice(client, noticeEvent, eligibleFlagFromEvent(noticeEvent));
      }
      await client.query("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (client && transactionOpen) await client.query("ROLLBACK");
      throw error;
    } finally {
      client?.release();
      this.rotating = false;
    }
    for (const entityId of expiredEntityIds) {
      try {
        this.combat.despawnMob(entityId);
      } catch (error) {
        this.logger.warn({ err: error, entityId }, "failed to despawn expired legendary bird");
      }
    }
    for (const row of activeRows) {
      try {
        this.spawn(row);
      } catch (error) {
        this.logger.warn({ err: error, eventId: row.event_id }, "failed to restore active legendary bird");
      }
    }
    for (const flagId of changedFlagIds) {
      try {
        await this.publishFlag(flagId);
      } catch (error) {
        this.logger.warn({ err: error, flagId }, "failed to publish legendary bird flag change");
      }
    }
    for (const { row, flag } of alerts) {
      try {
        this.sendAlert(row, flag);
      } catch (error) {
        this.logger.warn({ err: error, eventId: row.event_id }, "failed to send legendary bird alert");
      }
    }
  }

  async activateForCommittedArrival(
    client: pg.PoolClient,
    flagId: string,
    playerId: string,
    reasonCode: FlagAccessDecision["reasonCode"]
  ): Promise<string | null> {
    if (reasonCode !== "ALLOWED_OWNER" && reasonCode !== "ALLOWED_INVITE" && reasonCode !== "ALLOWED_NORMAL") {
      return null;
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext('legendary-bird-daily-cycle-v1'))");
    const activatedAt = this.now();
    const result = await client.query<{ event_id: string }>(
      `WITH activated AS (
         UPDATE legendary_bird_events event SET status='active',activated_at=$3,
                activated_by_player_id=$2
         WHERE event.flag_id=$1 AND event.status='pending' AND event.expires_at>$3
           AND (event.owner_player_id=$2 OR $4 <> 'ALLOWED_OWNER')
         RETURNING event.event_id,event.bird_species
       ), cooldown AS (
         INSERT INTO legendary_bird_species_cooldowns (
           bird_species,last_activated_at,available_at
         )
         SELECT event.bird_species,$3,$3 + interval '24 hours'
         FROM activated JOIN legendary_bird_events event USING (event_id)
         WHERE event.event_source='daily'
         ON CONFLICT (bird_species) DO UPDATE SET
           last_activated_at=GREATEST(
             legendary_bird_species_cooldowns.last_activated_at,
             EXCLUDED.last_activated_at
           ),
           available_at=GREATEST(
             legendary_bird_species_cooldowns.available_at,
             EXCLUDED.available_at
           )
         RETURNING bird_species
       )
       SELECT activated.event_id::text FROM activated
       LEFT JOIN cooldown USING (bird_species)`,
      [flagId, playerId, activatedAt, reasonCode]
    );
    return result.rows[0]?.event_id ?? null;
  }

  async searchDeveloperPlayers(search: string): Promise<{ players: LegendaryBirdDeveloperPlayer[] }> {
    const result = await this.pool.query<{
      player_id: string; player_name: string; eligible_count: string;
    }>(
      `SELECT player.id AS player_id,player.username AS player_name,
              count(flag.id)::text AS eligible_count
       FROM players player
       LEFT JOIN flags flag ON flag.owner_id=player.id
         AND flag.control_type='personal' AND flag.anchor_kind='flag'
         AND flag.reinforcement_level IN (1,3) AND flag.health>0
         AND (flag.burning_until IS NULL OR flag.burning_until<=$2)
         AND NOT EXISTS (
           SELECT 1 FROM legendary_bird_events cycle_event
           JOIN legendary_bird_cycles active_cycle
             ON active_cycle.cycle_started_at=cycle_event.cycle_started_at
           WHERE cycle_event.flag_id=flag.id
             AND active_cycle.cycle_started_at<=$2 AND active_cycle.expires_at>$2
         )
       WHERE ($1='' OR player.username ILIKE '%' || $1 || '%' OR player.id ILIKE '%' || $1 || '%')
       GROUP BY player.id,player.username
       ORDER BY (player.username_normalized=lower($1)) DESC,player.username_normalized,player.id
       LIMIT 20`,
      [search.trim(), this.now()]
    );
    return { players: result.rows.map((row) => ({
      playerId: row.player_id,
      playerName: row.player_name,
      eligibleBastionFlagCount: Number(row.eligible_count)
    })) };
  }

  async triggerDeveloperEvent(input: Readonly<{
    playerId: string;
    birdSpecies?: LegendaryBirdSpecies;
    operationKey: string;
  }>): Promise<LegendaryBirdDeveloperTriggerResult> {
    const now = this.now();
    const client = await this.pool.connect();
    let transactionOpen = false;
    let row: EventRow | null = null;
    let flag: EligibleFlag | null = null;
    let playerName = "";
    let replayed = false;
    try {
      await client.query("BEGIN"); transactionOpen = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext('legendary-bird-daily-cycle-v1'))");
      const existing = await client.query<EventRow & { player_name: string; city_name: string | null; city_lat: number | null; city_lon: number | null }>(
        `SELECT event.event_id::text,event.bird_species,event.flag_id::text,event.owner_player_id,
           event.status,event.selected_at,event.expires_at,event.combat_entity_id::text,
           event.defeat_settlement_key,flag.lat,flag.lon,flag.package_id AS region_code,event.event_source,
           player.username AS player_name,nearest.name AS city_name,
           nearest.hall_lat AS city_lat,nearest.hall_lon AS city_lon
         FROM legendary_bird_events event JOIN flags flag ON flag.id=event.flag_id
         JOIN players player ON player.id=event.owner_player_id
         LEFT JOIN LATERAL (SELECT city.name,city.hall_lat,city.hall_lon FROM cities city
           WHERE city.active ORDER BY ST_Distance(city.hall_geom::geography,flag.geom::geography),city.id LIMIT 1) nearest ON true
         WHERE event.developer_operation_key=$1`, [input.operationKey]
      );
      if (existing.rows[0]) {
        const found = existing.rows[0]; row = found; playerName = found.player_name; replayed = true;
        flag = { flag_id: found.flag_id, owner_player_id: found.owner_player_id, lat: Number(found.lat), lon: Number(found.lon), region_code: found.region_code, city_name: found.city_name, city_lat: found.city_lat === null ? null : Number(found.city_lat), city_lon: found.city_lon === null ? null : Number(found.city_lon) };
      } else {
        const player = await client.query<{ username: string }>(`SELECT username FROM players WHERE id=$1`, [input.playerId]);
        if (!player.rows[0]) throw new LegendaryBirdDeveloperError("LEGENDARY_BIRD_PLAYER_NOT_FOUND", "Player was not found", 404);
        playerName = player.rows[0].username;
        const cycle = await client.query<{ cycle_started_at: Date | string; expires_at: Date | string }>(
          `SELECT cycle_started_at,expires_at FROM legendary_bird_cycles WHERE cycle_started_at<=$1 AND expires_at>$1 ORDER BY cycle_started_at DESC LIMIT 1`, [now]
        );
        if (!cycle.rows[0]) throw new LegendaryBirdDeveloperError("LEGENDARY_BIRD_NO_ACTIVE_CYCLE", "No legendary bird cycle is active", 409);
        const eligible = await client.query<EligibleFlag>(
          `SELECT flag.id::text AS flag_id,flag.owner_id AS owner_player_id,flag.lat,flag.lon,flag.package_id AS region_code,
                  nearest.name AS city_name,nearest.hall_lat AS city_lat,nearest.hall_lon AS city_lon
           FROM flags flag LEFT JOIN LATERAL (SELECT city.name,city.hall_lat,city.hall_lon FROM cities city WHERE city.active
             ORDER BY ST_Distance(city.hall_geom::geography,flag.geom::geography),city.id LIMIT 1) nearest ON true
           WHERE flag.owner_id=$1 AND flag.control_type='personal' AND flag.anchor_kind='flag'
             AND flag.reinforcement_level IN (1,3) AND flag.health>0 AND (flag.burning_until IS NULL OR flag.burning_until<=$2)
             AND NOT EXISTS (SELECT 1 FROM legendary_bird_events cycle_event
               WHERE cycle_event.flag_id=flag.id AND cycle_event.cycle_started_at=$3)
           ORDER BY random() LIMIT 1 FOR UPDATE OF flag`,
          [input.playerId, now, cycle.rows[0].cycle_started_at]
        );
        flag = eligible.rows[0] ?? null;
        if (!flag) throw new LegendaryBirdDeveloperError("LEGENDARY_BIRD_NO_ELIGIBLE_FLAG", "Player has no eligible bastion flag", 409);
        const species = input.birdSpecies ?? (["fire", "lightning", "ice"] as const)[Math.floor(this.random() * 3)]!;
        const inserted = await client.query<EventRow>(
          `INSERT INTO legendary_bird_events (event_id,cycle_started_at,bird_species,flag_id,owner_player_id,selected_at,expires_at,event_source,developer_operation_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'developer',$8)
           RETURNING event_id::text,bird_species,flag_id::text,owner_player_id,status,selected_at,expires_at,
             combat_entity_id::text,defeat_settlement_key,$9::float8 AS lat,$10::float8 AS lon,$11::text AS region_code,event_source`,
          [randomUUID(), cycle.rows[0].cycle_started_at, species, flag.flag_id, input.playerId, now, cycle.rows[0].expires_at, input.operationKey, flag.lat, flag.lon, flag.region_code]
        );
        row = inserted.rows[0]!;
        await this.applyLegendaryBirdBurn(
          client,
          row.event_id,
          row.flag_id,
          row.owner_player_id,
          row.bird_species,
          now,
          new Date(cycle.rows[0].expires_at)
        );
      }
      await ensureLegendaryBirdInboxNotice(client, row, flag);
      await client.query("COMMIT"); transactionOpen = false;
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    if (!row || !flag) throw new Error("Developer legendary bird event result is unavailable");
    if (!replayed) {
      try { await this.publishFlag(flag.flag_id); }
      catch (error) { this.logger.warn({ err: error, flagId: flag.flag_id }, "failed to publish developer legendary bird flag change"); }
      try { this.sendAlert(row, flag); }
      catch (error) { this.logger.warn({ err: error, eventId: row.event_id }, "failed to send developer legendary bird alert"); }
    }
    return { eventId: row.event_id, playerId: row.owner_player_id, playerName, flagId: row.flag_id, birdSpecies: row.bird_species, expiresAt: new Date(row.expires_at).toISOString(), replayed };
  }

  async publishActivation(eventId: string): Promise<void> {
    const row = await this.activeEvent(eventId);
    if (!row) return;
    this.spawn(row);
    await this.publishFlag(row.flag_id);
  }

  async sendCurrentAlerts(playerId: string): Promise<void> {
    const alertNow = this.now();
    const result = await this.pool.query<AlertEventRow & {
      city_name: string | null;
      city_lat: number | null;
      city_lon: number | null;
    }>(
      `SELECT event.event_id::text,event.bird_species,event.flag_id::text,
              event.owner_player_id,event.status,event.selected_at,event.expires_at,
              event.combat_entity_id::text,event.defeat_settlement_key,
              flag.lat,flag.lon,flag.package_id AS region_code,
              event.event_source,
              flag.burning_reason,flag.burning_until,
              nearest.name AS city_name,nearest.hall_lat AS city_lat,nearest.hall_lon AS city_lon,
              receipt.read_revision
       FROM legendary_bird_events event JOIN flags flag ON flag.id=event.flag_id
       LEFT JOIN player_inbox_read_receipts receipt
         ON receipt.player_id=event.owner_player_id
        AND receipt.entry_key=CONCAT('game:',$3::text,':',event.event_id::text)
       LEFT JOIN LATERAL (
         SELECT city.name,city.hall_lat,city.hall_lon
         FROM cities city WHERE city.active
         ORDER BY ST_Distance(city.hall_geom::geography,flag.geom::geography),city.id LIMIT 1
       ) nearest ON true
       WHERE event.owner_player_id=$1 AND event.status IN ('pending','active')
         AND event.expires_at>$2 ORDER BY event.selected_at,event.event_id`,
      [playerId, alertNow, LEGENDARY_BIRD_INBOX_EVENT_KIND]
    );
    for (const row of result.rows) {
      if (row.read_revision === new Date(row.selected_at).toISOString()) continue;
      this.sendAlert(row, {
        flag_id: row.flag_id,
        owner_player_id: row.owner_player_id,
        lat: Number(row.lat),
        lon: Number(row.lon),
        region_code: row.region_code,
        city_name: row.city_name,
        city_lat: row.city_lat === null ? null : Number(row.city_lat),
        city_lon: row.city_lon === null ? null : Number(row.city_lon)
      }, (row.burning_reason === "legendary_event" || row.burning_reason === "flag_burn") &&
        row.burning_until !== null && new Date(row.burning_until) > alertNow);
    }
  }

  async acceptDefeat(candidate: CombatDefeatSettlementCandidate): Promise<boolean> {
    if (!this.ownsDefeatCandidate(candidate)) return false;
    const recipient =
      candidate.defeatingPlayerId &&
      candidate.eligibleParticipantIds.includes(candidate.defeatingPlayerId) &&
      candidate.contributions.some(
        (entry) => entry.entityId === candidate.defeatingPlayerId && entry.damage > 0
      )
        ? candidate.defeatingPlayerId
        : candidate.contributions.find(
            (entry) =>
              candidate.eligibleParticipantIds.includes(entry.entityId) &&
              entry.damage > 0
          )?.entityId ?? null;
    if (!recipient || !candidate.lootLocation) {
      throw new Error("Legendary bird defeat has no physical loot authority");
    }
    const client = await this.pool.connect();
    let flagId: string | null = null;
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const event = await client.query<EventRow>(
        `${EVENT_SELECT} WHERE event.combat_entity_id=$1 FOR UPDATE OF event`,
        [candidate.defeatedEntityId]
      );
      const row = event.rows[0];
      if (!row) throw new Error("Legendary bird event does not exist for defeat");
      flagId = row.flag_id;
      if (row.status === "completed" && row.defeat_settlement_key === candidate.settlementKey) {
        await this.rewardSettlements.acceptInTransaction(client, candidate);
      } else {
        if (row.status !== "active") throw new Error("Legendary bird event is not active");
        await this.rewardSettlements.acceptInTransaction(client, candidate);
        await client.query(
          `UPDATE legendary_bird_events SET status='completed',completed_at=$2,defeat_settlement_key=$3
           WHERE event_id=$1`,
          [row.event_id, this.now(), candidate.settlementKey]
        );
      }
      await client.query("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    void this.rewardSettlements.flush().catch((error: unknown) => {
      this.logger.warn({ err: error }, "failed to flush settled legendary bird combat rewards");
    });
    if (flagId) {
      try {
        await this.publishFlag(flagId);
      } catch (error) {
        this.logger.warn({ err: error, flagId }, "failed to publish settled legendary bird flag");
      }
    }
    return true;
  }

  private spawn(row: EventRow): void {
    if (this.combat.entity(row.combat_entity_id)) return;
    const position = { lat: Number(row.lat), lon: Number(row.lon) };
    this.combat.spawnMob({
      entityId: row.combat_entity_id,
      archetype: `${row.bird_species}_bird`,
      position,
      homePosition: position,
      regionCode: row.region_code ?? packageIdForPosition(position),
      zoneId: zoneIdForPosition(position),
      originFlagId: row.flag_id,
      worldAi: false,
      bossOwnership: {
        bossId: `legendary_${row.bird_species}`,
        bossRevision: 1,
        encounterHandlerId: this.handlerId,
        hostKind: "overworld",
        hostInstanceId: row.event_id,
        encounterInstanceId: row.event_id,
        appearanceId: `legendary_${row.bird_species}`,
        lifeGeneration: 0
      }
    });
  }

  private async applyLegendaryBirdBurn(
    client: pg.PoolClient,
    eventId: string,
    flagId: string,
    ownerPlayerId: string,
    birdSpecies: LegendaryBirdSpecies,
    startedAt: Date,
    expiresAt: Date
  ): Promise<void> {
    const target = await client.query<LegendaryBirdBurnTargetRow>(
      `SELECT flag.name AS flag_name,flag.lat AS flag_lat,flag.lon AS flag_lon,
              flag.owner_id AS owner_player_id,flag.reinforcement_level,flag.tower_level,
              flag.health,flag.maximum_health,flag.damage_cycle_id
       FROM flags flag
       WHERE flag.id=$1 AND flag.owner_id=$2
         AND flag.control_type='personal' AND flag.anchor_kind='flag'
       FOR UPDATE OF flag`,
      [flagId, ownerPlayerId]
    );
    const row = target.rows[0];
    if (!row) throw new Error("Legendary bird burn target does not exist");
    const reinforcementLevel = Number(row.reinforcement_level);
    const burnDurationMs = structureWarfareBurnDurationForReinforcementLevel(reinforcementLevel);
    const breachThreshold = structureWarfareBreachThresholdForReinforcementLevel(reinforcementLevel, row.tower_level);
    if (burnDurationMs === null || breachThreshold === null) {
      throw new Error("Legendary bird burn target has no canonical warfare tier");
    }
    const damageCycleId = row.damage_cycle_id ?? randomUUID();
    const remainingDurationMs = Math.max(0, expiresAt.getTime() - startedAt.getTime());
    await client.query(
      `INSERT INTO flag_burn_operations (
         burner_player_id,victim_player_id,flag_id,request_id,flag_name,
         flag_lat,flag_lon,notice_message,started_at,completes_at,
         reinforcement_level,burn_duration_ms,damage_cycle_id,remaining_duration_ms,
         source_kind,legendary_event_id
       ) VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                 COALESCE($12,gen_random_uuid()),$13,'legendary_bird',$14)
       ON CONFLICT DO NOTHING`,
      [
        ownerPlayerId,
        flagId,
        eventId,
        row.flag_name,
        Number(row.flag_lat),
        Number(row.flag_lon),
        `A ${birdSpecies} legendary bird is burning this Flag.`,
        startedAt,
        expiresAt,
        reinforcementLevel,
        burnDurationMs,
        damageCycleId,
        remainingDurationMs,
        eventId
      ]
    );
    await client.query(
      `UPDATE flags
       SET health=LEAST(health,$2),
           burning_started_at=$3,burning_until=$4,burning_reason='flag_burn',
           damage_cycle_id=COALESCE(damage_cycle_id,$5)
       WHERE id=$1`,
      [flagId, breachThreshold, startedAt, expiresAt, damageCycleId]
    );
  }

  private async activeEvent(eventId: string): Promise<EventRow | null> {
    const result = await this.pool.query<EventRow>(
      `${EVENT_SELECT} WHERE event.event_id=$1 AND event.status='active' AND event.expires_at>$2`,
      [eventId, this.now()]
    );
    return result.rows[0] ?? null;
  }

  async spawnActivation(eventId: string): Promise<void> {
    const row = await this.activeEvent(eventId);
    if (!row) return;
    this.spawn(row);
  }

  private async publishFlag(flagId: string): Promise<void> {
    const flag = await this.flags.getFlag(flagId);
    if (!flag) return;
    this.registry.broadcast({
      type: "FLAG_UPSERTED",
      flag,
      serverTime: Date.now(),
      flagSetRevision: await this.flags.currentFlagSetRevision()
    });
  }

  private sendAlert(row: EventRow, flag: EligibleFlag, flagIsBurning = true): void {
    this.registry.send(flag.owner_player_id, {
      type: "LEGENDARY_EVENT_ALERT",
      eventId: row.event_id,
      birdSpecies: row.bird_species,
      flagId: flag.flag_id,
      message: alertMessage(row.bird_species, flag, flagIsBurning),
      selectedAt: new Date(row.selected_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString()
    });
  }
}
async function ensureLegendaryBirdInboxNotice(
  queryable: Pick<pg.PoolClient, "query">,
  row: EventRow,
  flag: EligibleFlag
): Promise<void> {
  await queryable.query(
    `INSERT INTO player_inbox_entries (
       id,player_id,entry_kind,message,created_at,status,event_kind,event_id
     ) VALUES ($1,$2,'game_notice',$3,$4,'notice',$5,$6)
     ON CONFLICT (player_id,event_kind,event_id)
       WHERE entry_kind='game_notice'
     DO NOTHING`,
    [randomUUID(), row.owner_player_id, alertMessage(row.bird_species, flag, true),
      row.selected_at, LEGENDARY_BIRD_INBOX_EVENT_KIND, row.event_id]
  );
}

function eligibleFlagFromEvent(row: EventRow & {
  city_name: string | null;
  city_lat: number | null;
  city_lon: number | null;
}): EligibleFlag {
  return {
    flag_id: row.flag_id,
    owner_player_id: row.owner_player_id,
    lat: Number(row.lat),
    lon: Number(row.lon),
    region_code: row.region_code,
    city_name: row.city_name,
    city_lat: row.city_lat === null ? null : Number(row.city_lat),
    city_lon: row.city_lon === null ? null : Number(row.city_lon)
  };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

export function selectDailyLegendaryAssignments<T>(
  eligibleFlags: readonly T[],
  random: () => number,
  availableSpecies: readonly LegendaryBirdSpecies[] = ["fire", "lightning", "ice"]
): Array<Readonly<{ flag: T; bird: LegendaryBirdSpecies }>> {
  const flags = shuffled(eligibleFlags, random);
  const allowed = new Set(availableSpecies);
  const species = shuffled([
    ...Array.from({ length: LEGENDARY_EVENT_QUOTAS.fire }, () => "fire" as const),
    ...Array.from({ length: LEGENDARY_EVENT_QUOTAS.lightning }, () => "lightning" as const),
    ...Array.from({ length: LEGENDARY_EVENT_QUOTAS.ice }, () => "ice" as const)
  ].filter((species) => allowed.has(species)), random);
  return flags.slice(0, species.length).map((flag, index) => ({ flag, bird: species[index]! }));
}

export function alertMessage(
  species: LegendaryBirdSpecies,
  flag: EligibleFlag,
  flagIsBurning: boolean
): string {
  const label = { fire: "Phoenix", lightning: "Thunderbird", ice: "Ice Phoenix" }[species];
  const article = species === "ice" ? "An" : "A";
  const encounter = `The ${label} encounter remains available until the current legendary event cycle ends.`;
  const location = formatFlagRelativeCity(flag);
  if (!location) {
    return flagIsBurning
      ? `${article} ${label} is attacking your flag!`
      : `Your flag is no longer burning. ${encounter}`;
  }
  return flagIsBurning
    ? `${article} ${label} is attacking your flag! The flag is around ${location}!`
    : `Your flag ${location} is no longer burning. ${encounter}`;
}
