import { describe, expect, it } from "vitest";

import {
  resolveProfessionAward,
  type ProfessionActivity
} from "./masteries.js";

describe("Profession Progression V2 award authority", () => {
  it.each([
    [{ kind: "wood-harvest" }, "woodcutter", "harvest", 15],
    [{ kind: "stone-mine" }, "miner", "mining", 25],
    [{ kind: "flag-build" }, "builder", "construction", 25],
    [{ kind: "flag-reinforcement" }, "builder", "reinforcement", 25],
    [{ kind: "construction", baseDurationSeconds: 60 }, "builder", "construction", 100],
    [{ kind: "oil-harvest", harvestedCrude: 37 }, "oil_worker", "oil_harvest", 37],
    [{ kind: "iron-smelt", outcome: "success" }, "metallurgy", "furnace", 1_500],
    [{ kind: "iron-smelt", outcome: "failure" }, "metallurgy", "furnace", 1_000]
  ] as const)("derives %j centrally", (activity, professionId, sourceType, requestedXp) => {
    expect(resolveProfessionAward({
      operationKey: `policy:${activity.kind}`,
      playerId: "player-1",
      activity
    })).toMatchObject({ professionId, sourceType, requestedXp, policyVersion: 2 });
  });

  it("fails closed for unknown activities and invalid construction effort", () => {
    expect(() => resolveProfessionAward({
      operationKey: "policy:unknown",
      playerId: "player-1",
      activity: { kind: "combat" } as unknown as ProfessionActivity
    })).toThrow("Unknown profession activity policy");
    expect(() => resolveProfessionAward({
      operationKey: "policy:bad-duration",
      playerId: "player-1",
      activity: { kind: "construction", baseDurationSeconds: -1 }
    })).toThrow("nonnegative");
  });

  it.each([
    { kind: "huntable-combat", mobArchetype: "wolf", contributions: [{ playerId: "player-1", contributionShare: 1 }] },
    { kind: "breeding-contract" }
  ])("no longer awards retired Hunter or Breeder XP for %j", (activity) => {
    expect(() => resolveProfessionAward({
      operationKey: `policy:retired:${activity.kind}`,
      playerId: "player-1",
      activity: activity as unknown as ProfessionActivity
    })).toThrow("Unknown profession activity policy");
  });
});
