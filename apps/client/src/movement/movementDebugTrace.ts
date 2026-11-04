import type { LatLon } from "@ash-atlas/shared";

export const MOVEMENT_TRACE_MAX_ENTRIES = 500;
const MOVEMENT_TRACE_STORAGE_KEY = "ash-atlas:movement-debug";

export type MovementTraceOutcome =
  | "accepted"
  | "held"
  | "ignored"
  | "interpolated"
  | "snapped";

export type MovementTraceEntry = {
  clientTimeMs: number;
  messageType: string;
  requestId?: string | null;
  movementGeneration?: number | null;
  movementRevision?: number | null;
  replicationSequence?: number | null;
  serverTimeMs?: number | null;
  authoritativePosition?: LatLon | null;
  renderedBefore?: LatLon | null;
  renderedAfter?: LatLon | null;
  target?: LatLon | null;
  anchor?: LatLon | null;
  correctionDistanceM?: number | null;
  rawFrameMs?: number | null;
  consumedFrameMs?: number | null;
  discardedFrameMs?: number | null;
  predictionLeadM?: number | null;
  authorityAgeMs?: number | null;
  leadCapHeld?: boolean | null;
  outcome: MovementTraceOutcome;
  reason?: string | null;
};

type MovementTraceInput = Omit<MovementTraceEntry, "clientTimeMs"> & {
  clientTimeMs?: number;
};

class MovementDebugTrace {
  private enabled = import.meta.env.DEV && readStoredEnabled();
  private readonly entries: MovementTraceEntry[] = [];

  record(input: MovementTraceInput): void {
    if (!import.meta.env.DEV || !this.enabled) {
      return;
    }
    this.entries.push({
      ...input,
      clientTimeMs: input.clientTimeMs ?? performance.now()
    });
    if (this.entries.length > MOVEMENT_TRACE_MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MOVEMENT_TRACE_MAX_ENTRIES);
    }
  }

  setEnabled(enabled: boolean): void {
    if (!import.meta.env.DEV) {
      return;
    }
    this.enabled = enabled;
    writeStoredEnabled(enabled);
  }

  isEnabled(): boolean {
    return import.meta.env.DEV && this.enabled;
  }

  clear(): void {
    this.entries.length = 0;
  }

  snapshot(): MovementTraceEntry[] {
    return this.entries.map((entry) => structuredClone(entry));
  }

  json(): string {
    return JSON.stringify(this.entries, null, 2);
  }
}

const movementDebugTrace = new MovementDebugTrace();

export function recordMovementTrace(input: MovementTraceInput): void {
  movementDebugTrace.record(input);
}

export function setMovementTraceEnabled(enabled: boolean): void {
  movementDebugTrace.setEnabled(enabled);
}

export function movementTraceEnabled(): boolean {
  return movementDebugTrace.isEnabled();
}

export function clearMovementTrace(): void {
  movementDebugTrace.clear();
}

export function getMovementTrace(): MovementTraceEntry[] {
  return movementDebugTrace.snapshot();
}

export function movementTraceJson(): string {
  return movementDebugTrace.json();
}

if (import.meta.env.DEV) {
  Object.defineProperty(globalThis, "ashAtlasMovementTrace", {
    configurable: true,
    value: {
      enable: () => setMovementTraceEnabled(true),
      disable: () => setMovementTraceEnabled(false),
      clear: clearMovementTrace,
      entries: getMovementTrace,
      json: movementTraceJson,
      copy: async (): Promise<string> => {
        const json = movementTraceJson();
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          await navigator.clipboard.writeText(json);
        }
        return json;
      }
    }
  });
}

function readStoredEnabled(): boolean {
  try {
    const enabledByQuery = typeof location !== "undefined" &&
      new URLSearchParams(location.search).get("movementDebug") === "1";
    return enabledByQuery || (
      typeof localStorage !== "undefined" &&
      localStorage.getItem(MOVEMENT_TRACE_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

function writeStoredEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(MOVEMENT_TRACE_STORAGE_KEY, enabled ? "1" : "0");
    }
  } catch {
    // Development diagnostics must never affect gameplay.
  }
}
