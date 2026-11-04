import {
  SAPLING_VIEW_RADIUS_M,
  type SaplingStateAction,
  type ServerMessage
} from "@ash-atlas/shared";

import { SaplingError, type GivingSaplingService, type SaplingMutationResult } from "../../game/givingSaplings.js";
import type { GameState } from "../../game/state.js";
import type { SocketLike } from "../connectionRegistry.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import { requireHello, type RealtimeConnectionState } from "./handlerExecutionContext.js";

export type SaplingHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId">;
  socket: SocketLike;
  gameState: Pick<GameState, "getPlayer" | "isWorldPresent">;
  saplings?: GivingSaplingService | undefined;
  /** Grove Lore rank of the player (0 when undiscovered). */
  groveLoreRank?: ((playerId: string) => Promise<number>) | undefined;
  /** True while the player is flagged aggressive (planting is blocked). */
  isAggressive?: ((playerId: string) => boolean) | undefined;
  safeSendServerMessage(socket: SocketLike, message: ServerMessage): boolean;
}>;

export function createSaplingHandler(context: SaplingHandlerContext): RealtimeFamilyHandler<"sapling"> {
  return async (message) => {
    const { state, socket, gameState, saplings, safeSendServerMessage } = context;
    requireHello(state.playerId);
    const playerId = state.playerId;
    try {
      if (!saplings) throw new SaplingError("SAPLING_UNAVAILABLE", "Saplings are temporarily unavailable.", true);
      const player = gameState.getPlayer(playerId);
      if (!player) throw new SaplingError("SAPLING_PLAYER_REQUIRED", "Your player session is unavailable.", true);
      const worldPresent = gameState.isWorldPresent(playerId);
      // A mutation answers with its own tree's detail; everyone in view (this player too) gets the
      // compact change as a pushed delta, so no list is re-sent.
      const reply = (action: SaplingStateAction, result: SaplingMutationResult): void => {
        safeSendServerMessage(socket, {
          type: "SAPLING_RESULT",
          requestId: message.requestId,
          action,
          sapling: result.sapling,
          serverNowMs: Date.now(),
          notice: result.notice,
          ...(result.inventory ? { inventory: result.inventory } : {})
        });
      };
      const groveRank = async (): Promise<number> =>
        await (context.groveLoreRank?.(playerId) ?? Promise.resolve(0)).catch(() => 0);
      switch (message.type) {
        case "REQUEST_SAPLINGS":
          // Served from the in-memory index: no database read.
          safeSendServerMessage(socket, {
            type: "SAPLINGS_STATE",
            requestId: message.requestId,
            saplings: worldPresent ? saplings.listNear(player.position, SAPLING_VIEW_RADIUS_M) : [],
            serverNowMs: Date.now()
          });
          return;
        case "REQUEST_SAPLING_DETAIL":
          safeSendServerMessage(socket, {
            type: "SAPLING_DETAIL",
            requestId: message.requestId,
            saplingId: message.saplingId,
            sapling: await saplings.detail(message.saplingId),
            serverNowMs: Date.now()
          });
          return;
        case "PLANT_SAPLING":
          reply("plant", await saplings.plant({
            playerId,
            requestId: message.requestId,
            regionCode: player.regionCode,
            position: player.position,
            source: message.source,
            target: message.target,
            aggressive: context.isAggressive?.(playerId) ?? false,
            worldPresent
          }));
          return;
        case "PLANT_SAPLINGS_GRID": {
          const grid = await saplings.plantGrid({
            playerId,
            requestId: message.requestId,
            regionCode: player.regionCode,
            position: player.position,
            aggressive: context.isAggressive?.(playerId) ?? false,
            worldPresent
          });
          if (grid.planted === 0 || !grid.inventory) {
            throw new SaplingError("SAPLING_GRID_NONE", "Nothing could be planted here.");
          }
          safeSendServerMessage(socket, {
            type: "INVENTORY_STACK_UPDATED",
            requestId: message.requestId,
            action: "reorganize",
            inventory: grid.inventory,
            serverTime: Date.now(),
            message: `You planted ${grid.planted} sapling${grid.planted === 1 ? "" : "s"}.${grid.skipped > 0 ? ` ${grid.skipped} spot${grid.skipped === 1 ? "" : "s"} skipped.` : ""}`
          });
          return;
        }
        case "TEND_SAPLING":
          requireWorld(worldPresent);
          reply("tend", await saplings.tend({
            playerId,
            saplingId: message.saplingId,
            position: player.position,
            groveLoreRank: await groveRank()
          }));
          return;
        case "PULL_SAPLING":
          requireWorld(worldPresent);
          reply("pull", await saplings.pull({
            playerId,
            saplingId: message.saplingId,
            position: player.position,
            groveLoreRank: await groveRank()
          }));
          return;
        case "GATHER_SAPLING_BERRY":
          requireWorld(worldPresent);
          reply("gather", await saplings.gather({
            playerId,
            saplingId: message.saplingId,
            position: player.position,
            groveLoreRank: await groveRank()
          }));
          return;
      }
    } catch (error) {
      const saplingError = error instanceof SaplingError ? error : null;
      safeSendServerMessage(socket, {
        type: "SAPLING_ERROR",
        requestId: message.requestId,
        code: saplingError?.code ?? "SAPLING_REQUEST_REJECTED",
        message: saplingError?.message ?? "Sapling request rejected.",
        retryable: saplingError?.retryable ?? false
      });
    }
  };
}

function requireWorld(worldPresent: boolean): void {
  if (!worldPresent) throw new SaplingError("SAPLING_WORLD_REQUIRED", "Return to the open world first.");
}

export function registerSaplingHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"sapling">
): void {
  router.register("sapling", handler);
}
