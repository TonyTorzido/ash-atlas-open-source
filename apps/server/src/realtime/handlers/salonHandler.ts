import type { PlayerSalonStyles, ServerMessage } from "@ash-atlas/shared";

import { installAuthoritativePlayerAppearance } from "../../game/appearanceProjection.js";
import type { EquipmentService } from "../../game/equipment.js";
import { SalonError, type SalonRuntime, type SalonService } from "../../game/salon.js";
import type { GameState } from "../../game/state.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import { requireHello } from "./handlerExecutionContext.js";

export type SalonHandlerContext = Readonly<{
  state: { playerId: string | null };
  socket: SocketLike;
  registry: ConnectionRegistry;
  gameState: GameState;
  salon?: SalonService | undefined;
  salonRuntime?: SalonRuntime | undefined;
  equipment?: EquipmentService | undefined;
  /** Per-player command rate limit (throws the standard rate-limit error). */
  enforcePlayerClassRate?(key: string, maximum: number, windowMs: number): void;
}>;

export function createSalonHandler(context: SalonHandlerContext): RealtimeFamilyHandler<"salon"> {
  return async (message) => {
    const {
      state, registry, gameState, salon, salonRuntime, equipment
    } = context;
    // Each mask change bumps the appearance revision and is broadcast: same limit as other
    // per-player commands (outside the try so the standard rate-limit error reaches the client).
    if (message.type === "EQUIP_MASK") context.enforcePlayerClassRate?.("mask-equip", 6, 10_000);
    try {
      requireHello(state.playerId);
      switch (message.type) {
        case "EQUIP_MASK": {
        // Masks are worn from the inventory anywhere; only the appearance service is needed.
        if (!salon) throw new SalonError("UNAVAILABLE", "Appearance changes are unavailable.");
        const playerId = state.playerId!;
        const result = await salon.equipMask(playerId, message.copyId);
        gameState.setPlayerSalonStyles(playerId, result.styles, result.revision);
        const equipmentSnapshot = equipment?.runtimeSnapshot(playerId);
        if (!equipmentSnapshot) throw new SalonError("EQUIPMENT_UNAVAILABLE", "Appearance projection is unavailable.");
        const appearance = installAuthoritativePlayerAppearance(gameState, equipmentSnapshot);
        if (!appearance) throw new SalonError("NOT_CONNECTED", "Player state is unavailable.");
        registry.send(playerId, {
          type: "MASK_EQUIPPED",
          requestId: message.requestId,
          maskAppearanceId: result.styles.mask ?? null,
          maskCopyId: result.maskCopyId,
          appearanceRevision: result.revision,
          styles: result.styles,
          appearance,
          replayed: !result.changed,
          message: result.message
        });
        return;
        }
      }
      if (!salon || !salonRuntime) throw new SalonError("UNAVAILABLE", "The Salon is unavailable.");
      const playerId = state.playerId!;
      switch (message.type) {
        case "ENTER_SALON": {
          throw new SalonError("USE_PORTAL_REQUIRED", "Salon entry must use the universal portal system.");
        }
        case "SALON_MOVE_TO": {
          salon.invalidateEditor(playerId);
          const session = salonRuntime.moveTo(playerId, message.salonSessionId, message.x, message.y);
          registry.send(playerId, positionMessage(session));
          return;
        }
        case "BEGIN_SALON_CUSTOMIZE": {
          const session = salonRuntime.authorizeChair(
            playerId,
            message.salonSessionId,
            message.movementSequence
          );
          const editor = await salon.beginCustomize(playerId, session);
          registry.send(playerId, { type: "SALON_EDITOR_OPENED", requestId: message.requestId, ...editor });
          return;
        }
        case "CANCEL_SALON_CUSTOMIZE": {
          salon.cancelCustomize(playerId, message.editorSessionId);
          registry.send(playerId, { type: "SALON_EDITOR_CANCELLED", requestId: message.requestId });
          return;
        }
        case "SAVE_SALON_APPEARANCE": {
          const result = await salon.save({
            playerId,
            requestId: message.requestId,
            editorSessionId: message.editorSessionId,
            expectedAppearanceRevision: message.expectedAppearanceRevision,
            catalogRevision: message.catalogRevision,
            changes: message.changes as PlayerSalonStyles
          });
          gameState.setPlayerSalonStyles(playerId, result.styles, result.revision);
          const equipmentSnapshot = equipment?.runtimeSnapshot(playerId);
          if (!equipmentSnapshot) throw new SalonError("EQUIPMENT_UNAVAILABLE", "Appearance projection is unavailable.");
          const appearance = installAuthoritativePlayerAppearance(gameState, equipmentSnapshot);
          if (!appearance) throw new SalonError("NOT_CONNECTED", "Player state is unavailable.");
          registry.send(playerId, {
            type: "SALON_APPEARANCE_SAVED",
            requestId: message.requestId,
            appearanceRevision: result.revision,
            styles: result.styles,
            appearance,
            replayed: result.replayed,
            price: 0
          });
          return;
        }
        case "EXIT_SALON": {
          throw new SalonError("USE_PORTAL_REQUIRED", "Salon exit must use the universal portal system.");
        }
      }
    } catch (error) {
      const salonError = error instanceof SalonError
        ? error
        : new SalonError("SALON_FAILED", "The Salon request failed.");
      const requestId = "requestId" in message ? message.requestId : undefined;
      const response: ServerMessage = {
        type: "SALON_ERROR",
        ...(requestId ? { requestId } : {}),
        code: salonError.code,
        message: salonError.message
      };
      context.registry.send(state.playerId ?? "", response);
    }
  };
}

export function registerSalonHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"salon">
): void {
  router.register("salon", handler);
}

function positionMessage(session: NonNullable<ReturnType<SalonRuntime["get"]>>): ServerMessage {
  return {
    type: "SALON_POSITION",
    salonSessionId: session.sessionId,
    position: session.position,
    movementSequence: session.movementSequence,
    serverTime: Date.now()
  };
}
