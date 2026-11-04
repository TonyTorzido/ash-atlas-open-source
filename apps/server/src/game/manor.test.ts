import {
  MANOR_CHEST,
  MANOR_CHEST_INTERACTION_RADIUS,
  MANOR_DOOR,
  MANOR_DOOR_INTERACTION_RADIUS,
  MANOR_FLOOR_SIZE,
  MANOR_INTERACTION_APPROACH_INSET,
  MANOR_JEWEL,
  MANOR_JEWEL_INTERACTION_RADIUS,
  MANOR_MAIN_ROOM,
  MANOR_SMITH,
  MANOR_SMITH_INTERACTION_RADIUS,
  MANOR_SPAWN,
  DEFAULT_MANOR_TEMPLATE_CATALOG,
  distanceMeters,
  findIndoorNavigationRoute,
  indoorInteractionApproachPoint,
  isIndoorNavigationPointWalkable,
  isIndoorNavigationSegmentWalkable,
  manorRoomNavigation
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";
import { ManorError, ManorRuntime, ManorStorageService } from "./manor.js";
import { canonicalManorDecorationTransform, ManorDecorationService } from "./manorDecorations.js";
import { isWorldOnlyWhileInManor } from "../realtime/websocket.js";
import { loadConfig } from "../config.js";
import { GameState } from "./state.js";
import { isAggressionTravelLocked } from "./combat/combatEngine.js";
import { requireManorOwnerPresentForGuest } from "../realtime/manorRealtimeOperations.js";
import { createManorRealtimeOperations } from "../realtime/manorRealtimeOperations.js";
import { ConnectionGenerationLedger } from "../realtime/connectionLifecycle.js";
import { ConnectionRegistry } from "../realtime/connectionRegistry.js";

describe("ManorRuntime", () => {
  it("projects durable placements onto the generic authored Studio transform", () => {
    const template = DEFAULT_MANOR_TEMPLATE_CATALOG.templates.find((candidate) => candidate.id === "manor_lobby")!;
    const authored = template.decorations[0]!;
    const room = template.rooms.find((candidate) => candidate.id === authored.roomId)!;
    const surface = room.placementSurfaces.find((candidate) => candidate.id === authored.surfaceId)!;
    const updated = {
      ...authored,
      transform: {
        ...authored.transform,
        width: 64,
        height: 70,
        rotationDeg: 7,
        scaleX: 1.15,
        scaleY: .85,
        anchorX: .25,
        anchorY: .75
      }
    };

    const projected = canonicalManorDecorationTransform(
      updated,
      room,
      surface,
      { x: authored.transform.x, y: authored.transform.y }
    );

    expect(projected).toMatchObject({
      x: authored.transform.x,
      y: authored.transform.y,
      width: 64,
      height: 70,
      rotationDeg: 7,
      scaleX: 1.15,
      scaleY: .85,
      anchorX: .25,
      anchorY: .75
    });
  });

  it("creates private sessions at the shared spawn and rejects stale sessions", () => {
    const runtime = new ManorRuntime();
    const session = runtime.enter("a", "manor-a");
    expect(session.position).toMatchObject(MANOR_SPAWN);
    expect(() => runtime.requireSession("a", "11111111-1111-4111-8111-111111111111")).toThrowError(ManorError);
    expect(() => runtime.requireSession("b", session.sessionId)).toThrowError(ManorError);
  });

  it("moves smoothly without leaving authoritative bounds", () => {
    const runtime = new ManorRuntime();
    const session = runtime.enter("a", "manor-a");
    runtime.moveTo("a", session.sessionId, 300, 300);
    const first = runtime.tick(.05)[0]!;
    expect(first.position.moving).toBe(true);
    expect(first.position.x).toBeGreaterThan(300);
    for (let i = 0; i < 100; i += 1) runtime.tick(.05);
    expect(runtime.get("a")?.position).toMatchObject({ x: 300, y: 300, moving: false });
    expect(() => runtime.moveTo("a", session.sessionId, 0, 0)).toThrow(/outside/);
    expect(() => runtime.moveTo("a", session.sessionId, MANOR_FLOOR_SIZE, 500)).toThrow(/outside/);
    expect(() => runtime.moveTo("a", session.sessionId, Number.POSITIVE_INFINITY, 5)).toThrow(/finite/);
  });

  it("publishes one authoritative movement-settled event after reaching a portal threshold", async () => {
    const runtime = new ManorRuntime();
    const session = runtime.enter("a", "manor-a");
    const settled = vi.fn();
    runtime.moveTo("a", session.sessionId, 500, 880);
    runtime.subscribeMovementSettled("a", settled);

    for (let i = 0; i < 20 || (i < 200 && runtime.get("a")?.position.moving); i += 1) runtime.tick(.05);
    await Promise.resolve();
    runtime.tick(.05);
    await Promise.resolve();

    expect(runtime.get("a")?.position).toMatchObject({ x: 500, y: 880, moving: false });
    expect(settled).toHaveBeenCalledOnce();
  });

  it("settles through the former invisible collider area at the requested target", async () => {
    const runtime = new ManorRuntime();
    const session = runtime.restore(
      "a", "manor-a", "OWNER", MANOR_SPAWN, "manor_main_room"
    );
    const settled = vi.fn();
    const target = { x: 558, y: 485 };
    expect(isIndoorNavigationPointWalkable(MANOR_MAIN_ROOM, target)).toBe(true);
    expect(findIndoorNavigationRoute(MANOR_MAIN_ROOM, MANOR_SPAWN, target)).toEqual([target]);
    runtime.moveTo("a", session.sessionId, target.x, target.y);
    runtime.subscribeMovementSettled("a", settled);

    expect(runtime.get("a")?.position.targetX).toBe(target.x);
    for (let i = 0; i < 100 && runtime.get("a")?.position.moving; i += 1) {
      const [changed] = runtime.tick(.05);
      expect(changed).toBeTruthy();
      expect(isIndoorNavigationPointWalkable(MANOR_MAIN_ROOM, changed!.position)).toBe(true);
    }
    await Promise.resolve();

    expect(runtime.get("a")?.position).toMatchObject({ x: target.x, y: target.y, moving: false });
    expect(settled).toHaveBeenCalledOnce();
  });

  it("replaces and cancels private main-room routes", () => {
    const runtime = new ManorRuntime();
    const session = runtime.restore(
      "a", "manor-a", "OWNER", MANOR_SPAWN, "manor_main_room"
    );
    runtime.moveTo("a", session.sessionId, 500, 300);
    runtime.moveTo("a", session.sessionId, 800, 790);
    expect(runtime.get("a")?.position).toMatchObject({ targetX: 800, targetY: 790 });
    for (let i = 0; i < 30 && runtime.get("a")?.position.moving; i += 1) runtime.tick(.05);
    expect(runtime.get("a")?.position).toMatchObject({ x: 800, y: 790, moving: false });

    runtime.moveTo("a", session.sessionId, 500, 300);
    runtime.stop("a");
    const stopped = runtime.get("a")!.position;
    runtime.tick(.5);
    expect(runtime.get("a")?.position).toMatchObject({
      x: stopped.x, y: stopped.y, targetX: null, targetY: null, moving: false
    });
  });

  it("builds every room's navigation from the interior space exactly like manorRoomNavigation, plus decoration colliders", () => {
    const service = new ManorDecorationService({} as never);
    const template = DEFAULT_MANOR_TEMPLATE_CATALOG.templates.find((candidate) => candidate.id === "manor_lobby")!;
    for (const room of template.rooms.filter((candidate) => !candidate.retired && candidate.active)) {
      const spaceId = room.id === template.defaultRoomId ? "manor_main_room" : room.id;
      const legacy = manorRoomNavigation(spaceId);
      const navigation = service.navigationForManor("manor-a", spaceId);
      expect({
        roomWidth: navigation.roomWidth, roomHeight: navigation.roomHeight, playerRadius: navigation.playerRadius,
        colliders: navigation.colliders, walkableSurfaces: navigation.walkableSurfaces
      }, room.id).toEqual({
        roomWidth: legacy.roomWidth, roomHeight: legacy.roomHeight, playerRadius: legacy.playerRadius,
        colliders: legacy.colliders, walkableSurfaces: legacy.walkableSurfaces
      });
    }
    // Same blocking and routes on a grid of the lobby.
    const lobby = manorRoomNavigation("manor_main_room");
    const lobbyNavigation = service.navigationForManor("manor-a", "manor_main_room");
    for (let x = 0; x <= 1254; x += 57) for (let y = 0; y <= 1254; y += 61) {
      expect(isIndoorNavigationPointWalkable(lobbyNavigation, { x, y })).toBe(isIndoorNavigationPointWalkable(lobby, { x, y }));
    }
    expect(findIndoorNavigationRoute(lobbyNavigation, MANOR_SPAWN, MANOR_SMITH)).toEqual(findIndoorNavigationRoute(lobby, MANOR_SPAWN, MANOR_SMITH));
  });

  it("authorizes the smith, jewel and door from the lobby objects with the legacy radii", () => {
    const at = (x: number, y: number) => {
      const runtime = new ManorRuntime();
      return { runtime, session: runtime.restore("a", "manor-a", "OWNER", { x, y }, "manor_main_room") };
    };
    const stations = [
      { at: MANOR_DOOR, radius: MANOR_DOOR_INTERACTION_RADIUS, check: (r: ManorRuntime, id: string, _n: number) => { if (!r.isNearDoor("a", id)) throw new ManorError("OUT", "out"); } },
      { at: MANOR_SMITH, radius: MANOR_SMITH_INTERACTION_RADIUS, check: (r: ManorRuntime, id: string, n: number) => { r.authorizeSmith("a", id, n); } },
      { at: MANOR_JEWEL, radius: MANOR_JEWEL_INTERACTION_RADIUS, check: (r: ManorRuntime, id: string, n: number) => { r.authorizeJewel("a", id, n); } }
    ];
    for (const station of stations) {
      const inside = at(station.at.x, station.at.y + station.radius);
      expect(inside.session.position).toMatchObject({ x: station.at.x, y: station.at.y + station.radius });
      expect(() => station.check(inside.runtime, inside.session.sessionId, inside.session.movementSequence)).not.toThrow();
      const outside = at(station.at.x, station.at.y + station.radius + 0.001);
      expect(outside.session.position).toMatchObject({ y: station.at.y + station.radius + 0.001 });
      expect(() => station.check(outside.runtime, outside.session.sessionId, outside.session.movementSequence)).toThrow();
    }
  });

  it("allows navigation through former fixture footprints", () => {
    const runtime = new ManorRuntime();
    const session = runtime.restore(
      "a", "manor-a", "OWNER", MANOR_SPAWN, "manor_main_room"
    );
    const navigation = new ManorDecorationService({} as never)
      .navigationForManor("manor-a", "manor_main_room");
    // The jewel art is flush with the structural right wall, so use a point
    // inside its former fixture rectangle but outside the wall's player
    // clearance. The canonical in-range approach is covered below.
    for (const target of [MANOR_SMITH, {
      x: MANOR_JEWEL.x - 30,
      y: MANOR_JEWEL.y
    }]) {
      expect(isIndoorNavigationPointWalkable(navigation, target)).toBe(true);
      expect(findIndoorNavigationRoute(navigation, MANOR_SPAWN, target)).not.toBeNull();
    }
    expect(runtime.moveTo("a", session.sessionId, MANOR_SMITH.x, MANOR_SMITH.y))
      .toMatchObject({
        position: { targetX: MANOR_SMITH.x, targetY: MANOR_SMITH.y }
      });
  });

  it("allows feet anchors on the authored floor boundary and labels outside-floor targets correctly", () => {
    const runtime = new ManorRuntime();
    const session = runtime.restore(
      "a", "manor-a", "OWNER", MANOR_SPAWN, "manor_main_room"
    );
    const navigation = new ManorDecorationService({} as never)
      .navigationForManor("manor-a", "manor_main_room");
    const floorEdge = { x: MANOR_MAIN_ROOM.roomWidth / 2, y: MANOR_MAIN_ROOM.roomHeight };
    expect(isIndoorNavigationPointWalkable(navigation, floorEdge)).toBe(true);
    expect(findIndoorNavigationRoute(navigation, MANOR_SPAWN, floorEdge)).toEqual([floorEdge]);
    expect(runtime.moveTo("a", session.sessionId, floorEdge.x, floorEdge.y))
      .toMatchObject({ position: { targetX: floorEdge.x, targetY: floorEdge.y } });

    expect(() => runtime.moveTo("a", session.sessionId, 50, 700)).toThrowError(
      expect.objectContaining({
        code: "OUT_OF_BOUNDS",
        message: "That target is outside the manor floor."
      })
    );
  });

  it("does not promote the authored floor anchors or former invisible regions to colliders", () => {
    const navigation = new ManorDecorationService({} as never)
      .navigationForManor("manor-a", "manor_main_room");
    expect(navigation.colliders).toEqual([]);
    const formerColliderArea = { x: 558, y: 485 };
    expect(isIndoorNavigationPointWalkable(navigation, formerColliderArea)).toBe(true);
    expect(isIndoorNavigationSegmentWalkable(
      navigation,
      MANOR_SPAWN,
      formerColliderArea
    )).toBe(true);
  });

  it("settles a portal approach that begins exactly on its threshold", async () => {
    const runtime = new ManorRuntime();
    const session = runtime.restore("a", "manor-a", "OWNER", { x: 500, y: 880 }, "manor_foyer");
    const settled = vi.fn();
    runtime.moveTo("a", session.sessionId, 500, 880);
    runtime.subscribeMovementSettled("a", settled);

    runtime.tick(.05);
    await Promise.resolve();

    expect(settled).toHaveBeenCalledOnce();
  });

  it.each(["OWNER", "PARTY", "TRAVEL_INVITE"] as const)(
    "authorizes %s smithing only for the exact stationary in-range movement fence",
    (accessSource) => {
      const runtime = new ManorRuntime();
      const session = runtime.restore(
        accessSource.toLowerCase(),
        "manor-a",
        accessSource,
        { x: MANOR_SMITH.x, y: MANOR_SMITH.y + MANOR_SMITH_INTERACTION_RADIUS - 1 }
      );
      expect(runtime.authorizeSmith(
        session.playerId,
        session.sessionId,
        session.movementSequence
      )).toMatchObject({
        playerId: session.playerId,
        manorId: "manor-a",
        accessSource
      });
      expect(() => runtime.authorizeSmith(
        session.playerId,
        session.sessionId,
        session.movementSequence + 1
      )).toThrow(/position changed/);

      runtime.moveTo(
        session.playerId,
        session.sessionId,
        MANOR_SMITH.x + 1,
        MANOR_SMITH.y + MANOR_SMITH_INTERACTION_RADIUS - 2
      );
      const moving = runtime.get(session.playerId)!;
      expect(() => runtime.authorizeSmith(
        moving.playerId,
        moving.sessionId,
        moving.movementSequence
      )).toThrow(/Stop moving/);
    }
  );

  it.each([
    ["smith", MANOR_SMITH, MANOR_SMITH_INTERACTION_RADIUS],
    ["jewel", MANOR_JEWEL, MANOR_JEWEL_INTERACTION_RADIUS]
  ] as const)("walks to and authorizes the %s station from the lobby spawn", (kind, target, radius) => {
    const runtime = new ManorRuntime();
    const navigation = new ManorDecorationService({} as never)
      .navigationForManor("manor-a", "manor_main_room");
    runtime.setManorNavigation("manor-a", "manor_main_room", navigation);
    const session = runtime.restore("a", "manor-a", "OWNER", MANOR_SPAWN, "manor_main_room");
    const approach = indoorInteractionApproachPoint(
      MANOR_SPAWN,
      target,
      radius,
      MANOR_INTERACTION_APPROACH_INSET
    );
    expect(isIndoorNavigationPointWalkable(navigation, approach)).toBe(true);
    expect(findIndoorNavigationRoute(navigation, MANOR_SPAWN, approach)).not.toBeNull();

    runtime.moveTo(session.playerId, session.sessionId, approach.x, approach.y);
    for (let index = 0; index < 200 && runtime.get("a")?.position.moving; index += 1) {
      runtime.tick(.05);
    }
    const settled = runtime.get("a")!;
    expect(settled.position).toMatchObject({ x: approach.x, y: approach.y, moving: false });
    if (kind === "smith") {
      expect(runtime.authorizeSmith("a", session.sessionId, settled.movementSequence)).toBeTruthy();
    } else {
      expect(runtime.authorizeJewel("a", session.sessionId, settled.movementSequence)).toBeTruthy();
    }
  });

  it.each(["PARTY", "TRAVEL_INVITE"] as const)(
    "keeps Manor Storage owner-only for a %s guest at the chest",
    (accessSource) => {
      const runtime = new ManorRuntime();
      const guest = runtime.restore(
        "guest",
        "manor-a",
        accessSource,
        { x: MANOR_CHEST.x, y: MANOR_CHEST.y + MANOR_CHEST_INTERACTION_RADIUS - 1 }
      );
      expect(() => runtime.isNearChest("guest", guest.sessionId))
        .toThrow(/Only the manor owner/);
    }
  );

  it("uses only authoritative runtime position for door range", () => {
    const runtime = new ManorRuntime();
    const session = runtime.enter("a", "manor-a");
    // Players arrive just inside the front door; walk to the middle of the lobby first.
    runtime.moveTo("a", session.sessionId, 627, 700);
    for (let i = 0; i < 200 && runtime.get("a")?.position.moving; i += 1) runtime.tick(.05);
    expect(runtime.isNearDoor("a", session.sessionId)).toBe(false);
    runtime.moveTo(
      "a",
      session.sessionId,
      MANOR_DOOR.x - MANOR_DOOR_INTERACTION_RADIUS + 1,
      MANOR_DOOR.y
    );
    for (let i = 0; i < 100; i += 1) runtime.tick(.05);
    expect(runtime.isNearDoor("a", session.sessionId)).toBe(true);
  });

  it("removes only runtime local state on disconnect", async () => {
    const runtime = new ManorRuntime();
    const session = runtime.enter("a", "manor-a");
    await runtime.disconnect("a", session.sessionId);
    expect(runtime.isInside("a")).toBe(false);
    expect(runtime.restore("a", "manor-a").position).toMatchObject(MANOR_SPAWN);
  });

  it("coalesces movement persistence and restores a fresh stationary session", async () => {
    const persisted = new Map<string, { x: number; y: number }>();
    const persist = vi.fn(async (playerId: string, _manorId: string, x: number, y: number) => {
      persisted.set(playerId, { x, y });
    });
    const runtime = new ManorRuntime(persist);
    const first = runtime.enter("a", "manor-a");
    runtime.moveTo("a", first.sessionId, 300, 300);
    for (let index = 0; index < 100; index += 1) runtime.tick(.05);
    await runtime.flush("a", first.sessionId);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persisted.get("a")).toEqual({ x: 300, y: 300 });
    await runtime.disconnect("a", first.sessionId);

    const restored = runtime.restore("a", "manor-a", "OWNER", {
      x: persisted.get("a")!.x,
      y: persisted.get("a")!.y
    });
    expect(restored.sessionId).not.toBe(first.sessionId);
    expect(restored.position).toMatchObject({
      x: 300,
      y: 300,
      targetX: null,
      targetY: null,
      moving: false
    });
  });

  it("flushes the safe current authoritative position before a moving disconnect", async () => {
    const persist = vi.fn(async () => undefined);
    const runtime = new ManorRuntime(persist);
    const session = runtime.enter("a", "manor-a");
    runtime.moveTo("a", session.sessionId, 300, 300);
    runtime.tick(.1);
    const current = runtime.get("a")!.position;
    await runtime.disconnect("a", session.sessionId);
    expect(persist).toHaveBeenLastCalledWith(
      "a",
      "manor-a",
      current.x,
      current.y,
      "manor_main_room"
    );
  });

  it("immediately follows an in-flight movement write with the settled position", async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const persist = vi.fn()
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValue(undefined);
    const runtime = new ManorRuntime(persist);
    const session = runtime.enter("a", "manor-a");
    runtime.moveTo("a", session.sessionId, 400, 400);
    now = 2_001;
    runtime.tick(.1);
    expect(persist).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 100; index += 1) runtime.tick(.05);
    const settled = runtime.get("a")!.position;

    releaseFirst();
    await runtime.flush("a", session.sessionId);

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith(
      "a", "manor-a", settled.x, settled.y, "manor_main_room"
    );
    nowSpy.mockRestore();
  });

  it("does not let an old disconnect remove or overwrite a replacement session", async () => {
    let releaseOldWrite!: () => void;
    const oldWrite = new Promise<void>((resolve) => {
      releaseOldWrite = resolve;
    });
    const persisted = new Map<string, { x: number; y: number }>();
    const persist = vi.fn()
      .mockImplementationOnce(async (playerId: string, _manorId: string, x: number, y: number) => {
        await oldWrite;
        persisted.set(playerId, { x, y });
      })
      .mockImplementation(async (playerId: string, _manorId: string, x: number, y: number) => {
        persisted.set(playerId, { x, y });
      });
    const runtime = new ManorRuntime(persist);
    const sessionA = runtime.enter("a", "manor-a");
    runtime.moveTo("a", sessionA.sessionId, 400, 400);
    runtime.stop("a");
    const disconnectA = runtime.disconnect("a", sessionA.sessionId);

    const sessionB = runtime.restore("a", "manor-a");
    runtime.moveTo("a", sessionB.sessionId, 300, 300);
    for (let index = 0; index < 100; index += 1) runtime.tick(.05);
    const replacementPosition = runtime.get("a")!.position;

    releaseOldWrite();
    await disconnectA;
    await runtime.flush("a", sessionB.sessionId);

    expect(runtime.get("a")).toMatchObject({
      sessionId: sessionB.sessionId,
      position: replacementPosition
    });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persisted.get("a")).toEqual({
      x: replacementPosition.x,
      y: replacementPosition.y
    });
  });

  it("logs a failed position write without removing presence or retrying in a loop", async () => {
    const persist = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const onError = vi.fn();
    const runtime = new ManorRuntime(persist, onError);
    const session = runtime.enter("a", "manor-a");
    runtime.moveTo("a", session.sessionId, 400, 400);
    runtime.stop("a");
    await Promise.resolve();
    await Promise.resolve();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      { playerId: "a", manorId: "manor-a" }
    );
    expect(runtime.isInside("a")).toBe(true);
  });

  it("falls back to a safe spawn for missing or invalid durable coordinates", () => {
    const runtime = new ManorRuntime();
    expect(runtime.restore("legacy", "manor-a", "OWNER", { x: null, y: null }).position)
      .toMatchObject(MANOR_SPAWN);
    runtime.exit("legacy", runtime.get("legacy")!.sessionId);
    expect(runtime.restore("invalid", "manor-a", "OWNER", {
      x: Number.POSITIVE_INFINITY,
      y: -50
    }).position).toMatchObject(MANOR_SPAWN);
  });

  it("restores separate occupants at their own durable positions", () => {
    const runtime = new ManorRuntime();
    const owner = runtime.restore("owner", "manor-a", "OWNER", { x: 300, y: 310 });
    const guest = runtime.restore("guest", "manor-a", "PARTY", { x: 600, y: 610 });
    expect(owner.position).toMatchObject({ x: 300, y: 310 });
    expect(guest.position).toMatchObject({ x: 600, y: 610 });
  });

  it("tracks multiple authoritative occupants and keeps their guest spawns distinct", () => {
    const runtime = new ManorRuntime();
    const owner = runtime.enter("owner", "manor-a", "OWNER");
    const partyGuest = runtime.enter("party", "manor-a", "PARTY");
    const invitedGuest = runtime.enter("invited", "manor-a", "TRAVEL_INVITE");
    expect(runtime.playerIdsInManor("manor-a")).toEqual(["invited", "owner", "party"]);
    expect(partyGuest.accessSource).toBe("PARTY");
    expect(invitedGuest.accessSource).toBe("TRAVEL_INVITE");
    expect(new Set([owner.position.x + ":" + owner.position.y, partyGuest.position.x + ":" + partyGuest.position.y,
      invitedGuest.position.x + ":" + invitedGuest.position.y]).size).toBe(3);
  });
});

