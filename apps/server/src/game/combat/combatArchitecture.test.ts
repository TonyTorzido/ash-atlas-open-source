import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const engineSource = readFileSync(
  fileURLToPath(new URL("./combatEngine.ts", import.meta.url)),
  "utf8"
);
const serverSource = readFileSync(
  fileURLToPath(new URL("../../application.ts", import.meta.url)),
  "utf8"
);
const runtimeSource = readFileSync(
  fileURLToPath(new URL("../worldRuntime.ts", import.meta.url)),
  "utf8"
);
const websocketSource = readFileSync(
  fileURLToPath(new URL("../../realtime/realtimeApplication.ts", import.meta.url)),
  "utf8"
);
const combatHandlerSource = readFileSync(
  fileURLToPath(new URL("../../realtime/handlers/combatEquipmentHandler.ts", import.meta.url)),
  "utf8"
);
const worldHandlerSource = readFileSync(
  fileURLToPath(new URL("../../realtime/handlers/worldGameplayHandler.ts", import.meta.url)),
  "utf8"
);
const flagOperationsSource = readFileSync(
  fileURLToPath(new URL("../../realtime/flagRealtimeOperations.ts", import.meta.url)),
  "utf8"
);

describe("combat hot-path architecture", () => {
  it("contains no database calls or per-entity timers in the combat engine", () => {
    expect(engineSource).not.toMatch(/pool\.|client\.query\(|setInterval\(|setTimeout\(/);
    expect(engineSource).not.toMatch(/from ["']pg["']/);
  });

  it("keeps the shared world-mob AI executor free of archetype branches", () => {
    const start = engineSource.indexOf("private processWorldMobAi");
    const end = engineSource.indexOf("private processMobRetreats", start);
    const aiExecutor = engineSource.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(aiExecutor).not.toMatch(
      /["'](?:deer|wolf|ogre|bear|mysterious_traveler|sap_crawler|hog|frog|alligator|squid|jellyfish)["']/
    );
  });

  it("advances combat from the authoritative fixed-step server scheduler", () => {
    expect(serverSource).toContain("stepHz: config.SERVER_TICK_HZ");
    const schedulerStep = serverSource.indexOf("onStep: (deltaSeconds) => {");
    const telemetryObservation = serverSource.indexOf(
      "telemetry.observeTick(durationMs)",
      schedulerStep
    );
    const authoritativeTick = serverSource.lastIndexOf(
      "worldRuntime.tick(deltaSeconds",
      telemetryObservation
    );
    expect(schedulerStep).toBeGreaterThan(-1);
    expect(authoritativeTick).toBeGreaterThan(schedulerStep);
    expect(telemetryObservation).toBeGreaterThan(authoritativeTick);
    const orderedStages = [
      "this.commands.drain",
      "this.combat.beginTick()",
      "this.gameState.tick(deltaSeconds,",
      "this.combat.syncPlayer",
      "this.combat.finishTick()",
      "this.flushReplication("
    ];
    for (let index = 1; index < orderedStages.length; index += 1) {
      expect(runtimeSource.indexOf(orderedStages[index]!)).toBeGreaterThan(
        runtimeSource.indexOf(orderedStages[index - 1]!)
      );
    }
    expect(runtimeSource).toContain("this.combat.playerMovementMultiplier(playerId)");
  });

  it("queues high-frequency world commands instead of mutating combat in WebSocket callbacks", () => {
    const callbackSources = `${websocketSource}\n${combatHandlerSource}\n${worldHandlerSource}`;
    expect(callbackSources).not.toMatch(/combat\.startAttack\(/);
    expect(callbackSources).not.toMatch(/combat\.spawnMob\(/);
    expect(callbackSources).not.toMatch(/combat\.clearMobs\(/);
    expect(combatHandlerSource).toContain('kind: "start-attack"');
    expect(worldHandlerSource).toContain('kind: "move"');
  });

  it("publishes the committed flag immediately, then resolves durable resources before global upsert", () => {
    const preparation = flagOperationsSource.indexOf(
      "prepareResourceVision: ({"
    );
    const committedStart = flagOperationsSource.indexOf(
      "committed: ({ session, result }) => {"
    );
    const flagCreated = flagOperationsSource.indexOf(
      'type: "FLAG_CREATED"',
      committedStart
    );
    const completionStart = flagOperationsSource.indexOf(
      "completed: async ({",
      flagCreated
    );
    const preparedAdoption = flagOperationsSource.indexOf(
      "resourceVisionJobs.adoptPreparedExisting(",
      completionStart
    );
    const durableFallback = flagOperationsSource.indexOf(
      "await resourceVisionJobs.subscribeOrReplayCompletion(",
      preparedAdoption
    );
    const flagUpserted = flagOperationsSource.indexOf(
      'type: "FLAG_UPSERTED"',
      durableFallback
    );

    expect(preparation).toBeGreaterThanOrEqual(0);
    expect(committedStart).toBeGreaterThanOrEqual(0);
    expect(flagCreated).toBeGreaterThan(committedStart);
    expect(completionStart).toBeGreaterThan(flagCreated);
    expect(preparedAdoption).toBeGreaterThan(completionStart);
    expect(durableFallback).toBeGreaterThan(preparedAdoption);
    expect(flagUpserted).toBeGreaterThan(durableFallback);
  });

  it("does not broadcast full regional movement snapshots from the 20 Hz tick", () => {
    expect(serverSource).not.toContain('type: "PLAYER_SNAPSHOT"');
    expect(runtimeSource).toContain('type: "PLAYER_DELTA"');
  });
});
