import { CISTERN_WARRENS_SPATIAL_PROFILE, type DungeonSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { DungeonMovementTimeline } from "./dungeonMovementTimeline.js";

type Player = DungeonSnapshot["player"];

describe("DungeonMovementTimeline", () => {
  it("renders one local intent smoothly without alternating behind authority", () => {
    const timeline = new DungeonMovementTimeline();
    timeline.start("session", player(12, null), 1_000, 0);
    timeline.applySnapshot("session", player(13, 80, 2), 1_100, 100);
    const frames: number[] = [];
    for (let now = 100; now <= 1_000; now += 16) {
      if (now === 500) timeline.applySnapshot("session", player(17, 80, 3), 1_500, now);
      frames.push(timeline.render(now)!.x);
    }
    expect(frames.every((value, index) => index === 0 || value >= frames[index - 1]!)).toBe(true);
    expect(frames.at(-1)).toBeGreaterThan(17);
    expect(frames.at(-1)).toBeLessThanOrEqual(
      17 + CISTERN_WARRENS_SPATIAL_PROFILE.playerMovementLocalUnitsPerSecond * 0.12
    );
  });

  it("converges once on an authoritative stop without oscillation", () => {
    const timeline = new DungeonMovementTimeline();
    timeline.start("session", player(12, 80), 1_000, 0);
    for (let now = 16; now <= 500; now += 16) timeline.render(now);
    expect(timeline.applySnapshot("session", player(17, null, 2), 1_500, 500)).toBe("accepted");
    const stopped: number[] = [];
    for (let now = 516; now <= 1_000; now += 16) stopped.push(timeline.render(now)!.x);
    expect(stopped.every((value, index) => index === 0 || value <= stopped[index - 1]!)).toBe(true);
    expect(stopped.at(-1)).toBe(17);
    expect(new Set(stopped.slice(-5))).toEqual(new Set([17]));
  });

  it("rejects stale or different-session authority", () => {
    const timeline = new DungeonMovementTimeline();
    timeline.start("session", player(12, 80), 1_000, 0);
    expect(timeline.applySnapshot("session", player(13, 80, 2), 1_100, 100)).toBe("accepted");
    expect(timeline.applySnapshot("session", player(14, 80, 3), 1_050, 110)).toBe("ignored");
    expect(timeline.applySnapshot("other", player(14, 80, 3), 1_200, 120)).toBe("ignored");
  });

  it("uses the authoritative snapshot speed when a dungeon bonus changes", () => {
    const timeline = new DungeonMovementTimeline();
    timeline.start("session", player(0, null), 1_000, 0);
    timeline.applySnapshot("session", player(0, 100, 2, 390), 1_100, 100);
    expect(timeline.render(150)!.x).toBe(19.5);
  });
});

function player(
  x: number,
  targetX: number | null,
  movementRevision = 1,
  movementSpeed = CISTERN_WARRENS_SPATIAL_PROFILE.playerMovementLocalUnitsPerSecond
): Player {
  return {
    playerId: "player",
    name: "Player",
    displayColor: null,
    x,
    y: 50,
    targetX,
    targetY: targetX === null ? null : 50,
    targetEntityId: null,
    movementSpeed,
    movementRevision,
    currentHealth: 100,
    maxHealth: 100
  };
}
