import type { PlayerSnapshot, ResourceVision, ResourceVisionStatus } from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";

import { formatPerfSummary, perfMetrics } from "../perf/perfMetrics.js";
import type { PerformanceRecorderStatus } from "../perf/perfRecorder.js";
import {
  clearMovementTrace,
  getMovementTrace,
  movementTraceEnabled,
  movementTraceJson,
  MOVEMENT_TRACE_MAX_ENTRIES,
  setMovementTraceEnabled
} from "../movement/movementDebugTrace.js";
import { parseDevConsoleCommand } from "./devConsoleCommands.js";

type DevConsoleProps = {
  open: boolean;
  serverHttpBase: string;
  csrfToken: string;
  flagCount: number;
  player: PlayerSnapshot | null;
  resourceVision: ResourceVision | null;
  resourceVisionStatus: ResourceVisionStatus | null;
  visibleCollectibleCount: number;
  waterHighlightCount: number;
  recordingStatus: PerformanceRecorderStatus;
  lastRecordingFilename: string | null;
  onClose(): void;
  onStartPerformanceRecording(): string;
  onStopPerformanceRecording(): string;
  onResetPerformanceRecording(): string;
  onFlagsCleared(): void;
  onTeleport(lat: number, lon: number): boolean;
};

type ConsoleLine = {
  id: number;
  text: string;
  tone: "input" | "info" | "error";
};

const HELP_TEXT = [
  "help",
  "clear",
  "flags clear",
  "flags count",
  "spawns count",
  "resources vision",
  "player where",
  "perf",
  "perf reset",
  "perf record start",
  "perf record stop",
  "perf record status",
  "perf record reset",
  "movement trace on|off|status|clear|copy",
  "tp <lat> <lon>",
  "teleport <lat>,<lon>"
].join(" | ");

