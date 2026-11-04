/**
 * Death backpack drop: a player who dies drops their lowest-level
 * backpack plus whatever they can no longer carry without it. Everything lies
 * on the ground at the death spot, pickable by anyone, and despawns on the
 * normal ground-drop timer. The server decides and moves the items; this
 * module is only the pure selection order so it can be tested and shown.
 *
 * Which backpack: the victim's backpacks that are equipped or carried as a
 * spare (never Manor storage). Lowest upgrade level first (+0, then +1, ...);
 * ties go to an equipped pack before a carried spare, then the highest
 * equipped slot, then the lowest instance id. Exactly one backpack drops; with
 * no backpack nothing drops at all.
 *
 * Overflow: once the pack is gone, while carried weight is above the new
 * maximum, things drop at random until it fits. One candidate list mixes
 * droppable stacks (unit weight above zero) and droppable unequipped gear; it
 * is sorted by a stable key (so a given random source always gives the same
 * order), Fisher-Yates shuffled, then walked in order. A stack drops only the
 * units still needed (rounded up, capped at what may leave); gear drops whole.
 * PvP and PvE deaths use the same rule.
 * Never dropped: wallet gold, Glimmer, Lumen and other weightless items,
 * equipped gear, other backpacks, and anything existing drop rules forbid
 * (not droppable, kept by a keep policy, protected, in a saved kit, or in a
 * pending equipment operation). If the load still cannot fit after every
 * droppable thing, nothing drops (the database refuses an over-capacity
 * carry), and the outcome says "cannot_fit".
 */

import { isBeginnerProtectedLevel } from "./pvpTimers.js";

/** Overworld PvP deaths drop a backpack. */
export const DEATH_BACKPACK_DROP_ON_PVP = true;
/** Overworld PvE (mob and world) deaths drop a backpack. */
export const DEATH_BACKPACK_DROP_ON_PVE = true;
/** Dungeon floors are private instances no one else can reach, so dungeon deaths drop nothing. */
export const DEATH_BACKPACK_DROP_IN_DUNGEON = false;

/** Where the player was when they died. Interiors (manor rooms, shops) never drop. */
export type DeathDropSpace = "overworld" | "dungeon" | "interior";

export type DeathDropOutcome =
  | "dropped"
  | "protected"
  | "dungeon"
  | "interior"
  | "disabled"
  | "unknown_context"
  | "no_backpack"
  | "cannot_fit";

export type DeathDropBackpackCandidate = Readonly<{
  instanceId: string;
  upgradeLevel: number;
  location: "equipped" | "inventory";
  equippedSlot: number | null;
}>;

export type DeathDropStackCandidate = Readonly<{
  itemId: string;
  variant: string | null;
  quantity: number;
  /** Units existing drop rules allow to leave the inventory (0 when not droppable). */
  droppableQuantity: number;
  unitWeightGrams: number;
}>;

export type DeathDropEquipmentCandidate = Readonly<{
  instanceId: string;
  itemId: string;
  unitWeightGrams: number;
  droppable: boolean;
}>;

export type DeathDropPlanEntry =
  | Readonly<{ kind: "stack"; itemId: string; variant: string | null; quantity: number }>
  | Readonly<{ kind: "equipment"; itemId: string; instanceId: string }>;

export type DeathDropPlan = Readonly<{
  /** Everything that leaves, in the shuffled order it was chosen. */
  entries: readonly DeathDropPlanEntry[];
  stacks: readonly Readonly<{ itemId: string; variant: string | null; quantity: number }>[];
  equipmentInstanceIds: readonly string[];
  fits: boolean;
}>;

/** One line of the death summary shown to the victim. */
export type DeathDropSummaryLine = Readonly<{
  kind: "backpack" | "item" | "equipment";
  itemId: string;
  name: string;
  quantity: number;
}>;

export type DeathDropSummary = Readonly<{
  outcome: DeathDropOutcome;
  lines: readonly DeathDropSummaryLine[];
}>;

