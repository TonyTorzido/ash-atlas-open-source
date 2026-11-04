import { describe, expect, it } from "vitest";

import { createVaultState, drainEvents, roomGravity, roomIsReachable, stepVault } from "./vaultSim.js";
import { TILTED_VAULT_ROOMS } from "./vaultRooms.js";
import type { VaultRoomDef } from "./vaultTypes.js";

const room = (rows: string[], extra: Partial<VaultRoomDef> = {}): VaultRoomDef => ({
  id: "t", title: "t", intro: "", win: "reach", rows, hints: ["", "", ""], lore: [], ...extra
});
const run = (s: ReturnType<typeof createVaultState>, tilt: { x: number; y: number }, seconds: number): void => {
  for (let t = 0; t < seconds; t += 1 / 60) stepVault(s, tilt, 1 / 60);
};

describe("room data", () => {
  it("is rectangular and solvable in every room", () => {
    for (const def of TILTED_VAULT_ROOMS) {
      expect(new Set(def.rows.map((r) => r.length)).size, def.id).toBe(1);
      expect(roomIsReachable(def), def.id).toBe(true);
      expect(def.hints).toHaveLength(3);
    }
  });
});

describe("marble feel", () => {
  const open = ["#########", "#S......#", "#.......#", "#.......#", "#########"];
  it("accelerates under tilt, keeps rolling when the tilt stops, then slows by friction", () => {
    const s = createVaultState(room(open));
    run(s, { x: 1, y: 0 }, 0.4);
    const speedAtRelease = s.marbles[0]!.vx;
    expect(speedAtRelease).toBeGreaterThan(2);
    const x0 = s.marbles[0]!.x;
    run(s, { x: 0, y: 0 }, 0.3);
    expect(s.marbles[0]!.x).toBeGreaterThan(x0);
    expect(s.marbles[0]!.vx).toBeLessThan(speedAtRelease);
    expect(s.marbles[0]!.vx).toBeGreaterThan(0);
  });
  it("stays inside the walls", () => {
    const s = createVaultState(room(open));
    run(s, { x: 1, y: 1 }, 3);
    const m = s.marbles[0]!;
    expect(m.x).toBeLessThanOrEqual(8 - 0.3 + 1e-6);
    expect(m.y).toBeLessThanOrEqual(4 - 0.3 + 1e-6);
  });
  it("heavy marbles ignore a light lean and respond slower than light ones", () => {
    const rows = ["#########", "#S.....T#", "#.......#", "#########"];
    const s = createVaultState(room(rows));
    run(s, { x: 0.05, y: 0 }, 0.5);
    expect(s.marbles.find((m) => m.kind === "heavy")!.vx).toBe(0);
    const s2 = createVaultState(room(rows));
    run(s2, { x: 0, y: 1 }, 0.35);
    expect(s2.marbles.find((m) => m.kind === "light")!.vy).toBeGreaterThan(s2.marbles.find((m) => m.kind === "heavy")!.vy);
  });
});

describe("hazards", () => {
  it("drops into a hole and respawns at the start", () => {
    const s = createVaultState(room(["#####", "#S.o#", "#####"]));
    run(s, { x: 1, y: 0 }, 0.6);
    expect(s.falls).toBe(1);
    expect(drainEvents(s).some((e) => e.type === "fell")).toBe(true);
    run(s, { x: 0, y: 0 }, 1);
    expect(s.marbles[0]!.x).toBeCloseTo(1.5, 1);
    expect(s.marbles[0]!.falling).toBeNull();
  });
  it("breaks a cracked tile after the marble has crossed it", () => {
    const s = createVaultState(room(["########", "#S.c...#", "########"]));
    run(s, { x: 1, y: 0 }, 1.2);
    expect(s.cells[1 * 8 + 3]).toBe("o");
    expect(s.marbles[0]!.x).toBeGreaterThan(4);
  });
  it("turns room gravity with the floor", () => {
    const g = roomGravity({ x: 1, y: 0 }, Math.PI / 2);
    expect(g.x).toBeCloseTo(0);
    expect(g.y).toBeCloseTo(-1);
    const s = createVaultState(room(["#####", "#S..#", "#####"], { rotationSpeed: 1 }));
    stepVault(s, { x: 0, y: 0 }, 0.05);
    expect(s.angle).toBeCloseTo(0.05);
  });
});

describe("goals", () => {
  it("clears a reach room when the marble settles on the goal", () => {
    const s = createVaultState(room(["######", "#S.g.#", "######"]));
    run(s, { x: 0.45, y: 0 }, 2);
    run(s, { x: -0.3, y: 0 }, 1);
    expect(s.status).toBe("won");
  });
  it("clears a plates room only when both plates are held together", () => {
    const s = createVaultState(room(["#######", "#a...b#", "#S...T#", "#######"], { win: "plates" }));
    s.marbles[0]!.x = 1.5; s.marbles[0]!.y = 1.5;
    run(s, { x: 0, y: 0 }, 1.5);
    expect(s.status).toBe("playing");
    s.marbles[1]!.x = 5.5; s.marbles[1]!.y = 1.5;
    run(s, { x: 0, y: 0 }, 1.5);
    expect(s.status).toBe("won");
  });
  it("only the light marble fits through a slit", () => {
    const light = createVaultState(room(["#######", "#S.h..#", "#######"]));
    run(light, { x: 1, y: 0 }, 1.5);
    expect(light.marbles[0]!.x).toBeGreaterThan(4);
    const heavy = createVaultState(room(["#######", "#T.h..#", "#######"]));
    run(heavy, { x: 1, y: 0 }, 3);
    expect(heavy.marbles[0]!.x).toBeLessThan(3);
  });
});

describe("heart chamber wall", () => {
  it("is eroded by repeated fast hits from the big marble but not by a slow nudge", () => {
    const s = createVaultState(TILTED_VAULT_ROOMS[3]!);
    const big = s.marbles[0]!;
    const wallIndex = 8 * s.cols + 4;
    big.x = 4.5; big.y = 7.5;
    run(s, { x: 0, y: 0.05 }, 2);
    expect(s.cells[wallIndex]).toBe("w");
    for (let attempt = 0; attempt < 8 && s.cells[wallIndex] === "w"; attempt += 1) {
      big.x = 4.5; big.y = 5.2; big.vx = 0; big.vy = 0;
      run(s, { x: 0, y: 1 }, 1.2);
    }
    expect(s.cells[wallIndex]).toBe(".");
  });
});
