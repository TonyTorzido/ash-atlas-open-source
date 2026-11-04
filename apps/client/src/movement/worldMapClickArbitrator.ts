// Clicks and taps wait out a short window so a double-click on a tree, creature
// or other object moves the player there instead of opening its popup. Players
// tune it per device in Settings > Map (clickDelayPreference.ts).
export const WORLD_MAP_CLICK_CONFIRMATION_MS = 100;
export const MIN_WORLD_MAP_CLICK_CONFIRMATION_MS = 50;
export const MAX_WORLD_MAP_CLICK_CONFIRMATION_MS = 200;
let clickConfirmationMs = WORLD_MAP_CLICK_CONFIRMATION_MS;

export function setWorldMapClickConfirmationMs(ms: number): void {
  clickConfirmationMs = ms;
}
export const WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS = 300;
export const WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX = 48;

export type WorldMapClickPointerType = "mouse" | "touch" | "pen";

export type WorldMapClick<T> = {
  value: T;
  screenX: number;
  screenY: number;
  button: number;
  pointerType: WorldMapClickPointerType;
};

export type WorldMapClickArbitratorHandlers<T> = {
  onPending(click: WorldMapClick<T>): void;
  onPendingEnd(click: WorldMapClick<T>, outcome: "confirmed" | "cancelled"): void;
  onSingle(click: WorldMapClick<T>): void;
  onDouble(click: WorldMapClick<T>): void;
};

type PendingClick<T> = {
  click: WorldMapClick<T>;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type CompletedClick<T> = {
  click: WorldMapClick<T>;
  completedAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export class WorldMapClickArbitrator<T> {
  private pending: PendingClick<T> | null = null;
  private recentCompleted: CompletedClick<T> | null = null;
  private handledDouble: { screenX: number; screenY: number; until: number } | null = null;

  constructor(
    private readonly handlers: WorldMapClickArbitratorHandlers<T>,
    private readonly now: () => number = () => performance.now()
  ) {}

  click(click: WorldMapClick<T>): void {
    if (click.button !== 0) return;
    const now = this.now();
    const pending = this.pending;
    if (pending && this.qualifies(pending, click, now)) {
      clearTimeout(pending.timer);
      this.pending = null;
      this.clearRecentCompleted();
      this.handlers.onPendingEnd(pending.click, "cancelled");
      this.rememberHandledDouble(click, now);
      this.handlers.onDouble(click);
      return;
    }
    if (pending) {
      this.confirm(pending);
    }
    const recentCompleted = this.recentCompleted;
    if (recentCompleted && this.qualifiesCompleted(recentCompleted, click, now)) {
      this.clearRecentCompleted();
      this.rememberHandledDouble(click, now);
      this.handlers.onDouble(click);
      return;
    }
    this.clearRecentCompleted();
    const next: PendingClick<T> = {
      click,
      startedAt: now,
      timer: setTimeout(() => this.confirm(next), clickConfirmationMs)
    };
    this.pending = next;
    this.handlers.onPending(click);
  }

  nativeDoubleClick(click: WorldMapClick<T>): void {
    if (click.button !== 0) return;
    const now = this.now();
    const handled = this.handledDouble;
    if (
      handled &&
      now <= handled.until &&
      Math.hypot(click.screenX - handled.screenX, click.screenY - handled.screenY) <=
        WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX
    ) {
      this.handledDouble = null;
      return;
    }
    this.cancel();
    this.handlers.onDouble(click);
  }

  cancel(): void {
    this.clearRecentCompleted();
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    this.handlers.onPendingEnd(pending.click, "cancelled");
  }

  private qualifies(
    pending: PendingClick<T>,
    click: WorldMapClick<T>,
    now: number
  ): boolean {
    return this.qualifiesWithin(
      pending.click,
      pending.startedAt,
      click,
      now,
      WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS
    );
  }

  private qualifiesCompleted(
    completed: CompletedClick<T>,
    click: WorldMapClick<T>,
    now: number
  ): boolean {
    return this.qualifiesWithin(
      completed.click,
      completed.completedAt,
      click,
      now,
      WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS
    );
  }

  private qualifiesWithin(
    candidate: WorldMapClick<T>,
    startedAt: number,
    click: WorldMapClick<T>,
    now: number,
    windowMs: number
  ): boolean {
    return (
      click.pointerType === candidate.pointerType &&
      click.button === candidate.button &&
      now - startedAt <= windowMs &&
      Math.hypot(
        click.screenX - candidate.screenX,
        click.screenY - candidate.screenY
      ) <= WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX
    );
  }

  private confirm(pending: PendingClick<T>): void {
    if (this.pending !== pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    this.clearRecentCompleted();
    const completedAt = this.now();
    const completed: CompletedClick<T> = {
      click: pending.click,
      completedAt,
      timer: setTimeout(() => {
        if (this.recentCompleted === completed) this.recentCompleted = null;
      }, WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS)
    };
    this.recentCompleted = completed;
    this.handlers.onSingle(pending.click);
    this.handlers.onPendingEnd(pending.click, "confirmed");
  }

  private rememberHandledDouble(click: WorldMapClick<T>, now: number): void {
    this.handledDouble = {
      screenX: click.screenX,
      screenY: click.screenY,
      until: now + WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS
    };
  }

  private clearRecentCompleted(): void {
    const recentCompleted = this.recentCompleted;
    if (!recentCompleted) return;
    clearTimeout(recentCompleted.timer);
    this.recentCompleted = null;
  }
}
