import {
  FIELD_BUFF_FOR_ITEM,
  FIELD_CONSUMABLE_NAMES,
  isFieldConsumableItemId,
  type FieldBuffItemId,
  type FieldBuffSnapshot,
  type FieldConsumableItemId,
  type ServerMessage
} from "@ash-atlas/shared";

import type { CombatEngine } from "../../game/combat/combatEngine.js";
import {
  FieldConsumableError,
  type FieldConsumableService
} from "../../game/fieldConsumables.js";
import type { GameState } from "../../game/state.js";
import type { AppLogger } from "../../logger.js";
import type { SocketLike } from "../connectionRegistry.js";

export type FieldConsumableContext = Readonly<{
  playerId: string;
  socket: SocketLike;
  logger: AppLogger;
  gameState: GameState;
  combat: CombatEngine | undefined;
  fieldConsumables: FieldConsumableService | undefined;
  strikeStructures?: ((input: Readonly<{
    origin: { lat: number; lon: number };
    radiusM: number;
    damage?: number;
    activationId: string;
  }>) => Promise<Readonly<{ hit: number; skipped: number }>>) | undefined;
  safeSendServerMessage(
    socket: SocketLike,
    message: ServerMessage,
    logger?: Pick<AppLogger, "warn">,
    context?: Record<string, unknown>
  ): boolean;
}>;

type UseMessage = Readonly<{
  requestId: string;
  itemId: FieldConsumableItemId;
  stackId?: string | undefined;
  targetEntityId?: string | undefined;
}>;

export function isFieldConsumableUse(itemId: string): itemId is FieldConsumableItemId {
  return isFieldConsumableItemId(itemId);
}

function sendError(context: FieldConsumableContext, requestId: string, code: string, message: string): void {
  context.safeSendServerMessage(context.socket, { type: "ERROR", requestId, code, message });
}

/** USE_CONSUMABLE for the six field consumables. The caller has already required HELLO. */
export async function useFieldConsumable(context: FieldConsumableContext, message: UseMessage): Promise<void> {
  const { playerId, combat, fieldConsumables } = context;
  const { requestId, itemId } = message;
  const name = FIELD_CONSUMABLE_NAMES[itemId];
  if (!fieldConsumables || !combat) {
    sendError(context, requestId, "CONSUMABLE_UNAVAILABLE", `${name} is unavailable.`);
    return;
  }
  if (!combat.isPlayerAlive(playerId)) {
    sendError(context, requestId, "CONSUMABLE_PLAYER_UNAVAILABLE", `${name} cannot be used while defeated.`);
    return;
  }
  try {
    if (itemId in FIELD_BUFF_FOR_ITEM) {
      const result = await fieldConsumables.consumeBuff(
        playerId,
        requestId,
        itemId as FieldBuffItemId,
        message.stackId
      );
      combat.stageFieldBuffs(playerId, result.buffs, { drank: !result.replayed });
      const buff = result.buffs.find((entry) => entry.buffId === FIELD_BUFF_FOR_ITEM[itemId as FieldBuffItemId]);
      const hours = buff?.endsAt ? Math.max(1, Math.round((buff.endsAt - buff.startedAt) / 1_800_000) / 2) : 1;
      reply(context, message, result.inventory, [...result.buffs, ...combat.fieldBuffSnapshots(playerId)], result.replayed,
        result.replayed ? `${name} is already active.` : `${name} taken. It lasts ${hours} hour${hours === 1 ? "" : "s"}.`);
      return;
    }

    if (itemId === "mending_resin") {
      sendError(context, requestId, "MENDING_RESIN_NEEDS_ARMOR", "Choose a piece of chest armor to mend.");
      return;
    }

    if (itemId === "masons_tome") {
      const result = await fieldConsumables.applyMasonsTome(playerId, requestId, message.stackId);
      reply(context, message, result.inventory, combat.fieldBuffSnapshots(playerId), result.replayed,
        result.replayed ? "That tome was already used." : "The Mason's Tome halves the rest of this repair.");
      return;
    }

    const target = message.targetEntityId ?? null;
    const rejection = combat.checkFieldConsumable(playerId, itemId, target);
    if (rejection && !(await fieldConsumables.operationApplied(playerId, requestId))) {
      sendError(context, requestId, rejection.code, rejection.message);
      return;
    }
    const consumed = await fieldConsumables.consumeInstant(playerId, requestId, itemId, message.stackId);
    if (consumed.replayed) {
      reply(context, message, consumed.inventory, combat.fieldBuffSnapshots(playerId), true, `${name} was already used.`);
      return;
    }
    const allyPlayerIds = itemId === "undertow_snare" || itemId === "free_step_ward"
      ? await fieldConsumables.kingdomAllyIds(playerId)
      : [];
    const outcome = combat.applyFieldConsumable(playerId, itemId, target, { allyPlayerIds });
    if ("code" in outcome) {
      // The world changed between the check and the debit: give the item back.
      const inventory = await fieldConsumables.refundInstant(playerId, requestId, itemId);
      context.safeSendServerMessage(context.socket, {
        type: "PLAYER_RESOURCES_UPDATED",
        playerId,
        inventory,
        serverTime: Date.now()
      });
      sendError(context, requestId, outcome.code, outcome.message);
      return;
    }
    let text = successText(itemId, outcome.hits);
    let usedInventory = consumed.inventory;
    if (itemId === "field_net") {
      const returned = await fieldConsumables.returnNetOnUse(playerId, requestId).catch(() => null);
      if (returned) {
        usedInventory = returned;
        text += " The Net is recovered.";
      }
    }
    if (itemId === "ember_flask" && outcome.origin && outcome.radiusM !== undefined && context.strikeStructures &&
      context.gameState.isWorldPresent(playerId)) {
      const struck = await context.strikeStructures({
        origin: outcome.origin,
        radiusM: outcome.radiusM,
        ...(outcome.damage !== undefined ? { damage: outcome.damage } : {}),
        activationId: requestId
      });
      if (struck.hit > 0) text += ` ${struck.hit} structure${struck.hit === 1 ? "" : "s"} took a hit.`;
    }
    reply(context, message, usedInventory, combat.fieldBuffSnapshots(playerId), false, text);
  } catch (error) {
    context.logger.info({ playerId, requestId, itemId, err: error }, "field consumable rejected");
    sendError(
      context,
      requestId,
      error instanceof FieldConsumableError ? error.code : "CONSUMABLE_USE_REJECTED",
      error instanceof FieldConsumableError ? error.message : `${name} could not be used.`
    );
  }
}

