import {
  isDirectMessageServerMessage,
  isPlayerPackageServerMessage,
  isPlayerGiftServerMessage,
  isShopServerMessage,
  type ServerMessage
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  isCombatEquipmentServerMessage
} from "../features/combatEquipment/useCombatEquipmentFrameHandler.js";
import {
  isDeveloperServerMessage
} from "../features/developer/useDeveloperFrameHandler.js";
import { isFlagServerMessage } from "../features/flags/useFlagFrameHandler.js";
import {
  isHarvestingServerMessage
} from "../features/harvesting/useHarvestingFrameHandler.js";
import { isManorServerMessage } from "../features/manor/useManorFeature.js";
import { isSalonServerMessage } from "../features/salon/useSalonFeature.js";
import { isMarketServerMessage } from "../features/market/useMarketFeature.js";
import { isPartyServerMessage } from "../features/party/usePartyFeature.js";
import { isPetFamilyServerMessage } from "../features/pets/usePetFeature.js";
import {
  isApplicationSessionMessage
} from "../features/session/useSessionFrameHandler.js";
import { isChatServerMessage } from "../features/social/useChatFeature.js";
import {
  isSettlementServerMessage
} from "../features/settlements/useSettlementFeature.js";
import {
  isTravelServerMessage
} from "../features/travel/useTravelFrameHandler.js";
import {
  isWorldServerMessage
} from "../features/world/useWorldFrameHandler.js";
import {
  CLIENT_SERVER_MESSAGE_OWNERSHIP,
  type ClientFrameFamily
} from "./clientFrameRouter.js";
import { isBackpackServerMessage } from "./domains/backpackClient.js";
import { isPortalServerMessage } from "../features/locations/usePortalLocationController.js";

const guardByFamily = {
  // App's session owner also handles these frames directly before delegating.
  session: (message: ServerMessage) =>
    message.type === "PLAYER_ANNOUNCEMENT_PUBLISHED" ||
    message.type === "PLAYER_DEATH_MESSAGE" ||
    message.type === "CREATURE_BOOK_SNAPSHOT" ||
    message.type === "BIOME_DISCOVERY_SNAPSHOT" ||
    isApplicationSessionMessage(message),
  world: isWorldServerMessage,
  flags: isFlagServerMessage,
  settlements: isSettlementServerMessage,
  travel: isTravelServerMessage,
  party: isPartyServerMessage,
  manor: (message: ServerMessage) =>
    isManorServerMessage(message) || isSalonServerMessage(message),
  dungeon: (message: ServerMessage) => message.type.startsWith("DUNGEON_"),
  backpack: isBackpackServerMessage,
  harvesting: isHarvestingServerMessage,
  combatEquipment: isCombatEquipmentServerMessage,
  social: (message: ServerMessage) =>
    isDirectMessageServerMessage(message) || isChatServerMessage(message),
  market: isMarketServerMessage,
  pets: isPetFamilyServerMessage,
  packages: (message: ServerMessage) =>
    isPlayerPackageServerMessage(message) || isPlayerGiftServerMessage(message) || isShopServerMessage(message),
  developer: isDeveloperServerMessage,
  portal: isPortalServerMessage
} satisfies Record<
  ClientFrameFamily,
  (message: ServerMessage) => boolean
>;

describe("client frame domain ownership", () => {
  it("gives every non-terminal discriminant exactly one matching owner guard", () => {
    let checked = 0;
    for (const [type, owner] of Object.entries(
      CLIENT_SERVER_MESSAGE_OWNERSHIP
    )) {
      if (
        type === "SESSION_REPLACED" ||
        type === "AUTH_SESSION_INVALID" ||
        type === "BUG_REPORT_SUBMIT_RESULT"
      ) {
        continue;
      }
      const frame = { type } as ServerMessage;
      const matchingFamilies = Object.entries(guardByFamily)
        .filter(([, guard]) => guard(frame))
        .map(([family]) => family);
      expect(matchingFamilies, type).toEqual([owner]);
      checked += 1;
    }
    expect(checked).toBe(
      Object.keys(CLIENT_SERVER_MESSAGE_OWNERSHIP).length - 3
    );
  });
});
