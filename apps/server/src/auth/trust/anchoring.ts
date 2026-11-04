import { distanceMeters } from "@ash-atlas/shared";

import type { AppConfig } from "../../config.js";
import { isSettledNow } from "./settlement.js";
import type { OwnerSettlementRecord } from "./trustStore.js";

// Anchored destinations (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md 3.3).
// A destination created by account H is anchored iff H is Settled (not
// provisional-expired) and the destination lies within
// TRUST_HOME_DESTINATION_RADIUS_KM of H's Settled home. Computed on read from
// account_settlement; nothing is stored on the destination, so revocation is
// immediate apart from this short in-process cache. Wiring into flagAccess and
// the World Map is a separate package (A5b).

export const ANCHOR_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 5_000;

export type AnchoringStore = Readonly<{
  loadOwnerSettlement(accountId: string): Promise<OwnerSettlementRecord | null>;
}>;

export type AnchoringConfig = Pick<AppConfig, "TRUST_HOME_DESTINATION_RADIUS_KM">;

export class DestinationAnchoring {
  private readonly cache = new Map<string, { record: OwnerSettlementRecord | null; fetchedAt: number }>();

  constructor(
    private readonly store: AnchoringStore,
    private readonly config: AnchoringConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs: number = ANCHOR_CACHE_TTL_MS
  ) {}

  async isDestinationAnchored(ownerAccountId: string, lat: number, lon: number): Promise<boolean> {
    const record = await this.ownerRecord(ownerAccountId);
    // Settled is re-evaluated against the clock on every call so a cached
    // provisional window cannot outlive its expiry.
    if (!record || !record.settledHome || !isSettledNow(record, this.now())) return false;
    return distanceMeters({ lat, lon }, record.settledHome) <= this.config.TRUST_HOME_DESTINATION_RADIUS_KM * 1000;
  }

  // Call after a revocation or home change in this process to skip the TTL.
  invalidate(ownerAccountId?: string): void {
    if (ownerAccountId === undefined) this.cache.clear();
    else this.cache.delete(ownerAccountId);
  }

  private async ownerRecord(accountId: string): Promise<OwnerSettlementRecord | null> {
    const nowMs = this.now().getTime();
    const cached = this.cache.get(accountId);
    if (cached && nowMs - cached.fetchedAt < this.ttlMs) return cached.record;
    const record = await this.store.loadOwnerSettlement(accountId);
    if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
    this.cache.set(accountId, { record, fetchedAt: nowMs });
    return record;
  }
}
