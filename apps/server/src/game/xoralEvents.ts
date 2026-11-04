import { randomUUID } from "node:crypto";

import {
  DROPPED_ITEM_PICKUP_RADIUS_M,
  distanceMeters,
  type LatLon,
  type XoralRingDropSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppLogger } from "../logger.js";
import {
  type CombatDefeatSettlementCandidate,
  type CombatEngine
} from "./combat/combatEngine.js";
import { MOB_XP_LEVEL_GROWTH } from "./combat/mobDefinitions.js";
import { OverworldBossHostAdapter, type BossEncounterManager } from "./bossFramework.js";
import type { EquipmentService } from "./equipment.js";
import type { OverworldBossEventHandler, OverworldBossEventPublisher } from "./overworldBossEvents.js";
import { OverworldBossParticipantLeaseCoordinator } from "./overworldBossParticipantLeases.js";
import type { PartyAuthority } from "./party/PartyAuthority.js";
import type { ProgressionService } from "./progression.js";
import type { GameState } from "./state.js";
import type { PopulationV2HarvestedTreeTransition } from "./populationZonesV2Runtime.js";
import { WalletService } from "./wallet.js";
import { recordCreatureBookKillInTransaction } from "./creatureBook.js";

export const XORAL_TREE_SPAWN_CHANCE = 0.0005;
export const XORAL_ANCHOR_RADIUS_M = 650;
export const XORAL_TARGET_CHANGE_MS = 5_000;
export const XORAL_ROOT_INTERVAL_MS = 15_000;
export const XORAL_ROOT_DURATION_MS = 3_000;
export const XORAL_ROOT_FOCUS_MS = 15_000;
export const XORAL_GOLD_REWARD = 10_000;
export const XORAL_PLAYER_XP_REWARD = Math.round(
  12 * 20 * (MOB_XP_LEVEL_GROWTH ** 25) * 5
);
/** Class XP is retained legacy data and no longer advances under Skill System V3. */
export const XORAL_CLASS_XP_REWARD = 0;

type XoralStatus = "dormant" | "starting" | "active" | "settling" | "defeated" | "cancelled";
type XoralRingId = "ring_plain";

type XoralEventRow = {
  event_id: string;
  source_tree_entity_id: string;
  population_zone_id: string;
  population_generation_id: string;
  owner_player_id: string;
  combat_entity_id: string;
  region_code: string;
  zone_id: string;
  lat: number | string;
  lon: number | string;
  appearance_variant?: "normal" | "ashen" | null;
  status: XoralStatus;
  locked_party_id: string | null;
  locked_participant_ids: unknown;
  excluded_participant_ids: unknown;
  defeat_candidate: CombatDefeatSettlementCandidate | null;
};

type XoralRingDropRow = {
  drop_id: string;
  event_id: string;
  owner_player_id: string;
  ring_definition_id: XoralRingId;
  region_code: string;
  zone_id: string;
  lat: number | string;
  lon: number | string;
  status: "available" | "picked_up";
  created_at: Date | string;
};

type ActiveRuntime = {
  eventId: string;
  entityId: string;
  ownerPlayerId: string;
  participantIds: string[];
  excludedIds: Set<string>;
  anchor: LatLon;
  nextTargetAt: number;
  nextRootAt: number;
  forcedFocusPlayerId: string | null;
  forcedFocusUntil: number;
  rootGeneration: number;
  leaseId: string;
};

export class XoralEventError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "XoralEventError";
  }
}

