import {
  PROGRESSION_BALANCE_VERSION,
  PROGRESSION_CURVE_VERSION,
  TARGET_NORMAL_XP_PER_ACTIVE_HOUR,
  type EquipmentSnapshot,
  type ProgressionSnapshot
} from "@ash-atlas/shared";

export const PROGRESSION_RECORDING_IDLE_THRESHOLD_MS = 45_000;
export const MAX_PROGRESSION_RECORDING_EVENTS = 5_000;

export type ProgressionEventType =
  | "movement"
  | "combat_engaged"
  | "combat_damage"
  | "mob_defeated"
  | "player_defeated"
  | "harvest_started"
  | "harvest_completed"
  | "harvest_cancelled"
  | "xp_granted"
  | "equipment_changed"
  | "flag_visited"
  | "flag_created"
  | "menu_opened"
  | "menu_closed"
  | "loop_start"
  | "loop_end";

export type ProgressionRecordingEventInput = {
  type: ProgressionEventType;
  sourceType?: string | null;
  sourceId?: string | null;
  mobArchetype?: string | null;
  mobLevel?: number | null;
  resourceType?: string | null;
  durationMs?: number | null;
  xpRequested?: number;
  xpGranted?: number;
  playerLevel?: number;
  groupSize?: number | null;
  contributionShare?: number | null;
  levelMultiplier?: number | null;
  distanceM?: number | null;
  quantity?: number | null;
  damageDealt?: number | null;
  damageReceived?: number | null;
  meaningful?: boolean;
};

export type ProgressionRecordingEvent = Omit<
  ProgressionRecordingEventInput,
  "meaningful"
> & {
  timestamp: string;
  elapsedMs: number;
  activeElapsedMs: number;
  loopId: number | null;
  weaponDefinition: string | null;
  chestDefinition: string | null;
  metadataVersion: 1;
};

export type ProgressionLoopSummary = {
  loopId: number;
  startFlagId: string | null;
  endFlagId: string | null;
  wallDurationMs: number;
  activeDurationMs: number;
  xp: number;
  mobsDefeated: number;
  harvestCompletions: number;
  xpPerActiveHour: number;
  manual: boolean;
};

export type ProgressionRecordingSummary = {
  wallDurationMs: number;
  activeDurationMs: number;
  idleDurationMs: number;
  combatDurationMs: number;
  travelDurationMs: number;
  harvestDurationMs: number;
  menuDurationMs: number;
  unclassifiedActiveDurationMs: number;
  totalXp: number;
  xpPerActiveHour: number;
  xpPerWallHour: number;
  actionsPerActiveMinute: number;
  combatXp: number;
  harvestXp: number;
  otherXp: number;
  mobsDefeated: number;
  averageTtkMs: number;
  harvestCompletions: number;
  averageHarvestDurationMs: number;
  completedLoops: number;
  averageLoopDurationMs: number;
  averageXpPerLoop: number;
  targetXpPerActiveHour: number;
  percentOfTarget: number;
};

export type ProgressionRecording = {
  formatVersion: 1;
  app: "ash-atlas";
  progressionCurveVersion: number;
  balanceVersion: number;
  startedAt: string;
  endedAt: string;
  startingProgression: ProgressionSnapshot;
  endingProgression: ProgressionSnapshot;
  startingEquipment: EquipmentSnapshot | null;
  endingEquipment: EquipmentSnapshot | null;
  runtimeConfig: {
    serverTickRateHz: number | null;
    replicationRateHz: number | null;
  };
  summary: ProgressionRecordingSummary;
  loops: ProgressionLoopSummary[];
  sourceXp: Record<string, number>;
  rawEventsTruncated: boolean;
  eventLimit: number;
  events: ProgressionRecordingEvent[];
};

export type ProgressionRecorderStatus = {
  isRecording: boolean;
  durationMs: number;
  eventCount: number;
  maxEvents: number;
  rawEventsTruncated: boolean;
  startedAt: string | null;
};

type RecordingContext = {
  progression: ProgressionSnapshot;
  equipment: EquipmentSnapshot | null;
  serverTickRateHz?: number | null;
  replicationRateHz?: number | null;
};

type Activity = "combat" | "travel" | "harvest" | "menu" | "unclassified";

type OpenLoop = {
  loopId: number;
  startFlagId: string | null;
  startMs: number;
  startActiveMs: number;
  startXp: number;
  startMobs: number;
  startHarvests: number;
  manual: boolean;
};

