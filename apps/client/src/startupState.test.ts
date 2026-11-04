import { describe, expect, it } from "vitest";

import {
  initialStartupState,
  isCurrentWorldPresentation,
  isStartupPresentationReady,
  reduceStartupState,
  type StartupState
} from "./startupState.js";

describe("startup state", () => {
  const authority = {
    playerId: "player-1",
    connectionId: "connection-1",
    connectionGeneration: 2,
    relocationRevision: 3,
    resourceVisionRevision: 4,
    gameplayViewGeneration: 5,
    populationPreparationGeneration: 6
  } as const;
  it("connects only after the socket, progression, and an authoritative location are ready", () => {
    let state = reduceStartupState(initialStartupState, { type: "socket_open" });
    state = reduceStartupState(state, { type: "welcome" });
    state = reduceStartupState(state, { type: "progression" });
    expect(state.phase).toBe("bootstrap_pending");
    state = reduceStartupState(state, { type: "location" });
    expect(state.phase).toBe("connected");
  });

  it("releases world presentation only after the complete painted snapshot", () => {
    let state = initialStartupState;
    for (const type of ["socket_open", "welcome", "progression", "location"] as const) {
      state = reduceStartupState(state, { type });
    }
    expect(isStartupPresentationReady(state, true)).toBe(false);
    expect(isStartupPresentationReady(state, false)).toBe(true);

    for (const type of [
      "map_ready",
      "map_painted",
      "overlay_ready",
      "player",
      "flags"
    ] as const) {
      state = reduceStartupState(state, { type });
      expect(isStartupPresentationReady(state, true)).toBe(false);
    }
    state = reduceStartupState(state, { type: "world_ready", authority });
    expect(isStartupPresentationReady(state, true)).toBe(false);
    state = reduceStartupState(state, {
      type: "presentation_snapshot",
      authority
    });
    expect(isStartupPresentationReady(state, true)).toBe(true);
  });

  it("never combines readiness from different world authorities", () => {
    let state: StartupState = {
      ...initialStartupState,
      phase: "connected" as const,
      socket: "open" as const,
      welcomeReceived: true,
      progressionReceived: true,
      locationReceived: true,
      mapReady: true,
      mapPainted: true,
      overlayReady: true,
      playerReceived: true,
      flagsReceived: true
    };
    state = reduceStartupState(state, { type: "world_ready", authority });
    state = reduceStartupState(state, {
      type: "presentation_snapshot",
      authority: { ...authority, populationPreparationGeneration: 7 }
    });

    expect(isStartupPresentationReady(state, true)).toBe(false);
    state = reduceStartupState(state, {
      type: "world_preparing",
      authority: { ...authority, populationPreparationGeneration: 7 }
    });
    expect(state).toMatchObject({
      worldReady: false,
      presentationSnapshotReceived: true
    });
  });

  it("rejects an async reveal after a newer authority starts", () => {
    let state: StartupState = {
      ...initialStartupState,
      phase: "connected" as const,
      socket: "open" as const,
      welcomeReceived: true,
      progressionReceived: true,
      locationReceived: true,
      mapReady: true,
      mapPainted: true,
      overlayReady: true,
      playerReceived: true,
      flagsReceived: true
    };
    state = reduceStartupState(state, { type: "world_ready", authority });
    state = reduceStartupState(state, {
      type: "presentation_snapshot",
      authority
    });
    expect(isCurrentWorldPresentation(authority, state, authority)).toBe(true);

    const newer = { ...authority, relocationRevision: 4 };
    expect(isCurrentWorldPresentation(authority, state, newer)).toBe(false);
    state = reduceStartupState(state, {
      type: "world_preparing",
      authority: newer
    });
    expect(isCurrentWorldPresentation(authority, state, authority)).toBe(false);
  });

  it("preserves local renderers but requires fresh server presentation after reconnect", () => {
    let state: StartupState = {
      ...initialStartupState,
      phase: "connected" as const,
      socket: "open" as const,
      welcomeReceived: true,
      progressionReceived: true,
      locationReceived: true,
      mapReady: true,
      mapPainted: true,
      overlayReady: true,
      playerReceived: true,
      flagsReceived: true,
      worldReady: true,
      presentationSnapshotReceived: true
    };

    state = reduceStartupState(state, { type: "socket_open" });
    expect(state).toMatchObject({
      mapReady: true,
      mapPainted: true,
      overlayReady: true,
      playerReceived: false,
      flagsReceived: false,
      worldReady: false,
      worldReadyAuthority: null,
      presentationSnapshotReceived: false
    });
  });

  it("requires a fresh base-map paint after the welcome camera is centered", () => {
    let state = reduceStartupState(initialStartupState, { type: "map_painted" });
    expect(state.mapPainted).toBe(true);
    state = reduceStartupState(state, { type: "map_invalidated" });
    expect(state.mapPainted).toBe(false);
  });

  it("keeps presentation timeout separate from connection recovery", () => {
    expect(reduceStartupState(initialStartupState, { type: "timeout" }).phase).toBe("presentation_error");
    expect(reduceStartupState(initialStartupState, { type: "socket_closed", code: 1006 })).toMatchObject({
      phase: "bootstrap_pending", socket: "connecting", progressionReceived: false,
      locationReceived: false, closeCode: 1006, reconnectFailures: 1
    });
  });

  it("treats a server going-away close as a bounded temporary outage", () => {
    const state = reduceStartupState(initialStartupState, {
      type: "socket_closed",
      code: 1001
    });

    expect(state).toMatchObject({ phase: "bootstrap_pending", reconnectFailures: 1 });
  });

  it("completes bootstrap after reconnect and keeps transient failures recoverable", () => {
    let state = reduceStartupState(initialStartupState, { type: "socket_closed", code: 1006 });
    state = reduceStartupState(state, { type: "socket_open" });
    state = reduceStartupState(state, { type: "welcome" });
    state = reduceStartupState(state, { type: "progression" });
    state = reduceStartupState(state, { type: "location" });
    expect(state).toMatchObject({ phase: "connected", reconnectFailures: 0 });

    state = initialStartupState;
    for (let index = 0; index < 4; index += 1) {
      state = reduceStartupState(state, { type: "socket_closed", code: 1006 });
    }
    expect(state).toMatchObject({
      phase: "bootstrap_pending",
      socket: "connecting",
      reconnectFailures: 4
    });
  });

  it("fails immediately for a non-retryable close code", () => {
    expect(reduceStartupState(initialStartupState, {
      type: "socket_closed",
      code: 4001
    })).toMatchObject({ phase: "recoverable_error", socket: "closed" });
  });

  it("automatically reconnects a transient disconnect after startup completed", () => {
    const connected = {
      ...initialStartupState,
      phase: "connected" as const,
      socket: "open" as const,
      progressionReceived: true,
      locationReceived: true
    };
    expect(reduceStartupState(connected, {
      type: "socket_closed",
      code: 1006
    })).toMatchObject({
      phase: "bootstrap_pending",
      socket: "connecting",
      reconnectFailures: 1
    });
  });

  it("restarts bootstrap when a replacement socket opens without a close event", () => {
    const connected = {
      ...initialStartupState,
      phase: "connected" as const,
      socket: "open" as const,
      welcomeReceived: true,
      progressionReceived: true,
      locationReceived: true
    };

    expect(reduceStartupState(connected, { type: "socket_open" })).toMatchObject({
      phase: "bootstrap_pending",
      socket: "open",
      welcomeReceived: false,
      progressionReceived: false,
      locationReceived: false
    });
  });

  it("resets all bootstrap evidence on retry", () => {
    const failed = reduceStartupState(initialStartupState, { type: "error", message: "bad coordinates" });
    expect(reduceStartupState(failed, { type: "retry" })).toEqual({ ...initialStartupState, attempt: 1 });
  });
});
