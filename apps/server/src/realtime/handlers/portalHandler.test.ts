import type {
  PlayerLocationSnapshot,
  PortalDefinition,
  ServerMessage
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { DungeonError, type CisternWarrensRuntime } from "../../game/dungeon.js";
import { DungeonRepeatError } from "../../game/dungeonRepeatLedger.js";
import type { ManorRuntime } from "../../game/manor.js";
import type { PlayerLocationService } from "../../game/locations/playerLocationService.js";
import { PortalRegistry } from "../../game/locations/portalRegistry.js";
import type { SalonRuntime } from "../../game/salon.js";
import type { GameState } from "../../game/state.js";
import type { WorldRuntime } from "../../game/worldRuntime.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import { createPortalHandler } from "./portalHandler.js";

type Family = "manor" | "salon" | "cistern_warrens" | "dungeon";
type Direction = "entry" | "exit" | "room";

const families: readonly Family[] = ["manor", "salon", "cistern_warrens"];

describe("portalHandler route composition", () => {
  for (const family of families) {
    for (const direction of ["entry", "exit"] as const) {
      it(`${direction === "entry" ? "enters" : "exits"} ${family} through one durable and generic path`, async () => {
        const harness = createHarness(family, direction);
        await harness.handler({
          type: "USE_PORTAL",
          requestId: "request-1",
          portalId: harness.definition.portalId,
          expectedPortalRevision: harness.definition.revision,
          expectedLocationRevision: harness.source.revision
        });
        const plan = harness.sent.find(
          (message) => message.type === "PORTAL_TRANSITION_PLANNED"
        );
        if (!plan || plan.type !== "PORTAL_TRANSITION_PLANNED") {
          throw new Error("missing transition plan");
        }
        await harness.handler({
          type: "PORTAL_DESTINATION_READY",
          transitionId: plan.transitionId,
          sceneKey: plan.preloadSceneKey
        });
        harness.reachThreshold();

        await vi.waitFor(() => expect(harness.sent.at(-1)).toMatchObject({
          type: "PLAYER_LOCATION_SNAPSHOT",
          location: { revision: harness.source.revision + 1 }
        }));
        expect(harness.commitLocation).toHaveBeenCalledOnce();
        expect(harness.applyEffects).toHaveBeenCalledOnce();
        expect(harness.releaseEffects).toHaveBeenCalledOnce();
        expect(harness.commitLocation).toHaveBeenCalledWith(expect.objectContaining({
          destination: expect.objectContaining({
            position: harness.definition.destinationArrival
          })
        }));
        expect(harness.project).toHaveBeenCalledOnce();
        if (family === "manor" && direction === "entry") {
          expect(harness.authorizeManorEntry).toHaveBeenCalledOnce();
        }
        if (family === "cistern_warrens") {
          expect(harness.sent).toContainEqual(expect.objectContaining({
            type: direction === "entry" ? "DUNGEON_ENTERED" : "DUNGEON_EXITED",
            requestId: "request-1"
          }));
          if (direction === "entry") {
            expect(harness.dungeonEnter).toHaveBeenCalledWith(
              expect.objectContaining({ playerId: "player-1" }),
              "cistern_warrens-1",
              expect.objectContaining({
                spaceId: "sewer_entrance",
                position: { x: 30, y: 32 }
              })
            );
            expect(harness.sent).toContainEqual(expect.objectContaining({
              type: "DUNGEON_ENTERED",
              snapshot: expect.objectContaining({
                spaceId: "sewer_entrance",
                player: expect.objectContaining({ x: 30, y: 32 })
              })
            }));
          }
        }
      });
    }
  }

  it("fails a locked Cistern Warrens entry in destination authorization before approach or commit", async () => {
    const harness = createHarness("cistern_warrens", "entry");
    harness.dungeonAuthorizeEntry.mockRejectedValueOnce(new DungeonRepeatError(
      "DUNGEON_REPEAT_COOLDOWN_ACTIVE",
      "You can repeat this dungeon after 2026-09-04T00:00:00.000Z."
    ));

    await harness.handler({
      type: "USE_PORTAL",
      requestId: "request-locked",
      portalId: harness.definition.portalId,
      expectedPortalRevision: harness.definition.revision,
      expectedLocationRevision: harness.source.revision
    });

    expect(harness.dungeonAuthorizeEntry).toHaveBeenCalledWith("player-1", "cistern_warrens-1");
    expect(harness.worldSetTarget).not.toHaveBeenCalled();
    expect(harness.commitLocation).not.toHaveBeenCalled();
    expect(harness.sent.at(-1)).toMatchObject({
      type: "PORTAL_TRANSITION_FAILED",
      requestId: "request-locked",
      code: "DUNGEON_REPEAT_COOLDOWN_ACTIVE",
      message: "You can repeat this dungeon after 2026-09-04T00:00:00.000Z."
    });
  });

  it("denies a level-gated or unaffordable dungeon entry with the access message before commit", async () => {
    const harness = createHarness("cistern_warrens", "entry");
    harness.dungeonAuthorizeEntry.mockRejectedValueOnce(new DungeonError(
      "DUNGEON_LEVEL_TOO_LOW",
      "Fangrock Cavern requires level 5. You are level 3."
    ));

    await harness.handler({
      type: "USE_PORTAL",
      requestId: "request-level",
      portalId: harness.definition.portalId,
      expectedPortalRevision: harness.definition.revision,
      expectedLocationRevision: harness.source.revision
    });

    expect(harness.commitLocation).not.toHaveBeenCalled();
    expect(harness.sent.at(-1)).toMatchObject({
      type: "PORTAL_TRANSITION_FAILED",
      requestId: "request-level",
      code: "DUNGEON_LEVEL_TOO_LOW",
      message: "Fangrock Cavern requires level 5. You are level 3."
    });
  });

  it("does not apply the repeat gate to same-instance Sewer room travel", async () => {
    const harness = createHarness("cistern_warrens", "room");
    await harness.handler({
      type: "USE_PORTAL",
      requestId: "request-room",
      portalId: harness.definition.portalId,
      expectedPortalRevision: harness.definition.revision,
      expectedLocationRevision: harness.source.revision
    });
    expect(harness.dungeonAuthorizeEntry).not.toHaveBeenCalled();
    const plan = harness.sent.find((message) => message.type === "PORTAL_TRANSITION_PLANNED");
    if (!plan || plan.type !== "PORTAL_TRANSITION_PLANNED") throw new Error("missing room plan");
    await harness.handler({
      type: "CANCEL_PORTAL_TRANSITION", requestId: "cancel-room", transitionId: plan.transitionId
    });
  });

  it.each(["cistern_warrens", "dungeon"] as const)(
    "recovers from locked %s depths through the canonical death anchor while rejecting ordinary and forged exits",
    async (family) => {
      const harness = createHarness(family, "exit", "sewer_depths");
      vi.mocked(harness.dungeon.authorizePortal).mockImplementation((_playerId, portalId) => {
        throw new DungeonError(portalId === harness.definition.portalId ? "PORTAL_LOCKED" : "PORTAL_UNAVAILABLE",
          "That dungeon portal is unavailable.");
      });
      await harness.handler({ type: "USE_PORTAL", requestId: "locked-door",
        portalId: harness.definition.portalId, expectedLocationRevision: harness.source.revision });
      expect(harness.sent.at(-1)).toMatchObject({ type: "PORTAL_TRANSITION_FAILED", code: "PORTAL_LOCKED" });
      expect(harness.commitLocation).not.toHaveBeenCalled();
      vi.mocked(harness.dungeon.authorizePortal).mockClear();

      await harness.handler({ type: "USE_PORTAL", requestId: "forged-recovery",
        portalId: "recovery:death-anchor", expectedLocationRevision: harness.source.revision });
      expect(harness.sent.at(-1)).toMatchObject({ type: "PORTAL_TRANSITION_FAILED",
        message: "That portal is no longer available." });
      expect(harness.dungeon.authorizePortal).not.toHaveBeenCalled();
      expect(harness.commitLocation).not.toHaveBeenCalled();

      const recovered = await harness.handler.recoverToWorldAnchor("player-1", "player-death:locked-depths");
      expect(recovered).toMatchObject({ kind: "world", regionCode: "world_v1_lat36_lon-108",
        position: { lat: 36.2, lon: -107.4 }, revision: harness.source.revision + 1 });
      expect(harness.commitLocation).toHaveBeenCalledOnce();
      expect(harness.applyEffects).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(harness.releaseEffects).toHaveBeenCalledOnce());
      expect(harness.dungeon.authorizePortal).not.toHaveBeenCalled();
      expect(harness.dungeon.leave).toHaveBeenCalledWith("player-1", "sewer-session", "recovery:death-anchor");
      expect(harness.dungeon.get("player-1")).toBeNull();
      expect(harness.sent.at(-1)).toMatchObject({ type: "PLAYER_LOCATION_SNAPSHOT", location: recovered });
    }
  );

  it("recovers through the canonical path when the dungeon session is already missing", async () => {
    const harness = createHarness("cistern_warrens", "exit");
    vi.mocked(harness.dungeon.get).mockReturnValue(null);
    const recovered = await harness.handler.recoverToWorldAnchor("player-1", "player-death:missing-session");
    expect(recovered).toMatchObject({ kind: "world", position: { lat: 36.2, lon: -107.4 } });
    expect(harness.commitLocation).toHaveBeenCalledOnce();
    expect(harness.dungeon.leave).toHaveBeenCalledWith("player-1", undefined, "recovery:death-anchor");
    expect(harness.sent.at(-1)).toMatchObject({ type: "PLAYER_LOCATION_SNAPSHOT", location: recovered });
  });

  it("retries Manor recovery after the exit projection has removed its session", async () => {
    const harness = createHarness("manor", "exit");
    vi.mocked(harness.project).mockImplementationOnce(async () => {
      harness.dropManorSession();
      throw new Error("temporary Manor projection failure");
    });

    const recovery = {
      playerId: "player-1",
      requestId: "player-death:manor-projection-retry"
    } as const;
    await expect(harness.handler.recoverToWorldAnchor(recovery.playerId, recovery.requestId))
      .rejects.toThrow("temporary Manor projection failure");
    await expect(harness.handler.recoverToWorldAnchor(recovery.playerId, recovery.requestId))
      .resolves.toMatchObject({ kind: "world", position: { lat: 36.2, lon: -107.4 } });
    expect(harness.commitLocation).toHaveBeenCalledTimes(2);
    expect(harness.durableLocationCommitCount()).toBe(1);
    expect(harness.project).toHaveBeenCalledTimes(2);
  });

  it("replays one canonical recovery after an exit projection fails post-deletion", async () => {
    const harness = createHarness("cistern_warrens", "exit");
    vi.mocked(harness.dungeon.leave)
      .mockImplementationOnce(async () => {
        harness.dropDungeonSession();
        throw new Error("instance reset unavailable");
      })
      .mockResolvedValueOnce(null);

    await expect(harness.handler.recoverToWorldAnchor("player-1", "player-death:projection-retry"))
      .rejects.toThrow("instance reset unavailable");
    expect(harness.commitLocation).toHaveBeenCalledOnce();
    expect(harness.applyEffects).toHaveBeenCalledOnce();

    const recovered = await harness.handler.recoverToWorldAnchor("player-1", "player-death:projection-retry");
    expect(recovered).toMatchObject({ kind: "world", position: { lat: 36.2, lon: -107.4 } });
    expect(harness.commitLocation).toHaveBeenCalledTimes(2);
    expect(harness.durableLocationCommitCount()).toBe(1);
    expect(harness.dungeon.leave).toHaveBeenCalledTimes(2);
    expect(harness.sent.at(-1)).toMatchObject({ type: "PLAYER_LOCATION_SNAPSHOT", location: recovered });
  });

  it("derives forced recovery region from the exact anchor rather than the current region", async () => {
    const harness = createHarness("cistern_warrens", "exit");
    await harness.handler.recoverToWorldAnchor("player-1", "player-death:anchor-region");

    expect(harness.commitLocation).toHaveBeenCalledWith(expect.objectContaining({
      destination: {
        kind: "world",
        regionCode: "world_v1_lat36_lon-108",
        position: { lat: 36.2, lon: -107.4 }
      }
    }));
  });
});

