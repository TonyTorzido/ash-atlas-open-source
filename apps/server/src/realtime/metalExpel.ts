import { randomUUID } from "node:crypto";

import type { MetalExpelHandler } from "../game/combat/combatEngine.js";
import type { ManorPresenceService } from "../game/manor.js";
import type { GameState } from "../game/state.js";
import type { WorldRuntime } from "../game/worldRuntime.js";
import type { AppLogger } from "../logger.js";
import type { TravelRealtimeOperations } from "./travelRealtimeOperations.js";

/**
 * Host side of the Expel metal. The victim is teleported to their Manor entrance (the
 * Manor jump pipeline, with the combat and aggression travel locks skipped); with no built
 * Manor they go to their respawn point. Never inside dungeons or interiors.
 */
export function createMetalExpelHandler(deps: Readonly<{
  logger: Pick<AppLogger, "warn">;
  gameState: Pick<GameState, "isWorldPresent" | "getPlayer" | "snapshotForPlayer" | "repositionCombatPlayer">;
  worldRuntime: Pick<WorldRuntime, "hasPlayerWorldTransition"> | undefined;
  isInsideDungeon: (playerId: string) => boolean;
  manorPresence: Pick<ManorPresenceService, "status"> | undefined;
  performAuthoritativeTravel: TravelRealtimeOperations["performAuthoritativeTravel"];
  syncCombatPlayerAfterRelocation: (player: ReturnType<GameState["snapshotForPlayer"]>) => void;
}>): MetalExpelHandler {
  const { gameState, worldRuntime, logger } = deps;
  return {
    canExpel: (playerId) =>
      gameState.isWorldPresent(playerId) &&
      !deps.isInsideDungeon(playerId) &&
      worldRuntime?.hasPlayerWorldTransition(playerId) !== true,
    expel: async (playerId, lethal) => {
      const manor = await deps.manorPresence?.status(playerId).catch((error: unknown) => {
        logger.warn({ err: error, playerId }, "expel could not load the Manor entrance");
        return null;
      }) ?? null;
      const connected = gameState.getPlayer(playerId);
      if (!connected) return false;
      if (manor) {
        const center = { lat: manor.lat, lon: manor.lon };
        const result = await deps.performAuthoritativeTravel({
          playerId,
          destination: {
            kind: "manor",
            id: manor.manorId,
            center,
            travelAnchor: {
              scopeId: "world",
              layerId: `manor:${manor.manorId}`,
              center,
              relocationRevision: connected.relocationRevision ?? 0,
              layerGeneration: manor.placementRevision,
              sourceType: "manor",
              sourceId: manor.manorId
            }
          },
          requestId: `metal-expel:${randomUUID()}`,
          arrivalMode: "protected_jump",
          kind: "manor_jump",
          sendResult: false,
          skipTravelEligibility: true
        });
        if (result.success) return true;
        logger.warn({ playerId, reason: result.reason }, "expel to the Manor entrance failed; using the respawn point");
      }
      // A killing blow respawns the victim at their anchor anyway, so only a live victim needs moving.
      if (lethal) return true;
      if (!gameState.repositionCombatPlayer(playerId, connected.anchor, Number.MAX_SAFE_INTEGER)) return false;
      deps.syncCombatPlayerAfterRelocation(gameState.snapshotForPlayer(playerId));
      return true;
    }
  };
}
