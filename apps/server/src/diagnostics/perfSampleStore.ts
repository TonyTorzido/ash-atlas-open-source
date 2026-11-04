import { z } from "zod";

export const PERF_SAMPLES_PER_USER = 2000;
const MAX_TRACKED_USERS = 50;
/** Hard cap on accepted uploads per user per rolling minute (clients send about 6). */
const MAX_UPLOADS_PER_MINUTE = 20;

const num = z.number().finite().min(-1e9).max(1e9);
const optionalNum = num.nullable().optional();
/** Epoch milliseconds are about 1.8e12, far above `num`'s bound; this is what rejected every real upload. */
const epochMs = z.number().finite().min(0).max(1e15);

/** One compact client probe sample. Unknown keys are dropped. */
export const perfSampleSchema = z.object({
  clientAtMs: epochMs,
  fps: num,
  windowMs: optionalNum,
  activeMs: optionalNum,
  hiddenMs: optionalNum,
  frames: optionalNum,
  fpsActive: optionalNum,
  drawMapPerFrame: optionalNum,
  drawPixiPerFrame: optionalNum,
  zoomMs: optionalNum,
  moveMs: optionalNum,
  travelMs: optionalNum,
  worldMapOpen: z.boolean().optional(),
  locationMode: z.string().max(32).optional(),
  renderReasons: z.string().max(200).optional(),
  keyIgnored: z.string().max(200).optional(),
  staticLiveRedraws: optionalNum,
  frameP50Ms: num,
  frameP95Ms: num,
  frameP99Ms: num,
  framesOver50Ms: num,
  drawCallsPerFrame: num,
  textureCount: num,
  textureMb: num,
  jsHeapMb: optionalNum,
  retainedDisplayObjects: num,
  combatEntities: num,
  gameAppRendersPerSec: num,
  eventLoopLagMs: num,
  wsMsgsPerSec: num,
  wsKbPerSec: num,
  dpr: num,
  overlayResolution: optionalNum,
  legacyRenderQuality: z.boolean(),
  rttMs: optionalNum,
  deltaGapP95Ms: optionalNum,
  playerDeltaGapP95Ms: optionalNum,
  combatDeltaGapP95Ms: optionalNum,
  swings: optionalNum,
  swingPressToResultP95Ms: optionalNum,
  frameMaxMs: optionalNum,
  dynOverlayMsPerFrame: optionalNum,
  pixiRenderMsPerFrame: optionalNum,
  rendersPerFrame: optionalNum,
  staticRedraws: optionalNum,
  staticDrawMaxMs: optionalNum,
  gameAppRenders: optionalNum,
  longTasks: optionalNum,
  longTaskMaxMs: optionalNum,
  userAgent: z.string().max(240),
  build: z.string().max(64),
  zone: z.string().max(64).nullable().optional()
});

export type PerfSample = z.infer<typeof perfSampleSchema>;
export type StoredPerfSample = PerfSample & Readonly<{ serverAtMs: number }>;

/** Bounded in-memory ring per user. No persistence: the `perf-sample` log line survives restarts. */
export class PerfSampleStore {
  private readonly samples = new Map<string, StoredPerfSample[]>();
  private readonly uploadTimes = new Map<string, number[]>();

  constructor(
    private readonly capacityPerUser = PERF_SAMPLES_PER_USER,
    private readonly maxUploadsPerMinute = MAX_UPLOADS_PER_MINUTE
  ) {}

  /** Returns false when the user is over the upload rate limit; the sample is then dropped. */
  add(playerId: string, sample: PerfSample, nowMs = Date.now()): StoredPerfSample | null {
    const recent = (this.uploadTimes.get(playerId) ?? []).filter((at) => nowMs - at < 60_000);
    if (recent.length >= this.maxUploadsPerMinute) {
      this.uploadTimes.set(playerId, recent);
      return null;
    }
    recent.push(nowMs);
    this.uploadTimes.set(playerId, recent);
    let ring = this.samples.get(playerId);
    if (!ring) {
      if (this.samples.size >= MAX_TRACKED_USERS) {
        const oldest = this.samples.keys().next().value;
        if (oldest !== undefined) {
          this.samples.delete(oldest);
          this.uploadTimes.delete(oldest);
        }
      }
      ring = [];
      this.samples.set(playerId, ring);
    }
    const stored: StoredPerfSample = { ...sample, serverAtMs: nowMs };
    ring.push(stored);
    if (ring.length > this.capacityPerUser) ring.splice(0, ring.length - this.capacityPerUser);
    return stored;
  }

  read(options: { playerId?: string | undefined; sinceMs?: number | undefined; limit?: number | undefined } = {}): Record<string, StoredPerfSample[]> {
    const limit = Math.max(1, Math.min(options.limit ?? this.capacityPerUser, this.capacityPerUser));
    const result: Record<string, StoredPerfSample[]> = {};
    for (const [playerId, ring] of this.samples) {
      if (options.playerId && options.playerId !== playerId) continue;
      const filtered = options.sinceMs === undefined
        ? ring
        : ring.filter((sample) => sample.serverAtMs >= options.sinceMs!);
      result[playerId] = filtered.slice(-limit);
    }
    return result;
  }
}
