import {
  HOTBAR_PLAYER_SLOT_IDS,
  defaultHotbarSettings,
  hotbarPlayerSlotSchema,
  type HotbarBinding,
  type HotbarPlayerSlot,
  type PlayerInventoryItem,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { FIELD_CONSUMABLE_ITEM_IDS, INVENTORY_CATALOG } from "@ash-atlas/shared";

/**
 * The utility hotbar intentionally exposes only actions with a canonical
 * gameplay command. Giving Berry heals through the existing heal/use path;
 * fishing rods use the existing fishing path. Other consumables (including
 * the retired Torch and Simple Food shortcuts) stay in Inventory and are not
 * offered as hotbar choices.
 */
export const HOTBAR_SUPPORTED_CONSUMABLE_IDS = new Set<string>(["giving_berry", ...FIELD_CONSUMABLE_ITEM_IDS]);

/** Existing canonical direct-use commands exposed by the client protocol. */
export const HOTBAR_ACTIONABLE_CONSUMABLE_IDS = new Set<string>([
  "giving_berry",
  ...FIELD_CONSUMABLE_ITEM_IDS
]);

export type HotbarSlotLayout = Readonly<{
  slotId: (typeof HOTBAR_PLAYER_SLOT_IDS)[number];
  side: "left" | "right";
  index: number;
  keyLabel: string;
}>;

export const HOTBAR_SLOT_LAYOUT: readonly HotbarSlotLayout[] = [
  { slotId: "left-1", side: "left", index: 0, keyLabel: "1" },
  { slotId: "left-2", side: "left", index: 1, keyLabel: "2" },
  { slotId: "left-3", side: "left", index: 2, keyLabel: "3" },
  { slotId: "left-4", side: "left", index: 3, keyLabel: "4" },
  { slotId: "left-5", side: "left", index: 4, keyLabel: "5" },
  { slotId: "right-1", side: "right", index: 0, keyLabel: "6" },
  { slotId: "right-2", side: "right", index: 1, keyLabel: "7" },
  { slotId: "right-3", side: "right", index: 2, keyLabel: "8" },
  { slotId: "right-4", side: "right", index: 3, keyLabel: "9" },
  { slotId: "right-5", side: "right", index: 4, keyLabel: "0" }
];

/** A row is the paired left/right slot sharing one vertical anchor. */
export function hotbarRowForSlot(slotId: HotbarPlayerSlot["slotId"]): number {
  const match = /-(\d+)$/.exec(slotId);
  return match ? Math.max(0, Number(match[1]) - 1) : 0;
}

/** The bottom two visible rows (four slots, both sides) are unlocked by default. */
export function isHotbarSlotUnlocked(
  slotId: HotbarPlayerSlot["slotId"],
  visibleRows: number
): boolean {
  const row = hotbarRowForSlot(slotId);
  const count = Math.min(5, Math.max(0, Math.trunc(visibleRows)));
  return count > 0 && row >= count - 2 && row < count;
}

export type HotbarBindingResolution = Readonly<{
  binding: HotbarBinding;
  item: PlayerInventoryItem | null;
  available: boolean;
  actionable: boolean;
  reason: string | null;
}>;

export type HotbarActivatableItem = NonNullable<HotbarBindingResolution["item"]>;

export type HotbarItemChoice = Readonly<{
  binding: HotbarBinding;
  item: PlayerInventoryItem;
  name: string;
  quantity: number;
  usesRemaining: number | null;
  actionable: boolean;
}>;

/** Same starting slots as a player without saved settings (builder + heal in the bottom row). */
export function defaultHotbarSlots(): HotbarPlayerSlot[] {
  return defaultHotbarSettings().slots;
}

/** Parse persisted data without allowing malformed slots into the UI state. */
export function normalizeHotbarSlots(value: unknown): HotbarPlayerSlot[] {
  if (!Array.isArray(value)) return defaultHotbarSlots();
  const parsed = value
    .map((slot) => hotbarPlayerSlotSchema.safeParse(slot))
    .filter((result): result is { success: true; data: HotbarPlayerSlot } => result.success)
    .map((result) => result.data);
  const byId = new Map(parsed.map((slot) => [slot.slotId, slot]));
  return HOTBAR_PLAYER_SLOT_IDS.map((slotId) => byId.get(slotId) ?? ({ slotId, binding: null }));
}

export function sameHotbarSlots(
  left: readonly HotbarPlayerSlot[],
  right: readonly HotbarPlayerSlot[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((slot, index) => {
    const other = right[index];
    return other?.slotId === slot.slotId && hotbarBindingKey(other.binding) === hotbarBindingKey(slot.binding);
  });
}

export function hotbarBindingForInventoryItem(item: PlayerInventoryItem): HotbarBinding | null {
  if (item.resourceType === "fishing_rod") {
    const rodId = item.rodId ?? (item.variant && item.variant !== "default" ? item.variant : null);
    return rodId ? { kind: "fishing_rod", rodId } : null;
  }
  const catalog = INVENTORY_CATALOG[String(item.resourceType)];
  if (catalog?.kind !== "consumable" || !HOTBAR_SUPPORTED_CONSUMABLE_IDS.has(String(item.resourceType))) {
    return null;
  }
  return {
    kind: "consumable",
    itemId: String(item.resourceType),
    variant: item.variant ?? "default"
  };
}

/** Groups in the quick-slot picker, in display order. */
export const HOTBAR_CHOICE_CATEGORIES = [
  { id: "building", label: "Building", hint: "Flags and buoys" },
  { id: "tools", label: "Tools", hint: "Plant and dig" },
  { id: "healing", label: "Healing", hint: "Restore health" },
  { id: "fishing", label: "Fishing", hint: "Rods you carry" },
  { id: "gear", label: "Gear", hint: "Gear scrolls" },
  { id: "items", label: "Other items", hint: "Other usable items" }
] as const;
export type HotbarChoiceCategory = (typeof HOTBAR_CHOICE_CATEGORIES)[number]["id"];

export function hotbarChoiceCategory(binding: HotbarBinding): HotbarChoiceCategory {
  switch (binding.kind) {
    case "action": return binding.actionId === "anchor_build" ? "building" : "tools";
    case "fishing_rod": return "fishing";
    case "gear_scroll": return "gear";
    case "consumable": return binding.itemId === "giving_berry" ? "healing" : "items";
  }
}

export function hotbarItemChoices(snapshot: PlayerInventorySnapshot): HotbarItemChoice[] {
  const choices = new Map<string, HotbarItemChoice>();
  for (const item of snapshot.items) {
    if (item.quantity <= 0) continue;
    const binding = hotbarBindingForInventoryItem(item);
    if (!binding) continue;
    if (binding.kind === "fishing_rod" && (item.usesRemaining ?? 0) <= 0) continue;
    const catalog = INVENTORY_CATALOG[String(item.resourceType)];
    const key = hotbarBindingKey(binding);
    const existing = choices.get(key);
    if (existing && existing.quantity >= item.quantity) continue;
    choices.set(key, {
      binding,
      item,
      name: displayNameForItem(item, catalog?.displayName ?? String(item.resourceType)),
      quantity: item.quantity,
      usesRemaining: item.resourceType === "fishing_rod" ? item.usesRemaining ?? 0 : null,
      actionable: binding.kind === "fishing_rod" ||
        (binding.kind === "consumable" && HOTBAR_ACTIONABLE_CONSUMABLE_IDS.has(binding.itemId))
    });
  }
  return [...choices.values()].sort((left, right) => left.name.localeCompare(right.name) || hotbarBindingKey(left.binding).localeCompare(hotbarBindingKey(right.binding)));
}

export function resolveHotbarBinding(
  binding: HotbarBinding | null,
  snapshot: PlayerInventorySnapshot
): HotbarBindingResolution | null {
  if (!binding) return null;
  // Actions are not inventory items; whether they can run right now is decided
  // by the owning control (for example the flag/buoy build state).
  if (binding.kind === "action") return { binding, item: null, available: true, actionable: true, reason: null };
  if (binding.kind === "gear_scroll") {
    const carried = (snapshot.totals.loadout_scroll ?? 0) >= Number(binding.scrollId);
    return {
      binding,
      item: null,
      available: carried,
      actionable: carried,
      reason: carried ? null : "Not currently in your inventory."
    };
  }
  const item = snapshot.items.find((candidate) => itemMatchesBinding(candidate, binding)) ?? null;
  if (!item) {
    return {
      binding,
      item: null,
      available: false,
      actionable: false,
      reason: "Not currently in your inventory."
    };
  }
  if (item.quantity <= 0) {
    return {
      binding,
      item,
      available: false,
      actionable: false,
      reason: "None available. The binding will return when reacquired."
    };
  }
  if (binding.kind === "fishing_rod" && (item.usesRemaining ?? 0) <= 0) {
    return {
      binding,
      item,
      available: false,
      actionable: false,
      reason: "This rod has no casts remaining."
    };
  }
  if (binding.kind === "consumable" && !HOTBAR_SUPPORTED_CONSUMABLE_IDS.has(binding.itemId)) {
    return {
      binding,
      item,
      available: true,
      actionable: false,
      reason: "This consumable has no canonical action yet."
    };
  }
  if (binding.kind === "consumable" && !HOTBAR_ACTIONABLE_CONSUMABLE_IDS.has(binding.itemId)) {
    return {
      binding,
      item,
      available: true,
      actionable: false,
      reason: "This consumable has no canonical action yet."
    };
  }
  return { binding, item, available: true, actionable: true, reason: null };
}

export function activateHotbarBinding(
  binding: HotbarBinding,
  item: HotbarActivatableItem,
  onUseConsumable: (itemId: string, stackId: string) => boolean,
  onFishWithRod: (rodId: string) => boolean
): void {
  if (binding.kind === "fishing_rod") {
    const rodId = item.rodId ?? (item.variant && item.variant !== "default" ? item.variant : null);
    if (rodId) onFishWithRod(rodId);
    return;
  }
  if (binding.kind !== "consumable") return;
  const stackId = item.entryId ?? item.stackId ?? "";
  if (stackId) onUseConsumable(binding.itemId, stackId);
}

export function hotbarBindingKey(binding: HotbarBinding | null): string {
  if (!binding) return "empty";
  switch (binding.kind) {
    case "consumable": return `consumable:${binding.itemId}:${binding.variant ?? ""}`;
    case "fishing_rod": return `fishing_rod:${binding.rodId}`;
    case "gear_scroll": return `gear_scroll:${binding.scrollId}`;
    case "action": return `action:${binding.actionId}`;
  }
}

function itemMatchesBinding(item: PlayerInventoryItem, binding: HotbarBinding): boolean {
  if (binding.kind === "fishing_rod") {
    const rodId = item.rodId ?? (item.variant && item.variant !== "default" ? item.variant : null);
    return item.resourceType === "fishing_rod" && rodId === binding.rodId;
  }
  if (binding.kind !== "consumable") return false;
  return item.resourceType === binding.itemId &&
    (binding.variant === null || (item.variant ?? "default") === binding.variant);
}

function displayNameForItem(item: PlayerInventoryItem, baseName: string): string {
  if (item.resourceType === "fishing_rod") return "Fishing Rod";
  const variant = item.variant && item.variant !== "default" ? item.variant.replaceAll(/[_-]+/g, " ") : "";
  return variant ? `${variant.replace(/\b\w/g, (character) => character.toUpperCase())} ${baseName}` : baseName;
}

/**
 * A Giving Berry heal-over-time effect on the client clock. The server applies one heal
 * tick at use (startedAt) and then one per interval, seven in all, so the ring is tick
 * driven: remaining = (tickCount - ticksDone) / tickCount. Ticks are not signalled
 * individually and no other heal source may move the ring, so the schedule comes purely
 * from the effect's own timestamps and the server's tick constants.
 */
export type HotbarHealEffect = Readonly<{
  effectId: string;
  startMs: number;
  endMs: number;
  tickCount: number;
  tickMs: number;
}>;

export function hotbarHealEffectFromServer(
  effect: Readonly<{ effectId: string; startedAt: string; endsAt: string }>,
  serverTimeMs: number,
  localNowMs: number,
  tickCount: number,
  tickMs: number
): HotbarHealEffect | null {
  const startedAt = Date.parse(effect.startedAt);
  const endsAt = Date.parse(effect.endsAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endsAt) || !Number.isFinite(serverTimeMs) || endsAt <= startedAt) return null;
  const offset = localNowMs - serverTimeMs;
  const startMs = startedAt + offset;
  // The server stores endsAt for the base cadence; a faster cadence finishes sooner.
  return { effectId: effect.effectId, startMs, endMs: startMs + (tickCount - 1) * tickMs, tickCount, tickMs };
}

/** Ticks landed so far, from the effect's own schedule only. */
export function hotbarHealTicksDone(effect: HotbarHealEffect, nowMs: number): number {
  const scheduled = nowMs < effect.startMs ? 0 : Math.floor((nowMs - effect.startMs) / effect.tickMs) + 1;
  return Math.min(effect.tickCount, scheduled);
}

/** Wall-clock time of the next scheduled tick, or null once the schedule is complete. */
export function hotbarHealNextTickAt(effect: HotbarHealEffect, nowMs: number): number | null {
  const done = hotbarHealTicksDone(effect, nowMs);
  return done >= effect.tickCount ? null : effect.startMs + done * effect.tickMs;
}
