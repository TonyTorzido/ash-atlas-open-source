import type {
  GameplayTraceEvent,
  GameplayTraceReleaseIdentity,
  GameplayTraceSnapshot
} from "./gameplayLatencyTrace.js";

export type ColdVisitSampleValidation = Readonly<{
  traceId: string;
  valid: boolean;
  rejectionReasons: string[];
  releaseIdentity: GameplayTraceReleaseIdentity | null;
  relocationRevision: number | null;
  flagId: string | null;
  destinationLat: number | null;
  destinationLon: number | null;
  destinationZoneId: string | null;
}>;

export type ColdVisitValidation = Readonly<{
  acceptedTraceIds: string[];
  rejectedTraceIds: string[];
  samples: ColdVisitSampleValidation[];
}>;

export type GameplayTraceBoundaryId =
  | "flag-travel-server-commit"
  | "flag-travel-client"
  | "flag-travel-client-warm"
  | "flag-travel-client-cold"
  | "flag-travel-client-state-commit"
  | "flag-travel-client-first-paint"
  | "flag-travel-client-cold-first-paint"
  | "flag-travel-client-required-visible"
  | "flag-travel-controls-accepted"
  | "post-travel-buffer-replay"
  | "post-travel-movement-acceptance"
  | "population-plan-lookup"
  | "population-runtime-rehydrate";

export type GameplayTraceBoundaryAnalysis = {
  boundaryId: GameplayTraceBoundaryId;
  startEvent: string;
  endEvents: string[];
  targetP95Ms: number | null;
  sampleCount: number;
  incompleteStartCount: number;
  minimumMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  maximumMs: number | null;
  targetMet: boolean | null;
};

export type GameplayTraceAnalysis = {
  schemaVersion: 1;
  percentileMethod: "nearest-rank";
  durationClock: "same-source-monotonic-otherwise-wall";
  boundaries: GameplayTraceBoundaryAnalysis[];
};

export type GameplayTraceExport = {
  schemaVersion: 3;
  trace: GameplayTraceSnapshot;
  boundaryAnalysis: GameplayTraceAnalysis;
  coldVisitValidation: ColdVisitValidation;
};

type BoundaryDefinition = {
  boundaryId: GameplayTraceBoundaryId;
  startEvent: string;
  endEvents: string[];
  targetP95Ms: number | null;
  startMatches?(
    event: GameplayTraceEvent,
    traceEvents: readonly GameplayTraceEvent[]
  ): boolean;
};

const DEFINITIONS: readonly BoundaryDefinition[] = [
  {
    boundaryId: "flag-travel-server-commit",
    startEvent: "flag_travel_transition_started",
    endEvents: ["flag_visited_published"],
    targetP95Ms: 100
  },
  {
    boundaryId: "flag-travel-client",
    startEvent: "flag_travel_clicked",
    endEvents: ["flag_visited_received"],
    targetP95Ms: null
  },
  {
    boundaryId: "flag-travel-client-warm",
    startEvent: "flag_travel_clicked",
    endEvents: ["flag_visited_received"],
    targetP95Ms: 200,
    startMatches: (_event, traceEvents) =>
      populationStateForTrace(traceEvents) === "warm"
  },
  {
    boundaryId: "flag-travel-client-cold",
    startEvent: "flag_travel_clicked",
    endEvents: ["flag_visited_received"],
    targetP95Ms: 300,
    startMatches: (_event, traceEvents) =>
      populationStateForTrace(traceEvents) === "cold"
  },
  {
    boundaryId: "flag-travel-client-state-commit",
    startEvent: "flag_travel_clicked",
    endEvents: ["destination_state_committed"],
    targetP95Ms: null
  },
  {
    boundaryId: "flag-travel-client-first-paint",
    startEvent: "flag_travel_clicked",
    endEvents: ["first_destination_pixi_paint"],
    targetP95Ms: null
  },
  {
    boundaryId: "flag-travel-client-cold-first-paint",
    startEvent: "flag_travel_clicked",
    endEvents: ["first_destination_pixi_paint"],
    targetP95Ms: null,
    startMatches: (_event, traceEvents) =>
      populationStateForTrace(traceEvents) === "cold"
  },
  {
    boundaryId: "flag-travel-client-required-visible",
    startEvent: "flag_travel_clicked",
    endEvents: ["population_required_visible_presented"],
    targetP95Ms: null
  },
  {
    boundaryId: "flag-travel-controls-accepted",
    startEvent: "flag_travel_clicked",
    endEvents: ["first_post_arrival_move_accepted"],
    targetP95Ms: null
  },
  {
    boundaryId: "post-travel-buffer-replay",
    startEvent: "post_travel_movement_buffered",
    endEvents: ["post_travel_movement_replayed"],
    targetP95Ms: 150
  },
  {
    boundaryId: "post-travel-movement-acceptance",
    startEvent: "movement_request_transmitted",
    endEvents: ["movement_acceptance_received"],
    targetP95Ms: 150,
    startMatches: (event) =>
      event.details.postTravel === true ||
      typeof event.details.boundTravelRequestId === "string"
  },
  {
    boundaryId: "population-plan-lookup",
    startEvent: "population_zone_plan_lookup",
    endEvents: [
      "population_zone_plan_created",
      "population_zone_plan_reused"
    ],
    targetP95Ms: null
  },
  {
    boundaryId: "population-runtime-rehydrate",
    startEvent: "population_zone_activation_started",
    endEvents: ["population_zone_runtime_rehydrated"],
    targetP95Ms: null
  }
];

