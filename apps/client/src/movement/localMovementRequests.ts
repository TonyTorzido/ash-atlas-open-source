import type { LatLon } from "@ash-atlas/shared";

export const POST_ARRIVAL_TRAVEL_BINDING_TTL_MS = 2_000;

type RefCell<T> = { current: T };

type PostArrivalTravelBindingRefs = Readonly<{
  requestId: RefCell<string | null>;
  expiresAt: RefCell<number>;
}>;

export function setPostArrivalTravelBinding(
  refs: PostArrivalTravelBindingRefs,
  requestId: string,
  nowMs = Date.now()
): void {
  refs.requestId.current = requestId;
  refs.expiresAt.current = nowMs + POST_ARRIVAL_TRAVEL_BINDING_TTL_MS;
}

export function clearPostArrivalTravelBinding(
  refs: PostArrivalTravelBindingRefs,
  expectedRequestId?: string | null
): boolean {
  if (
    expectedRequestId !== undefined &&
    refs.requestId.current !== expectedRequestId
  ) return false;
  const cleared = refs.requestId.current !== null || refs.expiresAt.current !== 0;
  refs.requestId.current = null;
  refs.expiresAt.current = 0;
  return cleared;
}

export function activePostArrivalTravelRequestId(
  refs: PostArrivalTravelBindingRefs,
  nowMs = Date.now()
): string | null {
  if (
    refs.requestId.current &&
    refs.expiresAt.current > nowMs
  ) return refs.requestId.current;
  clearPostArrivalTravelBinding(refs);
  return null;
}

export type LocalMovementRequest = {
  requestId: string;
  generation: number;
  target: LatLon;
  issuedAtMs: number;
  accepted: boolean;
  boundTravelRequestId?: string;
};

export type LocalMovementAcceptance = {
  status: "accepted" | "duplicate" | "stale" | "untracked";
  request: LocalMovementRequest | null;
};

export class LocalMovementRequestTracker {
  private generation = 0;
  private latest: LocalMovementRequest | null = null;

  record(
    requestId: string,
    target: LatLon,
    issuedAtMs: number,
    boundTravelRequestId?: string
  ): LocalMovementRequest {
    this.generation += 1;
    this.latest = {
      requestId,
      generation: this.generation,
      target: { ...target },
      issuedAtMs,
      accepted: false,
      ...(boundTravelRequestId ? { boundTravelRequestId } : {})
    };
    return { ...this.latest, target: { ...this.latest.target } };
  }

  accept(requestId: string): LocalMovementAcceptance {
    if (!this.latest) {
      return { status: "untracked", request: null };
    }
    if (requestId !== this.latest.requestId) {
      return { status: "stale", request: this.snapshot() };
    }
    if (this.latest.accepted) {
      return { status: "duplicate", request: this.snapshot() };
    }
    this.latest = { ...this.latest, accepted: true };
    return { status: "accepted", request: this.snapshot() };
  }

  reset(): void {
    this.generation = 0;
    this.latest = null;
  }

  resetUnlessBoundTo(travelRequestId: string): LocalMovementRequest | null {
    if (this.latest?.boundTravelRequestId === travelRequestId) {
      return this.snapshot();
    }
    this.reset();
    return null;
  }

  discardBoundTo(travelRequestId: string): void {
    if (this.latest?.boundTravelRequestId === travelRequestId) this.reset();
  }

  isCurrent(requestId: string | undefined): boolean {
    return requestId !== undefined && requestId === this.latest?.requestId;
  }

  snapshot(): LocalMovementRequest | null {
    return this.latest
      ? { ...this.latest, target: { ...this.latest.target } }
      : null;
  }
}
