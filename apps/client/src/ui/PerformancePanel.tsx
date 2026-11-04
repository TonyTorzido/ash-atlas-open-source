import { useEffect, useState } from "react";

import { perfMetrics, type PerfSnapshot } from "../perf/perfMetrics.js";
import type { PerformanceRecorderStatus } from "../perf/perfRecorder.js";
import type { ProgressionRecorderStatus } from "../perf/progressionRecorder.js";

type PerformancePanelProps = {
  open: boolean;
  recordingStatus: PerformanceRecorderStatus;
  lastExportedFilename: string | null;
  onStartRecording(): void;
  onStopRecording(): void;
  onResetRecording(): void;
  progressionRecordingStatus: ProgressionRecorderStatus;
  lastProgressionFilenames: string | null;
  onStartProgressionRecording(): void;
  onStopProgressionRecording(): void;
  onResetProgressionRecording(): void;
  onMarkLoopStart(): void;
  onMarkLoopEnd(): void;
};

const SAMPLE_INTERVAL_MS = 500;

export function PerformancePanel({
  open,
  recordingStatus,
  lastExportedFilename,
  onStartRecording,
  onStopRecording,
  onResetRecording,
  progressionRecordingStatus,
  lastProgressionFilenames,
  onStartProgressionRecording,
  onStopProgressionRecording,
  onResetProgressionRecording,
  onMarkLoopStart,
  onMarkLoopEnd
}: PerformancePanelProps): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<PerfSnapshot>(() => perfMetrics.getSnapshot());

  useEffect(() => {
    if (!open) {
      return;
    }
    setSnapshot(perfMetrics.getSnapshot());
    const interval = window.setInterval(() => {
      setSnapshot(perfMetrics.getSnapshot());
    }, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <aside className="performance-panel" aria-label="Performance panel">
      <div className="performance-panel-header">
        <span>Performance</span>
        <button
          type="button"
          onClick={() => {
            perfMetrics.resetCounters();
            setSnapshot(perfMetrics.getSnapshot());
          }}
        >
          Reset Metrics
        </button>
      </div>
      <div className="performance-recording">
        <div className="performance-recording-status">
          <span className={recordingStatus.isRecording ? "recording-dot on" : "recording-dot"} />
          <strong>Recording: {recordingStatus.isRecording ? "ON" : "OFF"}</strong>
          <span>{formatDuration(recordingStatus.durationMs)}</span>
        </div>
        <div className="performance-recording-counts">
          <span>
            {recordingStatus.sampleCount}/{recordingStatus.maxSamples} samples
          </span>
          <span>
            {recordingStatus.eventCount}/{recordingStatus.maxEvents} events
          </span>
        </div>
        <div className="performance-recording-actions">
          <button type="button" disabled={recordingStatus.isRecording} onClick={onStartRecording}>
            Start Recording
          </button>
          <button type="button" disabled={!recordingStatus.isRecording} onClick={onStopRecording}>
            Stop + Download
          </button>
          <button type="button" disabled={recordingStatus.isRecording} onClick={onResetRecording}>
            Reset
          </button>
        </div>
        {lastExportedFilename ? (
          <div className="performance-recording-file">{lastExportedFilename}</div>
        ) : null}
      </div>
      <div className="performance-recording progression-recording">
        <div className="performance-subtitle">Progression Recording</div>
        <div className="performance-recording-status">
          <span className={progressionRecordingStatus.isRecording ? "recording-dot on" : "recording-dot"} />
          <strong>{progressionRecordingStatus.isRecording ? "ON" : "OFF"}</strong>
          <span>{formatDuration(progressionRecordingStatus.durationMs)}</span>
        </div>
        <div className="performance-recording-counts">
          <span>{progressionRecordingStatus.eventCount}/{progressionRecordingStatus.maxEvents} events</span>
          <span>{progressionRecordingStatus.rawEventsTruncated ? "raw events truncated" : "bounded local data"}</span>
        </div>
        <div className="performance-recording-actions">
          <button type="button" disabled={progressionRecordingStatus.isRecording} onClick={onStartProgressionRecording}>
            Start
          </button>
          <button type="button" disabled={!progressionRecordingStatus.isRecording} onClick={onStopProgressionRecording}>
            Stop + JSON/CSV
          </button>
          <button type="button" disabled={progressionRecordingStatus.isRecording} onClick={onResetProgressionRecording}>
            Reset
          </button>
          <button type="button" disabled={!progressionRecordingStatus.isRecording} onClick={onMarkLoopStart}>
            Loop Start
          </button>
          <button type="button" disabled={!progressionRecordingStatus.isRecording} onClick={onMarkLoopEnd}>
            Loop End
          </button>
        </div>
        {lastProgressionFilenames ? (
          <div className="performance-recording-file">{lastProgressionFilenames}</div>
        ) : null}
      </div>
      <div className="performance-grid">
        <Metric label="FPS" value={snapshot.fps.toFixed(1)} />
        <Metric label="Sample window" value={`${snapshot.sampleWindowMs.toFixed(0)} ms`} />
        <Metric label="Avg frame" value={`${snapshot.averageFrameMs.toFixed(1)} ms`} />
        <Metric label="Worst frame" value={`${snapshot.worstFrameMs.toFixed(1)} ms`} />
        <Metric label="Recent worst" value={`${snapshot.worstRecentFrameMs.toFixed(1)} ms`} />
        <Metric label="Miss >16" value={String(snapshot.frameBudgetMissesOver16Ms)} />
        <Metric label="Miss >33" value={String(snapshot.frameBudgetMissesOver33Ms)} />
        <Metric label="Long >50" value={String(snapshot.longFramesOver50Ms)} />
        <Metric label="Long >100" value={String(snapshot.longFramesOver100Ms)} />
        <Metric label="Map renders" value={String(snapshot.mapRenderEventsReceived)} />
        <Metric label="Map render/s" value={snapshot.mapRenderEventsPerSec.toFixed(1)} />
        <Metric label="Ease/s" value={snapshot.cameraEaseToPerSec.toFixed(1)} />
        <Metric label="Ease count" value={String(snapshot.cameraEaseToCount)} />
        <Metric label="WS snap/s" value={snapshot.websocketSnapshotsPerSec.toFixed(1)} />
        <Metric label="Player snap/s" value={snapshot.playerSnapshotsPerSec.toFixed(1)} />
        <Metric label="Flags snap/s" value={snapshot.flagSnapshotsPerSec.toFixed(1)} />
        <Metric label="Collectible snap/s" value={snapshot.collectibleSnapshotsPerSec.toFixed(1)} />
        <Metric label="Total WS/s" value={snapshot.totalWsMessagesPerSec.toFixed(1)} />
        <Metric label="Collectibles" value={String(snapshot.collectibleCount)} />
        <Metric label="Collectible max" value={String(snapshot.collectibleCountMax)} />
        <Metric label="Water highlights" value={String(snapshot.waterHighlightCount)} />
        <Metric label="Water highlight max" value={String(snapshot.waterHighlightCountMax)} />
        <Metric label="Collectible redraws" value={String(snapshot.collectibleRedrawCount)} />
        <Metric label="Collectible redraw/s" value={snapshot.collectibleRedrawsPerSec.toFixed(1)} />
        <Metric label="Collectible draw max" value={`${snapshot.maxCollectibleDrawMs.toFixed(1)} ms`} />
        <Metric label="Static redraws" value={String(snapshot.staticOverlayRedrawCount)} />
        <Metric label="Static redraw/s" value={snapshot.staticOverlayRedrawsPerSec.toFixed(1)} />
        <Metric
          label="Static skips"
          value={String(snapshot.staticOverlaySkippedDuringInteractionCount)}
        />
        <Metric label="Territory redraws" value={String(snapshot.territoryRedrawCount)} />
        <Metric label="Static draw max" value={`${snapshot.maxStaticOverlayDrawMs.toFixed(1)} ms`} />
        <Metric label="Collectible snap nodes" value={String(snapshot.collectibleSnapshotNodeCount)} />
        <Metric label="Inventory snaps" value={String(snapshot.inventorySnapshotCount)} />
        <Metric label="Flag survey requests" value={String(snapshot.surveyRequestCount)} />
        <Metric
          label="Flag survey response"
          value={
            snapshot.lastSurveyResponseMs === null
              ? "none"
              : `${snapshot.lastSurveyResponseMs.toFixed(0)} ms`
          }
        />
        <Metric
          label="Snapshot age"
          value={
            snapshot.lastSnapshotAgeMs === null
              ? "unknown"
              : `${snapshot.lastSnapshotAgeMs.toFixed(0)} ms`
          }
        />
        <Metric label="Flags" value={String(snapshot.visibleFlagCount)} />
        <Metric label="Selected" value={snapshot.selectedFlagId?.slice(0, 8) ?? "none"} />
        <Metric label="Map moving" value={snapshot.mapMoving ? "yes" : "no"} />
        <Metric label="Map zooming" value={snapshot.mapZooming ? "yes" : "no"} />
        <Metric label="WS state" value={String(snapshot.websocketReadyState ?? "unknown")} />
        <Metric label="WS reconnects" value={String(snapshot.websocketReconnectCount)} />
        <Metric label="WS malformed JSON" value={String(snapshot.websocketMalformedJsonCount)} />
        <Metric label="WS malformed frames" value={String(snapshot.websocketMalformedFrameCount)} />
        <Metric label="WS unknown frames" value={String(snapshot.websocketUnknownFrameCount)} />
        <Metric label="WS incompatible" value={String(snapshot.websocketIncompatibleProtocolCount)} />
        <Metric label="WS send closed" value={String(snapshot.websocketSendClosedCount)} />
        <Metric label="WS send failed" value={String(snapshot.websocketSendFailedCount)} />
        <Metric label="WS stale events" value={String(snapshot.websocketStaleEventCount)} />
      </div>
      <div className="performance-subtitle">Load milestones</div>
      <div className="performance-milestones">
        {snapshot.loadMilestones.map((milestone) => (
          <div key={milestone.name}>
            <span>{milestone.name}</span>
            <span>{milestone.elapsedMs.toFixed(0)} ms</span>
          </div>
        ))}
      </div>
      {snapshot.lastLongFrameReason ? (
        <div className="performance-note">Last long frame: {snapshot.lastLongFrameReason}</div>
      ) : null}
    </aside>
  );
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
    </>
  );
}
