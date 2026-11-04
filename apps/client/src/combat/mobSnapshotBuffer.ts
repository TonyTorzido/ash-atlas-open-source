import { distanceMeters, type LatLon } from "@ash-atlas/shared";

/**
 * Timestamped snapshot interpolation for world mobs (the approach remote players already use, see
 * movement/playerRenderSmoothing.ts): each server sample is stamped with the combat delta's `serverTime`, and a mob is drawn at
 * `serverNow - MOB_INTERPOLATION_DELAY_MS` between the two samples around that moment. Packet arrival jitter no longer changes
 * the glide speed, and velocity is continuous across deltas (the old companion smoother restarted a linear glide from the drawn
 * position on every 10 Hz delta, over a duration taken from how late the packet happened to be).
 *
 * The delay is also what the server rewinds a swing by (RTT/2 + this), so the hit test sees the mob where the player saw it.
 * It does not move telegraph decals: they are anchored to the server's strike time (combat/telegraphWindow.ts), not to the mob
 * sprite, and a casting mob stands still.
 */

/** How far behind the synchronized server clock mobs are drawn. Combat deltas arrive at 10 Hz (100 ms apart). */
export const MOB_INTERPOLATION_DELAY_MS = 110;
/** Past the newest sample the mob keeps its last velocity this long... */
export const MOB_EXTRAPOLATE_MS = 60;
/** ...then eases back to the newest sample over this long (a mob that stopped is not left ahead of where it is). */
export const MOB_EXTRAPOLATE_EASE_BACK_MS = 120;
/** A velocity from two samples further apart than this is stale and not extrapolated. */
export const MOB_VELOCITY_MAX_GAP_MS = 300;
const MOB_SAMPLE_CAPACITY = 4;

export type MobSnapshotSample = { serverMs: number; lat: number; lon: number };

export type MobSnapshotTrack = {
  samples: MobSnapshotSample[];
  /** The drawn point; the same object while the position does not change. */
  current: LatLon | null;
};

export function createMobSnapshotTrack(): MobSnapshotTrack {
  return { samples: [], current: null };
}

/**
 * Adds one server sample. A sample older than the newest is dropped; a jump past `snapM` (a teleport, respawn or reposition)
 * restarts the track so the mob does not glide across the map. A repeat of the same position is kept (it says "still here").
 */
export function pushMobSample(track: MobSnapshotTrack, serverMs: number, lat: number, lon: number, snapM: number): void {
  const samples = track.samples;
  const newest = samples[samples.length - 1];
  if (newest) {
    if (serverMs < newest.serverMs) return;
    if (serverMs === newest.serverMs && newest.lat === lat && newest.lon === lon) return;
    if (distanceMeters(newest, { lat, lon }) > snapM) {
      samples.length = 0;
      track.current = null;
    }
  }
  if (samples.length >= MOB_SAMPLE_CAPACITY) samples.shift();
  samples.push({ serverMs, lat, lon });
}

/**
 * The drawn point at `renderServerMs` (server epoch ms): interpolated between the surrounding samples, held at the oldest before
 * them, and a short eased extrapolation past the newest. Null with no samples.
 */
export function sampleMobTrack(track: MobSnapshotTrack, renderServerMs: number): LatLon | null {
  const samples = track.samples;
  const count = samples.length;
  if (count === 0) return null;
  const first = samples[0]!;
  const last = samples[count - 1]!;
  let lat: number;
  let lon: number;
  if (count === 1 || renderServerMs <= first.serverMs) {
    lat = first.lat;
    lon = first.lon;
  } else if (renderServerMs >= last.serverMs) {
    lat = last.lat;
    lon = last.lon;
    const previous = samples[count - 2]!;
    const gapMs = last.serverMs - previous.serverMs;
    if (gapMs > 0 && gapMs <= MOB_VELOCITY_MAX_GAP_MS) {
      const aheadMs = renderServerMs - last.serverMs;
      const reachMs = Math.min(aheadMs, MOB_EXTRAPOLATE_MS);
      const easeBack = aheadMs <= MOB_EXTRAPOLATE_MS
        ? 1
        : Math.max(0, 1 - (aheadMs - MOB_EXTRAPOLATE_MS) / MOB_EXTRAPOLATE_EASE_BACK_MS);
      const scale = (reachMs * easeBack) / gapMs;
      lat += (last.lat - previous.lat) * scale;
      lon += (last.lon - previous.lon) * scale;
    }
  } else {
    let index = 1;
    while (index < count - 1 && samples[index]!.serverMs < renderServerMs) index += 1;
    const a = samples[index - 1]!;
    const b = samples[index]!;
    const span = b.serverMs - a.serverMs;
    const t = span > 0 ? (renderServerMs - a.serverMs) / span : 1;
    lat = a.lat + (b.lat - a.lat) * t;
    lon = a.lon + (b.lon - a.lon) * t;
  }
  const current = track.current;
  if (current && current.lat === lat && current.lon === lon) return current;
  track.current = { lat, lon };
  return track.current;
}
