import { useEffect, useMemo, useState } from "react";
import { distanceMeters } from "@ash-atlas/shared";

import {
  gameplayLatencyTrace,
  gameplayTraceCsv,
  type GameplayTraceCategory,
  type GameplayTraceEvent,
  type GameplayTraceSnapshot
} from "../diagnostics/gameplayLatencyTrace.js";
import {
  createGameplayTraceExport
} from "../diagnostics/gameplayLatencyAnalysis.js";
import type { ReadyFlagPlacementQuote } from "../flags/flagPlacementPreview.js";
import { useModalBehavior } from "./useModalBehavior.js";

type Point = { lat: number; lon: number };

type Props = {
  open: boolean;
  developerAccessEnabled: boolean;
  authoritativePosition: Point | null;
  renderedPosition: Point | null;
  movementTargetActive: boolean;
  movementRevision: number | null;
  relocationRevision: number | null;
  quote: ReadyFlagPlacementQuote | null;
  lastVisibleError: string | null;
  onClose(): void;
  onRunStationaryQuote(): Promise<void>;
  onRunMoveStopQuote(): Promise<void>;
  onRunMoveStopBuild(): Promise<void>;
  onRunReliability(): Promise<void>;
};

const CATEGORIES: GameplayTraceCategory[] = [
  "movement", "networking", "flag-preparation", "build",
  "world", "population", "database", "ui"
];

