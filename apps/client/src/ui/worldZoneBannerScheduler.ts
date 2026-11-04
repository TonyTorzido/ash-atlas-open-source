import type { WorldZoneBannerContent } from "@ash-atlas/shared";

/** Time in a new zone before its banner shows, so border walks do not flicker. */
export const WORLD_ZONE_BANNER_DWELL_MS = 1_500;
/** Shorter wait after login, travel arrival, or leaving an interior. */
export const WORLD_ZONE_BANNER_ARRIVAL_DWELL_MS = 500;
/** Quiet time after combat, death, travel, or the World Map before a held banner shows. */
export const WORLD_ZONE_BANNER_SETTLE_MS = 1_200;
/** The same zone is not announced again within this window. */
export const WORLD_ZONE_BANNER_REPEAT_COOLDOWN_MS = 90_000;

export type WorldZoneBannerSchedulerState = Readonly<{
  candidate: WorldZoneBannerContent | null;
  candidateSince: number;
  arrival: boolean;
  suppressed: boolean;
  releasedAt: number;
  presentedKey: string | null;
  presentedAt: Readonly<Record<string, number>>;
}>;

export type WorldZoneBannerObservation = Readonly<{
  now: number;
  content: WorldZoneBannerContent | null;
  /** Combat, travel, interiors, or the World Map: hold the banner until play resumes. */
  suppressed: boolean;
}>;

export type WorldZoneBannerDecision = Readonly<{
  state: WorldZoneBannerSchedulerState;
  show: WorldZoneBannerContent | null;
  /** When to observe again to finish a pending dwell; null when nothing is pending. */
  recheckAt: number | null;
}>;

export const INITIAL_WORLD_ZONE_BANNER_STATE: WorldZoneBannerSchedulerState = {
  candidate: null,
  candidateSince: 0,
  arrival: true,
  suppressed: false,
  releasedAt: Number.NEGATIVE_INFINITY,
  presentedKey: null,
  presentedAt: {}
};

/** Marks the next zone as an arrival (login, travel, interior exit) so it shows promptly. */
export function markWorldZoneArrival(
  state: WorldZoneBannerSchedulerState
): WorldZoneBannerSchedulerState {
  return { ...state, arrival: true, presentedKey: null };
}

export function observeWorldZone(
  state: WorldZoneBannerSchedulerState,
  { now, content, suppressed }: WorldZoneBannerObservation
): WorldZoneBannerDecision {
  let next = state;
  if (suppressed !== next.suppressed) {
    next = { ...next, suppressed, releasedAt: suppressed ? next.releasedAt : now };
  }
  if (!content) return { state: { ...next, candidate: null }, show: null, recheckAt: null };
  if (next.candidate?.key !== content.key) {
    next = { ...next, candidate: content, candidateSince: now };
  } else if (next.candidate !== content) {
    next = { ...next, candidate: content };
  }
  if (next.presentedKey === content.key) return { state: next, show: null, recheckAt: null };
  const dwellMs = next.arrival ? WORLD_ZONE_BANNER_ARRIVAL_DWELL_MS : WORLD_ZONE_BANNER_DWELL_MS;
  if (suppressed) return { state: next, show: null, recheckAt: null };
  const readyAt = Math.max(next.candidateSince + dwellMs, next.releasedAt + WORLD_ZONE_BANNER_SETTLE_MS);
  if (now < readyAt) return { state: next, show: null, recheckAt: readyAt };
  const lastShown = next.presentedAt[content.key];
  const repeat = lastShown !== undefined && now - lastShown < WORLD_ZONE_BANNER_REPEAT_COOLDOWN_MS;
  next = {
    ...next,
    arrival: false,
    presentedKey: content.key,
    presentedAt: repeat ? next.presentedAt : { ...next.presentedAt, [content.key]: now }
  };
  return { state: next, show: repeat ? null : content, recheckAt: null };
}
