import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DUNGEON_CATALOG } from "../dungeonCatalog.js";
import { dungeonSceneRevision } from "../dungeon.js";
import { emptyInventoryTotals } from "../collectibles.js";
import { dungeonServerMessageSchemas } from "./dungeonServerSchemas.js";

describe("dungeon server schemas", () => {
  it("validates authoritative dungeon reward results", () => {
    const parsed = dungeonServerMessageSchemas.DUNGEON_REWARD_GRANTED.parse({
      type: "DUNGEON_REWARD_GRANTED",
      requestId: "open-chest",
      runId: "00000000-0000-4000-8000-000000000001",
      rewardSourceId: "chest-trigger",
      rewardTableId: "basic_dungeon_chest",
      applied: true,
      inventory: { playerId: "player-1", revision: 1, items: [], totals: emptyInventoryTotals() },
      wallet: { playerId: "player-1", gold: "25", revision: "1" },
      items: [{ itemId: "wood", quantity: 3 }],
      gold: 25,
      message: "Dungeon reward granted."
    });
    expect(parsed.applied).toBe(true);
    expect(parsed.items).toEqual([{ itemId: "wood", quantity: 3 }]);
    expect(parsed.gold).toBe(25);
  });

  it("preserves canonical player appearance in interior snapshots", () => {
    const appearance = {
      schemaVersion: 1 as const,
      catalogRevision: 7,
      revision: 12,
      bodyVariantId: "body-1",
      poseId: "idle",
      slots: {},
      styles: { hair: "hair-2", eyes: "eyes-2" },
      activeHand: null
    };
    const player = {
      playerId: "player-1",
      name: "Ash",
      displayColor: null,
      appearance,
      x: 20,
      y: 24,
      targetX: null,
      targetY: null,
      targetEntityId: null,
      movementSpeed: 10,
      movementRevision: 3,
      currentHealth: 100,
      maxHealth: 100
    };

    const parsed = dungeonServerMessageSchemas.DUNGEON_SNAPSHOT.parse({
      type: "DUNGEON_SNAPSHOT",
      snapshot: {
        snapshotKind: "full",
        catalogRevision: DUNGEON_CATALOG.catalogRevision,
        sceneRevision: dungeonSceneRevision(
          DUNGEON_CATALOG.catalogRevision,
          "cistern-warrens-v1",
          "sewer_entrance"
        ),
        dungeonId: "cistern_warrens",
        dungeonRevision: "cistern-warrens-v1",
        instancePolicy: "shared_persistent",
        sewerId: "sewer-1",
        cityId: "city-1",
        cityName: "Mexico City",
        sessionId: "session-1",
        instanceId: "sewer:sewer-1",
        spaceId: "sewer_entrance",
        roomWidth: 1_000,
        roomHeight: 1_000,
        playerVisualHeight: 52.5,
        camera: {
          mode: "fixed_center", center: { x: 500, y: 500 }, fitPadding: 0,
          defaultZoom: 1, minZoom: 0.5, maxZoom: 1.6
        },
        environment: {
          environmentId: "cistern_warrens_entrance", backgroundColor: "#071116",
          floorColor: "#182a2d", wallColor: "#405052", accentColor: "#8fbc8f",
          visualTreatmentId: null, musicAssetKey: null, ambienceAssetKey: null
        },
        player,
        occupants: [player],
        room: DUNGEON_CATALOG.dungeons[0]!.rooms[0]!,
        prefabs: DUNGEON_CATALOG.prefabs,
        enemies: [],
        objects: [],
        telegraphs: [],
        encounters: [],
        triggers: [],
        dungeonFlags: {},
        portalLocks: {},
        completed: false,
        cues: [],
        resetDeadline: null,
        status: "The entrance is quiet.",
        serverTime: 1
      }
    });

    expect(parsed.snapshot.player.appearance).toEqual(appearance);
    expect(parsed.snapshot.instancePolicy).toBe("shared_persistent");
    expect(parsed.snapshot.occupants[0]?.appearance).toEqual(appearance);
    expect(() => dungeonServerMessageSchemas.DUNGEON_SNAPSHOT.parse({
      ...parsed,
      snapshot: { ...parsed.snapshot, enemies: [{}] }
    })).toThrow();

    const eliteEnemy = {
      entityId: "mob:1", spawnId: "s1", encounterId: "e1", archetype: "wolf", name: "Wolf",
      x: 10, y: 10, currentHealth: 5, maxHealth: 10, lifeState: "alive", targetEntityId: null,
      visualScale: 1, elite: { modifiers: ["shielded", "hardy"], shieldActive: true }
    };
    const withElite = dungeonServerMessageSchemas.DUNGEON_SNAPSHOT.parse({
      ...parsed, snapshot: { ...parsed.snapshot, enemies: [eliteEnemy] }
    });
    expect(withElite.snapshot.enemies[0]?.elite).toEqual({ modifiers: ["shielded", "hardy"], shieldActive: true });
    expect(() => dungeonServerMessageSchemas.DUNGEON_SNAPSHOT.parse({
      ...parsed, snapshot: { ...parsed.snapshot, enemies: [{ ...eliteEnemy, elite: { modifiers: "hardy" } }] }
    })).toThrow();

    const dynamic = structuredClone(parsed.snapshot) as Partial<typeof parsed.snapshot>;
    delete dynamic.room;
    delete dynamic.prefabs;
    delete dynamic.snapshotKind;
    const update = dungeonServerMessageSchemas.DUNGEON_SNAPSHOT.parse({
      type: "DUNGEON_SNAPSHOT",
      snapshot: { ...dynamic, snapshotKind: "update" }
    });
    expect(update.snapshot).not.toHaveProperty("room");
    expect(update.snapshot).not.toHaveProperty("prefabs");
    expect(() => dungeonServerMessageSchemas.DUNGEON_SNAPSHOT.parse({
      type: "DUNGEON_SNAPSHOT",
      snapshot: { ...dynamic, snapshotKind: "update", sceneRevision: "stale-scene" }
    })).toThrow(/immutable dungeon scene identity/);
    expect(() => dungeonServerMessageSchemas.DUNGEON_ENTERED.parse({
      type: "DUNGEON_ENTERED", requestId: "entry", snapshot: { ...dynamic, snapshotKind: "update" }
    })).toThrow();
    expect(() => dungeonServerMessageSchemas.DUNGEON_SNAPSHOT.parse({
      ...parsed,
      snapshot: { ...parsed.snapshot, telegraphs: [{}] }
    })).toThrow();
    const cast = {
      encounterId: "instance:run:boss",
      bossId: "test-boss",
      abilityId: "cone-cleave",
      castInstanceId: "cast-1",
      startTime: 100,
      resolveTime: 500,
      origin: { lat: 35, lon: -106 },
      geometry: {
        kind: "cone" as const,
        origin: { lat: 35, lon: -106 },
        facingDegrees: 0,
        rangeM: 10,
        angleDegrees: 90
      },
      lifeGeneration: 1
    };
    expect(dungeonServerMessageSchemas.DUNGEON_SNAPSHOT.parse({
      ...parsed,
      snapshot: { ...parsed.snapshot, telegraphs: [cast] }
    }).snapshot.telegraphs).toHaveLength(1);
    expect(() => dungeonServerMessageSchemas.DUNGEON_SNAPSHOT.parse({
      ...parsed,
      snapshot: {
        ...parsed.snapshot,
        telegraphs: [{ ...cast, origin: { lat: 91, lon: -106 } }]
      }
    })).toThrow();
    expect(() => dungeonServerMessageSchemas.DUNGEON_SNAPSHOT.parse({
      ...parsed,
      snapshot: { ...parsed.snapshot, telegraphs: [{ ...cast, resolveTime: 99 }] }
    })).toThrow();
  });

  it("accepts a resumed personal-instance boss room whose runtime ids exceed 160 characters", () => {
    // Captured from a developer-spawned Ashen Crypt: dungeon:<entrance>:player:<player>:<run>:<boss>
    // encounter ids are ~180 characters. A 160-character cap rejected the frame, so the client never
    // received DUNGEON_ENTERED and looped in startup.
    const raw = readFileSync(
      fileURLToPath(new URL("./dungeonEnteredPersonalInstanceBoss.fixture.json", import.meta.url)),
      "utf8"
    );
    const frame = JSON.parse(raw) as { snapshot: { enemies: { bossEncounter: { encounterId: string } }[] } };
    expect(frame.snapshot.enemies[0]!.bossEncounter.encounterId.length).toBeGreaterThan(160);
    expect(dungeonServerMessageSchemas.DUNGEON_ENTERED.parse(frame).type).toBe("DUNGEON_ENTERED");
  });
});
