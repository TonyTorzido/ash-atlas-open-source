import type { ItemRarity } from "@ash-atlas/shared";

import type { LootCard, LootCardEntry } from "./lootCards.js";

/**
 * Magnet-to-player loot feedback. Drops burst out of their source (kill spot, harvest node, pickup),
 * hang a moment, then are pulled into the player; a "+N" floats off the player and the HUD counter
 * reacts. Rare and better drops also get one compact pill. This file is the pure model (drops, cap,
 * pills, gold hold, burst and easing maths); the DOM runner lives in `ui/lootFlyRunner.ts` and the
 * pill stack in `ui/CombatRewardHud.tsx`.
 */

/** Most icons in the air at once; extra drops fold into a count label. */
export const LOOT_FLY_MAX_ACTIVE = 6;
/** Drops waiting for a free slot are dropped after this long (a HUD that never mounted must not leak). */
export const LOOT_FLY_QUEUE_TTL_MS = 5_000;
export const LOOT_PILL_MERGE_MS = 1_000;
export const LOOT_PILL_HOLD_MS = 2_400;
export const LOOT_PILL_FADE_MS = 400;
export const LOOT_PILL_MAX = 4;
/** A held gold amount is released after this long even if its coin never lands. */
export const LOOT_GOLD_HOLD_MAX_MS = 4_000;

const RARITY_RANK: Readonly<Record<ItemRarity, number>> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4
};

/** Rare and better earn the bottom-left pill; everything below only flies. */
export function isPillRarity(rarity: ItemRarity): boolean {
  return RARITY_RANK[rarity] >= RARITY_RANK.rare;
}

export type LootDropKind = "gold" | "item";

export type LootDrop = Readonly<{
  kind: LootDropKind;
  itemId: string | null;
  name: string;
  quantity: number;
  rarity: ItemRarity;
  /** Gold only: the hold ids released when this drop lands. */
  holdIds: readonly string[];
  /** Viewport pixel the icon pops out of; absent means the player. */
  origin?: LootFlyOrigin;
}>;

export type LootFlyOrigin = Readonly<{ x: number; y: number }>;

export type LootLaunch = Readonly<LootDrop & {
  /** Quantity of other drops folded into this icon because the air was full. */
  folded: number;
}>;

const dropGroup = (drop: Pick<LootDrop, "kind" | "itemId">): string => `${drop.kind}:${drop.itemId ?? ""}`;

/** Merges drops of the same kind and item; order of first appearance is kept. */
export function aggregateDrops(drops: readonly LootDrop[]): LootDrop[] {
  const merged = new Map<string, LootDrop>();
  for (const drop of drops) {
    if (drop.quantity <= 0) continue;
    const existing = merged.get(dropGroup(drop));
    merged.set(dropGroup(drop), existing
      ? { ...existing, quantity: existing.quantity + drop.quantity, holdIds: [...existing.holdIds, ...drop.holdIds] }
      : drop);
  }
  return [...merged.values()];
}

/** The icons a card sends to the HUD: gold first, then items, best rarity first. Ground drops never fly. */
export function dropsFromCard(card: LootCard, origin?: LootFlyOrigin): LootDrop[] {
  const drops = card.entries.filter((entry) => entry.kind !== "ground").map((entry): LootDrop => ({
    kind: entry.kind === "gold" ? "gold" : "item",
    itemId: entry.kind === "gold" ? null : entry.itemId,
    name: entry.name,
    quantity: entry.quantity,
    rarity: entry.rarity,
    holdIds: entry.kind === "gold" ? [`gold:${card.id}`] : [],
    ...(origin ? { origin } : {})
  }));
  return sortDrops(aggregateDrops(drops));
}

function sortDrops(drops: readonly LootDrop[]): LootDrop[] {
  return [...drops].sort((left, right) =>
    (left.kind === "gold" ? 0 : 1) - (right.kind === "gold" ? 0 : 1) ||
    RARITY_RANK[right.rarity] - RARITY_RANK[left.rarity]);
}

/** Entries that earn a pill: rare or better, whether delivered or left on the ground. */
export function pillEntriesFromCard(card: LootCard): LootCardEntry[] {
  return card.entries.filter((entry) => entry.kind !== "gold" && isPillRarity(entry.rarity));
}

/**
 * Splits drops into icons to launch now and drops to keep waiting. With `slots` free, the first
 * `slots` drops launch; any further drops fold into the last launched icon's count label. With no
 * free slot everything waits.
 */