describe("remote manor storage authority", () => {
  it("resolves the built manor only from the authenticated owner id", async () => {
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes("SELECT id FROM player_manors")) {
        expect(values).toEqual(["owner"]);
        return { rows: [{ id: "manor-owned" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const equipment = {
      snapshotInTransaction: vi.fn(async () => ({ playerId: "owner", instances: [] }))
    };
    const backpacks = {
      snapshotInTransaction: vi.fn(async () => ({
        playerId: "owner", equippedBackpack: null, instances: []
      }))
    };
    const client = { query, release: vi.fn() };
    const service = new ManorStorageService(
      { query, connect: vi.fn(async () => client) } as never,
      undefined,
      undefined,
      equipment as never,
      backpacks as never
    );
    const snapshot = await service.snapshotForOwner("owner");
    expect(snapshot.manorId).toBe("manor-owned");
    expect(equipment.snapshotInTransaction).toHaveBeenCalledWith(client, "owner");
    expect(backpacks.snapshotInTransaction).toHaveBeenCalledWith(client, "owner");
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns no storage when the authenticated player has no built manor", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const client = { query, release: vi.fn() };
    const service = new ManorStorageService({ query, connect: async () => client } as never);
    await expect(service.snapshotForOwner("guest")).rejects.toMatchObject({
      code: "MANOR_NOT_BUILT"
    });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe("manor guest entry authority", () => {
  const manor = {
    manorId: "manor-a",
    ownerPlayerId: "owner",
    ownerUsername: "Owner",
    regionCode: "test",
    lat: 35,
    lon: -106,
    builtAt: "2026-07-24T00:00:00.000Z",
    placementRevision: 1
  };

  it("requires the owner inside for invited or party guests", () => {
    const runtime = new ManorRuntime();
    const authorization = { manor, accessSource: "PARTY" as const, travelInviteId: null };
    expect(() => requireManorOwnerPresentForGuest(runtime, authorization))
      .toThrowError(expect.objectContaining({ code: "MANOR_OWNER_ABSENT" }));
    runtime.enter("owner", manor.manorId, "OWNER");
    expect(() => requireManorOwnerPresentForGuest(runtime, authorization)).not.toThrow();
  });
});

describe("manor world intent fence", () => {
  it.each([
    "MOVE_TO", "PLACE_FLAG", "BUILD_MANOR", "DESTROY_MANOR",
    "START_ATTACK", "VISIT_CITY", "VISIT_CITY_HOUSE", "VISIT_WORLD_MAP_ATLAS_SHRINE", "MARKET_OPEN"
  ])("blocks %s", (type) => {
    expect(isWorldOnlyWhileInManor(type)).toBe(true);
  });
  it.each(["PING", "CHAT_SEND", "TRANSFER_MANOR_STACK", "MANOR_MOVE_TO", "DROP_ITEM", "DROP_EQUIPMENT"])("allows %s", (type) => {
    expect(isWorldOnlyWhileInManor(type)).toBe(false);
  });
});

describe("manor aggression travel lock", () => {
  it("lasts exactly ten seconds and restarts from every newer hit", () => {
    const now = 20_000;
    expect(isAggressionTravelLocked(10_001, false, now)).toBe(true);
    expect(isAggressionTravelLocked(10_000, false, now)).toBe(false);
    expect(isAggressionTravelLocked(19_500, false, now)).toBe(true);
    expect(isAggressionTravelLocked(null, true, now)).toBe(true);
    expect(isAggressionTravelLocked(null, false, now)).toBe(false);
  });
});

describe("manor world presence", () => {
  it("removes the player from snapshots, rejects world movement, and never writes local coordinates into geography", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    const player = state.helloPlayer("a", "Ash");
    const before = { ...player.position };
    state.setWorldPresence("a", false);
    expect(state.snapshots()).toEqual([]);
    expect(() => state.setTarget("a", { lat: before.lat + .001, lon: before.lon }))
      .toThrow(/interior location/u);
    const runtime = new ManorRuntime();
    const session = runtime.enter("a", "m");
    runtime.moveTo("a", session.sessionId, 300, 300);
    runtime.tick(1);
    expect(state.getPlayer("a")?.position).toEqual(before);
    state.restoreWorldPosition("a", before, player.regionCode);
    state.setWorldPresence("a", true);
    expect(state.snapshots()).toHaveLength(1);
  });

  it("relocates to a safe arrival while retaining the manor entrance as the movement anchor", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    const before = state.helloPlayer("anchor-owner", "Ash");
    state.setTarget("anchor-owner", { lat: before.position.lat + .0001, lon: before.position.lon });
    const previousMovementRevision = state.getPlayer("anchor-owner")!.movementRevision;
    const previousRelocationRevision = state.getPlayer("anchor-owner")!.relocationRevision!;
    const entrance = { lat: 35, lon: -106 };
    const arrival = { lat: 35.00005, lon: -106.00005 };
    const relocated = state.relocateToAnchor("anchor-owner", entrance, arrival);
    expect(relocated.position).toEqual(arrival);
    expect(relocated.anchor).toEqual(entrance);
    expect(relocated.target).toBeNull();
    expect(relocated.movementRevision).toBe(previousMovementRevision + 1);
    expect(relocated.relocationRevision).toBe(previousRelocationRevision + 1);
  });
});

describe("manor ejection world authority", () => {
  it("replaces the pre-manor movement anchor and resource vision", async () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    const player = state.helloPlayer("wren", "Wren");
    const previousAnchor = { ...player.anchor };
    const previousVision = {
      flagId: "flag-before-manor",
      flagName: "Before Manor",
      center: previousAnchor,
      movementLeashRadiusM: player.moveLeashRadiusM,
      paddingM: 50,
      radiusM: 650
    };
    state.setResourceVision(player.playerId, previousVision);
    state.setWorldPresence(player.playerId, false);

    const arrival = { lat: previousAnchor.lat + 0.02, lon: previousAnchor.lon };
    const runtime = new ManorRuntime();
    runtime.enter(player.playerId, "manor-a");
    const registry = new ConnectionRegistry();
    registry.add({
      accountId: "account-wren",
      playerId: player.playerId,
      username: player.username,
      regionCode: player.regionCode,
      zoneId: "world:test",
      socket: { readyState: 1, send: vi.fn(), close: vi.fn() }
    });
    const connectionGenerations = new ConnectionGenerationLedger();
    connectionGenerations.allocate(player.playerId);
    const transition = Symbol("manor-ejection");
    const worldRuntime = {
      beginPlayerWorldTransition: vi.fn(() => transition),
      endPlayerWorldTransition: vi.fn(() => true),
      replication: { resetPlayer: vi.fn() },
      sendManorOccupants: vi.fn()
    };
    const presence = {
      playerId: player.playerId,
      manorId: "manor-a",
      ownerPlayerId: player.playerId,
      accessSource: "OWNER" as const,
      admissionTravelInviteId: null,
      returnRegionCode: "world:test",
      returnLat: arrival.lat,
      returnLon: arrival.lon,
      localPositionX: null,
      localPositionY: null
    };
    const manorPresence = {
      builtManor: vi.fn(async () => null),
      listBuiltNear: vi.fn(async () => []),
      managementSnapshot: vi.fn(async () => ({
        manorId: presence.manorId,
        guests: [],
        bannedPlayers: []
      }))
    };
    const operations = createManorRealtimeOperations({
      logger: { warn: vi.fn() } as never,
      registry,
      gameState: state,
      worldRuntime: worldRuntime as never,
      classRealtimeState: {} as never,
      flagBuilds: null,
      manorPresence: manorPresence as never,
      manorRuntime: runtime,
      manorRealtimeState: {} as never,
      partyRealtimeState: {} as never,
      playerAuthorityFence: {} as never,
      connectionGenerations,
      activeHarvestSessionForPlayer: vi.fn(async () => null),
      cancelPendingManorEntry: vi.fn(),
      sendTravelInboxForPlayers: vi.fn(async () => undefined),
      refreshAuthoritativePlayerStats: vi.fn(async () => {
        throw new Error("not used");
      }),
      reserveTravelArrivals: vi.fn(() => null) as never,
      reservePopulationV2CurrentArea: vi.fn(() => null),
      sendCityScopeForPlayer: vi.fn(async () => undefined) as never,
      sendCollectiblesForPlayer: vi.fn(async () => undefined),
      schedulePopulationV2RelocationForActivePlayer: vi.fn(() => null)
    });

    await operations.forceManorEjection(presence, "The manor was unavailable.");

    const restored = state.getPlayer(player.playerId)!;
    expect(restored.position).toEqual(arrival);
    expect(restored.anchor).toEqual(arrival);
    expect(state.getResourceVision(player.playerId)).toBeNull();
    const target = pointEastMeters(arrival, 100);
    expect(distanceMeters(previousAnchor, target)).toBeGreaterThan(restored.moveLeashRadiusM);
    expect(() => state.setTarget(player.playerId, target)).not.toThrow();
    expect(runtime.isInside(player.playerId)).toBe(false);
  });
});

function pointEastMeters(point: { lat: number; lon: number }, meters: number): { lat: number; lon: number } {
  return { lat: point.lat, lon: point.lon + meters / (111_320 * Math.cos(point.lat * Math.PI / 180)) };
}
