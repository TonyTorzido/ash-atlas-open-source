import type { ClientMessage, PlayerSalonStyles } from "@ash-atlas/shared";

import { requestIdCrypto as crypto } from "../../requestId.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

export class SalonClient {
  constructor(private readonly port: ClientCommandPort) {}

  moveTo(salonSessionId: string, x: number, y: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "SALON_MOVE_TO", requestId, salonSessionId, x, y })
      ? requestId
      : null;
  }

  beginCustomize(
    salonSessionId: string,
    movementSequence: number
  ): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "BEGIN_SALON_CUSTOMIZE",
      requestId,
      salonSessionId,
      movementSequence
    }) ? requestId : null;
  }

  saveAppearance(input: {
    editorSessionId: string;
    expectedAppearanceRevision: number;
    catalogRevision: number;
    changes: PlayerSalonStyles;
  }): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "SAVE_SALON_APPEARANCE",
      requestId,
      ...input
    }) ? requestId : null;
  }

  cancelCustomize(editorSessionId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "CANCEL_SALON_CUSTOMIZE",
      requestId,
      editorSessionId
    }) ? requestId : null;
  }

  /** Wear a mask from the inventory, or take it off with null; answered by MASK_EQUIPPED or SALON_ERROR. */
  equipMask(copyId: string | null): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "EQUIP_MASK", requestId, copyId }) ? requestId : null;
  }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }
}
