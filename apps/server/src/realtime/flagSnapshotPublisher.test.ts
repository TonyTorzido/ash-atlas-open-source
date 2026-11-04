import { describe, expect, it, vi } from "vitest";

import { ConnectionRegistry } from "./connectionRegistry.js";
import { publishFlagSnapshot } from "./flagSnapshotPublisher.js";

describe("publishFlagSnapshot", () => {
  it("paces all 11,249 flags globally for a slow capable connection when scoping is off", async () => {
    const totalFlags = 11_249;
    const flags = Array.from({ length: totalFlags }, (_, index) => ({
      id: `flag-${index.toString().padStart(5, "0")}`,
      name: `Flag ${index} ${"x".repeat(180)}`
    }));
    let maximumBufferedAmount = 0;
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn((frame: string) => {
        sent.push(frame);
        socket.bufferedAmount += Buffer.byteLength(frame);
        maximumBufferedAmount = Math.max(
          maximumBufferedAmount,
          socket.bufferedAmount
        );
        setTimeout(() => {
          socket.bufferedAmount = 0;
        }, 1);
      }),
      close: vi.fn()
    };
    const registry = new ConnectionRegistry();
    const connectionId = registry.add({
      playerId: "player-1",
      username: "Player",
      regionCode: "GLOBAL",
      zoneId: "world:GLOBAL:0:0",
      protocolCapabilities: [
        "scoped-flag-snapshots",
        "viewport-flag-loading-v1"
      ],
      socket
    });
    const flagService = {
      streamFlagSnapshot: vi.fn(async (
        onChunk: (chunk: {
          flags: Array<{ id: string; name: string }>;
          flagSetRevision: number;
          chunkIndex: number;
          finalChunk: boolean;
        }) => boolean | Promise<boolean>,
        pageSize: number,
        scope?: unknown
      ) => {
        void scope;
        let chunksPublished = 0;
        let flagsPublished = 0;
        for (let offset = 0; offset < flags.length; offset += pageSize) {
          const chunkFlags = flags.slice(offset, offset + pageSize);
          const accepted = await onChunk({
            flags: chunkFlags,
            flagSetRevision: 42,
            chunkIndex: chunksPublished,
            finalChunk: offset + pageSize >= flags.length
          });
          if (!accepted) {
            return {
              flagSetRevision: 42,
              chunksPublished,
              flagsPublished,
              completed: false
            };
          }
          chunksPublished += 1;
          flagsPublished += chunkFlags.length;
        }
        return {
          flagSetRevision: 42,
          chunksPublished,
          flagsPublished,
          completed: true
        };
      })
    };

    await expect(publishFlagSnapshot({
      state: {
        playerId: "player-1",
        connectionId,
        connectionGeneration: 8
      },
      playerId: "player-1",
      registry,
      gameState: gameState() as never,
      flagService: flagService as never,
      scopedSnapshotsEnabled: false
    })).resolves.toBe(true);

    expect(flagService.streamFlagSnapshot).toHaveBeenCalledWith(
      expect.any(Function),
      250,
      undefined
    );
    expect(sent).toHaveLength(Math.ceil(totalFlags / 250));
    expect(sent.reduce(
      (count, frame) => count + JSON.parse(frame).flags.length,
      0
    )).toBe(totalFlags);
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({
      authority: {
        scopeKind: "global-flags",
        chunkIndex: 44,
        chunkCount: 45,
        finalChunk: true
      }
    });
    expect(maximumBufferedAmount).toBeLessThan(4 * 1024 * 1024);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("keeps a paced global fallback for clients without the scoped capability", async () => {
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn((frame: string) => sent.push(frame)),
      close: vi.fn()
    };
    const registry = new ConnectionRegistry();
    const connectionId = registry.add({
      playerId: "player-1",
      username: "Player",
      regionCode: "GLOBAL",
      zoneId: "world:GLOBAL:0:0",
      socket
    });
    const flagService = {
      streamFlagSnapshot: vi.fn(async (
        onChunk: (chunk: {
          flags: Array<{ id: string }>;
          flagSetRevision: number;
          chunkIndex: number;
          finalChunk: boolean;
        }) => boolean | Promise<boolean>
      ) => {
        const first = await onChunk({
          flags: [{ id: "flag-near" }],
          flagSetRevision: 40,
          chunkIndex: 0,
          finalChunk: false
        });
        const second = await onChunk({
          flags: [{ id: "flag-far" }],
          flagSetRevision: 40,
          chunkIndex: 1,
          finalChunk: true
        });
        return {
          flagSetRevision: 40,
          chunksPublished: Number(first) + Number(second),
          flagsPublished: 2,
          completed: second
        };
      })
    };

    await expect(publishFlagSnapshot({
      state: {
        playerId: "player-1",
        connectionId,
        connectionGeneration: 3
      },
      playerId: "player-1",
      registry,
      gameState: gameState() as never,
      flagService: flagService as never,
      scopedSnapshotsEnabled: true
    })).resolves.toBe(true);

    expect(flagService.streamFlagSnapshot).toHaveBeenCalledWith(
      expect.any(Function),
      250,
      undefined
    );
    expect(sent.map((frame) => JSON.parse(frame))).toEqual([
      expect.objectContaining({
        flags: [expect.objectContaining({ id: "flag-near" })],
        authority: expect.objectContaining({
          connectionId,
          connectionGeneration: 3,
          scopeKind: "global-flags",
          scopeId: "global-flags",
          chunkIndex: 0,
          finalChunk: false
        })
      }),
      expect.objectContaining({
        flags: [expect.objectContaining({ id: "flag-far" })],
        authority: expect.objectContaining({
          chunkIndex: 1,
          chunkCount: 2,
          finalChunk: true
        })
      })
    ]);
  });

  it("stops an old snapshot after connection replacement", async () => {
    const oldSocket = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn()
    };
    const registry = new ConnectionRegistry();
    const oldConnectionId = registry.add({
      accountId: "account-1",
      playerId: "player-1",
      username: "Player",
      regionCode: "GLOBAL",
      zoneId: "world:GLOBAL:0:0",
      socket: oldSocket
    });
    const flagService = {
      streamFlagSnapshot: vi.fn(async (
        onChunk: (chunk: {
          flags: never[];
          flagSetRevision: number;
          chunkIndex: number;
          finalChunk: boolean;
        }) => boolean | Promise<boolean>
      ) => {
        const first = await onChunk({
          flags: [],
          flagSetRevision: 40,
          chunkIndex: 0,
          finalChunk: false
        });
        registry.add({
          accountId: "account-1",
          playerId: "player-1",
          username: "Player",
          regionCode: "GLOBAL",
          zoneId: "world:GLOBAL:0:0",
          socket: {
            readyState: 1,
            bufferedAmount: 0,
            send: vi.fn(),
            close: vi.fn()
          }
        });
        const second = await onChunk({
          flags: [],
          flagSetRevision: 40,
          chunkIndex: 1,
          finalChunk: true
        });
        return {
          flagSetRevision: 40,
          chunksPublished: first ? 1 : 0,
          flagsPublished: 0,
          completed: second
        };
      })
    };

    await expect(publishFlagSnapshot({
      state: {
        playerId: "player-1",
        connectionId: oldConnectionId,
        connectionGeneration: 3
      },
      playerId: "player-1",
      registry,
      gameState: gameState() as never,
      flagService: flagService as never,
      scopedSnapshotsEnabled: true
    })).resolves.toBe(false);
    expect(oldSocket.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(oldSocket.send.mock.calls[0]![0])).toMatchObject({
      type: "FLAGS_SNAPSHOT",
      authority: { connectionId: oldConnectionId, chunkIndex: 0 }
    });
    expect(JSON.parse(oldSocket.send.mock.calls[1]![0])).toMatchObject({
      type: "SESSION_REPLACED"
    });
  });

  it("publishes only the authoritative gameplay circle for capable clients", async () => {
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn((frame: string) => sent.push(frame)),
      close: vi.fn()
    };
    const registry = new ConnectionRegistry();
    const connectionId = registry.add({
      playerId: "player-1",
      username: "Player",
      regionCode: "GLOBAL",
      zoneId: "world:GLOBAL:0:0",
      protocolCapabilities: [
        "scoped-flag-snapshots",
        "viewport-flag-loading-v1"
      ],
      socket
    });
    const flagService = {
      streamFlagSnapshot: vi.fn(async (
        onChunk: (chunk: {
          flags: Array<{ id: string }>;
          flagSetRevision: number;
          chunkIndex: number;
          finalChunk: boolean;
        }) => boolean | Promise<boolean>
      ) => {
        const completed = await onChunk({
          flags: [{ id: "flag-near" }],
          flagSetRevision: 41,
          chunkIndex: 0,
          finalChunk: true
        });
        return {
          flagSetRevision: 41,
          chunksPublished: Number(completed),
          flagsPublished: 1,
          completed
        };
      })
    };

    await expect(publishFlagSnapshot({
      state: {
        playerId: "player-1",
        connectionId,
        connectionGeneration: 7
      },
      playerId: "player-1",
      registry,
      gameState: gameState() as never,
      flagService: flagService as never,
      scopedSnapshotsEnabled: true
    })).resolves.toBe(true);

    expect(flagService.streamFlagSnapshot).toHaveBeenCalledWith(
      expect.any(Function),
      250,
      {
        center: { lat: 35, lon: -106 },
        radiusM: 650
      }
    );
    expect(JSON.parse(sent[0]!)).toMatchObject({
      type: "FLAGS_SNAPSHOT",
      flags: [{ id: "flag-near" }],
      authority: {
        connectionId,
        connectionGeneration: 7,
        scopeKind: "gameplay-circle-flags",
        scopeId: "gameplay-circle-flags:4:9",
        relocationRevision: 4,
        gameplayViewGeneration: 9,
        chunkIndex: 0,
        chunkCount: 1,
        finalChunk: true
      }
    });
  });

  it("publishes a deletion when snapshot reconciliation retires a legacy row", async () => {
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn((frame: string) => sent.push(frame)),
      close: vi.fn()
    };
    const registry = new ConnectionRegistry();
    const connectionId = registry.add({
      playerId: "player-1",
      username: "Player",
      regionCode: "GLOBAL",
      zoneId: "world:GLOBAL:0:0",
      socket
    });
    const flagService = {
      reconcileZeroHealthFlags: vi.fn(async () => [{
        flagId: "legacy-zero-health",
        affectedFlagIds: [],
        notificationPlayerIds: ["player-1"]
      }]),
      currentFlagSetRevision: vi.fn(async () => 42),
      streamFlagSnapshot: vi.fn(async (
        onChunk: (chunk: {
          flags: never[];
          flagSetRevision: number;
          chunkIndex: number;
          finalChunk: boolean;
        }) => boolean | Promise<boolean>
      ) => {
        const accepted = await onChunk({
          flags: [],
          flagSetRevision: 42,
          chunkIndex: 0,
          finalChunk: true
        });
        return {
          flagSetRevision: 42,
          chunksPublished: Number(accepted),
          flagsPublished: 0,
          completed: accepted
        };
      })
    };

    await expect(publishFlagSnapshot({
      state: { playerId: "player-1", connectionId, connectionGeneration: 1 },
      playerId: "player-1",
      registry,
      gameState: gameState() as never,
      flagService: flagService as never,
      scopedSnapshotsEnabled: false
    })).resolves.toBe(true);

    expect(flagService.reconcileZeroHealthFlags).toHaveBeenCalledOnce();
    expect(sent.map((frame) => JSON.parse(frame))).toEqual([
      {
        type: "FLAG_DELETED",
        flagId: "legacy-zero-health",
        reason: "deleted",
        flagSetRevision: 42
      },
      expect.objectContaining({ type: "FLAGS_SNAPSHOT", flags: [] })
    ]);
  });
});

function gameState() {
  return {
    getPlayer: () => ({ relocationRevision: 4 }),
    getGameplayViewCircle: () => ({
      center: { lat: 35, lon: -106 },
      radiusM: 650,
      generation: 9
    })
  };
}
