import type {
  ClientMessage,
  DungeonSnapshot,
  DungeonSnapshotUpdate
} from "@ash-atlas/shared";

import { heartPuzzleForNpc } from "@ash-atlas/shared";
import { talkToHeartPuzzleNpc } from "../../heartPuzzles/heartPuzzleSession.js";
import { requestIdCrypto as crypto } from "../../requestId.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

export class DungeonClient {
  private scene: DungeonSnapshot | null = null;

  constructor(private readonly port: ClientCommandPort) {}

  materializeSnapshot(snapshot: DungeonSnapshot | DungeonSnapshotUpdate): DungeonSnapshot | null {
    if (snapshot.snapshotKind === "full") {
      this.scene = snapshot;
      return snapshot;
    }
    const scene = this.scene;
    if (!scene || scene.dungeonId !== snapshot.dungeonId ||
        scene.sewerId !== snapshot.sewerId ||
        scene.cityId !== snapshot.cityId ||
        scene.sessionId !== snapshot.sessionId ||
        scene.instanceId !== snapshot.instanceId ||
        scene.catalogRevision !== snapshot.catalogRevision ||
        scene.dungeonRevision !== snapshot.dungeonRevision ||
        scene.spaceId !== snapshot.spaceId ||
        scene.sceneRevision !== snapshot.sceneRevision) {
      return null;
    }
    const materialized: DungeonSnapshot = {
      ...snapshot,
      snapshotKind: "full",
      room: scene.room,
      prefabs: scene.prefabs
    };
    this.scene = materialized;
    return materialized;
  }

  clearScene(): void {
    this.scene = null;
  }

  requestEntrances(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "REQUEST_DUNGEON_ENTRANCES", requestId })
      ? requestId
      : null;
  }

  moveTo(sessionId: string, x: number, y: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DUNGEON_MOVE_TO", requestId, sessionId, x, y })
      ? requestId
      : null;
  }

  interact(sessionId: string, objectId: string): string | null {
    // Ash Heart hint NPCs talk locally (tiered hints are client-timed); nothing to send.
    if (heartPuzzleForNpc(objectId)) {
      talkToHeartPuzzleNpc(objectId);
      return "local-heart-puzzle-talk";
    }
    const requestId = crypto.randomUUID();
    return this.send({ type: "DUNGEON_INTERACT", requestId, sessionId, objectId })
      ? requestId
      : null;
  }

  /** Start (beside the room's NPC) or quit the room's Ash Heart puzzle; the server locks the player while active. */
  puzzleActive(sessionId: string, roomId: string, active: boolean): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DUNGEON_PUZZLE_ACTIVE", requestId, sessionId, roomId, active })
      ? requestId
      : null;
  }

  puzzleSolve(sessionId: string, roomId: string, clientSolveMs: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DUNGEON_PUZZLE_SOLVE", requestId, sessionId, roomId, clientSolveMs })
      ? requestId
      : null;
  }

  torchLobbyJoin(entranceId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DUNGEON_TORCH_LOBBY_JOIN", requestId, entranceId }) ? requestId : null;
  }

  torchLobbySetTorches(lobbyId: string, torches: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DUNGEON_TORCH_LOBBY_SET_TORCHES", requestId, lobbyId, torches }) ? requestId : null;
  }

  torchLobbyReady(lobbyId: string, ready: boolean): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DUNGEON_TORCH_LOBBY_READY", requestId, lobbyId, ready }) ? requestId : null;
  }

  torchLobbyStart(lobbyId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DUNGEON_TORCH_LOBBY_START", requestId, lobbyId }) ? requestId : null;
  }

  torchLobbyLeave(lobbyId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DUNGEON_TORCH_LOBBY_LEAVE", requestId, lobbyId }) ? requestId : null;
  }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }
}
