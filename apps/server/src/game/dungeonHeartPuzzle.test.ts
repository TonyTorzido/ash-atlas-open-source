import { isIndoorNavigationPointWalkable } from "@ash-atlas/shared";
import { DUNGEON_CATALOG, dungeonLocalToCombatPosition, parseServerMessage } from "@ash-atlas/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDungeonHandler, type DungeonHandlerContext } from "../realtime/handlers/dungeonHandler.js";
import { CisternWarrensRuntime } from "./dungeon.js";

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

/** Enters the Tilted Vault in one room and drives the real realtime handler. */
/** Beside Old Pell in each puzzle room (his anchor plus 90 right, 30 down), inside his talk range. */
const BY_PELL: Record<string, { x: number; y: number }> = {
  vault_r1: { x: 420, y: 238 }, vault_r2: { x: 530, y: 252 }, vault_r3: { x: 530, y: 221 }, vault_r4: { x: 530, y: 264 }
};

async function vaultHarness(roomId: string, at: { x: number; y: number } = BY_PELL[roomId]!) {
  const dungeon = DUNGEON_CATALOG.dungeons.find((candidate) => candidate.id === "tilted_vault")!;
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM cistern_warrens_presence WHERE player_id=$1")) {
      return { rows: [{ sewer_structure_id: "vault-1", session_id: "session-1", local_x: 150, local_y: 110,
        return_region_code: "world", return_lat: 35, return_lon: -106 }], rowCount: 1 };
    }
    if (sql.includes("FROM city_structures structure")) {
      return { rows: [{ structure_id: "vault-1", city_id: "city-1", city_name: "T", region_code: "world",
        placement_revision: "1", lat: 35, lon: -106 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  /** Spawned mobs by entity id; any other id (the player) reads the shared player entity. */
  const entities = new Map<string, { entityId: string; lifeState: string; currentHealth: number; maxHealth: number;
    targetEntityId: null; lat: number; lon: number }>();
  const playerEntity = { targetEntityId: null, currentHealth: 100, maxHealth: 100, lifeState: "alive" };
  const combat = { syncPlayer: vi.fn(), cancelCombat: vi.fn(), isPlayerReserved: vi.fn(() => false),
    entity: vi.fn((entityId: string) => entities.get(entityId) ?? playerEntity),
    spawnMob: vi.fn((input: { entityId: string; position: { lat: number; lon: number } }) => {
      const entity = { entityId: input.entityId, lifeState: "alive", currentHealth: 10, maxHealth: 10, targetEntityId: null,
        lat: input.position.lat, lon: input.position.lon };
      entities.set(input.entityId, entity);
      return entity;
    }),
    scaleFreshMobStats: vi.fn(() => true), isPlayerAlive: vi.fn(() => true),
    despawnMob: vi.fn((entityId: string) => entities.delete(entityId)), generalSkillRank: vi.fn(() => 0), playerMovementMultiplier: vi.fn(() => 1) };
  const sent: Array<{ playerId: string; message: any }> = [];
  const runtime = new CisternWarrensRuntime({ query } as never, combat as never,
    { persistInteriorPosition: vi.fn(async () => undefined) } as never, dungeon, { grantReward: vi.fn() } as never, DUNGEON_CATALOG,
    { recordCompletion: vi.fn(), authorizeEntry: vi.fn() } as never);
  const snapshot = (await runtime.restore(
    { playerId: "player-1", username: "P", displayColor: null, movementRevision: 4, regionCode: "world",
      position: { lat: 35, lon: -106 } } as never,
    { sewerId: "vault-1", spaceId: roomId, position: at } as never))!;
  const handler = createDungeonHandler({
    state: { playerId: "player-1", connectionId: "c1" }, authenticatedSession: null, gameState: {},
    registry: { send: (playerId: string, message: unknown) => sent.push({ playerId, message }) }, dungeon: runtime
  } as unknown as DungeonHandlerContext);
  const lastSnapshot = () => sent.map((entry) => entry.message).filter((m) => m.type === "DUNGEON_SNAPSHOT").at(-1)?.snapshot;
  const solve = (requestId: string, room = roomId) => handler({
    type: "DUNGEON_PUZZLE_SOLVE", requestId, sessionId: snapshot.sessionId, roomId: room, clientSolveMs: 12000
  } as never);
  const interact = (requestId: string, objectId: string) => handler({
    type: "DUNGEON_INTERACT", requestId, sessionId: snapshot.sessionId, objectId
  } as never);
  const start = (requestId: string, active = true) => handler({
    type: "DUNGEON_PUZZLE_ACTIVE", requestId, sessionId: snapshot.sessionId, roomId, active
  } as never);
  const move = (requestId: string, x: number, y: number) => handler({
    type: "DUNGEON_MOVE_TO", requestId, sessionId: snapshot.sessionId, x, y
  } as never);
  const errors = () => h_errors(sent);
  const sealState = (n: number) => lastSnapshot()?.objects.find((o: { id: string }) => o.id === `vault_seal_${n}`)?.state;
  const flag = (id: string) => lastSnapshot()?.dungeonFlags?.[id] === true;
  return { solve, interact, start, move, errors, sealState, flag, lastSnapshot, sent, snapshot, runtime, entities, playerEntity, combat };
}

const h_errors = (sent: Array<{ message: any }>): string[] =>
  sent.filter((e) => e.message.type === "DUNGEON_ERROR").map((e) => String(e.message.code));

describe("heart puzzle solve (server authority)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it("accepts a solve after the minimum time and opens the door", async () => {
    const h = await vaultHarness("vault_r1");
    expect(h.snapshot.dungeonFlags["vault_r1_solved"]).not.toBe(true);
    await h.start("start");
    vi.setSystemTime(T0 + 10_000);
    await h.solve("s1");
    expect(h.sealState(1)).toBe("on");
    expect(h.flag("vault_r1_solved")).toBe(true);
  });

  it("rejects a solve from the wrong room", async () => {
    const h = await vaultHarness("vault_r1");
    vi.setSystemTime(T0 + 60_000);
    await h.solve("s1", "vault_r2");
    expect(h.sent.some((e) => e.message.type === "DUNGEON_ERROR" && e.message.code === "WRONG_ROOM")).toBe(true);
    expect(h.flag("vault_r1_solved")).toBe(false);
  });

  it("rejects a solve that is too fast and leaves the door locked", async () => {
    const h = await vaultHarness("vault_r1");
    await h.start("start");
    vi.setSystemTime(T0 + 1_000);
    await h.solve("s1");
    expect(h.sealState(1)).not.toBe("on");
    expect(h.flag("vault_r1_solved")).toBe(false);
    expect(JSON.stringify(h.sent.map((e) => e.message))).toContain("The seal does not budge");
    vi.setSystemTime(T0 + 20_000);
    await h.solve("s2");
    expect(h.sealState(1)).toBe("on");
  });

  it("treats a second solve of an open seal as a no-op", async () => {
    const h = await vaultHarness("vault_r1");
    await h.start("start");
    vi.setSystemTime(T0 + 10_000);
    await h.solve("s1");
    await h.solve("s2");
    expect(h.sealState(1)).toBe("on");
    expect(h.flag("vault_r1_solved")).toBe(true);
    expect(h.sent.filter((e) => e.message.type === "DUNGEON_ERROR")).toHaveLength(0);
  });

  it("does not let a player tap the seal directly", async () => {
    const h = await vaultHarness("vault_r1");
    vi.setSystemTime(T0 + 60_000);
    await h.interact("tap-1", "vault_seal_1");
    expect(h.sealState(1)).not.toBe("on");
    expect(h.flag("vault_r1_solved")).toBe(false);
    expect(JSON.stringify(h.sent.map((e) => e.message))).toContain("answers only to the puzzle");
  });

  it("completes the dungeon when the Heart room is solved", async () => {
    const h = await vaultHarness("vault_r4");
    expect(h.snapshot.completed).toBe(false);
    await h.start("start");
    vi.setSystemTime(T0 + 10_000);
    await h.solve("s1");
    expect(h.sealState(4)).toBe("on");
    expect(h.lastSnapshot().completed).toBe(true);
  });
});

