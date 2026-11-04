import {
  dungeonResourceIdFromNodeId,
  dungeonResourceMineNodeType,
  isDungeonResourceNodeId,
  dungeonLocalToCombatPosition,
  type ClientMessage,
  type RepeatableResourceNode,
  type ServerMessage
} from "@ash-atlas/shared";

import type { CombatEngine } from "../../game/combat/combatEngine.js";
import type { DungeonResourceHarvestService } from "../../game/dungeonResourceHarvest.js";
import type { CisternWarrensRuntime } from "../../game/dungeon.js";
import type { EquipmentService } from "../../game/equipment.js";
import { wornUtilityGlove } from "../../game/utilityGear.js";
import { HarvestSessionError } from "../../game/harvestSessions.js";
import { RepeatableResourceError } from "../../game/repeatableResources.js";
import type { ConnectionRegistry } from "../connectionRegistry.js";

type HarvestMessage = Extract<
  ClientMessage,
  { type: "START_HARVEST" | "COMPLETE_HARVEST" | "CANCEL_HARVEST" }
>;

export type DungeonHarvestFlowContext = Readonly<{
  playerId(): string | null;
  registry: ConnectionRegistry;
  service: DungeonResourceHarvestService | undefined;
  dungeon: CisternWarrensRuntime | undefined;
  combat: CombatEngine | undefined;
  equipment: EquipmentService | undefined;
  send(message: ServerMessage): void;
  broadcastDroppedItems(positions: readonly Readonly<{ lat: number; lon: number }>[]): Promise<void>;
  warn(error: unknown, step: string): void;
}>;

/**
 * START/COMPLETE/CANCEL_HARVEST for dungeon resource nodes. The frames and
 * error codes are the overworld ones, so the client runs its one harvest flow;
 * only the node's home differs (the player's dungeon instance and run).
 * Each method returns true when it handled the message.
 */
