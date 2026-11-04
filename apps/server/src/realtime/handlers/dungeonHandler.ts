import { DungeonError } from "../../game/dungeon.js";
import { DungeonRepeatError } from "../../game/dungeonRepeatLedger.js";
import type { CisternWarrensRuntime } from "../../game/dungeon.js";
import type { DungeonSkillService } from "../../game/dungeonSkills.js";
import type { DungeonTorchLobbyService } from "../dungeonTorchLobbyService.js";
import type { GameState } from "../../game/state.js";
import type { ConnectionRegistry } from "../connectionRegistry.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import { requireHello, type RealtimeConnectionState } from "./handlerExecutionContext.js";

export type DungeonHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId">;
  registry: ConnectionRegistry;
  gameState: GameState;
  dungeon?: CisternWarrensRuntime | undefined;
  /** Token to skill turn-ins (Scale Shrine, Giant Egg nest, Grove Hermit). */
  dungeonSkills?: DungeonSkillService | undefined;
  /** Torch lobbies at dungeon entrances (WP16). */
  torchLobbies?: DungeonTorchLobbyService | undefined;
}>;

export function createDungeonHandler(
  context: DungeonHandlerContext
): RealtimeFamilyHandler<"dungeon"> {
  const sendError = (
    playerId: string,
    requestId: string | undefined,
    error: unknown
  ): void => {
    context.registry.send(playerId, {
      type: "DUNGEON_ERROR",
      ...(requestId ? { requestId } : {}),
      code: error instanceof DungeonError || error instanceof DungeonRepeatError ? error.code : "DUNGEON_FAILED",
      message: error instanceof Error ? error.message : "The dungeon action failed."
    });
  };
  return async (message) => {
    const { state, dungeon, gameState, registry } = context;
    requireHello(state.playerId);
    if (!dungeon) {
      sendError(state.playerId, "requestId" in message ? message.requestId : undefined, new DungeonError("UNAVAILABLE", "Dungeons are unavailable."));
      return;
    }
    try {
      switch (message.type) {
        case "REQUEST_DUNGEON_ENTRANCES": {
          const player = gameState.getPlayer(state.playerId);
          if (!player) throw new DungeonError("NOT_CONNECTED", "Player state is unavailable.");
          registry.send(state.playerId, {
            type: "DUNGEON_ENTRANCES",
            requestId: message.requestId,
            entrances: await dungeon.entrancesNear(player.position, 25_000, state.playerId)
          });
          return;
        }
        case "ENTER_CISTERN_WARRENS": {
          throw new DungeonError("USE_PORTAL_REQUIRED", "Dungeon entry must use the universal portal system.");
        }
        case "DUNGEON_MOVE_TO": {
          registry.send(state.playerId, {
            type: "DUNGEON_SNAPSHOT",
            snapshot: dungeon.moveTo(state.playerId, message.sessionId, message.x, message.y)
          });
          return;
        }
        case "DUNGEON_INTERACT": {
          const skillId = context.dungeonSkills
            ? dungeon.skillTurnInFor(state.playerId, message.sessionId, message.objectId)
            : null;
          if (skillId && context.dungeonSkills) {
            const result = await context.dungeonSkills.turnIn(state.playerId, skillId, message.requestId);
            if (result.status === "discovered") {
              registry.send(state.playerId, {
                type: "SKILL_TREE_SNAPSHOT", requestId: message.requestId, snapshot: result.snapshot
              });
              registry.send(state.playerId, {
                type: "INVENTORY_STACK_UPDATED", requestId: message.requestId, action: "reorganize",
                inventory: result.inventory, serverTime: Date.now(), message: result.message
              });
            }
            registry.send(state.playerId, {
              type: "DUNGEON_SNAPSHOT",
              requestId: message.requestId,
              snapshot: dungeon.announceToPlayer(
                state.playerId, message.sessionId, result.message,
                result.status === "discovered" ? "success" : result.status === "insufficient" ? "warning" : "info"
              )
            });
            return;
          }
          registry.send(state.playerId, {
            type: "DUNGEON_SNAPSHOT",
            requestId: message.requestId,
            snapshot: dungeon.interact(
              state.playerId,
              message.sessionId,
              message.objectId,
              message.requestId
            )
          });
          return;
        }
        case "DUNGEON_PUZZLE_SOLVE": {
          registry.send(state.playerId, {
            type: "DUNGEON_SNAPSHOT",
            requestId: message.requestId,
            snapshot: dungeon.puzzleSolve(state.playerId, message.sessionId, message.roomId, message.requestId)
          });
          return;
        }
        case "DUNGEON_PUZZLE_ACTIVE": {
          registry.send(state.playerId, {
            type: "DUNGEON_SNAPSHOT",
            requestId: message.requestId,
            snapshot: dungeon.puzzleSetActive(state.playerId, message.sessionId, message.roomId, message.active)
          });
          return;
        }
        case "DUNGEON_HARVEST_RESOURCE": {
          // Game clients gather dungeon nodes through START/COMPLETE_HARVEST like the overworld.
          throw new DungeonError(
            "USE_HARVEST_FLOW_REQUIRED",
            "Dungeon resources are gathered with the standard harvest flow."
          );
        }
        case "DUNGEON_TORCH_LOBBY_JOIN":
        case "DUNGEON_TORCH_LOBBY_SET_TORCHES":
        case "DUNGEON_TORCH_LOBBY_READY":
        case "DUNGEON_TORCH_LOBBY_START":
        case "DUNGEON_TORCH_LOBBY_LEAVE": {
          const lobbies = context.torchLobbies;
          if (!lobbies) throw new DungeonError("TORCH_LOBBY_UNAVAILABLE", "Torch lobbies are unavailable.");
          if (message.type === "DUNGEON_TORCH_LOBBY_JOIN") await lobbies.join(state.playerId, message.entranceId, message.requestId);
          else if (message.type === "DUNGEON_TORCH_LOBBY_SET_TORCHES") {
            await lobbies.setTorches(state.playerId, message.lobbyId, message.torches, message.requestId);
          } else if (message.type === "DUNGEON_TORCH_LOBBY_READY") {
            lobbies.setReady(state.playerId, message.lobbyId, message.ready, message.requestId);
          } else if (message.type === "DUNGEON_TORCH_LOBBY_START") await lobbies.start(state.playerId, message.lobbyId, message.requestId);
          else lobbies.leave(state.playerId, message.lobbyId, message.requestId);
          return;
        }
        case "EXIT_CISTERN_WARRENS": {
          throw new DungeonError("USE_PORTAL_REQUIRED", "Dungeon exit must use the universal portal system.");
        }
      }
    } catch (error) {
      sendError(state.playerId, "requestId" in message ? message.requestId : undefined, error);
    }
  };
}

export function registerDungeonHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"dungeon">
): void {
  router.register("dungeon", handler);
}
