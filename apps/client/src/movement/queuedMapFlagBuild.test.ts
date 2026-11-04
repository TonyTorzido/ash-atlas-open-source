import { destinationPoint, type PlayerSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  QUEUED_FLAG_BUILD_ARRIVAL_TOLERANCE_M,
  QueuedMapFlagBuildController
} from "./queuedMapFlagBuild.js";

describe("queued map flag build", () => {
  it("waits for acceptance and authoritative matching arrival, then fires once", () => {
    const controller = queued();
    expect(controller.observe(player({ moving: false, lat: 35.0845 }))).toBe("waiting");
    expect(controller.accept("move-1", 7)?.action).toEqual({ kind: "anchor" });
    expect(controller.observe(player({ moving: true, movementRevision: 7 }))).toBe("waiting");
    expect(controller.observe(player({ moving: false, movementRevision: 6, lat: 35.0845 }))).toBe("waiting");
    expect(controller.observe(player({ moving: false, movementRevision: 7, lat: 35.0845 }))).toBe("arrived");
    expect(controller.observe(player({ moving: false, movementRevision: 7, lat: 35.0845 }))).toBe("waiting");
  });

  it("retains an arrived gesture until its placement surface is classified", () => {
    const controller = queued();
    controller.accept("move-1", 7);
    const arrived = player({ moving: false, movementRevision: 7, lat: 35.0845 });

    expect(controller.observe(arrived, false)).toBe("waiting");
    expect(controller.snapshot()).not.toBeNull();
    expect(controller.observe(arrived, true)).toBe("arrived");
    expect(controller.snapshot()).toBeNull();
  });

  it("ignores stale acceptance and rejects only the matching movement", () => {
    const controller = queued();
    expect(controller.accept("older", 8)).toBeNull();
    expect(controller.reject("older")).toBe(false);
    expect(controller.snapshot()?.requestId).toBe("move-1");
    expect(controller.reject("move-1")).toBe(true);
    expect(controller.snapshot()).toBeNull();
  });

  it("cancels on anchor, radius, or relocation change", () => {
    for (const change of [
      { anchorLat: 35.2 },
      { moveLeashRadiusM: 700 },
      { relocationRevision: 2 }
    ]) {
      const controller = queued();
      controller.accept("move-1", 7);
      expect(controller.observe(player(change))).toBe("authority-changed");
      expect(controller.snapshot()).toBeNull();
    }
  });

  it("allows a new command to explicitly cancel the queued action", () => {
    const controller = queued();
    expect(controller.cancel()).toBe(true);
    expect(controller.cancel()).toBe(false);
  });

  it("clears when the accepted movement authoritatively stops away from its target", () => {
    const controller = queued();
    controller.accept("move-1", 7);
    expect(controller.observe(player({ moving: false, lat: 35.0844 }))).toBe("movement-stopped-away");
    expect(controller.snapshot()).toBeNull();
  });

  it("continues automatically through normal arrival jitter outside the old threshold", () => {
    const controller = queued();
    controller.accept("move-1", 7);
    const jitteredArrival = destinationPoint(
      { lat: 35.0845, lon: -106.6504 },
      QUEUED_FLAG_BUILD_ARRIVAL_TOLERANCE_M - 1,
      180
    );

    expect(controller.observe(player({
      moving: false,
      lat: jitteredArrival.lat,
      lon: jitteredArrival.lon
    }))).toBe("arrived");
    expect(controller.snapshot()).toBeNull();
  });

  it("does not let stale acceptance replace a newer queued placement", () => {
    const controller = queued();
    controller.queue({
      requestId: "move-2",
      target: { lat: 35.0846, lon: -106.6504 },
      requested: { lat: 35.0847, lon: -106.6504 },
      authority: {
        anchorLat: 35.0844,
        anchorLon: -106.6504,
        moveLeashRadiusM: 600,
        relocationRevision: 1
      },
      createdAt: 2_000,
      action: { kind: "furnace" }
    });

    expect(controller.accept("move-1", 7)).toBeNull();
    expect(controller.snapshot()?.requestId).toBe("move-2");
  });

  it("preserves an explicitly selected Territory Buoy through acceptance and arrival", () => {
    const controller = queued();
    controller.queue({
      ...controller.snapshot()!,
      requestId: "move-buoy",
      action: { kind: "anchor", anchorKind: "buoy" }
    });

    expect(controller.accept("move-buoy", 9)?.action).toEqual({ kind: "anchor", anchorKind: "buoy" });
    expect(controller.observe(player({ movementRevision: 9, lat: 35.0845 }))).toBe("arrived");
  });
});

function queued(): QueuedMapFlagBuildController {
  const controller = new QueuedMapFlagBuildController();
  controller.queue({
    requestId: "move-1",
    target: { lat: 35.0845, lon: -106.6504 },
    requested: destinationPoint({ lat: 35.0844, lon: -106.6504 }, 800, 0),
    authority: {
      anchorLat: 35.0844,
      anchorLon: -106.6504,
      moveLeashRadiusM: 600,
      relocationRevision: 1
    },
    createdAt: 1_000,
    action: { kind: "anchor" }
  });
  return controller;
}

function player(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    playerId: "player", username: "Player", displayColor: null, regionCode: "NM", zoneId: "world:NM",
    lat: 35.0844, lon: -106.6504, anchorLat: 35.0844, anchorLon: -106.6504,
    moveLeashRadiusM: 600, movementRevision: 7, relocationRevision: 1,
    targetLat: null, targetLon: null, moving: false, online: true,
    updatedAt: "2026-07-22T00:00:00.000Z", ...overrides
  };
}
