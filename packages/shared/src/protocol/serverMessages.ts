import type { DirectMessageServerMessage } from "../directMessages.js";
import type { DungeonServerMessage } from "./dungeonMessages.js";
import type { BackpackServerMessage } from "./backpackMessages.js";
import type { MarketServerMessage } from "../marketProtocol.js";
import type { CombatEquipmentServerMessage } from "./combatEquipmentMessages.js";
import type { DeveloperServerMessage } from "./developerMessages.js";
import type { FlagServerMessage } from "./flagMessages.js";
import type { HarvestingServerMessage } from "./harvestingMessages.js";
import type { ManorServerMessage } from "./manorMessages.js";
import type { SalonServerMessage } from "./salonMessages.js";
import type { PartyServerMessage } from "./partyMessages.js";
import type { PlayerPackageServerMessage } from "./playerPackageMessages.js";
import type { PlayerGiftServerMessage } from "./playerGiftMessages.js";
import type { ShopServerMessage } from "./shopMessages.js";
import type { PetServerMessage } from "./petMessages.js";
import type { PortalServerMessage } from "./portalMessages.js";
import type { SessionServerMessage } from "./sessionMessages.js";
import type { SettlementServerMessage } from "./settlementMessages.js";
import type { SocialServerMessage } from "./socialMessages.js";
import type { TravelServerMessage } from "./travelMessages.js";
import type { WorldServerMessage } from "./worldMessages.js";
import type { SkillSystemV3ServerMessage } from "./skillSystemV3Messages.js";
import type { AnnouncementServerMessage } from "./announcementMessages.js";

export type ServerMessage =
  | AnnouncementServerMessage
  | SkillSystemV3ServerMessage
  | PortalServerMessage
  | BackpackServerMessage
  | DungeonServerMessage
  | MarketServerMessage
  | DirectMessageServerMessage
  | PetServerMessage
  | WorldServerMessage
  | ManorServerMessage
  | SalonServerMessage
  | SettlementServerMessage
  | SocialServerMessage
  | SessionServerMessage
  | CombatEquipmentServerMessage
  | DeveloperServerMessage
  | PartyServerMessage
  | PlayerPackageServerMessage
  | PlayerGiftServerMessage
  | ShopServerMessage
  | TravelServerMessage
  | FlagServerMessage
  | HarvestingServerMessage;

const DIRECT_MESSAGE_TYPES = new Set<ServerMessage["type"]>([
  "DM_BOOTSTRAP_RESULT",
  "DM_LIST_RESULT",
  "DM_OPEN_RESULT",
  "DM_HISTORY_RESULT",
  "DM_SEND_RESULT",
  "DM_READ_RESULT",
  "DM_DELIVERED_RESULT",
  "DM_MUTE_RESULT",
  "DM_PREFERENCES_RESULT",
  "DM_SYNC_RESULT",
  "DM_EVENT",
  "DM_EVENT_ACKED",
  "DM_ERROR"
]);

export function isDirectMessageServerMessage(
  message: ServerMessage
): message is DirectMessageServerMessage {
  return DIRECT_MESSAGE_TYPES.has(message.type);
}

export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
