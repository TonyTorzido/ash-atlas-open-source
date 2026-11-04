import {
  CISTERN_WARRENS_DUNGEON,
  DUNGEON_CATALOG,
  dungeonSceneRevision,
  type ClientMessage,
  type DungeonSnapshot,
  type DungeonSnapshotUpdate
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import type { ClientCommandPort } from "../clientCommandPort.js";
import { DungeonClient } from "./dungeonClient.js";

describe("DungeonClient", () => {
  it("owns Dungeon query and movement payloads", () => {
    const messages: ClientMessage[] = [];
    const port: ClientCommandPort = {
      send: vi.fn((message) => {
        messages.push(message);
        return { status: "sent", readiness: "ready", connectionGeneration: 1 } as const;
      })
    };
    const client = new DungeonClient(port);

    expect(client.requestEntrances()).not.toBeNull();
    expect(client.moveTo("sewer-1", 8, 9)).not.toBeNull();
    expect(client.interact("sewer-1", "lever-1")).not.toBeNull();

    expect(messages.map((message) => message.type)).toEqual([
      "REQUEST_DUNGEON_ENTRANCES",
      "DUNGEON_MOVE_TO",
      "DUNGEON_INTERACT"
    ]);
  });

  it("materializes lightweight updates from the matching full scene", () => {
    const client = dungeonClient();
    const full = snapshot(0);
    expect(client.materializeSnapshot(full)).toBe(full);
    const update = snapshotUpdate(full, { status: "Updated", serverTime: 2 });
    const materialized = client.materializeSnapshot(update);
    expect(materialized).toMatchObject({
      snapshotKind: "full", status: "Updated", serverTime: 2,
      room: full.room, prefabs: full.prefabs
    });
  });

  it("drops lightweight updates without a scene or with mismatched identity", () => {
    const client = dungeonClient();
    const full = snapshot(0);
    const update = snapshotUpdate(full);
    expect(client.materializeSnapshot(update)).toBeNull();
    client.materializeSnapshot(full);
    for (const mismatch of [
      { sceneRevision: "wrong-scene" },
      { catalogRevision: full.catalogRevision + 1 },
      { dungeonRevision: "wrong-dungeon-revision" },
      { spaceId: CISTERN_WARRENS_DUNGEON.rooms[1]!.id }
    ]) {
      expect(client.materializeSnapshot({ ...update, ...mismatch })).toBeNull();
    }
    expect(client.materializeSnapshot(update)?.room).toBe(full.room);
  });

  it("replaces cached scene on room transfer", () => {
    const client = dungeonClient();
    const entrance = snapshot(0);
    const depths = snapshot(1);
    client.materializeSnapshot(entrance);
    expect(client.materializeSnapshot(depths)).toBe(depths);
    expect(client.materializeSnapshot(snapshotUpdate(entrance))).toBeNull();
    expect(client.materializeSnapshot(snapshotUpdate(depths))?.room).toBe(depths.room);
  });

  it("drops same-scene updates from another session or instance without poisoning cache", () => {
    const client = dungeonClient();
    const full = snapshot(0);
    const update = snapshotUpdate(full, { status: "Current session" });
    client.materializeSnapshot(full);
    expect(client.materializeSnapshot({
      ...update, sessionId: "stale-session", instanceId: "stale-instance"
    })).toBeNull();
    expect(client.materializeSnapshot(update)?.status).toBe("Current session");
  });

  it("clears cached scene on dungeon exit or session reset", () => {
    const client = dungeonClient();
    const full = snapshot(0);
    client.materializeSnapshot(full);
    client.clearScene();
    expect(client.materializeSnapshot(snapshotUpdate(full))).toBeNull();
  });
});

function dungeonClient(): DungeonClient {
  return new DungeonClient({
    send: vi.fn(() => ({
      status: "sent", readiness: "ready", connectionGeneration: 1
    } as const))
  });
}

function snapshot(roomIndex: number): DungeonSnapshot {
  const room = CISTERN_WARRENS_DUNGEON.rooms[roomIndex]!;
  const catalogRevision = DUNGEON_CATALOG.catalogRevision;
  return {
    snapshotKind: "full", catalogRevision,
    sceneRevision: dungeonSceneRevision(catalogRevision, CISTERN_WARRENS_DUNGEON.revision, room.id),
    dungeonId: CISTERN_WARRENS_DUNGEON.id, dungeonRevision: CISTERN_WARRENS_DUNGEON.revision,
    entranceId: "sewer-entrance", name: "Cistern Warrens",
    description: "Municipal drainage tunnels.", instancePolicy: "shared_persistent",
    portalId: "sewer:sewer-1:world-to-entrance", presentation: "hatch", assetKey: null,
    sewerId: "sewer-1", cityId: "city-1", cityName: "City", sessionId: "session-1",
    instanceId: "instance-1", spaceId: room.id, roomWidth: room.width,
    roomHeight: room.height, playerVisualHeight: 52.5,
    camera: room.camera, environment: { ...CISTERN_WARRENS_DUNGEON.environment, ...room.environment },
    player: { playerId: "player-1", name: "Player", displayColor: null, x: 100, y: 100,
      targetX: null, targetY: null, targetEntityId: null, movementSpeed: 195,
      movementRevision: 1, currentHealth: 100, maxHealth: 100 },
    occupants: [], room, prefabs: [...DUNGEON_CATALOG.prefabs], enemies: [], objects: [],
    telegraphs: [], encounters: [], triggers: [], dungeonFlags: {}, portalLocks: {},
    completed: false, cues: [], resetDeadline: null, status: "Active", serverTime: 1
  };
}

function snapshotUpdate(
  full: DungeonSnapshot,
  overrides: Partial<DungeonSnapshotUpdate> = {}
): DungeonSnapshotUpdate {
  const update = structuredClone(full) as Partial<typeof full>;
  delete update.room;
  delete update.prefabs;
  return { ...update, snapshotKind: "update", ...overrides } as DungeonSnapshotUpdate;
}