describe("heart puzzle flow: talk, lock, walls (server authority)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it("rejects a solve that was never started at Old Pell", async () => {
    const h = await vaultHarness("vault_r1");
    vi.setSystemTime(T0 + 60_000);
    await h.solve("s1");
    expect(h.sealState(1)).not.toBe("on");
    expect(JSON.stringify(h.sent.map((e) => e.message))).toContain("Talk to Old Pell");
  });

  it("only starts next to Old Pell", async () => {
    const h = await vaultHarness("vault_r1", { x: 900, y: 250 });
    await h.start("far");
    expect(h.errors()).toContain("OUT_OF_RANGE");
    expect(h.lastSnapshot()?.heartPuzzleActiveRoomId ?? null).toBeNull();
  });

  it("locks movement while the puzzle is active and unlocks on the solve", async () => {
    const h = await vaultHarness("vault_r1");
    await h.start("start");
    expect(h.lastSnapshot().heartPuzzleActiveRoomId).toBe("vault_r1");
    expect(h.lastSnapshot().player.targetX).toBeNull();
    await h.move("m1", 200, 250);
    expect(h.errors()).toContain("PUZZLE_LOCKED");
  });

  it("rejects a dash while locked", async () => {
    const h = await vaultHarness("vault_r1");
    await h.start("start");
    expect(() => h.runtime.dash("player-1", 1, 0)).toThrow(/puzzle/);
  });

  it("unlocks after the solve", async () => {
    const h = await vaultHarness("vault_r1");
    await h.start("start");
    vi.setSystemTime(T0 + 10_000);
    await h.solve("s1");
    expect(h.sealState(1)).toBe("on");
    expect(h.lastSnapshot().heartPuzzleActiveRoomId).toBeNull();
    const before = h.errors().length;
    await h.move("m1", 200, 250);
    expect(h.errors().length).toBe(before);
    expect(h.lastSnapshot().player.targetX).not.toBeNull();
  });

  it("quitting unlocks and resets: the next solve needs a fresh start", async () => {
    const h = await vaultHarness("vault_r1");
    await h.start("start");
    vi.setSystemTime(T0 + 10_000);
    await h.start("quit", false);
    expect(h.lastSnapshot().heartPuzzleActiveRoomId).toBeNull();
    await h.move("m1", 200, 250);
    expect(h.errors()).not.toContain("PUZZLE_LOCKED");
    await h.solve("s1");
    expect(h.sealState(1)).not.toBe("on");
    expect(JSON.stringify(h.sent.map((e) => e.message))).toContain("Talk to Old Pell");
  });

  it("a restart after a quit restarts the server's minimum-time clock", async () => {
    const h = await vaultHarness("vault_r1");
    await h.start("start");
    vi.setSystemTime(T0 + 30_000);
    await h.start("quit", false);
    await h.start("again");
    vi.setSystemTime(T0 + 31_000);
    await h.solve("s1");
    expect(h.sealState(1)).not.toBe("on");
    vi.setSystemTime(T0 + 38_000);
    await h.solve("s2");
    expect(h.sealState(1)).toBe("on");
  });

  it("clears the lock when the connection drops (reconnect comes back reset and unlocked)", async () => {
    const h = await vaultHarness("vault_r1");
    await h.start("start");
    h.runtime.suspend("player-1");
    expect(h.runtime.snapshotForSession("player-1", h.snapshot.sessionId).heartPuzzleActiveRoomId).toBeNull();
  });

  it("makes the whole unsolved board footprint solid for players (corridors, holes, Maze 1's open bottom row); the solve opens it", async () => {
    const h = await vaultHarness("vault_r1", { x: 950, y: 1200 });
    // Board origin (180, 310), 80-unit cells, 9 x 13. A wall (0,0), a hole (4,1) and the open bottom-row corridor (6,12).
    await h.move("wall", 220, 350);
    await h.move("hole", 540, 430);
    await h.move("bottom-row", 700, 1310);
    expect(h.errors().filter((code) => code === "BLOCKED_TARGET")).toHaveLength(3);
    // The seal and the doors below the board stay reachable.
    const before = h.errors().length;
    await h.move("door", 890, 1379);
    await h.move("escape", 540, 1372);
    expect(h.errors().length).toBe(before);
    const instance = [...(h.runtime as any).instances.values()][0];
    instance.objectStates.set("vault_r1:vault_seal_1", "on");
    await h.move("bottom-row-after", 700, 1310);
    expect(h.errors().length).toBe(before);
    expect(h.lastSnapshot().player.targetX).not.toBeNull();
  });
});

