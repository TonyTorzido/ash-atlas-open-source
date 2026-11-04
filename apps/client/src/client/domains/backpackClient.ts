import type {
  BackpackSnapshot,
  BackpackServerMessage,
  ClientMessage,
  ServerMessage
} from "@ash-atlas/shared";

import { requestIdCrypto as crypto } from "../../requestId.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

export class BackpackClient {
  constructor(private readonly port: ClientCommandPort) {}

  craft(requestId = crypto.randomUUID()): string | null {
    return this.send({
      type: "CRAFT_BACKPACK",
      requestId
    }) ? requestId : null;
  }

  createStarter(equippedSlot: number, requestId = crypto.randomUUID()): string | null {
    return this.send({
      type: "CREATE_STARTER_BACKPACK",
      requestId,
      targetEquippedSlot: equippedSlot
    }) ? requestId : null;
  }

  equip(instanceId: string, equippedSlot: number, requestId = crypto.randomUUID()): string | null {
    return this.send({
      type: "EQUIP_BACKPACK",
      requestId,
      instanceId,
      targetEquippedSlot: equippedSlot
    }) ? requestId : null;
  }

  unequip(instanceId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({
      type: "UNEQUIP_BACKPACK",
      requestId,
      instanceId
    }) ? requestId : null;
  }

  upgrade(instanceId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({
      type: "UPGRADE_BACKPACK",
      requestId,
      instanceId
    }) ? requestId : null;
  }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }
}

export function isBackpackServerMessage(
  message: ServerMessage
): message is BackpackServerMessage {
  return message.type === "BACKPACK_SNAPSHOT" ||
    message.type === "BACKPACK_OPERATION_RESULT" ||
    message.type === "BACKPACK_ERROR";
}

export function shouldAcceptBackpackSnapshot(
  current: BackpackSnapshot | null,
  incoming: BackpackSnapshot,
  playerId: string
): boolean {
  return incoming.playerId === playerId &&
    (current?.playerId !== playerId || incoming.revision > current.revision);
}
