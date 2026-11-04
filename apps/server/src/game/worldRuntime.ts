import {
  DASH_DISTANCE_M,
  distanceMeters,
  isFiniteLatLon,
  MERCHANT_MAXIMIZE_TACTICS_ABILITY_ID,
  SWING_LAG_COMP_MAX_MS,
  type ServerMessage,
  type WorldViewAuthority
} from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";
import type { AppLogger } from "../logger.js";
import {
  CombatRequestError,
  type CombatEngine,
  type CombatInterestFrame,
  type SwingResolution
} from "./combat/combatEngine.js";
import type { GameState } from "./state.js";
import { waterLegSpeedProfile } from "./waterTravel.js";
import type { DruidReplenishService } from "./combat/druidReplenish.js";
import type { MerchantMaximizeTacticsService } from "./combat/merchantMaximizeTactics.js";
import {
  WorldCommandQueue,
  type CommandProcessResult,
  type EnqueueResult,
  type WorldCommand,
  type WorldCommandInput
} from "./worldCommandQueue.js";
import { WorldReplicationService } from "./worldReplication.js";
import {
  populationZoneV2IdForPoint,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import { adjacentZoneIdsForPosition, zoneIdForPosition } from "./spatialZones.js";
import type { ManorRuntime } from "./manor.js";

export type WorldRuntimeMetrics = {
  currentTick: number;
  lastTickDurationMs: number;
  longestRecentTickMs: number;
  worldDeltasSent: number;
  combatDeltasSent: number;
};

export type TrackedEnqueueResult =
  | (Extract<EnqueueResult, { accepted: true }> & {
      completion: Promise<CommandProcessResult>;
    })
  | Extract<EnqueueResult, { accepted: false }>;

export type AuthorityRevocationResult = "revoked" | "stale-connection";

export type WorldSendResult =
  | "sent"
  | "missing"
  | "not-open"
  | "backpressure-skipped"
  | "closed";

export interface WorldConnectionPort {
  send(
    playerId: string,
    message: ServerMessage,
    mode?: "critical" | "replaceable"
  ): WorldSendResult;
  sendToConnection(
    connectionId: string,
    message: ServerMessage,
    mode?: "critical" | "replaceable"
  ): WorldSendResult;
  activePlayerIds(): string[];
  activeConnectionIdForPlayer(playerId: string): string | null;
  isActiveConnection(accountId: string, connectionId: string): boolean;
  isActivePlayerConnection(playerId: string, connectionId: string): boolean;
  updateSpatialMembership(input: {
    playerId: string;
    regionCode: string;
    zoneId: string;
    interestZoneIds: string[];
  }): void;
  metricsSnapshot(): Readonly<{
    messagesSent: number;
    replaceableSkipped: number;
    replaceableCoalesced: number;
    recoverableSocialSkipped: number;
    transientSocialSkipped: number;
    backpressureClosures: number;
  }>;
}

const BOUND_TRAVEL_MOVE_TTL_MS = 2_000;
const DEFAULT_WORLD_TRANSITION_WAIT_TIMEOUT_MS = 5_000;

export type PlayerWorldTransitionPhase =
  | "started"
  | "phase-one-running"
  | "committed"
  | "waiting-visible-population";

/** A deferred swing answers within about 2 s (buffer limit plus windup); an entry this old was dropped by the engine. */
const DEFERRED_SWING_ENTRY_MAX_AGE_MS = 5_000;

export class WorldRuntime {
  readonly commands: WorldCommandQueue;
  readonly replication: WorldReplicationService;
  private readonly worldDeltaEveryTicks: number;
  private readonly combatDeltaEveryTicks: number;
  private readonly playerWorldTransitions = new Map<string, {
    token: symbol;
    requestId: string | null;
    connectionId: string | null;
    connectionGeneration: number | null;
    withholdPlayerReplication: boolean;
    startedAtMs: number;
    startingRelocationRevision: number;
    phase: PlayerWorldTransitionPhase;
    abortPreCommit: (() => void) | null;
    completed: Promise<void>;
    resolve: () => void;
    committedRelocationRevision: number | null;
    bufferedMove: {
      command: WorldCommandInput & { kind: "move" };
      receivedAtMs: number;
    } | null;
  }>();
  private readonly recentCommittedTravelBindings = new Map<string, {
    requestId: string;
    connectionId: string | null;
    expiresAtMs: number;
  }>();
  private readonly populationPreparationByPlayer = new Map<string, {
    relocationRevision: number;
    requestId: string | null;
  }>();
  private readonly withheldPopulationZonesByPlayer = new Map<string, Readonly<{
    connectionId: string;
    connectionGeneration: number;
    preparationGeneration: number;
    relocationRevision: number;
    resourceVisionRevision: number;
    gameplayViewGeneration: number;
    zoneIds: ReadonlySet<PopulationZoneV2Id>;
  }>>();
  private readonly mobAiPresentationAuthorityByPlayer = new Map<string, {
    authority: WorldViewAuthority;
    mobEntityIds: Set<string>;
  }>();
  private readonly commandCompletions = new Map<
    number,
    (result: CommandProcessResult) => void
  >();
  private druidReplenish: DruidReplenishService | null = null;
  private merchantTactics: MerchantMaximizeTacticsService | null = null;
  private readonly pendingReplenishPlayers = new Set<string>();
  private readonly deferredReplenishCommands: Array<{ command: WorldCommand; sequence: number }> = [];
  private readonly relocationCommandSequenceByPlayer = new Map<string, number>();
  private readonly lastAuthorityResyncAtByPlayer = new Map<string, number>();
  /**
   * Action combat: per player, per swing requestId, the connection a deferred swing was pressed on, so its one
   * SWING_RESULT goes back there only. Several can be in flight at once (a windup landing at contact plus an early
   * press buffered behind it), so each swing keeps its own entry.
   */
  private readonly bufferedSwingConnections = new Map<string, Map<string, { connectionId: string; receivedAtMs: number }>>();
  private readonly movementSettledListeners = new Map<string, Set<{
    listener: () => void;
    observedMovement: boolean;
    movementRevision: number;
  }>>();
  private mutualPositionVisiblePairs = new Set<string>();
  private onMutualPositionVisibilityEntries?: (
    pairs: readonly (readonly [string, string])[]
  ) => void;
  private metrics: WorldRuntimeMetrics = {
    currentTick: 0,
    lastTickDurationMs: 0,
    longestRecentTickMs: 0,
    worldDeltasSent: 0,
    combatDeltasSent: 0
  };

  constructor(
    private readonly config: AppConfig,
    private readonly registry: WorldConnectionPort,
    private readonly gameState: GameState,
    private readonly combat: CombatEngine,
    private readonly logger: AppLogger,
    private readonly manorRuntime?: ManorRuntime,
    private readonly partyCombatPublisher?: { flush(): void }
  ) {
    this.commands = new WorldCommandQueue(
      config.WORLD_COMMAND_QUEUE_GLOBAL_MAX,
      config.WORLD_COMMAND_QUEUE_PER_PLAYER_MAX,
      config.SERVER_TICK_HZ * 60
    );
    this.replication = new WorldReplicationService(gameState);
    this.worldDeltaEveryTicks = Math.max(
      1,
      Math.round(config.SERVER_TICK_HZ / config.WORLD_DELTA_HZ)
    );
    this.combatDeltaEveryTicks = Math.max(
      1,
      Math.round(config.SERVER_TICK_HZ / config.COMBAT_DELTA_HZ)
    );
  }

  configureDruidReplenish(service: DruidReplenishService): void {
    this.druidReplenish = service;
  }

  configureMerchantMaximizeTactics(service: MerchantMaximizeTacticsService): void {
    this.merchantTactics = service;
  }

  private isReplenishPending(playerId: string): boolean {
    return this.pendingReplenishPlayers.has(playerId) || this.combat.isPlayerReserved(playerId);
  }

  private commandTouchesReplenish(command: WorldCommand): boolean {
    return this.isReplenishPending(command.playerId) ||
      ("targetEntityId" in command && typeof command.targetEntityId === "string" &&
        this.isReplenishPending(command.targetEntityId));
  }

  enqueue(command: WorldCommandInput): EnqueueResult {
    const transition = this.playerWorldTransitions.get(command.playerId);
    if (transition) {
      if (
        command.kind === "move" &&
        (
          command.boundTravelRequestId === undefined
          || command.boundTravelRequestId === transition.requestId
        ) &&
        command.connectionId === transition.connectionId &&
        this.isTransitionMoveValid(
          command,
          transition.committedRelocationRevision
            ?? transition.startingRelocationRevision
        )
      ) {
        transition.bufferedMove = {
          command,
          receivedAtMs: Date.now()
        };
        gameplayLatencyTrace.record(command.playerId, {
          traceId: transition.requestId ?? command.boundTravelRequestId,
          source: "game",
          category: "movement",
          name: transition.committedRelocationRevision === null
            ? "pre_commit_movement_buffered"
            : "post_travel_movement_buffered",
          details: {
            movementBuffered: true,
            relocationRevision:
              this.gameState.getPlayer(command.playerId)?.relocationRevision ?? 0
          }
        });
        return { accepted: true, sequence: 0, buffered: true };
      }
      if (
        command.kind !== "disconnect-player" &&
        !(command.kind === "lifecycle-cancel" && command.reason === "connection-replaced")
      ) {
        gameplayLatencyTrace.record(command.playerId, {
          traceId: transition.requestId ?? command.requestId,
          source: "game",
          category: "population",
          name: "command_rejected_during_pre_commit_relocation",
          details: {
            commandKind: command.kind,
            transitionPhase: transition.phase,
            relocationRevision:
              this.gameState.getPlayer(command.playerId)?.relocationRevision ?? 0
          },
          failure: true
        });
        return { accepted: false, reason: "transition-pending" };
      }
    }
    const populationPreparation =
      this.populationPreparationByPlayer.get(command.playerId);
    if (command.kind === "move") {
      const binding = this.recentCommittedTravelBindings.get(command.playerId);
      if (
        command.boundTravelRequestId === undefined &&
        binding &&
        binding.expiresAtMs >= Date.now() &&
        binding.connectionId === command.connectionId
      ) {
        this.recentCommittedTravelBindings.delete(command.playerId);
        const accepted = this.enqueue(command);
        if (accepted.accepted) {
          gameplayLatencyTrace.record(command.playerId, {
            traceId: binding.requestId,
            source: "game",
            category: "movement",
            name: "first_post_arrival_move_accepted",
            details: {
              movementRevision:
                this.gameState.getPlayer(command.playerId)?.movementRevision ?? 0,
              relocationRevision:
                this.gameState.getPlayer(command.playerId)?.relocationRevision ?? 0
            }
          });
        }
        return accepted;
      }
    }
    if (command.kind === "move" && command.boundTravelRequestId !== undefined) {
      const binding = this.recentCommittedTravelBindings.get(command.playerId);
      if (
        binding?.requestId === command.boundTravelRequestId &&
        binding.expiresAtMs >= Date.now() &&
        binding.connectionId === command.connectionId &&
        isFiniteLatLon(command.target.lat, command.target.lon)
      ) {
        this.recentCommittedTravelBindings.delete(command.playerId);
        const unboundCommand = { ...command };
        delete unboundCommand.boundTravelRequestId;
        return this.enqueue(unboundCommand as WorldCommandInput);
      }
      if (binding && binding.expiresAtMs < Date.now()) {
        this.recentCommittedTravelBindings.delete(command.playerId);
      }
      return { accepted: false, reason: "transition-pending" };
    }
    const acceptedViewGeneration = command.kind === "universal-taunt"
      ? this.gameState.getGameplayViewCircle(command.playerId)?.generation ?? -1
      : undefined;
    const result = this.commands.enqueue({
      ...command,
      ...(acceptedViewGeneration === undefined ? {} : { acceptedViewGeneration }),
      acceptedRelocationRevision:
        this.gameState.getPlayer(command.playerId)?.relocationRevision ?? 0,
      acceptedTick: this.combat.serverTick
    } as WorldCommand);
    if (
      result.accepted &&
      populationPreparation &&
      command.kind !== "disconnect-player" &&
      command.kind !== "lifecycle-cancel"
    ) {
      gameplayLatencyTrace.record(command.playerId, {
        traceId: populationPreparation.requestId ?? command.requestId,
        source: "game",
        category: "population",
        name: "command_accepted_after_relocation_during_population_preparation",
        details: {
          commandKind: command.kind,
          relocationRevision: populationPreparation.relocationRevision
        }
      });
    }
    return result;
  }

  enqueueTracked(command: WorldCommandInput): TrackedEnqueueResult {
    const result = this.enqueue(command);
    if (!result.accepted) {
      return result;
    }
    const completion = new Promise<CommandProcessResult>((resolve) => {
      this.commandCompletions.set(result.sequence, resolve);
    });
    return { ...result, completion };
  }

  tick(deltaSeconds: number, preCombatMovement?: () => void): void {
    const startedAt = performance.now();
    for (let index = 0; index < this.deferredReplenishCommands.length;) {
      const deferred = this.deferredReplenishCommands[index]!;
      if (this.commandTouchesReplenish(deferred.command)) { index += 1; continue; }
      this.deferredReplenishCommands.splice(index, 1);
      const result = this.processCommand(
        { ...deferred.command, acceptedTick: this.combat.serverTick }, deferred.sequence
      );
      this.commandCompletions.get(deferred.sequence)?.(result);
      this.commandCompletions.delete(deferred.sequence);
    }
    this.commands.drain(this.config.WORLD_COMMANDS_PER_TICK_MAX, (command, sequence) => {
      if (this.commandTouchesReplenish(command)) {
        this.deferredReplenishCommands.push({ command, sequence });
        return "processed";
      }
      let result: CommandProcessResult = "rejected";
      try {
        result = this.processCommand(command, sequence);
        return result;
      } finally {
        this.commandCompletions.get(sequence)?.(result);
        this.commandCompletions.delete(sequence);
      }
    });
    this.combat.beginTick();
    const changedManorIds = new Set<string>();
    for (const session of this.manorRuntime?.tick(deltaSeconds) ?? []) {
      changedManorIds.add(session.manorId);
      this.registry.send(session.playerId, {
        type: "MANOR_POSITION",
        manorSessionId: session.sessionId,
        spaceId: session.spaceId,
        position: session.position,
        movementSequence: session.movementSequence,
        serverTime: Date.now()
      }, "replaceable");
    }
    for (const manorId of changedManorIds) {
      this.sendManorOccupants(manorId, "replaceable");
    }
    // A negative multiplier holds the player in place (replenish reservation, Skyrise immobilize).
    this.gameState.tick(deltaSeconds, (playerId) => this.isReplenishPending(playerId) ||
      this.combat.isPlayerImmobilized(playerId)
      ? -1 : this.combat.playerMovementMultiplier(playerId));
    preCombatMovement?.();
    this.publishMovementSettled();
    for (const playerId of this.registry.activePlayerIds()) {
      if (!this.gameState.isWorldPresent(playerId)) continue;
      const player = this.gameState.getPlayer(playerId);
      if (player) {
        const zoneId = zoneIdForPosition(player.position);
        const gameplayView = this.gameState.getGameplayViewCircle(playerId);
        const gameplayCenter = gameplayView?.center ?? player.anchor;
        this.registry.updateSpatialMembership({
          playerId,
          regionCode: player.regionCode,
          zoneId,
          interestZoneIds: gameplayView
            ? [...gameplayView.eligibleZoneIds]
            : adjacentZoneIdsForPosition(gameplayCenter)
        });
        this.combat.syncPlayer({
          playerId,
          position: player.position,
          regionCode: player.regionCode,
          zoneId,
          name: player.username
        });
      }
    }
    this.combat.finishTick();
    const worldReplicationDue = this.combat.serverTick % this.worldDeltaEveryTicks === 0;
    const immediateFlush = this.combat.takeImmediateFlush();
    const combatReplicationDue = immediateFlush || this.combat.serverTick % this.combatDeltaEveryTicks === 0;
    if (worldReplicationDue || combatReplicationDue) {
      this.flushReplication(worldReplicationDue, combatReplicationDue);
    }
    const duration = performance.now() - startedAt;
    this.metrics.currentTick = this.combat.serverTick;
    this.metrics.lastTickDurationMs = duration;
    this.metrics.longestRecentTickMs =
      this.combat.serverTick % (this.config.SERVER_TICK_HZ * 60) === 0
        ? duration
        : Math.max(this.metrics.longestRecentTickMs, duration);
  }

  sendManorOccupants(manorId: string, mode: "critical" | "replaceable" = "critical"): void {
    if (!this.manorRuntime) return;
    const occupants = this.manorRuntime.sessionsInManor(manorId).flatMap((session) => {
      const player = this.gameState.getPlayer(session.playerId);
      if (!player) return [];
      return [{
        playerId: session.playerId,
        displayName: player.username,
        displayColor: player.displayColor,
        ...(player.appearance ? { appearance: structuredClone(player.appearance) } : {}),
        spaceId: session.spaceId,
        accessSource: session.accessSource,
        position: session.position,
        movementSequence: session.movementSequence
      }];
    });
    const message = {
      type: "MANOR_OCCUPANTS" as const,
      manorId,
      occupants,
      serverTime: Date.now()
    };
    for (const playerId of this.manorRuntime.playerIdsInManor(manorId)) {
      const viewer = this.manorRuntime.get(playerId);
      this.registry.send(playerId, {
        ...message,
        occupants: occupants.filter((occupant) =>
          occupant.playerId !== playerId && occupant.spaceId === viewer?.spaceId
        )
      }, mode);
    }
  }

  interestFrameFor(playerIds: Iterable<string>): CombatInterestFrame {
    const orderedPlayerIds = [...playerIds].sort();
    return this.filterWithheldPopulationCombat(
      this.combat.buildInterestFrame(orderedPlayerIds)
    );
  }

  updateWithheldPopulationZones(input: Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    preparationGeneration: number;
    relocationRevision: number;
    resourceVisionRevision: number;
    gameplayViewGeneration: number;
    withheldZoneIds: readonly PopulationZoneV2Id[];
  }>): boolean {
    const player = this.gameState.getPlayer(input.playerId);
    if (
      !this.registry.isActivePlayerConnection(
        input.playerId,
        input.connectionId
      ) ||
      player?.relocationRevision !== input.relocationRevision ||
      this.gameState.getResourceVisionRevision(input.playerId) !==
        input.resourceVisionRevision ||
      this.gameState.getGameplayViewCircle(input.playerId)?.generation !==
        input.gameplayViewGeneration
    ) return false;
    const current = this.withheldPopulationZonesByPlayer.get(input.playerId);
    if (
      current &&
      current.connectionId === input.connectionId &&
      comparePopulationWithholdingAuthority(input, current) < 0
    ) return false;
    const nextZoneIds = new Set(input.withheldZoneIds);
    const visibilityChanged = !current ||
      !sameStringSet(current.zoneIds, nextZoneIds);
    this.withheldPopulationZonesByPlayer.set(input.playerId, {
      connectionId: input.connectionId,
      connectionGeneration: input.connectionGeneration,
      preparationGeneration: input.preparationGeneration,
      relocationRevision: input.relocationRevision,
      resourceVisionRevision: input.resourceVisionRevision,
      gameplayViewGeneration: input.gameplayViewGeneration,
      zoneIds: nextZoneIds
    });
    if (visibilityChanged) this.combat.requestResync(input.playerId);
    return true;
  }

  markMobAiPresentationAuthority(
    authority: WorldViewAuthority,
    presentedMobEntityIds: readonly string[]
  ): boolean {
    const player = this.gameState.getPlayer(authority.playerId);
    const withholding = this.withheldPopulationZonesByPlayer.get(authority.playerId);
    if (
      !player ||
      !this.registry.isActivePlayerConnection(authority.playerId, authority.connectionId) ||
      player.relocationRevision !== authority.relocationRevision ||
      this.gameState.getResourceVisionRevision(authority.playerId) !==
        authority.resourceVisionRevision ||
      this.gameState.getGameplayViewCircle(authority.playerId)?.generation !==
        authority.gameplayViewGeneration ||
      (withholding?.preparationGeneration ?? 0) !==
        authority.populationPreparationGeneration
    ) return false;
    this.mobAiPresentationAuthorityByPlayer.set(authority.playerId, {
      authority,
      mobEntityIds: new Set(presentedMobEntityIds.filter((mobEntityId) =>
        this.isMobAiAuthorityCurrent(mobEntityId, authority)
      ))
    });
    return true;
  }

  canMobProactivelyAcquire(mobEntityId: string, playerId: string): boolean {
    const presentation = this.mobAiPresentationAuthorityByPlayer.get(playerId);
    if (!presentation || this.hasPlayerWorldTransition(playerId)) return false;
    if (!presentation.mobEntityIds.has(mobEntityId)) return false;
    if (!this.registry.isActivePlayerConnection(playerId, presentation.authority.connectionId)) {
      return false;
    }
    return this.isMobAiAuthorityCurrent(mobEntityId, presentation.authority);
  }

  canMobContinueIntent(mobEntityId: string, playerId: string): boolean {
    const presentation = this.mobAiPresentationAuthorityByPlayer.get(playerId);
    if (!presentation || this.hasPlayerWorldTransition(playerId)) return false;
    if (!this.registry.isActivePlayerConnection(playerId, presentation.authority.connectionId)) {
      return false;
    }
    return this.isMobAiAuthorityCurrent(mobEntityId, presentation.authority);
  }

  private noteMobAiPresentationBatch(
    playerId: string,
    state: Readonly<{
      upserts: readonly Readonly<{ entityId: string; kind: "player" | "mob" }>[];
      removedEntityIds: readonly string[];
    }>,
    replace: boolean
  ): void {
    const presentation = this.mobAiPresentationAuthorityByPlayer.get(playerId);
    if (!presentation || this.hasPlayerWorldTransition(playerId)) return;
    const mobEntityIds = replace
      ? new Set<string>()
      : new Set(presentation.mobEntityIds);
    for (const entityId of state.removedEntityIds) mobEntityIds.delete(entityId);
    for (const entity of state.upserts) {
      if (
        entity.kind === "mob" &&
        this.isMobAiAuthorityCurrent(entity.entityId, presentation.authority)
      ) mobEntityIds.add(entity.entityId);
      else mobEntityIds.delete(entity.entityId);
    }
    presentation.mobEntityIds = mobEntityIds;
  }

  private isMobAiAuthorityCurrent(
    mobEntityId: string,
    authority: WorldViewAuthority
  ): boolean {
    if (!this.isMobAiAuthorityBaseCurrent(mobEntityId, authority)) return false;
    const mob = this.combat.entity(mobEntityId)!;
    const withholding = this.withheldPopulationZonesByPlayer.get(authority.playerId);
    return !withholding?.zoneIds.has(
      populationZoneV2IdForPoint({ lat: mob.lat, lon: mob.lon })
    ) || this.isMobPresentedByExactAuthority(mobEntityId, authority);
  }

  private isMobAiAuthorityBaseCurrent(
    mobEntityId: string,
    authority: WorldViewAuthority
  ): boolean {
    const player = this.gameState.getPlayer(authority.playerId);
    const view = this.gameState.getGameplayViewCircle(authority.playerId);
    const mob = this.combat.entity(mobEntityId);
    const withholding = this.withheldPopulationZonesByPlayer.get(authority.playerId);
    if (
      !player ||
      !this.gameState.isWorldPresent(authority.playerId) ||
      !this.registry.isActivePlayerConnection(
        authority.playerId,
        authority.connectionId
      ) ||
      !view ||
      !mob ||
      mob.kind !== "mob" ||
      player.relocationRevision !== authority.relocationRevision ||
      this.gameState.getResourceVisionRevision(authority.playerId) !==
        authority.resourceVisionRevision ||
      view.generation !== authority.gameplayViewGeneration ||
      (
        withholding
          ? withholding.connectionId !== authority.connectionId
            || withholding.connectionGeneration !== authority.connectionGeneration
            || withholding.preparationGeneration !==
              authority.populationPreparationGeneration
            || withholding.relocationRevision !== authority.relocationRevision
            || withholding.resourceVisionRevision !== authority.resourceVisionRevision
            || withholding.gameplayViewGeneration !== authority.gameplayViewGeneration
          : authority.populationPreparationGeneration !== 0
      ) ||
      distanceMeters({ lat: mob.lat, lon: mob.lon }, view.center) > view.radiusM
    ) return false;
    return true;
  }

  private isMobPresentedByExactAuthority(
    mobEntityId: string,
    authority: WorldViewAuthority
  ): boolean {
    const presentation = this.mobAiPresentationAuthorityByPlayer.get(authority.playerId);
    const presentedAuthority = presentation?.authority;
    return Boolean(
      presentation?.mobEntityIds.has(mobEntityId)
      && presentedAuthority
      && presentedAuthority.connectionId === authority.connectionId
      && presentedAuthority.connectionGeneration === authority.connectionGeneration
      && presentedAuthority.relocationRevision === authority.relocationRevision
      && presentedAuthority.resourceVisionRevision === authority.resourceVisionRevision
      && presentedAuthority.gameplayViewGeneration === authority.gameplayViewGeneration
      && presentedAuthority.populationPreparationGeneration ===
        authority.populationPreparationGeneration
    );
  }

  visiblePlayerIdsFor(playerId: string): string[] {
    return this.replication.visiblePlayerIdsFor(playerId, this.interestFrameFor([playerId]));
  }

  positionVisiblePlayerIdsFor(playerId: string): string[] {
    return this.replication.positionVisiblePlayerIdsFor(
      playerId,
      this.combat.buildInterestFrame([playerId])
    );
  }

  setMutualPositionVisibilityEntryHandler(
    handler: (pairs: readonly (readonly [string, string])[]) => void
  ): void {
    this.onMutualPositionVisibilityEntries = handler;
  }

  metricsSnapshot(): WorldRuntimeMetrics {
    return { ...this.metrics };
  }

  hasPendingCommand(playerId: string): boolean {
    return this.commands.hasPendingForPlayer(playerId);
  }

  hasPendingMovementCommand(playerId: string): boolean {
    return this.commands.hasPendingMovementForPlayer(playerId);
  }

  subscribeMovementSettled(playerId: string, listener: () => void): () => void {
    const listeners = this.movementSettledListeners.get(playerId) ?? new Set<{
      listener: () => void;
      observedMovement: boolean;
      movementRevision: number;
    }>();
    const subscription = {
      listener,
      observedMovement: Boolean(
        this.gameState.getPlayer(playerId)?.target ||
        this.hasPendingMovementCommand(playerId)
      ),
      movementRevision: this.gameState.getPlayer(playerId)?.movementRevision ?? 0
    };
    listeners.add(subscription);
    this.movementSettledListeners.set(playerId, listeners);
    return () => {
      listeners.delete(subscription);
      if (listeners.size === 0) this.movementSettledListeners.delete(playerId);
    };
  }

  private publishMovementSettled(): void {
    for (const [playerId, listeners] of this.movementSettledListeners) {
      const player = this.gameState.getPlayer(playerId);
      if (!player?.online) continue;
      if (player.target || this.hasPendingMovementCommand(playerId)) {
        for (const subscription of listeners) subscription.observedMovement = true;
        continue;
      }
      for (const subscription of listeners) {
        if (
          !subscription.observedMovement &&
          subscription.movementRevision === player.movementRevision
        ) continue;
        listeners.delete(subscription);
        queueMicrotask(subscription.listener);
      }
      if (listeners.size === 0) this.movementSettledListeners.delete(playerId);
    }
  }

  beginPlayerWorldTransition(
    playerId: string,
    requestId?: string,
    metadata: Readonly<{
      connectionGeneration?: number;
      withholdPlayerReplication?: boolean;
    }> = {}
  ): symbol | null {
    if (this.playerWorldTransitions.has(playerId)) return null;
    this.mobAiPresentationAuthorityByPlayer.delete(playerId);
    this.combat.invalidateMobAiPlayer(playerId);
    this.recentCommittedTravelBindings.delete(playerId);
    const token = Symbol(`world-transition:${playerId}`);
    let resolve: () => void = () => {};
    const completed = new Promise<void>((complete) => {
      resolve = complete;
    });
    this.playerWorldTransitions.set(playerId, {
      token,
      requestId: requestId ?? null,
      connectionId: this.registry.activeConnectionIdForPlayer(playerId),
      connectionGeneration: metadata.connectionGeneration ?? null,
      withholdPlayerReplication: metadata.withholdPlayerReplication ?? true,
      startedAtMs: Date.now(),
      startingRelocationRevision:
        this.gameState.getPlayer(playerId)?.relocationRevision ?? 0,
      phase: "started",
      abortPreCommit: null,
      completed,
      resolve,
      committedRelocationRevision: null,
      bufferedMove: null
    });
    this.logger.info({
      playerId,
      requestId: requestId ?? null,
      connectionId: this.registry.activeConnectionIdForPlayer(playerId),
      connectionGeneration: metadata.connectionGeneration ?? null,
      relocationRevision:
        this.gameState.getPlayer(playerId)?.relocationRevision ?? 0,
      phase: "started",
      elapsedMs: 0
    }, "player world transition phase changed");
    return token;
  }

  endPlayerWorldTransition(
    playerId: string,
    token: symbol,
    outcome: "committed" | "failed" = "committed",
    releaseReason: string = outcome,
    forced = false
  ): boolean {
    const transition = this.playerWorldTransitions.get(playerId);
    if (transition?.token !== token) return false;
    if (outcome === "failed") transition.abortPreCommit?.();
    this.playerWorldTransitions.delete(playerId);
    transition.resolve();
    const nowMs = Date.now();
    const buffered = transition.bufferedMove;
    const bufferedAgeMs = buffered ? nowMs - buffered.receivedAtMs : 0;
    const expectedReplayRevision = outcome === "committed"
      ? transition.committedRelocationRevision
      : transition.startingRelocationRevision;
    if (
      outcome === "committed" &&
      transition.requestId &&
      transition.committedRelocationRevision !== null &&
      this.gameState.getPlayer(playerId)?.relocationRevision ===
        transition.committedRelocationRevision &&
      this.registry.activeConnectionIdForPlayer(playerId) === transition.connectionId &&
      (!buffered || bufferedAgeMs <= BOUND_TRAVEL_MOVE_TTL_MS)
    ) {
      this.recentCommittedTravelBindings.set(playerId, {
        requestId: transition.requestId,
        connectionId: transition.connectionId,
        expiresAtMs: nowMs + BOUND_TRAVEL_MOVE_TTL_MS
      });
    }
    const unexpired = Boolean(
      buffered &&
      bufferedAgeMs <= BOUND_TRAVEL_MOVE_TTL_MS &&
      this.registry.activeConnectionIdForPlayer(playerId) === transition.connectionId &&
      expectedReplayRevision !== null &&
      this.isTransitionMoveValid(buffered.command, expectedReplayRevision)
    );
    if (unexpired && buffered) {
      this.recentCommittedTravelBindings.delete(playerId);
      const replayCommand = { ...buffered.command };
      delete replayCommand.boundTravelRequestId;
      const replayed = this.enqueue(replayCommand as WorldCommandInput);
      if (replayed.accepted) {
        gameplayLatencyTrace.record(playerId, {
          traceId: transition.requestId ?? buffered.command.boundTravelRequestId,
          source: "game",
          category: "movement",
          name: "first_post_arrival_move_accepted",
          details: {
            movementRevision:
              this.gameState.getPlayer(playerId)?.movementRevision ?? 0,
            relocationRevision:
              this.gameState.getPlayer(playerId)?.relocationRevision ?? 0
          }
        });
      }
      if (!replayed.accepted) {
        this.registry.sendToConnection(buffered.command.connectionId, {
          type: "ERROR",
          requestId: buffered.command.requestId,
          code: "MOVE_REJECTED",
          message: "Post-travel movement could not be queued."
        }, "critical");
      }
      gameplayLatencyTrace.record(playerId, {
        traceId: transition.requestId ?? buffered.command.boundTravelRequestId,
        source: "game",
        category: "movement",
        name: "post_travel_movement_replayed",
        details: {
          movementBuffered: true,
          relocationRevision:
            this.gameState.getPlayer(playerId)?.relocationRevision ?? 0
        },
        failure: !replayed.accepted
      });
    } else if (buffered) {
      this.registry.sendToConnection(buffered.command.connectionId, {
        type: "ERROR",
        requestId: buffered.command.requestId,
        code: "MOVE_REJECTED",
        message: bufferedAgeMs > BOUND_TRAVEL_MOVE_TTL_MS
          ? "Movement expired before the world transition completed."
          : "Movement no longer matches the authoritative world state."
      }, "critical");
      gameplayLatencyTrace.record(playerId, {
        traceId: transition.requestId ?? buffered.command.boundTravelRequestId,
        source: "game",
        category: "movement",
        name: bufferedAgeMs > BOUND_TRAVEL_MOVE_TTL_MS
          ? "post_travel_movement_expired"
          : "post_travel_movement_discarded",
        details: {
          movementBuffered: false,
          relocationRevision:
            this.gameState.getPlayer(playerId)?.relocationRevision ?? 0
        }
      });
    }
    this.logger.info({
      playerId,
      requestId: transition.requestId,
      connectionId: transition.connectionId,
      connectionGeneration: transition.connectionGeneration,
      relocationRevision:
        this.gameState.getPlayer(playerId)?.relocationRevision ?? null,
      startingRelocationRevision: transition.startingRelocationRevision,
      committedRelocationRevision: transition.committedRelocationRevision,
      phase: transition.phase,
      releasedPhase: forced ? "forced-release" : "released",
      elapsedMs: nowMs - transition.startedAtMs,
      releaseReason,
      outcome,
      rollbackState: outcome === "failed"
        ? "abort-requested-and-settled-by-owner"
        : "not-required",
      committedRelocationRetained: outcome === "committed"
    }, "player world transition released");
    return true;
  }

  markPlayerWorldTransitionPhase(
    playerId: string,
    token: symbol,
    phase: PlayerWorldTransitionPhase
  ): boolean {
    const transition = this.playerWorldTransitions.get(playerId);
    if (transition?.token !== token) return false;
    transition.phase = phase;
    this.logger.info({
      playerId,
      requestId: transition.requestId,
      connectionId: transition.connectionId,
      connectionGeneration: transition.connectionGeneration,
      relocationRevision:
        this.gameState.getPlayer(playerId)?.relocationRevision ?? null,
      phase,
      elapsedMs: Date.now() - transition.startedAtMs
    }, "player world transition phase changed");
    return true;
  }

  registerPlayerWorldTransitionPreCommitAbort(
    playerId: string,
    token: symbol,
    abort: () => void
  ): boolean {
    const transition = this.playerWorldTransitions.get(playerId);
    if (transition?.token !== token) return false;
    transition.abortPreCommit = abort;
    return true;
  }

  discardBufferedTransitionMove(playerId: string): void {
    this.recentCommittedTravelBindings.delete(playerId);
    const transition = this.playerWorldTransitions.get(playerId);
    if (transition) transition.bufferedMove = null;
  }

  hasPlayerWorldTransition(playerId: string): boolean {
    return this.playerWorldTransitions.has(playerId);
  }

  withholdsPlayerReplication(playerId: string): boolean {
    return this.playerWorldTransitions.get(playerId)
      ?.withholdPlayerReplication ?? false;
  }

  beginPopulationPreparation(
    playerId: string,
    relocationRevision: number,
    requestId?: string
  ): void {
    this.populationPreparationByPlayer.set(playerId, {
      relocationRevision,
      requestId: requestId ?? null
    });
  }

  endPopulationPreparation(playerId: string, relocationRevision: number): void {
    if (
      this.populationPreparationByPlayer.get(playerId)?.relocationRevision ===
      relocationRevision
    ) {
      this.populationPreparationByPlayer.delete(playerId);
    }
  }

  commitPlayerWorldTransition(
    playerId: string,
    token: symbol,
    relocationRevision: number
  ): boolean {
    const transition = this.playerWorldTransitions.get(playerId);
    if (
      transition?.token !== token
      || !Number.isSafeInteger(relocationRevision)
      || relocationRevision < 0
    ) return false;
    transition.committedRelocationRevision = relocationRevision;
    transition.phase = "committed";
    transition.abortPreCommit = null;
    return true;
  }

  playerWorldTransitionState(playerId: string): Readonly<{
    token: symbol;
    requestId: string | null;
    connectionId: string | null;
    connectionGeneration: number | null;
    startedAtMs: number;
    phase: PlayerWorldTransitionPhase;
    startingRelocationRevision: number;
    committedRelocationRevision: number | null;
  }> | null {
    const transition = this.playerWorldTransitions.get(playerId);
    return transition ? {
      token: transition.token,
      requestId: transition.requestId,
      connectionId: transition.connectionId,
      connectionGeneration: transition.connectionGeneration,
      startedAtMs: transition.startedAtMs,
      phase: transition.phase,
      startingRelocationRevision: transition.startingRelocationRevision,
      committedRelocationRevision: transition.committedRelocationRevision
    } : null;
  }

  forceReleasePlayerWorldTransition(
    playerId: string,
    connectionId: string | null,
    reason: string
  ): boolean {
    const transition = this.playerWorldTransitions.get(playerId);
    if (!transition || transition.connectionId !== connectionId) return false;
    return this.endPlayerWorldTransition(
      playerId,
      transition.token,
      transition.committedRelocationRevision === null ? "failed" : "committed",
      reason,
      true
    );
  }

  forceReleaseAllPlayerWorldTransitions(reason: string): number {
    let released = 0;
    for (const [playerId, transition] of [...this.playerWorldTransitions]) {
      if (this.endPlayerWorldTransition(
        playerId,
        transition.token,
        transition.committedRelocationRevision === null ? "failed" : "committed",
        reason,
        true
      )) released += 1;
    }
    return released;
  }

  bufferedTransitionMoveRequestId(playerId: string): string | null {
    return this.playerWorldTransitions.get(playerId)?.bufferedMove?.command.requestId ?? null;
  }

  async waitForPlayerWorldTransition(
    playerId: string,
    options: Readonly<{
      timeoutMs?: number;
      signal?: AbortSignal;
    }> = {}
  ): Promise<boolean> {
    const timeoutMs = Math.max(
      0,
      options.timeoutMs ?? DEFAULT_WORLD_TRANSITION_WAIT_TIMEOUT_MS
    );
    const deadlineMs = Date.now() + timeoutMs;
    while (this.playerWorldTransitions.has(playerId)) {
      if (options.signal?.aborted) return false;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) return false;
      const completed = this.playerWorldTransitions.get(playerId)!.completed;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const released = await Promise.race([
        completed.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), remainingMs);
          timer.unref?.();
        })
      ]);
      if (timer) clearTimeout(timer);
      if (!released) return false;
    }
    return true;
  }

  /**
   * Removes runtime authority synchronously after the exact socket generation has been removed
   * from the registry. Lifecycle cleanup never enters the bounded gameplay command queue.
   * Repeating the call is harmless; a newer active connection fences an older close event.
   */
  revokeConnectionAuthority(playerId: string, connectionId: string): AuthorityRevocationResult {
    this.forceReleasePlayerWorldTransition(
      playerId,
      connectionId,
      "connection-stale-or-closed"
    );
    const activeConnectionId = this.registry.activeConnectionIdForPlayer(playerId);
    if (activeConnectionId !== null) {
      this.logger.info(
        { playerId, connectionId, activeConnectionId },
        "ignored stale connection authority revocation"
      );
      return "stale-connection";
    }
    this.discardBufferedTransitionMove(playerId);
    this.combat.disconnectPlayer(playerId);
    this.replication.removePlayer(playerId);
    this.relocationCommandSequenceByPlayer.delete(playerId);
    this.lastAuthorityResyncAtByPlayer.delete(playerId);
    this.withheldPopulationZonesByPlayer.delete(playerId);
    this.mobAiPresentationAuthorityByPlayer.delete(playerId);
    const manorSession = this.manorRuntime?.get(playerId);
    if (manorSession) {
      void this.manorRuntime?.disconnect(playerId, manorSession.sessionId);
    }
    this.gameState.setWorldPresence(playerId, false);
    this.gameState.markOffline(playerId);
    return "revoked";
  }

  suspendConnectionAuthority(playerId: string, connectionId: string): AuthorityRevocationResult {
    this.forceReleasePlayerWorldTransition(playerId, connectionId, "connection-suspended");
    if (this.registry.activeConnectionIdForPlayer(playerId) !== null) {
      return "stale-connection";
    }
    this.discardBufferedTransitionMove(playerId);
    this.gameState.stopPlayer(playerId);
    this.manorRuntime?.stop(playerId);
    this.combat.suspendPlayerAuthority(playerId);
    return "revoked";
  }

  endLinkDeadWorldPresence(playerId: string): void {
    if (this.registry.activeConnectionIdForPlayer(playerId) !== null) return;
    this.replication.removePlayer(playerId);
    this.combat.endLinkDeadWorldPresence(playerId);
    this.mobAiPresentationAuthorityByPlayer.delete(playerId);
    this.gameState.setWorldPresence(playerId, false);
  }

  diagnosticsSnapshot() {
    return {
      runtime: this.metricsSnapshot(),
      commands: this.commands.metricsSnapshot(),
      combat: this.combat.metricsSnapshot(),
      replication: this.replication.metricsSnapshot(),
      network: this.registry.metricsSnapshot(),
      worldTransitions: [...this.playerWorldTransitions].map(([playerId, transition]) => ({
        playerId,
        requestId: transition.requestId,
        connectionId: transition.connectionId,
        connectionGeneration: transition.connectionGeneration,
        relocationRevision:
          this.gameState.getPlayer(playerId)?.relocationRevision ?? null,
        phase: transition.phase,
        elapsedMs: Date.now() - transition.startedAtMs
      }))
    };
  }

  private isTransitionMoveValid(
    command: WorldCommandInput & { kind: "move" },
    expectedRelocationRevision: number
  ): boolean {
    const player = this.gameState.getPlayer(command.playerId);
    return Boolean(
      player &&
      player.online &&
      player.relocationRevision === expectedRelocationRevision &&
      isFiniteLatLon(command.target.lat, command.target.lon) &&
      distanceMeters(player.anchor, command.target) <= player.moveLeashRadiusM
    );
  }

  private processCommand(command: WorldCommand, commandSequence: number): "processed" | "rejected" | "stale" {
    if (this.combat.serverTick - command.acceptedTick > this.config.SERVER_TICK_HZ * 2) {
      this.sendError(command, "COMMAND_STALE", "World command expired before processing");
      return "stale";
    }
    if (command.kind === "disconnect-player") {
      return this.revokeConnectionAuthority(command.playerId, command.connectionId) === "revoked"
        ? "processed"
        : "stale";
    }
    if (!this.hasAuthority(command)) {
      this.sendError(command, "COMMAND_AUTHORITY_STALE", "Gameplay connection is no longer authoritative");
      return "stale";
    }
    const currentRelocationRevision =
      this.gameState.getPlayer(command.playerId)?.relocationRevision ?? 0;
    if (
      command.kind === "move" &&
      command.acceptedRelocationRevision !== undefined &&
      command.acceptedRelocationRevision !== currentRelocationRevision &&
      commandSequence <= (this.relocationCommandSequenceByPlayer.get(command.playerId) ?? Number.POSITIVE_INFINITY)
    ) {
      this.sendError(command, "MOVE_EPOCH_STALE", "Movement command belongs to an earlier location");
      return "stale";
    }

    if (
      "targetEntityId" in command &&
      typeof command.targetEntityId === "string" &&
      this.isWithheldPopulationMob(command.playerId, command.targetEntityId)
    ) {
      this.sendError(
        command,
        "COMBAT_TARGET_NO_LONGER_AVAILABLE",
        "That creature is unavailable while its population zone recovers.",
        {
          retryable: true,
          targetEntityId: command.targetEntityId,
          relocationRevision: currentRelocationRevision,
          gameplayViewGeneration:
            this.gameState.getGameplayViewCircle(command.playerId)?.generation ?? 0,
          combatValidationPredicate: "population-zone-withheld"
        }
      );
      return "rejected";
    }
    if (
      command.kind === "universal-taunt" &&
      (this.withheldPopulationZonesByPlayer.get(command.playerId)?.zoneIds.size
        ?? 0) > 0
    ) {
      this.sendError(
        command,
        "WORLD_AUTHORITY_PREPARING",
        "Taunt is unavailable while nearby population recovers.",
        {
          retryable: true,
          relocationRevision: currentRelocationRevision,
          gameplayViewGeneration:
            this.gameState.getGameplayViewCircle(command.playerId)?.generation ?? 0
        }
      );
      return "rejected";
    }

    try {
      switch (command.kind) {
        case "move": {
          if (!this.combat.isPlayerAlive(command.playerId)) {
            this.sendError(command, "MOVE_REJECTED", "Movement is unavailable while incapacitated");
            return "rejected";
          }
          this.combat.cancelPlayerAttackApproach(command.playerId);
          const player = this.gameState.setTarget(
            command.playerId,
            command.target,
            command.waterLeg
          );
          const waterLeg = this.gameState.currentWaterLeg(command.playerId);
          // The same multiplier the tick applies, so the client predicts at the server's walking speed.
          this.gameState.noteMovementMultiplier(command.playerId, this.combat.playerMovementMultiplier(command.playerId));
          const speedMps = this.gameState.effectiveSpeedMps(command.playerId);
          this.send(command, {
            type: "MOVE_ACCEPTED",
            requestId: command.requestId,
            movementRevision: player.movementRevision,
            ...(speedMps !== undefined ? { speedMps } : {}),
            // Mid-dash the move is queued: report where the player heads after landing.
            target: this.gameState.pendingTargetAfterDash(command.playerId) ?? player.target ?? command.target,
            ...(waterLeg ? waterLegSpeedProfile(waterLeg) : {}),
            ...(command.shore ? { shore: command.shore } : {})
          });
          return "processed";
        }
        case "dash": {
          if (!this.combat.isPlayerAlive(command.playerId)) {
            this.sendError(command, "DASH_REJECTED", "You can't dash while incapacitated.");
            return "rejected";
          }
          const before = this.gameState.getPlayer(command.playerId);
          const beforePosition = before ? { ...before.position } : null;
          const beforeTarget = before?.target ? { ...before.target } : null;
          const end = this.gameState.planDash(
            command.playerId, command.dirX, command.dirY, undefined, command.maxDistanceM
          );
          this.combat.cancelPlayerAttackApproach(command.playerId);
          this.combat.notePlayerDashed(command.playerId);
          const { player, dash } = this.gameState.startDash(command.playerId, command.requestId, end);
          this.send(command, {
            type: "DASH_ACCEPTED",
            requestId: command.requestId,
            movementRevision: player.movementRevision,
            from: { ...dash.from },
            to: { ...dash.to },
            startedAt: dash.startedAtMs,
            until: dash.untilMs,
            cooldownUntil: dash.cooldownUntilMs,
            iframeUntil: dash.iframeUntilMs
          });
          const distanceM = distanceMeters(dash.from, dash.to);
          this.logger.debug({
            event: "dash_accepted",
            playerId: command.playerId,
            requestId: command.requestId,
            dirX: command.dirX,
            dirY: command.dirY,
            before: beforePosition,
            beforeTarget,
            plannedEnd: dash.to,
            distanceM: Math.round(distanceM * 100) / 100,
            clampReductionM: Math.round(Math.max(0, DASH_DISTANCE_M - distanceM) * 100) / 100,
            maxDistanceM: command.maxDistanceM ?? null
          }, "dash accepted");
          gameplayLatencyTrace.record(command.playerId, {
            traceId: command.requestId,
            source: "game",
            category: "movement",
            name: "dash_accepted",
            details: {
              requestId: command.requestId,
              serverQueueMs: performance.now() - command.receivedAtMs,
              distanceM,
              clampedM: Math.max(0, DASH_DISTANCE_M - distanceM),
              movementRevision: player.movementRevision
            }
          });
          return "processed";
        }
        case "swing": {
          // Commands run before beginTick, so an immediate swing is stamped with the previous tick;
          // its DAMAGE/SWING events still ship this tick (performSwing raises takeImmediateFlush).
          const result = this.combat.resolveSwing(command.playerId, {
            seq: command.seq,
            dirX: command.dirX,
            dirY: command.dirY,
            lagMs: command.lagMs,
            requestId: command.requestId,
            connectionId: command.connectionId
          });
          if (result.buffered) {
            // Dash in flight or pressed just early: the engine calls onSwingResolved once, later.
            this.rememberDeferredSwing(command.playerId, command.requestId, {
              connectionId: command.connectionId,
              receivedAtMs: command.receivedAtMs
            });
            return "processed";
          }
          this.sendToConnection(command.connectionId, swingResultMessage(result));
          this.logSwingOutcome(command.playerId, result, command.lagMs, performance.now() - command.receivedAtMs);
          return result.rejected ? "rejected" : "processed";
        }
        case "start-attack": {
          this.combat.startAttack({
            attackerId: command.playerId,
            targetEntityId: command.targetEntityId,
            requestId: command.requestId,
            accountId: command.accountId,
            connectionId: command.connectionId
          });
          this.send(command, {
            type: "COMBAT_STARTED",
            requestId: command.requestId,
            attackerEntityId: command.playerId,
            targetEntityId: command.targetEntityId
          });
          return "processed";
        }
        case "cancel-attack": {
          this.combat.cancelAttack(command.playerId);
          this.send(command, {
            type: "COMBAT_CANCELLED",
            requestId: command.requestId,
            entityId: command.playerId
          });
          return "processed";
        }
        case "lifecycle-cancel": {
          this.combat.cancelCombat(command.playerId);
          this.gameState.stopPlayer(command.playerId);
          return "processed";
        }
        case "normal-ability": {
          if (command.abilityId === MERCHANT_MAXIMIZE_TACTICS_ABILITY_ID) {
            if (!this.merchantTactics) {
              this.sendError(command, "ABILITY_NOT_AVAILABLE", "Maximize Tactics is unavailable right now");
              return "rejected";
            }
            void this.merchantTactics.use({
              playerId: command.playerId,
              accountId: command.accountId,
              connectionId: command.connectionId,
              requestId: command.requestId
            }).then((result) => {
              this.send(command, {
                type: "PLAYER_RESOURCES_UPDATED",
                playerId: command.playerId,
                inventory: result.inventory,
                walletGold: result.walletGold,
                walletVersion: result.walletVersion,
                serverTime: Date.now()
              });
            }).catch((error: unknown) => {
              this.sendError(command,
                error instanceof CombatRequestError ? error.code : "ABILITY_FAILED",
                error instanceof Error ? error.message : "Maximize Tactics failed");
            });
            return "processed";
          }
          if (command.abilityId === "v3_druid_replenish") {
            if (!command.targetEntityId || !this.druidReplenish) {
              this.sendError(command, "ABILITY_TARGET_REQUIRED", "Replenish requires a player target");
              return "rejected";
            }
            if (command.targetMode !== undefined && command.targetMode !== "friendly") {
              this.sendError(command, "ABILITY_TARGET_MODE_INVALID", "Replenish requires a friendly target");
              return "rejected";
            }
            const targetPlayerId = command.targetEntityId;
            let eligibleNow = false;
            try {
              if (!this.gameState.isWorldPresent(command.playerId) ||
                  !this.gameState.isWorldPresent(targetPlayerId)) throw new Error("different location");
              this.combat.validateReplenishCandidate({
                playerId: command.playerId, targetPlayerId,
                accountId: command.accountId, connectionId: command.connectionId
              });
              eligibleNow = true;
            } catch {
              // The service checks the durable receipt first, so a valid replay can
              // succeed even when the target has since moved or recovered.
            }
            this.pendingReplenishPlayers.add(command.playerId);
            if (eligibleNow) this.pendingReplenishPlayers.add(targetPlayerId);
            void this.druidReplenish.use({
              playerId: command.playerId,
              targetPlayerId,
              accountId: command.accountId,
              connectionId: command.connectionId,
              requestId: command.requestId
            }, () => { this.pendingReplenishPlayers.add(targetPlayerId); }).then((result) => {
              this.send(command, {
                type: "PLAYER_RESOURCES_UPDATED",
                playerId: command.playerId,
                inventory: result.inventory,
                serverTime: Date.now()
              });
              let state;
              try { state = this.combat.replenishActionState(command.playerId); }
              catch { return; }
              this.send(command, {
                type: "ABILITY_QUEUE_UPDATED",
                requestId: command.requestId,
                ...state
              });
            }).catch((error: unknown) => {
              this.sendError(command,
                error instanceof CombatRequestError ? error.code : "ABILITY_FAILED",
                error instanceof Error ? error.message : "Replenish failed");
            }).finally(() => {
              this.pendingReplenishPlayers.delete(command.playerId);
              this.pendingReplenishPlayers.delete(targetPlayerId);
            });
            return "processed";
          }
          const state = this.combat.useNormalAbility({
            playerId: command.playerId,
            abilityId: command.abilityId,
            accountId: command.accountId,
            connectionId: command.connectionId,
            ...(command.targetEntityId === undefined ? {} : { targetEntityId: command.targetEntityId }),
            ...(command.targetMode === undefined ? {} : { targetMode: command.targetMode }),
            ...(command.targetPosition === undefined ? {} : { targetPosition: command.targetPosition })
          });
          this.send(command, {
            type: "ABILITY_QUEUE_UPDATED",
            requestId: command.requestId,
            ...state
          });
          return "processed";
        }
        case "general-active": {
          const state = command.skillId === "edict_stride"
            ? this.combat.useEdictStride({
              playerId: command.playerId,
              accountId: command.accountId,
              connectionId: command.connectionId,
              rank: command.worldKnowledgeRank ?? 0,
              ...(command.targetEntityId === undefined ? {} : { targetEntityId: command.targetEntityId }),
              ...(command.targetMode === undefined ? {} : { targetMode: command.targetMode })
            })
            : this.combat.useGeneralActive({
            playerId: command.playerId,
            skillId: command.skillId,
            accountId: command.accountId,
            connectionId: command.connectionId,
            ...(command.targetEntityId === undefined ? {} : { targetEntityId: command.targetEntityId }),
            ...(command.targetMode === undefined ? {} : { targetMode: command.targetMode }),
            ...(command.targetPosition === undefined ? {} : { targetPosition: command.targetPosition }),
            ...(command.directionDegrees === undefined ? {} : { directionDegrees: command.directionDegrees })
          });
          if (command.skillId === "edict_stride") command.onEdictStrideAccepted?.();
          this.send(command, {
            type: "ABILITY_QUEUE_UPDATED",
            requestId: command.requestId,
            ...state
          });
          return "processed";
        }
        case "ultimate-ability": {
          const state = this.combat.useUltimateAbility({
            playerId: command.playerId,
            abilityId: command.abilityId,
            accountId: command.accountId,
            connectionId: command.connectionId,
            ...(command.targetEntityId === undefined ? {} : { targetEntityId: command.targetEntityId }),
            ...(command.targetMode === undefined ? {} : { targetMode: command.targetMode }),
            ...(command.targetPosition === undefined ? {} : { targetPosition: command.targetPosition })
          });
          this.send(command, {
            type: "ABILITY_QUEUE_UPDATED",
            requestId: command.requestId,
            ...state
          });
          return "processed";
        }
        case "reset-ability": {
          const state = this.combat.useResetAbility({
            playerId: command.playerId,
            abilityId: command.abilityId,
            accountId: command.accountId,
            connectionId: command.connectionId,
            ...(command.targetEntityId === undefined ? {} : { targetEntityId: command.targetEntityId }),
            ...(command.targetMode === undefined ? {} : { targetMode: command.targetMode })
          });
          this.send(command, {
            type: "ABILITY_QUEUE_UPDATED",
            requestId: command.requestId,
            ...state
          });
          return "processed";
        }
        case "universal-taunt": {
          const state = this.combat.useUniversalTaunt({
            playerId: command.playerId,
            accountId: command.accountId,
            connectionId: command.connectionId,
            viewGeneration: command.acceptedViewGeneration
          });
          this.send(command, {
            type: "ABILITY_QUEUE_UPDATED",
            requestId: command.requestId,
            ...state
          });
          return "processed";
        }
        case "dev-spawn-mob": {
          if (!this.config.DEV_TOOLS_ENABLED) {
            this.sendError(command, "DEV_TOOLS_DISABLED", "Developer tools are disabled");
            return "rejected";
          }
          const player = this.gameState.getPlayer(command.playerId);
          if (!player) {
            throw new CombatRequestError("COMBAT_PLAYER_NOT_FOUND", "Player is not connected");
          }
          if (distanceMeters(player.position, command.position) > this.config.DEV_MOB_MAX_SPAWN_DISTANCE_M) {
            this.sendError(
              command,
              "DEV_MOB_SPAWN_TOO_FAR",
              `Mob spawn must be within ${this.config.DEV_MOB_MAX_SPAWN_DISTANCE_M}m`
            );
            return "rejected";
          }
          const mob = this.combat.spawnMob({
            archetype: command.archetype,
            ...(command.appearanceVariant ? { appearanceVariant: command.appearanceVariant } : {}),
            worldAi: true,
            position: command.position,
            regionCode: player.regionCode,
            zoneId: zoneIdForPosition(player.position),
            originFlagId: this.gameState.currentFlagId(command.playerId)
          });
          this.send(command, {
            type: "DEV_MOB_SPAWNED",
            requestId: command.requestId,
            mobEntityId: mob.entityId,
            archetype: command.archetype,
            appearanceVariant: mob.appearanceVariant ?? "normal"
          });
          return "processed";
        }
        case "dev-clear-mobs": {
          if (!this.config.DEV_TOOLS_ENABLED) {
            this.sendError(command, "DEV_TOOLS_DISABLED", "Developer tools are disabled");
            return "rejected";
          }
          const removedCount = this.combat.clearMobs();
          this.send(command, {
            type: "DEV_MOBS_CLEARED",
            requestId: command.requestId,
            removedCount
          });
          this.logger.warn({ playerId: command.playerId, removedCount }, "development mobs cleared");
          return "processed";
        }
        case "dev-teleport": {
          if (!this.config.DEV_TOOLS_ENABLED) {
            this.sendError(command, "DEV_TOOLS_DISABLED", "Developer tools are disabled");
            return "rejected";
          }
          this.combat.cancelCombat(command.playerId);
          this.gameState.applyAuthoritativeRelocation({
            playerId: command.playerId,
            anchor: command.destination,
            resourceVision: command.resourceVision ?? null
          });
          this.relocationCommandSequenceByPlayer.set(command.playerId, commandSequence);
          return "processed";
        }
      }
    } catch (error) {
      if (
        command.kind === "start-attack" &&
        error instanceof CombatRequestError
      ) {
        this.logger.info({
          attackerId: command.playerId,
          targetEntityId: command.targetEntityId,
          attackerZoneId: error.details.attackerZoneId,
          targetZoneId: error.details.targetZoneId,
          attackerRegionCode: error.details.attackerRegionCode,
          targetRegionCode: error.details.targetRegionCode,
          gameplayViewGeneration:
            error.details.gameplayViewGeneration ??
            this.gameState.getGameplayViewCircle(command.playerId)
              ?.generation ??
            0,
          attackerInsideAuthoritativeView:
            error.details.attackerInsideAuthoritativeView,
          targetInsideAuthoritativeView:
            error.details.targetInsideAuthoritativeView,
          failedValidationPredicate:
            error.details.combatValidationPredicate,
          code: error.code
        }, "combat attack request rejected");
      }
      if (
        command.kind === "start-attack"
        && error instanceof CombatRequestError
        && (
          error.code === "COMBAT_TARGET_NOT_FOUND" ||
          error.code === "COMBAT_TARGET_OUTSIDE_AUTHORITY"
        )
      ) {
        const preparation = this.populationPreparationByPlayer.get(command.playerId);
        if (preparation) {
          this.sendError(
            command,
            "WORLD_AUTHORITY_PREPARING",
            "Combat authority is still preparing this target.",
            {
              retryable: true,
              targetEntityId: command.targetEntityId,
              relocationRevision: preparation.relocationRevision,
              gameplayViewGeneration:
                this.gameState.getGameplayViewCircle(command.playerId)?.generation ?? 0,
              ...error.details
            }
          );
        } else {
          this.sendError(
            command,
            "COMBAT_TARGET_NO_LONGER_AVAILABLE",
            "That target is no longer available.",
            {
              targetEntityId: command.targetEntityId,
              relocationRevision:
                this.gameState.getPlayer(command.playerId)?.relocationRevision ?? 0,
              gameplayViewGeneration:
                this.gameState.getGameplayViewCircle(command.playerId)?.generation ?? 0,
              ...error.details
            }
          );
          this.requestAuthorityResync(command.playerId);
        }
        return "rejected";
      }
      this.sendError(
        command,
        error instanceof CombatRequestError ? error.code : command.kind === "move" ? "MOVE_REJECTED"
          : command.kind === "dash" ? "DASH_REJECTED" : "COMMAND_REJECTED",
        error instanceof Error ? error.message : "World command rejected"
      );
      return "rejected";
    }
  }

  private flushReplication(worldDue: boolean, combatDue: boolean): void {
    const playerIds = this.registry.activePlayerIds();
    const positionInterest = this.combat.buildInterestFrame(playerIds);
    const interest = positionInterest;
    if (worldDue) this.observeMutualPositionVisibility(playerIds, positionInterest);
    const combatFrame = combatDue ? this.combat.beginDeltaFlush() : null;
    for (const playerId of playerIds) {
      const isWorldPresent = this.gameState.isWorldPresent(playerId);
      const withholdPlayerReplication =
        this.withholdsPlayerReplication(playerId);
      if (
        !withholdPlayerReplication &&
        isWorldPresent &&
        worldDue &&
        this.replication.needsSnapshot(playerId)
      ) {
        const players = this.replication.snapshotForPlayer(playerId, interest);
        const result = this.registry.send(
          playerId,
          { type: "PLAYER_SNAPSHOT", serverTime: Date.now(), sequence: 0, players },
          "replaceable"
        );
        if (result !== "sent") {
          this.replication.requestResync(playerId);
        }
      } else if (!withholdPlayerReplication && isWorldPresent && worldDue) {
        const delta = this.replication.deltaForPlayer(playerId, interest);
        if (delta) {
          const result = this.registry.send(playerId, { type: "PLAYER_DELTA", ...delta }, "replaceable");
          if (result === "sent") {
            this.metrics.worldDeltasSent += 1;
          } else {
            this.replication.requestResync(playerId);
          }
        }
      }

      if (!combatFrame) {
        continue;
      }
      const needsSnapshot = this.combat.needsSnapshot(playerId);
      const combatInterest = this.filterWithheldPopulationCombatForPlayer(
        playerId,
        interest
      );
      const state = needsSnapshot
        ? this.combat.snapshotForPlayer(playerId, combatInterest)
        : this.combat.deltaForPlayerWithInterest(
            playerId,
            combatFrame,
            combatInterest
          );
      if (state) {
        const result = this.registry.send(
          playerId,
          { type: needsSnapshot ? "COMBAT_SNAPSHOT" : "COMBAT_DELTA", state } as ServerMessage,
          "replaceable"
        );
        if (result === "sent") {
          this.metrics.combatDeltasSent += needsSnapshot ? 0 : 1;
          this.noteMobAiPresentationBatch(playerId, state, needsSnapshot);
        } else {
          this.combat.requestResync(playerId);
        }
      }
    }
    if (combatFrame) this.partyCombatPublisher?.flush();
  }

  private filterWithheldPopulationCombat(
    interest: CombatInterestFrame
  ): CombatInterestFrame {
    const nearbyIdsByPlayer = new Map<string, ReadonlySet<string>>();
    for (const playerId of interest.nearbyIdsByPlayer.keys()) {
      nearbyIdsByPlayer.set(
        playerId,
        this.filteredCombatIdsForPlayer(playerId, interest)
      );
    }
    return { ...interest, nearbyIdsByPlayer };
  }

  private filterWithheldPopulationCombatForPlayer(
    playerId: string,
    interest: CombatInterestFrame
  ): CombatInterestFrame {
    return {
      ...interest,
      nearbyIdsByPlayer: new Map([
        [playerId, this.filteredCombatIdsForPlayer(playerId, interest)]
      ])
    };
  }

  private filteredCombatIdsForPlayer(
    playerId: string,
    interest: CombatInterestFrame
  ): ReadonlySet<string> {
    const nearbyIds = interest.nearbyIdsByPlayer.get(playerId) ?? new Set();
    const withheld = this.withheldPopulationZonesByPlayer.get(playerId)?.zoneIds;
    if (!withheld || withheld.size === 0) return nearbyIds;
    return new Set([...nearbyIds].filter((entityId) => {
      const entity = this.combat.entity(entityId);
      return entity?.kind !== "mob" ||
        !this.combat.isPopulationManagedMob(entityId) ||
        !withheld.has(
        populationZoneV2IdForPoint({ lat: entity.lat, lon: entity.lon })
      ) || this.isRetainedPresentedPopulationMob(playerId, entityId);
    }));
  }

  private isWithheldPopulationMob(
    playerId: string,
    entityId: string
  ): boolean {
    const withheld = this.withheldPopulationZonesByPlayer.get(playerId)?.zoneIds;
    if (!withheld || withheld.size === 0) return false;
    const entity = this.combat.entity(entityId);
    return entity?.kind === "mob" &&
      this.combat.isPopulationManagedMob(entityId) &&
      withheld.has(
      populationZoneV2IdForPoint({ lat: entity.lat, lon: entity.lon })
    ) && !this.isRetainedPresentedPopulationMob(playerId, entityId);
  }

  private isRetainedPresentedPopulationMob(
    playerId: string,
    entityId: string
  ): boolean {
    const presentation = this.mobAiPresentationAuthorityByPlayer.get(playerId);
    return Boolean(
      presentation?.mobEntityIds.has(entityId)
      && this.isMobAiAuthorityBaseCurrent(entityId, presentation.authority)
    );
  }

  private observeMutualPositionVisibility(
    playerIds: readonly string[],
    positionInterest: CombatInterestFrame
  ): void {
    const visibleByPlayer = new Map<string, Set<string>>();
    for (const playerId of playerIds) {
      if (this.hasPlayerWorldTransition(playerId)) continue;
      visibleByPlayer.set(
        playerId,
        new Set(this.replication.positionVisiblePlayerIdsFor(playerId, positionInterest))
      );
    }
    const nextPairs = new Set<string>();
    const entries: Array<readonly [string, string]> = [];
    for (const leftPlayerId of [...visibleByPlayer.keys()].sort()) {
      for (const rightPlayerId of visibleByPlayer.get(leftPlayerId) ?? []) {
        if (leftPlayerId >= rightPlayerId) continue;
        if (!visibleByPlayer.get(rightPlayerId)?.has(leftPlayerId)) continue;
        const key = `${leftPlayerId}\u001f${rightPlayerId}`;
        nextPairs.add(key);
        if (!this.mutualPositionVisiblePairs.has(key)) {
          entries.push([leftPlayerId, rightPlayerId]);
        }
      }
    }
    this.mutualPositionVisiblePairs = nextPairs;
    if (entries.length > 0) this.onMutualPositionVisibilityEntries?.(entries);
  }

  private hasAuthority(command: WorldCommand): boolean {
    return (
      this.registry.isActiveConnection(command.accountId, command.connectionId) &&
      this.registry.isActivePlayerConnection(command.playerId, command.connectionId)
    );
  }

  private send(command: WorldCommand, message: ServerMessage): WorldSendResult {
    return this.registry.sendToConnection(command.connectionId, message, "critical");
  }

  private sendToConnection(connectionId: string, message: ServerMessage): WorldSendResult {
    return this.registry.sendToConnection(connectionId, message, "critical");
  }

  /**
   * CombatEngine `onSwingResolved`: the deferred result of a swing `resolveSwing` buffered. It goes
   * only to the connection the swing was pressed on; after a reconnect it is dropped silently.
   */
  deliverBufferedSwingResult(playerId: string, result: SwingResolution): void {
    const pending = this.bufferedSwingConnections.get(playerId);
    const origin = pending?.get(result.requestId ?? "");
    pending?.delete(result.requestId ?? "");
    if (pending?.size === 0) this.bufferedSwingConnections.delete(playerId);
    const connectionId = origin?.connectionId ?? this.registry.activeConnectionIdForPlayer(playerId);
    if (!connectionId || !this.registry.isActivePlayerConnection(playerId, connectionId)) {
      this.logger.debug({ event: "swing_buffered_dropped", playerId, seq: result.seq }, "buffered swing dropped");
      return;
    }
    this.sendToConnection(connectionId, swingResultMessage(result));
    this.logSwingOutcome(
      playerId,
      result,
      null,
      origin ? performance.now() - origin.receivedAtMs : null,
      true
    );
  }

  /** Records a deferred swing's connection; entries older than DEFERRED_SWING_ENTRY_MAX_AGE_MS (never answered) are dropped. */
  private rememberDeferredSwing(
    playerId: string,
    requestId: string,
    origin: { connectionId: string; receivedAtMs: number }
  ): void {
    let pending = this.bufferedSwingConnections.get(playerId);
    if (!pending) {
      pending = new Map();
      this.bufferedSwingConnections.set(playerId, pending);
    }
    for (const [id, entry] of pending) {
      if (origin.receivedAtMs - entry.receivedAtMs > DEFERRED_SWING_ENTRY_MAX_AGE_MS) pending.delete(id);
    }
    pending.set(requestId, origin);
  }

  private logSwingOutcome(
    playerId: string,
    result: SwingResolution,
    lagMs: number | null,
    queueMs: number | null,
    buffered = false
  ): void {
    const roundedQueueMs = queueMs === null ? null : Math.round(queueMs * 10) / 10;
    // The server logger runs at info, so SWING_DEBUG_LOG lifts these diagnostics to info to make them visible.
    const swingLog = this.config.SWING_DEBUG_LOG
      ? this.logger.info.bind(this.logger)
      : this.logger.debug.bind(this.logger);
    if (result.rejected) {
      swingLog({
        event: "swing_rejected",
        playerId,
        seq: result.seq,
        reason: result.rejected,
        buffered,
        queueMs: roundedQueueMs
      }, "swing rejected");
    } else if (this.config.SWING_DEBUG_LOG) {
      const tickMs = 1_000 / this.config.SERVER_TICK_HZ;
      swingLog({
        event: "swing_resolved",
        playerId,
        seq: result.seq,
        combo: result.comboIndex,
        hits: result.hits.length,
        // Same clamp as the engine; a buffered swing's lag hint is not kept here.
        rewindTicks: lagMs === null ? null : Math.round(Math.min(Math.max(0, lagMs), SWING_LAG_COMP_MAX_MS) / tickMs),
        queueMs: roundedQueueMs,
        buffered
      }, "swing resolved");
    }
    gameplayLatencyTrace.record(playerId, {
      ...(result.requestId ? { traceId: result.requestId } : {}),
      source: "game",
      category: "world",
      name: result.rejected ? "swing_rejected" : "swing_resolved",
      details: {
        requestId: result.requestId,
        seq: result.seq,
        serverQueueMs: queueMs,
        combo: result.comboIndex,
        hits: result.hits.length,
        buffered,
        ...(result.rejected ? { reason: result.rejected } : {})
      },
      ...(result.rejected ? { failure: true } : {})
    });
  }

  private sendError(
    command: WorldCommand,
    code: string,
    message: string,
    details?: Readonly<{
      retryable?: boolean;
      targetEntityId?: string;
      relocationRevision?: number;
      gameplayViewGeneration?: number;
      combatValidationPredicate?: string;
      attackerZoneId?: string;
      targetZoneId?: string;
      attackerRegionCode?: string;
      targetRegionCode?: string;
      attackerInsideAuthoritativeView?: boolean;
      targetInsideAuthoritativeView?: boolean;
    }>
  ): void {
    this.send(command, {
      type: "ERROR",
      requestId: command.requestId,
      code,
      message,
      ...(details?.retryable === undefined ? {} : { retryable: details.retryable }),
      ...(!details ? {} : {
        details: {
          ...(details.targetEntityId === undefined
            ? {}
            : { targetEntityId: details.targetEntityId }),
          ...(details.relocationRevision === undefined
            ? {}
            : { relocationRevision: details.relocationRevision }),
          ...(details.gameplayViewGeneration === undefined
            ? {}
            : { gameplayViewGeneration: details.gameplayViewGeneration }),
          ...(details.combatValidationPredicate === undefined
            ? {}
            : {
                combatValidationPredicate:
                  details.combatValidationPredicate
              }),
          ...(details.attackerZoneId === undefined
            ? {}
            : { attackerZoneId: details.attackerZoneId }),
          ...(details.targetZoneId === undefined
            ? {}
            : { targetZoneId: details.targetZoneId }),
          ...(details.attackerRegionCode === undefined
            ? {}
            : { attackerRegionCode: details.attackerRegionCode }),
          ...(details.targetRegionCode === undefined
            ? {}
            : { targetRegionCode: details.targetRegionCode }),
          ...(details.attackerInsideAuthoritativeView === undefined
            ? {}
            : {
                attackerInsideAuthoritativeView:
                  details.attackerInsideAuthoritativeView
              }),
          ...(details.targetInsideAuthoritativeView === undefined
            ? {}
            : {
                targetInsideAuthoritativeView:
                  details.targetInsideAuthoritativeView
              })
        }
      })
    });
  }

  private requestAuthorityResync(playerId: string): void {
    const now = Date.now();
    if (now - (this.lastAuthorityResyncAtByPlayer.get(playerId) ?? 0) < 2_000) {
      return;
    }
    this.lastAuthorityResyncAtByPlayer.set(playerId, now);
    this.replication.requestResync(playerId);
    this.combat.requestResync(playerId);
  }
}