describe("heart puzzle lock: no other way to move, no way to get stuck (server authority)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it("blocks combat approach and combat repositioning (lunges, knockback) while locked", async () => {
    const h = await vaultHarness("vault_r1");
    await h.start("start");
    const session = (h.runtime as any).sessions.get("player-1");
    const from = { x: session.x, y: session.y };
    const near = dungeonLocalToCombatPosition(from.x + 40, from.y);
    h.runtime.setCombatTarget("player-1", near);
    expect(session.targetX).toBeNull();
    expect(h.runtime.repositionCombatPlayer("player-1", near)).toBe(false);
    expect({ x: session.x, y: session.y }).toEqual(from);
    await h.start("quit", false);
    expect(h.runtime.repositionCombatPlayer("player-1", near)).toBe(true);
  });

  it("a portal approach is refused while locked; the room change of a used portal releases the lock", async () => {
    const h = await vaultHarness("vault_r1");
    await h.start("start");
    // The universal portal approach walks via moveTo, which the lock refuses (the player can still give up at Pell).
    expect(() => h.runtime.moveTo("player-1", h.snapshot.sessionId, 890, 1379)).toThrow(/puzzle/);
    const changed = h.runtime.transferSpace("player-1", h.snapshot.sessionId, "vault_r2", { x: 190, y: 227 });
    expect(changed.heartPuzzleActiveRoomId).toBeNull();
    expect(() => h.runtime.dash("player-1", 1, 0)).not.toThrow(/puzzle/);
  });

  it("releases the lock when the seal opens some other way (a party member solved it)", async () => {
    const h = await vaultHarness("vault_r1");
    await h.start("start");
    const instance = [...(h.runtime as any).instances.values()][0];
    instance.objectStates.set("vault_r1:vault_seal_1", "on");
    expect(h.runtime.snapshotForSession("player-1", h.snapshot.sessionId).heartPuzzleActiveRoomId).toBeNull();
    const before = h.errors().length;
    await h.move("m1", 200, 250);
    expect(h.errors().length).toBe(before);
    // A late solve report from the locked player is a no-op that also releases.
    await h.solve("late");
    expect(h.lastSnapshot().heartPuzzleActiveRoomId).toBeNull();
  });

  it("comes back unlocked after a reconnect or a server restart (the lock lives only in the live session)", async () => {
    const h = await vaultHarness("vault_r1");
    await h.start("start");
    const restored = await h.runtime.restore(
      { playerId: "player-1", username: "P", displayColor: null, movementRevision: 9, regionCode: "world",
        position: { lat: 35, lon: -106 } } as never,
      { sewerId: "vault-1", spaceId: "vault_r1", position: BY_PELL.vault_r1 } as never);
    expect(restored!.heartPuzzleActiveRoomId).toBeNull();
    const fresh = await vaultHarness("vault_r1");
    expect(fresh.snapshot.heartPuzzleActiveRoomId ?? null).toBeNull();
  });
});