export function GameplayLatencyTracePanel(props: Props): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<GameplayTraceSnapshot>(() => emptySnapshot());
  const [selectedCategories, setSelectedCategories] = useState(
    () => new Set<GameplayTraceCategory>(CATEGORIES)
  );
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [traceId, setTraceId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const dialogRef = useModalBehavior<HTMLElement>({
    open: props.open && props.developerAccessEnabled,
    onClose: props.onClose
  });

  useEffect(() => gameplayLatencyTrace.subscribe(setSnapshot), []);
  useEffect(() => {
    if (!props.open || !props.developerAccessEnabled) return;
    void gameplayLatencyTrace.refresh().catch(() => undefined);
    const interval = window.setInterval(() => {
      void gameplayLatencyTrace.refresh().catch(() => undefined);
    }, 500);
    return () => window.clearInterval(interval);
  }, [props.developerAccessEnabled, props.open]);

  const events = useMemo(
    () => snapshot.events.filter((event) =>
      selectedCategories.has(event.category) &&
      (!failuresOnly || event.failure) &&
      (!traceId || event.traceId === traceId)
    ),
    [failuresOnly, selectedCategories, snapshot.events, traceId]
  );
  const invariants = useMemo(() => traceInvariants(snapshot.events), [snapshot.events]);
  const summary = useMemo(() => latencySummary(snapshot.events), [snapshot.events]);
  const traceExport = useMemo(() => createGameplayTraceExport(snapshot), [snapshot]);
  const boundaryAnalysis = traceExport.boundaryAnalysis;
  const positionDifferenceM = props.authoritativePosition && props.renderedPosition
    ? distanceMeters(props.authoritativePosition, props.renderedPosition)
    : null;

  const run = async (label: string, action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(label);
    setFeedback(null);
    try {
      await action();
      await gameplayLatencyTrace.refresh();
      setFeedback(`${label} completed.`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : `${label} failed.`);
    } finally {
      setBusy(null);
    }
  };

  if (!props.open || !props.developerAccessEnabled) return null;
  return (
    <div className="modal-scrim gameplay-trace-scrim" onMouseDown={(event) => {
      if (event.target === event.currentTarget) props.onClose();
    }}>
      <aside ref={dialogRef} tabIndex={-1} className="gameplay-trace-panel" role="dialog" aria-modal="true" aria-labelledby="gameplay-trace-title">
        <header>
          <div><span className="eyebrow">Owner diagnostic</span><h2 id="gameplay-trace-title">Gameplay Latency Trace</h2></div>
          <button type="button" className="modal-close menu-text-close" onClick={props.onClose} aria-label="Close Gameplay Latency Trace">Close</button>
        </header>

        <div className="gameplay-trace-toolbar">
          <button
            type="button"
            disabled={snapshot.active || Boolean(busy)}
            onClick={() => void run("Start Recording", async () => {
              await gameplayLatencyTrace.start();
            })}
          >
            {busy === "Start Recording" ? "Starting\u2026" : "Start Recording"}
          </button>
          <button type="button" disabled={!snapshot.active} onClick={() => void gameplayLatencyTrace.stop()}>Stop Recording</button>
          <button type="button" onClick={() => void gameplayLatencyTrace.clear()}>Clear</button>
          <button type="button" disabled={!snapshot.active} onClick={() => gameplayLatencyTrace.mark()}>Mark Moment</button>
          <button type="button" disabled={snapshot.failures.length === 0} onClick={() => void copyJson(snapshot.failures.at(-1))}>Copy Last Failure</button>
          <button type="button" disabled={snapshot.events.length === 0} onClick={() => void copyJson(traceExport)}>Copy Trace JSON</button>
          <button type="button" disabled={snapshot.events.length === 0} onClick={() => download("json", snapshot)}>Export JSON</button>
          <button type="button" disabled={snapshot.events.length === 0} onClick={() => download("csv", snapshot)}>Export CSV</button>
        </div>

        <section className="gameplay-trace-invariants" aria-label="Trace invariants">
          <Invariant label="RICH LOOKUPS FROM FLAG PREPARATION" value={invariants.richFlagPreparation} />
          <Invariant label="RICH LOOKUPS FROM BUILD" value={invariants.richBuild} />
          <Invariant label="BACKGROUND FAILURES SHOWN TO USER" value={invariants.backgroundFailuresShown} />
          <Invariant label="DUPLICATE PROFILE JOBS FOR SAME CELL" value={invariants.duplicateProfileJobs} />
        </section>

        <section className="gameplay-trace-summary">
          <dl>
            <dt>Recording</dt><dd>{snapshot.active ? "ON" : "OFF"}</dd>
            <dt>Release</dt><dd>{snapshot.releaseIdentity
              ? `${snapshot.releaseIdentity.releaseGeneration} · ${snapshot.releaseIdentity.gameReleaseSha.slice(0, 12)}`
              : "unverified"}</dd>
            <dt>Cold samples</dt><dd>{traceExport.coldVisitValidation.acceptedTraceIds.length} accepted · {traceExport.coldVisitValidation.rejectedTraceIds.length} rejected</dd>
            <dt>Authoritative</dt><dd>{formatPoint(props.authoritativePosition)}</dd>
            <dt>Rendered/client</dt><dd>{formatPoint(props.renderedPosition)}</dd>
            <dt>Position difference</dt><dd>{positionDifferenceM === null ? "unknown" : `${positionDifferenceM.toFixed(2)} m`}</dd>
            <dt>Movement target</dt><dd>{props.movementTargetActive ? "active" : "clear"}</dd>
            <dt>Movement revision</dt><dd>{props.movementRevision ?? "unknown"}</dd>
            <dt>Relocation revision</dt><dd>{props.relocationRevision ?? "unknown"}</dd>
            <dt>Quote</dt><dd>{props.quote ? `${Math.max(0, Date.now() - props.quote.createdAt)} ms old` : "none"}</dd>
            <dt>Compact World calls</dt><dd>{invariants.compactCalls}</dd>
            <dt>Rich gameplay calls</dt><dd>{invariants.richFlagPreparation + invariants.richBuild}</dd>
            <dt>Dropped events</dt><dd>{formatDroppedEvents(snapshot)}</dd>
            <dt>Dropped critical</dt><dd>{snapshot.droppedCriticalEvents}</dd>
            <dt>Last visible UI error</dt><dd>{props.lastVisibleError ?? "none"}</dd>
          </dl>
          <div className="gameplay-trace-latencies">
            {summary.map((item) => <span key={item.label}><small>{item.label}</small><strong>{item.value}</strong></span>)}
            {boundaryAnalysis.boundaries.map((boundary) => (
              <span key={boundary.boundaryId}>
                <small>{readable(boundary.boundaryId)}</small>
                <strong>
                  {boundary.p95Ms === null
                    ? `no samples (n=0, incomplete=${boundary.incompleteStartCount})`
                    : `p95 ${boundary.p95Ms.toFixed(1)} ms (n=${boundary.sampleCount})${
                      boundary.targetP95Ms === null
                        ? ""
                        : ` · target ≤${boundary.targetP95Ms} ms ${
                          boundary.targetMet ? "PASS" : "FAIL"
                        }`
                    }`}
                </strong>
              </span>
            ))}
          </div>
        </section>

        <section className="gameplay-trace-scenarios">
          <button type="button" disabled={!snapshot.active || Boolean(busy)} onClick={() => void run("Stationary Quote Test", props.onRunStationaryQuote)}>Run Stationary Quote Test</button>
          <button type="button" disabled={!snapshot.active || Boolean(busy)} onClick={() => void run("Move → Stop → Quote Test", props.onRunMoveStopQuote)}>Run Move → Stop → Quote Test</button>
          <button type="button" disabled={!snapshot.active || Boolean(busy)} onClick={() => void run("Move → Stop → Build Test", props.onRunMoveStopBuild)}>Run Move → Stop → Build Test</button>
          <button type="button" disabled={!snapshot.active || Boolean(busy)} onClick={() => void run("20-Cycle Reliability Test", props.onRunReliability)}>Run 20-Cycle Reliability Test</button>
          {busy ? <span role="status">{busy} running…</span> : feedback ? <span role="status">{feedback}</span> : null}
        </section>

        <section className="gameplay-trace-filters">
          {CATEGORIES.map((category) => <label key={category}><input type="checkbox" checked={selectedCategories.has(category)} onChange={() => {
            setSelectedCategories((current) => {
              const next = new Set(current);
              if (next.has(category)) next.delete(category); else next.add(category);
              return next;
            });
          }} />{category}</label>)}
          <label><input type="checkbox" checked={failuresOnly} onChange={(event) => setFailuresOnly(event.currentTarget.checked)} />failures only</label>
          <label>Trace ID<input value={traceId} onChange={(event) => setTraceId(event.currentTarget.value.trim())} placeholder="all traces" /></label>
        </section>

        <section className="gameplay-trace-timeline" aria-label="Trace timeline">
          {events.length === 0 ? <p>No matching events.</p> : events.map((event) => (
            <article className={event.failure ? "failure" : undefined} key={`${event.sequence}-${event.source}`}>
              <time>{event.monotonicMs.toFixed(1)} ms</time>
              <span>{event.source}</span>
              <strong>{readable(event.name)}</strong>
              <small>{compactDetails(event)}</small>
            </article>
          ))}
        </section>
      </aside>
    </div>
  );
}

