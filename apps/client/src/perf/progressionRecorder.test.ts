import { describe, expect, it } from "vitest";

import type { ProgressionSnapshot } from "@ash-atlas/shared";
import {
  ProgressionRecorder,
  progressionRecordingCsv,
  progressionRecordingFilename,
  progressionRecordingJson
} from "./progressionRecorder.js";

describe("ProgressionRecorder", () => {
  it("separates active and idle time at the 45 second threshold", () => {
    let now = Date.UTC(2026, 0, 2, 3, 4, 5);
    const recorder = new ProgressionRecorder(() => now);
    recorder.start({ progression: snapshot(0, 0), equipment: null });
    now += 10_000;
    recorder.recordEvent({ type: "movement", distanceM: 20 });
    now += 50_000;
    const recording = recorder.stop({ progression: snapshot(0, 0), equipment: null })!;
    expect(recording.summary.wallDurationMs).toBe(60_000);
    expect(recording.summary.activeDurationMs).toBe(55_000);
    expect(recording.summary.idleDurationMs).toBe(5_000);
    expect(recording.summary.travelDurationMs).toBe(45_000);
  });

  it("computes XP rates, source totals, TTK, and harvest duration", () => {
    let now = 0;
    const recorder = new ProgressionRecorder(() => now);
    recorder.start({ progression: snapshot(0, 0), equipment: null });
    recorder.recordEvent({ type: "combat_engaged", sourceId: "mob:1", mobArchetype: "wolf" });
    now = 10_000;
    recorder.recordEvent({ type: "mob_defeated", sourceId: "mob:1", mobArchetype: "wolf" });
    recorder.recordEvent({ type: "xp_granted", sourceType: "combat", xpRequested: 75, xpGranted: 75 });
    recorder.recordEvent({ type: "harvest_started", sourceId: "node:1", resourceType: "wood" });
    now = 13_000;
    recorder.recordEvent({ type: "harvest_completed", sourceId: "node:1", resourceType: "wood" });
    recorder.recordEvent({ type: "xp_granted", sourceType: "harvest", xpRequested: 20, xpGranted: 20 });
    now = 36_000;
    const recording = recorder.stop({ progression: snapshot(0, 95), equipment: null })!;
    expect(recording.summary).toMatchObject({
      totalXp: 95,
      xpPerActiveHour: 9_500,
      xpPerWallHour: 9_500,
      combatXp: 75,
      harvestXp: 20,
      mobsDefeated: 1,
      averageTtkMs: 10_000,
      harvestCompletions: 1,
      averageHarvestDurationMs: 3_000,
      percentOfTarget: 95
    });
  });

  it("creates automatic distinct-flag loops without fake same-flag loops", () => {
    let now = 0;
    const recorder = new ProgressionRecorder(() => now);
    recorder.start({ progression: snapshot(0, 0), equipment: null });
    recorder.recordEvent({ type: "flag_visited", sourceId: "flag-a" });
    now = 1_000;
    recorder.recordEvent({ type: "flag_visited", sourceId: "flag-a" });
    now = 5_000;
    recorder.recordEvent({ type: "xp_granted", sourceType: "combat", xpGranted: 10 });
    now = 10_000;
    recorder.recordEvent({ type: "flag_created", sourceId: "flag-b" });
    const recording = recorder.stop({ progression: snapshot(0, 10), equipment: null })!;
    expect(recording.loops).toHaveLength(1);
    expect(recording.loops[0]).toMatchObject({
      startFlagId: "flag-a",
      endFlagId: "flag-b",
      wallDurationMs: 10_000,
      xp: 10,
      manual: false
    });
  });

  it("supports manual markers and bounded raw events while retaining aggregates", () => {
    let now = 0;
    const recorder = new ProgressionRecorder(() => now, 2);
    recorder.start({ progression: snapshot(0, 0), equipment: null });
    expect(recorder.markLoopStart()).toBe(true);
    recorder.recordEvent({ type: "xp_granted", sourceType: "other", xpGranted: 1 });
    recorder.recordEvent({ type: "xp_granted", sourceType: "other", xpGranted: 2 });
    now = 1_000;
    expect(recorder.markLoopEnd()).toBe(true);
    const recording = recorder.stop({ progression: snapshot(0, 3), equipment: null })!;
    expect(recording.events).toHaveLength(2);
    expect(recording.rawEventsTruncated).toBe(true);
    expect(recording.summary.totalXp).toBe(3);
    expect(recording.loops).toHaveLength(1);
    expect(recording.loops[0]?.manual).toBe(true);
  });

  it("exports deterministic JSON and CSV without authentication fields", () => {
    let now = Date.UTC(2026, 0, 2, 3, 4, 5);
    const recorder = new ProgressionRecorder(() => now);
    recorder.start({ progression: snapshot(0, 0), equipment: null, serverTickRateHz: 20 });
    recorder.recordEvent({ type: "xp_granted", sourceType: "combat", sourceId: "mob:1", xpGranted: 75 });
    now += 1_000;
    const recording = recorder.stop({ progression: snapshot(0, 75), equipment: null })!;
    const json = progressionRecordingJson(recording);
    const csv = progressionRecordingCsv(recording);
    expect(JSON.parse(json)).toMatchObject({ formatVersion: 1, app: "ash-atlas" });
    expect(json).not.toMatch(/cookie|token|email|userAgent/i);
    expect(csv).toContain("timestamp,elapsedMs,activeElapsedMs,event_type".replace("event_type", "type"));
    expect(csv).toContain("xp_granted");
    expect(progressionRecordingFilename(recording.startedAt, "json"))
      .toBe("ash-atlas-progression-20260102-030405.json");
  });
});

function snapshot(level: number, totalXp: number): ProgressionSnapshot {
  return {
    playerId: "player-1",
    totalXp,
    level,
    curveVersion: 1,
    persistenceVersion: 0,
    xpIntoLevel: totalXp,
    xpForNextLevel: 1_667,
    nextLevelTotalXp: 1_667,
    atCap: false,
    pveStats: {
      maxHealth: 100,
      attackPower: 10,
      defense: 0,
      attackIntervalMs: 800,
      attackRangeM: 75
    }
  };
}
