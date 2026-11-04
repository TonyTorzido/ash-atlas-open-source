import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export type GameplayTraceCategory =
  | "movement"
  | "networking"
  | "flag-preparation"
  | "build"
  | "world"
  | "population"
  | "database"
  | "ui";

export type GameplayTraceDetails = Record<
  string,
  string | number | boolean | null
>;

export type GameplayTraceReleaseIdentity = Readonly<{
  gameReleaseSha: string;
  releaseGeneration: string;
  worldPipelineSha: string;
}>;

export function resolveGameplayTraceReleaseIdentity(input: Readonly<{
  runtimeSha?: string | undefined;
  runtimeGeneration?: string | undefined;
  telemetryReleaseGeneration?: string | undefined;
  worldPipelineSha: string;
}>): GameplayTraceReleaseIdentity | null {
  if (
    !/^[a-f0-9]{40}$/u.test(input.runtimeSha ?? "") ||
    !/^test\/t[0-9]{3,4}$/u.test(input.runtimeGeneration ?? "") ||
    !/^[a-f0-9]{40}$/u.test(input.worldPipelineSha)
  ) return null;
  return {
    gameReleaseSha: input.runtimeSha!,
    releaseGeneration: input.runtimeGeneration!,
    worldPipelineSha: input.worldPipelineSha
  };
}

export type GameplayTraceEvent = {
  sequence: number;
  sessionTraceId: string;
  traceId: string;
  source: "client" | "game" | "world";
  category: GameplayTraceCategory;
  name: string;
  wallTimeIso: string;
  monotonicMs: number;
  details: GameplayTraceDetails;
  failure: boolean;
  releaseIdentity: GameplayTraceReleaseIdentity;
};

export type GameplayTraceSnapshot = {
  schemaVersion: 2;
  active: boolean;
  sessionTraceId: string | null;
  startedAtIso: string | null;
  stoppedAtIso: string | null;
  events: GameplayTraceEvent[];
  failures: GameplayTraceEvent[];
  droppedEvents: number;
  droppedEventsByCategory: Record<GameplayTraceCategory, number>;
  droppedCriticalEvents: number;
  expiresAtIso: string | null;
  releaseIdentity: GameplayTraceReleaseIdentity | null;
};

type TraceSession = {
  playerId: string;
  sessionTraceId: string;
  startedAtIso: string;
  stoppedAtIso: string | null;
  startedMonotonicMs: number;
  expiresAtMs: number;
  events: GameplayTraceEvent[];
  failures: GameplayTraceEvent[];
  nextSequence: number;
  ordinaryEventCount: number;
  droppedEvents: number;
  droppedEventsByCategory: Record<GameplayTraceCategory, number>;
  droppedCriticalEvents: number;
  releaseIdentity: GameplayTraceReleaseIdentity;
};

export type RecordGameplayTraceInput = {
  traceId?: string | undefined;
  source: GameplayTraceEvent["source"];
  category: GameplayTraceCategory;
  name: string;
  wallTimeIso?: string | undefined;
  monotonicMs?: number | undefined;
  details?: GameplayTraceDetails | undefined;
  failure?: boolean | undefined;
};

