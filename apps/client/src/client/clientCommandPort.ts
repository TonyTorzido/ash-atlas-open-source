import type { ClientMessage } from "@ash-atlas/shared";

export type ClientSendOutcome =
  | {
      status: "sent";
      readiness: "ready" | "world-preparing";
      connectionGeneration: number;
    }
  | { status: "connecting" }
  | { status: "session-bootstrap-pending" }
  | { status: "suspended" }
  | { status: "network-offline" }
  | {
      status: "stale-socket-generation";
      expectedGeneration: number;
      activeGeneration: number;
    }
  | { status: "send-failed"; error: unknown; failure: "serialization" | "transport" }
  | { status: "intentionally-disconnected" }
  | { status: "protocol-incompatible" };

export interface ClientCommandPort {
  send(message: ClientMessage, expectedGeneration?: number): ClientSendOutcome;
  connectionGeneration?(): number;
}

export function wasClientMessageSent(outcome: ClientSendOutcome): boolean {
  return outcome.status === "sent";
}

export type GameplayCommandAttempt = Readonly<{
  requestId: string;
  outcome: ClientSendOutcome;
}>;
