import {
  distanceMeters,
  STRATEGIC_VISION_RADIUS_M,
  type FlagSnapshot,
  type StrategicVisionAuthority,
  type StrategicVisionSnapshot
} from "@ash-atlas/shared";

const RETRY_START_MS = 1_000;
const RETRY_MAX_MS = 10_000;

export function flagClaimIntersectsStrategicVision(
  flag: FlagSnapshot,
  center: Readonly<{ lat: number; lon: number }>,
  radiusM = STRATEGIC_VISION_RADIUS_M
): boolean {
  return distanceMeters(center, flag) <= radiusM + Math.max(flag.claimRadiusM, 0);
}

export type StrategicVisionStatus = "idle" | "loading" | "ready" | "dense" | "error";
export type StrategicVisionResultDisposition = "accepted" | "retry";

export class StrategicVisionLoader {
  private authority: StrategicVisionAuthority | null = null;
  private enabled = false;
  private destroyed = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loadedAuthorityKey: string | null = null;
  private retryMs = RETRY_START_MS;

  constructor(
    private readonly serverHttpBase: string,
    private readonly onResult: (
      result: StrategicVisionSnapshot
    ) => StrategicVisionResultDisposition,
    private readonly onStatus: (status: StrategicVisionStatus) => void = () => undefined,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  setEnabled(enabled: boolean): void {
    if (this.destroyed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) this.schedule(true);
    else this.cancelPending();
  }

  setAuthority(authority: StrategicVisionAuthority | null): void {
    if (this.destroyed) return;
    const nextKey = authority ? strategicVisionAuthorityKey(authority) : null;
    const currentKey = this.authority ? strategicVisionAuthorityKey(this.authority) : null;
    if (nextKey === currentKey) return;
    this.authority = authority ? { ...authority, center: { ...authority.center } } : null;
    this.loadedAuthorityKey = null;
    this.retryMs = RETRY_START_MS;
    this.cancelPending();
    if (this.enabled && authority) this.schedule(true);
  }

  schedule(immediate = false): void {
    if (!this.enabled || this.destroyed || !this.authority) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, immediate ? 0 : 180);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.enabled = false;
    this.cancelPending();
    this.onStatus("idle");
  }

  private cancelPending(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
    this.controller = null;
  }

  private async refresh(): Promise<void> {
    const requestedAuthority = this.authority;
    if (!this.enabled || this.destroyed || !requestedAuthority) return;
    const requestedKey = strategicVisionAuthorityKey(requestedAuthority);
    if (requestedKey === this.loadedAuthorityKey) return;

    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.onStatus("loading");
    try {
      const fetchImpl = this.fetchImpl;
      const response = await fetchImpl(
        new URL("/api/map/strategic-vision", this.serverHttpBase),
        {
          cache: "no-store",
          credentials: "include",
          signal: controller.signal
        }
      );
      if (!response.ok) throw new Error(`strategic vision request failed (${response.status})`);
      const result = parseStrategicVisionResponse(await response.json());
      if (
        this.destroyed ||
        generation !== this.generation ||
        !this.authority ||
        strategicVisionAuthorityKey(this.authority) !== requestedKey
      ) return;
      if (strategicVisionAuthorityKey(result.authority) !== requestedKey) {
        const delay = this.retryMs;
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.refresh();
        }, delay);
        return;
      }
      if (this.onResult(result) === "retry") {
        const delay = this.retryMs;
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.refresh();
        }, delay);
        return;
      }
      this.retryMs = RETRY_START_MS;
      if (result.complete) {
        this.loadedAuthorityKey = requestedKey;
        this.onStatus("ready");
      } else {
        this.onStatus("dense");
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.refresh();
        }, RETRY_START_MS);
      }
    } catch {
      if (controller.signal.aborted || this.destroyed || generation !== this.generation) return;
      this.onStatus("error");
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.refresh();
      }, delay);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}

export function replaceStrategicFlagSnapshots(
  current: readonly FlagSnapshot[],
  previousStrategicIds: ReadonlySet<string>,
  incoming: readonly FlagSnapshot[],
  gameplayIds: ReadonlySet<string>,
  maximum: number,
  authority?: StrategicVisionAuthority,
  complete = true
): FlagSnapshot[] {
  const incomingIds = new Set(incoming.map((flag) => flag.id));
  const retainedCache = current.filter((flag) =>
    previousStrategicIds.has(flag.id)
    && !gameplayIds.has(flag.id)
    && !incomingIds.has(flag.id)
    && (
      !complete
      || !authority
      || !flagClaimIntersectsStrategicVision(flag, authority.center, authority.radiusM)
    )
  );
  const currentById = new Map(current.map((flag) => [flag.id, flag]));
  const essential = new Map<string, FlagSnapshot>();
  for (const id of gameplayIds) {
    const flag = currentById.get(id);
    if (flag) essential.set(id, flag);
  }
  for (const flag of incoming) essential.set(flag.id, flag);
  const cacheBudget = Math.max(0, maximum - essential.size);
  return [
    ...(cacheBudget > 0 ? retainedCache.slice(-cacheBudget) : []),
    ...essential.values()
  ];
}

export function strategicVisionAuthorityKey(authority: StrategicVisionAuthority): string {
  return [
    authority.center.lat,
    authority.center.lon,
    authority.radiusM,
    authority.relocationRevision,
    authority.gameplayViewGeneration
  ].join(":");
}

function parseStrategicVisionResponse(value: unknown): StrategicVisionSnapshot {
  if (!value || typeof value !== "object") throw new Error("invalid strategic vision response");
  const response = value as Partial<StrategicVisionSnapshot>;
  const authority = response.authority;
  if (
    !authority ||
    !Number.isFinite(authority.center?.lat) ||
    !Number.isFinite(authority.center?.lon) ||
    !Number.isFinite(authority.radiusM) ||
    !Number.isSafeInteger(authority.relocationRevision) ||
    !Number.isSafeInteger(authority.gameplayViewGeneration) ||
    !Array.isArray(response.flags) ||
    !Array.isArray(response.cities) ||
    !Array.isArray(response.landmarks) ||
    !Number.isSafeInteger(response.flagSetRevision) ||
    typeof response.complete !== "boolean"
  ) throw new Error("invalid strategic vision response");
  return response as StrategicVisionSnapshot;
}