const MAX_EVENTS = 1_000;
const CRITICAL_EVENT_RESERVE = 250;
const MAX_ORDINARY_EVENTS = MAX_EVENTS - CRITICAL_EVENT_RESERVE;
const MAX_FAILURES = 25;
const MAX_SESSIONS = 50;
const ACTIVE_TTL_MS = 30 * 60_000;
const STOPPED_TTL_MS = 10 * 60_000;
const SAFE_NAME = /^[a-z0-9][a-z0-9_.:-]{0,95}$/i;
const FORBIDDEN_DETAIL_KEY = /(token|cookie|oauth|subject|email|inventory|chat|message|credential|secret)/i;
export const PROTECTED_GAMEPLAY_TRACE_EVENT_NAMES = new Set([
  "flag_jump_clicked",
  "flag_access_loading",
  "flag_access_ready",
  "flag_access_failed",
  "flag_visit_sent",
  "flag_visit_received",
  "flag_visit_rejected",
  "population_relocation_started",
  "population_visible_ready",
  "population_visible_timeout",
  "travel_transition_released",
  "first_post_arrival_move_accepted",
  "flag_travel_clicked",
  "flag_travel_transition_started",
  "flag_travel_authority_applied",
  "flag_travel_persisted",
  "flag_visited_published",
  "flag_visited_received",
  "flag_travel_transition_released",
  "origin_presentation_frozen",
  "camera_motion_started",
  "camera_moveend",
  "destination_state_committed",
  "first_destination_pixi_paint",
  "population_required_visible_applied",
  "population_required_visible_presented",
  "post_travel_movement_buffered",
  "post_travel_movement_replayed",
  "post_travel_movement_expired",
  "population_zone_plan_lookup",
  "population_zone_plan_created",
  "population_zone_plan_reused",
  "population_zone_plan_compile_breakdown",
  "population_zone_activation_breakdown",
  "population_zone_generation_materialization_breakdown",
  "population_zone_activation_started",
  "population_zone_activation_delta",
  "population_zone_retained",
  "population_zone_activated",
  "population_zone_released",
  "population_zone_runtime_rehydrated",
  "population_zone_runtime_slept"
]);
const PROTECTED_DETAIL_KEYS = new Set([
  "activated",
  "activatedCount",
  "affectedZoneCount",
  "arrivalKind",
  "chargedTollGold",
  "connectionGeneration",
  "connectionId",
  "connectionMs",
  "combatProfileClaimMs",
  "commitMs",
  "currentGenerationLoadMs",
  "currentVersion",
  "cutoverRevision",
  "databaseMs",
  "candidateProcessingMs",
  "cameraGeneration",
  "committedDestinationCount",
  "deterministicSelectionMs",
  "destinationFlagId",
  "destinationLat",
  "destinationLon",
  "destinationZoneId",
  "durationMs",
  "durableWriteMs",
  "durableEntityCount",
  "durableEntityLoadMs",
  "entityKind",
  "entityCount",
  "flagId",
  "fromVersion",
  "geometryVersion",
  "generationInsertMs",
  "generationMaterializationMs",
  "entityStateInsertMs",
  "invariantProcessingMs",
  "kindManifestInsertMs",
  "leaseCount",
  "lockWaitMs",
  "mode",
  "movementBuffered",
  "movementRevision",
  "outcome",
  "planId",
  "planPreparationMs",
  "planStatus",
  "populationState",
  "preparationGeneration",
  "preparationReason",
  "samplePreparationMs",
  "queueWaitMs",
  "projectionInsertMs",
  "reason",
  "removalCount",
  "removedEntityCount",
  "released",
  "releasedCount",
  "relocationRevision",
  "resourceVisionRevision",
  "retained",
  "retainedCount",
  "retainedObjectCount",
  "runtimeSpawnCount",
  "runtimeRemovalMs",
  "runtimeSpawnMs",
  "sleptRuntimeActors",
  "source",
  "status",
  "serializationConstructionMs",
  "slotCount",
  "slotMaterializationMs",
  "spacingLockMs",
  "spawnSlotInsertMs",
  "suppressedEntityCount",
  "suppressionReason",
  "restoredEntityCount",
  "toVersion",
  "transitionDurationMs",
  "transactionBeginMs",
  "templateLoadMs",
  "totalCompilationMs",
  "totalActivationMs",
  "totalMaterializationMs",
  "trigger",
  "terminal",
  "upsertCount",
  "worldCalled",
  "worldLookupMs",
  "authorityLoadMs",
  "neighboringContextLoadMs",
  "otherActivationMs",
  "otherMaterializationMs",
  "registeredManifestInsertMs",
  "habitatEstimationMs",
  "habitatConstructionMs",
  "zoneCount",
  "visibleZoneCount",
  "readyVisibleZoneCount",
  "zoneId",
  "partial",
  "expectedTollGold",
  "gameplayViewGeneration",
  "pendingVisibleZoneCount",
  "rejectionCode",
  "requestId",
  "populationOwnerRequestId",
  "preparationAuthority"
]);

export class GameplayLatencyTraceStore {
  private readonly sessions = new Map<string, TraceSession>();

