import {
  BUG_REPORT_ACTION_LIMIT,
  BUG_REPORT_ERROR_LIMIT,
  BUG_REPORT_HISTORY_WINDOW_MS,
  BUG_REPORT_NETWORK_LIMIT,
  BUG_REPORT_PERFORMANCE_LIMIT,
  BUG_REPORT_WIRE_MAX_BYTES,
  bugReportSubmitMessageSchema,
  type BugReportClientAction,
  type BugReportClientError,
  type BugReportClientState,
  type BugReportFrozenDiagnostics,
  type BugReportNetworkEntry,
  type BugReportPerformanceEntry,
  type BugReportSubmitMessage,
  type ClientMessage,
  type ClientTelemetrySample,
  type ServerMessage
} from "@ash-atlas/shared";

type Timestamped = { timestamp: number };

class TimeCapacityRing<T extends Timestamped> {
  private values: T[] = [];

  constructor(
    readonly capacity: number,
    private readonly windowMs = BUG_REPORT_HISTORY_WINDOW_MS
  ) {}

  push(value: T): void {
    this.evict(value.timestamp);
    this.values.push(structuredClone(value));
    if (this.values.length > this.capacity) {
      this.values.splice(0, this.values.length - this.capacity);
    }
  }

  replaceLast(value: T): void {
    if (this.values.length === 0) return this.push(value);
    this.values[this.values.length - 1] = structuredClone(value);
  }

  snapshot(markerAt: number): T[] {
    this.evict(markerAt);
    const start = markerAt - this.windowMs;
    return this.values
      .filter((value) => value.timestamp >= start && value.timestamp <= markerAt)
      .map((value) => structuredClone(value));
  }

  get size(): number {
    return this.values.length;
  }

  last(): T | null {
    return this.values.at(-1) ?? null;
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    const firstRetained = this.values.findIndex((value) => value.timestamp >= cutoff);
    if (firstRetained < 0) this.values.length = 0;
    else if (firstRetained > 0) this.values.splice(0, firstRetained);
  }
}

export type BugReportDraftSnapshot = Readonly<{
  draftId: string;
  requestId: string;
  reportMarkerAt: number;
  availableWindowStartAt: number;
  windowStartAt: number;
  windowEndAt: number;
  diagnostics: BugReportFrozenDiagnostics;
}>;

type ReportFields = Pick<
  BugReportSubmitMessage,
  "title" | "category" | "description" | "expectedBehavior" | "reproducibility"
>;

export class BugReportDiagnostics {
  private readonly actions = new TimeCapacityRing<BugReportClientAction>(
    BUG_REPORT_ACTION_LIMIT
  );
  private readonly errors = new TimeCapacityRing<BugReportClientError>(
    BUG_REPORT_ERROR_LIMIT
  );
  private readonly network = new TimeCapacityRing<BugReportNetworkEntry>(
    BUG_REPORT_NETWORK_LIMIT
  );
  private readonly performance = new TimeCapacityRing<BugReportPerformanceEntry>(
    BUG_REPORT_PERFORMANCE_LIMIT
  );
  private readonly drafts = new Map<string, BugReportDraftSnapshot>();
  private readonly pendingOperationIds = new Set<string>();
  private historyStartedAt = Date.now();
  private globalListenersInstalled = false;
  private removeGlobalListeners: (() => void) | null = null;

  noteConnected(timestamp = Date.now()): void {
    this.historyStartedAt = timestamp;
  }

  /** Fixed native event names + public build identity only. Uses the existing
   * bounded report contract; never captures URLs, cookies, tokens or account data. */
  recordNativeBoundary(action: string, runId: string): void {
    this.actions.push({ timestamp:Date.now(),kind:"ui_no_command",operationId:runId,
      targetId:null,targetType:"native-runtime",action:action.slice(0,80),outcome:"no_command",rejectionCode:null });
  }

