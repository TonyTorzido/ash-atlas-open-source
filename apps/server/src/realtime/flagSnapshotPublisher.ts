import { randomUUID } from "node:crypto";

import { gameplayCircleFlagScopeId } from "@ash-atlas/shared";

import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";
import { flagSetRevisionMetadata, type FlagService } from "../game/flags.js";
import type { GameState } from "../game/state.js";
import type { ConnectionRegistry } from "./connectionRegistry.js";
import type { SessionConnectionState } from "./handlers/sessionHandler.js";

const FLAG_SNAPSHOT_DRAIN_TIMEOUT_MS = 10_000;

export async function publishFlagSnapshot(input: Readonly<{
  state: Pick<
    SessionConnectionState,
    "connectionId" | "connectionGeneration" | "playerId"
  >;
  playerId: string;
  registry: ConnectionRegistry;
  gameState: GameState;
  flagService: FlagService;
  scopedSnapshotsEnabled: boolean;
  isCurrent?: () => boolean;
}>): Promise<boolean> {
  const connectionId = input.state.connectionId;
  const connectionGeneration = input.state.connectionGeneration;
  if (
    !connectionId
    || connectionGeneration === null
    || input.state.playerId !== input.playerId
  ) return false;

  // Reconcile terminal rows before taking a scoped or global snapshot. This
  // repairs legacy zero-health Flags for reconnects and viewport refreshes,
  // and tells already-connected clients to drop the retired row as well.
  const reconcileZeroHealthFlags = (
    input.flagService as Partial<Pick<FlagService, "reconcileZeroHealthFlags">>
  ).reconcileZeroHealthFlags;
  if (typeof reconcileZeroHealthFlags === "function") {
    const retired = await reconcileZeroHealthFlags.call(input.flagService);
    if (retired.length > 0) {
      const revisionMetadata = await flagSetRevisionMetadata(input.flagService);
      for (const result of retired) {
        input.registry.broadcast({
          type: "FLAG_DELETED",
          flagId: result.flagId,
          reason: "deleted",
          ...revisionMetadata
        });
      }
    }
  }

  const player = input.gameState.getPlayer(input.playerId);
  const gameplayCircle = input.gameState.getGameplayViewCircle(input.playerId);
  const useScopedSnapshot = input.scopedSnapshotsEnabled
    && input.registry.connectionSupports(
      connectionId,
      "scoped-flag-snapshots"
    )
    && input.registry.connectionSupports(
      connectionId,
      "viewport-flag-loading-v1"
    )
    && player !== undefined
    && gameplayCircle !== null;
  const relocationRevision = player?.relocationRevision ?? 0;
  const gameplayViewGeneration = gameplayCircle?.generation ?? 0;
  const scopeId = useScopedSnapshot
    ? gameplayCircleFlagScopeId({
        relocationRevision,
        gameplayViewGeneration
      })
    : "global-flags";
  const snapshotId = randomUUID();
  const startedAt = performance.now();
  let socketDrainWaitMs = 0;
  const isCurrent = (): boolean =>
    (input.isCurrent?.() ?? true)
      && input.state.connectionId === connectionId
      && input.state.connectionGeneration === connectionGeneration
      && input.state.playerId === input.playerId
      && input.registry.isActivePlayerConnection(
        input.playerId,
        connectionId
      )
      && (
        !useScopedSnapshot
        || (
          (input.gameState.getPlayer(input.playerId)?.relocationRevision ?? -1)
            === relocationRevision
          && (input.gameState.getGameplayViewCircle(input.playerId)?.generation ?? -1)
            === gameplayViewGeneration
        )
      );

  const result = await input.flagService.streamFlagSnapshot(
    async (chunk) => {
      if (!isCurrent()) return false;
      const drainStartedAt = performance.now();
      if (!await input.registry.waitForConnectionDrain(
        connectionId,
        FLAG_SNAPSHOT_DRAIN_TIMEOUT_MS
      )) return false;
      socketDrainWaitMs += performance.now() - drainStartedAt;
      if (!isCurrent()) return false;
      const sendResult = input.registry.sendToConnection(connectionId, {
        type: "FLAGS_SNAPSHOT",
        flags: [...chunk.flags],
        flagSetRevision: chunk.flagSetRevision,
        complete: true,
        truncated: false,
        authority: useScopedSnapshot
          ? {
              connectionId,
              connectionGeneration,
              scopeKind: "gameplay-circle-flags",
              scopeId,
              snapshotId,
              chunkIndex: chunk.chunkIndex,
              ...(chunk.finalChunk
                ? { chunkCount: chunk.chunkIndex + 1 }
                : {}),
              finalChunk: chunk.finalChunk,
              relocationRevision,
              gameplayViewGeneration
            }
          : {
              connectionId,
              connectionGeneration,
              scopeKind: "global-flags",
              scopeId,
              snapshotId,
              chunkIndex: chunk.chunkIndex,
              ...(chunk.finalChunk
                ? { chunkCount: chunk.chunkIndex + 1 }
                : {}),
              finalChunk: chunk.finalChunk
            }
      });
      return sendResult === "sent";
    },
    250,
    useScopedSnapshot && gameplayCircle
      ? {
          center: gameplayCircle.center,
          radiusM: gameplayCircle.radiusM
        }
      : undefined
  );
  gameplayLatencyTrace.record(input.playerId, {
    traceId: snapshotId,
    source: "game",
    category: "networking",
    name: "flag_scope_snapshot_published",
    details: {
      scopeKind: useScopedSnapshot
        ? "gameplay-circle-flags"
        : "global-flags",
      chunksPublished: result.chunksPublished,
      flagsPublished: result.flagsPublished,
      completed: result.completed,
      socketDrainWaitMs,
      durationMs: performance.now() - startedAt,
      worldCalled: false
    }
  });
  return result.completed;
}
