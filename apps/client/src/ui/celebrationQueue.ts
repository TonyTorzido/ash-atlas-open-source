import { WORLD_ZONE_BIOME_NAMES, biomeLegendId, type BiomeDiscoveryCelebration } from "@ash-atlas/shared";

export const CELEBRATION_EYEBROW_REGION = "NEW REGION DISCOVERED";
export const CELEBRATION_EYEBROW_ACHIEVEMENT = "ACHIEVEMENT UNLOCKED";

/** One passive celebration card. `key` makes a card play at most once per session. */
export type CelebrationCard = Readonly<{
  key: string;
  eyebrow: typeof CELEBRATION_EYEBROW_REGION | typeof CELEBRATION_EYEBROW_ACHIEVEMENT;
  /** The achievement title (the region name when a discovery completed no achievement). */
  title: string;
  points: number | null;
  honor: string | null;
}>;

export type CelebrationQueueState = Readonly<{
  queue: readonly CelebrationCard[];
  current: CelebrationCard | null;
  /** Keys already queued or played this session. */
  seen: readonly string[];
}>;

export const INITIAL_CELEBRATION_QUEUE: CelebrationQueueState = { queue: [], current: null, seen: [] };

/**
 * The region card first (the zone banner already names the region, so the card carries the
 * region's own achievement), then one "achievement unlocked" card per other unlock.
 */
export function celebrationCardsFor(celebration: BiomeDiscoveryCelebration): CelebrationCard[] {
  const regionId = biomeLegendId(celebration.biome);
  const regional = celebration.achievements.find((entry) => entry.id === regionId) ?? null;
  const cards: CelebrationCard[] = [{
    key: `region:${celebration.biome}`,
    eyebrow: CELEBRATION_EYEBROW_REGION,
    title: regional?.title ?? WORLD_ZONE_BIOME_NAMES[celebration.biome],
    points: regional?.points ?? null,
    honor: regional?.honor ?? null
  }];
  for (const entry of celebration.achievements) {
    if (entry.id === regionId) continue;
    cards.push(achievementCard(entry.id, entry.title, entry.points, entry.honor ?? null));
  }
  return cards;
}

export function achievementCard(
  id: string,
  title: string,
  points: number | null = null,
  honor: string | null = null
): CelebrationCard {
  return { key: `achievement:${id}`, eyebrow: CELEBRATION_EYEBROW_ACHIEVEMENT, title, points, honor };
}

export function enqueueCelebrations(
  state: CelebrationQueueState,
  cards: readonly CelebrationCard[]
): CelebrationQueueState {
  const seen = new Set(state.seen);
  const fresh: CelebrationCard[] = [];
  for (const card of cards) {
    if (seen.has(card.key)) continue;
    seen.add(card.key);
    fresh.push(card);
  }
  if (fresh.length === 0) return state;
  return { ...state, queue: [...state.queue, ...fresh], seen: [...seen] };
}

/** Moves the head of the queue onto the stage when nothing is playing. */
export function startNextCelebration(state: CelebrationQueueState): CelebrationQueueState {
  if (state.current || state.queue.length === 0) return state;
  const [head, ...rest] = state.queue;
  return { ...state, queue: rest, current: head! };
}

export function finishCelebration(state: CelebrationQueueState): CelebrationQueueState {
  return state.current ? { ...state, current: null } : state;
}

/** A fight, trip or map opening stops the card; it replays in full once things settle. */
export function interruptCelebration(state: CelebrationQueueState): CelebrationQueueState {
  if (!state.current) return state;
  return { ...state, queue: [state.current, ...state.queue], current: null };
}

export function celebrationAnnouncement(card: CelebrationCard): string {
  const parts = [card.eyebrow.charAt(0) + card.eyebrow.slice(1).toLowerCase(), card.title];
  if (card.points !== null) parts.push(`Plus ${card.points} points`);
  if (card.honor) parts.push(`Honor: ${card.honor}`);
  return `${parts.join(". ")}.`;
}