export class XoralEventService implements OverworldBossEventHandler {
  readonly handlerId = "xoral";
  readonly rewardSettlementPolicy = "xoral_bespoke";
  private readonly activeByEntityId = new Map<string, ActiveRuntime>();
  private readonly eventIdByParticipant = new Map<string, string>();
  private readonly leaseIdByEventId = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextDormantCleanupAt = 0;
  private dormantCleanupPending = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly combat: CombatEngine,
    private readonly parties: PartyAuthority,
    private readonly gameState: GameState,
    private readonly registry: Pick<OverworldBossEventPublisher, "send">,
    private readonly progression: ProgressionService,
    private readonly equipment: EquipmentService,
    private readonly logger: AppLogger,
    private readonly random: () => number = Math.random,
    private readonly participantLeases = new OverworldBossParticipantLeaseCoordinator(),
    private readonly bossEncounters: BossEncounterManager | null = null
  ) {}

  async recover(): Promise<void> {
    const result = await this.pool.query<XoralEventRow>(
      `SELECT event_id::text,source_tree_entity_id,population_zone_id,
              population_generation_id::text,owner_player_id,combat_entity_id,
              region_code,zone_id,lat,lon,appearance_variant,status,locked_party_id,
              locked_participant_ids,excluded_participant_ids,defeat_candidate
       FROM xoral_events
       WHERE status IN ('dormant','starting','active','settling')
       ORDER BY created_at`
    );
    for (const row of result.rows) {
      if (row.status === "starting") {
        const reset = await this.pool.query<XoralEventRow>(
          `UPDATE xoral_events
           SET status='dormant',locked_party_id=NULL,
               locked_participant_ids='[]'::jsonb,
               excluded_participant_ids='[]'::jsonb,
               activated_at=NULL,settled_at=NULL
           WHERE event_id=$1 AND status='starting'`,
          [row.event_id]
        );
        if (reset.rowCount !== 0) {
          const dormantRow = { ...row, status: "dormant" } as XoralEventRow;
          if (this.combat.entity(row.combat_entity_id)) {
            this.combat.setBossEventState(row.combat_entity_id, "dormant");
            this.ensureBossEncounter(
              dormantRow,
              this.combat.entity(row.combat_entity_id)?.appearanceVariant
            );
          } else {
            this.spawnCombatProjection(dormantRow);
          }
        }
        continue;
      }
      if (row.status === "settling" && row.defeat_candidate) {
        this.ensureEventLease(row);
        await this.finishSettlement(row);
        continue;
      }
      if (row.status === "active") {
        // Safe restart policy: an active Xoral life is cancelled on process
        // recovery. Combat health, casts, and target timers are not durable,
        // so silently rebuilding a full-health fight would misrepresent the
        // player's progress. The authored event remains represented only by
        // durable terminal state; a new tree event may be spawned normally.
        this.ensureEventLease(row);
        const cancelled = await this.pool.query(
          `UPDATE xoral_events
           SET status='cancelled',settled_at=now(),locked_party_id=NULL,
               locked_participant_ids='[]'::jsonb,
               excluded_participant_ids='[]'::jsonb
           WHERE event_id=$1 AND status='active'`,
          [row.event_id]
        );
        if (cancelled.rowCount !== 0) {
          this.bossEncounters?.despawn(row.event_id, "restart-cancel");
          this.despawnCombatEntity(row.combat_entity_id);
          this.releaseEventLease(row.event_id);
        }
        continue;
      }
      this.spawnCombatProjection(row);
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), 250);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const runtime of this.activeByEntityId.values()) {
      runtime.rootGeneration += 1;
      for (const playerId of runtime.participantIds) {
        this.gameState.setMovementBlocked(playerId, false, `xoral-root:${runtime.eventId}`);
      }
    }
    this.bossEncounters?.clearCasts();
  }

  async maybeSpawnAfterTreeHarvest(input: Readonly<{
    playerId: string;
    transition: PopulationV2HarvestedTreeTransition;
    regionCode: string;
    combatZoneId: string;
  }>): Promise<boolean> {
    if (this.random() >= XORAL_TREE_SPAWN_CHANCE) return false;
    const entityId = `xoral:${input.transition.entityId}`;
    const inserted = await this.pool.query<XoralEventRow>(
      `INSERT INTO xoral_events (
         source_tree_entity_id,population_zone_id,population_generation_id,
         owner_player_id,combat_entity_id,region_code,zone_id,lat,lon,appearance_variant
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING
       RETURNING event_id::text,source_tree_entity_id,population_zone_id,
         population_generation_id::text,owner_player_id,combat_entity_id,
         region_code,zone_id,lat,lon,appearance_variant,status,locked_party_id,
         locked_participant_ids,excluded_participant_ids,defeat_candidate`,
      [
        input.transition.entityId,
        input.transition.zoneId,
        input.transition.generationId,
        input.playerId,
        entityId,
        input.regionCode,
        input.combatZoneId,
        input.transition.position.lat,
        input.transition.position.lon,
        "normal"
      ]
    );
    const row = inserted.rows[0];
    if (!row) return false;
    this.spawnCombatProjection(row);
    return true;
  }

  async spawnDeveloperDormant(input: Readonly<{
    playerId: string;
    position: LatLon;
    regionCode: string;
    combatZoneId: string;
    appearanceVariant?: "normal" | "ashen";
  }>): Promise<string> {
    const identity = randomUUID();
    const entityId = `xoral:dev:${identity}`;
    const inserted = await this.pool.query<XoralEventRow>(
      `INSERT INTO xoral_events (
         source_tree_entity_id,population_zone_id,population_generation_id,
         owner_player_id,combat_entity_id,region_code,zone_id,lat,lon,appearance_variant
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING event_id::text,source_tree_entity_id,population_zone_id,
         population_generation_id::text,owner_player_id,combat_entity_id,
         region_code,zone_id,lat,lon,appearance_variant,status,locked_party_id,
         locked_participant_ids,excluded_participant_ids,defeat_candidate`,
      [
        `dev-tree:${identity}`,
        `dev:${input.regionCode}:${identity}`,
        identity,
        input.playerId,
        entityId,
        input.regionCode,
        input.combatZoneId,
        input.position.lat,
        input.position.lon,
        input.appearanceVariant ?? "normal"
      ]
    );
    this.spawnCombatProjection(inserted.rows[0]!, input.appearanceVariant);
    return entityId;
  }

  async clearDeveloperEvents(): Promise<void> {
    const cleared = await this.pool.query<{ event_id: string; combat_entity_id: string }>(
      `UPDATE xoral_events
       SET status='cancelled',settled_at=now()
       WHERE source_tree_entity_id LIKE 'dev-tree:%'
         AND status IN ('dormant','starting','active','settling')
       RETURNING event_id::text,combat_entity_id`
    );
    for (const row of cleared.rows) {
      const runtime = this.activeByEntityId.get(row.combat_entity_id);
      if (runtime) this.clearRuntime(runtime);
      else this.releaseEventLease(row.event_id);
      this.bossEncounters?.cancel(row.event_id, "developer-clear");
      this.despawnCombatEntity(row.combat_entity_id);
    }
  }

  async start(playerId: string, entityId: string): Promise<Readonly<{
    eventId: string;
    entityId: string;
    leaderPlayerId: string;
    participantIds: string[];
    partyId: string | null;
    partyRevision: number | null;
    anchor: LatLon;
    regionCode: string;
    zoneId: string;
  }>> {
    const party = this.parties.partyForPlayer(playerId);
    if (party && party.leaderPlayerId !== playerId) {
      throw new XoralEventError(
        "XORAL_PARTY_LEADER_REQUIRED",
        "Only the party leader may start The Xoral"
      );
    }
    const participantIds = party ? [...party.memberPlayerIds] : [playerId];
    if (!participantIds.includes(playerId) || participantIds.length < 1 || participantIds.length > 5) {
      throw new XoralEventError("XORAL_PARTY_INVALID", "The event party is invalid");
    }
    const partyId = party?.partyId ?? null;
    const partyRevision = party?.revision ?? null;
    const leaseId = `xoral-start:${randomUUID()}`;
    if (!this.participantLeases.acquire(leaseId, participantIds)) {
      throw new XoralEventError(
        "XORAL_PARTICIPANT_BUSY",
        "A participant is already committed to another overworld boss event or party roster change"
      );
    }

    let client: pg.PoolClient | null = null;
    let commitAttempted = false;
    let row: XoralEventRow | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      const selected = await client.query<XoralEventRow>(
        `SELECT event_id::text,source_tree_entity_id,population_zone_id,
                population_generation_id::text,owner_player_id,combat_entity_id,
                region_code,zone_id,lat,lon,appearance_variant,status,locked_party_id,
                locked_participant_ids,excluded_participant_ids,defeat_candidate
         FROM xoral_events WHERE combat_entity_id=$1 FOR UPDATE`,
        [entityId]
      );
      row = selected.rows[0]!;
      if (!row || row.status !== "dormant") {
        throw new XoralEventError("XORAL_NOT_DORMANT", "The Xoral event is no longer available");
      }
      const player = this.gameState.getPlayer(playerId);
      if (
        !player
        || !this.gameState.isWorldPresent(playerId)
        || player.regionCode !== row.region_code
        || distanceMeters(player.position, positionOf(row)) > XORAL_ANCHOR_RADIUS_M
      ) {
        throw new XoralEventError(
          "XORAL_START_LOCATION_INVALID",
          "Move within The Xoral arena before starting the event"
        );
      }
      const updated = await client.query<XoralEventRow>(
        `UPDATE xoral_events
         SET status='starting',locked_party_id=$2,owner_player_id=$4,
             locked_participant_ids=$3::jsonb,excluded_participant_ids='[]'::jsonb
         WHERE event_id=$1 AND status='dormant'
         RETURNING event_id::text,source_tree_entity_id,population_zone_id,
           population_generation_id::text,owner_player_id,combat_entity_id,
           region_code,zone_id,lat,lon,appearance_variant,status,locked_party_id,
           locked_participant_ids,excluded_participant_ids,defeat_candidate`,
        [row.event_id, partyId, JSON.stringify(participantIds), playerId]
      );
      row = updated.rows[0]!;
      if (!row) throw new XoralEventError("XORAL_START_CONFLICT", "The Xoral event changed concurrently");
      this.leaseIdByEventId.set(row.event_id, leaseId);
      commitAttempted = true;
      await client.query("COMMIT");
    } catch (error) {
      let rollbackError: unknown = null;
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (caught) {
          rollbackError = caught;
        }
      }
      if (!commitAttempted) {
        this.participantLeases.release(leaseId);
        if (row && this.leaseIdByEventId.get(row.event_id) === leaseId) {
          this.leaseIdByEventId.delete(row.event_id);
        }
      }
      throw rollbackError ?? error;
    } finally {
      client?.release();
    }

    if (!row) throw new XoralEventError("XORAL_START_CONFLICT", "The Xoral event did not start");
    const start = {
      eventId: row.event_id,
      entityId,
      leaderPlayerId: playerId,
      participantIds,
      partyId,
      partyRevision,
      anchor: positionOf(row),
      regionCode: row.region_code,
      zoneId: row.zone_id
    };
    if (!this.isStartingPartyCurrent(start)) {
      await this.resetStartingEvent(row.event_id, participantIds);
      throw new XoralEventError(
        "XORAL_PARTY_CHANGED",
        "The party changed while The Xoral event was starting. Try again."
      );
    }
    return start;
  }

  isStartingPartyCurrent(start: Readonly<{
    leaderPlayerId: string;
    participantIds: readonly string[];
    partyId: string | null;
    partyRevision: number | null;
  }>): boolean {
    const party = this.parties.partyForPlayer(start.leaderPlayerId);
    if (start.partyId === null) return party === null && start.participantIds.length === 1
      && start.participantIds[0] === start.leaderPlayerId;
    if (
      !party
      || party.partyId !== start.partyId
      || party.leaderPlayerId !== start.leaderPlayerId
      || party.revision !== start.partyRevision
      || party.memberPlayerIds.length !== start.participantIds.length
    ) return false;
    const expected = new Set(start.participantIds);
    return party.memberPlayerIds.every((participantId) => expected.has(participantId));
  }

  async activateStartedEvent(eventId: string): Promise<void> {
    const activated = await this.pool.query<XoralEventRow>(
      `UPDATE xoral_events SET status='active',activated_at=now()
       WHERE event_id=$1 AND status='starting'
       RETURNING event_id::text,source_tree_entity_id,population_zone_id,
         population_generation_id::text,owner_player_id,combat_entity_id,
         region_code,zone_id,lat,lon,appearance_variant,status,locked_party_id,
         locked_participant_ids,excluded_participant_ids,defeat_candidate`,
      [eventId]
    );
    const row = activated.rows[0];
    if (!row) throw new XoralEventError("XORAL_START_CONFLICT", "The Xoral event changed while loading");
    this.combat.setBossEventState(row.combat_entity_id, "active");
    this.bossEncounters?.encounter(row.event_id)?.activate();
    this.installActiveRuntime(row);
  }

  async resetStartingEvent(
    eventId: string,
    participantIds: readonly string[]
  ): Promise<boolean> {
    void participantIds;
    const reset = await this.pool.query<{ combat_entity_id: string }>(
      `UPDATE xoral_events
       SET status='dormant',locked_party_id=NULL,
           locked_participant_ids='[]'::jsonb,
           excluded_participant_ids='[]'::jsonb,
           activated_at=NULL,settled_at=NULL
       WHERE event_id=$1 AND status='starting'
       RETURNING combat_entity_id`,
      [eventId]
    );
    const entityId = reset.rows[0]?.combat_entity_id;
    if (entityId) this.combat.setBossEventState(entityId, "dormant");
    if (entityId) {
      const encounter = this.bossEncounters?.encounterForEntity(entityId);
      if (encounter) {
        encounter.cancelAllCasts("starting-reset");
        encounter.dormanize();
      }
    }
    if (reset.rowCount !== 0) this.releaseEventLease(eventId);
    return reset.rowCount !== 0;
  }

  isXoral(entityId: string): boolean {
    return entityId.startsWith("xoral:");
  }

  ownsEntity(entityId: string): boolean {
    return this.isXoral(entityId);
  }

  ownsDefeatCandidate(candidate: CombatDefeatSettlementCandidate): boolean {
    return candidate.bossOwnership?.hostKind === "overworld" &&
      candidate.bossOwnership.encounterHandlerId === this.handlerId &&
      candidate.bossOwnership.bossId === "xoral";
  }

  isSharedCombat(entityId: string): boolean {
    return this.activeByEntityId.has(entityId);
  }

  canPlayerAttack(playerId: string, entityId: string): boolean {
    if (!this.isXoral(entityId)) return true;
    const runtime = this.activeByEntityId.get(entityId);
    if (!runtime) return false;
    return runtime.participantIds.includes(playerId) && !runtime.excludedIds.has(playerId);
  }

  canMobAttack(entityId: string, playerId: string): boolean {
    const runtime = this.activeByEntityId.get(entityId);
    return Boolean(
      runtime && runtime.participantIds.includes(playerId) && !runtime.excludedIds.has(playerId)
    );
  }

  hasActiveEvent(playerId: string): boolean {
    return this.eventIdByParticipant.has(playerId);
  }

  blocksPartyGrowth(playerId: string): boolean {
    return this.participantLeases.isReserved(playerId);
  }

  canMobContinueIntent(entityId: string, playerId: string): boolean {
    return this.canMobAttack(entityId, playerId);
  }

  async sendAvailableDrops(playerId: string): Promise<void> {
    this.registry.send(playerId, {
      type: "XORAL_RING_DROPS_SNAPSHOT",
      drops: await this.availableDrops(playerId)
    });
  }

  async pickupRingDrop(playerId: string, dropId: string, requestId: string): Promise<void> {
    const player = this.gameState.getPlayer(playerId);
    if (!player || !this.gameState.isWorldPresent(playerId)) {
      throw new XoralEventError("XORAL_DROP_LOCATION_INVALID", "Return to the world to pick up this ring");
    }
    const client = await this.pool.connect();
    let equipmentSnapshot: Awaited<ReturnType<EquipmentService["snapshotInTransaction"]>> | null = null;
    try {
      await client.query("BEGIN");
      const selected = await client.query<XoralRingDropRow>(
        `SELECT drop_id::text,event_id::text,owner_player_id,ring_definition_id,
                region_code,zone_id,lat,lon,status,created_at
         FROM xoral_ring_drops WHERE drop_id=$1 FOR UPDATE`,
        [dropId]
      );
      const drop = selected.rows[0];
      if (!drop || drop.owner_player_id !== playerId || drop.status !== "available") {
        throw new XoralEventError("XORAL_DROP_UNAVAILABLE", "That Xoral ring is no longer available to you");
      }
      if (
        drop.region_code !== player.regionCode ||
        distanceMeters(player.position, { lat: Number(drop.lat), lon: Number(drop.lon) }) >
          DROPPED_ITEM_PICKUP_RADIUS_M
      ) {
        throw new XoralEventError("XORAL_DROP_OUT_OF_RANGE", "Move within 20m of the ring to pick it up");
      }
      const equipment = await this.equipment.grantPackageInstancesInTransaction(client, {
        operationKey: `xoral-drop:${drop.drop_id}:pickup`,
        playerId,
        grants: [{ definitionId: drop.ring_definition_id, quantity: 1 }]
      });
      if ((equipment.grants[0]?.grantedQuantity ?? 0) !== 1) {
        throw new XoralEventError("XORAL_INVENTORY_FULL", "Make room in your equipment inventory first");
      }
      const updated = await client.query(
        `UPDATE xoral_ring_drops SET status='picked_up',picked_up_at=now()
         WHERE drop_id=$1 AND status='available'`,
        [dropId]
      );
      if (updated.rowCount !== 1) {
        throw new XoralEventError("XORAL_DROP_UNAVAILABLE", "That Xoral ring is no longer available");
      }
      equipmentSnapshot = equipment.equipment;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    this.equipment.installAuthoritativeSnapshot(playerId, equipmentSnapshot!);
    this.registry.send(playerId, {
      type: "XORAL_RING_DROP_PICKED_UP",
      requestId,
      dropId,
      equipment: equipmentSnapshot!
    });
    await this.sendAvailableDrops(playerId);
  }

  private async availableDrops(playerId: string): Promise<XoralRingDropSnapshot[]> {
    const result = await this.pool.query<XoralRingDropRow>(
      `SELECT drop_id::text,event_id::text,owner_player_id,ring_definition_id,
              region_code,zone_id,lat,lon,status,created_at
       FROM xoral_ring_drops
       WHERE owner_player_id=$1 AND status='available'
       ORDER BY created_at`,
      [playerId]
    );
    return result.rows.map((row) => ({
      dropId: row.drop_id,
      eventId: row.event_id,
      ringDefinitionId: row.ring_definition_id,
      regionCode: row.region_code,
      zoneId: row.zone_id,
      lat: Number(row.lat),
      lon: Number(row.lon),
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  exitRole(playerId: string): "leader" | "follower" | null {
    const eventId = this.eventIdByParticipant.get(playerId);
    if (!eventId) return null;
    const runtime = [...this.activeByEntityId.values()]
      .find((entry) => entry.eventId === eventId);
    if (!runtime || runtime.excludedIds.has(playerId)) return null;
    return runtime.ownerPlayerId === playerId ? "leader" : "follower";
  }

  async confirmExit(playerId: string): Promise<Readonly<{
    eventId: string;
    role: "leader" | "follower";
  }>> {
    const eventId = this.eventIdByParticipant.get(playerId);
    const runtime = eventId
      ? [...this.activeByEntityId.values()].find((entry) => entry.eventId === eventId)
      : null;
    if (!runtime || runtime.excludedIds.has(playerId)) {
      throw new XoralEventError("XORAL_EVENT_NOT_ACTIVE", "You are not in an active Xoral event");
    }
    if (runtime.ownerPlayerId === playerId) {
      const cancelled = await this.cancelForLeader(
        playerId,
        "The party leader ended The Xoral event by confirming travel."
      );
      if (!cancelled) {
        throw new XoralEventError(
          "XORAL_EVENT_NOT_ACTIVE",
          "The Xoral event is no longer active"
        );
      }
      return { eventId: runtime.eventId, role: "leader" };
    }
    await this.excludeParticipant(runtime, playerId);
    return { eventId: runtime.eventId, role: "follower" };
  }

  async acceptDefeat(candidate: CombatDefeatSettlementCandidate): Promise<boolean> {
    if (!this.ownsDefeatCandidate(candidate)) return false;
    const transitioned = await this.pool.query<XoralEventRow>(
      `UPDATE xoral_events SET status='settling',defeat_candidate=$2::jsonb
       WHERE combat_entity_id=$1 AND status='active'
       RETURNING event_id::text,source_tree_entity_id,population_zone_id,
         population_generation_id::text,owner_player_id,combat_entity_id,
         region_code,zone_id,lat,lon,appearance_variant,status,locked_party_id,
         locked_participant_ids,excluded_participant_ids,defeat_candidate`,
      [candidate.defeatedEntityId, JSON.stringify(candidate)]
    );
    const resumed = transitioned.rows[0]
      ? null
      : await this.pool.query<XoralEventRow>(
          `SELECT event_id::text,source_tree_entity_id,population_zone_id,
                  population_generation_id::text,owner_player_id,combat_entity_id,
                  region_code,zone_id,lat,lon,appearance_variant,status,locked_party_id,
                  locked_participant_ids,excluded_participant_ids,defeat_candidate
           FROM xoral_events
           WHERE combat_entity_id=$1 AND status IN ('settling','defeated')`,
          [candidate.defeatedEntityId]
        );
    const row = transitioned.rows[0] ?? resumed?.rows[0];
    if (!row) throw new Error("Active Xoral event does not exist for defeat");
    await this.finishSettlement(row);
    this.bossEncounters?.encounter(row.event_id)?.defeat();
    return true;
  }

  async cancelForLeader(playerId: string, reason: string): Promise<boolean> {
    const runtime = [...this.activeByEntityId.values()]
      .find((entry) => entry.ownerPlayerId === playerId);
    if (!runtime) return false;
    const cancelled = await this.pool.query(
      `UPDATE xoral_events SET status='cancelled',settled_at=now()
       WHERE event_id=$1 AND status='active'`,
      [runtime.eventId]
    );
    if (cancelled.rowCount !== 1) return false;
    this.bossEncounters?.cancel(runtime.eventId, "leader-cancel");
    this.despawnCombatEntity(runtime.entityId);
    this.clearRuntime(runtime);
    for (const participantId of runtime.participantIds) {
      this.registry.send(participantId, {
        type: "XORAL_EVENT_CANCELLED",
        eventId: runtime.eventId,
        reason
      });
    }
    return true;
  }

  private spawnCombatProjection(row: XoralEventRow, appearanceVariant?: "normal" | "ashen"): void {
    const existing = this.combat.entity(row.combat_entity_id);
    const resolvedAppearance = appearanceVariant ?? row.appearance_variant ??
      existing?.appearanceVariant ?? undefined;
    if (!existing) {
      this.combat.spawnMob({
        entityId: row.combat_entity_id,
        archetype: "xoral",
        ...(resolvedAppearance ? { appearanceVariant: resolvedAppearance } : {}),
        position: positionOf(row),
        homePosition: positionOf(row),
        regionCode: row.region_code,
        zoneId: row.zone_id,
        worldAi: false,
        bossEventState: row.status === "dormant" ? "dormant" : "active",
        bossOwnership: {
          bossId: "xoral",
          bossRevision: 1,
          encounterHandlerId: this.handlerId,
          hostKind: "overworld",
          hostInstanceId: row.event_id,
          encounterInstanceId: row.event_id,
          appearanceId: "xoral",
          ...(resolvedAppearance ? { appearanceVariant: resolvedAppearance } : {}),
          lifeGeneration: 0
        }
      });
    }
    this.ensureBossEncounter(row, resolvedAppearance);
  }

  private ensureBossEncounter(
    row: XoralEventRow,
    appearanceVariant?: "normal" | "ashen"
  ): void {
    if (!this.bossEncounters || this.bossEncounters.encounter(row.event_id)) return;
    const host = new OverworldBossHostAdapter({
      hostInstanceId: row.event_id,
      encounterInstanceId: row.event_id,
      encounterHandlerId: this.handlerId,
      participationPolicyId: "xoral-locked-roster",
      participantIds: stringArray(row.locked_participant_ids)
    });
    this.bossEncounters.create({
      encounterId: row.event_id,
      definitionId: "xoral",
      host,
      mobEntityId: row.combat_entity_id,
      initialState: row.status === "active" ? "active" : "dormant",
      ...(appearanceVariant ? { initialAppearanceVariant: appearanceVariant } : {})
    });
  }

  private installActiveRuntime(row: XoralEventRow): void {
    const participantIds = stringArray(row.locked_participant_ids);
    const leaseId = this.ensureEventLease(row);
    const runtime: ActiveRuntime = {
      eventId: row.event_id,
      entityId: row.combat_entity_id,
      ownerPlayerId: row.owner_player_id,
      participantIds,
      excludedIds: new Set(stringArray(row.excluded_participant_ids)),
      anchor: positionOf(row),
      nextTargetAt: Date.now(),
      nextRootAt: Date.now() + XORAL_ROOT_INTERVAL_MS,
      forcedFocusPlayerId: null,
      forcedFocusUntil: 0,
      rootGeneration: 0,
      leaseId
    };
    this.activeByEntityId.set(runtime.entityId, runtime);
    for (const playerId of participantIds) {
      if (!runtime.excludedIds.has(playerId)) {
        this.eventIdByParticipant.set(playerId, runtime.eventId);
      }
    }
  }

  private tick(): void {
    const now = Date.now();
    if (now >= this.nextDormantCleanupAt && !this.dormantCleanupPending) {
      this.nextDormantCleanupAt = now + 30_000;
      this.dormantCleanupPending = true;
      void this.cleanupExpiredDormantEvents()
        .catch((error: unknown) => this.logger.warn({ err: error }, "failed to clean expired dormant Xoral events"))
        .finally(() => { this.dormantCleanupPending = false; });
    }
    for (const runtime of this.activeByEntityId.values()) {
      this.reconcileDepartures(runtime);
      const candidates = runtime.participantIds.filter((playerId) =>
        !runtime.excludedIds.has(playerId) &&
        this.gameState.isWorldPresent(playerId) &&
        this.combat.isPlayerAlive(playerId)
      );
      if (candidates.length === 0) continue;
      if (runtime.forcedFocusPlayerId && now < runtime.forcedFocusUntil) {
        if (candidates.includes(runtime.forcedFocusPlayerId)) continue;
        runtime.forcedFocusPlayerId = null;
      }
      if (now >= runtime.nextRootAt) {
        const rooted = randomEntry(candidates, this.random);
        if (rooted) {
          const applied = this.combat.applyScriptedRoot(
            runtime.entityId,
            rooted,
            XORAL_ROOT_DURATION_MS
          );
          if (applied) {
            this.gameState.setMovementBlocked(rooted, true, `xoral-root:${runtime.eventId}`);
            const rootGeneration = ++runtime.rootGeneration;
            setTimeout(() => {
              if (
                this.activeByEntityId.get(runtime.entityId) !== runtime ||
                runtime.rootGeneration !== rootGeneration
              ) return;
              this.gameState.setMovementBlocked(rooted, false, `xoral-root:${runtime.eventId}`);
            }, XORAL_ROOT_DURATION_MS).unref?.();
            runtime.forcedFocusPlayerId = rooted;
            runtime.forcedFocusUntil = now + XORAL_ROOT_FOCUS_MS;
          }
          this.combat.directMobTarget(runtime.entityId, rooted);
        }
        runtime.nextRootAt = now + XORAL_ROOT_INTERVAL_MS;
        runtime.nextTargetAt = now + XORAL_TARGET_CHANGE_MS;
      } else if (now >= runtime.nextTargetAt) {
        const target = randomEntry(candidates, this.random);
        if (target) this.combat.directMobTarget(runtime.entityId, target);
        runtime.nextTargetAt = now + XORAL_TARGET_CHANGE_MS;
      }
    }
  }

  private async cleanupExpiredDormantEvents(): Promise<void> {
    const expired = await this.pool.query<{ combat_entity_id: string }>(
      `UPDATE xoral_events AS event
       SET status='cancelled',settled_at=now()
       FROM population_zone_generations_v2 AS generation
       WHERE event.population_generation_id=generation.generation_id
         AND event.status='dormant'
         AND generation.is_current=false
       RETURNING event.combat_entity_id`
    );
    for (const row of expired.rows) {
      const encounter = this.bossEncounters?.encounterForEntity(row.combat_entity_id);
      if (encounter) this.bossEncounters?.despawn(encounter.encounterId, "expired-dormant");
      this.despawnCombatEntity(row.combat_entity_id);
    }
  }

  private reconcileDepartures(runtime: ActiveRuntime): void {
    for (const playerId of runtime.participantIds) {
      if (runtime.excludedIds.has(playerId)) continue;
      const player = this.gameState.getPlayer(playerId);
      if (!player || !this.gameState.isWorldPresent(playerId)) continue;
      const anchor = this.gameState.getAuthoritativeTravelAnchor(playerId)?.center;
      if (!anchor || metersBetween(anchor, runtime.anchor) > 2) {
        if (playerId === runtime.ownerPlayerId) {
          void this.cancelForLeader(playerId, "The party leader left The Xoral anchor.")
            .catch((error: unknown) => this.logger.warn({ err: error }, "failed to cancel departed Xoral event"));
          return;
        }
        void this.excludeParticipant(runtime, playerId)
          .catch((error: unknown) => this.logger.warn({ err: error }, "failed to persist Xoral departure"));
      }
    }
  }

  private async excludeParticipant(runtime: ActiveRuntime, playerId: string): Promise<void> {
    if (runtime.excludedIds.has(playerId)) return;
    const excludedIds = new Set(runtime.excludedIds).add(playerId);
    const updated = await this.pool.query(
      `UPDATE xoral_events SET excluded_participant_ids=$2::jsonb
       WHERE event_id=$1 AND status='active'`,
      [runtime.eventId, JSON.stringify([...excludedIds])]
    );
    if (updated.rowCount !== 1) {
      throw new XoralEventError("XORAL_EVENT_NOT_ACTIVE", "The Xoral event is no longer active");
    }
    runtime.excludedIds.add(playerId);
    this.eventIdByParticipant.delete(playerId);
    const encounter = this.bossEncounters?.encounter(runtime.eventId);
    if (encounter?.host instanceof OverworldBossHostAdapter) {
      encounter.host.removeParticipant(playerId);
    }
    this.participantLeases.releaseParticipant(runtime.leaseId, playerId);
    this.gameState.setMovementBlocked(playerId, false, `xoral-root:${runtime.eventId}`);
  }

  private async finishSettlement(row: XoralEventRow): Promise<void> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`overworld-boss:xoral:${row.event_id}`]
      );
      const currentResult = await client.query<XoralEventRow>(
        `SELECT event_id::text,source_tree_entity_id,population_zone_id,
                population_generation_id::text,owner_player_id,combat_entity_id,
                region_code,zone_id,lat,lon,appearance_variant,status,locked_party_id,
                locked_participant_ids,excluded_participant_ids,defeat_candidate
         FROM xoral_events WHERE event_id=$1 FOR NO KEY UPDATE`,
        [row.event_id]
      );
      const current = currentResult.rows[0];
      if (!current) throw new Error("Xoral event does not exist for settlement");
      if (current.status === "defeated") {
        await client.query("COMMIT");
        committed = true;
      } else {
        if (current.status !== "settling" || !current.defeat_candidate) {
          throw new Error("Xoral event is not settling with a defeat candidate");
        }
        const locked = stringArray(current.locked_participant_ids);
        const excluded = new Set(stringArray(current.excluded_participant_ids));
        const damageByPlayer = new Map(
          current.defeat_candidate.contributions.map((entry) => [
            entry.entityId,
            Math.max(0, Math.trunc(entry.damage))
          ])
        );
        const eligible = locked.filter((playerId) =>
          !excluded.has(playerId) && (damageByPlayer.get(playerId) ?? 0) > 0
        );
        for (const playerId of eligible) {
          await this.grantReward(current, playerId, damageByPlayer.get(playerId)!);
        }
        const defeated = await client.query(
          `UPDATE xoral_events SET status='defeated',settled_at=now()
           WHERE event_id=$1 AND status='settling'`,
          [current.event_id]
        );
        if (defeated.rowCount !== 1) {
          throw new Error("Xoral settlement lost durable ownership");
        }
        await client.query("COMMIT");
        committed = true;
      }
    } finally {
      try {
        if (!committed) await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
    const runtime = this.activeByEntityId.get(row.combat_entity_id);
    if (runtime) this.clearRuntime(runtime);
    else this.releaseEventLease(row.event_id);
  }

  private async grantReward(row: XoralEventRow, playerId: string, damage: number): Promise<void> {
    const ringDefinitionId = ringFor(row.event_id, playerId);
    const client = await this.pool.connect();
    let ringDelivery: "inventory" | "ground" = "inventory";
    let walletGold = "0";
    let walletVersion = "0";
    try {
      await client.query("BEGIN");
      const walletRow = await client.query<{ account_id: string }>(
        `SELECT account_id FROM player_wallets WHERE player_id=$1 FOR SHARE`,
        [playerId]
      );
      const accountId = walletRow.rows[0]?.account_id;
      if (!accountId) throw new Error("Xoral reward player wallet does not exist");
      const wallet = await new WalletService().creditForOperationInTransaction(client, {
        playerId,
        accountId,
        amount: BigInt(XORAL_GOLD_REWARD),
        operationKey: `xoral:${row.event_id}:${playerId}:gold`,
        reason: "xoral_event_reward"
      });
      walletGold = wallet.goldBalance.toString();
      walletVersion = wallet.version.toString();
      const equipment = await this.equipment.grantPackageInstancesInTransaction(client, {
        operationKey: `xoral:${row.event_id}:${playerId}:ring`,
        playerId,
        grants: [{ definitionId: ringDefinitionId, quantity: 1 }]
      });
      if ((equipment.grants[0]?.grantedQuantity ?? 0) === 0) {
        ringDelivery = "ground";
        await client.query(
          `INSERT INTO xoral_ring_drops (
             event_id,owner_player_id,ring_definition_id,region_code,zone_id,lat,lon
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (event_id,owner_player_id) DO NOTHING`,
          [row.event_id, playerId, ringDefinitionId, row.region_code, row.zone_id, row.lat, row.lon]
        );
      }
      await client.query(
        `INSERT INTO xoral_event_rewards (
           event_id,player_id,authoritative_damage,ring_definition_id,ring_delivery,
           xp_amount,class_xp_amount
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (event_id,player_id) DO NOTHING`,
        [
          row.event_id,
          playerId,
          damage,
          ringDefinitionId,
          ringDelivery,
          XORAL_PLAYER_XP_REWARD,
          XORAL_CLASS_XP_REWARD
        ]
      );
      await recordCreatureBookKillInTransaction(client, {
        playerId,
        sourceKind: "xoral_event",
        sourceId: row.event_id,
        mobArchetype: "xoral",
        itemIds: [ringDefinitionId]
      });
      await client.query("COMMIT");
      this.equipment.installAuthoritativeSnapshot(playerId, equipment.equipment);
      this.registry.send(playerId, { type: "EQUIPMENT_SNAPSHOT", equipment: equipment.equipment });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const xpGrant = await this.progression.grantXp({
      operationKey: `xoral:${row.event_id}:${playerId}:xp`,
      playerId,
      sourceType: "combat",
      sourceId: row.event_id,
      requestedXp: XORAL_PLAYER_XP_REWARD,
      metadata: { boss: "xoral", eventId: row.event_id }
    });
    this.registry.send(playerId, { type: "XP_GRANTED", grant: xpGrant });
    this.registry.send(playerId, {
      type: "XORAL_REWARD_GRANTED",
      eventId: row.event_id,
      ringDefinitionId,
      ringDelivery,
      gold: XORAL_GOLD_REWARD,
      walletGold,
      walletVersion,
      xp: XORAL_PLAYER_XP_REWARD,
      classXp: XORAL_CLASS_XP_REWARD
    });
    await this.sendAvailableDrops(playerId);
  }

  private clearRuntime(runtime: ActiveRuntime): void {
    runtime.rootGeneration += 1;
    this.activeByEntityId.delete(runtime.entityId);
    for (const playerId of runtime.participantIds) {
      if (this.eventIdByParticipant.get(playerId) === runtime.eventId) {
        this.eventIdByParticipant.delete(playerId);
      }
      this.gameState.setMovementBlocked(playerId, false, `xoral-root:${runtime.eventId}`);
    }
    this.participantLeases.release(runtime.leaseId);
    if (this.leaseIdByEventId.get(runtime.eventId) === runtime.leaseId) {
      this.leaseIdByEventId.delete(runtime.eventId);
    }
  }

  private despawnCombatEntity(entityId: string): void {
    const despawn = (this.combat as unknown as {
      despawnMob?: (id: string) => unknown;
    }).despawnMob;
    if (typeof despawn === "function") despawn.call(this.combat, entityId);
  }

  private ensureEventLease(row: XoralEventRow): string {
    const existing = this.leaseIdByEventId.get(row.event_id);
    if (existing) return existing;
    const excluded = new Set(stringArray(row.excluded_participant_ids));
    const participantIds = stringArray(row.locked_participant_ids)
      .filter((playerId) => !excluded.has(playerId));
    const leaseId = `xoral-recovery:${row.event_id}:${randomUUID()}`;
    if (!this.participantLeases.acquire(leaseId, participantIds)) {
      throw new XoralEventError(
        "XORAL_PARTICIPANT_BUSY",
        `Recovered Xoral event ${row.event_id} conflicts with another overworld boss roster`
      );
    }
    this.leaseIdByEventId.set(row.event_id, leaseId);
    return leaseId;
  }

  private releaseEventLease(eventId: string): void {
    const leaseId = this.leaseIdByEventId.get(eventId);
    if (!leaseId) return;
    this.participantLeases.release(leaseId);
    this.leaseIdByEventId.delete(eventId);
  }
}

function positionOf(row: Pick<XoralEventRow, "lat" | "lon">): LatLon {
  return { lat: Number(row.lat), lon: Number(row.lon) };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function randomEntry<T>(values: readonly T[], random: () => number): T | null {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))] ?? null;
}

/** The stock rings are retired: Xoral now pays a Plain ring whose bonus rolls on grant. */
function ringFor(_eventId: string, _playerId: string): XoralRingId {
  return "ring_plain";
}

function metersBetween(left: LatLon, right: LatLon): number {
  const radians = Math.PI / 180;
  const lat1 = left.lat * radians;
  const lat2 = right.lat * radians;
  const deltaLat = (right.lat - left.lat) * radians;
  const deltaLon = (right.lon - left.lon) * radians;
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
