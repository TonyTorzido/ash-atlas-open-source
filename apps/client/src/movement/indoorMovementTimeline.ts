import type { IndoorPosition } from "@ash-atlas/shared";

export type IndoorRenderedPosition = { x: number; y: number; moving: boolean };
export type IndoorMovementApplyResult = "accepted" | "ignored" | "snapped";

const MAX_FRAME_DELTA_MS = 50;
const LARGE_CORRECTION_DISTANCE = 180;
const MAX_AUTHORITY_LEAD_SECONDS = 0.12;
const STOP_RECONCILE_SPEED_MULTIPLIER = 2.5;

export class IndoorMovementTimeline<TPosition extends IndoorPosition> {
  private sessionId: string | null = null;
  private authority: TPosition | null = null;
  private rendered: IndoorRenderedPosition | null = null;
  private movementSequence = -1;
  private serverTime = Number.NEGATIVE_INFINITY;
  private lastRenderAtMs: number | null = null;
  /** A predicted dash in flight: the rendered point follows it, whatever the authority says, until it lands. */
  private dash: { fromX: number; fromY: number; toX: number; toY: number; startMs: number; durationMs: number } | null = null;

  constructor(private movementSpeed: number) {}

  setMovementSpeed(movementSpeed: number): void {
    if (Number.isFinite(movementSpeed) && movementSpeed >= 0) {
      this.movementSpeed = movementSpeed;
    }
  }

  start(sessionId: string, position: TPosition, movementSequence: number, serverTime: number, clientNowMs: number): void {
    this.sessionId = sessionId;
    this.authority = { ...position };
    this.rendered = { x: position.x, y: position.y, moving: position.moving };
    this.movementSequence = movementSequence;
    this.serverTime = serverTime;
    this.lastRenderAtMs = clientNowMs;
  }

  applySnapshot(
    sessionId: string,
    position: TPosition,
    movementSequence: number,
    serverTime: number,
    clientNowMs: number
  ): IndoorMovementApplyResult {
    if (
      sessionId !== this.sessionId || !this.authority || !this.rendered ||
      !isValidPosition(position) || !Number.isSafeInteger(movementSequence) ||
      movementSequence <= this.movementSequence || !Number.isFinite(serverTime) || serverTime < this.serverTime
    ) return "ignored";
    this.authority = { ...position };
    this.movementSequence = movementSequence;
    this.serverTime = serverTime;
    if (Math.hypot(position.x - this.rendered.x, position.y - this.rendered.y) >= LARGE_CORRECTION_DISTANCE) {
      this.rendered = { x: position.x, y: position.y, moving: position.moving };
      this.lastRenderAtMs = clientNowMs;
      return "snapped";
    }
    return "accepted";
  }

  render(clientNowMs: number): IndoorRenderedPosition | null {
    if (!this.authority || !this.rendered || !Number.isFinite(clientNowMs)) return this.rendered;
    if (this.lastRenderAtMs === null) {
      this.lastRenderAtMs = clientNowMs;
      return { ...this.rendered };
    }
    const dash = this.dash;
    if (dash) {
      const progress = (clientNowMs - dash.startMs) / dash.durationMs;
      this.lastRenderAtMs = Math.max(this.lastRenderAtMs, clientNowMs);
      if (progress < 1) {
        const t = Math.max(0, progress);
        this.rendered = { x: dash.fromX + (dash.toX - dash.fromX) * t, y: dash.fromY + (dash.toY - dash.fromY) * t, moving: true };
        return { ...this.rendered };
      }
      this.dash = null;
      this.rendered = { x: dash.toX, y: dash.toY, moving: false };
    }
    const elapsedMs = Math.min(Math.max(clientNowMs - this.lastRenderAtMs, 0), MAX_FRAME_DELTA_MS);
    this.lastRenderAtMs = Math.max(this.lastRenderAtMs, clientNowMs);
    const destination = this.authority.moving && this.authority.targetX !== null && this.authority.targetY !== null
      ? { x: this.authority.targetX, y: this.authority.targetY }
      : { x: this.authority.x, y: this.authority.y };
    const speed = this.authority.moving
      ? this.movementSpeed
      : this.movementSpeed * STOP_RECONCILE_SPEED_MULTIPLIER;
    const next = moveToward(this.rendered, destination, speed * elapsedMs / 1_000);
    if (this.authority.moving) {
      const maxLead = this.movementSpeed * MAX_AUTHORITY_LEAD_SECONDS;
      const authorityDistance = Math.hypot(next.x - this.authority.x, next.y - this.authority.y);
      this.rendered = authorityDistance > maxLead
        ? { ...moveToward(this.authority, next, maxLead), moving: true }
        : { ...next, moving: true };
    } else {
      this.rendered = { ...next, moving: next.x !== this.authority.x || next.y !== this.authority.y };
    }
    return { ...this.rendered };
  }

  /** Plays a dash from the rendered point to `to` over `durationMs` (server position still reconciles after landing). */
  beginDash(to: { x: number; y: number }, durationMs: number, clientNowMs: number): void {
    if (!this.rendered) return;
    this.dash = { fromX: this.rendered.x, fromY: this.rendered.y, toX: to.x, toY: to.y, startMs: clientNowMs, durationMs };
  }

  latestAuthorityPosition(): TPosition | null {
    return this.authority ? { ...this.authority } : null;
  }

  currentSessionId(): string | null { return this.sessionId; }
  currentSequence(): number { return this.movementSequence; }

  clear(): void {
    this.sessionId = null;
    this.authority = null;
    this.rendered = null;
    this.movementSequence = -1;
    this.serverTime = Number.NEGATIVE_INFINITY;
    this.lastRenderAtMs = null;
    this.dash = null;
  }
}

function moveToward(from: { x: number; y: number }, to: { x: number; y: number }, distance: number): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const remaining = Math.hypot(dx, dy);
  if (remaining === 0 || remaining <= distance) return { x: to.x, y: to.y };
  return { x: from.x + dx / remaining * distance, y: from.y + dy / remaining * distance };
}

function isValidPosition(position: IndoorPosition): boolean {
  const targetNull = position.targetX === null && position.targetY === null;
  const targetFinite = position.targetX !== null && position.targetY !== null &&
    Number.isFinite(position.targetX) && Number.isFinite(position.targetY);
  return Number.isFinite(position.x) && Number.isFinite(position.y) &&
    Number.isSafeInteger(position.revision) && (targetNull || targetFinite);
}
