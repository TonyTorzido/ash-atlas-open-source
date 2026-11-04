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

type PendingClientEvent = {
  traceId?: string;
  source: "client";
  category: GameplayTraceCategory;
  name: string;
  wallTimeIso: string;
  monotonicMs: number;
  details?: GameplayTraceDetails;
  failure?: boolean;
};

type Subscriber = (snapshot: GameplayTraceSnapshot) => void;

const FLUSH_INTERVAL_MS = 100;
const MAX_PENDING_EVENTS = 200;
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

export class GameplayLatencyTraceClient {
  private serverHttpBase = "";
  private csrfToken = "";
  private active = false;
  private sessionTraceId: string | null = null;
  private startedAtPerformanceMs = 0;
  private pending: PendingClientEvent[] = [];
  private flushTimer: number | null = null;
  private subscribers = new Set<Subscriber>();
  private lastSnapshot: GameplayTraceSnapshot = emptySnapshot();

  configure(serverHttpBase: string, csrfToken: string): void {
    this.serverHttpBase = serverHttpBase;
    this.csrfToken = csrfToken;
  }

  isRecording(): boolean {
    return this.active;
  }

  sessionId(): string | null {
    return this.sessionTraceId;
  }

  newTraceId(): string {
    return crypto.randomUUID();
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.lastSnapshot);
    return () => this.subscribers.delete(subscriber);
  }

  async start(): Promise<GameplayTraceSnapshot> {
    const snapshot = await this.request("/api/diagnostics/gameplay-latency-trace/start", {
      method: "POST"
    });
    this.active = snapshot.active;
    this.sessionTraceId = snapshot.sessionTraceId;
    this.startedAtPerformanceMs = performance.now();
    this.pending = [];
    this.update(snapshot);
    this.record("ui", "client_recording_started", {
      browserVisibility: document.visibilityState
    });
    return snapshot;
  }

  async stop(): Promise<GameplayTraceSnapshot> {
    this.record("ui", "client_recording_stopped");
    await this.flush();
    const snapshot = await this.request("/api/diagnostics/gameplay-latency-trace/stop", {
      method: "POST"
    });
    this.active = false;
    this.sessionTraceId = snapshot.sessionTraceId;
    this.update(snapshot);
    return snapshot;
  }

  async clear(): Promise<GameplayTraceSnapshot> {
    this.cancelFlush();
    this.pending = [];
    const snapshot = await this.request("/api/diagnostics/gameplay-latency-trace", {
      method: "DELETE"
    });
    this.active = false;
    this.sessionTraceId = null;
    this.update(snapshot);
    return snapshot;
  }

  async refresh(): Promise<GameplayTraceSnapshot> {
    await this.flush();
    const snapshot = await this.request("/api/diagnostics/gameplay-latency-trace");
    this.active = snapshot.active;
    this.sessionTraceId = snapshot.sessionTraceId;
    this.update(snapshot);
    return snapshot;
  }

  mark(label = "Developer mark"): void {
    this.record("ui", "moment_marked", { label });
  }

  record(
    category: GameplayTraceCategory,
    name: string,
    details?: GameplayTraceDetails,
    options: { traceId?: string; failure?: boolean } = {}
  ): boolean {
    if (!this.active) return false;
    if (this.pending.length >= MAX_PENDING_EVENTS) {
      if (!PROTECTED_GAMEPLAY_TRACE_EVENT_NAMES.has(name)) return false;
      const ordinaryIndex = this.pending.findIndex((event) =>
        !PROTECTED_GAMEPLAY_TRACE_EVENT_NAMES.has(event.name)
      );
      const replaceIndex = ordinaryIndex >= 0
        ? ordinaryIndex
        : protectedReplacementIndex(this.pending, name);
      if (replaceIndex < 0) return false;
      this.pending.splice(replaceIndex, 1);
    }
    this.pending.push({
      ...(options.traceId ? { traceId: options.traceId } : {}),
      source: "client",
      category,
      name,
      wallTimeIso: new Date().toISOString(),
      monotonicMs: Math.max(0, performance.now() - this.startedAtPerformanceMs),
      ...(details ? { details: sanitizeDetails(details, name) } : {}),
      ...(options.failure ? { failure: true } : {})
    });
    this.scheduleFlush();
    return true;
  }

  recordFlagVisitedReceived(
    details: {
      flagId?: string | undefined;
      destinationFlagId?: string | undefined;
      arrivalKind?: "warm" | "cold" | undefined;
      transitionDurationMs?: number | undefined;
      relocationRevision?: number | undefined;
      movementBuffered?: boolean | undefined;
      worldCalled?: boolean | undefined;
    },
    traceId?: string
  ): boolean {
    const boundedDetails: GameplayTraceDetails = {};
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined) boundedDetails[key] = value;
    }
    const recorded = this.record(
      "movement",
      "flag_visited_received",
      boundedDetails,
      { ...(traceId ? { traceId } : {}) }
    );
    this.record(
      "movement",
      "flag_visit_received",
      boundedDetails,
      { ...(traceId ? { traceId } : {}) }
    );
    return recorded;
  }

  recordFlagTravelClicked(
    details: {
      arrivalKind?: "warm" | "cold" | undefined;
      flagId?: string | undefined;
      destinationLat?: number | undefined;
      destinationLon?: number | undefined;
    },
    traceId: string
  ): boolean {
    const boundedDetails: GameplayTraceDetails = {};
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined) boundedDetails[key] = value;
    }
    return this.record(
      "population",
      "flag_travel_clicked",
      boundedDetails,
      { traceId }
    );
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  private cancelFlush(): void {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async flush(): Promise<void> {
    this.cancelFlush();
    if (!this.active || this.pending.length === 0) return;
    const events = this.pending.splice(0, 100);
    try {
      await this.request("/api/diagnostics/gameplay-latency-trace/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events })
      });
    } catch {
      this.pending = retainBoundedPendingEvents([...events, ...this.pending]);
    }
    if (this.pending.length > 0) this.scheduleFlush();
  }

  private async request(
    path: string,
    init: RequestInit = {}
  ): Promise<GameplayTraceSnapshot> {
    if (!this.serverHttpBase) throw new Error("Gameplay trace client is not configured.");
    const mutation = init.method !== undefined &&
      !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase());
    const response = await fetch(new URL(path, this.serverHttpBase), {
      credentials: "include",
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(mutation ? { "x-csrf-token": this.csrfToken } : {})
      }
    });
    if (!response.ok) {
      throw new Error(`Gameplay latency trace request failed (${response.status}).`);
    }
    return response.json() as Promise<GameplayTraceSnapshot>;
  }

  private update(snapshot: GameplayTraceSnapshot): void {
    this.lastSnapshot = snapshot;
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }
}

