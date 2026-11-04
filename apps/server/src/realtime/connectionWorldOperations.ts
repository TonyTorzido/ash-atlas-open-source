import type { WorldViewAuthority } from "@ash-atlas/shared";

import type { AuthenticatedSession } from "../auth/types.js";
import type { AppConfig } from "../config.js";
import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";
import type { CombatEngine } from "../game/combat/combatEngine.js";
import type { PlayerAuthorityFence } from "../game/playerAuthorityFence.js";
import type { GameState } from "../game/state.js";
import type { AppLogger } from "../logger.js";
import type { WorldCommandInput } from "../game/worldCommandQueue.js";
import type { WorldRuntime } from "../game/worldRuntime.js";
import type { ConnectionRegistry, SocketLike } from "./connectionRegistry.js";
import type { ConnectionGenerationLedger } from "./connectionLifecycle.js";
import type { SessionConnectionState } from "./handlers/sessionHandler.js";
import { sendCombatError } from "./handlers/handlerExecutionContext.js";

type ConnectionWorldCommand = WorldCommandInput extends infer Command
  ? Command extends WorldCommandInput
    ? Omit<Command, "playerId" | "accountId" | "connectionId">
    : never
  : never;

export function createConnectionWorldOperations(context: Readonly<{
  state: Pick<SessionConnectionState, "playerId" | "connectionId"> &
    Partial<Pick<SessionConnectionState, "connectionGeneration">>;
  authenticatedSession: AuthenticatedSession | null | undefined;
  socket: SocketLike;
  config?: AppConfig | undefined;
  registry: ConnectionRegistry;
  gameState: GameState;
  worldRuntime?: WorldRuntime | undefined;
  combat?: CombatEngine | undefined;
  logger?: Pick<AppLogger, "info"> | undefined;
  connectionGenerations?: Pick<ConnectionGenerationLedger, "current"> | undefined;
  playerAuthorityFence: PlayerAuthorityFence;
  sendManorsForPlayer(player: ReturnType<GameState["getPlayer"]>): Promise<void>;
  sendCombatScopeSnapshot?(
    playerId: string,
    expectedAuthority?: WorldViewAuthority,
    presentationEligible?: boolean
  ): void;
}>): Readonly<{
  enqueueWorldCommand(command: ConnectionWorldCommand): boolean;
  runMovementLifecycle<T>(operation: () => Promise<T>): Promise<T>;
  awaitCommittedPlayerWorldTransition(requestId: string): Promise<boolean>;
  rejectDuringPlayerWorldTransition(
    requestId: string,
    error?: Readonly<{ code: string; message: string }>
  ): boolean;
  requestWorldResync(
    requestId: string,
    expectedWorldViewAuthority?: WorldViewAuthority
  ): void;
}> {
  const {
    state,
    authenticatedSession,
    socket,
    config,
    registry,
    gameState,
    worldRuntime,
    combat,
    logger,
    connectionGenerations,
    playerAuthorityFence,
    sendManorsForPlayer,
    sendCombatScopeSnapshot
  } = context;
  let lastWorldResyncAt = 0;

  function enqueueWorldCommand(command: ConnectionWorldCommand): boolean {
    if (!worldRuntime || !state.playerId || !state.connectionId || !authenticatedSession) {
      sendCombatError(
        socket,
        command.requestId,
        "WORLD_RUNTIME_UNAVAILABLE",
        "World runtime is unavailable"
      );
      return false;
    }
    const result = worldRuntime.enqueue({
      ...command,
      playerId: state.playerId,
      accountId: authenticatedSession.account.id,
      connectionId: state.connectionId
    } as WorldCommandInput);
    if (result.accepted) return true;
    if (result.reason === "transition-pending") {
      const transition = worldRuntime.playerWorldTransitionState(state.playerId);
      logger?.info({
        playerId: state.playerId,
        requestId: command.requestId,
        originatingConnectionId: state.connectionId,
        originatingConnectionGeneration: state.connectionGeneration ?? null,
        currentConnectionId: registry.activeConnectionIdForPlayer(state.playerId),
        currentConnectionGeneration:
          connectionGenerations?.current(state.playerId) ?? null,
        startingRelocationRevision:
          transition?.startingRelocationRevision ?? null,
        committedRelocationRevision:
          transition?.committedRelocationRevision ?? null,
        transitionPhase: transition?.phase ?? null
      }, "world command rejected during player relocation");
      sendCombatError(
        socket,
        command.requestId,
        "WORLD_AUTHORITY_PREPARING",
        "World authority is still preparing after travel. Try again shortly.",
        {
          retryable: true,
          retryAfterMs: 250,
          ...("targetEntityId" in command
            ? { targetEntityId: command.targetEntityId }
            : {}),
          relocationRevision:
            gameState.getPlayer(state.playerId)?.relocationRevision ?? 0,
          gameplayViewGeneration:
            gameState.getGameplayViewCircle(state.playerId)?.generation ?? 0
        }
      );
      return false;
    }
    const overflow = result.reason !== "duplicate";
    sendCombatError(
      socket,
      command.requestId,
      overflow ? "COMMAND_QUEUE_FULL" : "COMMAND_DUPLICATE",
      overflow
        ? "Too many world commands are pending; try again shortly"
        : "Duplicate world command ignored"
    );
    return false;
  }

  function runMovementLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    return state.playerId
      ? playerAuthorityFence.run(state.playerId, operation)
      : operation();
  }

  function rejectDuringPlayerWorldTransition(
    requestId: string,
    error: Readonly<{ code: string; message: string }> = {
      code: "PLAYER_WORLD_TRANSITION_PENDING",
      message: "This operation cannot run during a player world transition"
    }
  ): boolean {
    if (
      !worldRuntime ||
      !state.playerId ||
      !worldRuntime.hasPlayerWorldTransition(state.playerId)
    ) return false;
    sendCombatError(
      socket,
      requestId,
      error.code,
      error.message
    );
    return true;
  }

  async function awaitCommittedPlayerWorldTransition(
    requestId: string
  ): Promise<boolean> {
    if (!worldRuntime || !state.playerId || !state.connectionId) return true;
    const transition = worldRuntime.playerWorldTransitionState(state.playerId);
    if (!transition) return true;
    if (
      transition.committedRelocationRevision === null
      || transition.connectionId !== state.connectionId
    ) {
      return false;
    }
    const playerId = state.playerId;
    const connectionId = state.connectionId;
    const relocationRevision = transition.committedRelocationRevision;
    const startedAt = performance.now();
    await Promise.race([
      worldRuntime.waitForPlayerWorldTransition(playerId),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 750);
        timer.unref?.();
      })
    ]);
    const valid =
      state.playerId === playerId
      && state.connectionId === connectionId
      && registry.activeConnectionIdForPlayer(playerId) === connectionId
      && worldRuntime.playerWorldTransitionState(playerId) === null
      && gameState.getPlayer(playerId)?.relocationRevision === relocationRevision;
    gameplayLatencyTrace.record(playerId, {
      traceId: transition.requestId ?? requestId,
      source: "game",
      category: "population",
      name: valid
        ? "post_travel_safe_intent_released"
        : "post_travel_safe_intent_discarded",
      details: {
        requestId,
        connectionId,
        relocationRevision,
        deferredMs: performance.now() - startedAt
      },
      failure: !valid
    });
    return valid;
  }

  function requestWorldResync(
    requestId: string,
    expectedWorldViewAuthority?: WorldViewAuthority
  ): void {
    if (!worldRuntime || !combat || !state.playerId || !state.connectionId) return;
    const now = Date.now();
    if (now - lastWorldResyncAt < (config?.WORLD_RESYNC_MIN_INTERVAL_MS ?? 2_000)) {
      sendCombatError(socket, requestId, "RESYNC_RATE_LIMITED", "World resync is rate limited");
      return;
    }
    lastWorldResyncAt = now;
    worldRuntime.replication.requestResync(state.playerId);
    combat.requestResync(state.playerId);
    const interest = worldRuntime.interestFrameFor([state.playerId]);
    registry.sendToConnection(state.connectionId, {
      type: "PLAYER_SNAPSHOT",
      serverTime: now,
      sequence: 0,
      players: worldRuntime.replication.snapshotForPlayer(state.playerId, interest)
    });
    if (sendCombatScopeSnapshot) {
      sendCombatScopeSnapshot(
        state.playerId,
        expectedWorldViewAuthority,
        true
      );
    } else {
      registry.sendToConnection(state.connectionId, {
        type: "COMBAT_SNAPSHOT",
        state: combat.snapshotForPlayer(state.playerId, interest)
      });
    }
    void sendManorsForPlayer(gameState.getPlayer(state.playerId));
  }

  return {
    enqueueWorldCommand,
    runMovementLifecycle,
    awaitCommittedPlayerWorldTransition,
    rejectDuringPlayerWorldTransition,
    requestWorldResync
  };
}
