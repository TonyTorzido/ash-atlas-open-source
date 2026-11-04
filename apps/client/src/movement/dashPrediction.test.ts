import type { LatLon, PlayerSnapshot } from "@ash-atlas/shared";
import { DASH_DISTANCE_M, DASH_DURATION_MS, destinationPoint, distanceMeters } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { PlayerRenderTimeline } from "./playerRenderSmoothing.js";

/**
 * Headless repro of "walking, press dash, the character barely moves": a 20 Hz server and a
 * 60 fps client with 15 ms one-way latency. The player walks east with the joystick, dashes
 * north, and the joystick resumes walking right after the dash (as JoystickMovement does).
 */
const SPEED = 125;
const LATENCY = 15;
const start: LatLon = { lat: 35.0844, lon: -106.6504 };

type ServerState = { pos: LatLon; rev: number; moving: boolean; target: LatLon | null };

function snapshot(state: ServerState): PlayerSnapshot {
  return {
    playerId: "p1", username: "P", displayColor: null, regionCode: "NM", zoneId: "world:NM",
    lat: state.pos.lat, lon: state.pos.lon, anchorLat: start.lat, anchorLon: start.lon,
    moveLeashRadiusM: 5_000, movementRevision: state.rev, relocationRevision: 0,
    targetLat: state.target?.lat ?? null, targetLon: state.target?.lon ?? null,
    moving: state.moving, online: true, updatedAt: "2026-10-11T00:00:00.000Z"
  };
}

function simulate(pressAt: number) {
  const timeline = new PlayerRenderTimeline();
  timeline.configureLocalPlayer("p1", { speedMps: SPEED, serverTickHz: 20 });
  timeline.applySnapshot([snapshot({ pos: start, rev: 0, moving: false, target: null })], 1_000, 1_000, { sequence: 0 });
  timeline.renderPosition("p1", 1_000);

  const walkTarget = destinationPoint(start, 2_000, 90);
  // Server timeline (server time == client time; only the network adds latency).
  let serverDashFrom: LatLon | null = null;
  let serverDashTo: LatLon | null = null;
  let resumeTarget: LatLon | null = null;
  const dashStart = pressAt + LATENCY;
  const dashEnd = dashStart + DASH_DURATION_MS;
  const walkEastPos = (t: number): LatLon =>
    destinationPoint(start, Math.max(0, SPEED * (Math.min(t, dashStart) - 1_015) / 1_000), 90);
  const serverAt = (t: number): ServerState => {
    if (t < 1_015) return { pos: start, rev: 0, moving: false, target: null };
    if (t < dashStart) return { pos: walkEastPos(t), rev: 1, moving: true, target: walkTarget };
    serverDashFrom ??= walkEastPos(dashStart);
    serverDashTo ??= destinationPoint(serverDashFrom, DASH_DISTANCE_M, 0);
    if (t < dashEnd) {
      return {
        pos: destinationPoint(serverDashFrom, DASH_DISTANCE_M * (t - dashStart) / DASH_DURATION_MS, 0),
        rev: 2, moving: true, target: serverDashTo
      };
    }
    // Landed; the queued joystick resume (if it arrived) starts walking at once.
    if (resumeTarget) {
      return {
        pos: destinationPoint(serverDashTo, SPEED * (t - dashEnd) / 1_000, 90),
        rev: 4, moving: true, target: resumeTarget
      };
    }
    return { pos: serverDashTo, rev: 3, moving: false, target: null };
  };

  timeline.beginLocalAnticipation("walk-1", 1, walkTarget, 1_000);
  let walkAccepted = false;
  let dashAccepted = false;
  let resumeSentAt: number | null = null;
  let resumeAccepted = false;
  let pressPosition: LatLon | null = null;
  const frames: Array<{ t: number; pos: LatLon }> = [];
  let nextSnapshot = 1_050;
  let sequence = 1;
  for (let t = 1_000; t <= pressAt + 600; t += 1_000 / 60) {
    while (nextSnapshot + LATENCY <= t) {
      const state = serverAt(nextSnapshot);
      timeline.applyDelta([{ kind: "movement", playerId: "p1", lat: state.pos.lat, lon: state.pos.lon,
        movementRevision: state.rev, relocationRevision: 0, targetLat: state.target?.lat ?? null,
        targetLon: state.target?.lon ?? null, moving: state.moving, online: true,
        updatedAt: "2026-10-11T00:00:00.000Z" }], [], nextSnapshot, nextSnapshot + LATENCY, { sequence: sequence++ });
      nextSnapshot += 50;
    }
    if (!walkAccepted && t >= 1_030) {
      timeline.acceptLocalAnticipation("walk-1", walkTarget, 1);
      walkAccepted = true;
    }
    if (!pressPosition && t >= pressAt) {
      const rendered = timeline.renderPosition("p1", t)!;
      pressPosition = { lat: rendered.lat, lon: rendered.lon };
      timeline.beginLocalDash("dash-1", 2, destinationPoint(pressPosition, DASH_DISTANCE_M, 0), DASH_DURATION_MS, t);
    }
    if (pressPosition && !dashAccepted && t >= pressAt + 2 * LATENCY) {
      serverAt(dashStart);
      timeline.acceptLocalAnticipation("dash-1", serverDashTo!, 2);
      dashAccepted = true;
    }
    if (pressPosition && resumeSentAt === null && !timeline.isLocalDashActive(t) && t >= pressAt + DASH_DURATION_MS) {
      const rendered = timeline.renderPosition("p1", t)!;
      resumeTarget = destinationPoint(rendered, SPEED * 0.7, 90);
      resumeSentAt = t;
      timeline.beginLocalAnticipation("walk-2", 3, resumeTarget, t);
    }
    if (resumeSentAt !== null && !resumeAccepted && t >= resumeSentAt + 2 * LATENCY) {
      timeline.acceptLocalAnticipation("walk-2", resumeTarget!, 4);
      resumeAccepted = true;
    }
    frames.push({ t, pos: timeline.renderPosition("p1", t)! });
  }
  return { frames, pressPosition: pressPosition! };
}

/** Northward progress (m) of the rendered player since the press. */
function northProgress(from: LatLon, to: LatLon): number {
  const sign = to.lat >= from.lat ? 1 : -1;
  return sign * distanceMeters(from, { lat: to.lat, lon: from.lon });
}

describe("local dash prediction (regression)", () => {
  it("renders at least 80% of the dash distance within 250 ms while walking", () => {
    const pressAt = 1_600;
    const { frames, pressPosition } = simulate(pressAt);
    const at250 = frames.filter((frame) => frame.t <= pressAt + 250).at(-1)!;
    expect(northProgress(pressPosition, at250.pos)).toBeGreaterThanOrEqual(DASH_DISTANCE_M * 0.8);
    // And it stays there: no snap back south afterwards.
    const later = frames.at(-1)!;
    expect(northProgress(pressPosition, later.pos)).toBeGreaterThanOrEqual(DASH_DISTANCE_M * 0.8);
  });
});
