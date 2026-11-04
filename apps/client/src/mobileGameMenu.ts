export const MOBILE_MENU_DESTINATIONS = [
  { id: "profile", label: "Profile", icon: "profile" },
  { id: "contacts", label: "Contacts", icon: "contacts" },
  { id: "messages", label: "Messages", icon: "messages" },
  { id: "party", label: "Party", icon: "party" },
  { id: "classes", label: "Progression", icon: "classes" },
  { id: "character", label: "Character", icon: "character" },
  { id: "equipment", label: "Inventory", icon: "equipment" },
  { id: "crafting", label: "Crafting", icon: "crafting" },
  { id: "city", label: "City", icon: "city" },
  { id: "kingdom", label: "Kingdom", icon: "kingdom" },
  { id: "build", label: "Construction", icon: "build" },
  { id: "flags", label: "Land Management", icon: "flags" },
  { id: "tolls", label: "Harvest Tolls", icon: "tolls" },
  { id: "world-map", label: "World Map", icon: "world-map" },
  { id: "pet-chamber", label: "Pets", icon: "pet" },
  { id: "leaderboards", label: "Leaderboards", icon: "leaderboards" },
  { id: "shop", label: "Shop", icon: "shop" },
  { id: "achievements", label: "Achievements", icon: "achievements" },
  { id: "creature-book", label: "Encyclopedia", icon: "creature-book" },
  { id: "bug-report", label: "Report a Bug", icon: "bug-report" },
  { id: "miscellaneous", label: "Settings & Support", icon: "miscellaneous" },
  { id: "announcements", label: "Announcements", icon: "announcements" },
  { id: "patch-notes", label: "Patch Notes", icon: "patch-notes" }
] as const;

export type MobileMenuDestinationId = typeof MOBILE_MENU_DESTINATIONS[number]["id"];
export type MobileMenuView = "gameplay" | "menu" | MobileMenuDestinationId;

export const MOBILE_MENU_CATEGORIES = [
  {
    id: "adventurer",
    label: "Adventurer",
    icon: "profile",
    destinations: ["profile", "pet-chamber"]
  },
  {
    id: "progression",
    label: "Progression",
    icon: "classes",
    destinations: ["classes"]
  },
  {
    id: "social",
    label: "Social",
    icon: "messages",
    destinations: ["contacts", "messages", "party"]
  },
  {
    id: "realm",
    label: "Realm",
    icon: "world-map",
    destinations: ["world-map", "city", "kingdom"]
  },
  {
    id: "holdings",
    label: "Holdings",
    icon: "build",
    destinations: ["build", "flags", "tolls"]
  },
  {
    id: "notice-board",
    label: "Notice Board",
    icon: "announcements",
    destinations: ["announcements", "patch-notes"]
  }
] as const satisfies readonly {
  id: string;
  label: string;
  icon: typeof MOBILE_MENU_DESTINATIONS[number]["icon"];
  destinations: readonly MobileMenuDestinationId[];
}[];

export type MobileMenuCategoryId = typeof MOBILE_MENU_CATEGORIES[number]["id"];

export type MobileMenuRootEntry = Readonly<{
  kind: "destination";
  id: MobileMenuDestinationId;
  label: string;
}>;
export type MobileMenuRootSection = Readonly<{
  id: "adventurer" | "fellowship" | "realm" | "store";
  label: string;
  entries: readonly MobileMenuRootEntry[];
}>;

/**
 * The Game Menu sheet: ruled sections of up to four apps, each opening directly.
 * World Map carries City and Kingdom as its own tabs and Relocate as a header action.
 */