  recordOutgoing(
    message: ClientMessage,
    timestamp: number,
    connectionGeneration: number,
    status: BugReportNetworkEntry["status"],
    approximateBytes: number
  ): void {
    const operationId = requestIdFrom(message);
    this.network.push({
      timestamp,
      direction: "outgoing",
      messageType: safeMessageType(message.type),
      approximateBytes: boundedBytes(approximateBytes),
      sequence: numericField(message, "sequence"),
      serverTick: null,
      operationId,
      status,
      connectionGeneration
    });
    if (operationId && status === "sent") this.pendingOperationIds.add(operationId);
    const action = actionFromClientMessage(message, timestamp, status);
    if (action) this.actions.push(action);
  }

  recordIncoming(
    message: ServerMessage,
    timestamp: number,
    connectionGeneration: number,
    approximateBytes: number
  ): void {
    const operationId = requestIdFrom(message);
    const status = serverMessageStatus(message);
    this.network.push({
      timestamp,
      direction: "incoming",
      messageType: safeMessageType(message.type),
      approximateBytes: boundedBytes(approximateBytes),
      sequence: numericField(message, "sequence"),
      serverTick: numericField(message, "serverTick"),
      operationId,
      status,
      connectionGeneration
    });
    if (operationId && terminalNetworkStatus(status)) {
      this.pendingOperationIds.delete(operationId);
      this.actions.push({
        timestamp,
        kind: "command_result",
        operationId,
        targetId: safeTarget(message).id,
        targetType: safeTarget(message).type,
        action: message.type,
        outcome: actionOutcome(status, message),
        rejectionCode:
          "code" in message && typeof message.code === "string"
            ? sanitizeDiagnosticText(message.code, 120)
            : null
      });
    }
  }

  recordPerformance(sample: ClientTelemetrySample, timestamp: number): void {
    this.performance.push({ timestamp, sample: structuredClone(sample) });
    if (sample.reason === "severe_frame_stall") {
      this.recordError({
        timestamp,
        category: "severe_frame_stall",
        name: "SevereFrameStall",
        message: `Frame time reached ${Math.round(sample.frameTimeMaxMs)}ms`,
        component: "render-loop"
      });
    }
  }

  recordError(input: {
    timestamp?: number;
    category: BugReportClientError["category"];
    name: string;
    message: string;
    stack?: string | null;
    component?: string | null;
    operationId?: string | null;
  }): void {
    const timestamp = input.timestamp ?? Date.now();
    const sanitizedName = sanitizeDiagnosticText(input.name, 120) || "ClientError";
    const sanitizedMessage =
      sanitizeDiagnosticText(input.message, 320) || "Client error";
    const stackFingerprint = input.stack ? fingerprint(input.stack) : null;
    const previous = this.errors.last();
    if (
      previous &&
      previous.category === input.category &&
      previous.name === sanitizedName &&
      previous.message === sanitizedMessage &&
      previous.stackFingerprint === stackFingerprint
    ) {
      this.errors.replaceLast({
        ...previous,
        timestamp,
        count: Math.min(1_000_000, previous.count + 1)
      });
      return;
    }
    this.errors.push({
      timestamp,
      category: input.category,
      name: sanitizedName,
      message: sanitizedMessage,
      stackFingerprint,
      component: input.component
        ? sanitizeDiagnosticText(input.component, 120) || null
        : null,
      operationId: input.operationId
        ? sanitizeDiagnosticText(input.operationId, 160) || null
        : null,
      count: 1
    });
  }

  recordSelection(
    targetId: string | null,
    targetType: string | null,
    timestamp = Date.now()
  ): void {
    this.actions.push({
      timestamp,
      kind: "entity_selected",
      operationId: null,
      targetId: targetId ? sanitizeDiagnosticText(targetId, 160) : null,
      targetType: targetType ? sanitizeDiagnosticText(targetType, 80) : null,
      action: "select",
      outcome: "applied",
      rejectionCode: null
    });
  }

