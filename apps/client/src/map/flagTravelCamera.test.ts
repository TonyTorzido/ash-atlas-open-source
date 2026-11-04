import { describe, expect, it } from "vitest";

import {
  cubicEaseInOut,
  FLAG_TRAVEL_CAMERA_AUTHORITY_DEAD_ZONE_PX,
  FLAG_TRAVEL_CAMERA_MAX_DURATION_MS,
  FLAG_TRAVEL_CAMERA_MIN_DURATION_MS,
  FlagTravelCameraTransactionOwner,
  planFlagTravelCamera,
  planFlagTravelCameraCorrection,
  shouldReapplyFlagTravelCameraTransform
} from "./flagTravelCamera.js";

const requestedDestination = { lat: 40, lon: -105 };

function beginTransaction(
  owner: FlagTravelCameraTransactionOwner,
  requestId = "travel-1",
  generation = 1
) {
  return owner.begin({
    requestId,
    generation,
    requestedDestination
  }).transaction;
}

describe("flag travel camera planning", () => {
  it("uses a continuous duration on both sides of the former distance threshold", () => {
    const before = planFlagTravelCamera({
      current: { x: 0, y: 0 },
      destination: { x: 398, y: 0 },
      viewport: { width: 380, height: 600 },
      reducedMotion: false
    });
    const after = planFlagTravelCamera({
      current: { x: 0, y: 0 },
      destination: { x: 402, y: 0 },
      viewport: { width: 380, height: 600 },
      reducedMotion: false
    });

    expect(before.kind).toBe("ease");
    expect(after.kind).toBe("ease");
    if (before.kind !== "ease" || after.kind !== "ease") return;
    expect(before.viewportDistance).toBeLessThan(1.05);
    expect(after.viewportDistance).toBeGreaterThan(1.05);
    expect(after.durationMs).toBeGreaterThan(before.durationMs);
    expect(after.durationMs - before.durationMs).toBeLessThan(10);
    expect(before.plan).toBe("continuous");
    expect(after.plan).toBe("continuous");
  });

  it("uses cubic ease-in-out with a visible deceleration", () => {
    const plan = planFlagTravelCamera({
      current: { x: 0, y: 0 },
      destination: { x: 600, y: 0 },
      viewport: { width: 1_000, height: 600 },
      reducedMotion: false
    });

    expect(plan.kind).toBe("ease");
    if (plan.kind !== "ease") return;
    expect(plan.easing).toBe(cubicEaseInOut);
    expect(plan.easing(0.25)).toBeCloseTo(0.0625);
    expect(plan.easing(0.5)).toBe(0.5);
    expect(plan.easing(0.75)).toBeCloseTo(0.9375);
  });

  it("scales normal flag travel from 560 to 1300 milliseconds by viewport distance", () => {
    const tiny = planFlagTravelCamera({
      current: { x: 0, y: 0 },
      destination: { x: 1, y: 0 },
      viewport: { width: 1_000, height: 600 },
      reducedMotion: false
    });
    const huge = planFlagTravelCamera({
      current: { x: 0, y: 0 },
      destination: { x: 10_000, y: 0 },
      viewport: { width: 1_000, height: 600 },
      reducedMotion: false
    });

    expect(tiny.kind).toBe("ease");
    expect(huge.kind).toBe("ease");
    if (tiny.kind !== "ease" || huge.kind !== "ease") return;
    expect(tiny.durationMs).toBeGreaterThanOrEqual(
      FLAG_TRAVEL_CAMERA_MIN_DURATION_MS
    );
    expect(tiny.durationMs).toBeLessThan(huge.durationMs);
    expect(huge.durationMs).toBe(FLAG_TRAVEL_CAMERA_MAX_DURATION_MS);
  });

  it("still jumps atomically for reduced motion", () => {
    expect(planFlagTravelCamera({
      current: { x: 0, y: 0 },
      destination: { x: 10, y: 10 },
      viewport: { width: 1_000, height: 600 },
      reducedMotion: true
    })).toMatchObject({ kind: "jump", reason: "reduced-motion" });
  });
});

