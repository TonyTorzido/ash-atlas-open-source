import { describe, expect, it } from "vitest";

import { clientMessageSchema } from "./protocol.js";

describe("flag build and development teleport protocol", () => {
  it("accepts bounded build cancellation and teleport requests", () => {
    expect(clientMessageSchema.parse({ type: "CANCEL_FLAG_BUILD", requestId: "cancel-1", buildId: "11111111-1111-4111-8111-111111111111" }).type).toBe("CANCEL_FLAG_BUILD");
    expect(clientMessageSchema.parse({ type: "DEV_TELEPORT", requestId: "tp-1", lat: -89.9, lon: 180 }).type).toBe("DEV_TELEPORT");
  });

  it("rejects invalid coordinates and extra authority fields", () => {
    expect(() => clientMessageSchema.parse({ type: "DEV_TELEPORT", requestId: "tp-1", lat: 91, lon: 0 })).toThrow();
    expect(() => clientMessageSchema.parse({ type: "DEV_TELEPORT", requestId: "tp-1", lat: 0, lon: 0, devMode: true })).toThrow();
  });

  it("accepts a server-resolved mine visit and rejects forged flag authority", () => {
    expect(clientMessageSchema.parse({
      type: "DEV_VISIT_MINE",
      requestId: "mine-visit-1",
      mineId: "11111111-1111-4111-8111-111111111111"
    }).type).toBe("DEV_VISIT_MINE");
    expect(() => clientMessageSchema.parse({
      type: "DEV_VISIT_MINE",
      requestId: "mine-visit-1",
      mineId: "11111111-1111-4111-8111-111111111111",
      flagId: "22222222-2222-4222-8222-222222222222"
    })).toThrow();
  });
});
