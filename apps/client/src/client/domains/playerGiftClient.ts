import type { ClientMessage, PlayerGiftItemLineInput } from "@ash-atlas/shared";

import { requestIdCrypto as crypto } from "../../requestId.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

/** Player gifting commands; results arrive as GIFT_BOX_PURCHASE_RESULT,
 * PLAYER_GIFT_SEND_RESULT, PLAYER_GIFT_STATUS or PLAYER_GIFT_ERROR frames. */
export class PlayerGiftClient {
  constructor(private readonly port: ClientCommandPort) {}

  buyBox(quantity: number, requestId = crypto.randomUUID()): string | null {
    return this.dispatch({ type: "BUY_GIFT_BOX", requestId, quantity }) ? requestId : null;
  }

  send(
    gift: Readonly<{
      recipientPlayerId: string;
      message?: string;
      items: readonly PlayerGiftItemLineInput[];
      equipmentInstanceIds: readonly string[];
    }>,
    requestId = crypto.randomUUID()
  ): string | null {
    return this.dispatch({
      type: "SEND_PLAYER_GIFT",
      requestId,
      recipientPlayerId: gift.recipientPlayerId,
      ...(gift.message ? { message: gift.message } : {}),
      items: [...gift.items],
      equipmentInstanceIds: [...gift.equipmentInstanceIds]
    }) ? requestId : null;
  }

  requestStatus(requestId = crypto.randomUUID()): string | null {
    return this.dispatch({ type: "REQUEST_GIFT_STATUS", requestId }) ? requestId : null;
  }

  private dispatch(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }
}