export async function craftFieldConsumable(
  context: FieldConsumableContext,
  message: Readonly<{ requestId: string; itemId: FieldConsumableItemId }>
): Promise<void> {
  const { playerId, fieldConsumables } = context;
  const name = FIELD_CONSUMABLE_NAMES[message.itemId];
  if (!fieldConsumables) {
    sendError(context, message.requestId, "CRAFT_UNAVAILABLE", `${name} cannot be crafted right now.`);
    return;
  }
  try {
    const result = await fieldConsumables.craft(playerId, message.requestId, message.itemId);
    context.safeSendServerMessage(context.socket, {
      type: "FIELD_CONSUMABLE_CRAFTED",
      requestId: message.requestId,
      itemId: message.itemId,
      quantity: result.quantity,
      inventory: result.inventory,
      replayed: result.replayed,
      message: result.replayed ? `${name} craft already applied.` : `Crafted ${result.quantity} ${name}.`
    });
  } catch (error) {
    sendError(
      context,
      message.requestId,
      error instanceof FieldConsumableError ? error.code : "FIELD_CRAFT_REJECTED",
      error instanceof FieldConsumableError ? error.message : `${name} could not be crafted.`
    );
  }
}

function reply(
  context: FieldConsumableContext,
  message: UseMessage,
  inventory: Extract<ServerMessage, { type: "FIELD_CONSUMABLE_USED" }>["inventory"],
  buffs: FieldBuffSnapshot[],
  replayed: boolean,
  text: string
): void {
  context.safeSendServerMessage(context.socket, {
    type: "FIELD_CONSUMABLE_USED",
    requestId: message.requestId,
    itemId: message.itemId,
    playerId: context.playerId,
    inventory,
    buffs,
    replayed,
    serverTime: Date.now(),
    message: text
  });
}

function successText(itemId: FieldConsumableItemId, hits: number): string {
  switch (itemId) {
    case "battle_draught": return "Battle Draught taken. Your hits hit harder while you stay Aggressive.";
    case "field_net": return "The Net holds the monster for 8 seconds.";
    case "field_trap": return "Trap set. It lasts 12 minutes.";
    case "undertow_snare": return "Undertow Snare set. It pulls everything nearby for 5 minutes.";
    case "free_step_ward": return "Free-Step Ward raised. It stands for 10 minutes.";
    case "stillwater_orb": return hits > 0
      ? `The Stillwater Orb roots ${hits} target${hits === 1 ? "" : "s"} for 15 seconds.`
      : "The Stillwater Orb splashes with nothing in reach.";
    case "ember_flask": return hits > 0
      ? `The Ember Bomb burns ${hits} target${hits === 1 ? "" : "s"}.`
      : "The Ember Bomb burns out with nothing in reach.";
    default: return "Used.";
  }
}
