import { clientConfig } from "../config.js";
import type { AudioReportKind, ReportValue } from "./musicEngine.js";

/**
 * Music diagnostics sender. The engine builds one flat report per session (plus one per audio error); this posts it to
 * the game server, which logs it as "client audio report". Reports wait for the signed-in session's CSRF token and are
 * best effort: a failed post is dropped and never retried in a loop.
 */
type Pending = { path: string; item: { kind: string; report: Record<string, ReportValue> } };

let csrfToken: string | null = null;
const pending: Pending[] = [];
const MAX_PENDING = 6;

export function setAudioReportSession(token: string | null): void {
  csrfToken = token;
  if (!token) return;
  for (const entry of pending.splice(0)) post(entry, token);
}

export function sendAudioReport(kind: AudioReportKind, report: Record<string, ReportValue>): void {
  queue({ path: "/api/diagnostics/audio", item: { kind, report: boundedReport(report, 60) } });
}

/** Motion diagnostics (perf/motionReport.ts): same session token and bounds, logged as "client motion report". */
export function sendMotionReport(kind: "session" | "jitter", report: Record<string, ReportValue>): void {
  queue({ path: "/api/diagnostics/motion", item: { kind, report: boundedReport(report, 80) } });
}

/** Touch attack aim timings (combat/attackAimTelemetry.ts): same session token and bounds, logged as "client attack aim report". */
export function sendAttackAimReport(report: Record<string, ReportValue>): void {
  queue({ path: "/api/diagnostics/attack-aim", item: { kind: "batch", report: boundedReport(report, 40) } });
}

/** Dungeon stuck reports (dungeonStuckTelemetry.ts): same session token and bounds, logged as "client dungeon stuck report". */
export function sendDungeonStuckReport(report: Record<string, ReportValue>): void {
  queue({ path: "/api/diagnostics/dungeon-stuck", item: { kind: "stuck", report: boundedReport(report, 40) } });
}

function queue(entry: Pending): void {
  if (csrfToken) post(entry, csrfToken);
  else if (pending.length < MAX_PENDING) pending.push(entry);
}

function boundedReport(report: Record<string, ReportValue>, maxKeys: number): Record<string, ReportValue> {
  const out: Record<string, ReportValue> = {};
  for (const [key, value] of Object.entries(report).slice(0, maxKeys)) {
    out[key.slice(0, 40)] = typeof value === "string" ? value.slice(0, 240) : typeof value === "number" && !Number.isFinite(value) ? null : value;
  }
  return out;
}

function post({ path, item }: Pending, token: string): void {
  try {
    void fetch(new URL(path, clientConfig.serverHttpBase), {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { "content-type": "application/json", "x-csrf-token": token },
      body: JSON.stringify(item)
    }).catch(() => undefined);
  } catch { /* Diagnostics only. */ }
}
