import type {
  PlayerLocationSnapshot,
  PortalDefinition,
  PortalServerMessage
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { PlayerAuthorityFence } from "../playerAuthorityFence.js";
import type { PlayerLocationService } from "./playerLocationService.js";
import { PortalRegistry } from "./portalRegistry.js";
import {
  PortalTransitionCoordinator,
  PortalTransitionError,
  type PortalMovementAdapter
} from "./portalTransitionCoordinator.js";

const source: PlayerLocationSnapshot = {
  kind: "interior", locationType: "cistern_warrens", locationId: "sewer-1",
  instanceId: "sewer:sewer-1", spaceId: "sewer_entrance",
  regionCode: "interior:sewer:sewer-1",
  zoneId: "interior:sewer:sewer-1:sewer_entrance",
  position: { x: 24, y: 28 }, revision: 9, lastPortalId: "world-entry"
};

const definition: PortalDefinition = {
  portalId: "sewer:sewer-1:entrance-to-depths",
  source: {
    kind: "interior", locationType: "cistern_warrens", locationId: "sewer-1",
    instanceId: "sewer:sewer-1", spaceId: "sewer_entrance", position: { x: 140, y: 80 }
  },
  destination: {
    kind: "interior", locationType: "cistern_warrens", locationId: "sewer-1",
    instanceId: "sewer:sewer-1", spaceId: "sewer_depths", position: { x: 10, y: 24 }
  },
  sourceApproach: { x: 134, y: 80 }, sourceThreshold: { x: 140, y: 80 },
  destinationArrival: { x: 16, y: 24 }, interactionLabel: "Go Deeper",
  transitionPresentation: "door", preloadSceneKey: "cistern_warrens/sewer_depths",
  enabled: true, revision: "3"
};

function createHarness(options: {
  enabled?: boolean;
  approachPolicy?: PortalDefinition["approachPolicy"];
  authorizeError?: Error;
  prepareError?: Error;
  prepareErrorOnce?: Error;
  commitError?: Error;
  commitErrorOnce?: Error;
  projectionError?: Error;
  projectionErrorOnce?: Error;
  projectionGate?: Promise<void>;
  completeGate?: Promise<void>;
  replayLocation?: PlayerLocationSnapshot;
  authorityFence?: PlayerAuthorityFence;
} = {}) {
  let location = source;
  let commitErrorOnceUsed = false;
  let movementCallbacks: Parameters<PortalMovementAdapter["approach"]>[0] | null = null;
  const messages: PortalServerMessage[] = [];
  const order: string[] = [];
  let committedRequest: { requestId: string; requestHash: string } | null = null;
  const commitPortalTransition = vi.fn(async (input: {
    expectedRevision: number;
    destination: PortalDefinition["destination"];
    portalId: string;
    requestId: string;
    requestHash: string;
  }) => {
    if (committedRequest?.requestId === input.requestId &&
        committedRequest.requestHash === input.requestHash) {
      return { location, replayed: true };
    }
    if (options.commitErrorOnce && !commitErrorOnceUsed) {
      commitErrorOnceUsed = true;
      throw options.commitErrorOnce;
    }
    if (options.commitError) throw options.commitError;
    order.push("durable-commit");
    if (input.expectedRevision !== location.revision) throw new Error("stale");
    const destination = input.destination;
    location = destination.kind === "world"
      ? {
          kind: "world", regionCode: destination.regionCode, zoneId: `world:${destination.regionCode}`,
          position: destination.position, revision: location.revision + 1, lastPortalId: input.portalId
        }
      : {
          ...destination,
          regionCode: `interior:${destination.instanceId}`,
          zoneId: `interior:${destination.instanceId}:${destination.spaceId}`,
          revision: location.revision + 1,
          lastPortalId: input.portalId
        };
    committedRequest = { requestId: input.requestId, requestHash: input.requestHash };
    return { location, replayed: false };
  });
  const replayPortalTransition = vi.fn(async () => options.replayLocation ?? null);
  const locations = {
    load: vi.fn(async () => location),
    replayPortalTransition,
    commitPortalTransition
  } as unknown as PlayerLocationService;
  const portals = new PortalRegistry();
  portals.register({
    ...definition,
    enabled: options.enabled ?? true,
    ...(options.approachPolicy ? { approachPolicy: options.approachPolicy } : {})
  });
  const stop = vi.fn();
  const authorize = vi.fn(async () => {
    if (options.authorizeError) throw options.authorizeError;
  });
  const project = vi.fn(async () => {
    order.push("destination-projection");
    await options.projectionGate;
    if (options.projectionErrorOnce && project.mock.calls.length === 1) {
      throw options.projectionErrorOnce;
    }
    if (options.projectionError) throw options.projectionError;
  });
  const prepareEffects = vi.fn(() => {
    order.push("effects-prepare");
    if (options.prepareErrorOnce && prepareEffects.mock.calls.length === 1) throw options.prepareErrorOnce;
    if (options.prepareError) throw options.prepareError;
  });
  const applyEffects = vi.fn(() => { order.push("generic-effects"); });
  const completeEffects = vi.fn(async () => {
    order.push("effects-complete");
    await options.completeGate;
  });
  const releaseEffects = vi.fn(() => { order.push("effects-release"); });
  const coordinator = new PortalTransitionCoordinator({
    locations,
    portals,
    movementFor: () => ({
      approach(input) { movementCallbacks = input; },
      stop
    }),
    destinationFor: () => ({ authorize, commit: project }),
    effects: {
      prepare: prepareEffects,
      apply: applyEffects,
      complete: completeEffects,
      release: releaseEffects
    },
    send: (_playerId, message) => {
      if (message.type === "PLAYER_LOCATION_SNAPSHOT") order.push("canonical-publication");
      messages.push(message);
    },
    ...(options.authorityFence ? {
      runWithPlayerAuthority: <T>(playerId: string, operation: () => Promise<T>) =>
        options.authorityFence!.run(playerId, operation)
    } : {}),
    readinessFallbackMs: 60_000
  });
  return {
    coordinator, messages, commitPortalTransition, replayPortalTransition,
    authorize, project, stop, order,
    prepareEffects, applyEffects, completeEffects, releaseEffects,
    get location() { return location; },
    setLocation(next: PlayerLocationSnapshot) { location = next; },
    get movement() { return movementCallbacks; }
  };
}

async function begin(harness: ReturnType<typeof createHarness>, requestId = "request-1") {
  await harness.coordinator.usePortal({
    playerId: "player-1", requestId, portalId: definition.portalId,
    expectedPortalRevision: definition.revision, expectedLocationRevision: source.revision
  });
  const plan = harness.messages.find((message) => message.type === "PORTAL_TRANSITION_PLANNED");
  if (!plan || plan.type !== "PORTAL_TRANSITION_PLANNED") throw new Error("missing plan");
  return plan;
}

describe("PortalTransitionCoordinator", () => {
  it("holds a ready portal commit behind another action on that player", async () => {
    const fence = new PlayerAuthorityFence();
    const harness = createHarness({ authorityFence: fence });
    let release!: () => void;
    const held = fence.run("player-1", () => new Promise<void>((resolve) => { release = resolve; }));
    const plan = await begin(harness);
    harness.coordinator.destinationReady("player-1", plan.transitionId, plan.preloadSceneKey);
    harness.movement?.onThreshold();
    await Promise.resolve();
    expect(harness.commitPortalTransition).not.toHaveBeenCalled();
    release();
    await held;
    await vi.waitFor(() => expect(harness.commitPortalTransition).toHaveBeenCalledOnce());
  });

  it("holds canonical death recovery behind another action on that player", async () => {
    const fence = new PlayerAuthorityFence();
    const harness = createHarness({ authorityFence: fence });
    let release!: () => void;
    const held = fence.run("player-1", () => new Promise<void>((resolve) => { release = resolve; }));
    const recovery = harness.coordinator.recoverToWorldAnchor({
      playerId: "player-1", requestId: "death:held", regionCode: "NM",
      anchor: { lat: 35.1, lon: -106.6 }
    });
    await Promise.resolve();
    expect(harness.commitPortalTransition).not.toHaveBeenCalled();
    release();
    await held;
    await expect(recovery).resolves.toMatchObject({ kind: "world" });
    expect(harness.commitPortalTransition).toHaveBeenCalledOnce();
  });

  it("recovers an interior death through canonical effects and projection to the exact world anchor", async () => {
    const harness = createHarness();
    const anchor = { lat: 35.123456, lon: -106.654321 };

    await expect(harness.coordinator.recoverToWorldAnchor({
      playerId: "player-1",
      requestId: "player-death:one",
      regionCode: "NM",
      anchor
    })).resolves.toMatchObject({ kind: "world", regionCode: "NM", position: anchor });

    expect(harness.commitPortalTransition).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "player-death:one",
      portalId: "recovery:death-anchor",
      destination: { kind: "world", regionCode: "NM", position: anchor }
    }));
    expect(harness.order).toEqual([
      "effects-prepare",
      "durable-commit",
      "generic-effects",
      "destination-projection",
      "canonical-publication",
      "effects-complete",
      "effects-release"
    ]);
  });

  it("replays a committed recovery with the original interior projection after a transient adapter failure", async () => {
    const harness = createHarness({ projectionErrorOnce: new Error("temporary sewer cleanup failure") });
    const recovery = {
      playerId: "player-1",
      requestId: "player-death:retry",
      regionCode: "NM",
      anchor: { lat: 35.1, lon: -106.6 }
    } as const;

    await expect(harness.coordinator.recoverToWorldAnchor(recovery)).rejects.toThrow("temporary sewer cleanup failure");
    expect(harness.location).toMatchObject({ kind: "world", position: recovery.anchor });
    await expect(harness.coordinator.recoverToWorldAnchor(recovery)).resolves.toMatchObject({
      kind: "world",
      position: recovery.anchor
    });

    expect(harness.order.filter((entry) => entry === "durable-commit")).toHaveLength(1);
    expect(harness.project).toHaveBeenCalledTimes(2);
    expect(harness.project).toHaveBeenNthCalledWith(2, expect.objectContaining({ source }));
  });

  it("reloads the recovery source after a confirmed precommit failure while retaining request reuse protection", async () => {
    const harness = createHarness({ commitErrorOnce: new Error("stale revision") });
    const recovery = {
      playerId: "player-1",
      requestId: "player-death:stale-retry",
      regionCode: "NM",
      anchor: { lat: 35.1, lon: -106.6 }
    } as const;

    await expect(harness.coordinator.recoverToWorldAnchor(recovery)).rejects.toThrow("stale revision");
    const advanced: PlayerLocationSnapshot = {
      kind: "world",
      regionCode: "world:advanced",
      zoneId: "world:advanced",
      position: { lat: 36, lon: -107 },
      revision: source.revision + 1,
      lastPortalId: "manor-exit"
    };
    harness.setLocation(advanced);

    await expect(harness.coordinator.recoverToWorldAnchor(recovery)).resolves.toMatchObject({
      kind: "world", position: recovery.anchor, revision: advanced.revision + 1
    });
    expect(harness.commitPortalTransition).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedRevision: advanced.revision
    }));
    await expect(harness.coordinator.recoverToWorldAnchor({
      ...recovery,
      anchor: { lat: 35.2, lon: -106.7 }
    })).rejects.toMatchObject({ code: "REQUEST_ID_REUSED" });
  });

  it("does not steal a foreign transition token when recovery preparation is pending", async () => {
    const harness = createHarness({
      prepareErrorOnce: new PortalTransitionError("TRANSITION_PENDING", "another world transition is active")
    });
    const recovery = {
      playerId: "player-1",
      requestId: "player-death:foreign-token",
      regionCode: "NM",
      anchor: { lat: 35.1, lon: -106.6 }
    } as const;

    await expect(harness.coordinator.recoverToWorldAnchor(recovery)).rejects.toMatchObject({
      code: "TRANSITION_PENDING"
    });
    await expect(harness.coordinator.recoverToWorldAnchor(recovery)).resolves.toMatchObject({
      kind: "world", position: recovery.anchor
    });
    expect(harness.releaseEffects).toHaveBeenCalledWith(expect.objectContaining({ committed: false }));
    expect(harness.commitPortalTransition).toHaveBeenCalledOnce();
  });

  it("replays durable recovery before discarding projection context after an ambiguous commit", async () => {
    const durableLocation: PlayerLocationSnapshot = {
      kind: "world",
      regionCode: "NM",
      zoneId: "world:NM",
      position: { lat: 35.1, lon: -106.6 },
      revision: source.revision + 1,
      lastPortalId: "recovery:death-anchor"
    };
    const harness = createHarness({
      commitErrorOnce: new Error("connection lost after commit"),
      replayLocation: durableLocation
    });

    await expect(harness.coordinator.recoverToWorldAnchor({
      playerId: "player-1",
      requestId: "player-death:ambiguous",
      regionCode: "NM",
      anchor: durableLocation.position
    })).resolves.toEqual(durableLocation);
    expect(harness.replayPortalTransition).toHaveBeenCalledWith(
      "player-1", "player-death:ambiguous", expect.any(String)
    );
    expect(harness.commitPortalTransition).toHaveBeenCalledOnce();
    expect(harness.project).toHaveBeenCalledOnce();
    expect(harness.releaseEffects).toHaveBeenCalledWith(expect.objectContaining({ committed: true }));
  });

  it("waits for an active committing projection before recovering and does not wait on optional completion", async () => {
    let releaseProjection = (): void => undefined;
    const projectionGate = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const completeGate = new Promise<void>(() => undefined);
    const harness = createHarness({ projectionGate, completeGate });
    const plan = await begin(harness);
    harness.coordinator.destinationReady("player-1", plan.transitionId, plan.preloadSceneKey);
    harness.movement?.onThreshold();
    await vi.waitFor(() => expect(harness.commitPortalTransition).toHaveBeenCalledOnce());

    const recovery = harness.coordinator.recoverToWorldAnchor({
      playerId: "player-1",
      requestId: "player-death:committing-exit",
      regionCode: "NM",
      anchor: { lat: 35.1, lon: -106.6 }
    });
    await Promise.resolve();
    expect(harness.commitPortalTransition).toHaveBeenCalledOnce();
    expect(harness.stop).not.toHaveBeenCalled();

    releaseProjection();
    await expect(recovery).resolves.toMatchObject({ kind: "world", revision: source.revision + 2 });
    expect(harness.commitPortalTransition).toHaveBeenCalledTimes(2);
    expect(harness.releaseEffects).not.toHaveBeenCalledWith(expect.objectContaining({ committed: false }));
  });

  it("shares one in-flight recovery for concurrent respawn retries", async () => {
    const harness = createHarness();
    const recovery = {
      playerId: "player-1",
      requestId: "player-death:concurrent",
      regionCode: "NM",
      anchor: { lat: 35.1, lon: -106.6 }
    } as const;

    const [first, second] = await Promise.all([
      harness.coordinator.recoverToWorldAnchor(recovery),
      harness.coordinator.recoverToWorldAnchor(recovery)
    ]);
    expect(first).toEqual(second);
    expect(harness.commitPortalTransition).toHaveBeenCalledOnce();
    expect(harness.project).toHaveBeenCalledOnce();
  });

  it("waits for both authoritative threshold and destination readiness, then preserves the instance", async () => {
    const harness = createHarness();
    const plan = await begin(harness);

    harness.coordinator.destinationReady("player-1", plan.transitionId, plan.preloadSceneKey);
    expect(harness.commitPortalTransition).not.toHaveBeenCalled();
    harness.movement?.onThreshold();

    await vi.waitFor(() => expect(harness.messages.at(-1)).toMatchObject({
      type: "PLAYER_LOCATION_SNAPSHOT"
    }));
    expect(harness.location).toMatchObject({
      kind: "interior", instanceId: source.instanceId, spaceId: "sewer_depths", revision: 10
    });
    expect(harness.project).toHaveBeenCalledOnce();
    expect(harness.applyEffects).toHaveBeenCalledOnce();
    expect(harness.order).toEqual([
      "effects-prepare",
      "durable-commit",
      "generic-effects",
      "destination-projection",
      "canonical-publication",
      "effects-complete",
      "effects-release"
    ]);
  });

  it("commits an explicitly immediate portal without an approach movement", async () => {
    const harness = createHarness({ approachPolicy: "immediate" });
    await harness.coordinator.usePortal({
      playerId: "player-1", requestId: "immediate-request", portalId: definition.portalId,
      expectedPortalRevision: definition.revision, expectedLocationRevision: source.revision,
      approach: "immediate"
    });

    const plan = harness.messages.find((message) => message.type === "PORTAL_TRANSITION_PLANNED");
    if (!plan || plan.type !== "PORTAL_TRANSITION_PLANNED") throw new Error("missing plan");
    expect(harness.stop).toHaveBeenCalledOnce();
    expect(harness.movement).toBeNull();
    expect(harness.messages).toContainEqual({
      type: "PORTAL_TRANSITION_PHASE",
      transitionId: plan.transitionId,
      phase: "threshold_reached"
    });

    harness.coordinator.destinationReady("player-1", plan.transitionId, plan.preloadSceneKey);
    await vi.waitFor(() => expect(harness.commitPortalTransition).toHaveBeenCalledOnce());
    expect(harness.location).toMatchObject({ kind: "interior", spaceId: "sewer_depths", revision: 10 });
  });

  it("refuses an immediate portal use when the portal requires an approach", async () => {
    const harness = createHarness({ approachPolicy: "required" });
    await expect(harness.coordinator.usePortal({
      playerId: "player-1", requestId: "far-request", portalId: definition.portalId,
      expectedPortalRevision: definition.revision, expectedLocationRevision: source.revision,
      approach: "immediate"
    })).rejects.toMatchObject({ code: "PORTAL_IMMEDIATE_UNAVAILABLE" });
    expect(harness.stop).not.toHaveBeenCalled();
    expect(harness.commitPortalTransition).not.toHaveBeenCalled();
  });

  it("replays a completed request without a second durable or domain commit", async () => {
    const harness = createHarness();
    const plan = await begin(harness);
    harness.coordinator.destinationReady("player-1", plan.transitionId, plan.preloadSceneKey);
    harness.movement?.onThreshold();
    await vi.waitFor(() => expect(harness.project).toHaveBeenCalledOnce());

    await harness.coordinator.usePortal({
      playerId: "player-1", requestId: "request-1", portalId: definition.portalId,
      expectedPortalRevision: definition.revision, expectedLocationRevision: source.revision
    });
    expect(harness.commitPortalTransition).toHaveBeenCalledOnce();
    expect(harness.project).toHaveBeenCalledOnce();
    expect(harness.applyEffects).toHaveBeenCalledOnce();
  });

  it("publishes the canonical destination before slow cleanup while keeping the transition active", async () => {
    let releaseCleanup: () => void = () => undefined;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const harness = createHarness({ completeGate: cleanupGate });
    const plan = await begin(harness);
    harness.coordinator.destinationReady("player-1", plan.transitionId, plan.preloadSceneKey);
    harness.movement?.onThreshold();

    await vi.waitFor(() => expect(harness.messages.at(-1)).toMatchObject({
      type: "PLAYER_LOCATION_SNAPSHOT",
      transitionId: plan.transitionId
    }));
    expect(harness.order.indexOf("canonical-publication"))
      .toBeLessThan(harness.order.indexOf("effects-complete"));
    await expect(harness.coordinator.usePortal({
      playerId: "player-1",
      requestId: "request-2",
      portalId: definition.portalId,
      expectedPortalRevision: definition.revision,
      expectedLocationRevision: source.revision
    })).rejects.toMatchObject({ code: "TRANSITION_ACTIVE" });

    releaseCleanup();
    await vi.waitFor(() => expect(harness.releaseEffects).toHaveBeenCalledOnce());
  });

  it("replays the durable destination after reconnect before validating the stale source revision", async () => {
    const destination: PlayerLocationSnapshot = {
      kind: "interior", locationType: "cistern_warrens", locationId: "sewer-1",
      instanceId: source.instanceId, spaceId: "sewer_depths",
      regionCode: source.regionCode,
      zoneId: "interior:sewer:sewer-1:sewer_depths",
      position: { x: 16, y: 24 }, revision: 10,
      lastPortalId: definition.portalId
    };
    const harness = createHarness({ replayLocation: destination });
    await harness.coordinator.usePortal({
      playerId: "player-1", requestId: "request-1", portalId: definition.portalId,
      expectedPortalRevision: definition.revision, expectedLocationRevision: source.revision
    });

    expect(harness.replayPortalTransition).toHaveBeenCalledOnce();
    expect(harness.commitPortalTransition).not.toHaveBeenCalled();
    expect(harness.messages).toEqual([{
      type: "PLAYER_LOCATION_SNAPSHOT", location: destination
    }]);
  });

  it("cancels a precommit transition on disconnect and keeps the source canonical", async () => {
    const harness = createHarness();
    await begin(harness);
    await harness.coordinator.disconnect("player-1");

    expect(harness.stop).toHaveBeenCalledOnce();
    expect(harness.commitPortalTransition).not.toHaveBeenCalled();
    expect(harness.location).toEqual(source);
    expect(harness.releaseEffects).toHaveBeenCalledWith(expect.objectContaining({ committed: false }));
  });

  it("reports a durable commit failure instead of revealing the unchanged source as success", async () => {
    const harness = createHarness({ commitError: new Error("coordinate constraint") });
    const plan = await begin(harness);
    harness.coordinator.destinationReady("player-1", plan.transitionId, plan.preloadSceneKey);
    harness.movement?.onThreshold();

    await vi.waitFor(() => expect(harness.messages.at(-1)).toMatchObject({
      type: "PORTAL_TRANSITION_FAILED",
      code: "PORTAL_TRANSITION_FAILED",
      message: "coordinate constraint",
      location: source
    }));
    expect(harness.stop).toHaveBeenCalledOnce();
    expect(harness.project).not.toHaveBeenCalled();
  });

  it("keeps the source authoritative when generic preparation fails", async () => {
    const harness = createHarness({ prepareError: new Error("warmup unavailable") });
    await expect(begin(harness)).rejects.toThrow("warmup unavailable");
    expect(harness.commitPortalTransition).not.toHaveBeenCalled();
    expect(harness.location).toEqual(source);
    expect(harness.releaseEffects).toHaveBeenCalledWith(expect.objectContaining({
      committed: false
    }));
  });

  it("keeps the durable destination authoritative when destination projection fails", async () => {
    const harness = createHarness({ projectionError: new Error("projection unavailable") });
    const plan = await begin(harness);
    harness.coordinator.destinationReady("player-1", plan.transitionId, plan.preloadSceneKey);
    harness.movement?.onThreshold();

    await vi.waitFor(() => expect(harness.messages.at(-1)).toMatchObject({
      type: "PLAYER_LOCATION_SNAPSHOT",
      location: { revision: source.revision + 1 }
    }));
    expect(harness.commitPortalTransition).toHaveBeenCalledOnce();
    expect(harness.applyEffects).toHaveBeenCalledOnce();
    expect(harness.project).toHaveBeenCalledOnce();
    expect(harness.releaseEffects).toHaveBeenCalledWith(expect.objectContaining({ committed: true }));
    expect(harness.messages).not.toContainEqual(expect.objectContaining({
      type: "PORTAL_TRANSITION_FAILED"
    }));
  });

  it("preserves a committed destination when the connection drops during projection", async () => {
    let releaseProjection: () => void = () => undefined;
    const projectionGate = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const harness = createHarness({ projectionGate });
    const plan = await begin(harness);
    harness.coordinator.destinationReady("player-1", plan.transitionId, plan.preloadSceneKey);
    harness.movement?.onThreshold();
    await vi.waitFor(() => expect(harness.commitPortalTransition).toHaveBeenCalledOnce());

    await harness.coordinator.disconnect("player-1");
    expect(harness.location.revision).toBe(source.revision + 1);
    expect(harness.stop).not.toHaveBeenCalled();
    releaseProjection();
    await vi.waitFor(() => expect(harness.messages.at(-1)).toMatchObject({
      type: "PLAYER_LOCATION_SNAPSHOT",
      location: { revision: source.revision + 1 }
    }));
  });

  it("rejects a newer request while active and ignores late readiness after cancellation", async () => {
    const harness = createHarness();
    const plan = await begin(harness);
    await expect(begin(harness, "request-2")).rejects.toMatchObject({
      code: "TRANSITION_ACTIVE"
    });
    await harness.coordinator.cancel("player-1", plan.transitionId);
    expect(() => harness.coordinator.destinationReady(
      "player-1",
      plan.transitionId,
      plan.preloadSceneKey
    )).toThrow(expect.objectContaining({ code: "STALE_TRANSITION" }));
    expect(harness.commitPortalTransition).not.toHaveBeenCalled();
  });

  it("rejects stale, disabled, and unauthorized use before movement or commit", async () => {
    const stale = createHarness();
    await expect(stale.coordinator.usePortal({
      playerId: "player-1", requestId: "stale", portalId: definition.portalId,
      expectedLocationRevision: source.revision - 1
    })).rejects.toMatchObject({ code: "STALE_LOCATION" });

    const disabled = createHarness({ enabled: false });
    await expect(begin(disabled)).rejects.toMatchObject({ code: "PORTAL_DISABLED" });

    const denied = createHarness({ authorizeError: new PortalTransitionError("ACCESS_DENIED", "locked") });
    await expect(begin(denied)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(denied.commitPortalTransition).not.toHaveBeenCalled();
  });
});
