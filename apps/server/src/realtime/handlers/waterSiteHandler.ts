import type { LatLon, ServerMessage } from "@ash-atlas/shared";
import type pg from "pg";

import type { GameState } from "../../game/state.js";
import { WaterSiteError, type WaterSiteService } from "../../game/waterSites.js";
import type { AppLogger } from "../../logger.js";
import type { SocketLike } from "../connectionRegistry.js";

export type WhirlpoolTravel = (input: Readonly<{
  playerId: string;
  requestId: string;
  destination: LatLon;
  chargeInTransaction(client: pg.PoolClient): Promise<void>;
}>) => Promise<
  | Readonly<{ success: true }>
  | Readonly<{ success: false; reason: Readonly<{ code: string; message: string }> }>
>;

export type WaterSiteContext = Readonly<{
  playerId: string;
  socket: SocketLike;
  logger: AppLogger;
  gameState: Pick<GameState, "setAfloat">;
  waterSites: WaterSiteService | undefined;
  travelThroughWhirlpool: WhirlpoolTravel | undefined;
  inventorySnapshot(playerId: string): Promise<Extract<ServerMessage, { type: "PLAYER_RESOURCES_UPDATED" }>["inventory"]>;
  safeSendServerMessage(
    socket: SocketLike,
    message: ServerMessage,
    logger?: Pick<AppLogger, "warn">,
    context?: Record<string, unknown>
  ): boolean;
}>;

type WaterSiteMessage =
  | Readonly<{ type: "REQUEST_WATER_SITES"; requestId: string }>
  | Readonly<{ type: "DIVE_PEARL_BED" | "ENTER_WHIRLPOOL" | "PRESENT_ABYSSAL_ORBS"; requestId: string; siteId: string }>;

/** Pearl Beds, whirlpools and Drowned City sites. The caller has already required HELLO. */
export async function handleWaterSiteMessage(context: WaterSiteContext, message: WaterSiteMessage): Promise<void> {
  const { playerId, socket, waterSites } = context;
  const send = (outgoing: ServerMessage) => context.safeSendServerMessage(socket, outgoing, context.logger, { playerId });
  const sendError = (code: string, text: string) => send({ type: "ERROR", requestId: message.requestId, code, message: text });
  if (!waterSites) {
    sendError("WATER_SITES_UNAVAILABLE", "The sea is quiet right now.");
    return;
  }
  try {
    switch (message.type) {
      case "REQUEST_WATER_SITES": {
        const result = await waterSites.sitesFor(playerId);
        send({
          type: "WATER_SITES",
          requestId: message.requestId,
          sites: result.sites,
          tidecraftRank: result.tidecraft.rank,
          tidecraftDiscovered: result.tidecraft.discovered,
          serverTime: Date.now()
        });
        return;
      }
      case "DIVE_PEARL_BED": {
        const result = await waterSites.dive(playerId, message.siteId, message.requestId);
        send({
          type: "PEARL_DIVE_RESULT",
          requestId: message.requestId,
          siteId: result.siteId,
          pearls: result.pearls,
          diveReadyAt: result.diveReadyAt,
          inventory: result.inventory,
          replayed: result.replayed,
          serverTime: Date.now(),
          message: result.replayed
            ? "You already dived here."
            : `You dive and bring up ${result.pearls} Pearl${result.pearls === 1 ? "" : "s"}.`
        });
        return;
      }
      case "ENTER_WHIRLPOOL": {
        if (!context.travelThroughWhirlpool) {
          sendError("WATER_SITES_UNAVAILABLE", "The whirlpool is calm right now.");
          return;
        }
        const plan = await waterSites.planWhirlpool(playerId, message.siteId, message.requestId);
        const travel = await context.travelThroughWhirlpool({
          playerId,
          requestId: message.requestId,
          destination: plan.destination,
          chargeInTransaction: (client) =>
            waterSites.chargeWhirlpoolInTransaction(client, playerId, message.requestId, plan.siteId)
        });
        if (!travel.success) {
          sendError(travel.reason.code, travel.reason.message);
          return;
        }
        // Whirlpool arrival is always afloat, free.
        context.gameState.setAfloat(playerId, true, true);
        send({ type: "PLAYER_RESOURCES_UPDATED", playerId, inventory: await context.inventorySnapshot(playerId), serverTime: Date.now() });
        return;
      }
      case "PRESENT_ABYSSAL_ORBS": {
        const result = await waterSites.presentOrbs(playerId, message.siteId, message.requestId);
        send({ type: "SKILL_TREE_SNAPSHOT", requestId: message.requestId, snapshot: result.snapshot });
        send({
          type: "INVENTORY_STACK_UPDATED",
          requestId: message.requestId,
          action: "reorganize",
          inventory: result.inventory,
          serverTime: Date.now(),
          message: result.message
        });
        return;
      }
    }
  } catch (error) {
    if (error instanceof WaterSiteError) {
      sendError(error.code, error.message);
      return;
    }
    context.logger.warn({ err: error, playerId, requestId: message.requestId, type: message.type }, "water site action failed");
    sendError("WATER_SITE_ACTION_FAILED", "That did not work. Try again.");
  }
}