describe("developer Vault run reset", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it("refuses a run entered from a player-facing entrance", async () => {
    const h = await vaultHarness("vault_r1");
    await expect(h.runtime.resetDeveloperRun("player-1")).rejects.toThrow(/developer entrance/);
  });

  it("puts every seal back, clears completion and locks, and sends the player to the first room's spawn", async () => {
    const h = await vaultHarness("vault_r1");
    (h.runtime as any).sessions.get("player-1").sewerId = "dev-dungeon-test";
    await h.start("start");
    const instance = [...(h.runtime as any).instances.values()][0];
    for (const n of [1, 2, 3, 4]) instance.objectStates.set(`vault_r${n}:vault_seal_${n}`, "on");
    instance.completed = true;
    const snapshot = await h.runtime.resetDeveloperRun("player-1");
    expect(snapshot.completed).toBe(false);
    expect(snapshot.heartPuzzleActiveRoomId).toBeNull();
    expect(snapshot.spaceId).toBe("vault_r1");
    expect(snapshot.objects.find((o) => o.id === "vault_seal_1")?.state).not.toBe("on");
    for (const n of [1, 2, 3, 4]) expect(instance.objectStates.get(`vault_r${n}:vault_seal_${n}`)).not.toBe("on");
    expect({ x: snapshot.player.x, y: snapshot.player.y }).toEqual({ x: 134, y: 264 });
    // A replay needs a fresh talk to Old Pell.
    vi.setSystemTime(T0 + 60_000);
    await h.solve("s1");
    expect(JSON.stringify(h.sent.map((e) => e.message))).toContain("Talk to Old Pell");
  });
});

