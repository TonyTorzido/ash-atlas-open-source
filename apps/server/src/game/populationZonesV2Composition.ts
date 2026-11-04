import type pg from "pg";

import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import {
  assertWorldReleaseIdentity,
  gameReleaseSha,
  REQUIRED_WORLD_PIPELINE_SHA,
  type GameReleaseSha,
  type WorldPipelineSha
} from "../runtime/authorityIdentity.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { CombatEngine } from "./combat/combatEngine.js";
import {
  type WorldEnvironmentDataIdentity,
  worldEnvironmentIdentityKey
} from "./gameplayEnvironmentProfiles.js";
import {
  populationV2MobRegistry,
  type PopulationV2MobDefinition
} from "./populationV2MobRegistry.js";
import {
  PopulationV2MobRolloutService
} from "./populationV2MobRolloutService.js";
import {
  PopulationV2PostgresMobRolloutExecutor,
  PostgresPopulationV2RegisteredMobRolloutStore
} from "./populationV2RegisteredMobRolloutStore.js";
import { PopulationAreaOrchestrator } from "./populationAreaOrchestrator.js";
import { PopulationZoneV3HabitatCompiler } from "./populationZoneV3HabitatCompiler.js";
import { PopulationZonesV2Backend } from "./populationZonesV2Backend.js";
import type { PopulationZoneV2Id } from "./populationZonesV2Geometry.js";
import type { PopulationZoneV2ReadyEntity } from "./populationZonesV2Store.js";
import { PopulationZonesV2Planner } from "./populationZonesV2Planner.js";
import {
  POPULATION_V2_VISIBLE_PREPARATION_TERMINAL_MS,
  PopulationZonesV2Runtime
} from "./populationZonesV2Runtime.js";
import { PostgresPopulationZonesV2Store } from "./populationZonesV2Store.js";

export const REQUIRED_POPULATION_V2_WORLD_PIPELINE_SHA =
  REQUIRED_WORLD_PIPELINE_SHA;

type PopulationCompositionConfig = Pick<
  AppConfig,
  "REGION_CODE" | "RUNTIME_SHA"
> & Partial<Pick<
  AppConfig,
  | "POPULATION_V2_ACTIVE_PREPARATION_CONCURRENCY"
  | "POPULATION_V2_ZONE_QUEUE_MAX"
  | "POPULATION_V2_RETRY_MIN_MS"
  | "POPULATION_V2_RETRY_MAX_MS"
  | "POPULATION_V2_SLEEP_GRACE_MS"
  | "POPULATION_V2_DESCRIPTOR_CACHE_MAX_ZONES"
  | "POPULATION_V2_DESCRIPTOR_CACHE_MAX_BYTES"
  | "POPULATION_V2_DESCRIPTOR_CACHE_TTL_MS"
  | "POPULATION_V2_VISIBLE_PREPARATION_STALE_MS"
  | "POPULATION_V2_VISIBLE_PREPARATION_TERMINAL_MS"
  | "POPULATION_V2_VISIBLE_PREPARATION_RETRY_LIMIT"
  | "POPULATION_INFLIGHT_RESULT_REUSE_ENABLED"
  | "POPULATION_PROFILE_CLAIM_NOOP_FAST_PATH_ENABLED"
  | "POPULATION_V2_MOB_ROLLOUT_ENABLED"
  | "POPULATION_V2_MOB_ROLLOUT_KINDS"
  | "POPULATION_V2_MOB_ROLLOUT_QUEUE_MAX"
  | "POPULATION_V2_MOB_ROLLOUT_MIN_DELAY_MS"
  | "POPULATION_V2_MOB_ROLLOUT_MAX_ATTEMPTS"
>>;

export type PopulationZonesV2Composition = Readonly<{
  store: PostgresPopulationZonesV2Store;
  planner: PopulationZonesV2Planner;
  backend: PopulationZonesV2Backend;
  runtime: PopulationZonesV2Runtime;
  orchestrator: PopulationAreaOrchestrator;
  mobRollout: PopulationV2MobRolloutService;
  queueBackgroundMobRollout(zoneIds: readonly PopulationZoneV2Id[]): void;
  close(): Promise<void>;
}>;

type PopulationCompositionInput = Readonly<{
  pool: pg.Pool;
  config: PopulationCompositionConfig;
  worldIdentity: WorldEnvironmentDataIdentity;
  worldLookup: Pick<WorldLookupClient, "lookupGameplayEnvironments">;
  combat: Pick<
    CombatEngine,
    | "entity"
    | "spawnMob"
    | "despawnMob"
    | "despawnPopulationManagedMob"
    | "rebindPopulationAuthority"
  >;
  logger: Pick<AppLogger, "warn"> & Partial<Pick<AppLogger, "info">>;
  backgroundPressureElevated?(): boolean;
  hostHealthy?(): boolean;
  onRuntimeMobSpawned?(
    entity: PopulationZoneV2ReadyEntity,
    position: { lat: number; lon: number }
  ): void;
}>;

