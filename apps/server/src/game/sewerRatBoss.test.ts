import { describe, expect, it } from "vitest";

import { BossEncounter, DungeonBossHostAdapter } from "./bossFramework.js";
import {
  createSewerRatMinibossController,
  SEWER_RAT_MINIBOSS_PHASE_DURATION_MS
} from "./sewerRatBoss.js";

const definition = {
  id: "sewer_rat_miniboss",
  revision: 1,
  archetypeKey: "sewer_rat_miniboss" as const,
  controllerId: "sewer_rat_miniboss",
  rewardPolicy: { id: "sewer_rat_miniboss", minimumContribution: 1 }
};

describe("sewer rat miniboss controller", () => {
  it("keeps phase deadlines and combat modifiers server-owned across the full cycle", () => {
    let now = 1_000;
    const encounter = new BossEncounter({
      encounterId: "instance:run:rat-warden:1:boss",
      definition,
      host: new DungeonBossHostAdapter({
        instanceId: "instance",
        runId: "run",
        roomId: "rat_warden",
        encounterId: "rat-warden:1:boss",
        participantIds: ["player-1"]
      }),
      mobEntityId: "mob:rat-warden",
      controller: createSewerRatMinibossController(125),
      initialState: "active",
      now: () => now
    });

    expect(encounter.activate()).toBe(false);
    expect(encounter.projection(now)).toMatchObject({
      phaseId: "normal",
      phaseDeadlineAt: now + SEWER_RAT_MINIBOSS_PHASE_DURATION_MS.normal
    });
    expect(encounter.movementOverride).toMatchObject({
      movementSpeedMps: 100,
      outgoingDamageMultiplier: 1,
      incomingDamageMultiplier: 1
    });

    now += SEWER_RAT_MINIBOSS_PHASE_DURATION_MS.normal;
    encounter.tick(now);
    expect(encounter.phase).toBe("steam");
    expect(encounter.movementOverride).toMatchObject({
      movementSpeedMps: 118.75,
      outgoingDamageMultiplier: 2,
      incomingDamageMultiplier: 1
    });

    now += SEWER_RAT_MINIBOSS_PHASE_DURATION_MS.steam;
    encounter.tick(now);
    expect(encounter.phase).toBe("rest");
    expect(encounter.movementOverride).toMatchObject({
      movementSpeedMps: 0,
      outgoingDamageMultiplier: 0,
      incomingDamageMultiplier: 3
    });

    now += SEWER_RAT_MINIBOSS_PHASE_DURATION_MS.rest;
    encounter.tick(now);
    expect(encounter.phase).toBe("normal");
    expect(encounter.movementOverride?.movementSpeedMps).toBe(100);
  });
});