export const gameplayLatencyTrace = new GameplayLatencyTraceClient();

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

function sanitizeDetails(
  details: GameplayTraceDetails,
  eventName: string
): GameplayTraceDetails {
  const sanitized: GameplayTraceDetails = {};
  const protectedEvent = PROTECTED_GAMEPLAY_TRACE_EVENT_NAMES.has(eventName);
  for (const [key, value] of Object.entries(details).slice(0, 40)) {
    if (/(token|cookie|oauth|subject|email|inventory|chat|credential|secret)/i.test(key)) continue;
    if (protectedEvent && !PROTECTED_DETAIL_KEYS.has(key)) continue;
    if (typeof value === "string") {
      sanitized[key] = value.slice(0, protectedEvent ? 128 : 160);
    }
    else if (typeof value === "number" && Number.isFinite(value)) sanitized[key] = value;
    else if (typeof value === "boolean" || value === null) sanitized[key] = value;
  }
  return sanitized;
}

export function gameplayTraceCsv(snapshot: GameplayTraceSnapshot): string {
  const headers = [
    "sequence", "wallTimeIso", "monotonicMs", "source", "category",
    "name", "traceId", "failure", "details"
  ];
  const rows = snapshot.events.map((event) => [
    event.sequence,
    event.wallTimeIso,
    event.monotonicMs.toFixed(3),
    event.source,
    event.category,
    event.name,
    event.traceId,
    event.failure,
    JSON.stringify(event.details)
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value: unknown): string {
  return `"${String(value).replaceAll("\"", "\"\"")}"`;
}

function retainBoundedPendingEvents(
  events: readonly PendingClientEvent[]
): PendingClientEvent[] {
  const retained: PendingClientEvent[] = [];
  for (const event of events) {
    if (retained.length < MAX_PENDING_EVENTS) {
      retained.push(event);
      continue;
    }
    if (!PROTECTED_GAMEPLAY_TRACE_EVENT_NAMES.has(event.name)) continue;
    const ordinaryIndex = retained.findIndex((candidate) =>
      !PROTECTED_GAMEPLAY_TRACE_EVENT_NAMES.has(candidate.name)
    );
    const replaceIndex = ordinaryIndex >= 0
      ? ordinaryIndex
      : protectedReplacementIndex(retained, event.name);
    if (replaceIndex < 0) continue;
    retained.splice(replaceIndex, 1);
    retained.push(event);
  }
  return retained;
}

function protectedReplacementIndex(
  events: readonly PendingClientEvent[],
  incomingName: string
): number {
  const sameNameIndex = events.findIndex((event) =>
    event.name === incomingName
  );
  if (sameNameIndex >= 0) return sameNameIndex;
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.name, (counts.get(event.name) ?? 0) + 1);
  }
  return events.findIndex((event) => (counts.get(event.name) ?? 0) > 1);
}