export const MOBILE_MENU_ROOT_SECTIONS = [
  {
    id: "adventurer",
    label: "Adventurer",
    entries: [
      { kind: "destination", id: "equipment", label: "Inventory" },
      { kind: "destination", id: "classes", label: "Progression" },
      { kind: "destination", id: "pet-chamber", label: "Pets" },
      { kind: "destination", id: "creature-book", label: "Encyclopedia" }
    ]
  },
  {
    id: "fellowship",
    label: "Fellowship",
    entries: [
      { kind: "destination", id: "messages", label: "Messages" },
      { kind: "destination", id: "contacts", label: "Contacts" },
      { kind: "destination", id: "party", label: "Party" },
      { kind: "destination", id: "leaderboards", label: "Rankings" }
    ]
  },
  {
    id: "realm",
    label: "Realm",
    entries: [
      { kind: "destination", id: "world-map", label: "Atlas" },
      { kind: "destination", id: "crafting", label: "Crafting" },
      { kind: "destination", id: "build", label: "Construction" },
      { kind: "destination", id: "flags", label: "Land" }
    ]
  },
  {
    id: "store",
    label: "Store",
    entries: [
      { kind: "destination", id: "shop", label: "Shop" }
    ]
  }
] as const satisfies readonly MobileMenuRootSection[];

export const MOBILE_MENU_ROOT_PRIMARY: readonly MobileMenuRootEntry[] =
  MOBILE_MENU_ROOT_SECTIONS.flatMap<MobileMenuRootEntry>((section) => section.entries);

/** Compatibility export for callers that still distinguish a realm row. */
export const MOBILE_MENU_ROOT_REALM: readonly MobileMenuRootEntry[] = [];

export const MOBILE_MENU_ROOT = [
  ...MOBILE_MENU_ROOT_PRIMARY,
  ...MOBILE_MENU_ROOT_REALM
] as const satisfies readonly MobileMenuRootEntry[];

export const MOBILE_MENU_ROOT_UTILITIES = [
  { kind: "destination", id: "announcements", label: "Notice Board" },
  { kind: "destination", id: "miscellaneous", label: "Settings & Support" }
] as const satisfies readonly MobileMenuRootEntry[];

/**
 * Retained for callers that still use the pre-header-utility name. The root
 * renders these destinations in its header; they are no longer footer cells.
 */
export const MOBILE_MENU_ROOT_FOOTER = MOBILE_MENU_ROOT_UTILITIES;

export type MobileMenuChild =
  | { destination: "messages"; screen: "peer"; id: string }
  | { destination: "messages"; screen: "notification"; id: string }
  | { destination: "character"; screen: "slot"; id: MobileCharacterSlot }
  | { destination: "equipment"; screen: "detail"; id: string };

export type MobileMenuHistorySnapshot = {
  view: MobileMenuView;
  category: MobileMenuCategoryId | null;
  child: MobileMenuChild | null;
  ownedDepth: number;
  /** Opened straight from a HUD shortcut: one history step above gameplay, no Game Menu below it. */
  shortcut: boolean;
};

export type MobileCharacterSlot =
  | "head"
  | "chest"
  | "gloves"
  | "boots"
  | "ring"
  | "melee"
  | "secondary";

export const DEFAULT_MOBILE_MENU_ORDER: readonly MobileMenuDestinationId[] =
  MOBILE_MENU_DESTINATIONS.map(({ id }) => id);

const VALID_DESTINATIONS = new Set<string>(DEFAULT_MOBILE_MENU_ORDER);
const CATEGORY_BY_DESTINATION = new Map<MobileMenuDestinationId, MobileMenuCategoryId>(
  MOBILE_MENU_CATEGORIES.flatMap((category) =>
    category.destinations.map((destination) => [destination, category.id] as const)
  )
);
// These destinations no longer appear in a category directory, but their old
// parent remains valid while a player unwinds a persisted menu history entry.
const LEGACY_CATEGORY_BY_DESTINATION = new Map<MobileMenuDestinationId, MobileMenuCategoryId>([
  ["character", "adventurer"],
  ["achievements", "progression"],
  ["bug-report", "notice-board"],
  ["miscellaneous", "notice-board"]
]);
const VALID_CHARACTER_SLOTS = new Set<string>([
  "head", "chest", "gloves", "boots", "ring", "melee", "secondary"
]);