export function createDungeonHarvestFlow(context: DungeonHarvestFlowContext) {
  const { service, dungeon, combat, equipment, registry, send } = context;

  const reject = (requestId: string, error: unknown, nodeId?: string): void => {
    const known = error instanceof RepeatableResourceError || error instanceof HarvestSessionError;
    send({
      type: "ERROR",
      requestId,
      code: known ? error.code : "HARVEST_INTERNAL_FAILURE",
      message: known ? error.message : "Gathering could not be completed.",
      details: {
        ...(nodeId ? { nodeId } : {}),
        ...(error instanceof RepeatableResourceError && error.details.reconciliation
          ? { reconciliation: error.details.reconciliation }
          : {}),
        ...(error instanceof RepeatableResourceError && error.retryAfterMs !== undefined
          ? { retryAfterMs: error.retryAfterMs }
          : {})
      }
    });
    if (!known) context.warn(error, "dungeon harvest failure");
    // Re-sync the room so a stale node state is corrected.
    const playerId = context.playerId();
    const snapshot = playerId ? dungeon?.get(playerId) : null;
    if (snapshot && playerId) registry.send(playerId, { type: "DUNGEON_SNAPSHOT", snapshot });
  };

  return {
    async start(message: HarvestMessage & { type: "START_HARVEST" }): Promise<boolean> {
      const playerId = context.playerId();
      if (!service || !playerId || !isDungeonResourceNodeId(message.nodeId)) return false;
      try {
        if (!dungeon?.isInside(playerId)) {
          throw new RepeatableResourceError("HARVEST_NODE_NOT_FOUND", "Resource not found.", undefined, {
            nodeId: message.nodeId,
            reconciliation: "remove-node"
          });
        }
        if (combat && !combat.isPlayerAlive(playerId)) {
          throw new RepeatableResourceError("HARVEST_PLAYER_UNAVAILABLE", "Unable to gather while defeated");
        }
        const derived = equipment?.runtimeSnapshot(playerId)?.derivedStats;
        const result = await service.start(playerId, message.nodeId, {
          ...(derived ? {
            actionDurationMultiplier: derived.actionDurationMultiplier,
            miningDurationMultiplier: derived.miningDurationMultiplier,
            choppingDurationMultiplier: derived.choppingDurationMultiplier,
            choppingRingSeconds: derived.ringBonuses?.fleet_chopper ?? 0,
            miningRingSeconds: derived.ringBonuses?.fleet_miner ?? 0
          } : {}),
          utilityGlove: wornUtilityGlove(equipment?.runtimeSnapshot(playerId))
        });
        send({
          type: "HARVEST_STARTED",
          requestId: message.requestId,
          session: result.session,
          serverTime: Date.now()
        });
      } catch (error) {
        reject(message.requestId, error, message.nodeId);
      }
      return true;
    },

    async complete(message: HarvestMessage & { type: "COMPLETE_HARVEST" }): Promise<boolean> {
      const playerId = context.playerId();
      if (!service || !playerId || !service.hasSession(message.sessionId)) return false;
      try {
        if (combat && !combat.isPlayerAlive(playerId)) {
          throw new RepeatableResourceError("HARVEST_PLAYER_UNAVAILABLE", "Unable to finish gathering while defeated");
        }
        const result = await service.complete(playerId, message.sessionId);
        const mineNodeType = dungeonResourceMineNodeType(result.resourceType);
        if (mineNodeType) {
          const resourceId = dungeonResourceIdFromNodeId(result.nodeId);
          const resource = result.snapshot?.resources?.find((candidate) => candidate.id === resourceId);
          const position = resource
            ? dungeonLocalToCombatPosition(resource.x, resource.y)
            : result.position;
          const node: RepeatableResourceNode = {
            id: result.nodeId,
            nodeType: mineNodeType,
            lat: position.lat,
            lon: position.lon,
            yieldItemId: result.resourceType,
            yieldQuantity: resource?.quantity ?? result.rewardQuantity,
            state: resource?.state === "available" ? "ready" : "depleted",
            authorityRevision: 0,
            readyAt: resource?.availableAt ? new Date(resource.availableAt).toISOString() : null,
            timerVisibility: resource && resource.state !== "available" && resource.availableAt === null
              ? "redacted"
              : "visible"
          };
          send({
            type: "REPEATABLE_RESOURCE_HARVESTED",
            requestId: message.requestId,
            node,
            playerId,
            inventory: result.inventory,
            replayed: result.replayed,
            professionResults: result.professionResults,
            tollGold: "0",
            walletGold: null,
            walletRevision: null,
            serverTime: Date.now()
          });
        } else {
          send({
            type: "HARVEST_COMPLETED",
            requestId: message.requestId,
            session: result.session,
            nodeId: result.nodeId,
            playerId,
            inventory: result.inventory,
            nodeRemoved: true,
            replayed: result.replayed,
            professionResults: result.professionResults,
            serverTime: Date.now()
          });
        }
        // After the completion frame, so the client settles its gather before the node leaves the room view.
        if (result.snapshot) registry.send(playerId, { type: "DUNGEON_SNAPSHOT", snapshot: result.snapshot });
        if (result.masteryGrant) {
          registry.send(playerId, { type: "MASTERY_SNAPSHOT", masteries: result.masteryGrant.snapshot });
        }
        if (!result.replayed) {
          registry.send(playerId, {
            type: "RESOURCE_GAINED",
            playerId,
            gain: {
              eventId: `harvest:${result.session.sessionId}`,
              itemId: result.resourceType,
              quantity: result.rewardQuantity
            },
            serverTime: Date.now()
          });
        }
        if (result.droppedItems.length > 0) {
          try {
            await context.broadcastDroppedItems(result.droppedItems.map(({ lat, lon }) => ({ lat, lon })));
          } catch (error) {
            context.warn(error, "dungeon harvest overflow publication");
          }
        }
      } catch (error) {
        reject(message.requestId, error);
      }
      return true;
    },

    cancel(message: HarvestMessage & { type: "CANCEL_HARVEST" }): boolean {
      const playerId = context.playerId();
      if (!service || !playerId || !service.hasSession(message.sessionId)) return false;
      try {
        const result = service.cancel(playerId, message.sessionId);
        send({
          type: "HARVEST_CANCELLED",
          requestId: message.requestId,
          session: result.session,
          serverTime: Date.now()
        });
      } catch (error) {
        send({
          type: "ERROR",
          requestId: message.requestId,
          code: error instanceof HarvestSessionError ? error.code : "HARVEST_CANCEL_REJECTED",
          message: error instanceof HarvestSessionError ? error.message : "harvest cancellation rejected"
        });
      }
      return true;
    }
  };
}
