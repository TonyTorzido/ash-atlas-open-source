import { describe, expect, it, vi } from "vitest";

import { HeartPuzzleRuntime, type HeartPuzzleContext } from "./heartPuzzleRuntime.js";

const ctx = (over: Partial<HeartPuzzleContext> = {}): HeartPuzzleContext => ({
  dungeonId: "tilted_vault", roomId: "vault_r1", sessionId: "s1", roomWidth: 1000, roomHeight: 1300, solved: false, active: true, ...over
});

describe("HeartPuzzleRuntime", () => {
  it("only runs in rooms that have a puzzle", () => {
    const runtime = new HeartPuzzleRuntime({ readInput: () => ({ tilt: { x: 0, y: 0 } }), onSolved: vi.fn() });
    runtime.activate(ctx({ roomId: "somewhere_else" }));
    expect(runtime.state).toBeNull();
    runtime.activate(ctx());
    expect(runtime.state).not.toBeNull();
    expect(runtime.status()?.hintTier).toBe(0);
  });

  it("unlocks hints with time and keeps the sim across context refreshes", () => {
    const runtime = new HeartPuzzleRuntime({ readInput: () => ({ tilt: { x: 0, y: 0 } }), onSolved: vi.fn() });
    runtime.activate(ctx());
    for (let i = 0; i < 45 * 60; i += 1) runtime.step(1 / 60);
    runtime.activate(ctx());
    expect(runtime.status()?.hintTier).toBe(1);
    expect(runtime.unlockedHints()).toHaveLength(1);
  });

  it("reports exactly one solve once the goal is reached, and freezes when the server confirms", () => {
    const onSolved = vi.fn();
    const runtime = new HeartPuzzleRuntime({ readInput: () => ({ tilt: { x: 0, y: 0 } }), onSolved });
    runtime.activate(ctx());
    const s = runtime.state!;
    const m = s.marbles[0]!;
    m.x = s.goal!.x; m.y = s.goal!.y;
    for (let i = 0; i < 10; i += 1) runtime.step(1 / 60);
    expect(onSolved).toHaveBeenCalledTimes(1);
    expect(onSolved.mock.calls[0]![0]).toMatchObject({ sessionId: "s1", roomId: "vault_r1" });
    runtime.activate(ctx({ solved: true }));
    runtime.step(1 / 60);
    expect(runtime.status()?.solved).toBe(true);
    expect(onSolved).toHaveBeenCalledTimes(1);
  });

  it("only rolls once the server says the puzzle started, and a quit resets the board", () => {
    const runtime = new HeartPuzzleRuntime({ readInput: () => ({ tilt: { x: 1, y: 0 } }), onSolved: () => undefined });
    runtime.activate(ctx({ active: false }));
    const start = { ...runtime.state!.marbles[0]! };
    for (let i = 0; i < 30; i += 1) runtime.step(1 / 30);
    expect(runtime.state!.marbles[0]!.x).toBe(start.x);
    expect(runtime.status()!.active).toBe(false);
    runtime.activate(ctx({ active: true }));
    for (let i = 0; i < 30; i += 1) runtime.step(1 / 30);
    expect(runtime.state!.marbles[0]!.x).not.toBe(start.x);
    runtime.activate(ctx({ active: false }));
    expect(runtime.state!.marbles[0]!.x).toBe(start.x);
  });

  it("carries Old Pell's lore for every room, and his farewell once the Heart room is solved", () => {
    const runtime = new HeartPuzzleRuntime({ readInput: () => ({ tilt: { x: 0, y: 0 } }), onSolved: () => undefined });
    for (const roomId of ["vault_r1", "vault_r2", "vault_r3", "vault_r4"]) {
      runtime.activate(ctx({ roomId, sessionId: roomId, active: false }));
      expect(runtime.status()!.lore.length, roomId).toBeGreaterThan(0);
    }
    expect(runtime.status()!.lore.join(" ")).toContain("afraid to finish");
    runtime.activate(ctx({ roomId: "vault_r4", sessionId: "vault_r4", solved: true }));
    const farewell = runtime.status()!.lore.join(" ");
    expect(farewell).toContain("They're not coming back, are they.");
    expect(farewell).toContain("tell her Papa rolled it home.");
    // A solved room without a farewell keeps its story.
    runtime.activate(ctx({ roomId: "vault_r1", sessionId: "r1-solved", solved: true }));
    expect(runtime.status()!.lore.join(" ")).toContain("Wren");
  });
});