  start(
    playerId: string,
    releaseIdentity: GameplayTraceReleaseIdentity
  ): GameplayTraceSnapshot {
    this.prune();
    const now = Date.now();
    const session: TraceSession = {
      playerId,
      sessionTraceId: randomUUID(),
      startedAtIso: new Date(now).toISOString(),
      stoppedAtIso: null,
      startedMonotonicMs: performance.now(),
      expiresAtMs: now + ACTIVE_TTL_MS,
      events: [],
      failures: [],
      nextSequence: 1,
      ordinaryEventCount: 0,
      droppedEvents: 0,
      droppedEventsByCategory: emptyCategoryCounts(),
      droppedCriticalEvents: 0,
      releaseIdentity
    };
    this.sessions.delete(playerId);
    this.sessions.set(playerId, session);
    this.trimSessions();
    this.record(playerId, {
      traceId: session.sessionTraceId,
      source: "game",
      category: "ui",
      name: "recording_started"
    });
    return this.snapshot(playerId);
  }

  stop(playerId: string): GameplayTraceSnapshot {
    const session = this.activeSession(playerId);
    if (!session) return this.snapshot(playerId);
    this.record(playerId, {
      traceId: session.sessionTraceId,
      source: "game",
      category: "ui",
      name: "recording_stopped"
    });
    const now = Date.now();
    session.stoppedAtIso = new Date(now).toISOString();
    session.expiresAtMs = now + STOPPED_TTL_MS;
    return this.snapshot(playerId);
  }

  clear(playerId: string): GameplayTraceSnapshot {
    this.sessions.delete(playerId);
    return emptySnapshot();
  }

  isActive(playerId: string | null | undefined): boolean {
    if (!playerId) return false;
    return this.activeSession(playerId) !== null;
  }

  record(playerId: string | null | undefined, input: RecordGameplayTraceInput): boolean {
    if (!playerId) return false;
    const session = this.activeSession(playerId);
    if (!session) return false;
    if (!SAFE_NAME.test(input.name)) return false;
    const event: GameplayTraceEvent = {
      sequence: session.nextSequence++,
      sessionTraceId: session.sessionTraceId,
      traceId: safeTraceId(input.traceId) ?? session.sessionTraceId,
      source: input.source,
      category: input.category,
      name: input.name,
      wallTimeIso: safeWallTime(input.wallTimeIso),
      monotonicMs: finiteDuration(input.monotonicMs) ??
        Math.max(0, performance.now() - session.startedMonotonicMs),
      details: sanitizeDetails(input.details, input.name),
      failure: input.failure === true,
      releaseIdentity: session.releaseIdentity
    };
    const priority = eventPriority(event);
    const critical = priority > 0;
    session.expiresAtMs = Date.now() + ACTIVE_TTL_MS;
    const needsEviction = session.events.length >= MAX_EVENTS ||
      (!critical && session.ordinaryEventCount >= MAX_ORDINARY_EVENTS);
    if (needsEviction) {
      const evictionIndex = evictionIndexFor(session.events, event);
      if (evictionIndex < 0) {
        noteDroppedEvent(session, event, critical);
        return false;
      }
      const [evicted] = session.events.splice(evictionIndex, 1);
      if (evicted) {
        const evictedWasCritical = isCriticalEvent(evicted);
        noteDroppedEvent(session, evicted, evictedWasCritical);
        if (!evictedWasCritical) session.ordinaryEventCount -= 1;
      }
    }
    session.events.push(event);
    if (!critical) session.ordinaryEventCount += 1;
    if (event.failure) {
      session.failures.push(event);
      if (session.failures.length > MAX_FAILURES) session.failures.shift();
    }
    return true;
  }

  recordClientEvents(
    playerId: string,
    events: readonly RecordGameplayTraceInput[]
  ): number {
    let accepted = 0;
    for (const event of events.slice(0, 100)) {
      if (event.source !== "client") continue;
      if (this.record(playerId, event)) accepted += 1;
    }
    return accepted;
  }

  recordActive(input: RecordGameplayTraceInput): number {
    let recorded = 0;
    for (const playerId of this.sessions.keys()) {
      if (this.record(playerId, input)) recorded += 1;
    }
    return recorded;
  }

  snapshot(playerId: string): GameplayTraceSnapshot {
    this.prune();
    const session = this.sessions.get(playerId);
    if (!session) return emptySnapshot();
    return {
      schemaVersion: 2,
      active: session.stoppedAtIso === null && session.expiresAtMs > Date.now(),
      sessionTraceId: session.sessionTraceId,
      startedAtIso: session.startedAtIso,
      stoppedAtIso: session.stoppedAtIso,
      events: session.events.map(copyEvent),
      failures: session.failures.map(copyEvent),
      droppedEvents: session.droppedEvents,
      droppedEventsByCategory: { ...session.droppedEventsByCategory },
      droppedCriticalEvents: session.droppedCriticalEvents,
      expiresAtIso: new Date(session.expiresAtMs).toISOString(),
      releaseIdentity: session.releaseIdentity
    };
  }