function createHarness(family: Family, direction: Direction, sourceSpace?: string) {
  const id = `${family}-1`;
  const instanceId = family === "cistern_warrens" ? `sewer:${id}` : `${family}:${id}`;
  const spaceId = sourceSpace ?? (family === "manor"
    ? "manor_main_room"
    : family === "salon" ? "salon_main_room" : "sewer_entrance");
  const interior: Extract<PlayerLocationSnapshot, { kind: "interior" }> = {
    kind: "interior",
    locationType: family,
    locationId: id,
    instanceId,
    spaceId,
    regionCode: `interior:${instanceId}`,
    zoneId: `interior:${instanceId}:${spaceId}`,
    position: { x: 20, y: 24 },
    revision: 4,
    lastPortalId: "entry"
  };
  const world: Extract<PlayerLocationSnapshot, { kind: "world" }> = {
    kind: "world",
    regionCode: "package:nm",
    zoneId: "world:package:nm",
    position: { lat: 35.1, lon: -106.6 },
    revision: 4,
    lastPortalId: "world-spawn"
  };
  const source = direction === "entry" ? world : interior;
  const destination = direction === "entry"
    ? {
        kind: "interior" as const,
        locationType: family,
        locationId: id,
        instanceId,
        spaceId,
        position: { x: 30, y: 32 }
      }
    : direction === "exit" ? {
        kind: "world" as const,
        regionCode: "package:nm",
        position: { lat: 35.1002, lon: -106.6002 }
      } : {
        kind: "interior" as const,
        locationType: family,
        locationId: id,
        instanceId,
        spaceId: "sewer_depths",
        position: { x: 30, y: 32 }
      };
  const definition: PortalDefinition = {
    portalId: `${family}:${id}:${direction}`,
    source: direction === "entry"
      ? { kind: "world", regionCode: world.regionCode, position: world.position }
      : {
          kind: "interior",
          locationType: family,
          locationId: id,
          instanceId,
          spaceId,
          position: interior.position
        },
    destination,
    sourceApproach: direction === "entry" ? world.position : { x: 24, y: 24 },
    sourceThreshold: direction === "entry" ? world.position : { x: 28, y: 28 },
    destinationArrival: destination.position,
    interactionLabel: direction === "entry" ? "Enter" : direction === "exit" ? "Exit" : "Descend",
    transitionPresentation: "door",
    preloadSceneKey: direction === "exit" ? "world" : `${family}/${destination.kind === "interior" ? destination.spaceId : spaceId}`,
    enabled: true,
    revision: family === "manor" ? "7" : "revision-7"
  };
  const portals = new PortalRegistry();
  portals.register(definition);
  let location = source;
  let durableLocationCommitCount = 0;
  const durableLocationsByRequest = new Map<string, PlayerLocationSnapshot>();
  const commitLocation = vi.fn(async (input: {
    requestId: string;
    destination: PortalDefinition["destination"];
    portalId: string;
  }) => {
    const replayed = durableLocationsByRequest.get(input.requestId);
    if (replayed) return { location: replayed, replayed: true };
    durableLocationCommitCount += 1;
    location = input.destination.kind === "world"
      ? {
          ...input.destination,
          zoneId: `world:${input.destination.regionCode}`,
          revision: source.revision + 1,
          lastPortalId: input.portalId
        }
      : {
          ...input.destination,
          regionCode: `interior:${input.destination.instanceId}`,
          zoneId: `interior:${input.destination.instanceId}:${input.destination.spaceId}`,
          revision: source.revision + 1,
          lastPortalId: input.portalId
        };
    durableLocationsByRequest.set(input.requestId, location);
    return { location, replayed: false };
  });
  const locations = {
    load: vi.fn(async () => location),
    replayPortalTransition: vi.fn(async () => null),
    commitPortalTransition: commitLocation
  } as unknown as PlayerLocationService;
  const sent: ServerMessage[] = [];
  const registry = {
    send: vi.fn((_playerId: string, message: ServerMessage) => sent.push(message))
  } as unknown as ConnectionRegistry;
  let worldThreshold: () => void = () => undefined;
  let interiorThreshold: () => void = () => undefined;
  let manorSession: { sessionId: string; manorId: string; position: { x: number; y: number; moving: boolean } } | null =
    direction === "exit" && family === "manor"
      ? { sessionId: "manor-session", manorId: id, position: { x: 20, y: 24, moving: false } }
      : null;
  let salonSession: { sessionId: string; structureId: string; position: { x: number; y: number; moving: boolean } } | null =
    direction === "exit" && family === "salon"
      ? { sessionId: "salon-session", structureId: id, position: { x: 20, y: 24, moving: false } }
      : null;
  let sewerSession: { sessionId: string; player: { x: number; y: number; targetX: number | null } } | null =
    direction !== "entry" && (family === "cistern_warrens" || family === "dungeon")
      ? { sessionId: "sewer-session", player: { x: 20, y: 24, targetX: null } }
      : null;
  const worldRuntime = {
    subscribeMovementSettled: vi.fn((_playerId: string, callback: () => void) => {
      worldThreshold = callback;
      return vi.fn();
    })
  } as unknown as WorldRuntime;
  const manorRuntime = {
    get: vi.fn(() => manorSession),
    moveTo: vi.fn((_playerId: string, _sessionId: string, x: number, y: number) => {
      if (manorSession) manorSession.position = { x, y, moving: false };
    }),
    subscribeMovementSettled: vi.fn((_playerId: string, callback: () => void) => {
      interiorThreshold = callback;
      return vi.fn();
    }),
    stop: vi.fn()
  } as unknown as ManorRuntime;
  const salonRuntime = {
    get: vi.fn(() => salonSession),
    moveTo: vi.fn((_playerId: string, _sessionId: string, x: number, y: number) => {
      if (salonSession) salonSession.position = { x, y, moving: false };
    }),
    stop: vi.fn()
  } as unknown as SalonRuntime;
  const dungeonAuthorizeEntry = vi.fn(async () => undefined);
  const dungeon = {
    authorizeEntry: dungeonAuthorizeEntry,
    get: vi.fn(() => sewerSession),
    moveTo: vi.fn((_playerId: string, _sessionId: string, x: number, y: number) => {
      if (sewerSession) sewerSession.player = { x, y, targetX: null };
    }),
    stop: vi.fn(),
    authorizePortal: vi.fn(),
    portalUsed: vi.fn(),
    transferSpace: vi.fn((_playerId: string, _sessionId: string, nextSpaceId: string, position: { x: number; y: number }) => ({
      sewerId: id, spaceId: nextSpaceId, player: { ...position, targetX: null }
    })),
    enter: vi.fn(async (
      player: unknown,
      sewerId: string,
      canonical: { spaceId: "sewer_entrance" | "sewer_depths"; position: { x: number; y: number } }
    ) => {
      void player;
      void sewerId;
      sewerSession = {
        sessionId: "sewer-session",
        player: { x: canonical.position.x, y: canonical.position.y, targetX: null }
      };
      return {
        sewerId: id,
        spaceId: canonical.spaceId,
        player: sewerSession.player
      };
    }),
    leave: vi.fn(async () => { sewerSession = null; })
  } as unknown as CisternWarrensRuntime;
  const worldSetTarget = vi.fn();
  const gameState = {
    setTarget: worldSetTarget,
    stopPlayer: vi.fn(),
    getPlayer: vi.fn(() => ({
      playerId: "player-1",
      regionCode: "world_v1_lat35_lon-107",
      anchor: { lat: 36.2, lon: -107.4 }
    })),
    snapshotForPlayer: vi.fn(() => ({ playerId: "player-1" }))
  } as unknown as GameState;
  const authorizeManorEntry = vi.fn(async () => undefined);
  const projectManorEntry = vi.fn(async () => {
    manorSession = {
      sessionId: "manor-session",
      manorId: id,
      position: { x: 30, y: 32, moving: false }
    };
  });
  const projectManorExit = vi.fn(async () => { manorSession = null; });
  const projectSalonEntry = vi.fn(async () => {
    salonSession = {
      sessionId: "salon-session",
      structureId: id,
      position: { x: 30, y: 32, moving: false }
    };
  });
  const projectSalonExit = vi.fn(async () => { salonSession = null; });
  const applyEffects = vi.fn();
  const releaseEffects = vi.fn();
  const handler = createPortalHandler({
    state: { playerId: "player-1" },
    socket: { send: vi.fn() } as unknown as SocketLike,
    registry,
    gameState,
    locations,
    portals,
    worldRuntime,
    manorRuntime,
    salonRuntime,
    dungeon,
    effects: {
      prepare: vi.fn(),
      apply: applyEffects,
      release: releaseEffects
    },
    authorizeManorEntry,
    projectManorEntry,
    projectManorExit,
    projectSalonEntry,
    projectSalonExit
  });
  const project = family === "manor"
    ? direction === "entry" ? projectManorEntry : projectManorExit
    : family === "salon"
      ? direction === "entry" ? projectSalonEntry : projectSalonExit
      : direction === "entry" ? dungeon.enter : dungeon.leave;

  return {
    handler,
    definition,
    source,
    sent,
    commitLocation,
    durableLocationCommitCount: () => durableLocationCommitCount,
    applyEffects,
    releaseEffects,
    authorizeManorEntry,
    project,
    dungeonEnter: dungeon.enter,
    dungeonAuthorizeEntry,
    dungeon,
    dropDungeonSession() {
      sewerSession = null;
    },
    dropManorSession() {
      manorSession = null;
    },
    worldSetTarget,
    reachThreshold() {
      if (direction === "entry") worldThreshold();
      else if (family === "manor") interiorThreshold();
    }
  };
}
