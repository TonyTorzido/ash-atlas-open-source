import {
  HOLLIN_HELPER_BERRY_INTERVAL_MS,
  HOLLIN_HELPER_BERRY_ITEM,
  HOLLIN_HELPER_FOLLOW_DISTANCE_M,
  HOLLIN_HELPER_FORAGE_INTERVAL_MS,
  HOLLIN_HELPER_MIN_RANK,
  HOLLIN_HELPER_PICKUP_RADIUS_M,
  bearingDegrees,
  destinationPoint,
  distanceMeters,
  hollinHelperEntityId,
  type DroppedItemSnapshot,
  type LatLon,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";

import type pg from "pg";

import type { CombatEngine } from "./combat/combatEngine.js";
import type { DroppedItemService } from "./droppedItems.js";
import type { InventoryService } from "./inventory.js";
import type { PlayerRecord } from "./state.js";
import { zoneIdForPosition } from "./spatialZones.js";

type HelperCombat = Pick<CombatEngine, "spawnMob" | "despawnMob" | "entity" | "relocateMob">;

export type HollinForageEvent = Readonly<{
  playerId: string;
  kind: "pickup" | "berry";
  itemId: string;
  quantity: number;
  inventory: PlayerInventorySnapshot;
}>;

export type HollinHelperDeps = Readonly<{
  combat: HelperCombat;
  ranks: Readonly<{ ensureLoaded(playerId: string): Promise<void>; rankOf(playerId: string, skillId: "wildkin_lore"): number }>;
  players: Readonly<{ onlineWorldPlayers(): readonly Pick<PlayerRecord, "playerId" | "position" | "regionCode">[] }>;
  droppedItems: Pick<DroppedItemService, "listActive" | "pickupDroppedItem">;
  inventory: Pick<InventoryService, "grantItemsForOperationInTransaction">;
  transaction: <T>(work: (client: pg.PoolClient) => Promise<T>) => Promise<T>;
  playerSpeedMps: number;
  onForaged(event: HollinForageEvent): void;
  now?: () => number;
  logger?: Readonly<{ warn(context: object, message: string): void }>;
}>;

type Helper = { entityId: string; nextForageAt: number; lastBerryAt: number; busy: boolean };

/**
 * Hollin Lore rank 3: a small Hollin follows its owner. Every so often it picks up one of the
 * owner's own dropped items lying nearby, or, at most once per ten minutes, gathers a berry.
 */
export class HollinHelperService {
  private readonly helpers = new Map<string, Helper>();
  private lastTickAt: number;
  private readonly now: () => number;

  constructor(private readonly deps: HollinHelperDeps) {
    this.now = deps.now ?? Date.now;
    this.lastTickAt = this.now();
  }

  hasHelper(playerId: string): boolean {
    return this.helpers.has(playerId);
  }

  async tick(): Promise<void> {
    const now = this.now();
    const elapsedS = Math.min(2, Math.max(0, now - this.lastTickAt) / 1_000);
    this.lastTickAt = now;
    const online = new Map(this.deps.players.onlineWorldPlayers().map((player) => [player.playerId, player]));
    for (const ownerId of [...this.helpers.keys()]) {
      if (!online.has(ownerId)) this.dismiss(ownerId);
    }
    for (const player of online.values()) {
      await this.deps.ranks.ensureLoaded(player.playerId);
      const eligible = this.deps.ranks.rankOf(player.playerId, "wildkin_lore") >= HOLLIN_HELPER_MIN_RANK;
      if (!eligible) {
        this.dismiss(player.playerId);
        continue;
      }
      const helper = this.helpers.get(player.playerId) ?? this.summon(player, now);
      this.follow(helper, player.position, elapsedS);
      if (now >= helper.nextForageAt && !helper.busy) {
        helper.nextForageAt = now + HOLLIN_HELPER_FORAGE_INTERVAL_MS;
        helper.busy = true;
        void this.forage(player, helper, now)
          .catch((error: unknown) => this.deps.logger?.warn({ err: error, playerId: player.playerId }, "Hollin helper forage failed"))
          .finally(() => { helper.busy = false; });
      }
    }
  }

  dismiss(playerId: string): void {
    const helper = this.helpers.get(playerId);
    if (!helper) return;
    this.deps.combat.despawnMob(helper.entityId);
    this.helpers.delete(playerId);
  }

  private summon(player: Pick<PlayerRecord, "playerId" | "position" | "regionCode">, now: number): Helper {
    const entityId = hollinHelperEntityId(player.playerId);
    const position = destinationPoint(player.position, HOLLIN_HELPER_FOLLOW_DISTANCE_M, 135);
    if (!this.deps.combat.entity(entityId)) {
      this.deps.combat.spawnMob({
        entityId, archetype: "hollin_helper", position, homePosition: position,
        regionCode: player.regionCode, zoneId: zoneIdForPosition(player.position), worldAi: true, summoned: true
      });
    }
    const helper: Helper = { entityId, nextForageAt: now + HOLLIN_HELPER_FORAGE_INTERVAL_MS, lastBerryAt: now, busy: false };
    this.helpers.set(player.playerId, helper);
    return helper;
  }

  private follow(helper: Helper, owner: LatLon, elapsedS: number): void {
    const body = this.deps.combat.entity(helper.entityId);
    if (!body) return;
    const distance = distanceMeters(body, owner);
    if (distance <= HOLLIN_HELPER_FOLLOW_DISTANCE_M) return;
    if (distance > 120) {
      this.deps.combat.relocateMob(helper.entityId, destinationPoint(owner, HOLLIN_HELPER_FOLLOW_DISTANCE_M, 135));
      return;
    }
    const step = Math.min(distance - HOLLIN_HELPER_FOLLOW_DISTANCE_M, this.deps.playerSpeedMps * 1.2 * Math.max(0.1, elapsedS));
    this.deps.combat.relocateMob(helper.entityId, destinationPoint(body, step, bearingDegrees(body, owner)));
  }

  private async forage(owner: PlayerRecord | Pick<PlayerRecord, "playerId" | "position" | "regionCode">, helper: Helper, now: number): Promise<void> {
    const bucket = Math.floor(now / HOLLIN_HELPER_FORAGE_INTERVAL_MS);
    const drops: DroppedItemSnapshot[] = await this.deps.droppedItems.listActive(owner.regionCode);
    const nearby = drops.find((drop) =>
      drop.droppedBy === owner.playerId &&
      !drop.equipmentInstanceId && !drop.backpackInstanceId && !drop.manorId &&
      distanceMeters({ lat: drop.lat, lon: drop.lon }, owner.position) <= HOLLIN_HELPER_PICKUP_RADIUS_M
    );
    if (nearby) {
      const result = await this.deps.droppedItems.pickupDroppedItem(owner as PlayerRecord, `hollin-forage-${nearby.dropId}-${bucket}`, nearby.dropId);
      this.deps.onForaged({ playerId: owner.playerId, kind: "pickup", itemId: nearby.itemId, quantity: result.pickedUpQuantity, inventory: result.inventory });
      return;
    }
    if (now - helper.lastBerryAt < HOLLIN_HELPER_BERRY_INTERVAL_MS) return;
    helper.lastBerryAt = now;
    const window = Math.floor(now / HOLLIN_HELPER_BERRY_INTERVAL_MS);
    const granted = await this.deps.transaction((client) => this.deps.inventory.grantItemsForOperationInTransaction(client, {
      operationKey: `hollin-forage:${owner.playerId}:${window}`,
      playerId: owner.playerId,
      source: "hollin_helper_forage",
      sourceEntityType: "hollin_helper",
      sourceEntityId: helper.entityId,
      metadata: { itemId: HOLLIN_HELPER_BERRY_ITEM },
      grants: [{ itemId: HOLLIN_HELPER_BERRY_ITEM, variant: null, quantity: 1 }]
    }));
    if (granted.applied) {
      this.deps.onForaged({ playerId: owner.playerId, kind: "berry", itemId: HOLLIN_HELPER_BERRY_ITEM, quantity: 1, inventory: granted.inventory });
    }
  }
}
