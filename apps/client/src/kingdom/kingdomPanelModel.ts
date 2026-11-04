import {
  canModerateKingdomRole,
  unicodeLength,
  type KingdomRole,
  type KingdomChatMessage,
  type KingdomMemberSnapshot,
  type KingdomPermission
} from "@ash-atlas/shared";

export const KINGDOM_PANEL_TABS = [
  "overview",
  "members",
  "treasury",
  "progression",
  "perks",
  "objects",
  "wars",
  "activity"
] as const;

export type KingdomPanelTab = (typeof KINGDOM_PANEL_TABS)[number];

export const KINGDOM_PANEL_TAB_LABELS: Readonly<Record<KingdomPanelTab, string>> = {
  overview: "Overview",
  members: "Members",
  treasury: "Treasury",
  progression: "Progression",
  perks: "Perks",
  objects: "Cots & Decorations",
  wars: "Wars",
  activity: "Activity"
};

export const MAX_KINGDOM_CHAT_HISTORY = 100;
export const KINGDOM_CHAT_MAX_CHARACTERS = 500;

const FRIENDLY_ERRORS: Readonly<Record<string, string>> = {
  KINGDOM_WORLD_AUTHORITY_UNAVAILABLE:
    "World land authority is unavailable. Existing Kingdom features remain available; founding cannot continue yet.",
  KINGDOM_NOT_ON_LAND: "Your authoritative position is not on valid land.",
  KINGDOM_WATER_REJECTED: "A Castle cannot be founded on water.",
  KINGDOM_SEAT_TOO_CLOSE: "This position is too close to another active Castle.",
  KINGDOM_TERRITORY_OVERLAP: "The intended territory overlaps another active Kingdom.",
  KINGDOM_PENDING_RESERVATION_CONFLICT:
    "This position conflicts with a pending Castle construction reservation.",
  KINGDOM_FLAG_TERRITORY_OVERLAP: "This position overlaps a Kingdom Flag territory.",
  KINGDOM_ALREADY_MEMBER: "You already have an active Kingdom membership.",
  KINGDOM_NAME_UNAVAILABLE: "That Kingdom name is unavailable.",
  KINGDOM_PERMISSION_DENIED: "Your Kingdom role does not permit that action.",
  KINGDOM_MEMBER_CAPACITY_REACHED: "This Kingdom has reached its member capacity.",
  KINGDOM_COT_CAPACITY_REACHED: "This Kingdom has reached its cot capacity.",
  KINGDOM_DECORATION_CAPACITY_REACHED: "This Kingdom has reached its decoration capacity.",
  KINGDOM_COT_ALREADY_PLACED: "You already have an active cot in this Kingdom.",
  KINGDOM_OUTSIDE_TERRITORY: "The intended placement is outside Kingdom territory.",
  KINGDOM_DONATION_INSUFFICIENT_BALANCE: "The donation exceeds your available balance.",
  KINGDOM_CONSTRUCTION_INSUFFICIENT_RESOURCES: "You do not have the resources required for this construction.",
  KINGDOM_INVITATION_EXPIRED: "This invitation has expired.",
  KINGDOM_ADVANCEMENT_PROJECT_ACTIVE: "A Kingdom advancement project is already active.",
  KINGDOM_ADVANCEMENT_MAX_LEVEL: "This Kingdom has already reached maximum level.",
  KINGDOM_ADVANCEMENT_PROJECT_NOT_FOUND: "That advancement project could not be found.",
  KINGDOM_ADVANCEMENT_PROJECT_NOT_PENDING: "That advancement project is no longer pending.",
  KINGDOM_ADVANCEMENT_COMPLETION_PROCESSED: "That advancement project has already completed.",
  KINGDOM_ADVANCEMENT_INSUFFICIENT_TREASURY:
    "The Kingdom treasury does not contain all required project resources.",
  KINGDOM_ADVANCEMENT_PROJECT_STATE_CHANGED:
    "The advancement project changed. Refresh Kingdom state and try again.",
  KINGDOM_REVOLT_ANARCHY: "The Kingdom is in anarchy. There is no leader to revolt against.",
  KINGDOM_REVOLT_LEADER_CANNOT_VOTE: "The leader cannot start or vote in a revolt.",
  KINGDOM_REVOLT_ALREADY_OPEN: "A revolt vote is already open.",
  KINGDOM_REVOLT_NOT_FOUND: "That revolt vote has closed.",
  KINGDOM_REVOLT_ALREADY_VOTED: "You have already voted in this revolt.",
  KINGDOM_REVOLT_COOLDOWN: "A revolt failed in the last 24 hours. A new vote can start after the cooldown."
};

export function normalizeKingdomChatDraft(value: string): string | null {
  const normalized = value.trim();
  if (normalized.length === 0 || unicodeLength(normalized) > KINGDOM_CHAT_MAX_CHARACTERS) {
    return null;
  }
  return normalized;
}

export function mergeKingdomChatHistory(
  history: readonly KingdomChatMessage[],
  incoming: KingdomChatMessage | readonly KingdomChatMessage[]
): KingdomChatMessage[] {
  const messages = Array.isArray(incoming) ? incoming : [incoming];
  const byId = new Map<string, KingdomChatMessage>();
  for (const message of [...history, ...messages]) {
    byId.set(message.id, message);
  }
  return [...byId.values()]
    .sort((left, right) => {
      const timeDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      return timeDifference === 0 ? left.id.localeCompare(right.id) : timeDifference;
    })
    .slice(-MAX_KINGDOM_CHAT_HISTORY);
}

export function nextSelectedKingdomId(
  currentSelection: string | null,
  ownKingdomId: string | null | undefined
): string | null {
  return currentSelection ?? ownKingdomId ?? null;
}

export function kingdomErrorMessage(code: string, fallback: string): string {
  return FRIENDLY_ERRORS[code] ?? fallback;
}

export function hasPermission(
  permissions: readonly KingdomPermission[],
  permission: KingdomPermission
): boolean {
  return permissions.includes(permission);
}

export function mayModerateMember(
  actor: KingdomMemberSnapshot | null,
  target: KingdomMemberSnapshot
): boolean {
  return Boolean(
    actor &&
      actor.status === "active" &&
      target.playerId !== actor.playerId &&
      canModerateKingdomRole(actor.role, target.role, actor.playerId === target.playerId)
  );
}

export function formatKingdomRole(role: KingdomRole): string {
  return `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
}

export function formatDurationSeconds(seconds: number): string {
  if (seconds <= 0) return "Immediate";
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hr`;
}