describe("flag travel camera transaction ownership", () => {
  it("adopts arrival during an active pan without changing its generation", () => {
    const owner = new FlagTravelCameraTransactionOwner();
    beginTransaction(owner);

    const decision = owner.adoptArrival(
      "travel-1",
      { lat: 40.00001, lon: -105 },
      2
    );

    expect(decision).toMatchObject({
      kind: "adopted",
      transaction: {
        generation: 1,
        lifecycle: "arrival-adopted",
        authoritativeDestination: null
      }
    });
  });

  it("queues a material arrival correction until the active pan completes", () => {
    const owner = new FlagTravelCameraTransactionOwner();
    beginTransaction(owner);

    const arrival = owner.adoptArrival(
      "travel-1",
      { lat: 40.001, lon: -105 },
      20
    );
    expect(arrival).toMatchObject({
      kind: "correction-required",
      startImmediately: false,
      transaction: { generation: 1, lifecycle: "correction-pending" }
    });

    const completion = owner.completeGeneration(1);
    expect(completion).toMatchObject({
      kind: "correction-required",
      transaction: { generation: null, lifecycle: "correction-pending" }
    });
    expect(owner.beginCorrection("travel-1", 2)).toBe(true);
    expect(owner.current()).toMatchObject({
      generation: 2,
      lifecycle: "correcting",
      authoritativeDestination: { lat: 40.001, lon: -105 }
    });
  });

  it("ignores an authoritative discrepancy at or inside eight pixels", () => {
    const owner = new FlagTravelCameraTransactionOwner();
    beginTransaction(owner);

    expect(owner.adoptArrival(
      "travel-1",
      { lat: 41, lon: -104 },
      FLAG_TRAVEL_CAMERA_AUTHORITY_DEAD_ZONE_PX
    )).toMatchObject({
      kind: "adopted",
      transaction: { authoritativeDestination: null }
    });
  });

  it("stores a material authoritative destination and plans a short correction", () => {
    const owner = new FlagTravelCameraTransactionOwner();
    beginTransaction(owner);
    const authoritativeDestination = { lat: 40.001, lon: -105.001 };

    expect(owner.adoptArrival(
      "travel-1",
      authoritativeDestination,
      FLAG_TRAVEL_CAMERA_AUTHORITY_DEAD_ZONE_PX + 1
    )).toMatchObject({
      kind: "correction-required",
      transaction: { authoritativeDestination }
    });
    const correction = planFlagTravelCameraCorrection({
      projectedDistancePx: 20,
      reducedMotion: false
    });
    expect(correction.kind).toBe("ease");
    if (correction.kind !== "ease") return;
    expect(correction.durationMs).toBeGreaterThanOrEqual(100);
    expect(correction.durationMs).toBeLessThanOrEqual(150);
    expect(correction.easing).toBe(cubicEaseInOut);
  });

  it("reapplies the synchronized overlay transform after presentation recreation", () => {
    const owner = new FlagTravelCameraTransactionOwner();
    const transaction = beginTransaction(owner);

    expect(shouldReapplyFlagTravelCameraTransform(transaction)).toBe(true);
    owner.completeGeneration(1);
    expect(
      shouldReapplyFlagTravelCameraTransform(owner.current())
    ).toBe(false);
  });

  it("replaces first-click ownership with the second flag click", () => {
    const owner = new FlagTravelCameraTransactionOwner();
    beginTransaction(owner, "travel-1", 1);

    const replacement = owner.begin({
      requestId: "travel-2",
      generation: 2,
      requestedDestination: { lat: 41, lon: -104 }
    });

    expect(replacement.replaced).toMatchObject({
      requestId: "travel-1",
      lifecycle: "replaced"
    });
    expect(Object.isFrozen(replacement.transaction.requestedDestination)).toBe(
      true
    );
    expect(owner.current()).toMatchObject({
      requestId: "travel-2",
      generation: 2,
      requestedDestination: { lat: 41, lon: -104 }
    });
    expect(owner.adoptArrival("travel-1", requestedDestination, 0)).toEqual({
      kind: "suppressed"
    });
  });

  it("cancels ownership on direct user camera interaction", () => {
    const owner = new FlagTravelCameraTransactionOwner();
    beginTransaction(owner);

    expect(owner.cancel("cancelled")).toMatchObject({
      requestId: "travel-1",
      lifecycle: "cancelled"
    });
    expect(owner.current()).toBeNull();
    expect(owner.adoptArrival("travel-1", requestedDestination, 0)).toEqual({
      kind: "suppressed"
    });
  });

  it("does not request a second recenter when matching arrival follows pan completion", () => {
    const owner = new FlagTravelCameraTransactionOwner();
    beginTransaction(owner);

    expect(owner.completeGeneration(1)).toMatchObject({
      kind: "awaiting-arrival",
      transaction: { generation: null, lifecycle: "awaiting-arrival" }
    });
    expect(owner.adoptArrival("travel-1", requestedDestination, 0)).toMatchObject({
      kind: "completed",
      transaction: { lifecycle: "completed" }
    });
    expect(owner.current()).toBeNull();
  });
});