export const MOBILE_MENU_HISTORY_KEYS = [
  "ashAtlasMobileMenuView",
  "ashAtlasMobileMenuCategory",
  "ashAtlasMobileMenuChild",
  "ashAtlasMobileMenuDepth",
  "ashAtlasMobileMessagePeerId",
  "ashAtlasMobileMenuShortcut"
] as const;

export const MOBILE_MENU_RETURN_EVENT = "ashAtlasMobileMenuReturnToGame";

export function mobileMenuViewFromHistoryState(state: unknown): MobileMenuView {
  if (!state || typeof state !== "object") return "gameplay";
  const value = (state as { ashAtlasMobileMenuView?: unknown }).ashAtlasMobileMenuView;
  if (value === "menu" || (typeof value === "string" && VALID_DESTINATIONS.has(value))) {
    return value as MobileMenuView;
  }
  return "gameplay";
}

export function mobileMenuHistoryFromState(state: unknown): MobileMenuHistorySnapshot {
  const view = mobileMenuViewFromHistoryState(state);
  if (view === "gameplay") return { view, category: null, child: null, ownedDepth: 0, shortcut: false };

  const record = isRecord(state) ? state : {};
  // Category directories are retired from the player flow. Ignore legacy
  // category markers while preserving the destination/detail history entry.
  const category: MobileMenuCategoryId | null = null;
  const child = view === "menu" ? null : mobileMenuChildFromRecord(record, view);
  const shortcut = view !== "menu" && record.ashAtlasMobileMenuShortcut === true;
  const minimumDepth = view === "menu"
    ? category ? 2 : 1
    : (child ? category ? 4 : 3 : category ? 3 : 2) - (shortcut ? 1 : 0);
  const recordedDepth = record.ashAtlasMobileMenuDepth;
  const ownedDepth = Number.isInteger(recordedDepth)
    && Number(recordedDepth) >= minimumDepth
    && Number(recordedDepth) <= 32
      ? Number(recordedDepth)
      : minimumDepth;
  return { view, category, child, ownedDepth, shortcut };
}

export function mobileMenuCategoryForDestination(
  destination: MobileMenuDestinationId
): MobileMenuCategoryId | null {
  return categoryForDestination(destination);
}

function categoryForDestination(destination: MobileMenuDestinationId): MobileMenuCategoryId | null {
  return CATEGORY_BY_DESTINATION.get(destination) ?? LEGACY_CATEGORY_BY_DESTINATION.get(destination) ?? null;
}

export function withoutMobileMenuHistoryState(state: unknown): Record<string, unknown> {
  const next = isRecord(state) ? { ...state } : {};
  for (const key of MOBILE_MENU_HISTORY_KEYS) delete next[key];
  return next;
}

export function requestMobileMenuReturnToGame(): void {
  window.dispatchEvent(new Event(MOBILE_MENU_RETURN_EVENT));
}

function mobileMenuChildFromRecord(
  state: Record<string, unknown>,
  view: MobileMenuDestinationId
): MobileMenuChild | null {
  const value = state.ashAtlasMobileMenuChild;
  if (isRecord(value) && value.destination === view && typeof value.id === "string") {
    if (view === "character" && value.screen === "slot" && VALID_CHARACTER_SLOTS.has(value.id)) {
      return { destination: "character", screen: "slot", id: value.id as MobileCharacterSlot };
    }
    if (view === "equipment" && value.screen === "detail" && value.id.trim()) {
      return { destination: "equipment", screen: "detail", id: value.id };
    }
    if (view === "messages" && value.screen === "peer" && isPlayerId(value.id)) {
      return { destination: "messages", screen: "peer", id: value.id };
    }
    if (view === "messages" && value.screen === "notification" && value.id.trim()) {
      return { destination: "messages", screen: "notification", id: value.id };
    }
  }

  const legacyPeerId = state.ashAtlasMobileMessagePeerId;
  return view === "messages" && typeof legacyPeerId === "string" && isPlayerId(legacyPeerId)
    ? { destination: "messages", screen: "peer", id: legacyPeerId }
    : null;
}

function isPlayerId(value: string): boolean {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
