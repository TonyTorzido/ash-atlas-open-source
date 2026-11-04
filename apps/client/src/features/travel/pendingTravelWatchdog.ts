export const PENDING_TRAVEL_WATCHDOG_TIMEOUT_MS = 20_000;

export class MatchedPendingTravelWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private requestId: string | null = null;

  constructor(private readonly options: Readonly<{
    pendingRequestId(): string | null;
    onTimeout(requestId: string): void;
    timeoutMs?: number;
  }>) {}

  arm(requestId: string): void {
    this.clear();
    this.requestId = requestId;
    this.timer = setTimeout(() => {
      this.timer = null;
      const captured = this.requestId;
      this.requestId = null;
      if (
        captured !== requestId
        || this.options.pendingRequestId() !== requestId
      ) return;
      this.options.onTimeout(requestId);
    }, this.options.timeoutMs ?? PENDING_TRAVEL_WATCHDOG_TIMEOUT_MS);
  }

  settle(requestId: string): boolean {
    if (this.requestId !== requestId) return false;
    this.clear();
    return true;
  }

  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.requestId = null;
  }
}

export function settledTravelRequestId(frame: Readonly<{
  type: string;
  requestId?: unknown;
  success?: unknown;
}>): string | null {
  if (typeof frame.requestId !== "string") return null;
  if (
    frame.type === "FLAG_VISITED"
    || frame.type === "CITY_VISITED"
    || frame.type === "ERROR"
    || (frame.type === "TRAVEL_RESULT" && frame.success === true)
  ) return frame.requestId;
  return null;
}