  private activeSession(playerId: string): TraceSession | null {
    this.prune();
    const session = this.sessions.get(playerId);
    return session && session.stoppedAtIso === null ? session : null;
  }

  private prune(): void {
    const now = Date.now();
    for (const [playerId, session] of this.sessions) {
      if (session.expiresAtMs <= now) this.sessions.delete(playerId);
    }
  }

  private trimSessions(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
  }
}

export const gameplayLatencyTrace = new GameplayLatencyTraceStore();

function emptySnapshot(): GameplayTraceSnapshot {
  return {
    schemaVersion: 2,
    active: false,
    sessionTraceId: null,
    startedAtIso: null,
    stoppedAtIso: null,
    events: [],
    failures: [],
    droppedEvents: 0,
    droppedEventsByCategory: emptyCategoryCounts(),
    droppedCriticalEvents: 0,
    expiresAtIso: null,
    releaseIdentity: null
  };
}

function emptyCategoryCounts(): Record<GameplayTraceCategory, number> {
  return {
    movement: 0,
    networking: 0,
    "flag-preparation": 0,
    build: 0,
    world: 0,
    population: 0,
    database: 0,
    ui: 0
  };
}

function isCriticalEvent(event: GameplayTraceEvent): boolean {
  return eventPriority(event) > 0;
}

function eventPriority(event: GameplayTraceEvent): 0 | 1 | 2 {
  if (PROTECTED_GAMEPLAY_TRACE_EVENT_NAMES.has(event.name)) return 2;
  return event.failure ||
    event.category === "flag-preparation" ||
    event.category === "build"
    ? 1
    : 0;
}

function evictionIndexFor(
  events: readonly GameplayTraceEvent[],
  incoming: GameplayTraceEvent
): number {
  const incomingPriority = eventPriority(incoming);
  for (let priority = 0; priority <= incomingPriority; priority += 1) {
    if (priority === 2) break;
    const index = events.findIndex((event) => eventPriority(event) === priority);
    if (index >= 0) return index;
  }
  if (incomingPriority === 2) {
    const sameNameIndex = events.findIndex((event) =>
      event.name === incoming.name
    );
    if (sameNameIndex >= 0) return sameNameIndex;
    const counts = new Map<string, number>();
    for (const event of events) {
      if (eventPriority(event) !== 2) continue;
      counts.set(event.name, (counts.get(event.name) ?? 0) + 1);
    }
    return events.findIndex((event) =>
      eventPriority(event) === 2 && (counts.get(event.name) ?? 0) > 1
    );
  }
  return -1;
}

function noteDroppedEvent(
  session: TraceSession,
  event: GameplayTraceEvent,
  critical: boolean
): void {
  session.droppedEvents += 1;
  session.droppedEventsByCategory[event.category] += 1;
  if (critical) session.droppedCriticalEvents += 1;
}

function safeTraceId(value: string | undefined): string | null {
  return value && /^[a-z0-9-]{1,80}$/i.test(value) ? value : null;
}

function safeWallTime(value: string | undefined): string {
  if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && Math.abs(parsed - Date.now()) < 60 * 60_000) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function finiteDuration(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, 60 * 60_000)
    : null;
}

function sanitizeDetails(
  details: GameplayTraceDetails | undefined,
  eventName: string
): GameplayTraceDetails {
  if (!details) return {};
  const sanitized: GameplayTraceDetails = {};
  const protectedEvent = PROTECTED_GAMEPLAY_TRACE_EVENT_NAMES.has(eventName);
  for (const [key, value] of Object.entries(details).slice(0, 40)) {
    if (!SAFE_NAME.test(key) || FORBIDDEN_DETAIL_KEY.test(key)) continue;
    if (protectedEvent && !PROTECTED_DETAIL_KEYS.has(key)) continue;
    if (typeof value === "string") {
      sanitized[key] = value.slice(0, protectedEvent ? 128 : 160);
    }
    else if (typeof value === "number" && Number.isFinite(value)) sanitized[key] = value;
    else if (typeof value === "boolean" || value === null) sanitized[key] = value;
  }
  return sanitized;
}

function copyEvent(event: GameplayTraceEvent): GameplayTraceEvent {
  return { ...event, details: { ...event.details } };
}
