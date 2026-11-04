import { describe, expect, it } from "vitest";

import { isWebSocketHeartbeatExpired } from "./realtimeApplication.js";

describe("WebSocket heartbeat lifecycle", () => {
  it("does not expire early and expires immediately after the configured deadline", () => {
    const lastMessageAt = new Date(1_000);
    expect(isWebSocketHeartbeatExpired(lastMessageAt, 20_999, 20_000)).toBe(false);
    expect(isWebSocketHeartbeatExpired(lastMessageAt, 21_000, 20_000)).toBe(true);
  });
});
