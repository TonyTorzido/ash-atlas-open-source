import { describe, expect, it } from "vitest";
import { parseServerMessage } from "./serverMessageParser.js";

describe("confirmed Bomber presentation cues", () => {
  const baseline = { type: "MILITARY_INDUSTRY_STATE", requestId: "snapshot", snapshot: {} };
  const cue = { requestId: "bomb-1", groupId: "bomber-1", occurredAt: 5000,
    position: { lat: 40, lon: -105 }, targetPosition: { lat: 40.001, lon: -105 } };

  it("round-trips optional committed cues while preserving cue-free reconnect snapshots", () => {
    expect(parseServerMessage(JSON.stringify(baseline))).toEqual(baseline);
    const state = { ...baseline, bomberDetonations: [cue] };
    expect(parseServerMessage(JSON.stringify(state))).toEqual(state);
    const changed = { ...state, type: "MILITARY_INDUSTRY_CHANGED", replayed: false };
    expect(parseServerMessage(JSON.stringify(changed))).toEqual(changed);
  });

  it("rejects a completion without the independent target coordinates needed after deletion", () => {
    const { targetPosition: _target, ...incomplete } = cue;
    expect(() => parseServerMessage(JSON.stringify({ ...baseline, bomberDetonations: [incomplete] }))).toThrow();
  });
});