export function DevConsole({
  open,
  serverHttpBase,
  csrfToken,
  flagCount,
  player,
  resourceVision,
  resourceVisionStatus,
  visibleCollectibleCount,
  waterHighlightCount,
  recordingStatus,
  lastRecordingFilename,
  onClose,
  onStartPerformanceRecording,
  onStopPerformanceRecording,
  onResetPerformanceRecording,
  onFlagsCleared,
  onTeleport
}: DevConsoleProps): React.JSX.Element | null {
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<ConsoleLine[]>([
    { id: 1, text: `Ash Atlas dev console. ${HELP_TEXT}`, tone: "info" }
  ]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nextLineId = useRef(2);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const appendLine = (text: string, tone: ConsoleLine["tone"] = "info"): void => {
    const id = nextLineId.current;
    nextLineId.current += 1;
    setLines((current) => [...current, { id, text, tone }]);
  };

  const runCommand = async (rawCommand: string): Promise<void> => {
    const command = rawCommand.trim();
    if (!command) {
      return;
    }
    appendLine(`> ${command}`, "input");
    setHistory((current) => [...current, command]);
    setHistoryIndex(null);

    const parsed = parseDevConsoleCommand(command);
    if (parsed.type === "help") {
      appendLine(HELP_TEXT);
      return;
    }
    if (parsed.type === "clear") {
      setLines([]);
      return;
    }
    if (parsed.type === "flags-count") {
      await fetchFlagCount(serverHttpBase, flagCount, appendLine);
      return;
    }
    if (parsed.type === "flags-clear") {
      const cleared = await clearFlags(serverHttpBase, csrfToken, appendLine);
      if (cleared) {
        onFlagsCleared();
      }
      return;
    }
    if (parsed.type === "spawns-count") {
      await fetchSpawnCount(serverHttpBase, appendLine);
      return;
    }
    if (parsed.type === "resources-vision") {
      appendLine(
        formatResourceVision(
          resourceVision,
          resourceVisionStatus,
          visibleCollectibleCount,
          waterHighlightCount
        )
      );
      return;
    }
    if (parsed.type === "player-where") {
      appendLine(
        player
          ? `player ${player.playerId.slice(0, 8)} lat=${player.lat.toFixed(
              6
            )} lon=${player.lon.toFixed(6)} anchor=${player.anchorLat.toFixed(
              6
            )},${player.anchorLon.toFixed(6)} leash=${player.moveLeashRadiusM.toFixed(0)}m`
          : "player unknown"
      );
      return;
    }
    if (parsed.type === "perf") {
      appendLine(formatPerfSummary(perfMetrics.getSnapshot()));
      return;
    }
    if (parsed.type === "perf-reset") {
      perfMetrics.resetCounters();
      appendLine("performance counters reset");
      return;
    }
    if (parsed.type === "perf-record-start") {
      appendLine(onStartPerformanceRecording());
      return;
    }
    if (parsed.type === "perf-record-stop") {
      appendLine(onStopPerformanceRecording());
      return;
    }
    if (parsed.type === "perf-record-status") {
      appendLine(formatRecordingStatus(recordingStatus, lastRecordingFilename));
      return;
    }
    if (parsed.type === "perf-record-reset") {
      appendLine(onResetPerformanceRecording());
      return;
    }
    if (parsed.type === "movement-trace-on") {
      clearMovementTrace();
      setMovementTraceEnabled(true);
      appendLine(
        movementTraceEnabled()
          ? "movement trace enabled and cleared"
          : "movement trace is unavailable outside a development build"
      );
      return;
    }
    if (parsed.type === "movement-trace-off") {
      setMovementTraceEnabled(false);
      appendLine("movement trace disabled");
      return;
    }
    if (parsed.type === "movement-trace-status") {
      appendLine(
        `movement trace=${movementTraceEnabled() ? "ON" : "OFF"} entries=${
          getMovementTrace().length
        }/${MOVEMENT_TRACE_MAX_ENTRIES}`
      );
      return;
    }
    if (parsed.type === "movement-trace-clear") {
      clearMovementTrace();
      appendLine("movement trace cleared");
      return;
    }
    if (parsed.type === "movement-trace-copy") {
      const entries = getMovementTrace();
      try {
        await Promise.race([
          navigator.clipboard.writeText(movementTraceJson()),
          new Promise<never>((_resolve, reject) => {
            window.setTimeout(() => reject(new Error("clipboard timeout")), 1_000);
          })
        ]);
        appendLine(`copied ${entries.length} movement trace entries`);
      } catch {
        appendLine("movement trace copy failed; use ashAtlasMovementTrace.json()", "error");
      }
      return;
    }
    if (parsed.type === "teleport") {
      if (!player) {
        appendLine("teleport failed: player unknown", "error");
        return;
      }
      const accepted = onTeleport(parsed.lat, parsed.lon);
      appendLine(
        accepted
          ? `teleport requested for lat=${parsed.lat.toFixed(6)} lon=${parsed.lon.toFixed(6)}`
          : "teleport failed: disconnected",
        accepted ? "info" : "error"
      );
      return;
    }

    appendLine(`unknown command: ${command}`, "error");
  };

  return (
    <section className="dev-console" aria-label="Developer console">
      <div className="dev-console-header">
        <span>Dev Console</span>
        <button type="button" className="menu-text-close" onClick={onClose} aria-label="Close developer console">
          Close
        </button>
      </div>
      <div className="dev-console-output">
        {lines.map((line) => (
          <div key={line.id} className={`dev-console-line dev-console-line-${line.tone}`}>
            {line.text}
          </div>
        ))}
      </div>
      <form
        className="dev-console-form"
        onSubmit={(event) => {
          event.preventDefault();
          const command = input;
          setInput("");
          void runCommand(command);
        }}
      >
        <span>&gt;</span>
        <input
          ref={inputRef}
          value={input}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              const nextIndex =
                historyIndex === null ? history.length - 1 : Math.max(historyIndex - 1, 0);
              const next = history[nextIndex];
              if (next !== undefined) {
                setHistoryIndex(nextIndex);
                setInput(next);
              }
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (historyIndex === null) {
                return;
              }
              const nextIndex = historyIndex + 1;
              const next = history[nextIndex];
              if (next === undefined) {
                setHistoryIndex(null);
                setInput("");
              } else {
                setHistoryIndex(nextIndex);
                setInput(next);
              }
            }
          }}
        />
        <button type="submit">Run</button>
      </form>
    </section>
  );
}