export function planLaunches(
  drops: readonly LootDrop[],
  slots: number
): { launch: LootLaunch[]; waiting: LootDrop[] } {
  if (drops.length === 0) return { launch: [], waiting: [] };
  if (slots <= 0) return { launch: [], waiting: [...drops] };
  const launch = drops.slice(0, slots).map((drop): LootLaunch => ({ ...drop, folded: 0 }));
  const extras = drops.slice(slots);
  if (extras.length > 0) {
    const last = launch[launch.length - 1]!;
    launch[launch.length - 1] = {
      ...last,
      folded: extras.reduce((total, extra) => total + extra.quantity, 0),
      holdIds: [...last.holdIds, ...extras.flatMap((extra) => extra.holdIds)]
    };
  }
  return { launch, waiting: [] };
}

/** The count shown at the player: "+22", "+2". Folded extras are added to the total. */
export function lootLaunchLabel(launch: Pick<LootLaunch, "quantity" | "folded">): string {
  return `+${(launch.quantity + launch.folded).toLocaleString()}`;
}

/** Burst landing distance from the source (px). */
export const LOOT_BURST_MIN_PX = 30;
export const LOOT_BURST_MAX_PX = 40;
/** How high the burst arc rises above its start and the size of the single ground rebound (px). */
export const LOOT_BURST_RISE_PX = 34;
export const LOOT_BURST_REBOUND_PX = 6;

/** Where icon `index` of `count` lands: evenly spaced around the source, with jitter, 30-40px out. */
export function lootBurstPoint(
  origin: Readonly<{ x: number; y: number }>,
  index: number,
  count: number,
  random: () => number = Math.random
): { x: number; y: number } {
  const step = (Math.PI * 2) / Math.max(1, count);
  const angle = -Math.PI / 2 + index * step + (random() - 0.5) * Math.min(0.5, step * 0.35);
  const radius = LOOT_BURST_MIN_PX + (LOOT_BURST_MAX_PX - LOOT_BURST_MIN_PX) * random();
  return { x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius };
}

/** CSS-style cubic-bezier easing (x1,y1,x2,y2), solved by bisection; maps time 0..1 to progress. */
export function cubicBezierEase(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const axis = (a: number, b: number, u: number): number => 3 * a * u * (1 - u) * (1 - u) + 3 * b * u * u * (1 - u) + u * u * u;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      if (axis(x1, x2, mid) < t) lo = mid; else hi = mid;
    }
    return axis(y1, y2, (lo + hi) / 2);
  };
}

/** The magnet pull: slow start, fast finish. */
export const lootMagnetEase = cubicBezierEase(0.55, 0, 1, 0.45);
export const LOOT_MAGNET_END_SCALE = 0.25;

/** Landings within this window stack their "+N" a few px apart so they never overlap. */
export const LOOT_COUNT_STACK_WINDOW_MS = 150;
export const LOOT_COUNT_STACK_STEP_PX = 14;

/** Vertical offset (px, upward positive) for the next "+N" given recent landing times. */
export function lootCountStackOffset(recentLandingsMs: readonly number[], nowMs: number): number {
  const recent = recentLandingsMs.filter((at) => nowMs - at <= LOOT_COUNT_STACK_WINDOW_MS).length;
  return recent * LOOT_COUNT_STACK_STEP_PX;
}

export type LootPill = Readonly<{
  key: string;
  itemId: string | null;
  name: string;
  rarity: ItemRarity;
  quantity: number;
  createdAtMs: number;
  lastAtMs: number;
  expiresAtMs: number;
}>;

/** The bottom-left pills: merged inside a short window, capped, expiring on their own. */
export class LootPillState {
  private pills: LootPill[] = [];
  private serial = 0;

  push(entries: readonly Pick<LootCardEntry, "itemId" | "name" | "rarity" | "quantity">[], nowMs: number): void {
    for (const entry of entries) {
      const index = this.pills.findIndex((pill) =>
        pill.itemId === entry.itemId && pill.name === entry.name && nowMs - pill.lastAtMs <= LOOT_PILL_MERGE_MS);
      const expiresAtMs = nowMs + LOOT_PILL_HOLD_MS + LOOT_PILL_FADE_MS;
      if (index >= 0) {
        const pill = this.pills[index]!;
        this.pills[index] = { ...pill, quantity: pill.quantity + entry.quantity, lastAtMs: nowMs, expiresAtMs };
        continue;
      }
      this.serial += 1;
      this.pills = [...this.pills, {
        key: `pill:${this.serial}`, itemId: entry.itemId, name: entry.name, rarity: entry.rarity,
        quantity: entry.quantity, createdAtMs: nowMs, lastAtMs: nowMs, expiresAtMs
      }].slice(-LOOT_PILL_MAX);
    }
  }

