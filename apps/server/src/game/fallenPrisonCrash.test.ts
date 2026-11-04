import { describe, expect, it, vi } from "vitest";
import {
  DUNGEON_CATALOG,
  FALLEN_PRISON_HUNT,
  effectiveDungeonMinimumLevel,
  describeDungeonAccess,
  CURRENT_LEVEL_CAP,
  destinationPoint,
  distanceMeters,
  fallenPrisonHuntBand,
  fallenPrisonHuntDirection,
  fallenPrisonHuntHint,
  fallenPrisonLandingAnnouncement
} from "@ash-atlas/shared";
import type pg from "pg";

import type { CombatEngine } from "./combat/combatEngine.js";
import { CisternWarrensRuntime } from "./dungeon.js";
import type { DeveloperSpawnedDungeonEntrance, DeveloperSpawnedDungeonService } from "./developerSpawnedDungeons.js";
import {
  FALLEN_PRISON_AUTO_CRASH,
  FALLEN_PRISON_CRASH_DURATION_MS,
  FALLEN_PRISON_GUARD_RESPAWN_MS,
  FallenPrisonCrashService,
  type FallenPrisonHuntMessage
} from "./fallenPrisonCrash.js";

function harness() {
  const clock = { now: Date.parse("2026-10-03T12:00:00Z") };
  const spawned: string[] = [];
  const alive = new Map<string, "alive" | "defeated">();
  const combat = {
    spawnMob: vi.fn((input: { entityId: string }) => { spawned.push(input.entityId); alive.set(input.entityId, "alive"); }),
    entity: (id: string) => (alive.has(id) ? { lifeState: alive.get(id) } : null),
    despawnMob: vi.fn((id: string) => { alive.delete(id); }),
    isCompanionPositionTraversable: vi.fn(() => true)
  };
  const placements = {
    spawn: vi.fn(async (input: { requestId: string; position: { lat: number; lon: number }; regionCode: string; expiresAt: Date; eventKind: string }) => ({
      replayed: false,
      entrance: {
        entranceId: `dev-dungeon-${input.requestId}`, creatorPlayerId: "dev", requestId: input.requestId, templateId: "x", templateRevision: "1",
        templatePortalRevision: "1", dungeonRevision: "1", catalogRevision: 1, placementRevision: 1, regionCode: input.regionCode,
        position: input.position, createdAt: new Date(clock.now).toISOString(), deletedAt: null,
        expiresAt: input.expiresAt.toISOString(), eventKind: input.eventKind
      } satisfies DeveloperSpawnedDungeonEntrance
    })),
    listActive: vi.fn(async () => [])
  };
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("player_progression_profiles")) {
        return { rows: (params[0] as string[]).filter((id) => !id.startsWith("low")).map((id) => ({ player_id: id })) };
      }
      return { rows: [] };
    })
  };
  const players: { playerId: string; position: { lat: number; lon: number } }[] = [];
  const sent: { playerId: string; message: FallenPrisonHuntMessage }[] = [];
  const connections = new Map<string, string>();
  const land = { answer: true as boolean | null };
  const landAt = vi.fn(async (points: readonly unknown[]) => points.map(() => land.answer));
  const service = new FallenPrisonCrashService(
    pool as unknown as pg.Pool, placements as unknown as DeveloperSpawnedDungeonService, combat as unknown as CombatEngine, undefined, () => clock.now,
    { onlinePlayers: () => players, landAt, send: (playerId, message) => { sent.push({ playerId, message }); },
      connectionKey: (playerId) => connections.get(playerId) ?? "c1" }
  );
  const landed = () => placements.spawn.mock.calls.map(([input]) => input);
  return { clock, service, combat, placements, spawned, alive, players, landed, sent, connections, land, landAt };
}

describe("Fallen Prison crash event", () => {
  it("lands for 24 hours with guards, one crash at a time", async () => {
    const { service, placements, spawned } = harness();
    await service.trigger({ creatorPlayerId: "dev", requestId: "r1", regionCode: "pkg", position: { lat: 35, lon: -106 } });
    const call = placements.spawn.mock.calls[0]![0];
    expect(call.expiresAt.getTime() - Date.parse("2026-10-03T12:00:00Z")).toBe(FALLEN_PRISON_CRASH_DURATION_MS);
    expect(spawned.length).toBe(7);
    await expect(service.trigger({ creatorPlayerId: "dev", requestId: "r2", regionCode: "pkg", position: { lat: 35, lon: -106 } }))
      .rejects.toMatchObject({ code: "FALLEN_PRISON_ALREADY_LANDED" });
  });

  it("respawns fallen guards after 6 hours and clears everything at expiry", async () => {
    const { service, clock, alive, spawned } = harness();
    await service.trigger({ creatorPlayerId: "dev", requestId: "r1", regionCode: "pkg", position: { lat: 35, lon: -106 } });
    alive.set(spawned[0]!, "defeated");
    await service.tick();
    expect(spawned.length).toBe(7);
    clock.now += FALLEN_PRISON_GUARD_RESPAWN_MS + 1;
    await service.tick();
    expect(spawned.length).toBe(8);
    clock.now += FALLEN_PRISON_CRASH_DURATION_MS;
    await service.tick();
    expect(alive.size).toBe(0);
    expect(service.currentCrash()).toBeNull();
  });
});

