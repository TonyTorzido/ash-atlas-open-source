import { describe, expect, it } from "vitest";

import { parseServerMessage } from "./serverMessageParser.js";

describe("travel server messages: land-action availability", () => {
  it("parses TRAVEL_INBOX_SNAPSHOT with and without landActionAvailableAt", () => {
    const base = {
      type: "TRAVEL_INBOX_SNAPSHOT",
      entries: [],
      serverTime: 1_000,
      relocationAvailableAt: null,
      travelInviteAvailableAt: null
    };
    expect(parseServerMessage(JSON.stringify(base))).toEqual(base);
    expect(parseServerMessage(JSON.stringify({ ...base, landActionAvailableAt: 61_000 })))
      .toEqual({ ...base, landActionAvailableAt: 61_000 });
    expect(parseServerMessage(JSON.stringify({ ...base, landActionAvailableAt: null })))
      .toEqual({ ...base, landActionAvailableAt: null });
  });

  it("parses a gps_relocate TRAVEL_RESULT with the optional field", () => {
    const result = {
      type: "TRAVEL_RESULT",
      requestId: "gps-1",
      kind: "gps_relocate",
      success: true,
      message: "Relocated.",
      landActionAvailableAt: 2_000
    };
    expect(parseServerMessage(JSON.stringify(result))).toEqual(result);
  });

  it("rejects a non-numeric landActionAvailableAt", () => {
    expect(() => parseServerMessage(JSON.stringify({
      type: "TRAVEL_INBOX_SNAPSHOT",
      entries: [],
      serverTime: 1_000,
      landActionAvailableAt: "soon"
    }))).toThrow();
  });
});
