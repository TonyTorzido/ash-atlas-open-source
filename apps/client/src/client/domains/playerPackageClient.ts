import type { ClientMessage } from "@ash-atlas/shared";

import { requestIdCrypto as crypto } from "../../requestId.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

export class PlayerPackageClient {
  constructor(private readonly port: ClientCommandPort) {}

  requestInbox(requestId = crypto.randomUUID()): string | null {
    return this.send({
      type: "REQUEST_PLAYER_PACKAGES",
      requestId
    }) ? requestId : null;
  }

  claim(
    packageId: string,
    expectedRevision: string,
    requestId = crypto.randomUUID()
  ): string | null {
    return this.send({
      type: "CLAIM_PLAYER_PACKAGE",
      requestId,
      packageId,
      expectedRevision
    }) ? requestId : null;
  }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }
}
