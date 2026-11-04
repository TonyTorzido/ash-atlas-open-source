import {
  DEFAULT_FLAG_PREPARE_BUFFER_M,
  DEFAULT_FLAG_PREPARE_RADIUS_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  type EquipmentChallengeProfile,
  type GameplayAreaContract,
  type WorldViewAuthority
} from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";
import type { CombatEngine } from "../game/combat/combatEngine.js";
import type { EquipmentService } from "../game/equipment.js";
import type { PopulationAreaOrchestrator } from "../game/populationAreaOrchestrator.js";
import {
  reservePopulationTravelArea,
  type PopulationTravelReservation
} from "../game/populationTravelReservation.js";
import type {
  PopulationConnectionPreparationState,
  PopulationConnectionRepublishResult,
  PopulationV2HarvestedTreeTransition
} from "../game/populationZonesV2Runtime.js";
import type { GameState } from "../game/state.js";
import type { WorldRuntime } from "../game/worldRuntime.js";
import type { AppLogger } from "../logger.js";
import type { ConnectionGenerationLedger } from "./connectionLifecycle.js";
import type { ConnectionRegistry } from "./connectionRegistry.js";
import type { TravelRuntimeState } from "./travelRuntimeState.js";

const COMMITTED_TRAVEL_TRANSITION_WATCHDOG_MS = 500;

export type RelocationPopulationReadiness =
  | "ready"
  | "degraded"
  | "preparing"
  | "retrying-after-backpressure"
  | "terminal-failure"
  | "stale"
  | "unavailable";

export type PopulationV2RealtimeRelocationHandle = Readonly<{
  visibleReady: Promise<Readonly<{
    status: "ready" | "degraded" | "stale" | "closed" | "failed";
    pendingVisibleZoneCount: number;
  }>>;
  presentationReady: Promise<Readonly<{
    status: "ready" | "degraded" | "stale" | "closed" | "failed";
    pendingVisibleZoneCount: number;
  }>>;
  completion: Promise<void>;
  preparationGeneration?: number;
  visibleZoneCount?: number;
  pendingVisibleZoneCount(): number;
}>;

export type PopulationV2RealtimeHooks = {
  prepareArea?(
    input: Parameters<PopulationAreaOrchestrator["prepareArea"]>[0]
  ): ReturnType<PopulationAreaOrchestrator["prepareArea"]>;
  releaseSource?(
    sourceId: string
  ): ReturnType<PopulationAreaOrchestrator["releaseSource"]>;
  adoptSource?(
    input: Parameters<PopulationAreaOrchestrator["adoptSource"]>[0]
  ): ReturnType<PopulationAreaOrchestrator["adoptSource"]>;
  hasPreparedZones?(
    zoneIds: Parameters<PopulationAreaOrchestrator["hasPreparedZones"]>[0],
    stage: Parameters<PopulationAreaOrchestrator["hasPreparedZones"]>[1]
  ): ReturnType<PopulationAreaOrchestrator["hasPreparedZones"]>;
  canAdmitSpeculative?(): ReturnType<
    PopulationAreaOrchestrator["canAdmitSpeculative"]
  >;
  refreshFlagLocality?(input: Readonly<{
    playerId: string;
    generation: number;
    center: Readonly<{ lat: number; lon: number }>;
  }>): void;
  releaseFlagLocality?(playerId: string): void;
  relocate(input: Readonly<{
    playerId: string;
    connectionId: string;
    area: GameplayAreaContract;
    relocationRevision: number;
    resourceVisionRevision: number;
    connectionGeneration: number;
    challengeProfile?: EquipmentChallengeProfile;
    trigger: PopulationRelocationTrigger;
    isCurrent: () => boolean;
  }>): PopulationV2RealtimeRelocationHandle;
  resync?(input: Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    preparationGeneration: number;
    relocationRevision: number;
    resourceVisionRevision: number;
    preparationTrigger: PopulationRelocationTrigger | "flag-construction";
    preparationScope: "required-visible" | "prepared-radius" | "neighbor-preload";
  }>): PopulationConnectionRepublishResult;
  releaseConnection(input: Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
  }>): void | Promise<void>;
  removeHarvestedTree?(transition: PopulationV2HarvestedTreeTransition): void;
};