function comparePopulationWithholdingAuthority(
  left: Readonly<{
    connectionGeneration: number;
    preparationGeneration: number;
    relocationRevision: number;
    resourceVisionRevision: number;
    gameplayViewGeneration: number;
  }>,
  right: Readonly<{
    connectionGeneration: number;
    preparationGeneration: number;
    relocationRevision: number;
    resourceVisionRevision: number;
    gameplayViewGeneration: number;
  }>
): number {
  return left.connectionGeneration - right.connectionGeneration ||
    left.relocationRevision - right.relocationRevision ||
    left.resourceVisionRevision - right.resourceVisionRevision ||
    left.gameplayViewGeneration - right.gameplayViewGeneration ||
    left.preparationGeneration - right.preparationGeneration;
}

function sameStringSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/** SWING_RESULT for one resolution; `nextSwingAt` is server epoch ms. */
function swingResultMessage(result: SwingResolution): ServerMessage {
  return {
    type: "SWING_RESULT",
    requestId: result.requestId ?? "",
    seq: result.seq,
    serverTick: result.serverTick,
    comboIndex: result.comboIndex,
    nextSwingAt: Math.round(result.nextSwingAtMs),
    hits: result.hits.map((hit) => ({
      entityId: hit.entityId,
      damage: Math.max(0, Math.round(hit.damage)),
      currentHealth: Math.max(0, Math.round(hit.currentHealth))
    })),
    ...(result.rejected ? { rejected: result.rejected } : {})
  };
}