describe("dungeon snapshot telegraphs", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it("ships a combat mob cast (durationMs/remainingMs) in a DUNGEON_SNAPSHOT the client accepts", async () => {
    const h = await vaultHarness("combat_a", { x: 600, y: 600 });
    const origin = dungeonLocalToCombatPosition(600, 600);
    (h.playerEntity as Record<string, unknown>).telegraphs = [{
      encounterId: "mob:dungeon:x", bossId: "ember_shade", abilityId: "ember_wail", castInstanceId: "dungeon:x:ember_wail:12",
      startTime: T0, resolveTime: T0 + 900, durationMs: 900, remainingMs: 600, origin,
      geometry: { kind: "circle", center: origin, radiusM: 120 }, lifeGeneration: 1
    }];
    const snapshot = h.runtime.snapshotForSession("player-1", h.snapshot.sessionId);
    expect(snapshot.telegraphs).toHaveLength(1);
    expect(snapshot.telegraphs[0]).not.toHaveProperty("remainingMs");
    expect(() => parseServerMessage(JSON.stringify({ type: "DUNGEON_SNAPSHOT", snapshot }))).not.toThrow();
  });
});

describe("death in the Vault respawns at the start of the room (server authority)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it("is a room-respawn dungeon only for players inside the Tilted Vault", async () => {
    const h = await vaultHarness("combat_a", { x: 600, y: 600 });
    expect(h.runtime.respawnsInRoomOnDeath("player-1")).toBe(true);
    expect(h.runtime.respawnsInRoomOnDeath("nobody")).toBe(false);
    const session = (h.runtime as any).sessions.get("player-1");
    session.dungeon = { ...session.dungeon, id: "some_other_dungeon" };
    expect(h.runtime.respawnsInRoomOnDeath("player-1")).toBe(false);
  });

  it("puts the player back at the combat room's spawn, in the same room, with solved seals still open", async () => {
    const h = await vaultHarness("combat_a", { x: 600, y: 600 });
    const instance = [...(h.runtime as any).instances.values()][0];
    instance.objectStates.set("vault_r1:vault_seal_1", "on");
    const position = h.runtime.respawnPlayer("player-1");
    expect(position).toEqual(dungeonLocalToCombatPosition(308, 276));
    const snapshot = h.runtime.snapshotForSession("player-1", h.snapshot.sessionId);
    expect(snapshot.spaceId).toBe("combat_a");
    expect({ x: snapshot.player.x, y: snapshot.player.y }).toEqual({ x: 308, y: 276 });
    expect(snapshot.player.targetX).toBeNull();
    expect(instance.objectStates.get("vault_r1:vault_seal_1")).toBe("on");
  });

  it("releases an active heart-puzzle lock and needs a fresh talk to Old Pell", async () => {
    const h = await vaultHarness("vault_r2");
    await h.start("start");
    expect(h.lastSnapshot().heartPuzzleActiveRoomId).toBe("vault_r2");
    h.runtime.respawnPlayer("player-1");
    const snapshot = h.runtime.snapshotForSession("player-1", h.snapshot.sessionId);
    expect(snapshot.spaceId).toBe("vault_r2");
    expect(snapshot.heartPuzzleActiveRoomId).toBeNull();
    vi.setSystemTime(T0 + 60_000);
    await h.solve("s1");
    expect(h.sealState(2)).not.toBe("on");
    expect(JSON.stringify(h.sent.map((e) => e.message))).toContain("Talk to Old Pell");
  });
});