  startDraft(markerAt: number): BugReportDraftSnapshot {
    const draftId = crypto.randomUUID();
    const windowStartAt = markerAt - BUG_REPORT_HISTORY_WINDOW_MS;
    const draft: BugReportDraftSnapshot = {
      draftId,
      requestId: crypto.randomUUID(),
      reportMarkerAt: markerAt,
      availableWindowStartAt: Math.max(windowStartAt, this.historyStartedAt),
      windowStartAt,
      windowEndAt: markerAt,
      diagnostics: {
        recentClientActions: this.actions.snapshot(markerAt),
        recentClientErrors: this.errors.snapshot(markerAt),
        networkTimeline: this.network.snapshot(markerAt),
        performanceHistory: this.performance.snapshot(markerAt)
      }
    };
    this.drafts.set(draftId, draft);
    return structuredClone(draft);
  }

  getDraft(draftId: string): BugReportDraftSnapshot | null {
    const draft = this.drafts.get(draftId);
    return draft ? structuredClone(draft) : null;
  }

  discardDraft(draftId: string): void {
    this.drafts.delete(draftId);
  }

  buildSubmission(
    draftId: string,
    connectionGeneration: number,
    fields: ReportFields,
    clientState: BugReportClientState
  ): { message: BugReportSubmitMessage; wireBytes: number } {
    const draft = this.drafts.get(draftId);
    if (!draft) throw new Error("Bug report draft is no longer available.");
    const candidate: BugReportSubmitMessage = {
      type: "BUG_REPORT_SUBMIT",
      requestId: draft.requestId,
      connectionGeneration,
      reportMarkerAt: draft.reportMarkerAt,
      availableWindowStartAt: draft.availableWindowStartAt,
      windowStartAt: draft.windowStartAt,
      windowEndAt: draft.windowEndAt,
      ...fields,
      diagnostics: structuredClone(draft.diagnostics),
      clientState: {
        ...clientState,
        pendingOperationIds: [...this.pendingOperationIds].slice(0, 32)
      }
    };
    const message = bugReportSubmitMessageSchema.parse(candidate);
    const wireBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
    if (wireBytes > BUG_REPORT_WIRE_MAX_BYTES) {
      throw new Error("The diagnostic snapshot is too large. Reopen Report a Bug and retry.");
    }
    return { message, wireBytes };
  }

  installGlobalErrorCapture(): () => void {
    if (this.globalListenersInstalled) return this.removeGlobalListeners ?? (() => {});
    const onError = (event: ErrorEvent): void => {
      this.recordError({
        category: "caught_exception",
        name: event.error instanceof Error ? event.error.name : "WindowError",
        message: event.error instanceof Error ? event.error.message : event.message,
        stack: event.error instanceof Error ? event.error.stack ?? null : null,
        component: "window"
      });
    };
    const onRejection = (event: PromiseRejectionEvent): void => {
      const reason = event.reason;
      this.recordError({
        category: "unhandled_rejection",
        name: reason instanceof Error ? reason.name : "UnhandledRejection",
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack ?? null : null,
        component: "promise"
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    this.globalListenersInstalled = true;
    this.removeGlobalListeners = () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      this.globalListenersInstalled = false;
      this.removeGlobalListeners = null;
    };
    return this.removeGlobalListeners;
  }

  sizes(): Readonly<{
    actions: number;
    errors: number;
    network: number;
    performance: number;
  }> {
    return {
      actions: this.actions.size,
      errors: this.errors.size,
      network: this.network.size,
      performance: this.performance.size
    };
  }
}

function actionFromClientMessage(
  message: ClientMessage,
  timestamp: number,
  status: BugReportNetworkEntry["status"]
): BugReportClientAction | null {
  if (
    message.type === "HELLO" ||
    message.type === "PING" ||
    message.type === "APP_SUSPEND" ||
    message.type === "TELEMETRY_BATCH" ||
    message.type === "BUG_REPORT_SUBMIT"
  ) return null;
  const operationId = requestIdFrom(message);
  const target = safeTarget(message);
  let kind: BugReportClientAction["kind"] = "command_sent";
  if (message.type === "MOVE_TO" || message.type === "MANOR_MOVE_TO") kind = "move_requested";
  else if (message.type.includes("HARVEST")) kind = "harvest_requested";
  else if (message.type.includes("ATTACK") || message.type.includes("ABILITY")) kind = "attack_requested";
  else if (message.type.includes("PICKUP")) kind = "pickup_requested";
  else if (
    message.type.includes("TRAVEL") ||
    message.type.startsWith("VISIT_") ||
    message.type.startsWith("JUMP_TO_")
  ) kind = "travel_requested";
  else if (
    message.type.includes("FLAG") ||
    message.type.includes("BUILD") ||
    message.type.includes("FOUND_")
  ) kind = "building_requested";
  else if (
    message.type.includes("INVENTORY") ||
    message.type.includes("EQUIP") ||
    message.type.includes("STACK") ||
    message.type.includes("PROTECTION")
  ) kind = "inventory_action";
  return {
    timestamp,
    kind,
    operationId,
    targetId: target.id,
    targetType: target.type,
    action: message.type,
    outcome: status === "observed" ? null : status,
    rejectionCode: null
  };
}

function safeTarget(value: object): { id: string | null; type: string | null } {
  const record = value as Record<string, unknown>;
  const candidates = [
    ["targetEntityId", "combat_entity"],
    ["entityId", "entity"],
    ["nodeId", "collectible"],
    ["dropId", "dropped_item"],
    ["flagId", "flag"],
    ["cityId", "city"],
    ["kingdomId", "kingdom"],
    ["manorId", "manor"],
    ["itemInstanceId", "item"]
  ] as const;
  for (const [key, type] of candidates) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return { id: sanitizeDiagnosticText(candidate, 160), type };
    }
  }
  return { id: null, type: null };
}

