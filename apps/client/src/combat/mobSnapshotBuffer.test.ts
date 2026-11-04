import { describe, expect, it } from "vitest";

import {
  MOB_EXTRAPOLATE_EASE_BACK_MS,
  MOB_EXTRAPOLATE_MS,
  createMobSnapshotTrack,
  pushMobSample,
  sampleMobTrack,
} from "./mobSnapshotBuffer.js";

const SNAP_M = 40;
// 1e-5 deg of longitude near the equator is about 1.1 m.
const D = 1e-5;

describe("mobSnapshotBuffer", () => {
  it("returns null with no samples and holds a single sample", () => {
    const track = createMobSnapshotTrack();
    expect(sampleMobTrack(track, 1000)).toBeNull();
    pushMobSample(track, 1000, 0, 0, SNAP_M);
    expect(sampleMobTrack(track, 5000)).toEqual({ lat: 0, lon: 0 });
  });

  it("interpolates linearly between the surrounding samples regardless of arrival timing", () => {
    const track = createMobSnapshotTrack();
    pushMobSample(track, 1000, 0, 0, SNAP_M);
    pushMobSample(track, 1100, 0, D, SNAP_M);
    pushMobSample(track, 1200, 0, 3 * D, SNAP_M);
    expect(sampleMobTrack(track, 1050)!.lon).toBeCloseTo(0.5 * D, 12);
    expect(sampleMobTrack(track, 1150)!.lon).toBeCloseTo(2 * D, 12);
    // Velocity is continuous in render time: the value at a sample is the sample.
    expect(sampleMobTrack(track, 1100)!.lon).toBeCloseTo(D, 12);
  });

  it("holds at the oldest sample before the buffer", () => {
    const track = createMobSnapshotTrack();
    pushMobSample(track, 1000, 0, D, SNAP_M);
    pushMobSample(track, 1100, 0, 2 * D, SNAP_M);
    expect(sampleMobTrack(track, 900)!.lon).toBe(D);
  });

  it("extrapolates briefly past the newest sample, then eases back to it", () => {
    const track = createMobSnapshotTrack();
    pushMobSample(track, 1000, 0, 0, SNAP_M);
    pushMobSample(track, 1100, 0, D, SNAP_M);
    const reach = sampleMobTrack(track, 1100 + MOB_EXTRAPOLATE_MS)!.lon;
    expect(reach).toBeCloseTo(D + (MOB_EXTRAPOLATE_MS / 100) * D, 12);
    const eased = sampleMobTrack(track, 1100 + MOB_EXTRAPOLATE_MS + MOB_EXTRAPOLATE_EASE_BACK_MS)!.lon;
    expect(eased).toBeCloseTo(D, 12);
  });

  it("does not extrapolate from samples that are too far apart", () => {
    const track = createMobSnapshotTrack();
    pushMobSample(track, 1000, 0, 0, SNAP_M);
    pushMobSample(track, 1500, 0, D, SNAP_M);
    expect(sampleMobTrack(track, 1550)!.lon).toBe(D);
  });

  it("drops out-of-order samples and restarts the track on a teleport", () => {
    const track = createMobSnapshotTrack();
    pushMobSample(track, 1000, 0, 0, SNAP_M);
    pushMobSample(track, 1100, 0, D, SNAP_M);
    pushMobSample(track, 1050, 0, 9 * D, SNAP_M);
    expect(track.samples).toHaveLength(2);
    pushMobSample(track, 1200, 1, 1, SNAP_M);
    expect(track.samples).toHaveLength(1);
    expect(sampleMobTrack(track, 1150)).toEqual({ lat: 1, lon: 1 });
  });

  it("reuses the same point object while the position does not change", () => {
    const track = createMobSnapshotTrack();
    pushMobSample(track, 1000, 0, 0, SNAP_M);
    pushMobSample(track, 1100, 0, 0, SNAP_M);
    const a = sampleMobTrack(track, 1050);
    const b = sampleMobTrack(track, 1080);
    expect(b).toBe(a);
  });

  it("keeps a bounded number of samples", () => {
    const track = createMobSnapshotTrack();
    for (let i = 0; i < 20; i += 1) pushMobSample(track, 1000 + i * 100, 0, i * D, SNAP_M);
    expect(track.samples.length).toBeLessThanOrEqual(4);
  });
});