export function analyzeGameplayTraceBoundaries(
  events: readonly GameplayTraceEvent[]
): GameplayTraceAnalysis {
  return {
    schemaVersion: 1,
    percentileMethod: "nearest-rank",
    durationClock: "same-source-monotonic-otherwise-wall",
    boundaries: DEFINITIONS.map((definition) =>
      analyzeBoundary(events, definition)
    )
  };
}

export function createGameplayTraceExport(
  snapshot: GameplayTraceSnapshot
): GameplayTraceExport {
  const coldVisitValidation = validateColdVisitSamples(snapshot);
  const rejectedTraceIds = new Set(coldVisitValidation.rejectedTraceIds);
  const validatedEvents = snapshot.events.filter((event) =>
    !rejectedTraceIds.has(event.traceId)
  );
  return {
    schemaVersion: 3,
    trace: snapshot,
    boundaryAnalysis: analyzeGameplayTraceBoundaries(validatedEvents),
    coldVisitValidation
  };
}

export function validateColdVisitSamples(
  snapshot: GameplayTraceSnapshot
): ColdVisitValidation {
  const traces = new Map<string, GameplayTraceEvent[]>();
  for (const event of snapshot.events) {
    if (!traces.has(event.traceId)) traces.set(event.traceId, []);
    traces.get(event.traceId)!.push(event);
  }
  const samples: ColdVisitSampleValidation[] = [];
  for (const [traceId, events] of traces) {
    const click = events.find((event) => event.name === "flag_travel_clicked");
    if (!click) continue;
    const published = events.find((event) => event.name === "flag_visited_published");
    const populationCandidates = events.filter((event) =>
      event.name === "population_required_visible_applied" &&
      event.details.preparationAuthority === "destination-critical"
    );
    const reasons: string[] = [];
    const expectedRelease = snapshot.releaseIdentity;
    if (!expectedRelease) reasons.push("missing_session_release_identity");
    if (events.some((event) =>
      !expectedRelease || !sameRelease(event.releaseIdentity, expectedRelease)
    )) reasons.push("release_or_deployment_boundary_mismatch");
    if (!/^[a-f0-9]{40}$/u.test(expectedRelease?.gameReleaseSha ?? "")) {
      reasons.push("invalid_game_release_sha");
    }
    if (!/^test\/t[0-9]+$/u.test(expectedRelease?.releaseGeneration ?? "")) {
      reasons.push("invalid_release_generation");
    }
    if (!published) reasons.push("request_not_traced_end_to_end");
    const clickFlagId = stringDetail(click, "flagId");
    const publishedFlagId = stringDetail(published, "flagId");
    if (!clickFlagId || !publishedFlagId || clickFlagId !== publishedFlagId) {
      reasons.push("flag_identity_mismatch");
    }
    const clickLat = numberDetail(click, "destinationLat");
    const clickLon = numberDetail(click, "destinationLon");
    const destinationLat = numberDetail(published, "destinationLat");
    const destinationLon = numberDetail(published, "destinationLon");
    if (
      clickLat === null || clickLon === null ||
      destinationLat === null || destinationLon === null ||
      Math.abs(clickLat - destinationLat) > 0.000001 ||
      Math.abs(clickLon - destinationLon) > 0.000001
    ) reasons.push("authoritative_destination_mismatch");
    const destinationZoneId = stringDetail(published, "destinationZoneId");
    const population = populationCandidates.find((event) =>
      stringDetail(event, "destinationZoneId") === destinationZoneId
    ) ?? populationCandidates.at(-1);
    if (
      !destinationZoneId ||
      stringDetail(population, "destinationZoneId") !== destinationZoneId
    ) reasons.push("destination_zone_mismatch");
    if (
      stringDetail(published, "requestId") !== traceId ||
      stringDetail(published, "populationOwnerRequestId") !== traceId ||
      stringDetail(population, "populationOwnerRequestId") !== traceId
    ) reasons.push("population_ownership_mismatch");
    if (population?.details.populationState !== "cold") {
      reasons.push("not_authoritatively_cold");
    }
    samples.push({
      traceId,
      valid: reasons.length === 0,
      rejectionReasons: [...new Set(reasons)],
      releaseIdentity: expectedRelease,
      relocationRevision: numberDetail(published, "relocationRevision"),
      flagId: publishedFlagId,
      destinationLat,
      destinationLon,
      destinationZoneId
    });
  }
  return {
    acceptedTraceIds: samples.filter((sample) => sample.valid).map((sample) => sample.traceId),
    rejectedTraceIds: samples.filter((sample) => !sample.valid).map((sample) => sample.traceId),
    samples
  };
}

