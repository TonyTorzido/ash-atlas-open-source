export const FLAG_TRAVEL_CAMERA_FALLBACK_MS = 320;
// Recenter shares the standalone World Map's smooth globe-to-area motion.
// Leave enough timeout headroom for MapLibre's moveend event after easing.
export const RECENTER_CAMERA_DURATION_MS = 420;
export const RECENTER_CAMERA_TIMEOUT_MS = 620;
export const FLAG_TRAVEL_CAMERA_MIN_DURATION_MS = 560;
export const FLAG_TRAVEL_CAMERA_MAX_DURATION_MS = 1_300;
export const FLAG_TRAVEL_CAMERA_MAX_DURATION_VIEWPORT_DISTANCE = 1.5;
export const FLAG_TRAVEL_CAMERA_CORRECTION_MIN_DURATION_MS = 100;
export const FLAG_TRAVEL_CAMERA_CORRECTION_MAX_DURATION_MS = 150;
export const FLAG_TRAVEL_CAMERA_CORRECTION_DURATION_MS_PER_PX = 2;
export const FLAG_TRAVEL_CAMERA_AUTHORITY_DEAD_ZONE_PX = 8;

export type FlagTravelCameraDestination = Readonly<{
  lat: number;
  lon: number;
}>;

export type FlagTravelCameraLifecycle =
  | "moving-to-requested"
  | "awaiting-arrival"
  | "arrival-adopted"
  | "correction-pending"
  | "correcting"
  | "completed"
  | "cancelled"
  | "replaced";

export type FlagTravelCameraTransaction = Readonly<{
  requestId: string;
  generation: number | null;
  requestedDestination: FlagTravelCameraDestination;
  authoritativeDestination: FlagTravelCameraDestination | null;
  lifecycle: FlagTravelCameraLifecycle;
}>;

export type FlagTravelCameraArrivalDecision =
  | Readonly<{ kind: "unmatched" | "suppressed" }>
  | Readonly<{
      kind: "adopted" | "completed";
      transaction: FlagTravelCameraTransaction;
    }>
  | Readonly<{
      kind: "correction-required";
      startImmediately: boolean;
      transaction: FlagTravelCameraTransaction;
    }>;

export type FlagTravelCameraCompletionDecision =
  | Readonly<{ kind: "unmatched" }>
  | Readonly<{
      kind: "awaiting-arrival" | "completed";
      transaction: FlagTravelCameraTransaction;
    }>
  | Readonly<{
      kind: "correction-required";
      transaction: FlagTravelCameraTransaction;
    }>;

export type FlagTravelCameraPlan =
  | Readonly<{
      kind: "ease";
      plan: "continuous";
      durationMs: number;
      easing: (t: number) => number;
      projectedDistancePx: number;
      viewportDistance: number;
    }>
  | Readonly<{
      kind: "jump";
      projectedDistancePx: number;
      viewportDistance: number;
      reason: "reduced-motion";
    }>;

export type FlagTravelCameraCorrectionPlan =
  | Readonly<{
      kind: "ease";
      durationMs: number;
      easing: (t: number) => number;
    }>
  | Readonly<{ kind: "jump"; reason: "reduced-motion" }>;

