import type { PlayerSnapshot } from "@ash-atlas/shared";
import { DEFAULT_PLAYER_SPEED_MPS, distanceMeters, moveToward } from "@ash-atlas/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { noteMotionLeadLimit } from "../perf/motionReport.js";

import {
  clearMovementTrace,
  getMovementTrace,
  setMovementTraceEnabled
} from "./movementDebugTrace.js";
import {
  PLAYER_INTERPOLATION_DELAY_MS,
  PlayerRenderTimeline
} from "./playerRenderSmoothing.js";

vi.mock("../perf/motionReport.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../perf/motionReport.js")>(),
  noteMotionLeadLimit: vi.fn()
}));

describe("authoritative player render timeline", () => {
  beforeEach(() => {
    setMovementTraceEnabled(false);
    clearMovementTrace();
  });

  it("interpolates smoothly between timestamped authoritative samples", () => {
    const timeline = new PlayerRenderTimeline(100);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const end = playerSnapshot({ lat: 35.0844, lon: -106.6494 });
    timeline.applySnapshot([start], 1_000, 1_050, { sequence: 0 });
    timeline.applyDelta([movementSample(end)], [], 1_100, 1_150, { sequence: 1 });

    const frames = [1_166, 1_183, 1_200].map((clientNowMs) =>
      timeline.renderPosition(start.playerId, clientNowMs)!
    );

    expect(frames[0]!.lon).toBeGreaterThan(start.lon);
    expect(frames[1]!.lon).toBeGreaterThan(frames[0]!.lon);
    expect(frames[2]!.lon).toBeGreaterThan(frames[1]!.lon);
    expect(frames[2]!.lon).toBeLessThan(end.lon);
  });

  it("renders 20 Hz authoritative samples smoothly at 500 m/s", () => {
    expect(PLAYER_INTERPOLATION_DELAY_MS).toBe(150);
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({
      lat: 35.0844,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const samples = [0, 25, 50, 75].map((meters) => snapshotEastOf(start, meters, {
      moving: true,
      movementRevision: 1
    }));
    timeline.applySnapshot([samples[0]!], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([movementSample(samples[1]!)], [], 1_050, 1_050, { sequence: 1 });
    timeline.applyDelta([movementSample(samples[2]!)], [], 1_100, 1_100, { sequence: 2 });
    timeline.applyDelta([movementSample(samples[3]!)], [], 1_150, 1_150, { sequence: 3 });

    const frames = [1_150, 1_166, 1_182, 1_198, 1_214, 1_230, 1_246, 1_262, 1_278, 1_294]
      .map((clientNowMs) => timeline.renderPosition(start.playerId, clientNowMs)!);
    const progressM = frames.map((position) => distanceMeters(start, position));

    expect(progressM[0]).toBeCloseTo(0, 2);
    expect(progressM[1]).toBeCloseTo(8, 1);
    expect(progressM).toEqual([...progressM].sort((left, right) => left - right));
    for (let index = 1; index < frames.length; index += 1) {
      expect(distanceMeters(frames[index - 1]!, frames[index]!)).toBeLessThanOrEqual(10.1);
    }
    expect(progressM.at(-1)).toBeCloseTo(72, 1);
    expect(distanceMeters(start, timeline.renderPosition(start.playerId, 1_310)!))
      .toBeCloseTo(75, 1);
  });

  it("uses the same timestamped authority path for two remote players", () => {
    const timeline = new PlayerRenderTimeline(100);
    const local = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const remote = playerSnapshot({
      playerId: "remote",
      lat: 35.0845,
      lon: -106.6504
    });
    timeline.applySnapshot([local, remote], 1_000, 1_020, { sequence: 0 });

    const localNext = playerSnapshot({ lat: local.lat, lon: -106.6494 });
    const remoteNext = playerSnapshot({
      playerId: remote.playerId,
      lat: remote.lat,
      lon: -106.6494
    });
    timeline.applyDelta(
      [movementSample(localNext), movementSample(remoteNext)],
      [],
      1_100,
      1_120,
      { sequence: 1 }
    );

    const localPosition = timeline.renderPosition(local.playerId, 1_170)!;
    const remotePosition = timeline.renderPosition(remote.playerId, 1_170)!;
    expect(localPosition.lon - local.lon).toBeCloseTo(remotePosition.lon - remote.lon, 10);
    expect(localPosition.lon).toBeGreaterThan(local.lon);
    expect(localPosition.lon).toBeLessThan(localNext.lon);
    expect(timeline.sampleCount(local.playerId)).toBe(2);
    expect(timeline.sampleCount(remote.playerId)).toBe(2);
  });

  it("snaps a remote player on relocation and rejects delayed old-epoch movement", () => {
    const timeline = new PlayerRenderTimeline(100);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504, relocationRevision: 0 });
    const walking = snapshotEastOf(start, 10, {
      moving: true,
      movementRevision: 1,
      relocationRevision: 0
    });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([movementSample(walking)], [], 1_050, 1_050, { sequence: 1 });
    expect(timeline.sampleCount(start.playerId)).toBe(2);

    const relocated = snapshotEastOf(start, 2_000, {
      moving: false,
      movementRevision: 2,
      relocationRevision: 1,
      targetLat: null,
      targetLon: null
    });
    timeline.applyDelta([movementSample(relocated)], [], 1_100, 1_100, { sequence: 2 });

    expect(timeline.renderPosition(start.playerId, 1_100)).toMatchObject({
      lat: relocated.lat,
      lon: relocated.lon
    });
    expect(timeline.sampleCount(start.playerId)).toBe(1);

    const delayedOldMovement = snapshotEastOf(start, 20, {
      moving: true,
      movementRevision: 99,
      relocationRevision: 0
    });
    timeline.applyDelta([movementSample(delayedOldMovement)], [], 1_200, 1_200, { sequence: 3 });
    expect(timeline.renderPosition(start.playerId, 1_300)).toMatchObject({
      lat: relocated.lat,
      lon: relocated.lon
    });
    expect(timeline.sampleCount(start.playerId)).toBe(1);
  });

  it("snaps the local player, clears old intent, and resumes interpolation in the new epoch", () => {
    const timeline = new PlayerRenderTimeline(100);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504, relocationRevision: 0 });
    timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    const oldTarget = eastOf(start, 1_000);
    timeline.beginLocalAnticipation("old-move", 1, oldTarget, 1_000);

    const relocated = snapshotEastOf(start, 2_000, {
      movementRevision: 2,
      relocationRevision: 1,
      moving: false,
      targetLat: null,
      targetLon: null
    });
    timeline.applyDelta([movementSample(relocated)], [], 1_100, 1_100, { sequence: 1 });
    expect(timeline.renderPosition(start.playerId, 1_100)).toMatchObject({
      lat: relocated.lat,
      lon: relocated.lon
    });
    expect(timeline.acceptLocalAnticipation("old-move", oldTarget, 1)).toBe(false);

    const walking = snapshotEastOf(relocated, 25, {
      movementRevision: 3,
      relocationRevision: 1,
      moving: true
    });
    timeline.applyDelta([movementSample(walking)], [], 1_150, 1_150, { sequence: 2 });
    const before = timeline.renderPosition(start.playerId, 1_150)!;
    const after = timeline.renderPosition(start.playerId, 1_166)!;
    expect(distanceMeters(relocated, before)).toBeCloseTo(0, 2);
    expect(distanceMeters(relocated, after)).toBeGreaterThan(0);
    expect(distanceMeters(relocated, after)).toBeLessThan(25);
  });

  it("predicts water legs at the server's per-segment speed", () => {
    const timeline = new PlayerRenderTimeline(100);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const target = eastOf(start, 1_000);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 100, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("water-move", 1, target, 1_000);
    expect(timeline.acceptLocalAnticipation("water-move", target, 1, {
      origin: { lat: start.lat, lon: start.lon },
      segments: [{ startM: 0, multiplier: 0.5 }]
    })).toBe(true);
    const after = timeline.renderPosition(start.playerId, 1_100)!;
    // 100 m/s at half speed for 100 ms.
    expect(distanceMeters(start, after)).toBeCloseTo(5, 1);
  });

  it("keeps duplicate relocation samples idempotent and snaps consecutive teleports", () => {
    const timeline = new PlayerRenderTimeline(100);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504, relocationRevision: 0 });
    const first = snapshotEastOf(start, 500, { movementRevision: 1, relocationRevision: 1 });
    const second = snapshotEastOf(start, 1_000, { movementRevision: 2, relocationRevision: 2 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([movementSample(first)], [], 1_050, 1_050, { sequence: 1 });
    timeline.applyDelta([movementSample(first)], [], 1_050, 1_060, { sequence: 2 });
    expect(timeline.sampleCount(start.playerId)).toBe(1);
    timeline.applyDelta([movementSample(second)], [], 1_100, 1_100, { sequence: 3 });
    expect(timeline.renderPosition(start.playerId, 1_100)).toMatchObject({
      lat: second.lat,
      lon: second.lon
    });
    expect(timeline.sampleCount(start.playerId)).toBe(1);
  });

  it("moves continuously at 60 Hz across drift-compensated authority delivered every 62 ms", () => {
    setMovementTraceEnabled(true);
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const target = snapshotEastOf(start, 2_000);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    const before = timeline.renderPosition(start.playerId, 1_000)!;

    timeline.beginLocalAnticipation("move-1", 1, target, 1_000);
    timeline.acceptLocalAnticipation("move-1", target, 1);
    const frames = [before];
    let authoritySequence = 0;
    for (let frame = 1; frame <= 90; frame += 1) {
      const clientNowMs = 1_000 + frame * (1_000 / 60);
      const nextAuthoritySequence = Math.floor((clientNowMs - 1_000) / 62);
      if (nextAuthoritySequence > authoritySequence) {
        authoritySequence = nextAuthoritySequence;
        const simulatedSteps = Math.floor((authoritySequence * 62) / 50);
        const authority = snapshotEastOf(start, simulatedSteps * 25, {
          moving: true,
          movementRevision: 1,
          targetLat: target.lat,
          targetLon: target.lon
        });
        timeline.applyDelta(
          [movementSample(authority)],
          [],
          1_000 + simulatedSteps * 50,
          1_000 + authoritySequence * 62,
          { sequence: authoritySequence }
        );
      }
      frames.push(timeline.renderPosition(start.playerId, clientNowMs)!);
    }

    const displacements = frames.slice(1).map((frame, index) =>
      distanceMeters(frames[index]!, frame)
    );
    const progress = frames.map((frame) => distanceMeters(start, frame));
    const averageVelocityMps = progress.at(-1)! / 1.5;

    expect(displacements[0]).toBeCloseTo(500 / 60, 1);
    expect(displacements.every((distanceM) => distanceM > 0.1)).toBe(true);
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
    expect(averageVelocityMps).toBeGreaterThan(480);
    expect(averageVelocityMps).toBeLessThanOrEqual(501);
    expect(Math.max(...displacements)).toBeLessThan(10);
    expect(getMovementTrace()).toContainEqual(expect.objectContaining({
      messageType: "LOCAL_FIRST_MOVEMENT_FRAME",
      requestId: "move-1",
      movementGeneration: 1,
      reason: "first-position-change"
    }));
  });

  it("recovers a 120 ms local render hitch without discarding movement time", () => {
    setMovementTraceEnabled(true);
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const target = snapshotEastOf(start, 1_000);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("move-1", 1, target, 1_000);

    const afterHitch = timeline.renderPosition(start.playerId, 1_120)!;

    expect(distanceMeters(start, afterHitch)).toBeCloseTo(60, 1);
    const renderTrace = getMovementTrace().find(
      (entry) => entry.messageType === "LOCAL_RENDER_FRAME"
    );
    expect(renderTrace).toMatchObject({
      messageType: "LOCAL_RENDER_FRAME",
      rawFrameMs: 120,
      consumedFrameMs: 120,
      discardedFrameMs: 0,
      authorityAgeMs: 120,
      leadCapHeld: false
    });
    expect(renderTrace?.predictionLeadM).toBeCloseTo(60, 1);
  });

  it.each([
    [10, 100],
    [20, 62.5],
    [60, 62.5]
  ])("holds an unconfirmed local lead at twice the budget (four ticks, floored at 250 ms) at %d Hz", (serverTickHz, expectedLeadM) => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const target = snapshotEastOf(start, 500);
    timeline.configureLocalPlayer(start.playerId, {
      speedMps: DEFAULT_PLAYER_SPEED_MPS,
      serverTickHz
    });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);

    timeline.beginLocalAnticipation("move-1", 1, target, 1_000);
    timeline.acceptLocalAnticipation("move-1", target, 1);
    renderFrames(timeline, start.playerId, 1_016, 3_000);
    const held = timeline.renderPosition(start.playerId, 3_017)!;

    expect(distanceMeters(start, held)).toBeCloseTo(expectedLeadM, 1);
    expect(timeline.renderPosition(start.playerId, 3_033)).toEqual(held);
  });

  it.each([200, 500, 1_000])("eases a real %d ms authority stall and never passes twice the lead budget", (stallMs) => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const target = snapshotEastOf(start, 1_000);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("move-1", 1, target, 1_000);
    timeline.acceptLocalAnticipation("move-1", target, 1);

    const frames = renderFrames(timeline, start.playerId, 1_016, 1_000 + stallMs);
    const progress = frames.map((position) => distanceMeters(start, position));

    // 500 m/s x 250 ms budget: free up to 150 m (budget + one tick), eased past it, held at 250 m.
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
    expect(Math.max(...progress)).toBeLessThanOrEqual(250.01);
    // Every step short of the hard limit keeps at least 85% of the walking speed (the bounded soft pull).
    progress.slice(1).forEach((value, index) => {
      if (value < 249.99) expect(value - progress[index]!).toBeGreaterThanOrEqual(500 * 0.016 * 0.85 - 0.01);
    });
    if (stallMs >= 1_000) {
      expect(progress.at(-1)).toBeCloseTo(250, 1);
      expect(frames.at(-1)).toEqual(frames.at(-2));
    } else {
      expect(progress.at(-1)).toBeGreaterThan(Math.min(150, 500 * (stallMs - 16) / 1_000) - 0.01);
    }
  });

  it("lets same-target authority catch up without a backward local frame", () => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const target = snapshotEastOf(start, 500);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("move-1", 1, target, 1_000);
    timeline.acceptLocalAnticipation("move-1", target, 1);
    const anticipated = timeline.renderPosition(start.playerId, 1_050)!;

    const authority = snapshotEastOf(start, 20, {
      moving: true,
      movementRevision: 1,
      targetLat: target.lat,
      targetLon: target.lon
    });
    timeline.applyDelta([movementSample(authority)], [], 1_050, 1_050, { sequence: 1 });
    const recovery = renderFrames(timeline, start.playerId, 1_066, 1_130);
    const progress = [anticipated, ...recovery].map((position) => distanceMeters(start, position));

    expect(progress).toEqual([...progress].sort((left, right) => left - right));
    for (const frame of recovery) {
      expect(distanceMeters(authority, frame)).toBeLessThanOrEqual(50.01);
    }
    expect(timeline.sampleCount(start.playerId)).toBe(1);
  });

  it("returns a rare rejected local request to authority with a bounded soft correction", () => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const target = snapshotEastOf(start, 500);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("move-1", 1, target, 1_000);
    const ahead = timeline.renderPosition(start.playerId, 1_050)!;

    expect(timeline.rejectLocalAnticipation("move-1", 1_050)).toBe(true);
    const correction = [1_066, 1_100, 1_154]
      .map((clientNowMs) => timeline.renderPosition(start.playerId, clientNowMs)!);

    expect(distanceMeters(start, ahead)).toBeCloseTo(25, 1);
    expect(distanceMeters(start, correction[0]!)).toBeGreaterThan(0);
    expect(distanceMeters(ahead, correction[0]!)).toBeLessThan(25);
    expect(correction.at(-1)).toMatchObject({ lat: start.lat, lon: start.lon });
    expect(timeline.renderPosition(start.playerId, 1_170)).toEqual(correction.at(-1));
  });

  it("retargets local anticipation from the current rendered position", () => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const eastTarget = snapshotEastOf(start, 500);
    const northTarget = moveToward(start, { lat: start.lat + 0.02, lon: start.lon }, 500);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("move-1", 1, eastTarget, 1_000);
    const beforeRetarget = timeline.renderPosition(start.playerId, 1_032)!;

    timeline.beginLocalAnticipation("move-2", 2, northTarget, 1_032);
    const afterRetarget = timeline.renderPosition(start.playerId, 1_048)!;

    expect(afterRetarget.lat).toBeGreaterThan(beforeRetarget.lat);
    expect(afterRetarget.lon).toBeLessThan(beforeRetarget.lon);
    expect(distanceMeters(beforeRetarget, afterRetarget)).toBeLessThanOrEqual(8.01);
    expect(distanceMeters(start, afterRetarget)).toBeLessThanOrEqual(25.01);
  });

  it("keeps a pending retarget when delayed authority belongs to the previous move", () => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const eastTarget = snapshotEastOf(start, 500);
    const northTarget = moveToward(start, { lat: start.lat + 0.02, lon: start.lon }, 500);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("move-a", 1, eastTarget, 1_000);
    timeline.renderPosition(start.playerId, 1_032);
    timeline.beginLocalAnticipation("move-b", 2, northTarget, 1_032);
    const beforeDelayedAuthority = timeline.renderPosition(start.playerId, 1_048)!;

    const delayedAuthorityForA = snapshotEastOf(start, 25, {
      moving: true,
      movementRevision: 1,
      targetLat: eastTarget.lat,
      targetLon: eastTarget.lon
    });
    timeline.applyDelta(
      [movementSample(delayedAuthorityForA)],
      [],
      1_050,
      1_048,
      { sequence: 1 }
    );
    const afterDelayedAuthority = timeline.renderPosition(start.playerId, 1_064)!;

    expect(afterDelayedAuthority.lat).toBeGreaterThan(beforeDelayedAuthority.lat);
    expect(afterDelayedAuthority.lon).toBeLessThan(beforeDelayedAuthority.lon);
    expect(timeline.acceptLocalAnticipation("move-b", northTarget, 2)).toBe(true);

    const authorityForBPosition = moveToward(start, northTarget, 25);
    const authorityForB = playerSnapshot({
      ...authorityForBPosition,
      moving: true,
      movementRevision: 2,
      targetLat: northTarget.lat,
      targetLon: northTarget.lon
    });
    timeline.applyDelta(
      [movementSample(authorityForB)],
      [],
      1_100,
      1_064,
      { sequence: 2 }
    );
    const afterAuthorityForB = timeline.renderPosition(start.playerId, 1_080)!;

    expect(afterAuthorityForB.lat).toBeGreaterThan(afterDelayedAuthority.lat);
    expect(afterAuthorityForB.lon).toBeLessThan(afterDelayedAuthority.lon);
  });

  it("never drags the rendered player back toward the old target while a reversal is pending", () => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const eastTarget = snapshotEastOf(start, 5_000);
    const northTarget = moveToward(start, { lat: start.lat + 0.2, lon: start.lon }, 5_000);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("move-a", 1, eastTarget, 1_000);
    timeline.renderPosition(start.playerId, 1_100);
    timeline.beginLocalAnticipation("move-b", 2, northTarget, 1_100);
    timeline.renderPosition(start.playerId, 1_116);

    const staleAuthorityForA = snapshotEastOf(start, 25, {
      moving: true,
      movementRevision: 1,
      targetLat: eastTarget.lat,
      targetLon: eastTarget.lon
    });
    timeline.applyDelta([movementSample(staleAuthorityForA)], [], 1_050, 1_120, { sequence: 1 });

    let previous = timeline.renderPosition(start.playerId, 1_116)!;
    for (let clientNowMs = 1_132; clientNowMs <= 1_700; clientNowMs += 16) {
      const frame = timeline.renderPosition(start.playerId, clientNowMs)!;
      expect(frame.lat).toBeGreaterThanOrEqual(previous.lat);
      expect(distanceMeters(frame, northTarget)).toBeLessThan(distanceMeters(previous, northTarget));
      previous = frame;
    }
  });

  it("grows the local lead budget with the latency estimate", () => {
    const leadAfterBudgetWindow = (rttMs: number | null): number => {
      const timeline = new PlayerRenderTimeline();
      const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
      const target = snapshotEastOf(start, 5_000);
      timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
      if (rttMs !== null) timeline.setLatencyEstimateMs(rttMs);
      timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
      timeline.renderPosition(start.playerId, 1_000);
      timeline.beginLocalAnticipation("move-1", 1, target, 1_000);
      timeline.acceptLocalAnticipation("move-1", target, 1);
      renderFrames(timeline, start.playerId, 1_016, 2_984);
      return distanceMeters(start, timeline.renderPosition(start.playerId, 3_000)!);
    };

    // Held at twice the budget: 250 ms floor, RTT + four ticks, 600 ms ceiling.
    expect(leadAfterBudgetWindow(null)).toBeCloseTo(250, 0);
    expect(leadAfterBudgetWindow(300)).toBeCloseTo(500, 0);
    expect(leadAfterBudgetWindow(5_000)).toBeCloseTo(600, 0);
  });

  it("corrects to authority when a pending request is never answered", () => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const target = snapshotEastOf(start, 5_000);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("move-1", 1, target, 1_000);

    const running = timeline.renderPosition(start.playerId, 1_400)!;
    expect(distanceMeters(start, running)).toBeGreaterThan(150);

    timeline.renderPosition(start.playerId, 2_600);
    const corrected = timeline.renderPosition(start.playerId, 2_800)!;
    expect(corrected).toMatchObject({ lat: start.lat, lon: start.lon });
  });

  it("adopts a newer authoritative target from the current rendered position", () => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({
      lat: 35.0844,
      lon: -106.6504,
      movementRevision: 1
    });
    const eastTarget = snapshotEastOf(start, 500);
    const northTarget = moveToward(start, { lat: start.lat + 0.02, lon: start.lon }, 500);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("move-1", 1, eastTarget, 1_000);
    timeline.acceptLocalAnticipation("move-1", eastTarget, 2);
    const beforeServerRetarget = timeline.renderPosition(start.playerId, 1_032)!;

    const retargetedAuthority = {
      ...start,
      moving: true,
      movementRevision: 3,
      targetLat: northTarget.lat,
      targetLon: northTarget.lon
    };
    timeline.applyDelta(
      [movementSample(retargetedAuthority)],
      [],
      1_050,
      1_032,
      { sequence: 1 }
    );
    const afterServerRetarget = timeline.renderPosition(start.playerId, 1_048)!;

    expect(afterServerRetarget.lat).toBeGreaterThan(beforeServerRetarget.lat);
    expect(afterServerRetarget.lon).toBeLessThan(beforeServerRetarget.lon);
    expect(distanceMeters(beforeServerRetarget, afterServerRetarget)).toBeLessThanOrEqual(8.01);
  });

  it("converges an anticipated local player once on authoritative stop", () => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const target = snapshotEastOf(start, 500);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("move-1", 1, target, 1_000);
    timeline.acceptLocalAnticipation("move-1", target, 1);
    const ahead = timeline.renderPosition(start.playerId, 1_050)!;
    const stopped = snapshotEastOf(start, 20, {
      moving: false,
      movementRevision: 1,
      targetLat: null,
      targetLon: null
    });

    timeline.applyDelta([movementSample(stopped)], [], 1_050, 1_050, { sequence: 1 });
    const correction = [1_066, 1_100, 1_136]
      .map((clientNowMs) => timeline.renderPosition(start.playerId, clientNowMs)!);

    expect(distanceMeters(stopped, correction[0]!)).toBeLessThan(distanceMeters(stopped, ahead));
    expect(correction.at(-1)).toMatchObject({ lat: stopped.lat, lon: stopped.lon });
    expect(timeline.renderPosition(start.playerId, 1_300)).toEqual(correction.at(-1));
  });

  it("does not let a remote underflow pause local anticipation", () => {
    const timeline = new PlayerRenderTimeline();
    const local = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const remote = playerSnapshot({
      playerId: "remote",
      lat: 35.0854,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const target = snapshotEastOf(local, 500);
    timeline.configureLocalPlayer(local.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([local, remote], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(local.playerId, 1_000);
    timeline.beginLocalAnticipation("move-1", 1, target, 1_000);

    const frames = renderFrames(timeline, local.playerId, 1_016, 1_064);
    expect(distanceMeters(local, frames[0]!)).toBeGreaterThan(0);
    expect(distanceMeters(local, frames.at(-1)!)).toBeGreaterThan(25);
    expect(distanceMeters(local, frames.at(-1)!)).toBeLessThanOrEqual(50.01);
  });

  it("advances remote tracks independently when another remote underflows", () => {
    const timeline = new PlayerRenderTimeline(150);
    const moving = playerSnapshot({
      playerId: "moving-remote",
      lat: 35.0844,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const underflowed = playerSnapshot({
      playerId: "underflowed-remote",
      lat: 35.0854,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    timeline.applySnapshot([moving, underflowed], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([
      movementSample(snapshotEastOf(moving, 25))
    ], [], 1_050, 1_050, { sequence: 1 });
    timeline.renderPosition(moving.playerId, 1_150);

    const progressed = timeline.renderPosition(moving.playerId, 1_166)!;
    expect(distanceMeters(moving, progressed)).toBeCloseTo(8, 1);
  });

  it("renders 0 m, 2 m, 4 m, and 6 m samples monotonically under irregular arrivals", () => {
    const timeline = new PlayerRenderTimeline(100);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504, moving: true });
    const points = [0, 2, 4, 6].map((meters) => snapshotEastOf(start, meters, {
      moving: true,
      movementRevision: 1
    }));
    timeline.configureTracedPlayer(start.playerId);

    timeline.applySnapshot([points[0]!], 1_000, 1_050, { sequence: 0 });
    const rendered = renderFrames(timeline, start.playerId, 1_050, 1_178);
    timeline.applyDelta([movementSample(points[1]!)], [], 1_100, 1_180, { sequence: 1 });
    rendered.push(...renderFrames(timeline, start.playerId, 1_180, 1_228));
    timeline.applyDelta([movementSample(points[2]!)], [], 1_200, 1_230, { sequence: 2 });
    rendered.push(...renderFrames(timeline, start.playerId, 1_230, 1_438));
    timeline.applyDelta([movementSample(points[3]!)], [], 1_300, 1_440, { sequence: 3 });
    rendered.push(...renderFrames(timeline, start.playerId, 1_440, 1_520));

    const progress = rendered.map((position) => distanceMeters(start, position));
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
    for (let index = 1; index < rendered.length; index += 1) {
      expect(distanceMeters(rendered[index - 1]!, rendered[index]!)).toBeLessThanOrEqual(0.51);
    }
    expect(progress.at(-1)).toBeCloseTo(6, 1);
  });

  it("holds for 250-500 ms without a newer sample and never extrapolates ahead", () => {
    const timeline = new PlayerRenderTimeline(100);
    const start = playerSnapshot({
      lat: 35.0844,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const newest = snapshotEastOf(start, 2, {
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    timeline.configureTracedPlayer(start.playerId);
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([movementSample(newest)], [], 1_100, 1_100, { sequence: 1 });

    const latestRendered = timeline.renderPosition(start.playerId, 1_200)!;
    const after250Ms = timeline.renderPosition(start.playerId, 1_450)!;
    const after500Ms = timeline.renderPosition(start.playerId, 1_700)!;

    expect(after250Ms).toEqual(latestRendered);
    expect(after500Ms).toEqual(latestRendered);
    expect(distanceMeters(start, after500Ms)).toBeLessThanOrEqual(2.01);
  });

  it("bounds the first frame after a delayed ordinary sample underflows the buffer", () => {
    const timeline = new PlayerRenderTimeline(120);
    const start = playerSnapshot({
      lat: 35.0844,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const first = snapshotEastOf(start, 50, {
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const delayed = snapshotEastOf(start, 100, {
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([movementSample(first)], [], 1_100, 1_100, { sequence: 1 });

    const held = timeline.renderPosition(start.playerId, 1_220)!;
    for (const clientNowMs of [1_240, 1_280, 1_310, 1_320]) {
      expect(timeline.renderPosition(start.playerId, clientNowMs)).toEqual(held);
    }

    timeline.applyDelta([movementSample(delayed)], [], 1_200, 1_320, { sequence: 2 });
    const firstFrameAfterDelivery = timeline.renderPosition(start.playerId, 1_336)!;
    const oneFrameJumpM = distanceMeters(held, firstFrameAfterDelivery);

    expect(oneFrameJumpM).toBeLessThanOrEqual(10.1);
    expect(distanceMeters(firstFrameAfterDelivery, delayed)).toBeGreaterThan(1);
  });

  it("bounds the first frame when the delayed sample is the final stopped endpoint", () => {
    const timeline = new PlayerRenderTimeline(120);
    const start = playerSnapshot({
      lat: 35.0844,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const moving = snapshotEastOf(start, 50, {
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const stopped = snapshotEastOf(start, 100, {
      moving: false,
      movementRevision: 2,
      targetLat: null,
      targetLon: null
    });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([movementSample(moving)], [], 1_100, 1_100, { sequence: 1 });

    const held = timeline.renderPosition(start.playerId, 1_220)!;
    for (const clientNowMs of [1_240, 1_280, 1_310, 1_320]) {
      expect(timeline.renderPosition(start.playerId, clientNowMs)).toEqual(held);
    }

    timeline.applyDelta([movementSample(stopped)], [], 1_200, 1_320, { sequence: 2 });
    const firstFrameAfterDelivery = timeline.renderPosition(start.playerId, 1_336)!;
    const oneFrameJumpM = distanceMeters(held, firstFrameAfterDelivery);

    expect(oneFrameJumpM).toBeLessThanOrEqual(10.1);
    expect(distanceMeters(firstFrameAfterDelivery, stopped)).toBeGreaterThan(1);

    const recoveryFrames = [firstFrameAfterDelivery];
    for (const clientNowMs of [1_352, 1_368, 1_384, 1_400, 1_416, 1_432]) {
      recoveryFrames.push(timeline.renderPosition(start.playerId, clientNowMs)!);
    }
    for (let index = 1; index < recoveryFrames.length; index += 1) {
      expect(distanceMeters(recoveryFrames[index - 1]!, recoveryFrames[index]!))
        .toBeLessThanOrEqual(10.1);
    }
    expect(recoveryFrames.at(-2)).toMatchObject({ lat: stopped.lat, lon: stopped.lon });
    expect(recoveryFrames.at(-1)).toEqual(recoveryFrames.at(-2));
  });

  it("holds one underflowed track while another player advances independently", () => {
    const timeline = new PlayerRenderTimeline(120);
    const local = playerSnapshot({
      lat: 35.0844,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const remote = playerSnapshot({
      playerId: "remote",
      lat: 35.0854,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    timeline.applySnapshot([local, remote], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([
      movementSample(snapshotEastOf(local, 50)),
      movementSample(snapshotEastOf(remote, 10))
    ], [], 1_100, 1_100, { sequence: 1 });

    const held = timeline.renderPosition(local.playerId, 1_220)!;
    timeline.renderPosition(local.playerId, 1_320);
    timeline.applyDelta([
      movementSample(snapshotEastOf(remote, 20))
    ], [], 1_200, 1_320, { sequence: 2 });
    expect(timeline.renderPosition(local.playerId, 1_336)).toEqual(held);

    const delayedLocal = snapshotEastOf(local, 100);
    timeline.applyDelta([movementSample(delayedLocal)], [], 1_200, 1_340, { sequence: 3 });
    const firstRecoveryFrame = timeline.renderPosition(local.playerId, 1_352)!;
    expect(distanceMeters(held, firstRecoveryFrame)).toBeLessThanOrEqual(10.1);
    expect(distanceMeters(firstRecoveryFrame, delayedLocal)).toBeGreaterThan(1);
  });

  it("smoothly adopts an equal-time final stop without freezing another moving track", () => {
    const timeline = new PlayerRenderTimeline(120);
    const local = playerSnapshot({
      lat: 35.0844,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const remote = playerSnapshot({
      playerId: "remote",
      lat: 35.0854,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const localMoving = snapshotEastOf(local, 25);
    timeline.applySnapshot([local, remote], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([
      movementSample(localMoving),
      movementSample(snapshotEastOf(remote, 10))
    ], [], 1_100, 1_100, { sequence: 1 });

    const held = timeline.renderPosition(local.playerId, 1_220)!;
    const stopped = snapshotEastOf(local, 50, {
      moving: false,
      movementRevision: 2,
      targetLat: null,
      targetLon: null
    });
    timeline.applyDelta([movementSample(stopped)], [], 1_100, 1_220, { sequence: 2 });
    timeline.applyDelta([
      movementSample(snapshotEastOf(remote, 20))
    ], [], 1_150, 1_225, { sequence: 3 });

    const recovery = [1_236, 1_252, 1_268, 1_284, 1_300]
      .map((clientNowMs) => timeline.renderPosition(local.playerId, clientNowMs)!);
    expect(distanceMeters(held, recovery[0]!)).toBeLessThanOrEqual(10.1);
    expect(distanceMeters(recovery[0]!, stopped)).toBeGreaterThan(1);
    for (let index = 1; index < recovery.length; index += 1) {
      expect(distanceMeters(recovery[index - 1]!, recovery[index]!)).toBeLessThanOrEqual(10.1);
    }
    expect(recovery.at(-2)).toMatchObject({ lat: stopped.lat, lon: stopped.lon });
    expect(recovery.at(-1)).toEqual(recovery.at(-2));
  });

  it("accepts a newer resume while an equal-time final stop is still presenting", () => {
    const timeline = new PlayerRenderTimeline(120);
    const local = playerSnapshot({
      lat: 35.0844,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const remote = playerSnapshot({
      playerId: "remote",
      lat: 35.0854,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    timeline.applySnapshot([local, remote], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([
      movementSample(snapshotEastOf(local, 25)),
      movementSample(snapshotEastOf(remote, 10))
    ], [], 1_100, 1_100, { sequence: 1 });

    const held = timeline.renderPosition(local.playerId, 1_220)!;
    const stopped = snapshotEastOf(local, 50, {
      moving: false,
      movementRevision: 2,
      targetLat: null,
      targetLon: null
    });
    timeline.applyDelta([movementSample(stopped)], [], 1_100, 1_220, { sequence: 2 });

    const resumed = snapshotEastOf(local, 75, {
      moving: true,
      movementRevision: 3,
      targetLat: local.lat,
      targetLon: -106.64
    });
    timeline.applyDelta([
      movementSample(resumed),
      movementSample(snapshotEastOf(remote, 20))
    ], [], 1_140, 1_225, { sequence: 3 });
    const recovery = [timeline.renderPosition(local.playerId, 1_236)!];
    timeline.applyDelta([
      movementSample(snapshotEastOf(remote, 30))
    ], [], 1_190, 1_240, { sequence: 4 });
    recovery.push(timeline.renderPosition(local.playerId, 1_252)!);
    timeline.applyDelta([
      movementSample(snapshotEastOf(remote, 40))
    ], [], 1_240, 1_260, { sequence: 5 });
    for (const clientNowMs of [1_268, 1_284, 1_300, 1_316, 1_332, 1_348]) {
      recovery.push(timeline.renderPosition(local.playerId, clientNowMs)!);
    }

    expect(distanceMeters(held, recovery[0]!)).toBeLessThanOrEqual(10.1);
    for (let index = 1; index < recovery.length; index += 1) {
      expect(distanceMeters(recovery[index - 1]!, recovery[index]!)).toBeLessThanOrEqual(10.1);
    }
    expect(recovery.at(-2)).toMatchObject({ lat: resumed.lat, lon: resumed.lon });
    expect(recovery.at(-1)).toEqual(recovery.at(-2));
  });

  it("bridges a resume when another moving track advanced past the stopped player", () => {
    const timeline = new PlayerRenderTimeline(120);
    const local = playerSnapshot({
      lat: 35.0844,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const remote = playerSnapshot({
      playerId: "remote",
      lat: 35.0854,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    timeline.applySnapshot([local, remote], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([
      movementSample(snapshotEastOf(local, 25)),
      movementSample(snapshotEastOf(remote, 10))
    ], [], 1_050, 1_050, { sequence: 1 });
    timeline.renderPosition(local.playerId, 1_170);

    const stopped = snapshotEastOf(local, 50, {
      moving: false,
      movementRevision: 2,
      targetLat: null,
      targetLon: null
    });
    timeline.applyDelta([movementSample(stopped)], [], 1_050, 1_170, { sequence: 2 });
    timeline.applyDelta([
      movementSample(snapshotEastOf(remote, 20))
    ], [], 1_100, 1_175, { sequence: 3 });
    timeline.renderPosition(local.playerId, 1_190);
    timeline.applyDelta([
      movementSample(snapshotEastOf(remote, 30))
    ], [], 1_150, 1_195, { sequence: 4 });
    const held = timeline.renderPosition(local.playerId, 1_270)!;
    expect(held).toMatchObject({ lat: stopped.lat, lon: stopped.lon });

    const resumed = snapshotEastOf(local, 75, {
      moving: true,
      movementRevision: 3,
      targetLat: local.lat,
      targetLon: -106.64
    });
    timeline.applyDelta([movementSample(resumed)], [], 1_140, 1_270, { sequence: 5 });
    const atReceipt = timeline.renderPosition(local.playerId, 1_270)!;
    timeline.applyDelta([
      movementSample(snapshotEastOf(remote, 40))
    ], [], 1_200, 1_275, { sequence: 6 });
    const firstFrame = timeline.renderPosition(local.playerId, 1_286)!;

    expect(atReceipt).toEqual(held);
    expect(distanceMeters(held, firstFrame)).toBeLessThanOrEqual(10.1);
    expect(distanceMeters(firstFrame, resumed)).toBeGreaterThan(1);
  });

  it("skips a coordinate-identical idle gap before interpolating the first 500 m/s step", () => {
    const timeline = new PlayerRenderTimeline(150);
    const stopped = playerSnapshot({ lat: 35.0844, lon: -106.6504, moving: false });
    timeline.applySnapshot([stopped], 1_000, 1_000, { sequence: 0 });
    expect(timeline.renderPosition(stopped.playerId, 1_000)).toMatchObject({
      lat: stopped.lat,
      lon: stopped.lon
    });
    expect(timeline.renderPosition(stopped.playerId, 4_990)).toMatchObject({
      lat: stopped.lat,
      lon: stopped.lon
    });

    const moving = snapshotEastOf(stopped, 25, {
      moving: true,
      movementRevision: 1,
      targetLat: stopped.lat,
      targetLon: -106.64
    });
    timeline.applyDelta([movementSample(moving)], [], 5_000, 5_000, { sequence: 1 });
    const frames = renderFrames(timeline, stopped.playerId, 5_000, 5_160);

    expect(frames[0]).toMatchObject({ lat: stopped.lat, lon: stopped.lon });
    for (let index = 1; index < frames.length; index += 1) {
      expect(distanceMeters(frames[index - 1]!, frames[index]!)).toBeLessThanOrEqual(10.1);
    }
    expect(frames.at(-1)).toMatchObject({ lat: moving.lat, lon: moving.lon });
    expect(timeline.renderPosition(stopped.playerId, 5_176)).toEqual(frames.at(-1));
  });

  it("treats a compatible full resync as one authoritative sample without reversing", () => {
    const timeline = new PlayerRenderTimeline(0);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504, movementRevision: 1 });
    const points = [0, 2, 4, 6].map((meters) => snapshotEastOf(start, meters, {
      movementRevision: 1,
      moving: true
    }));
    timeline.configureTracedPlayer(start.playerId);
    timeline.applySnapshot([points[0]!], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([movementSample(points[1]!)], [], 1_100, 1_100, { sequence: 1 });
    const beforeResync = timeline.renderPosition(start.playerId, 1_100)!;

    timeline.applySnapshot([points[2]!], 1_200, 1_200, {
      sequence: 0,
      reason: "player-sequence-gap"
    });
    const afterResync = timeline.renderPosition(start.playerId, 1_200)!;
    timeline.applyDelta([movementSample(points[3]!)], [], 1_300, 1_300, { sequence: 1 });
    const afterDelta = timeline.renderPosition(start.playerId, 1_300)!;

    expect(timeline.sampleCount(start.playerId)).toBeGreaterThanOrEqual(2);
    expect(distanceMeters(start, afterResync)).toBeGreaterThan(distanceMeters(start, beforeResync));
    expect(distanceMeters(afterResync, points[2]!)).toBeGreaterThanOrEqual(0);
    expect(distanceMeters(start, afterDelta)).toBeGreaterThan(distanceMeters(start, afterResync));
    expect(distanceMeters(afterDelta, points[3]!)).toBeGreaterThanOrEqual(0);
  });

  it("ignores older resyncs and smoothly presents an equal-time correction", () => {
    const timeline = new PlayerRenderTimeline(0);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504, movementRevision: 1 });
    const east2 = snapshotEastOf(start, 2, { movementRevision: 1, moving: true });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([movementSample(east2)], [], 1_100, 1_100, { sequence: 5 });

    const older = snapshotEastOf(start, 1, { movementRevision: 1, moving: true });
    timeline.applySnapshot([older], 1_050, 1_150, { sequence: 0, reason: "delayed-resync" });
    expect(distanceMeters(start, timeline.renderPosition(start.playerId, 1_150)!)).toBeCloseTo(2, 1);

    const baseline = snapshotEastOf(start, 3, { movementRevision: 1, moving: true });
    const beforeEqualTimeCorrection = timeline.renderPosition(start.playerId, 1_160)!;
    timeline.applySnapshot([baseline], 1_100, 1_160, { sequence: 0, reason: "full-resync" });
    const atReceipt = timeline.renderPosition(start.playerId, 1_160)!;
    const firstCorrectionFrame = timeline.renderPosition(start.playerId, 1_176)!;
    expect(atReceipt).toEqual(beforeEqualTimeCorrection);
    expect(distanceMeters(atReceipt, firstCorrectionFrame)).toBeLessThanOrEqual(10.1);
    expect(distanceMeters(start, firstCorrectionFrame)).toBeGreaterThan(2);
    expect(distanceMeters(firstCorrectionFrame, baseline)).toBeGreaterThan(0.1);

    const continued = snapshotEastOf(start, 4, { movementRevision: 1, moving: true });
    timeline.applyDelta([movementSample(continued)], [], 1_200, 1_200, { sequence: 1 });
    const firstContinuedFrame = timeline.renderPosition(start.playerId, 1_200)!;
    expect(distanceMeters(start, firstContinuedFrame)).toBeGreaterThan(2);
    expect(distanceMeters(firstContinuedFrame, continued)).toBeGreaterThan(0.1);
    expect(distanceMeters(start, timeline.renderPosition(start.playerId, 1_240)!)).toBeCloseTo(4, 1);
  });

  it("never gets ahead of a same-target snapshot because movement intent is not rendered", () => {
    const timeline = new PlayerRenderTimeline(0);
    const start = playerSnapshot({
      lat: 35.0844,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    timeline.configureTracedPlayer(start.playerId);
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });

    expect(timeline.renderPosition(start.playerId, 1_500)).toMatchObject({
      lat: start.lat,
      lon: start.lon
    });

    const sameTargetSnapshot = snapshotEastOf(start, 2, {
      moving: true,
      movementRevision: 1,
      targetLon: start.targetLon
    });
    timeline.applySnapshot([sameTargetSnapshot], 1_600, 1_600, {
      sequence: 0,
      reason: "full-resync"
    });
    const firstFrame = timeline.renderPosition(start.playerId, 1_600)!;
    expect(distanceMeters(start, firstFrame)).toBeGreaterThan(0);
    expect(distanceMeters(firstFrame, sameTargetSnapshot)).toBeGreaterThan(1);
    const recovered = renderFrames(timeline, start.playerId, 1_616, 2_064).at(-1)!;
    expect(distanceMeters(start, recovered)).toBeCloseTo(2, 1);
  });

  it("orders samples by accepted sequence, server time, and movement revision", () => {
    const timeline = new PlayerRenderTimeline(0);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504, movementRevision: 1 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta(
      [movementSample(snapshotEastOf(start, 2, { movementRevision: 1 }))],
      [],
      1_100,
      1_100,
      { sequence: 1 }
    );

    timeline.applyDelta(
      [movementSample(snapshotEastOf(start, 3, { movementRevision: 1 }))],
      [],
      1_100,
      1_101,
      { sequence: 0 }
    );
    expect(distanceMeters(start, timeline.renderPosition(start.playerId, 1_101)!)).toBeCloseTo(2, 1);

    const equalTimeCorrection = snapshotEastOf(start, 3, { movementRevision: 1 });
    timeline.applyDelta(
      [movementSample(equalTimeCorrection)],
      [],
      1_100,
      1_102,
      { sequence: 2 }
    );
    const firstCorrectionFrame = timeline.renderPosition(start.playerId, 1_118)!;
    expect(distanceMeters(start, firstCorrectionFrame)).toBeGreaterThan(2);
    expect(distanceMeters(firstCorrectionFrame, equalTimeCorrection)).toBeGreaterThan(0.1);
    renderFrames(timeline, start.playerId, 1_134, 1_150);
    timeline.applyDelta(
      [movementSample(snapshotEastOf(start, 4, { movementRevision: 1 }))],
      [],
      1_050,
      1_151,
      { sequence: 3 }
    );
    timeline.applyDelta(
      [movementSample(snapshotEastOf(start, 4, { movementRevision: 0 }))],
      [],
      1_200,
      1_200,
      { sequence: 3 }
    );

    expect(timeline.sampleCount(start.playerId)).toBe(2);
    expect(distanceMeters(start, timeline.renderPosition(start.playerId, 1_300)!)).toBeCloseTo(3, 1);
  });

  it("reverses only after a newer authoritative revision supplies reversed coordinates", () => {
    const timeline = new PlayerRenderTimeline(0);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504, movementRevision: 1 });
    const east2 = snapshotEastOf(start, 2, { movementRevision: 1, moving: true });
    timeline.configureTracedPlayer(start.playerId);
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([movementSample(east2)], [], 1_100, 1_100, { sequence: 1 });
    const beforeReversal = timeline.renderPosition(start.playerId, 1_100)!;

    expect(timeline.renderPosition(start.playerId, 1_600)).toEqual(beforeReversal);
    const reversedIntent = {
      ...east2,
      movementRevision: 2,
      targetLat: start.lat,
      targetLon: start.lon
    };
    timeline.applyDelta([movementSample(reversedIntent)], [], 1_700, 1_700, { sequence: 2 });
    expect(timeline.renderPosition(start.playerId, 1_700)).toEqual(beforeReversal);

    const east1 = snapshotEastOf(start, 1, {
      movementRevision: 2,
      moving: true,
      targetLat: start.lat,
      targetLon: start.lon
    });
    timeline.applyDelta([movementSample(east1)], [], 1_800, 1_800, { sequence: 3 });
    expect(distanceMeters(start, timeline.renderPosition(start.playerId, 1_800)!))
      .toBeLessThan(distanceMeters(start, beforeReversal));
  });

  it("holds a newer authoritative stop until a later authoritative resume", () => {
    const timeline = new PlayerRenderTimeline(0);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504, movementRevision: 1 });
    const east4 = snapshotEastOf(start, 4, { movementRevision: 1, moving: true });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([movementSample(east4)], [], 1_100, 1_100, { sequence: 1 });

    const stopped = { ...east4, movementRevision: 2, moving: false, targetLat: null, targetLon: null };
    timeline.applyDelta([movementSample(stopped)], [], 1_200, 1_200, { sequence: 2 });
    const held = timeline.renderPosition(start.playerId, 1_200)!;

    const staleResume = snapshotEastOf(start, 6, { movementRevision: 1, moving: true });
    timeline.applyDelta([movementSample(staleResume)], [], 1_300, 1_300, { sequence: 3 });
    expect(timeline.renderPosition(start.playerId, 1_300)).toEqual(held);
    expect(timeline.renderPosition(start.playerId, 1_700)).toEqual(held);
    renderFrames(timeline, start.playerId, 1_716, 1_796);

    const resumed = snapshotEastOf(start, 6, { movementRevision: 3, moving: true });
    timeline.applyDelta([movementSample(resumed)], [], 1_800, 1_800, { sequence: 4 });
    const firstResumeFrame = timeline.renderPosition(start.playerId, 1_812)!;
    expect(distanceMeters(start, firstResumeFrame)).toBeGreaterThan(4);
    expect(distanceMeters(firstResumeFrame, resumed)).toBeGreaterThan(0.1);
    expect(distanceMeters(start, timeline.renderPosition(start.playerId, 1_852)!)).toBeCloseTo(6, 1);
  });

  it.each(["flag-visited", "city-visited", "dev-teleport"])(
    "snaps %s lifecycle positions immediately",
    (reason) => {
      const timeline = new PlayerRenderTimeline(100);
      const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
      const destination = snapshotEastOf(start, 50, { movementRevision: 2 });
      timeline.configureTracedPlayer(start.playerId);
      timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });

      timeline.snapPlayer(destination, 1_100, 1_100, reason);

      expect(timeline.sampleCount(start.playerId)).toBe(1);
      expect(timeline.renderPosition(start.playerId, 1_100)).toMatchObject({
        lat: destination.lat,
        lon: destination.lon
      });
    }
  );

  it("snaps respawn positions immediately", () => {
    const timeline = new PlayerRenderTimeline(100);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const respawn = eastOf(start, 50);
    timeline.configureTracedPlayer(start.playerId);
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });

    timeline.snapPosition(start.playerId, respawn, 1_100, 1_100, "respawn");

    expect(timeline.sampleCount(start.playerId)).toBe(1);
    expect(timeline.renderPosition(start.playerId, 1_100)).toMatchObject(respawn);
  });

  it.each([
    ["anchor", { anchorLat: 35.09, anchorLon: -106.64 }],
    ["region", { regionCode: "CO" }],
    ["zone", { zoneId: "world:NM:north" }]
  ] as const)("snaps immediately on a %s discontinuity", (_label, changes) => {
    const timeline = new PlayerRenderTimeline(100);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    const changed = { ...snapshotEastOf(start, 1), ...changes };

    timeline.applyDelta([{ kind: "full", player: changed }], [], 1_100, 1_100, {
      sequence: 1
    });

    expect(timeline.sampleCount(start.playerId)).toBe(1);
    expect(timeline.renderPosition(start.playerId, 1_100)).toMatchObject({
      lat: changed.lat,
      lon: changed.lon,
      anchorLat: changed.anchorLat,
      anchorLon: changed.anchorLon
    });
  });

  it("rejects non-finite coordinates without poisoning later playback", () => {
    const timeline = new PlayerRenderTimeline(100);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);

    timeline.applyDelta([
      movementSample({ ...start, lat: Number.NaN, moving: true })
    ], [], 1_000_000_000, 1_100, { sequence: 1 });
    timeline.applyDelta([{
      kind: "full",
      player: { ...start, anchorLon: Number.POSITIVE_INFINITY }
    }], [], 1_200, 1_200, { sequence: 2 });
    timeline.applyDelta([
      movementSample({ ...start, targetLat: Number.NaN, targetLon: start.lon, moving: true })
    ], [], 1_300, 1_300, { sequence: 3 });

    expect(timeline.sampleCount(start.playerId)).toBe(1);
    const held = timeline.renderPosition(start.playerId, 1_500)!;
    const resumed = snapshotEastOf(start, 25, {
      moving: true,
      movementRevision: 1,
      targetLat: start.lat,
      targetLon: -106.64
    });
    timeline.applyDelta([movementSample(resumed)], [], 1_400, 1_500, { sequence: 4 });
    const firstRecoveryFrame = timeline.renderPosition(start.playerId, 1_516)!;

    expect(distanceMeters(held, firstRecoveryFrame)).toBeLessThanOrEqual(10.1);
    expect(distanceMeters(firstRecoveryFrame, resumed)).toBeGreaterThan(1);
  });

  it("interpolates a 400 ms ordinary same-anchor gap at 500 m/s", () => {
    const timeline = new PlayerRenderTimeline(100);
    const local = playerSnapshot({
      lat: 35.0844,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const remote = playerSnapshot({ playerId: "remote", lat: 35.0845, lon: -106.6504 });
    timeline.applySnapshot([local, remote], 1_000, 1_000, { sequence: 0 });
    const held = renderFrames(timeline, local.playerId, 1_100, 1_550).at(-1)!;
    const far = snapshotEastOf(local, 200, { moving: true, movementRevision: 1 });

    timeline.applyDelta([movementSample(far)], [], 1_400, 1_550, { sequence: 1 });
    const recovery = renderFrames(timeline, local.playerId, 1_564, 1_884);

    expect(timeline.sampleCount(local.playerId)).toBe(2);
    expect(distanceMeters(held, recovery[0]!)).toBeLessThanOrEqual(10.1);
    expect(distanceMeters(recovery[0]!, far)).toBeGreaterThan(1);
    for (let index = 1; index < recovery.length; index += 1) {
      expect(distanceMeters(recovery[index - 1]!, recovery[index]!)).toBeLessThanOrEqual(10.1);
    }
    expect(recovery.at(-1)).toMatchObject({ lat: far.lat, lon: far.lon });

    timeline.applySnapshot([far], 1_500, 1_900, { sequence: 0 });
    expect(timeline.renderPosition(remote.playerId, 1_900)).toBeNull();
  });

  it("records authoritative interpolation and holds without prediction modes", () => {
    setMovementTraceEnabled(true);
    const timeline = new PlayerRenderTimeline(100);
    const start = playerSnapshot({
      lat: 35.0844,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const newest = snapshotEastOf(start, 2, {
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    timeline.configureTracedPlayer(start.playerId);
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([movementSample(newest)], [], 1_100, 1_100, { sequence: 1 });
    renderFrames(timeline, start.playerId, 1_110, 1_350);

    const entries = getMovementTrace();
    expect(entries.slice(0, 2).map((entry) => entry.messageType)).toEqual([
      "PLAYER_SNAPSHOT",
      "PLAYER_DELTA"
    ]);
    const renderEntries = entries.filter((entry) => entry.messageType === "LOCAL_RENDER_FRAME");
    expect(renderEntries.some((entry) => entry.outcome === "interpolated")).toBe(true);
    expect(renderEntries.at(-1)).toMatchObject({
      replicationSequence: 1,
      outcome: "held",
      authoritativePosition: { lat: newest.lat, lon: newest.lon },
      renderedAfter: { lat: newest.lat, lon: newest.lon }
    });
    expect(entries.some((entry) => "timelineMode" in entry || "progressM" in entry)).toBe(false);
  });

  it("traces interpolation into an authoritative stop and one held endpoint", () => {
    setMovementTraceEnabled(true);
    const timeline = new PlayerRenderTimeline(100);
    const start = playerSnapshot({
      lat: 35.0844,
      lon: -106.6504,
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    const moving = snapshotEastOf(start, 2, {
      moving: true,
      movementRevision: 1,
      targetLon: -106.64
    });
    timeline.configureTracedPlayer(start.playerId);
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.applyDelta([movementSample(moving)], [], 1_100, 1_100, { sequence: 1 });
    renderFrames(timeline, start.playerId, 1_110, 1_190);

    const stopped = {
      ...moving,
      moving: false,
      movementRevision: 2,
      targetLat: null,
      targetLon: null
    };
    timeline.applyDelta([movementSample(stopped)], [], 1_200, 1_200, { sequence: 2 });
    renderFrames(timeline, start.playerId, 1_210, 1_418);

    const stopFrames = getMovementTrace().filter((entry) =>
      entry.messageType === "LOCAL_RENDER_FRAME" && entry.movementRevision === 2
    );
    expect(stopFrames[0]?.outcome).toBe("interpolated");
    expect(stopFrames.at(-1)?.outcome).toBe("held");
    expect(stopFrames.at(-1)?.renderedAfter).toEqual({ lat: stopped.lat, lon: stopped.lon });
  });

  it("clears every authoritative track", () => {
    const timeline = new PlayerRenderTimeline();
    const player = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    timeline.applySnapshot([player], 1_000, 1_000, { sequence: 0 });

    timeline.clear();

    expect(timeline.sampleCount(player.playerId)).toBe(0);
    expect(timeline.renderPosition(player.playerId, 1_100)).toBeNull();
  });

  it("drops remote tracks while retaining local movement tuning on relocation", () => {
    const timeline = new PlayerRenderTimeline();
    const local = playerSnapshot({ playerId: "local", lat: 35, lon: -106 });
    const remote = playerSnapshot({ playerId: "remote", lat: 35.001, lon: -106 });
    timeline.configureLocalPlayer(local.playerId, { speedMps: 5, serverTickHz: 20 });
    timeline.applySnapshot([local, remote], 1_000, 1_000, { sequence: 0 });

    timeline.retainOnly(local.playerId);

    expect(timeline.sampleCount(local.playerId)).toBe(1);
    expect(timeline.sampleCount(remote.playerId)).toBe(0);
    expect(timeline.renderPosition(local.playerId, 1_100)).not.toBeNull();
  });

  it("retains the local player presentation when reconnect refreshes movement tuning", () => {
    const timeline = new PlayerRenderTimeline();
    const local = playerSnapshot({ playerId: "local", lat: 35, lon: -106 });
    timeline.configureLocalPlayer(local.playerId, { speedMps: 5, serverTickHz: 20 });
    timeline.applySnapshot([local], 1_000, 1_000, { sequence: 0 });
    const renderedBeforeReconnect = timeline.renderPosition(local.playerId, 1_100);

    timeline.configureLocalPlayer(local.playerId, { speedMps: 6, serverTickHz: 30 });

    expect(timeline.renderPosition(local.playerId, 5_000)).toEqual(renderedBeforeReconnect);
    expect(timeline.sampleCount(local.playerId)).toBe(1);
  });
});

function renderFrames(
  timeline: PlayerRenderTimeline,
  playerId: string,
  firstClientTimeMs: number,
  lastClientTimeMs: number
) {
  const rendered = [];
  for (let clientNowMs = firstClientTimeMs; clientNowMs <= lastClientTimeMs; clientNowMs += 16) {
    rendered.push(timeline.renderPosition(playerId, clientNowMs)!);
  }
  return rendered;
}

function playerSnapshot(input: {
  playerId?: string;
  lat: number;
  lon: number;
  regionCode?: string;
  zoneId?: string;
  anchorLat?: number;
  anchorLon?: number;
  moving?: boolean;
  movementRevision?: number;
  relocationRevision?: number;
  targetLat?: number | null;
  targetLon?: number | null;
}): PlayerSnapshot {
  const hasTarget = input.targetLat !== undefined || input.targetLon !== undefined;
  return {
    playerId: input.playerId ?? "player-1",
    username: "Avery",
    displayColor: "#38bdf8",
    regionCode: input.regionCode ?? "NM",
    zoneId: input.zoneId ?? "world:NM",
    lat: input.lat,
    lon: input.lon,
    anchorLat: input.anchorLat ?? 35.0844,
    anchorLon: input.anchorLon ?? -106.6504,
    moveLeashRadiusM: 900,
    movementRevision: input.movementRevision ?? 0,
    relocationRevision: input.relocationRevision ?? 0,
    targetLat: input.targetLat ?? (hasTarget ? input.lat : null),
    targetLon: input.targetLon ?? (hasTarget ? input.lon : null),
    moving: input.moving ?? false,
    online: true,
    updatedAt: "2026-07-09T00:00:00.000Z"
  };
}

function snapshotEastOf(
  start: PlayerSnapshot,
  distanceM: number,
  changes: Partial<PlayerSnapshot> = {}
): PlayerSnapshot {
  return {
    ...start,
    ...eastOf(start, distanceM),
    ...changes
  };
}

function eastOf(position: { lat: number; lon: number }, distanceM: number) {
  return moveToward(position, { lat: position.lat, lon: position.lon + 0.02 }, distanceM);
}

function movementSample(player: PlayerSnapshot) {
  return {
    kind: "movement" as const,
    playerId: player.playerId,
    lat: player.lat,
    lon: player.lon,
    movementRevision: player.movementRevision,
    ...(player.relocationRevision === undefined
      ? {}
      : { relocationRevision: player.relocationRevision }),
    targetLat: player.targetLat,
    targetLon: player.targetLon,
    moving: player.moving,
    online: player.online,
    updatedAt: player.updatedAt
  };
}

describe("local prediction under real network timing (docs/plans/move-smooth.md)", () => {
  const FRAME_MS = 1_000 / 60;
  const TICK_MS = 50;
  const leadLimit = vi.mocked(noteMotionLeadLimit);

  beforeEach(() => {
    leadLimit.mockClear();
  });

  /** Deterministic jitter in [-1, 1]. */
  function jitterSource(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0xffff_ffff * 2 - 1;
    };
  }

  /**
   * A server walking east at `serverSpeedMps` (20 Hz ticks, deltas stamped with server time), delivered after
   * 40 ms +/- `jitterMs`, handled between display frames (frame clock = the previous frame) and rendered at 60 Hz.
   */
  function walkUnderJitter(options: {
    serverSpeedMps: number;
    speedField?: number;
    jitterMs: number;
    durationMs: number;
    rttMs?: number;
  }) {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const target = snapshotEastOf(start, 20_000);
    timeline.configureLocalPlayer(start.playerId, { speedMps: DEFAULT_PLAYER_SPEED_MPS, serverTickHz: 20 });
    if (options.rttMs !== undefined) timeline.setLatencyEstimateMs(options.rttMs);
    timeline.applySnapshot([start], 0, 40, { sequence: 0 });
    timeline.renderPosition(start.playerId, 50);
    const clickMs = 100;
    timeline.beginLocalAnticipation("walk", 1, target, clickMs);
    timeline.acceptLocalAnticipation("walk", target, 1, null, options.speedField ?? null);
    const jitter = jitterSource(7);
    const packets: Array<{ arriveMs: number; serverTimeMs: number; distanceM: number; sequence: number }> = [];
    const firstTick = Math.ceil((clickMs + 40) / TICK_MS);
    for (let tick = firstTick; tick * TICK_MS < options.durationMs + 500; tick += 1) {
      const serverTimeMs = tick * TICK_MS;
      packets.push({
        serverTimeMs,
        distanceM: options.serverSpeedMps * (tick - firstTick + 1) * TICK_MS / 1_000,
        arriveMs: serverTimeMs + 40 + jitter() * options.jitterMs,
        sequence: tick
      });
    }
    packets.sort((left, right) => left.arriveMs - right.arriveMs);
    const frames: Array<{ t: number; m: number }> = [];
    let previousFrameMs = clickMs;
    let next = 0;
    for (let t = clickMs + FRAME_MS; t <= options.durationMs; t += FRAME_MS) {
      while (next < packets.length && packets[next]!.arriveMs <= t) {
        const packet = packets[next++]!;
        const authority = snapshotEastOf(start, packet.distanceM, {
          moving: true,
          movementRevision: 1,
          targetLat: target.lat,
          targetLon: target.lon
        });
        timeline.applyDelta(
          [{ ...movementSample(authority), ...(options.speedField ? { speedMps: options.speedField } : {}) }],
          [],
          packet.serverTimeMs,
          previousFrameMs,
          { sequence: packet.sequence, receivedAtMs: packet.arriveMs }
        );
      }
      const rendered = timeline.renderPosition(start.playerId, t)!;
      // The camera and the sprite read the same frame: a second read changes nothing.
      expect(timeline.renderPosition(start.playerId, t)).toEqual(rendered);
      frames.push({ t, m: distanceMeters(start, rendered) });
      previousFrameMs = t;
    }
    return frames;
  }

  function stepStats(frames: Array<{ t: number; m: number }>, fromMs: number) {
    const steps: number[] = [];
    for (let index = 1; index < frames.length; index += 1) {
      if (frames[index]!.t >= fromMs) steps.push(frames[index]!.m - frames[index - 1]!.m);
    }
    const mean = steps.reduce((sum, step) => sum + step, 0) / steps.length;
    const std = Math.sqrt(steps.reduce((sum, step) => sum + (step - mean) ** 2, 0) / steps.length);
    return { steps, mean, cv: std / mean, minStep: Math.min(...steps), mps: mean / FRAME_MS * 1_000 };
  }

  function limitCallsAfter(fromMs: number) {
    const calls = leadLimit.mock.calls.filter(([frameMs]) => frameMs >= fromMs);
    return { frames: calls.length, hard: calls.filter(([, hard]) => hard).length };
  }

  it("walks evenly when the server is 10% slower than the prediction, with jittered 20 Hz delivery", () => {
    // No speed field (an older server): the soft limit absorbs the mismatch. Master: step CV 0.32, 7 backward steps.
    const frames = walkUnderJitter({
      serverSpeedMps: DEFAULT_PLAYER_SPEED_MPS * 0.9,
      jitterMs: 15,
      durationMs: 7_000,
      rttMs: 80
    });
    const settled = stepStats(frames, 4_000);
    expect(settled.minStep).toBeGreaterThan(0);
    expect(settled.cv).toBeLessThan(0.05);
    // The lead settles: the prediction walks at the server's pace with gentle pulls, never a hard clamp.
    expect(settled.mps).toBeGreaterThan(DEFAULT_PLAYER_SPEED_MPS * 0.9 * 0.99);
    expect(settled.mps).toBeLessThan(DEFAULT_PLAYER_SPEED_MPS * 0.9 * 1.01);
    expect(limitCallsAfter(4_000).hard).toBe(0);
  });

  it("never touches the lead limit when the server sends its effective speed", () => {
    const frames = walkUnderJitter({
      serverSpeedMps: DEFAULT_PLAYER_SPEED_MPS * 0.9,
      speedField: DEFAULT_PLAYER_SPEED_MPS * 0.9,
      jitterMs: 15,
      durationMs: 5_000,
      rttMs: 80
    });
    const settled = stepStats(frames, 1_000);
    expect(settled.minStep).toBeGreaterThan(0);
    expect(settled.cv).toBeLessThan(0.01);
    expect(settled.mps).toBeCloseTo(DEFAULT_PLAYER_SPEED_MPS * 0.9, 0);
    expect(leadLimit).not.toHaveBeenCalled();
  });

  it("predicts at the server's effective speed and falls back to the base speed without it", () => {
    const walked = (speedMps: number | null, viaDelta = false): number => {
      const timeline = new PlayerRenderTimeline();
      const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
      const target = eastOf(start, 1_000);
      timeline.configureLocalPlayer(start.playerId, { speedMps: 100, serverTickHz: 20 });
      timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
      timeline.renderPosition(start.playerId, 1_000);
      timeline.beginLocalAnticipation("move", 1, target, 1_000);
      timeline.acceptLocalAnticipation("move", target, 1, null, viaDelta ? null : speedMps);
      if (viaDelta && speedMps !== null) {
        timeline.applyDelta([{ ...movementSample(start), speedMps }], [], 1_000, 1_000, { sequence: 1 });
      }
      expect(timeline.localSpeedMps()).toBeCloseTo(speedMps ?? 100, 9);
      return distanceMeters(start, timeline.renderPosition(start.playerId, 1_100)!);
    };
    expect(walked(null)).toBeCloseTo(10, 3);
    expect(walked(85)).toBeCloseTo(8.5, 3);
    expect(walked(70, true)).toBeCloseTo(7, 3);
  });

  it("applies the server's 0.2..2 clamp to the effective speed times the water segment multiplier", () => {
    const timeline = new PlayerRenderTimeline(100);
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const target = eastOf(start, 1_000);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 100, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("water-move", 1, target, 1_000);
    timeline.acceptLocalAnticipation("water-move", target, 1, {
      origin: { lat: start.lat, lon: start.lon },
      segments: [{ startM: 0, multiplier: 3 }]
    }, 90);
    // 100 m/s x clamp(0.9 x 3 = 2.7 -> 2) for 100 ms.
    expect(distanceMeters(start, timeline.renderPosition(start.playerId, 1_100)!)).toBeCloseTo(20, 1);
  });

  it("keeps the prediction clock and the water profile across a joystick resend between frames", () => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const firstTarget = eastOf(start, 1_000);
    const secondTarget = eastOf(start, 1_100);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 100, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("first", 1, firstTarget, 1_000);
    timeline.acceptLocalAnticipation("first", firstTarget, 1, {
      origin: { lat: start.lat, lon: start.lon },
      segments: [{ startM: 0, multiplier: 0.5 }]
    });
    const atFrame = timeline.renderPosition(start.playerId, 1_016)!;
    // A resend stamped later than the last frame (a touch event before the next frame) must not eat that time.
    timeline.beginLocalAnticipation("second", 2, secondTarget, 1_024);
    const nextFrame = timeline.renderPosition(start.playerId, 1_032)!;
    // 100 m/s x 0.5 (the profile survives until the resend's own MOVE_ACCEPTED) x 16 ms.
    expect(distanceMeters(atFrame, nextFrame)).toBeCloseTo(0.8, 3);
    // An earlier stamp never rewinds the clock either.
    timeline.beginLocalAnticipation("third", 3, secondTarget, 1_020);
    expect(distanceMeters(nextFrame, timeline.renderPosition(start.playerId, 1_048)!)).toBeCloseTo(0.8, 3);
  });

  it("restarts the prediction clock for a request after an idle gap", () => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    timeline.configureLocalPlayer(start.playerId, { speedMps: 100, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalAnticipation("late", 1, eastOf(start, 1_000), 5_000);
    expect(distanceMeters(start, timeline.renderPosition(start.playerId, 5_016)!)).toBeCloseTo(1.6, 3);
  });

  it("does not limit the lead against a sample older than the accepted revision", () => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const north = { lat: start.lat + 0.01, lon: start.lon };
    const oldLeg = snapshotEastOf(start, 30, {
      moving: true,
      movementRevision: 1,
      targetLat: eastOf(start, 1_000).lat,
      targetLon: eastOf(start, 1_000).lon
    });
    timeline.configureLocalPlayer(start.playerId, { speedMps: 125, serverTickHz: 20 });
    timeline.applySnapshot([oldLeg], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    // Far ahead of the old leg's sample already: a turn the server accepted (revision 2) before its next delta.
    timeline.beginLocalAnticipation("turn", 1, north, 1_000);
    timeline.acceptLocalAnticipation("turn", north, 2);
    const frames = renderFrames(timeline, start.playerId, 1_016, 1_200);
    const steps = frames.slice(1).map((frame, index) => distanceMeters(frames[index]!, frame));
    for (const step of steps) expect(step).toBeCloseTo(125 * 0.016, 3);
    expect(leadLimit).not.toHaveBeenCalled();
  });

  it("leaves a dash unthrottled by the soft lead limit", () => {
    const timeline = new PlayerRenderTimeline();
    const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
    const end = eastOf(start, 80);
    timeline.configureLocalPlayer(start.playerId, { speedMps: 125, serverTickHz: 20 });
    timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
    timeline.renderPosition(start.playerId, 1_000);
    timeline.beginLocalDash("dash", 1, end, 200, 1_000);
    timeline.acceptLocalAnticipation("dash", end, 1);
    // 400 m/s, far past the walking lead budget, lands at the end in 200 ms.
    expect(distanceMeters(start, timeline.renderPosition(start.playerId, 1_100)!)).toBeCloseTo(40, 1);
    expect(timeline.renderPosition(start.playerId, 1_200)).toMatchObject({ lat: end.lat, lon: end.lon });
    expect(leadLimit).not.toHaveBeenCalled();
  });

  it("smooths the round-trip estimate instead of taking one PONG", () => {
    const leadAfter = (samples: number[]): number => {
      const timeline = new PlayerRenderTimeline();
      const start = playerSnapshot({ lat: 35.0844, lon: -106.6504 });
      timeline.configureLocalPlayer(start.playerId, { speedMps: 500, serverTickHz: 20 });
      for (const rtt of samples) timeline.setLatencyEstimateMs(rtt);
      timeline.applySnapshot([start], 1_000, 1_000, { sequence: 0 });
      timeline.renderPosition(start.playerId, 1_000);
      const target = eastOf(start, 5_000);
      timeline.beginLocalAnticipation("move", 1, target, 1_000);
      timeline.acceptLocalAnticipation("move", target, 1);
      renderFrames(timeline, start.playerId, 1_016, 2_984);
      return distanceMeters(start, timeline.renderPosition(start.playerId, 3_000)!);
    };
    // One 400 ms spike after 100 ms samples moves the estimate to 160 ms (budget 360 ms, held at 2x = 360 m).
    expect(leadAfter([100, 100, 400])).toBeCloseTo(360, 0);
  });
});
