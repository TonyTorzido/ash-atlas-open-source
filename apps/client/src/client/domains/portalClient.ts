import type { ClientMessage, PlayerLocationSnapshot } from "@ash-atlas/shared";
import { requestIdCrypto as crypto } from "../../requestId.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

export class PortalClient {
  private location: PlayerLocationSnapshot | null = null;
  private activeTransitionId: string | null = null;
  private pendingRequestId: string | null = null;
  private readonly cancelledPendingRequestIds = new Set<string>();

  constructor(private readonly port: ClientCommandPort) {}

  installLocation(location: PlayerLocationSnapshot): void {
    this.location = location;
    this.activeTransitionId = null;
    this.pendingRequestId = null;
    this.cancelledPendingRequestIds.clear();
  }

  snapshot(): PlayerLocationSnapshot | null {
    return this.location;
  }

  notePlan(requestId: string, transitionId: string): boolean {
    this.activeTransitionId = transitionId;
    if (this.pendingRequestId === requestId) this.pendingRequestId = null;
    if (!this.cancelledPendingRequestIds.delete(requestId)) return true;
    this.sendCancellation(transitionId);
    return false;
  }

  noteFailure(requestId?: string, transitionId?: string): void {
    if (requestId && this.pendingRequestId === requestId) this.pendingRequestId = null;
    if (requestId) this.cancelledPendingRequestIds.delete(requestId);
    if (transitionId && this.activeTransitionId === transitionId) {
      this.activeTransitionId = null;
    }
  }

  use(
    portalId: string,
    expectedPortalRevision?: string,
    options?: Readonly<{ approach?: "normal" | "immediate"; lantern?: "cinder" | "challenger" }>
  ): string | null {
    const requestId = crypto.randomUUID();
    const message: ClientMessage = {
      type: "USE_PORTAL", requestId, portalId,
      expectedLocationRevision: this.location?.revision ?? 0,
      ...(expectedPortalRevision ? { expectedPortalRevision } : {}),
      ...(options?.approach ? { approach: options.approach } : {}),
      ...(options?.lantern ? { lantern: options.lantern } : {})
    };
    const sent = wasClientMessageSent(this.port.send(message));
    if (sent) {
      this.pendingRequestId = requestId;
    }
    if (sent && import.meta.env.DEV) performance.mark("ash-atlas:portal:request-sent");
    return sent ? requestId : null;
  }

  destinationReady(transitionId: string, sceneKey: string): boolean {
    return wasClientMessageSent(this.port.send({
      type: "PORTAL_DESTINATION_READY", transitionId, sceneKey
    }));
  }

  cancel(): boolean {
    if (this.activeTransitionId) return this.sendCancellation(this.activeTransitionId);
    if (!this.pendingRequestId) return false;
    this.cancelledPendingRequestIds.add(this.pendingRequestId);
    return true;
  }

  private sendCancellation(transitionId: string): boolean {
    const sent = wasClientMessageSent(this.port.send({
      type: "CANCEL_PORTAL_TRANSITION", requestId: crypto.randomUUID(),
      transitionId
    }));
    if (sent) this.activeTransitionId = null;
    return sent;
  }
}
