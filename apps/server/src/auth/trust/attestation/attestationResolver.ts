import { createHash } from "node:crypto";

import { formatAttestBoundFix } from "@ash-atlas/shared";

import type { FixAttestation } from "./assurance.js";
import type { AttestationStore, StoredAttestation } from "./attestationStore.js";

// Resolves the attestationRef a location fix carries (NATIVE_ANTISPOOF_BUILD_PLAN.md §8.5).

export const ATTESTATION_RESOLVER_TTL_MS = 10 * 60_000;
const MAX_CACHED_REFS = 10_000;

export function attestationRefHash(ref: string): string {
  return createHash("sha256").update(ref, "utf8").digest("hex");
}

export type ResolveAttestationInput = Readonly<{
  ref: string;
  accountId: string;
  sessionId: string | null;
  installationId: string | null;
  source: "passive" | "relocation";
  fix: Readonly<{ lat: number; lon: number; accuracy?: number | undefined; fixTimestampMs?: number | undefined }>;
  now: Date;
}>;

export class AttestationResolver {
  // ref hash -> row; Map insertion order gives LRU eviction.
  private readonly cache = new Map<string, { row: StoredAttestation; cachedAtMs: number }>();
  private readonly ttlMs: number;

  constructor(
    private readonly store: Pick<AttestationStore, "findByRefHash">,
    options: Readonly<{ ttlMs?: number }> = {}
  ) {
    this.ttlMs = options.ttlMs ?? ATTESTATION_RESOLVER_TTL_MS;
  }

  /**
   * The attestation for this fix, or null when unknown, expired, out of scope
   * (another account, session or installation) or not fix-bound for a
   * relocation. A relocation whose bound fix differs is returned with tamper.
   */
  async resolve(input: ResolveAttestationInput): Promise<FixAttestation | null> {
    const row = await this.load(attestationRefHash(input.ref), input.now.getTime());
    if (!row) return null;
    if (row.accountId !== input.accountId
      || row.sessionId !== input.sessionId
      || row.installationId !== input.installationId
      || row.expiresAt.getTime() <= input.now.getTime()) {
      return null;
    }
    let tamper = false;
    if (input.source === "relocation") {
      // DeviceCheck tokens cannot carry a challenge or fix; every other method
      // must have attested this exact fix for a relocation.
      if (row.method !== "devicecheck") {
        if (row.purpose !== "relocation" || !row.boundFix) return null;
        tamper = !boundFixMatches(row.boundFix, input.fix);
      }
    }
    return { id: row.id, method: row.method, outcome: row.outcome, assurance: row.assurance, tamper };
  }

  private async load(refHash: string, nowMs: number): Promise<StoredAttestation | null> {
    const cached = this.cache.get(refHash);
    if (cached && nowMs - cached.cachedAtMs < this.ttlMs) {
      this.cache.delete(refHash);
      this.cache.set(refHash, cached);
      return cached.row;
    }
    if (cached) this.cache.delete(refHash);
    const row = await this.store.findByRefHash(refHash);
    if (!row) return null;
    if (this.cache.size >= MAX_CACHED_REFS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(refHash, { row, cachedAtMs: nowMs });
    return row;
  }
}

/** Re-formats the wire fix with the shared toFixed rules and compares strings. */
export function boundFixMatches(
  bound: Readonly<{ lat: string; lon: string; accuracy: string; fixTimestampMs: string }>,
  fix: ResolveAttestationInput["fix"]
): boolean {
  if (typeof fix.fixTimestampMs !== "number" || !Number.isFinite(fix.fixTimestampMs)) return false;
  const formatted = formatAttestBoundFix({
    lat: fix.lat,
    lon: fix.lon,
    accuracy: fix.accuracy,
    fixTimestampMs: fix.fixTimestampMs
  });
  return formatted.lat === bound.lat
    && formatted.lon === bound.lon
    && formatted.accuracy === bound.accuracy
    && formatted.fixTimestampMs === bound.fixTimestampMs;
}