describe("Fallen Prison automatic crashes", () => {
  it("lands one crash 15-30 km from an eligible player, none for under-level players, and a new one only after expiry", async () => {
    const { service, placements, players, landed, clock, combat, landAt } = harness();
    players.push({ playerId: "low1", position: { lat: 35, lon: -106 } });
    await service.tick();
    expect(placements.spawn).not.toHaveBeenCalled();
    players.push({ playerId: "p1", position: { lat: 35.2, lon: -106 } });
    clock.now += FALLEN_PRISON_AUTO_CRASH.checkIntervalMs;
    await service.tick();
    expect(placements.spawn).toHaveBeenCalledTimes(1);
    expect(landed()).toHaveLength(1);
    expect(combat.isCompanionPositionTraversable).toHaveBeenCalled();
    expect(landAt).toHaveBeenCalled();
    const metres = distanceMeters(players[1]!.position, landed()[0]!.position);
    expect(FALLEN_PRISON_AUTO_CRASH.minDistanceM).toBe(15_000);
    expect(FALLEN_PRISON_AUTO_CRASH.maxDistanceM).toBe(30_000);
    expect(metres).toBeGreaterThanOrEqual(15_000 - 1);
    expect(metres).toBeLessThanOrEqual(30_000 + 1);
    clock.now += FALLEN_PRISON_AUTO_CRASH.checkIntervalMs;
    await service.tick();
    expect(placements.spawn).toHaveBeenCalledTimes(1);
    clock.now += FALLEN_PRISON_CRASH_DURATION_MS;
    await service.tick();
    expect(placements.spawn).toHaveBeenCalledTimes(2);
    clock.now += FALLEN_PRISON_AUTO_CRASH.checkIntervalMs;
    await service.tick();
    expect(placements.spawn).toHaveBeenCalledTimes(2);
  });

  it("skips a spot that is not walkable land, and fails closed when World does not answer (retrying next check)", async () => {
    const { service, placements, players, combat, land, clock } = harness();
    combat.isCompanionPositionTraversable.mockReturnValue(false);
    players.push({ playerId: "p1", position: { lat: 35.2, lon: -106 } });
    await service.tick();
    expect(placements.spawn).not.toHaveBeenCalled();
    combat.isCompanionPositionTraversable.mockReturnValue(true);
    land.answer = false;
    clock.now += FALLEN_PRISON_AUTO_CRASH.checkIntervalMs;
    await service.tick();
    land.answer = null;
    clock.now += FALLEN_PRISON_AUTO_CRASH.checkIntervalMs;
    await service.tick();
    expect(placements.spawn).not.toHaveBeenCalled();
    land.answer = true;
    clock.now += FALLEN_PRISON_AUTO_CRASH.checkIntervalMs;
    await service.tick();
    expect(placements.spawn).toHaveBeenCalledTimes(1);
  });

  it("announces the landing and keeps a live, level-gated hint towards the crash", async () => {
    const { service, players, landed, sent, clock, connections } = harness();
    players.push({ playerId: "p1", position: { lat: 35.2, lon: -106 } }, { playerId: "low1", position: { lat: 35.21, lon: -106 } });
    await service.tick();
    const crash = landed()[0]!.position;
    const landing = sent.filter((entry) => entry.playerId === "p1");
    expect(landing).toHaveLength(1);
    expect(landing[0]!.message.announcement).toBe(fallenPrisonLandingAnnouncement(players[0]!.position, crash));
    expect(landing[0]!.message.announcement).toMatch(/^A prison has fallen from the sky somewhere to the (north|south|east|west|north-east|north-west|south-east|south-west)\.$/u);
    expect(landing[0]!.message.hint).toEqual(fallenPrisonHuntHint(players[0]!.position, crash));
    expect(landing[0]!.message.hint?.band).toBe("far");
    // Below level 40: nothing at all.
    expect(sent.some((entry) => entry.playerId === "low1")).toBe(false);
    // Unchanged hint: nothing more is sent.
    clock.now += 30_000;
    await service.tick();
    expect(sent.filter((entry) => entry.playerId === "p1")).toHaveLength(1);
    // Walking in: the band tightens and the smoke comes into sight.
    players[0]!.position = destinationPoint(crash, 5_000, 0);
    await service.tick();
    expect(sent.at(-1)).toMatchObject({ playerId: "p1", message: { hint: { direction: "south", band: "closer", smokeInSight: false } } });
    players[0]!.position = destinationPoint(crash, 2_000, 90);
    await service.tick();
    expect(sent.at(-1)).toMatchObject({ playerId: "p1", message: { hint: { direction: "west", band: "near", smokeInSight: true } } });
    // A reconnect (new connection) gets the hint again.
    connections.set("p1", "c2");
    await service.tick();
    expect(sent.at(-1)).toMatchObject({ playerId: "p1", message: { hint: { band: "near" } } });
    const count = sent.length;
    await service.tick();
    expect(sent.length).toBe(count);
    // Out of range: cleared once.
    players[0]!.position = destinationPoint(crash, FALLEN_PRISON_HUNT.hintRadiusM + 1_000, 0);
    await service.tick();
    expect(sent.at(-1)).toEqual({ playerId: "p1", message: { type: "FALLEN_PRISON_HUNT", hint: null } });
    await service.tick();
    expect(sent.length).toBe(count + 1);
    expect(sent.some((entry) => entry.playerId === "low1")).toBe(false);
  });

  it("is listed to nearby players only once its smoke is in sight (3 km), other placements at the usual radius", async () => {
    const from = { lat: 35, lon: -106 };
    const placement = (entranceId: string, distanceM: number, eventKind: string | null) => ({
      entranceId, eventKind, position: destinationPoint(from, distanceM, 90)
    });
    const developer = {
      listActive: async () => [placement("crash-far", 4_000, "fallen_prison_crash"), placement("crash-near", 2_500, "fallen_prison_crash"),
        placement("dev-other", 4_000, null)],
      snapshotFor: (entry: { entranceId: string; position: { lat: number; lon: number } }) => ({
        entranceId: entry.entranceId, dungeonId: "fallen_prison", lat: entry.position.lat, lon: entry.position.lon, developerSpawned: false
      })
    };
    const runtime = new CisternWarrensRuntime({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never, {} as never,
      undefined, undefined, {}, DUNGEON_CATALOG, undefined, developer as never);
    const listed = (await runtime.entrancesNear(from, 25_000)).map((entrance) => entrance.entranceId);
    expect(listed).toContain("crash-near");
    expect(listed).toContain("dev-other");
    expect(listed).not.toContain("crash-far");
  });

  it("hint math: 8-point compass and far / closer / near bands within 40 km", () => {
    expect([0, 44, 46, 90, 135, 180, 225, 270, 315, 338, 359, -90].map(fallenPrisonHuntDirection)).toEqual([
      "north", "north-east", "north-east", "east", "south-east", "south", "south-west", "west", "north-west", "north", "north", "west"
    ]);
    expect([0, 2_999, 3_000, 9_999, 10_000, 40_000].map(fallenPrisonHuntBand)).toEqual(["near", "near", "closer", "closer", "far", "far"]);
    const from = { lat: 35, lon: -106 };
    expect(fallenPrisonHuntHint(from, destinationPoint(from, 20_000, 45))).toEqual({ direction: "north-east", band: "far", smokeInSight: false });
    expect(fallenPrisonHuntHint(from, destinationPoint(from, 2_500, 200))).toEqual({ direction: "south", band: "near", smokeInSight: true });
    expect(fallenPrisonHuntHint(from, destinationPoint(from, 41_000, 0))).toBeNull();
  });
});

describe("Fallen Prison catalog", () => {
  const dungeon = DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "fallen_prison")!;

  it("asks for level 40 capped by the level cap, with torch cost and lockout", () => {
    expect(dungeon.access?.minimumLevel).toBe(40);
    expect(effectiveDungeonMinimumLevel(dungeon.access)).toBe(Math.min(40, CURRENT_LEVEL_CAP));
    expect(dungeon.access?.lockoutHours).toBe(10);
    expect(describeDungeonAccess(dungeon.access)).toContain("10-hour lockout after clearing");
    expect(dungeon.access?.entryCost?.length).toBeGreaterThan(0);
  });

  it("has three timed rescue cells, three bosses and a Seal chest per boss", () => {
    const rescues = dungeon.encounters.filter((encounter) => encounter.rescue);
    expect(rescues.map((encounter) => encounter.rescue!.timeLimitMs)).toEqual([75_000, 80_000, 90_000]);
    expect([...dungeon.bossTemplateIds].sort()).toEqual(["brood_matron", "centurion", "trifang_warden"]);
    const seals = DUNGEON_CATALOG.rewardTables
      .filter((table) => table.id.startsWith("fallen_prison_") && table.items.some((item) => item.itemId === "edict_seal"))
      .map((table) => table.items.find((item) => item.itemId === "edict_seal")!.quantity)
      .sort((left, right) => left - right);
    expect(seals).toEqual([13, 27, 44]);
  });
});