export class ProgressionRecorder {
  private recording: {
    context: RecordingContext;
    startedMs: number;
    startedAt: string;
    lastClockMs: number;
    lastMeaningfulMs: number;
    activity: Activity;
    activeMs: number;
    idleMs: number;
    activityMs: Record<Activity, number>;
    actionCount: number;
    totalXp: number;
    sourceXp: Record<string, number>;
    mobsDefeated: number;
    ttkTotalMs: number;
    ttkCount: number;
    harvestCompletions: number;
    harvestDurationTotalMs: number;
    harvestStarts: Map<string, number>;
    engagements: Map<string, number>;
    events: ProgressionRecordingEvent[];
    truncated: boolean;
    loops: ProgressionLoopSummary[];
    openLoop: OpenLoop | null;
    nextLoopId: number;
    lastFlagId: string | null;
  } | null = null;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxEvents = MAX_PROGRESSION_RECORDING_EVENTS
  ) {}

  start(context: RecordingContext): void {
    const now = this.now();
    this.recording = {
      context: structuredClone(context),
      startedMs: now,
      startedAt: new Date(now).toISOString(),
      lastClockMs: now,
      lastMeaningfulMs: now,
      activity: "unclassified",
      activeMs: 0,
      idleMs: 0,
      activityMs: { combat: 0, travel: 0, harvest: 0, menu: 0, unclassified: 0 },
      actionCount: 0,
      totalXp: 0,
      sourceXp: {},
      mobsDefeated: 0,
      ttkTotalMs: 0,
      ttkCount: 0,
      harvestCompletions: 0,
      harvestDurationTotalMs: 0,
      harvestStarts: new Map(),
      engagements: new Map(),
      events: [],
      truncated: false,
      loops: [],
      openLoop: null,
      nextLoopId: 1,
      lastFlagId: null
    };
  }

  isRecording(): boolean {
    return this.recording !== null;
  }

  recordEvent(input: ProgressionRecordingEventInput): boolean {
    const state = this.recording;
    if (!state) return false;
    const now = this.now();
    this.accrueTime(state, now);
    const meaningful = input.meaningful !== false;
    if (meaningful) {
      state.lastMeaningfulMs = now;
      state.actionCount += 1;
    }
    this.applyEvent(state, input, now);
    state.activity = activityForEvent(input.type, state.activity);
    const event: ProgressionRecordingEvent = {
      type: input.type,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      mobArchetype: input.mobArchetype ?? null,
      mobLevel: finiteOrNull(input.mobLevel),
      resourceType: input.resourceType ?? null,
      durationMs: finiteOrNull(input.durationMs),
      xpRequested: safeNonnegative(input.xpRequested),
      xpGranted: safeNonnegative(input.xpGranted),
      playerLevel: safeNonnegative(input.playerLevel ?? state.context.progression.level),
      groupSize: finiteOrNull(input.groupSize),
      contributionShare: finiteOrNull(input.contributionShare),
      levelMultiplier: finiteOrNull(input.levelMultiplier),
      distanceM: finiteOrNull(input.distanceM),
      quantity: finiteOrNull(input.quantity),
      damageDealt: finiteOrNull(input.damageDealt),
      damageReceived: finiteOrNull(input.damageReceived),
      timestamp: new Date(now).toISOString(),
      elapsedMs: now - state.startedMs,
      activeElapsedMs: state.activeMs,
      loopId: state.openLoop?.loopId ?? null,
      weaponDefinition: state.context.equipment?.weapon?.definitionId ?? null,
      chestDefinition: state.context.equipment?.chest?.definitionId ?? null,
      metadataVersion: 1
    };
    if (state.events.length < this.maxEvents) state.events.push(event);
    else state.truncated = true;
    return true;
  }

  markLoopStart(): boolean {
    if (!this.recording) return false;
    const now = this.now();
    this.accrueTime(this.recording, now);
    if (this.recording.openLoop) this.finishLoop(this.recording, now, null);
    this.openLoop(this.recording, now, null, true);
    this.recordEvent({ type: "loop_start" });
    return true;
  }

  markLoopEnd(): boolean {
    if (!this.recording?.openLoop) return false;
    const now = this.now();
    this.accrueTime(this.recording, now);
    this.recordEvent({ type: "loop_end" });
    this.finishLoop(this.recording, now, null);
    return true;
  }

  stop(ending: { progression: ProgressionSnapshot; equipment: EquipmentSnapshot | null }): ProgressionRecording | null {
    const state = this.recording;
    if (!state) return null;
    const now = this.now();
    this.accrueTime(state, now);
    const summary = summarize(state, now - state.startedMs);
    const recording: ProgressionRecording = {
      formatVersion: 1,
      app: "ash-atlas",
      progressionCurveVersion: PROGRESSION_CURVE_VERSION,
      balanceVersion: PROGRESSION_BALANCE_VERSION,
      startedAt: state.startedAt,
      endedAt: new Date(now).toISOString(),
      startingProgression: structuredClone(state.context.progression),
      endingProgression: structuredClone(ending.progression),
      startingEquipment: structuredClone(state.context.equipment),
      endingEquipment: structuredClone(ending.equipment),
      runtimeConfig: {
        serverTickRateHz: state.context.serverTickRateHz ?? null,
        replicationRateHz: state.context.replicationRateHz ?? null
      },
      summary,
      loops: structuredClone(state.loops),
      sourceXp: { ...state.sourceXp },
      rawEventsTruncated: state.truncated,
      eventLimit: this.maxEvents,
      events: structuredClone(state.events)
    };
    this.recording = null;
    return recording;
  }

  reset(): void {
    this.recording = null;
  }

  getStatus(): ProgressionRecorderStatus {
    const state = this.recording;
    return {
      isRecording: state !== null,
      durationMs: state ? Math.max(0, this.now() - state.startedMs) : 0,
      eventCount: state?.events.length ?? 0,
      maxEvents: this.maxEvents,
      rawEventsTruncated: state?.truncated ?? false,
      startedAt: state?.startedAt ?? null
    };
  }

  private accrueTime(state: NonNullable<ProgressionRecorder["recording"]>, now: number): void {
    const start = state.lastClockMs;
    if (now <= start) return;
    const idleBoundary = state.lastMeaningfulMs + PROGRESSION_RECORDING_IDLE_THRESHOLD_MS;
    const activeEnd = Math.min(now, Math.max(start, idleBoundary));
    const activeDelta = Math.max(0, activeEnd - start);
    const idleDelta = Math.max(0, now - Math.max(start, idleBoundary));
    state.activeMs += activeDelta;
    state.idleMs += idleDelta;
    state.activityMs[state.activity] += activeDelta;
    state.lastClockMs = now;
  }

  private applyEvent(
    state: NonNullable<ProgressionRecorder["recording"]>,
    input: ProgressionRecordingEventInput,
    now: number
  ): void {
    if (input.type === "combat_engaged" && input.sourceId) {
      state.engagements.set(input.sourceId, now);
    }
    if (input.type === "mob_defeated") {
      state.mobsDefeated += 1;
      const started = input.sourceId ? state.engagements.get(input.sourceId) : undefined;
      const duration = input.durationMs ?? (started === undefined ? null : now - started);
      if (duration !== null && duration >= 0) {
        state.ttkTotalMs += duration;
        state.ttkCount += 1;
      }
      if (input.sourceId) state.engagements.delete(input.sourceId);
    }
    if (input.type === "harvest_started" && input.sourceId) {
      state.harvestStarts.set(input.sourceId, now);
    }
    if (input.type === "harvest_completed") {
      state.harvestCompletions += 1;
      const started = input.sourceId ? state.harvestStarts.get(input.sourceId) : undefined;
      const duration = input.durationMs ?? (started === undefined ? null : now - started);
      if (duration !== null && duration >= 0) state.harvestDurationTotalMs += duration;
      if (input.sourceId) state.harvestStarts.delete(input.sourceId);
    }
    if (input.type === "harvest_cancelled" && input.sourceId) {
      state.harvestStarts.delete(input.sourceId);
    }
    if (input.type === "xp_granted") {
      const granted = safeNonnegative(input.xpGranted);
      state.totalXp += granted;
      const source = input.sourceType ?? "other";
      state.sourceXp[source] = (state.sourceXp[source] ?? 0) + granted;
    }
    if ((input.type === "flag_visited" || input.type === "flag_created") && input.sourceId) {
      this.noteFlag(state, input.sourceId, now);
    }
  }

  private noteFlag(state: NonNullable<ProgressionRecorder["recording"]>, flagId: string, now: number): void {
    if (state.lastFlagId === flagId) return;
    if (!state.openLoop) this.openLoop(state, now, flagId, false);
    else if (!state.openLoop.manual) {
      this.finishLoop(state, now, flagId);
      this.openLoop(state, now, flagId, false);
    }
    state.lastFlagId = flagId;
  }

  private openLoop(
    state: NonNullable<ProgressionRecorder["recording"]>,
    now: number,
    flagId: string | null,
    manual: boolean
  ): void {
    state.openLoop = {
      loopId: state.nextLoopId++,
      startFlagId: flagId,
      startMs: now,
      startActiveMs: state.activeMs,
      startXp: state.totalXp,
      startMobs: state.mobsDefeated,
      startHarvests: state.harvestCompletions,
      manual
    };
  }

  private finishLoop(
    state: NonNullable<ProgressionRecorder["recording"]>,
    now: number,
    endFlagId: string | null
  ): void {
    const loop = state.openLoop;
    if (!loop) return;
    const activeDurationMs = Math.max(0, state.activeMs - loop.startActiveMs);
    const xp = state.totalXp - loop.startXp;
    state.loops.push({
      loopId: loop.loopId,
      startFlagId: loop.startFlagId,
      endFlagId,
      wallDurationMs: Math.max(0, now - loop.startMs),
      activeDurationMs,
      xp,
      mobsDefeated: state.mobsDefeated - loop.startMobs,
      harvestCompletions: state.harvestCompletions - loop.startHarvests,
      xpPerActiveHour: hourlyRate(xp, activeDurationMs),
      manual: loop.manual
    });
    state.openLoop = null;
  }
}

