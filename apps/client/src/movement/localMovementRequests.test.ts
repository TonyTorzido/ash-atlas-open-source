import { describe, expect, it } from "vitest";

import {
  activePostArrivalTravelRequestId,
  clearPostArrivalTravelBinding,
  LocalMovementRequestTracker,
  POST_ARRIVAL_TRAVEL_BINDING_TTL_MS,
  setPostArrivalTravelBinding
} from "./localMovementRequests.js";

describe("local movement request acceptance correlation", () => {
  it("preserves only the latest movement bound to the matching travel arrival", () => {
    const tracker = new LocalMovementRequestTracker();
    tracker.record("move-a", { lat: 35.1, lon: -106.7 }, 10, "travel-a");
    const latest = tracker.record("move-b", { lat: 35.2, lon: -106.8 }, 20, "travel-a");

    expect(tracker.resetUnlessBoundTo("travel-a")).toEqual(latest);
    tracker.discardBoundTo("travel-b");
    expect(tracker.snapshot()).toEqual(latest);
    tracker.discardBoundTo("travel-a");
    expect(tracker.snapshot()).toBeNull();
  });

  it("does not let acceptance A replace request B after B has been issued", () => {
    const tracker = new LocalMovementRequestTracker();
    tracker.record("request-a", { lat: 35.0845, lon: -106.6503 }, 10);
    const requestB = tracker.record("request-b", { lat: 35.0846, lon: -106.6502 }, 20);
    const startedRequestIds: string[] = [];

    const acceptanceA = tracker.accept("request-a");
    if (acceptanceA.status === "accepted" && acceptanceA.request) {
      startedRequestIds.push(acceptanceA.request.requestId);
    }
    expect(acceptanceA).toMatchObject({
      status: "stale",
      request: requestB
    });
    const acceptanceB = tracker.accept("request-b");
    if (acceptanceB.status === "accepted" && acceptanceB.request) {
      startedRequestIds.push(acceptanceB.request.requestId);
    }
    expect(acceptanceB).toMatchObject({
      status: "accepted",
      request: {
        requestId: requestB.requestId,
        generation: requestB.generation,
        accepted: true
      }
    });
    expect(startedRequestIds).toEqual(["request-b"]);
  });

  it("accepts normal in-order requests and advances their movement generation", () => {
    const tracker = new LocalMovementRequestTracker();
    const requestA = tracker.record("request-a", { lat: 35.0845, lon: -106.6503 }, 10);
    expect(tracker.accept("request-a")).toMatchObject({
      status: "accepted",
      request: {
        requestId: requestA.requestId,
        generation: requestA.generation,
        accepted: true
      }
    });

    const requestB = tracker.record("request-b", { lat: 35.0846, lon: -106.6502 }, 20);
    expect(requestB.generation).toBe(requestA.generation + 1);
    expect(tracker.accept("request-b")).toMatchObject({
      status: "accepted",
      request: {
        requestId: requestB.requestId,
        generation: requestB.generation,
        accepted: true
      }
    });
  });

  it("treats duplicate and untracked acceptances as non-starting events", () => {
    const tracker = new LocalMovementRequestTracker();
    expect(tracker.accept("missing").status).toBe("untracked");
    tracker.record("request", { lat: 35.0845, lon: -106.6503 }, 10);
    expect(tracker.accept("request").status).toBe("accepted");
    expect(tracker.accept("request").status).toBe("duplicate");
    tracker.reset();
    expect(tracker.accept("request").status).toBe("untracked");
  });

  it("distinguishes a stale movement rejection from the latest request", () => {
    const tracker = new LocalMovementRequestTracker();
    tracker.record("request-a", { lat: 35.0845, lon: -106.6503 }, 10);
    tracker.record("request-b", { lat: 35.0846, lon: -106.6502 }, 20);

    expect(tracker.isCurrent("request-a")).toBe(false);
    expect(tracker.isCurrent("request-b")).toBe(true);
    expect(tracker.isCurrent(undefined)).toBe(false);
  });

  it("treats an interaction stop as a newer intent than its approach request", () => {
    const tracker = new LocalMovementRequestTracker();
    tracker.record("approach", { lat: 35.0848, lon: -106.6501 }, 10);
    const stop = tracker.record("stop", { lat: 35.0844, lon: -106.6504 }, 20);

    expect(tracker.accept("approach").status).toBe("stale");
    expect(tracker.accept("stop")).toMatchObject({
      status: "accepted",
      request: {
        requestId: stop.requestId,
        generation: stop.generation,
        accepted: true
      }
    });
  });

  it("clears post-arrival travel binding on matching settlement and expiry only", () => {
    const requestId = { current: null as string | null };
    const expiresAt = { current: 0 };
    const refs = { requestId, expiresAt };
    setPostArrivalTravelBinding(refs, "travel-1", 1_000);

    expect(activePostArrivalTravelRequestId(
      refs,
      1_000 + POST_ARRIVAL_TRAVEL_BINDING_TTL_MS - 1
    )).toBe("travel-1");
    expect(clearPostArrivalTravelBinding(refs, "other-travel")).toBe(false);
    expect(requestId.current).toBe("travel-1");
    expect(activePostArrivalTravelRequestId(
      refs,
      1_000 + POST_ARRIVAL_TRAVEL_BINDING_TTL_MS
    )).toBeNull();
    expect(requestId.current).toBeNull();
    expect(expiresAt.current).toBe(0);

    setPostArrivalTravelBinding(refs, "travel-2", 5_000);
    expect(clearPostArrivalTravelBinding(refs, "travel-2")).toBe(true);
    expect(activePostArrivalTravelRequestId(refs, 5_001)).toBeNull();
  });
});