/** Why this death drops nothing, or null when it should drop. Order: context, space, rules, level. */
export function deathBackpackDropSkipReason(input: Readonly<{
  space: DeathDropSpace | null;
  killedByPlayer: boolean;
  level: number;
}>): Exclude<DeathDropOutcome, "dropped" | "no_backpack" | "cannot_fit"> | null {
  if (input.space === null) return "unknown_context";
  if (input.space === "interior") return "interior";
  if (input.space === "dungeon" && !DEATH_BACKPACK_DROP_IN_DUNGEON) return "dungeon";
  if (input.killedByPlayer ? !DEATH_BACKPACK_DROP_ON_PVP : !DEATH_BACKPACK_DROP_ON_PVE) return "disabled";
  // Beginner protection (pvpTimers.ts): players at that level or lower drop nothing.
  if (isBeginnerProtectedLevel(input.level)) return "protected";
  return null;
}

/** The single backpack a death drops, or null when the player carries none. */
export function chooseDeathDropBackpack<T extends DeathDropBackpackCandidate>(
  candidates: readonly T[]
): T | null {
  const sorted = [...candidates].sort((left, right) =>
    left.upgradeLevel - right.upgradeLevel ||
    locationRank(left) - locationRank(right) ||
    (right.equippedSlot ?? -1) - (left.equippedSlot ?? -1) ||
    compareText(left.instanceId, right.instanceId)
  );
  return sorted[0] ?? null;
}

/** What else must leave, chosen at random, so the remaining carry fits the maximum after the pack is gone. */
export function planDeathDropOverflow(input: Readonly<{
  carriedWeightGrams: bigint;
  maximumWeightGramsAfter: bigint;
  stacks: readonly DeathDropStackCandidate[];
  equipment: readonly DeathDropEquipmentCandidate[];
  /** Uniform in [0, 1); Math.random on the server, a fixed sequence in tests. */
  random: () => number;
}>): DeathDropPlan {
  type Candidate =
    | { kind: "stack"; key: string; stack: DeathDropStackCandidate }
    | { kind: "equipment"; key: string; item: DeathDropEquipmentCandidate };
  const candidates: Candidate[] = [
    ...input.stacks
      .filter((stack) => stack.unitWeightGrams > 0 && stack.droppableQuantity > 0 && stack.quantity > 0)
      .map((stack) => ({ kind: "stack" as const, key: `stack:${stack.itemId}:${stack.variant ?? ""}`, stack })),
    ...input.equipment
      .filter((item) => item.droppable && item.unitWeightGrams > 0)
      .map((item) => ({ kind: "equipment" as const, key: `equipment:${item.instanceId}`, item }))
  ].sort((left, right) => compareText(left.key, right.key));
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const pick = Math.min(index, Math.max(0, Math.floor(input.random() * (index + 1))));
    [candidates[index], candidates[pick]] = [candidates[pick]!, candidates[index]!];
  }
  let excess = input.carriedWeightGrams - input.maximumWeightGramsAfter;
  const entries: DeathDropPlanEntry[] = [];
  for (const candidate of candidates) {
    if (excess <= 0n) break;
    if (candidate.kind === "equipment") {
      entries.push({ kind: "equipment", itemId: candidate.item.itemId, instanceId: candidate.item.instanceId });
      excess -= BigInt(candidate.item.unitWeightGrams);
      continue;
    }
    const { stack } = candidate;
    const unit = BigInt(stack.unitWeightGrams);
    const needed = (excess + unit - 1n) / unit;
    const available = BigInt(Math.min(stack.droppableQuantity, stack.quantity));
    const quantity = needed < available ? needed : available;
    entries.push({ kind: "stack", itemId: stack.itemId, variant: stack.variant, quantity: Number(quantity) });
    excess -= quantity * unit;
  }
  return {
    entries,
    stacks: entries.flatMap((entry) => entry.kind === "stack"
      ? [{ itemId: entry.itemId, variant: entry.variant, quantity: entry.quantity }]
      : []),
    equipmentInstanceIds: entries.flatMap((entry) => entry.kind === "equipment" ? [entry.instanceId] : []),
    fits: excess <= 0n
  };
}

/** One readable line for the death summary ("Backpack +0", "Hog Carcass x3"). */
export function deathDropSummaryText(summary: DeathDropSummary | null | undefined): string | null {
  if (!summary || summary.lines.length === 0) return null;
  return `Dropped ${summary.lines
    .map((line) => line.quantity > 1 ? `${line.name} x${line.quantity.toLocaleString("en-US")}` : line.name)
    .join(", ")}`;
}

function locationRank(candidate: DeathDropBackpackCandidate): number {
  return candidate.location === "equipped" ? 0 : 1;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