export const progressionRecorder = new ProgressionRecorder();

export function progressionRecordingJson(recording: ProgressionRecording): string {
  return JSON.stringify(recording, null, 2);
}

export function progressionRecordingCsv(recording: ProgressionRecording): string {
  const columns: Array<keyof ProgressionRecordingEvent> = [
    "timestamp", "elapsedMs", "activeElapsedMs", "type", "sourceType", "sourceId",
    "mobArchetype", "mobLevel", "resourceType", "durationMs", "xpRequested", "xpGranted",
    "playerLevel", "weaponDefinition", "chestDefinition", "loopId", "distanceM",
    "damageDealt", "damageReceived", "metadataVersion"
  ];
  return [
    columns.join(","),
    ...recording.events.map((event) =>
      columns.map((column) => csvCell(event[column])).join(",")
    )
  ].join("\n");
}

export function progressionRecordingFilename(startedAt: string, extension: "json" | "csv"): string {
  const date = new Date(startedAt);
  const compact = [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
    "-",
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds())
  ].join("");
  return `ash-atlas-progression-${compact}.${extension}`;
}

function summarize(
  state: NonNullable<ProgressionRecorder["recording"]>,
  wallDurationMs: number
): ProgressionRecordingSummary {
  const combatXp = state.sourceXp.combat ?? 0;
  const harvestXp = state.sourceXp.harvest ?? 0;
  const otherXp = state.totalXp - combatXp - harvestXp;
  const completedLoops = state.loops.length;
  const xpPerActiveHour = hourlyRate(state.totalXp, state.activeMs);
  return {
    wallDurationMs,
    activeDurationMs: state.activeMs,
    idleDurationMs: state.idleMs,
    combatDurationMs: state.activityMs.combat,
    travelDurationMs: state.activityMs.travel,
    harvestDurationMs: state.activityMs.harvest,
    menuDurationMs: state.activityMs.menu,
    unclassifiedActiveDurationMs: state.activityMs.unclassified,
    totalXp: state.totalXp,
    xpPerActiveHour,
    xpPerWallHour: hourlyRate(state.totalXp, wallDurationMs),
    actionsPerActiveMinute: perMinute(state.actionCount, state.activeMs),
    combatXp,
    harvestXp,
    otherXp,
    mobsDefeated: state.mobsDefeated,
    averageTtkMs: state.ttkCount === 0 ? 0 : state.ttkTotalMs / state.ttkCount,
    harvestCompletions: state.harvestCompletions,
    averageHarvestDurationMs: state.harvestCompletions === 0
      ? 0
      : state.harvestDurationTotalMs / state.harvestCompletions,
    completedLoops,
    averageLoopDurationMs: completedLoops === 0
      ? 0
      : state.loops.reduce((sum, loop) => sum + loop.wallDurationMs, 0) / completedLoops,
    averageXpPerLoop: completedLoops === 0
      ? 0
      : state.loops.reduce((sum, loop) => sum + loop.xp, 0) / completedLoops,
    targetXpPerActiveHour: TARGET_NORMAL_XP_PER_ACTIVE_HOUR,
    percentOfTarget: xpPerActiveHour / TARGET_NORMAL_XP_PER_ACTIVE_HOUR * 100
  };
}

function activityForEvent(type: ProgressionEventType, current: Activity): Activity {
  if (type === "movement" || type === "flag_visited" || type === "flag_created") return "travel";
  if (type === "combat_engaged" || type === "combat_damage" || type === "mob_defeated" || type === "player_defeated") return "combat";
  if (type.startsWith("harvest_")) return "harvest";
  if (type === "menu_opened") return "menu";
  if (type === "menu_closed") return "unclassified";
  return current;
}

function hourlyRate(value: number, durationMs: number): number {
  return durationMs <= 0 ? 0 : value * 3_600_000 / durationMs;
}

function perMinute(value: number, durationMs: number): number {
  return durationMs <= 0 ? 0 : value * 60_000 / durationMs;
}

function safeNonnegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? 0)) : 0;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