describe("a wiped Vault fight wakes again on the next entry (server authority)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  for (const [roomId, mobCount] of [["combat_a", 6], ["combat_b", 7], ["combat_c", 5]] as const) {
    it(`${roomId}: wipe, respawn at the room start, the mobs spawn again, the clear opens the door`, async () => {
      const h = await vaultHarness(roomId, { x: 600, y: 600 });
      const encounterState = () => h.runtime.get("player-1")?.encounters.find((e) => e.id === `${roomId}_fight`)?.state;
      const living = () => [...h.entities.values()].filter((e) => e.lifeState === "alive").length;
      const at = async (ms: number) => { vi.setSystemTime(T0 + ms); await h.runtime.tick(0); };
      await at(0);
      expect(encounterState()).toBe("active");
      expect(living()).toBe(mobCount);

      // The only player dies: a party wipe clears the mobs and resets the fight.
      h.playerEntity.lifeState = "defeated";
      await at(500);
      expect(encounterState()).toBe("resetting");
      expect(living()).toBe(0);
      // The reset ends while the player still lies dead: the fight waits (no spawn, no wipe loop).
      await at(4_000);
      await at(8_000);
      expect(encounterState()).toBe("idle");
      expect(living()).toBe(0);

      // Respawn (the start of the room, inside the detector) is a fresh entry: the fight wakes again.
      const position = h.runtime.respawnPlayer("player-1");
      h.playerEntity.lifeState = "alive";
      expect(position).toBeTruthy();
      await at(9_000);
      expect(encounterState()).toBe("active");
      expect(living()).toBe(mobCount);
      expect(h.runtime.snapshotForSession("player-1", h.snapshot.sessionId).dungeonFlags?.[`${roomId}_cleared`]).not.toBe(true);

      for (const mob of h.entities.values()) { mob.lifeState = "defeated"; mob.currentHealth = 0; }
      await at(10_000);
      expect(encounterState()).toBe("completed");
      const snapshot = h.runtime.snapshotForSession("player-1", h.snapshot.sessionId);
      expect(snapshot.dungeonFlags?.[`${roomId}_cleared`]).toBe(true);
      const nextRoom = { combat_a: "vault_r2", combat_b: "vault_r3", combat_c: "vault_r4" }[roomId];
      const door = snapshot.objects.find((o: { id: string }) => o.id === `${roomId}_to_${nextRoom}_object`);
      expect(door, "forward door object").toBeTruthy();
      expect((door as { available?: boolean }).available).not.toBe(false);
      // A completed fight never restarts, even on another respawn.
      h.runtime.respawnPlayer("player-1");
      await at(11_000);
      expect(encounterState()).toBe("completed");
      expect(living()).toBe(0);
    });
  }

  for (const roomId of ["combat_a", "combat_b", "combat_c"]) {
    it(`${roomId} mobs spawn at the level of the highest-level living player in the room`, async () => {
      const h = await vaultHarness(roomId, { x: 600, y: 600 });
      const at = async (ms: number) => { vi.setSystemTime(T0 + ms); await h.runtime.tick(0); };
      await at(0);
      // The restore woke the fight before the player's level was known here: wipe it, then wake it at level 7.
      (h.playerEntity as { level?: number }).level = 7;
      h.playerEntity.lifeState = "downed";
      await at(500);
      await at(4_000);
      h.combat.spawnMob.mockClear();
      h.playerEntity.lifeState = "alive";
      await at(5_000);
      const calls = h.combat.spawnMob.mock.calls.map(([input]) => input as unknown as { archetype: string; combatProfile?: { level: number } });
      expect(calls.length).toBeGreaterThan(0);
      // Every mob, the elite Warden included (its elite modifiers stay), comes in at level 7.
      for (const call of calls) expect(call.combatProfile?.level, call.archetype).toBe(7);
    });
  }

  it("a respawn wakes the fight at the player's level even before combat marks them alive", async () => {
    const h = await vaultHarness("combat_a", { x: 600, y: 600 });
    const at = async (ms: number) => { vi.setSystemTime(T0 + ms); await h.runtime.tick(0); };
    await at(0);
    (h.playerEntity as { level?: number }).level = 9;
    h.playerEntity.lifeState = "respawning";
    await at(500);
    await at(4_000);
    h.combat.spawnMob.mockClear();
    h.runtime.respawnPlayer("player-1");
    await at(4_100);
    const calls = h.combat.spawnMob.mock.calls.map(([input]) => input as unknown as { combatProfile?: { level: number } });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.combatProfile?.level).toBe(9);
  });

  it("a fight wiped by a downed (not killed) player wakes again when they recover where they lie", async () => {
    const h = await vaultHarness("combat_b", { x: 600, y: 600 });
    const encounterState = () => h.runtime.get("player-1")?.encounters.find((e) => e.id === "combat_b_fight")?.state;
    const living = () => [...h.entities.values()].filter((e) => e.lifeState === "alive").length;
    const at = async (ms: number) => { vi.setSystemTime(T0 + ms); await h.runtime.tick(0); };
    await at(0);
    expect(encounterState()).toBe("active");
    const mobCount = living();
    h.playerEntity.lifeState = "downed";
    await at(500);
    expect(encounterState()).toBe("resetting");
    await at(4_000);
    expect(encounterState()).toBe("idle");
    expect(living()).toBe(0);
    // Downed recovery: alive again in place, no respawn, no new zone entry.
    h.playerEntity.lifeState = "alive";
    await at(5_000);
    expect(encounterState()).toBe("active");
    expect(living()).toBe(mobCount);
  });

  it("after a dev Reset Vault run from a woken combat room, walking back in wakes the fight again", async () => {
    const h = await vaultHarness("combat_a", { x: 600, y: 600 });
    const session = (h.runtime as any).sessions.get("player-1");
    session.sewerId = "dev-dungeon-test";
    // No location store here: the room moves go straight to transferSpace (production commits the transition first).
    (h.runtime as any).playerLocations = undefined;
    const encounterState = () => h.runtime.get("player-1")?.encounters.find((e) => e.id === "combat_a_fight")?.state;
    const living = () => [...h.entities.values()].filter((e) => e.lifeState === "alive").length;
    const at = async (ms: number) => { vi.setSystemTime(T0 + ms); await h.runtime.tick(0); };
    await at(0);
    expect(encounterState()).toBe("active");
    const mobCount = living();
    expect(mobCount).toBeGreaterThan(0);

    const reset = await h.runtime.resetDeveloperRun("player-1");
    expect(reset.spaceId).toBe("vault_r1");
    expect(living()).toBe(0);
    await at(1_000);
    await at(5_000);
    expect(encounterState()).toBe("idle");

    await (h.runtime as any).relocateWithinRun(session, "test:combat_a", "combat_a", { x: 600, y: 600 });
    await at(6_000);
    expect(encounterState()).toBe("active");
    expect(living()).toBe(mobCount);
  });

  it("a reset that ends with a living player already in the room wakes the fight at once", async () => {
    const h = await vaultHarness("combat_a", { x: 600, y: 600 });
    const encounterState = () => h.runtime.get("player-1")?.encounters.find((e) => e.id === "combat_a_fight")?.state;
    const at = async (ms: number) => { vi.setSystemTime(T0 + ms); await h.runtime.tick(0); };
    await at(0);
    h.playerEntity.lifeState = "defeated";
    await at(500);
    expect(encounterState()).toBe("resetting");
    // Respawned during the reset window: the start trigger only fires while the fight is idle, the reset end restarts it.
    h.runtime.respawnPlayer("player-1");
    h.playerEntity.lifeState = "alive";
    await at(1_000);
    expect(encounterState()).toBe("resetting");
    await at(4_000);
    expect(encounterState()).toBe("active");
    expect([...h.entities.values()].filter((e) => e.lifeState === "alive")).toHaveLength(6);
  });
});

