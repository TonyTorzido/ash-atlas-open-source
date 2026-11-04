import { POSITION_HISTORY_TICKS } from "@ash-atlas/shared";

/** Mutable lat/lon output for `positionAtTick` (reuse one per caller; nothing is allocated). */
export type PositionOut = { lat: number; lon: number };

type Ring = {
  /** (tick, lat, lon) triples, `capacity` long. */
  samples: Float64Array;
  /** Slot the next write goes to. */
  head: number;
  /** Valid samples (0..capacity). */
  count: number;
};

/**
 * Short per-entity position history for lag-compensated hit tests (action combat rewind; PvP later).
 *
 * Each entity that moves gets a preallocated Float64Array ring of (tick, lat, lon), created on its
 * first write and returned to a pool on removal. Idle entities cost nothing: no write, no ring.
 *
 * Positions are a step function of server ticks: a write at tick T holds until the next write.
 * `positionAtTick` therefore returns the latest sample at or before the asked tick, and only
 * interpolates (linearly) across the final tick before the next sample, so a fractional tick
 * between two consecutive per-tick chase steps lands between them, while a mob that stood still
 * for 40 ticks and then moved is not smeared across those 40 ticks.
 */
export class PositionHistory {
  private readonly rings = new Map<string, Ring>();
  private readonly pool: Ring[] = [];

  constructor(readonly capacity: number = POSITION_HISTORY_TICKS) {
    if (!Number.isInteger(capacity) || capacity < 2) throw new Error("position history needs at least 2 samples");
  }

  /** Entities currently holding a ring (for tests and diagnostics). */
  get size(): number {
    return this.rings.size;
  }

  /** Records the position an entity holds from `tick` on. A second write in the same tick replaces the first. */
  record(entityId: string, tick: number, lat: number, lon: number): void {
    let ring = this.rings.get(entityId);
    if (!ring) {
      ring = this.pool.pop() ?? { samples: new Float64Array(this.capacity * 3), head: 0, count: 0 };
      ring.head = 0;
      ring.count = 0;
      this.rings.set(entityId, ring);
    }
    const samples = ring.samples;
    if (ring.count > 0) {
      const newest = (ring.head + this.capacity - 1) % this.capacity;
      const newestTick = samples[newest * 3]!;
      if (newestTick === tick) {
        samples[newest * 3 + 1] = lat;
        samples[newest * 3 + 2] = lon;
        return;
      }
      if (tick < newestTick) {
        // Ticks only go forward; a write from the past means the clock was reset. Start over.
        ring.head = 0;
        ring.count = 0;
      }
    }
    const offset = ring.head * 3;
    samples[offset] = tick;
    samples[offset + 1] = lat;
    samples[offset + 2] = lon;
    ring.head = (ring.head + 1) % this.capacity;
    if (ring.count < this.capacity) ring.count += 1;
  }

  /**
   * Where the entity was at `tick` (fractional ticks allowed), written into `out`, which is returned.
   * Falls back to `fallback` (the current position) when there is no history, when the tick is at
   * or after the newest sample, or when it is older than the oldest sample still held.
   */
  positionAtTick(
    entityId: string,
    tick: number,
    fallback: Readonly<{ lat: number; lon: number }>,
    out: PositionOut
  ): PositionOut {
    const ring = this.rings.get(entityId);
    if (!ring || ring.count === 0 || !Number.isFinite(tick)) return copyInto(fallback, out);
    const capacity = this.capacity;
    const samples = ring.samples;
    const oldestSlot = (ring.head + capacity - ring.count) % capacity;
    const newestSlot = (ring.head + capacity - 1) % capacity;
    if (tick >= samples[newestSlot * 3]! || tick < samples[oldestSlot * 3]!) return copyInto(fallback, out);
    // Walk back from the newest sample to the latest one at or before `tick`; the sample after it bounds it.
    let laterSlot = newestSlot;
    for (let step = 1; step < ring.count; step += 1) {
      const slot = (newestSlot + capacity - step) % capacity;
      const sampleTick = samples[slot * 3]!;
      if (sampleTick <= tick) {
        const laterTick = samples[laterSlot * 3]!;
        const lat = samples[slot * 3 + 1]!;
        const lon = samples[slot * 3 + 2]!;
        // Held at this sample until the tick before the next write, then moved across that one tick.
        const fraction = tick - (laterTick - 1);
        if (fraction <= 0) {
          out.lat = lat;
          out.lon = lon;
          return out;
        }
        const laterLat = samples[laterSlot * 3 + 1]!;
        let laterLon = samples[laterSlot * 3 + 2]!;
        if (laterLon - lon > 180) laterLon -= 360;
        else if (lon - laterLon > 180) laterLon += 360;
        out.lat = lat + (laterLat - lat) * fraction;
        let interpolatedLon = lon + (laterLon - lon) * fraction;
        if (interpolatedLon > 180) interpolatedLon -= 360;
        else if (interpolatedLon < -180) interpolatedLon += 360;
        out.lon = interpolatedLon;
        return out;
      }
      laterSlot = slot;
    }
    return copyInto(fallback, out);
  }

  /** Forgets the history (a teleport); the ring stays allocated for the next write. */
  reset(entityId: string): void {
    const ring = this.rings.get(entityId);
    if (!ring) return;
    ring.head = 0;
    ring.count = 0;
  }

  /** Drops the entity and returns its ring to the pool. */
  release(entityId: string): void {
    const ring = this.rings.get(entityId);
    if (!ring) return;
    this.rings.delete(entityId);
    ring.head = 0;
    ring.count = 0;
    this.pool.push(ring);
  }

  /** Number of samples held for an entity (0 when it has none). */
  sampleCount(entityId: string): number {
    return this.rings.get(entityId)?.count ?? 0;
  }
}

function copyInto(source: Readonly<{ lat: number; lon: number }>, out: PositionOut): PositionOut {
  out.lat = source.lat;
  out.lon = source.lon;
  return out;
}