function requestIdFrom(value: object): string | null {
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.trim()
    ? sanitizeDiagnosticText(requestId, 160)
    : null;
}

function numericField(value: object, key: string): number | null {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= 0
    ? candidate
    : null;
}

function serverMessageStatus(message: ServerMessage): BugReportNetworkEntry["status"] {
  if (message.type === "ERROR" || message.type.endsWith("_ERROR")) return "rejected";
  if (/FAILED|REJECTED|INVALID/u.test(message.type)) return "failed";
  if ("success" in message && message.success === false) return "rejected";
  if (
    /ACCEPTED|COMPLETED|RESULT|CREATED|UPDATED|SNAPSHOT|WELCOME|PONG/u.test(
      message.type
    )
  ) return "accepted";
  return "observed";
}

function actionOutcome(
  status: BugReportNetworkEntry["status"],
  message: ServerMessage
): BugReportClientAction["outcome"] {
  if (
    "replayed" in message &&
    (message as Record<string, unknown>).replayed === true
  ) return "replayed";
  if (status === "accepted") return "accepted";
  if (status === "rejected") return "rejected";
  if (status === "failed") return "failed";
  return "applied";
}

function terminalNetworkStatus(status: BugReportNetworkEntry["status"]): boolean {
  return status === "accepted" || status === "rejected" || status === "failed";
}

function safeMessageType(type: string): string {
  return /^[A-Z0-9_]{1,80}$/u.test(type) ? type : "UNKNOWN";
}

function boundedBytes(value: number): number {
  return Math.max(0, Math.min(BUG_REPORT_WIRE_MAX_BYTES, Math.round(value)));
}

export function sanitizeDiagnosticText(value: string, maximumLength: number): string {
  return stripUnsafeControlCharacters(value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted email]")
    .replace(/\b(?:https?|wss?):\/\/[^\s]+/giu, "[redacted URL]")
    .replace(
      /\b(?:bearer\s+|token[=:]\s*|password[=:]\s*|secret[=:]\s*)[A-Za-z0-9._~+/=-]{8,}/giu,
      "[redacted secret]"
    ))
    .slice(0, maximumLength);
}

function stripUnsafeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
      ? ""
      : character;
  }).join("");
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export const bugReportDiagnostics = new BugReportDiagnostics();