describe("walking back through a finished Vault (server authority)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  const sessionOf = (h: Awaited<ReturnType<typeof vaultHarness>>) => (h.runtime as any).sessions.get("player-1");

  it("solves every room, then walks back through every backward door and can move in each room", async () => {
    const h = await vaultHarness("vault_r1");
    const sid = h.snapshot.sessionId;
    const dungeon = DUNGEON_CATALOG.dungeons.find((c) => c.id === "tilted_vault")!;
    let now = T0;
    for (const n of [1, 2, 3, 4]) {
      const room = `vault_r${n}`;
      if (n > 1) h.runtime.transferSpace("player-1", sid, room, { x: BY_PELL[room]!.x, y: BY_PELL[room]!.y });
      h.runtime.puzzleSetActive("player-1", sid, room, true);
      now += 20_000; vi.setSystemTime(now);
      h.runtime.puzzleSolve("player-1", sid, room, `solve-${n}`);
    }
    expect(h.runtime.snapshotForSession("player-1", sid).completed).toBe(true);
    const backDoors = dungeon.portals.filter((portal) => portal.id.endsWith("_back")).reverse();
    expect(backDoors).toHaveLength(6);
    for (const portal of backDoors) {
      const destination = portal.destination as { roomId: string };
      const room: any = dungeon.rooms.find((candidate) => candidate.id === destination.roomId)!;
      const arrival = room.anchors.find((anchor: any) => anchor.id === portal.destinationArrivalAnchorId)!;
      const snapshot = h.runtime.transferSpace("player-1", sid, destination.roomId, { x: arrival.x, y: arrival.y });
      expect({ room: snapshot.spaceId, x: snapshot.player.x, y: snapshot.player.y }, portal.id)
        .toEqual({ room: destination.roomId, x: arrival.x, y: arrival.y });
      if (destination.roomId.startsWith("vault_r")) {
        const n = Number(destination.roomId.slice(-1));
        expect(snapshot.objects.find((o: any) => o.id === `vault_seal_${n}`)?.state, portal.id).toBe("on");
        expect(snapshot.heartPuzzleActiveRoomId).toBeNull();
      }
      // Walk a short hop away from the door and let the server step the movement.
      const before = { x: sessionOf(h).x, y: sessionOf(h).y };
      h.runtime.moveTo("player-1", sid, arrival.x - 60, arrival.y - 60);
      h.runtime.advanceMovement(0.25);
      const after = sessionOf(h);
      expect(Math.hypot(after.x - before.x, after.y - before.y), `moved after ${portal.id}`).toBeGreaterThan(5);
    }
  });

  it("moves a player found inside an unsolved board to open floor, and they can walk on", async () => {
    const h = await vaultHarness("vault_r1");
    const session = sessionOf(h);
    // Death-recovery point of the room: well inside the solid board footprint.
    session.x = 540; session.y = 830;
    h.runtime.advanceMovement(0.05);
    expect(isIndoorNavigationPointWalkable((h.runtime as any).playerNavigation(session), session)).toBe(true);
    const moved = { x: session.x, y: session.y };
    h.runtime.moveTo("player-1", h.snapshot.sessionId, moved.x, moved.y + 10);
    h.runtime.advanceMovement(0.25);
    expect(session.y).not.toBe(moved.y);
  });

  it("moves a player standing outside the floor of the room back onto it", async () => {
    const h = await vaultHarness("vault_r2");
    const session = sessionOf(h);
    session.x = 20; session.y = 20;
    h.runtime.advanceMovement(0.05);
    expect(isIndoorNavigationPointWalkable((h.runtime as any).playerNavigation(session), session)).toBe(true);
  });
});

describe("dungeon state persistence waits for hydration (server restart race)", () => {
  it("does not write an instance's defaults before its saved run was read, and writes once it was", async () => {
    const h = await vaultHarness("vault_r1");
    const runtime = h.runtime as any;
    const instance = [...runtime.instances.values()][0];
    // A fresh uuid run, as after a restart: the instance exists in memory but the saved run is not read yet.
    instance.legacySewer = false;
    instance.runId = "00000000-0000-4000-8000-000000900007";
    runtime.hydratedRuns.delete(instance);
    const writes = () => (runtime.pool.query as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => String(call[0]).includes("INSERT INTO dungeon_instance_state")).length;
    const before = writes();
    await runtime.persistInstanceState(instance);
    expect(writes()).toBe(before);
    runtime.hydratedRuns.set(instance, instance.runId);
    await runtime.persistInstanceState(instance);
    expect(writes()).toBe(before + 1);
  });
});
