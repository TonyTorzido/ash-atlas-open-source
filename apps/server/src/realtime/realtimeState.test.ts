import { describe, expect, it, vi } from "vitest";

import { ClassRealtimeState } from "./classRealtimeState.js";
import { DeveloperRealtimeState } from "./developerRealtimeState.js";
import { ManorRealtimeState } from "./manorRealtimeState.js";
import { PartyRealtimeState } from "./partyRealtimeState.js";
import { SocialRealtimeState } from "./socialRealtimeState.js";
import { TravelRuntimeState } from "./travelRuntimeState.js";

describe("focused realtime state owners", () => {
  it("fences class and party mutations and releases waiters", async () => {
    const classes = new ClassRealtimeState();
    const token = classes.beginMutation("player-1");
    expect(classes.hasActiveMutation("player-1")).toBe(true);
    expect(() => classes.beginMutation("player-1")).toThrow("still pending");
    classes.endMutation("player-1", Symbol("wrong"));
    expect(classes.hasActiveMutation("player-1")).toBe(true);
    classes.endMutation("player-1", token);
    expect(classes.hasActiveMutation("player-1")).toBe(false);

    const parties = new PartyRealtimeState();
    let release!: () => void;
    const operation = parties.runMutation("player-1", () => new Promise<string>((resolve) => {
      release = () => resolve("done");
    }));
    const waiter = parties.waitForMutation("player-1");
    release();
    await expect(operation).resolves.toBe("done");
    await expect(waiter).resolves.toBeUndefined();
  });

  it("bounds developer replay and owns manor/social cleanup", async () => {
    const developer = new DeveloperRealtimeState();
    expect(developer.begin("request")).toBe(true);
    expect(developer.begin("request")).toBe(false);
    developer.finish("request");
    expect(developer.begin("request")).toBe(true);

    const manor = new ManorRealtimeState();
    const unsubscribe = vi.fn();
    manor.setPending("player-1", {
      requestId: "request",
      manorId: "manor",
      placementRevision: 1,
      unsubscribe
    });
    expect(manor.pendingEntriesForManor("manor")).toHaveLength(1);
    expect(manor.takePending("player-1")?.unsubscribe).toBe(unsubscribe);
    expect(manor.pending("player-1")).toBeNull();

    const social = new SocialRealtimeState();
    const flight = Promise.resolve();
    social.beginBootstrap("connection", flight);
    expect(social.bootstrapFlight("connection")).toBe(flight);
    social.finishBootstrap("connection", flight, true);
    expect(social.isBootstrapReady("connection")).toBe(true);
    social.clearConnection("connection");
    expect(social.isBootstrapReady("connection")).toBe(false);
  });

  it("owns population generations and clears transition watchdogs", () => {
    vi.useFakeTimers();
    const travel = new TravelRuntimeState();
    const first = travel.nextPopulationGeneration("player-1");
    const second = travel.nextPopulationGeneration("player-1");
    expect(travel.isPopulationGenerationCurrent("player-1", first)).toBe(false);
    expect(travel.isPopulationGenerationCurrent("player-1", second)).toBe(true);
    const watchdog = setTimeout(vi.fn(), 10) as unknown as ReturnType<typeof setTimeout>;
    const token = Symbol("transition");
    travel.trackTransition(token, {
      playerId: "player-1",
      requestId: "request",
      connectionId: "connection",
      connectionGeneration: 1,
      relocationRevision: 2,
      startedAtMs: 0,
      phase: "committed",
      committed: true,
      watchdog
    });
    expect(travel.transitionsForPlayer("player-1")).toHaveLength(1);
    expect(travel.releaseTransition(token)?.requestId).toBe("request");
    vi.runAllTimers();
    vi.useRealTimers();
  });
});