  active(nowMs: number): readonly LootPill[] {
    return this.pills.filter((pill) => pill.expiresAtMs > nowMs);
  }

  prune(nowMs: number): void {
    this.pills = this.pills.filter((pill) => pill.expiresAtMs > nowMs);
  }

  clear(): void {
    this.pills = [];
  }
}

/** Opacity for one pill: full while held, fading over the last `LOOT_PILL_FADE_MS`. */
export function lootPillAlpha(pill: Pick<LootPill, "expiresAtMs">, nowMs: number): number {
  return Math.min(1, Math.max(0, (pill.expiresAtMs - nowMs) / LOOT_PILL_FADE_MS));
}

/**
 * Gold that has been paid but whose coin has not landed yet. The gold counter shows the wallet minus
 * this amount, then counts up when the hold is released. Holds expire on their own.
 */
export class LootGoldHold {
  private holds = new Map<string, { amount: number; expiresAtMs: number }>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  add(id: string, amount: number, nowMs: number): void {
    if (amount <= 0) return;
    this.holds.set(id, { amount, expiresAtMs: nowMs + LOOT_GOLD_HOLD_MAX_MS });
    this.changed();
  }

  release(ids: readonly string[]): void {
    let any = false;
    for (const id of ids) any = this.holds.delete(id) || any;
    if (any) this.changed();
  }

  held(nowMs: number): number {
    let total = 0;
    for (const [id, hold] of this.holds) {
      if (hold.expiresAtMs <= nowMs) {
        this.holds.delete(id);
        continue;
      }
      total += hold.amount;
    }
    return total;
  }

  /** Earliest expiry, so a subscriber can re-read exactly when a stuck hold lapses. */
  nextExpiryMs(): number | null {
    let next: number | null = null;
    for (const hold of this.holds.values()) next = next === null ? hold.expiresAtMs : Math.min(next, hold.expiresAtMs);
    return next;
  }

  getRevision = (): number => this.revision;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    if (this.holds.size === 0) return;
    this.holds.clear();
    this.changed();
  }

  private changed(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

/** Shared by the fly layer and the gold counter in the bottom HUD bar. */
export const lootGoldHold = new LootGoldHold();

/** Everything one controller owns: the launch queue and the pills. */
export class LootFlyState {
  readonly pills = new LootPillState();
  private queue: Array<{ drop: LootDrop; atMs: number }> = [];

  constructor(private readonly goldHold: LootGoldHold = lootGoldHold) {}

  accept(card: LootCard, nowMs: number, origin?: LootFlyOrigin): void {
    const drops = dropsFromCard(card, origin);
    for (const drop of drops) {
      if (drop.kind === "gold") this.goldHold.add(drop.holdIds[0]!, drop.quantity, nowMs);
      this.queue.push({ drop, atMs: nowMs });
    }
    this.pills.push(pillEntriesFromCard(card), nowMs);
  }

  /** Drops that can launch now given `activeCount` icons in the air; the rest stay queued (merged). */
  takeLaunches(activeCount: number, nowMs: number, max = LOOT_FLY_MAX_ACTIVE): LootLaunch[] {
    const expired = this.queue.filter((entry) => nowMs - entry.atMs > LOOT_FLY_QUEUE_TTL_MS);
    this.goldHold.release(expired.flatMap((entry) => entry.drop.holdIds));
    this.queue = this.queue.filter((entry) => nowMs - entry.atMs <= LOOT_FLY_QUEUE_TTL_MS);
    if (this.queue.length === 0) return [];
    const merged = sortDrops(aggregateDrops(this.queue.map((entry) => entry.drop)));
    const { launch, waiting } = planLaunches(merged, Math.max(0, max - activeCount));
    this.queue = waiting.map((drop) => ({ drop, atMs: this.queue[0]!.atMs }));
    return launch;
  }

  queued(): number {
    return this.queue.length;
  }

  clear(): void {
    this.goldHold.release(this.queue.flatMap((entry) => entry.drop.holdIds));
    this.queue = [];
    this.pills.clear();
  }
}
