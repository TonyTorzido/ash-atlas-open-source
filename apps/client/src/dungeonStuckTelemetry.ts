import type { ReportValue } from "./audio/musicEngine.js";

/**
 * Dungeon stuck telemetry: a player who keeps giving movement input (stick or tap) for over STUCK_AFTER_MS without the
 * server position changing, or whose movement input is ignored by a client gate, sends one throttled flat report
 * (/api/diagnostics/dungeon-stuck, logged by the server as "client dungeon stuck report") so it can be grepped
 * without asking the player for anything. The detector is pure; the App supplies the clock, the position and the context.
 */
export const STUCK_AFTER_MS = 2_000;
/** Input samples closer than this belong to one continuous push. */
const INPUT_GAP_MS = 700;
/** The server position moved less than this (room units) over the push. */
const MOVED_UNITS = 2;
export const STUCK_REPORT_COOLDOWN_MS = 60_000;
export const STUCK_REPORT_MAX = 5;

export type StuckReason = "no-move" | `ignored:${string}`;

export class DungeonStuckDetector {
  private pushStartedAt: number | null = null;
  private lastInputAt = 0;
  private startPos: { x: number; y: number } | null = null;
  private lastReportAt = -Infinity;
  private reports = 0;

  /** Movement input arrived. `ignoredReason` names the gate that dropped it, or null when it was passed on. */
  input(nowMs: number, pos: { x: number; y: number }, ignoredReason: string | null): StuckReason | null {
    if (nowMs - this.lastInputAt > INPUT_GAP_MS || this.pushStartedAt === null) {
      this.pushStartedAt = nowMs;
      this.startPos = { x: pos.x, y: pos.y };
    }
    this.lastInputAt = nowMs;
    return ignoredReason ? this.allow(nowMs, `ignored:${ignoredReason}`) : null;
  }

  /** Poll with the latest server position; returns a reason when a report should go out now. */
  tick(nowMs: number, pos: { x: number; y: number }): StuckReason | null {
    if (this.pushStartedAt === null || nowMs - this.lastInputAt > INPUT_GAP_MS) { this.pushStartedAt = null; return null; }
    const start = this.startPos!;
    if (Math.hypot(pos.x - start.x, pos.y - start.y) >= MOVED_UNITS) {
      this.pushStartedAt = nowMs; this.startPos = { x: pos.x, y: pos.y };
      return null;
    }
    if (nowMs - this.pushStartedAt < STUCK_AFTER_MS) return null;
    return this.allow(nowMs, "no-move");
  }

  private allow(nowMs: number, reason: StuckReason): StuckReason | null {
    if (this.reports >= STUCK_REPORT_MAX || nowMs - this.lastReportAt < STUCK_REPORT_COOLDOWN_MS) return null;
    this.lastReportAt = nowMs;
    this.reports += 1;
    this.pushStartedAt = null;
    return reason;
  }
}

export type StuckContext = Readonly<Record<string, ReportValue>>;