export type PopulationRelocationTrigger =
  | "world-entry"
  | "reconnect"
  | "flag-travel"
  | "party-travel"
  | "flag-placement"
  | "separate-space-exit"
  | "administrative-relocation"
  | "explicit-relocation";

export type ScheduledPopulationV2Relocation =
  PopulationV2RealtimeRelocationHandle & Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    relocationRevision: number;
    resourceVisionRevision: number;
    gameplayViewGeneration: number;
    area: GameplayAreaContract;
    trigger: PopulationRelocationTrigger;
    startedAtMs: number;
    isCurrent(): boolean;
  }>;

export function createPopulationRealtimeOperations(context: Readonly<{
  config?: AppConfig | undefined;
  logger: AppLogger;
  registry: ConnectionRegistry;
  gameState: GameState;
  worldRuntime?: WorldRuntime | undefined;
  combat?: CombatEngine | undefined;
  equipment?: EquipmentService | undefined;
  populationV2?: PopulationV2RealtimeHooks | undefined;
  connectionGenerations: ConnectionGenerationLedger;
  travelRuntimeState: TravelRuntimeState;
  onPresentationRelocation?(relocation: ScheduledPopulationV2Relocation): void;
}>): Readonly<{
  closeScheduling(): void;
  schedulePopulationV2RelocationForActivePlayer(
    targetPlayerId: string,
    trigger: PopulationRelocationTrigger,
    expectedConnection?: Readonly<{
      connectionId: string;
      connectionGeneration: number;
      requestId?: string;
      challengeProfile?: EquipmentChallengeProfile;
    }>
  ): ScheduledPopulationV2Relocation | null;
  currentWorldViewAuthority(playerId: string): WorldViewAuthority | null;
  beginSmoothTravelTransition(targetPlayerId: string, requestId: string): symbol | null;
  endSmoothTravelTransition(
    targetPlayerId: string,
    requestId: string,
    transition: symbol,
    outcome: "committed" | "failed",
    releaseReason?: string
  ): boolean;
  markSmoothTravelTransitionPhase(
    playerId: string,
    transition: symbol,
    phase: "phase-one-running" | "committed" | "waiting-visible-population"
  ): boolean;
  armCommittedTravelTransitionWatchdog(
    targetPlayerId: string,
    requestId: string,
    transition: symbol,
    relocationRevision: number
  ): void;
  requestPopulationResync(input: Readonly<{
    requestId: string;
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    preparationGeneration: number;
    relocationRevision: number;
    resourceVisionRevision: number;
    preparationTrigger: PopulationRelocationTrigger | "flag-construction";
    preparationScope: "required-visible" | "prepared-radius" | "neighbor-preload";
  }>): "republished" | "started" | "ignored" | "rate-limited";
  waitForRelocationPopulationV2(input: Readonly<{
    playerId: string;
    requestId: string;
    destination: { lat: number; lon: number };
    transitionToken: symbol;
    relocation: ScheduledPopulationV2Relocation | null;
  }>): Promise<RelocationPopulationReadiness>;
  reservePopulationV2CurrentArea(input: Readonly<{
    playerId: string;
    requestId: string;
    kind: "separate-space-exit";
    center?: { lat: number; lon: number };
    preserveCurrentVision?: boolean;
    signal?: AbortSignal;
  }>): PopulationTravelReservation | null;
}> {
  const {
    config,
    logger,
    registry,
    gameState,
    worldRuntime,
    equipment,
    populationV2,
    connectionGenerations,
    travelRuntimeState,
    onPresentationRelocation
  } = context;
  let schedulingClosed = false;
  const populationRecoveryFlights = new Map<
    string,
    { key: string; completion: Promise<void> }
  >();
  const lastPopulationRecoveryAt = new Map<string, number>();
  const worldViewAuthorities = new Map<
    string,
    Readonly<{ authority: WorldViewAuthority; isCurrent(): boolean }>
  >();
  const currentRelocations = new Map<string, ScheduledPopulationV2Relocation>();

  const schedulePopulationV2RelocationForActivePlayer = (
    targetPlayerId: string,
    trigger: PopulationRelocationTrigger,
    expectedConnection?: Readonly<{
      connectionId: string;
      connectionGeneration: number;
      requestId?: string;
      challengeProfile?: EquipmentChallengeProfile;
    }>
  ): ScheduledPopulationV2Relocation | null => {
    if (
      !populationV2 ||
      schedulingClosed ||
      !gameState.isWorldPresent(targetPlayerId)
    ) return null;
    const player = gameState.getPlayer(targetPlayerId);
    const scheduledConnectionId =
      registry.activeConnectionIdForPlayer(targetPlayerId);
    const scheduledConnectionGeneration =
      connectionGenerations.current(targetPlayerId);
    if (
      !player ||
      !scheduledConnectionId ||
      scheduledConnectionGeneration === undefined ||
      (expectedConnection &&
        (expectedConnection.connectionId !== scheduledConnectionId ||
          expectedConnection.connectionGeneration !==
            scheduledConnectionGeneration))
    ) return null;
    const relocationRevision = player.relocationRevision ?? 0;
    const resourceVisionRevision = gameState.getResourceVisionRevision(targetPlayerId);
    const populationRelocationGeneration =
      travelRuntimeState.nextPopulationGeneration(targetPlayerId);
    const isCurrent = (): boolean =>
      registry.activeConnectionIdForPlayer(targetPlayerId) ===
        scheduledConnectionId &&
      connectionGenerations.current(targetPlayerId) ===
        scheduledConnectionGeneration &&
      gameState.isWorldPresent(targetPlayerId) &&
      (gameState.getPlayer(targetPlayerId)?.relocationRevision ?? -1) ===
        relocationRevision &&
      gameState.getResourceVisionRevision(targetPlayerId) === resourceVisionRevision &&
      travelRuntimeState.isPopulationGenerationCurrent(
        targetPlayerId,
        populationRelocationGeneration
      );
    const gameplayView = gameState.getGameplayViewCircle(targetPlayerId);
    const gameplayViewGeneration = gameplayView?.generation ?? 0;
    const resourceVision = gameState.getResourceVision(targetPlayerId);
    const certifiedVisibleRadiusM =
      gameplayView?.radiusM ??
      config?.FLAG_RESOURCE_VISION_RADIUS_M ??
      DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M;
    const preparationBufferM =
      config?.FLAG_PREPARE_BUFFER_M ?? DEFAULT_FLAG_PREPARE_BUFFER_M;
    const area: GameplayAreaContract = {
      center: { ...player.anchor },
      certifiedVisibleRadiusM,
      preparedRadiusM: Math.max(
        config?.FLAG_PREPARE_RADIUS_M ?? DEFAULT_FLAG_PREPARE_RADIUS_M,
        certifiedVisibleRadiusM + preparationBufferM
      ),
      sourceType: resourceVision?.destinationKind === "kingdom_seat"
        ? "kingdom_seat"
        : resourceVision?.destinationKind === "area"
          ? "area"
          : resourceVision
            ? "flag"
            : "player_anchor",
      sourceId: resourceVision?.flagId ?? player.playerId,
      generation: gameplayViewGeneration
    };
    if (!isCurrent()) return null;
    const challengeProfile =
      expectedConnection?.challengeProfile
      ?? equipment?.runtimeSnapshot(targetPlayerId)?.derivedStats.challengeProfile;
    populationV2.releaseFlagLocality?.(targetPlayerId);
    let runtimeHandle: PopulationV2RealtimeRelocationHandle;
    try {
      runtimeHandle = populationV2.relocate({
        playerId: targetPlayerId,
        connectionId: scheduledConnectionId,
        area,
        relocationRevision,
        resourceVisionRevision,
        connectionGeneration: scheduledConnectionGeneration,
        ...(challengeProfile === undefined
          ? {}
          : { challengeProfile }),
        trigger,
        isCurrent
      });
    } catch (error) {
      logger.warn(
        { err: error, playerId: targetPlayerId, trigger },
        "population v2 lifecycle relocation failed"
      );
      return null;
    }
    if (expectedConnection?.requestId) {
      gameplayLatencyTrace.record(targetPlayerId, {
        traceId: expectedConnection.requestId,
        source: "game",
        category: "population",
        name: "population_relocation_started",
        details: {
          relocationRevision,
          resourceVisionRevision,
          connectionGeneration: scheduledConnectionGeneration,
          gameplayViewGeneration,
          pendingVisibleZoneCount: runtimeHandle.pendingVisibleZoneCount(),
          trigger,
          worldCalled: false
        }
      });
    }
    const authority: WorldViewAuthority = {
      playerId: targetPlayerId,
      connectionId: scheduledConnectionId,
      connectionGeneration: scheduledConnectionGeneration,
      relocationRevision,
      resourceVisionRevision,
      gameplayViewGeneration,
      populationPreparationGeneration:
        runtimeHandle.preparationGeneration ?? 0
    };
    worldViewAuthorities.set(targetPlayerId, {
      authority,
      isCurrent
    });
    const scheduledRelocation: ScheduledPopulationV2Relocation = {
      ...runtimeHandle,
      playerId: targetPlayerId,
      connectionId: scheduledConnectionId,
      connectionGeneration: scheduledConnectionGeneration,
      relocationRevision,
      resourceVisionRevision,
      gameplayViewGeneration,
      area,
      trigger,
      startedAtMs: performance.now(),
      isCurrent
    };
    currentRelocations.set(targetPlayerId, scheduledRelocation);
    worldRuntime?.beginPopulationPreparation(
      targetPlayerId,
      relocationRevision,
      expectedConnection?.requestId
    );
    void runtimeHandle.completion
      .then(() => {
        if (!isCurrent()) return;
        populationV2.refreshFlagLocality?.({
          playerId: targetPlayerId,
          generation: gameplayViewGeneration,
          center: area.center
        });
      })
      .catch((error: unknown) => {
        logger.warn(
          { err: error, playerId: targetPlayerId, trigger },
          "population v2 lifecycle relocation failed"
        );
      })
      .finally(() => {
        worldRuntime?.endPopulationPreparation(targetPlayerId, relocationRevision);
      });
    return scheduledRelocation;
  };

  const requestPopulationResync = (input: Readonly<{
    requestId: string;
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    preparationGeneration: number;
    relocationRevision: number;
    resourceVisionRevision: number;
    preparationTrigger: PopulationRelocationTrigger | "flag-construction";
    preparationScope: "required-visible" | "prepared-radius" | "neighbor-preload";
  }>): "republished" | "started" | "ignored" | "rate-limited" => {
    const currentConnectionId =
      registry.activeConnectionIdForPlayer(input.playerId);
    const currentConnectionGeneration =
      connectionGenerations.current(input.playerId);
    const player = gameState.getPlayer(input.playerId);
    const currentRelocationRevision = player?.relocationRevision ?? 0;
    const currentResourceVisionRevision =
      gameState.getResourceVisionRevision(input.playerId);
    const finish = (
      outcome:
        | "republished"
        | "relocation-started"
        | "already-current"
        | "rate-limited"
        | "ignored-stale"
        | "unavailable",
      legacy: "republished" | "started" | "ignored" | "rate-limited",
      state: PopulationConnectionPreparationState | null = null
    ): typeof legacy => {
      if (
        currentConnectionId &&
        currentConnectionGeneration !== undefined
      ) {
        registry.sendToConnection(currentConnectionId, {
          type: "POPULATION_RESYNC_RESULT",
          requestId: input.requestId,
          outcome,
          playerId: input.playerId,
          connectionId: currentConnectionId,
          connectionGeneration: currentConnectionGeneration,
          requestedPreparationGeneration: input.preparationGeneration,
          currentPreparationGeneration: state?.preparationGeneration ?? null,
          requestedRelocationRevision: input.relocationRevision,
          currentRelocationRevision: state?.relocationRevision
            ?? currentRelocationRevision,
          requestedResourceVisionRevision: input.resourceVisionRevision,
          currentResourceVisionRevision: state?.resourceVisionRevision
            ?? currentResourceVisionRevision,
          preparationReason: state?.preparationReason ?? null,
          preparationResult: state?.preparationResult ?? null,
          visibleZoneCount: state?.visibleZoneCount ?? 0,
          readyVisibleZoneCount: state?.readyVisibleZoneCount ?? 0,
          terminal: state?.terminal ?? false
        });
      }
      return legacy;
    };
    if (
      schedulingClosed ||
      !populationV2?.resync
    ) return finish("unavailable", "ignored");
    if (
      input.preparationScope !== "required-visible" ||
      currentConnectionId !== input.connectionId ||
      currentConnectionGeneration !==
        input.connectionGeneration ||
      !gameState.isWorldPresent(input.playerId)
    ) return finish("ignored-stale", "ignored");
    if (
      !player ||
      input.relocationRevision > currentRelocationRevision ||
      input.resourceVisionRevision >
        currentResourceVisionRevision
    ) return finish("ignored-stale", "ignored");
    const key = [
      input.connectionId,
      input.connectionGeneration,
      input.preparationGeneration,
      input.relocationRevision,
      input.resourceVisionRevision,
      input.preparationTrigger,
      input.preparationScope
    ].join(":");
    const activeRecovery = populationRecoveryFlights.get(input.playerId);
    if (activeRecovery) return finish("already-current", "ignored");
    const now = Date.now();
    const minimumIntervalMs = config?.WORLD_RESYNC_MIN_INTERVAL_MS ?? 2_000;
    if (
      now - (lastPopulationRecoveryAt.get(input.playerId) ?? -Infinity) <
        minimumIntervalMs
    ) return finish("rate-limited", "rate-limited");
    lastPopulationRecoveryAt.set(input.playerId, now);
    const result = populationV2.resync(input);
    if (result.status === "republished") {
      gameplayLatencyTrace.record(input.playerId, {
        traceId: input.requestId,
        source: "game",
        category: "population",
        name: "population_resync_republished",
        details: {
          connectionGeneration: input.connectionGeneration,
          preparationGeneration: input.preparationGeneration,
          relocationRevision: input.relocationRevision,
          resourceVisionRevision: input.resourceVisionRevision,
          trigger: input.preparationTrigger,
          scope: input.preparationScope
        }
      });
      const terminalReady = result.state?.terminal === true && (
        result.state.preparationResult === "degraded" ||
        (
          result.state.preparationResult === "ready" &&
          result.state.readyVisibleZoneCount === result.state.visibleZoneCount
        )
      );
      if (terminalReady) {
        const current = currentRelocations.get(input.playerId);
        if (current?.isCurrent()) onPresentationRelocation?.(current);
        return finish("already-current", "republished", result.state);
      }
      if (!result.state?.terminal) {
        return finish("republished", "republished", result.state);
      }
    }
    const relocation = schedulePopulationV2RelocationForActivePlayer(
      input.playerId,
      "explicit-relocation",
      {
        connectionId: input.connectionId,
        connectionGeneration: input.connectionGeneration,
        requestId: input.requestId
      }
    );
    if (!relocation) {
      return finish(
        result.status === "missing" ? "unavailable" : "ignored-stale",
        "ignored",
        result.state
      );
    }
    onPresentationRelocation?.(relocation);
    const completion = relocation.completion
      .catch(() => undefined)
      .finally(() => {
        if (populationRecoveryFlights.get(input.playerId)?.key === key) {
          populationRecoveryFlights.delete(input.playerId);
        }
      });
    populationRecoveryFlights.set(input.playerId, { key, completion });
    return finish("relocation-started", "started", {
      preparationGeneration:
        relocation.preparationGeneration ?? input.preparationGeneration,
      relocationRevision: relocation.relocationRevision,
      resourceVisionRevision: relocation.resourceVisionRevision,
      preparationResult: "pending",
      preparationReason: "durable-rehydration",
      visibleZoneCount: relocation.visibleZoneCount
        ?? relocation.pendingVisibleZoneCount(),
      readyVisibleZoneCount: Math.max(
        0,
        (relocation.visibleZoneCount ?? relocation.pendingVisibleZoneCount())
          - relocation.pendingVisibleZoneCount()
      ),
      terminal: false
    });
  };

  const beginSmoothTravelTransition = (
    targetPlayerId: string,
    requestId: string
  ): symbol | null => {
    if (!worldRuntime) return null;
    const connectionGeneration =
      connectionGenerations.current(targetPlayerId) ?? -1;
    const transition = worldRuntime.beginPlayerWorldTransition(
      targetPlayerId,
      requestId,
      { connectionGeneration }
    );
    if (!transition) return null;
    travelRuntimeState.trackTransition(transition, {
      playerId: targetPlayerId,
      requestId,
      connectionId: registry.activeConnectionIdForPlayer(targetPlayerId),
      connectionGeneration,
      relocationRevision: gameState.getPlayer(targetPlayerId)?.relocationRevision ?? 0,
      startedAtMs: performance.now(),
      phase: "started",
      committed: false,
      watchdog: null
    });
    gameplayLatencyTrace.record(targetPlayerId, {
      traceId: requestId,
      source: "game",
      category: "population",
      name: "flag_travel_transition_started",
      details: { worldCalled: false }
    });
    return transition;
  };

  const endSmoothTravelTransition = (
    targetPlayerId: string,
    requestId: string,
    transition: symbol,
    outcome: "committed" | "failed",
    releaseReason: string = outcome
  ): boolean => {
    if (!worldRuntime) return false;
    const timing = travelRuntimeState.transition(transition);
    const ended = worldRuntime.endPlayerWorldTransition(
      targetPlayerId,
      transition,
      outcome,
      releaseReason,
      releaseReason === "watchdog"
        || releaseReason === "shutdown"
        || releaseReason.includes("timeout")
        || releaseReason.includes("stale")
        || releaseReason.includes("replaced")
    );
    if (
      timing?.playerId === targetPlayerId &&
      timing.requestId === requestId
    ) {
      travelRuntimeState.releaseTransition(transition);
    }
    if (!ended) return false;
    gameplayLatencyTrace.record(targetPlayerId, {
      traceId: requestId,
      source: "game",
      category: "population",
      name: "flag_travel_transition_released",
      details: {
        transitionDurationMs: timing
          ? performance.now() - timing.startedAtMs
          : 0,
        relocationRevision:
          gameState.getPlayer(targetPlayerId)?.relocationRevision ?? 0,
        phase: timing?.phase ?? "released",
        reason: releaseReason,
        worldCalled: false
      },
      failure: outcome === "failed"
    });
    gameplayLatencyTrace.record(targetPlayerId, {
      traceId: requestId,
      source: "game",
      category: "population",
      name: "travel_transition_released",
      details: {
        transitionDurationMs: timing
          ? performance.now() - timing.startedAtMs
          : 0,
        relocationRevision:
          gameState.getPlayer(targetPlayerId)?.relocationRevision ?? 0,
        phase: timing?.phase ?? "released",
        reason: releaseReason,
        worldCalled: false
      },
      failure: outcome === "failed"
    });
    return true;
  };

  const markSmoothTravelTransitionPhase = (
    targetPlayerId: string,
    transition: symbol,
    phase: "phase-one-running" | "committed" | "waiting-visible-population"
  ): boolean => {
    const tracked = travelRuntimeState.transition(transition);
    if (!tracked || tracked.playerId !== targetPlayerId) return false;
    tracked.phase = phase;
    return worldRuntime?.markPlayerWorldTransitionPhase(
      targetPlayerId,
      transition,
      phase
    ) ?? false;
  };

  const armCommittedTravelTransitionWatchdog = (
    targetPlayerId: string,
    requestId: string,
    transition: symbol,
    relocationRevision: number
  ): void => {
    const tracked = travelRuntimeState.transition(transition);
    if (!tracked || tracked.playerId !== targetPlayerId || tracked.requestId !== requestId) return;
    tracked.committed = true;
    tracked.phase = "committed";
    tracked.relocationRevision = relocationRevision;
    worldRuntime?.commitPlayerWorldTransition(
      targetPlayerId,
      transition,
      relocationRevision
    );
    tracked.watchdog = setTimeout(() => {
      const current = travelRuntimeState.transition(transition);
      if (
        !current ||
        current.playerId !== targetPlayerId ||
        current.requestId !== requestId ||
        current.relocationRevision !== relocationRevision
      ) return;
      logger.warn({
        playerId: targetPlayerId,
        requestId,
        transitionToken: String(transition),
        connectionId: current.connectionId,
        connectionGeneration: current.connectionGeneration,
        relocationRevision,
        phase: current.phase,
        elapsedMs: performance.now() - current.startedAtMs
      }, "committed travel transition exceeded the population readiness diagnostic threshold");
    }, COMMITTED_TRAVEL_TRANSITION_WATCHDOG_MS);
    tracked.watchdog.unref?.();
  };

  const reservePopulationV2CurrentArea = (input: Readonly<{
    playerId: string;
    requestId: string;
    kind: "separate-space-exit";
    center?: { lat: number; lon: number };
    preserveCurrentVision?: boolean;
    signal?: AbortSignal;
  }>): PopulationTravelReservation | null => {
    if (
      schedulingClosed
      || !populationV2?.prepareArea
      || !populationV2.releaseSource
      || !populationV2.adoptSource
    ) return null;
    const player = gameState.getPlayer(input.playerId);
    const connectionId =
      registry.activeConnectionIdForPlayer(input.playerId);
    const connectionGeneration =
      connectionGenerations.current(input.playerId);
    if (!player || !connectionId || connectionGeneration === undefined) {
      return null;
    }
    const vision = input.preserveCurrentVision === false
      ? null
      : gameState.getResourceVision(input.playerId);
    const certifiedVisibleRadiusM =
      vision?.radiusM
      ?? config?.FLAG_RESOURCE_VISION_RADIUS_M
      ?? DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M;
    const preparationBufferM =
      config?.FLAG_PREPARE_BUFFER_M ?? DEFAULT_FLAG_PREPARE_BUFFER_M;
    const area: GameplayAreaContract = {
      center: { ...(input.center ?? player.anchor) },
      certifiedVisibleRadiusM,
      preparedRadiusM: Math.max(
        config?.FLAG_PREPARE_RADIUS_M ?? DEFAULT_FLAG_PREPARE_RADIUS_M,
        certifiedVisibleRadiusM + preparationBufferM
      ),
      sourceType: vision?.destinationKind === "kingdom_seat"
        ? "kingdom_seat"
        : vision?.destinationKind === "area"
          ? "area"
          : vision
            ? "flag"
            : "player_anchor",
      sourceId: vision?.flagId ?? player.playerId,
      generation:
        (gameState.getGameplayViewCircle(input.playerId)?.generation ?? 0) + 1
    };
    return reservePopulationTravelArea({
      hooks: {
        prepareArea: (request) => populationV2.prepareArea!(request),
        releaseSource: (sourceId) => populationV2.releaseSource!(sourceId),
        adoptSource: (request) => populationV2.adoptSource!(request)
      },
      area,
      kind: input.kind,
      playerId: input.playerId,
      connectionId,
      connectionGeneration,
      travelId: input.requestId,
      expectedRelocationRevision: (player.relocationRevision ?? 0) + 1,
      expectedResourceVisionRevision:
        gameState.getResourceVisionRevision(input.playerId)
        + (input.preserveCurrentVision === false ? 0 : 1),
      expectedGameplayViewGeneration: area.generation,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
  };

  const waitForRelocationPopulationV2 = async (input: Readonly<{
    playerId: string;
    requestId: string;
    destination: { lat: number; lon: number };
    transitionToken: symbol;
    relocation: ScheduledPopulationV2Relocation | null;
  }>): Promise<RelocationPopulationReadiness> => {
    if (!input.relocation) return "unavailable";
    const outcome = await input.relocation.presentationReady;
    if (outcome.status !== "ready" && outcome.status !== "degraded") {
      logger.warn(
        {
          playerId: input.playerId,
          requestId: input.requestId,
          connectionId: input.relocation.connectionId,
          connectionGeneration: input.relocation.connectionGeneration,
          relocationRevision: input.relocation.relocationRevision,
          resourceVisionRevision: input.relocation.resourceVisionRevision,
          gameplayViewGeneration: input.relocation.gameplayViewGeneration,
          destination: input.destination,
          presentationActivationStatus: outcome.status,
          pendingVisibleZoneCount: outcome.pendingVisibleZoneCount
        },
        "authoritative relocation presentation did not become ready"
      );
      return outcome.status === "failed" ? "terminal-failure" : "stale";
    }
    if (!input.relocation.isCurrent()) return "stale";
    requestPopulationResync({
      requestId: `${input.requestId}:presentation-ready`,
      playerId: input.playerId,
      connectionId: input.relocation.connectionId,
      connectionGeneration: input.relocation.connectionGeneration,
      preparationGeneration: input.relocation.preparationGeneration ?? 0,
      relocationRevision: input.relocation.relocationRevision,
      resourceVisionRevision: input.relocation.resourceVisionRevision,
      preparationTrigger: input.relocation.trigger,
      preparationScope: "required-visible"
    });
    gameplayLatencyTrace.record(input.playerId, {
      traceId: input.requestId,
      source: "game",
      category: "population",
      name: "authoritative_relocation_presentation_ready",
      details: {
        relocationRevision: input.relocation.relocationRevision,
        resourceVisionRevision: input.relocation.resourceVisionRevision,
        durationMs: performance.now() - input.relocation.startedAtMs,
        pendingVisibleZoneCount: outcome.pendingVisibleZoneCount,
        worldCalled: false
      }
    });
    gameplayLatencyTrace.record(input.playerId, {
      traceId: input.requestId,
      source: "game",
      category: "population",
      name: "population_presentation_ready",
      details: {
        relocationRevision: input.relocation.relocationRevision,
        resourceVisionRevision: input.relocation.resourceVisionRevision,
        pendingVisibleZoneCount: outcome.pendingVisibleZoneCount,
        durationMs: performance.now() - input.relocation.startedAtMs,
        worldCalled: false
      }
    });
    return outcome.status;
  };

  return {
    closeScheduling() {
      schedulingClosed = true;
      populationRecoveryFlights.clear();
      lastPopulationRecoveryAt.clear();
      worldViewAuthorities.clear();
      currentRelocations.clear();
    },
    schedulePopulationV2RelocationForActivePlayer,
    currentWorldViewAuthority: (playerId) => {
      const current = worldViewAuthorities.get(playerId);
      return current?.isCurrent() ? current.authority : null;
    },
    requestPopulationResync,
    beginSmoothTravelTransition,
    endSmoothTravelTransition,
    markSmoothTravelTransitionPhase,
    armCommittedTravelTransitionWatchdog,
    reservePopulationV2CurrentArea,
    waitForRelocationPopulationV2
  };
}