export function createPopulationZonesV2Composition(
  input: PopulationCompositionInput
): PopulationZonesV2Composition {
  if (!input.config.RUNTIME_SHA) {
    throw new Error("Population v2 production composition requires an exact game RUNTIME_SHA");
  }
  return createComposition(input, gameReleaseSha(input.config.RUNTIME_SHA));
}

function createComposition(
  input: PopulationCompositionInput,
  releaseSha: GameReleaseSha
): PopulationZonesV2Composition {
  const worldPipelineSha = populationV2WorldPipelineSha(input.worldIdentity);
  const store = new PostgresPopulationZonesV2Store(
    input.pool,
    undefined,
    undefined,
    {
      profileClaimNoopFastPathEnabled:
        input.config.POPULATION_PROFILE_CLAIM_NOOP_FAST_PATH_ENABLED === true,
      logger: input.logger
    }
  );
  const identityKey = worldEnvironmentIdentityKey(input.worldIdentity);
  const compiler = new PopulationZoneV3HabitatCompiler(
    input.worldLookup,
    {},
    input.logger
  );
  const planner = new PopulationZonesV2Planner(
    store,
    compiler,
    {
      worldEnvironmentIdentityKey: identityKey,
      worldPipelineSha,
      activePreparationConcurrency:
        input.config.POPULATION_V2_ACTIVE_PREPARATION_CONCURRENCY ?? 4,
      zoneQueueMax: input.config.POPULATION_V2_ZONE_QUEUE_MAX ?? 128,
      retryMs: input.config.POPULATION_V2_RETRY_MIN_MS ?? 5_000,
      retryMaxMs: input.config.POPULATION_V2_RETRY_MAX_MS ?? 60_000
    },
    input.logger
  );

  const backend = new PopulationZonesV2Backend(
    store,
    planner,
    input.combat,
    {
      regionCode: input.config.REGION_CODE,
      runtimeSha: releaseSha,
      worldEnvironmentIdentityKey: identityKey,
      worldPipelineSha,
      ...(input.onRuntimeMobSpawned
        ? { onRuntimeMobSpawned: input.onRuntimeMobSpawned }
        : {}),
      ...(input.backgroundPressureElevated
        ? {
            backgroundPressureElevated:
              input.backgroundPressureElevated
          }
        : {})
    },
    input.logger
  );
  const runtime = new PopulationZonesV2Runtime(
    backend,
    {
      sleepGraceMs: input.config.POPULATION_V2_SLEEP_GRACE_MS ?? 60_000,
      descriptorCacheMaxZones:
        input.config.POPULATION_V2_DESCRIPTOR_CACHE_MAX_ZONES ?? 128,
      descriptorCacheMaxBytes:
        input.config.POPULATION_V2_DESCRIPTOR_CACHE_MAX_BYTES
        ?? 16 * 1_024 * 1_024,
      descriptorCacheTtlMs:
        input.config.POPULATION_V2_DESCRIPTOR_CACHE_TTL_MS ?? 300_000,
      visiblePreparationStaleMs:
        input.config.POPULATION_V2_VISIBLE_PREPARATION_STALE_MS ?? 15_000,
      visiblePreparationTerminalMs:
        input.config.POPULATION_V2_VISIBLE_PREPARATION_TERMINAL_MS
        ?? POPULATION_V2_VISIBLE_PREPARATION_TERMINAL_MS,
      visiblePreparationRetryLimit:
        input.config.POPULATION_V2_VISIBLE_PREPARATION_RETRY_LIMIT ?? 1,
      inflightResultReuseEnabled:
        input.config.POPULATION_INFLIGHT_RESULT_REUSE_ENABLED === true,
      logger: input.logger,
      plannerStateForZones: (zoneIds) => {
        const selected = new Set(zoneIds);
        return planner.snapshot().zones.filter((zone) =>
          selected.has(zone.zoneId)
        );
      }
    }
  );
  const orchestrator = new PopulationAreaOrchestrator(runtime, {
    speculativePressureElevated: () =>
      input.backgroundPressureElevated?.() === true
      || input.pool.waitingCount > 0
  });
  const unsubscribeReady = planner.onPlanReady((zoneId) =>
    runtime.notifyZoneReady(zoneId)
  );
  const unsubscribeFailure = planner.onPlanFailed((zoneId, outcome) =>
    runtime.notifyZoneFailed(zoneId, outcome)
  );
  const unsubscribeGenerationRefresh = backend.onGenerationRefreshReady(
    (zoneId) => runtime.notifyZoneReady(zoneId)
  );
  const rolloutDefinitions =
    input.config.POPULATION_V2_MOB_ROLLOUT_ENABLED === true
      ? configuredRolloutDefinitions(input.config)
      : [];
  const rolloutEnabled = rolloutDefinitions.length > 0;
  const rolloutQueueMax =
    input.config.POPULATION_V2_MOB_ROLLOUT_QUEUE_MAX ?? 64;
  const rolloutMaximumAttempts =
    input.config.POPULATION_V2_MOB_ROLLOUT_MAX_ATTEMPTS ?? 4;
  const rolloutStore = new PostgresPopulationV2RegisteredMobRolloutStore(
    input.pool,
    { maximumAttempts: rolloutMaximumAttempts }
  );
  const mobRollout = new PopulationV2MobRolloutService(
    new PopulationV2PostgresMobRolloutExecutor(rolloutStore),
    {
      enabled: rolloutEnabled,
      queueMax: rolloutQueueMax,
      minimumDelayMs:
        input.config.POPULATION_V2_MOB_ROLLOUT_MIN_DELAY_MS ?? 25,
      maxAttempts: rolloutMaximumAttempts,
      eventLoopPressureElevated: () =>
        input.backgroundPressureElevated?.() === true,
      postgresPoolWaiters: () => input.pool.waitingCount,
      hostHealthy: () => input.hostHealthy?.() !== false,
      notifyRuntime: (zoneId) =>
        runtime.notifyZoneReady(zoneId as PopulationZoneV2Id),
      warn: (message) =>
        input.logger.warn({}, message)
    }
  );
  const pendingRolloutAdmissionZones = new Set<PopulationZoneV2Id>();
  let rolloutAdmission: Promise<void> | null = null;
  let rolloutAdmissionClosed = false;
  let rolloutAdmissionOverflowWarned = false;

  const scheduleRolloutAdmission = (): void => {
    if (
      rolloutAdmissionClosed
      || !rolloutEnabled
      || rolloutAdmission !== null
      || pendingRolloutAdmissionZones.size === 0
    ) return;
    rolloutAdmission = Promise.resolve().then(async () => {
      const zoneIds = [...pendingRolloutAdmissionZones].sort();
      pendingRolloutAdmissionZones.clear();
      const generations =
        await store.loadCurrentServingPlanGenerations(zoneIds);
      if (rolloutAdmissionClosed) return;
      const now = Date.now();
      for (const generation of generations) {
        if (
          !generation.isCurrent
          || generation.status !== "active"
          || generation.expiresAt.getTime() <= now
        ) continue;
        for (const definition of rolloutDefinitions) {
          mobRollout.enqueue({
            generationId: generation.generationId,
            zoneId: generation.zoneId,
            mobKind: definition.mobKind,
            rolloutRevision: definition.placementRevision,
            referenced: true
          });
        }
      }
    }).catch((error: unknown) => {
      input.logger.warn(
        { err: error },
        "Population V2 mob rollout admission failed"
      );
    }).finally(() => {
      rolloutAdmission = null;
      scheduleRolloutAdmission();
    });
  };

  const queueBackgroundMobRollout = (
    zoneIds: readonly PopulationZoneV2Id[]
  ): void => {
    if (!rolloutEnabled || rolloutAdmissionClosed) return;
    for (const zoneId of [...new Set(zoneIds)].sort()) {
      if (pendingRolloutAdmissionZones.size >= rolloutQueueMax) {
        if (!rolloutAdmissionOverflowWarned) {
          rolloutAdmissionOverflowWarned = true;
          input.logger.warn(
            { rolloutQueueMax },
            "Population V2 mob rollout admission is full; optional zones were dropped"
          );
        }
        break;
      }
      pendingRolloutAdmissionZones.add(zoneId);
    }
    scheduleRolloutAdmission();
  };
  let closed = false;
  return {
    store,
    planner,
    backend,
    runtime,
    orchestrator,
    mobRollout,
    queueBackgroundMobRollout,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      rolloutAdmissionClosed = true;
      pendingRolloutAdmissionZones.clear();
      await rolloutAdmission;
      await mobRollout.close();
      unsubscribeReady();
      unsubscribeFailure();
      unsubscribeGenerationRefresh();
      orchestrator.close();
      await runtime.close();
      await planner.close();
      await backend.close();
    }
  };
}

function configuredRolloutDefinitions(
  config: PopulationCompositionConfig
): readonly PopulationV2MobDefinition[] {
  const configuredKinds = [
    ...new Set(
      (config.POPULATION_V2_MOB_ROLLOUT_KINDS ?? "")
        .split(",")
        .map((kind) => kind.trim())
        .filter(Boolean)
    )
  ].sort();
  return configuredKinds.map((kind) => {
    const definition = populationV2MobRegistry.requireDefinition(kind);
    if (
      definition.generationPlacement !== "registered_overlay"
      || !definition.existingGenerationRolloutEligible
    ) {
      throw new Error(
        `Population V2 mob ${kind} is not eligible for existing-generation rollout`
      );
    }
    return definition;
  });
}

export function populationV2WorldPipelineSha(
  requiredIdentity: WorldEnvironmentDataIdentity
): WorldPipelineSha {
  return assertWorldReleaseIdentity(requiredIdentity);
}
