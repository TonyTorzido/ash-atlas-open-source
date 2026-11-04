import { describe, expect, it } from "vitest";

import { parseServerMessage } from "../protocol.js";

describe("legendary event alert server frame", () => {
  it("parses and preserves the canonical event selection revision", () => {
    const frame = {
      type: "LEGENDARY_EVENT_ALERT",
      eventId: "00000000-0000-4000-8000-000000000099",
      birdSpecies: "ice",
      flagId: "00000000-0000-4000-8000-000000000088",
      message: "An Ice Phoenix is attacking your flag!",
      selectedAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-02T00:00:00.000Z"
    };

    expect(parseServerMessage(JSON.stringify(frame))).toEqual(frame);
  });
});
