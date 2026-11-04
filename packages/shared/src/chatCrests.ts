/**
 * Chat identity crests are intentionally separate from player appearance.
 * The entitlement seam lets future unlock systems narrow this starter set
 * without changing chat message projection or rendering.
 */
export const CHAT_CREST_IDS = ["lion", "leaf", "stag", "cross"] as const;
export type ChatCrestId = (typeof CHAT_CREST_IDS)[number];

export type ChatCrestDefinition = Readonly<{
  id: ChatCrestId;
  label: string;
  assetKey: `chat-crests/${ChatCrestId}.png`;
}>;

export const DEFAULT_CHAT_CREST_ID: ChatCrestId = "leaf";

export const CHAT_CRESTS: readonly ChatCrestDefinition[] = Object.freeze([
  { id: "lion", label: "Lion", assetKey: "chat-crests/lion.png" },
  { id: "leaf", label: "Leaf", assetKey: "chat-crests/leaf.png" },
  { id: "stag", label: "Stag", assetKey: "chat-crests/stag.png" },
  { id: "cross", label: "Cross", assetKey: "chat-crests/cross.png" }
]);

export type ChatCrestSelection = Readonly<{
  crests: readonly ChatCrestDefinition[];
  equippedCrestId: ChatCrestId;
}>;

export function isChatCrestId(value: unknown): value is ChatCrestId {
  return typeof value === "string" &&
    (CHAT_CREST_IDS as readonly string[]).includes(value);
}

export function chatCrestDefinition(id: unknown): ChatCrestDefinition {
  return CHAT_CRESTS.find((crest) => crest.id === id) ??
    CHAT_CRESTS.find((crest) => crest.id === DEFAULT_CHAT_CREST_ID)!;
}

export function normalizeChatCrestId(value: unknown): ChatCrestId {
  return isChatCrestId(value) ? value : DEFAULT_CHAT_CREST_ID;
}