function formatRecordingStatus(
  status: PerformanceRecorderStatus,
  lastRecordingFilename: string | null
): string {
  const state = status.isRecording ? "ON" : "OFF";
  const filename = lastRecordingFilename ? ` last=${lastRecordingFilename}` : "";
  const reason = status.lastStoppedReason ? ` reason=${status.lastStoppedReason}` : "";
  return [
    `recording=${state}`,
    `duration=${formatDuration(status.durationMs)}`,
    `samples=${status.sampleCount}/${status.maxSamples}`,
    `events=${status.eventCount}/${status.maxEvents}${reason}${filename}`
  ].join(" ");
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatResourceVision(
  resourceVision: ResourceVision | null,
  resourceVisionStatus: ResourceVisionStatus | null,
  visibleCollectibleCount: number,
  waterHighlightCount: number
): string {
  if (!resourceVision) {
    return "Resource Vision inactive. Travel to a flag to survey resources.";
  }
  return [
    `Resource Vision anchored=${resourceVision.flagName}`,
    `flag=${resourceVision.flagId.slice(0, 8)}`,
    `center=${resourceVision.center.lat.toFixed(6)},${resourceVision.center.lon.toFixed(6)}`,
    `radius=${resourceVision.radiusM.toFixed(0)}m`,
    `walkable=${resourceVision.movementLeashRadiusM.toFixed(0)}m`,
    `padding=${resourceVision.paddingM.toFixed(0)}m`,
    `status=${resourceVisionStatus?.status ?? "surveying"}`,
    `nodes=${visibleCollectibleCount}`,
    `waterHighlights=${waterHighlightCount}`,
    resourceVisionStatus?.lastError ? `error=${resourceVisionStatus.lastError}` : null
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

async function fetchFlagCount(
  serverHttpBase: string,
  fallbackCount: number,
  appendLine: (text: string, tone?: ConsoleLine["tone"]) => void
): Promise<void> {
  try {
    const response = await fetch(`${serverHttpBase}/api/dev/flags/count`, {
      credentials: "include"
    });
    if (!response.ok) {
      appendLine(`flags count failed: HTTP ${response.status}`, "error");
      return;
    }
    const payload = (await response.json()) as { count?: unknown };
    appendLine(`flags: ${Number(payload.count ?? fallbackCount)}`);
  } catch (error) {
    appendLine(error instanceof Error ? error.message : "flags count failed", "error");
  }
}

async function clearFlags(
  serverHttpBase: string,
  csrfToken: string,
  appendLine: (text: string, tone?: ConsoleLine["tone"]) => void
): Promise<boolean> {
  try {
    const response = await fetch(`${serverHttpBase}/api/dev/flags`, {
      method: "DELETE",
      credentials: "include",
      headers: { "x-csrf-token": csrfToken }
    });
    if (!response.ok) {
      appendLine(`flags clear failed: HTTP ${response.status}`, "error");
      return false;
    }
    const payload = (await response.json()) as { deletedCount?: unknown };
    appendLine(`cleared ${Number(payload.deletedCount ?? 0)} flags`);
    return true;
  } catch (error) {
    appendLine(error instanceof Error ? error.message : "flags clear failed", "error");
    return false;
  }
}

async function fetchSpawnCount(
  serverHttpBase: string,
  appendLine: (text: string, tone?: ConsoleLine["tone"]) => void
): Promise<void> {
  try {
    const response = await fetch(`${serverHttpBase}/api/dev/spawns/count`, {
      credentials: "include"
    });
    if (!response.ok) {
      appendLine(`spawns count failed: HTTP ${response.status}`, "error");
      return;
    }
    const payload = (await response.json()) as {
      spawnCellCount?: unknown;
      availableNodeCount?: unknown;
      harvestedNodeCount?: unknown;
      resourceVisionStatusCounts?: Partial<Record<string, unknown>>;
    };
    const statusCounts = payload.resourceVisionStatusCounts ?? {};
    appendLine(
      `spawns: cells=${Number(payload.spawnCellCount ?? 0)} available=${Number(
        payload.availableNodeCount ?? 0
      )} harvested=${Number(payload.harvestedNodeCount ?? 0)} visions=${formatVisionStatusCounts(
        statusCounts
      )}`
    );
  } catch (error) {
    appendLine(error instanceof Error ? error.message : "spawns count failed", "error");
  }
}

function formatVisionStatusCounts(statusCounts: Partial<Record<string, unknown>>): string {
  return ["pending", "generating", "ready", "failed"]
    .map((status) => `${status}:${Number(statusCounts[status] ?? 0)}`)
    .join(",");
}
