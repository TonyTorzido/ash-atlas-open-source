import { describe, expect, it } from "vitest";

import { parseServerMessage } from "./protocol.js";

describe("presentation snapshot protocol", () => {
  it("parses the authority-fenced completion checkpoint", () => {
    expect(parseServerMessage(JSON.stringify({
      type: "PRESENTATION_SNAPSHOT_COMPLETE",
      connectionId: "connection-1",
      connectionGeneration: 2,
      gameplayViewGeneration: 3,
      relocationRevision: 4,
      resourceVisionRevision: 5,
      populationPreparationGeneration: 6
    }))).toEqual({
      type: "PRESENTATION_SNAPSHOT_COMPLETE",
      connectionId: "connection-1",
      connectionGeneration: 2,
      gameplayViewGeneration: 3,
      relocationRevision: 4,
      resourceVisionRevision: 5,
      populationPreparationGeneration: 6
    });
  });
});