export function cubicEaseInOut(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function planFlagTravelCamera(input: Readonly<{
  current: { x: number; y: number };
  destination: { x: number; y: number };
  viewport: { width: number; height: number };
  reducedMotion: boolean;
}>): FlagTravelCameraPlan {
  const deltaX = input.destination.x - input.current.x;
  const deltaY = input.destination.y - input.current.y;
  const projectedDistancePx = Math.hypot(deltaX, deltaY);
  const viewportDistance = Math.hypot(
    deltaX / Math.max(1, input.viewport.width),
    deltaY / Math.max(1, input.viewport.height)
  );
  if (input.reducedMotion) {
    return {
      kind: "jump",
      projectedDistancePx,
      viewportDistance,
      reason: "reduced-motion"
    };
  }
  const durationProgress = Math.min(
    1,
    viewportDistance / FLAG_TRAVEL_CAMERA_MAX_DURATION_VIEWPORT_DISTANCE
  );
  return {
    kind: "ease",
    plan: "continuous",
    durationMs: Math.round(
      FLAG_TRAVEL_CAMERA_MIN_DURATION_MS +
        (FLAG_TRAVEL_CAMERA_MAX_DURATION_MS -
          FLAG_TRAVEL_CAMERA_MIN_DURATION_MS) *
          durationProgress
    ),
    easing: cubicEaseInOut,
    projectedDistancePx,
    viewportDistance
  };
}

export function planFlagTravelCameraCorrection(input: Readonly<{
  projectedDistancePx: number;
  reducedMotion: boolean;
}>): FlagTravelCameraCorrectionPlan {
  if (input.reducedMotion) {
    return { kind: "jump", reason: "reduced-motion" };
  }
  return {
    kind: "ease",
    durationMs: Math.min(
      FLAG_TRAVEL_CAMERA_CORRECTION_MAX_DURATION_MS,
      Math.max(
        FLAG_TRAVEL_CAMERA_CORRECTION_MIN_DURATION_MS,
        FLAG_TRAVEL_CAMERA_CORRECTION_MIN_DURATION_MS +
          Math.max(
            0,
            input.projectedDistancePx -
              FLAG_TRAVEL_CAMERA_AUTHORITY_DEAD_ZONE_PX
          ) * FLAG_TRAVEL_CAMERA_CORRECTION_DURATION_MS_PER_PX
      )
    ),
    easing: cubicEaseInOut
  };
}

export function shouldReapplyFlagTravelCameraTransform(
  transaction: FlagTravelCameraTransaction | null
): boolean {
  return transaction !== null &&
    transaction.generation !== null &&
    transaction.lifecycle !== "cancelled" &&
    transaction.lifecycle !== "completed" &&
    transaction.lifecycle !== "replaced";
}

export class FlagTravelCameraTransactionOwner {
  private transaction: FlagTravelCameraTransaction | null = null;
  private readonly suppressedRequestIds = new Set<string>();

  current(): FlagTravelCameraTransaction | null {
    return this.transaction;
  }

  begin(input: Readonly<{
    requestId: string;
    generation: number | null;
    requestedDestination: FlagTravelCameraDestination;
  }>): Readonly<{
    transaction: FlagTravelCameraTransaction;
    replaced: FlagTravelCameraTransaction | null;
  }> {
    const replaced = this.transaction
      ? { ...this.transaction, lifecycle: "replaced" as const }
      : null;
    if (replaced) this.suppress(replaced.requestId);
    const transaction: FlagTravelCameraTransaction = {
      requestId: input.requestId,
      generation: input.generation,
      requestedDestination: Object.freeze({ ...input.requestedDestination }),
      authoritativeDestination: null,
      lifecycle:
        input.generation === null ? "awaiting-arrival" : "moving-to-requested"
    };
    this.transaction = transaction;
    return { transaction, replaced };
  }

  replaceRequestId(previousRequestId: string, nextRequestId: string): boolean {
    if (this.transaction?.requestId !== previousRequestId) return false;
    this.suppress(previousRequestId);
    this.transaction = {
      ...this.transaction,
      requestId: nextRequestId
    };
    return true;
  }

  adoptArrival(
    requestId: string,
    authoritativeDestination: FlagTravelCameraDestination,
    discrepancyPx: number
  ): FlagTravelCameraArrivalDecision {
    if (this.suppressedRequestIds.has(requestId)) {
      return { kind: "suppressed" };
    }
    const current = this.transaction;
    if (!current || current.requestId !== requestId) {
      return { kind: "unmatched" };
    }
    if (discrepancyPx > FLAG_TRAVEL_CAMERA_AUTHORITY_DEAD_ZONE_PX) {
      const transaction: FlagTravelCameraTransaction = {
        ...current,
        authoritativeDestination: Object.freeze({ ...authoritativeDestination }),
        lifecycle: "correction-pending"
      };
      this.transaction = transaction;
      return {
        kind: "correction-required",
        startImmediately: current.generation === null,
        transaction
      };
    }
    const adopted: FlagTravelCameraTransaction = {
      ...current,
      authoritativeDestination: null,
      lifecycle:
        current.generation === null ? "completed" : "arrival-adopted"
    };
    if (current.generation === null) {
      this.completeAndSuppress(adopted);
      return { kind: "completed", transaction: adopted };
    }
    this.transaction = adopted;
    return { kind: "adopted", transaction: adopted };
  }

  completeGeneration(generation: number): FlagTravelCameraCompletionDecision {
    const current = this.transaction;
    if (!current || current.generation !== generation) {
      return { kind: "unmatched" };
    }
    if (current.lifecycle === "correction-pending") {
      const transaction: FlagTravelCameraTransaction = {
        ...current,
        generation: null
      };
      this.transaction = transaction;
      return { kind: "correction-required", transaction };
    }
    if (
      current.lifecycle === "arrival-adopted" ||
      current.lifecycle === "correcting"
    ) {
      const transaction: FlagTravelCameraTransaction = {
        ...current,
        generation: null,
        lifecycle: "completed"
      };
      this.completeAndSuppress(transaction);
      return { kind: "completed", transaction };
    }
    const transaction: FlagTravelCameraTransaction = {
      ...current,
      generation: null,
      lifecycle: "awaiting-arrival"
    };
    this.transaction = transaction;
    return { kind: "awaiting-arrival", transaction };
  }

  beginCorrection(requestId: string, generation: number): boolean {
    const current = this.transaction;
    if (
      !current ||
      current.requestId !== requestId ||
      current.lifecycle !== "correction-pending" ||
      current.authoritativeDestination === null
    ) {
      return false;
    }
    this.transaction = {
      ...current,
      generation,
      lifecycle: "correcting"
    };
    return true;
  }

  cancel(
    reason: "cancelled" | "replaced",
    requestId?: string
  ): FlagTravelCameraTransaction | null {
    const current = this.transaction;
    if (!current || (requestId !== undefined && current.requestId !== requestId)) {
      return null;
    }
    const cancelled: FlagTravelCameraTransaction = {
      ...current,
      lifecycle: reason
    };
    this.suppress(current.requestId);
    this.transaction = null;
    return cancelled;
  }

  private completeAndSuppress(transaction: FlagTravelCameraTransaction): void {
    this.suppress(transaction.requestId);
    this.transaction = null;
  }

  private suppress(requestId: string): void {
    this.suppressedRequestIds.add(requestId);
    if (this.suppressedRequestIds.size <= 16) return;
    const oldest = this.suppressedRequestIds.values().next().value;
    if (oldest !== undefined) this.suppressedRequestIds.delete(oldest);
  }
}