function sameRelease(
  left: GameplayTraceReleaseIdentity,
  right: GameplayTraceReleaseIdentity
): boolean {
  return left.gameReleaseSha === right.gameReleaseSha &&
    left.releaseGeneration === right.releaseGeneration &&
    left.worldPipelineSha === right.worldPipelineSha;
}

function stringDetail(
  event: GameplayTraceEvent | undefined,
  key: string
): string | null {
  const value = event?.details[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberDetail(
  event: GameplayTraceEvent | undefined,
  key: string
): number | null {
  const value = event?.details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function analyzeBoundary(
  events: readonly GameplayTraceEvent[],
  definition: BoundaryDefinition
): GameplayTraceBoundaryAnalysis {
  const eventsByTrace = new Map<string, GameplayTraceEvent[]>();
  for (const event of events) {
    const traceEvents = eventsByTrace.get(event.traceId) ?? [];
    traceEvents.push(event);
    eventsByTrace.set(event.traceId, traceEvents);
  }
  const starts = events.filter((event) =>
    event.name === definition.startEvent &&
    (definition.startMatches?.(
      event,
      eventsByTrace.get(event.traceId) ?? []
    ) ?? true)
  );
  const terminalNames = new Set(definition.endEvents);
  const terminalByTrace = new Map<string, GameplayTraceEvent[]>();
  for (const event of events) {
    if (!terminalNames.has(event.name)) continue;
    const terminals = terminalByTrace.get(event.traceId) ?? [];
    terminals.push(event);
    terminalByTrace.set(event.traceId, terminals);
  }
  for (const terminals of terminalByTrace.values()) {
    terminals.sort((left, right) => left.sequence - right.sequence);
  }
  const usedTerminalSequences = new Set<number>();
  const durations: number[] = [];
  let incompleteStartCount = 0;
  for (const start of [...starts].sort((left, right) =>
    left.sequence - right.sequence
  )) {
    const terminal = terminalByTrace.get(start.traceId)?.find((candidate) =>
      !usedTerminalSequences.has(candidate.sequence) &&
      candidate.sequence > start.sequence
    );
    if (!terminal) {
      incompleteStartCount += 1;
      continue;
    }
    const duration = eventDurationMs(start, terminal);
    if (duration === null) {
      incompleteStartCount += 1;
      continue;
    }
    usedTerminalSequences.add(terminal.sequence);
    durations.push(duration);
  }
  durations.sort((left, right) => left - right);
  const p95Ms = nearestRank(durations, 0.95);
  const targetMet = definition.targetP95Ms === null || p95Ms === null
    ? null
    : p95Ms <= definition.targetP95Ms;
  return {
    boundaryId: definition.boundaryId,
    startEvent: definition.startEvent,
    endEvents: [...definition.endEvents],
    targetP95Ms: definition.targetP95Ms,
    sampleCount: durations.length,
    incompleteStartCount,
    minimumMs: durations[0] ?? null,
    medianMs: nearestRank(durations, 0.5),
    p95Ms,
    maximumMs: durations.at(-1) ?? null,
    targetMet
  };
}

function populationStateForTrace(
  events: readonly GameplayTraceEvent[]
): "cold" | "warm" | "indeterminate" {
  const states = events
    .filter((event) => event.name === "population_required_visible_applied")
    .map((event) => event.details.populationState);
  if (states.includes("cold")) return "cold";
  if (states.length > 0 && states.every((state) => state === "warm")) {
    return "warm";
  }
  return "indeterminate";
}

function eventDurationMs(
  start: GameplayTraceEvent,
  end: GameplayTraceEvent
): number | null {
  const duration = start.source === end.source
    ? end.monotonicMs - start.monotonicMs
    : Date.parse(end.wallTimeIso) - Date.parse(start.wallTimeIso);
  return Number.isFinite(duration) && duration >= 0
    ? Math.round(duration * 1_000) / 1_000
    : null;
}

function nearestRank(
  sortedValues: readonly number[],
  percentile: number
): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.max(
    0,
    Math.ceil(percentile * sortedValues.length) - 1
  );
  return sortedValues[index] ?? null;
}
