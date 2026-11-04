import { describe, expect, it } from "vitest";

import type { ClientCommandPort, ClientSendOutcome } from "./clientCommandPort.js";
import { wasClientMessageSent } from "./clientCommandPort.js";

describe("ClientCommandPort", () => {
  it("distinguishes every authoritative gameplay send readiness state", () => {
    const outcomes: ClientSendOutcome[] = [
      { status: "sent", readiness: "ready", connectionGeneration: 4 },
      { status: "sent", readiness: "world-preparing", connectionGeneration: 4 },
      { status: "connecting" },
      { status: "session-bootstrap-pending" },
      { status: "suspended" },
      { status: "network-offline" },
      {
        status: "stale-socket-generation",
        expectedGeneration: 3,
        activeGeneration: 4
      },
      {
        status: "send-failed",
        error: new Error("serialize"),
        failure: "serialization"
      },
      { status: "intentionally-disconnected" },
      { status: "protocol-incompatible" }
    ];
    const sent: Parameters<ClientCommandPort["send"]>[0] = { type: "PING", clientTime: 1 };

    expect(sent.type).toBe("PING");
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "sent",
      "sent",
      "connecting",
      "session-bootstrap-pending",
      "suspended",
      "network-offline",
      "stale-socket-generation",
      "send-failed",
      "intentionally-disconnected",
      "protocol-incompatible"
    ]);
    expect(outcomes.map(wasClientMessageSent)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false
    ]);
  });
});