function Invariant({ label, value }: { label: string; value: number }): React.JSX.Element {
  return <div className={value === 0 ? "pass" : "fail"}><span>{label}</span><strong>{value}</strong></div>;
}

function traceInvariants(events: readonly GameplayTraceEvent[]) {
  const sum = (category: GameplayTraceCategory, key: string): number =>
    events.filter((event) => event.category === category)
      .reduce((total, event) => total + numeric(event.details[key]), 0);
  return {
    richFlagPreparation: sum("flag-preparation", "richWorldCalls"),
    richBuild: sum("build", "richWorldCalls"),
    compactCalls: events
      .filter((event) => event.name === "compact_world_request_completed")
      .reduce((total, event) => total + numeric(event.details.compactWorldCalls), 0),
    backgroundFailuresShown: events.filter((event) =>
      event.name.includes("background") && event.details.notificationDisplayed === true
    ).length,
    duplicateProfileJobs: events.filter((event) =>
      event.name === "profile_job_duplicate_created"
    ).length
  };
}

function latencySummary(events: readonly GameplayTraceEvent[]) {
  const duration = (name: string, key: string): string => {
    const values = events.filter((event) => event.name === name)
      .map((event) => numeric(event.details[key]))
      .filter((value) => value > 0);
    return values.length ? `${values.at(-1)!.toFixed(1)} ms` : "—";
  };
  return [
    { label: "Last quote", value: duration("quote_response_received", "totalMs") },
    { label: "Last Build admission", value: duration("build_admission_accepted", "totalAdmissionMs") },
    { label: "Last World", value: duration("compact_world_request_completed", "totalMs") },
    { label: "Last DB transaction", value: duration("flag_transaction_committed", "transactionMs") }
  ];
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function compactDetails(event: GameplayTraceEvent): string {
  return Object.entries(event.details).slice(0, 6)
    .map(([key, value]) => `${key}=${String(value)}`).join(" · ");
}

function readable(value: string): string {
  return value.replaceAll("_", " ");
}

function formatPoint(point: Point | null): string {
  return point ? `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}` : "unknown";
}

function formatDroppedEvents(snapshot: GameplayTraceSnapshot): string {
  const byCategory = CATEGORIES
    .filter((category) => snapshot.droppedEventsByCategory[category] > 0)
    .map((category) => `${category} ${snapshot.droppedEventsByCategory[category]}`)
    .join(", ");
  return byCategory || String(snapshot.droppedEvents);
}

async function copyJson(value: unknown): Promise<void> {
  await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
}

function download(kind: "json" | "csv", snapshot: GameplayTraceSnapshot): void {
  const body = kind === "json"
    ? JSON.stringify(createGameplayTraceExport(snapshot), null, 2)
    : gameplayTraceCsv(snapshot);
  const blob = new Blob([body], {
    type: kind === "json" ? "application/json" : "text/csv"
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `ash-atlas-gameplay-trace-${Date.now()}.${kind}`;
  link.click();
  URL.revokeObjectURL(link.href);
}

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
    droppedEventsByCategory: {
      movement: 0,
      networking: 0,
      "flag-preparation": 0,
      build: 0,
      world: 0,
      population: 0,
      database: 0,
      ui: 0
    },
    droppedCriticalEvents: 0,
    expiresAtIso: null,
    releaseIdentity: null
  };
}
