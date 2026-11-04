import {
  RealtimeMessageRouter,
  type RealtimeFamilyHandler
} from "../messageRouter.js";
import { registerCombatEquipmentHandler } from "./combatEquipmentHandler.js";
import { registerBackpackHandler } from "./backpackHandler.js";
import { registerDeveloperHandler } from "./developerHandler.js";
import { registerDungeonHandler } from "./dungeonHandler.js";
import { registerPortalHandler } from "./portalHandler.js";
import { registerFlagHandler } from "./flagHandler.js";
import { registerHarvestingHandler } from "./harvestingHandler.js";
import { registerManorHandler } from "./manorHandler.js";
import { registerSalonHandler } from "./salonHandler.js";
import { registerMarketHandler } from "./marketHandler.js";
import { registerPartyHandler } from "./partyHandler.js";
import { registerPetHandler } from "./petHandler.js";
import { registerSaplingHandler } from "./saplingHandler.js";
import { registerPlayerPackageHandler } from "./playerPackageHandler.js";
import { registerPlayerGiftHandler } from "./playerGiftHandler.js";
import { registerShopHandler } from "./shopHandler.js";
import { registerSessionHandler } from "./sessionHandler.js";
import { registerSettlementHandler } from "./settlementHandler.js";
import { registerSocialHandler } from "./socialHandler.js";
import { registerTravelHandler } from "./travelHandler.js";
import { registerWorldGameplayHandler } from "./worldGameplayHandler.js";

export type RealtimeFamilyHandlers = Readonly<{
  session: RealtimeFamilyHandler<"session">;
  worldGameplay: RealtimeFamilyHandler<"world-gameplay">;
  flag: RealtimeFamilyHandler<"flag">;
  travel: RealtimeFamilyHandler<"travel">;
  settlement: RealtimeFamilyHandler<"settlement">;
  party: RealtimeFamilyHandler<"party">;
  manor: RealtimeFamilyHandler<"manor">;
  salon: RealtimeFamilyHandler<"salon">;
  harvesting: RealtimeFamilyHandler<"harvesting">;
  combatEquipment: RealtimeFamilyHandler<"combat-equipment">;
  backpack: RealtimeFamilyHandler<"backpack">;
  social: RealtimeFamilyHandler<"social">;
  market: RealtimeFamilyHandler<"market">;
  pet: RealtimeFamilyHandler<"pet">;
  sapling: RealtimeFamilyHandler<"sapling">;
  packages: RealtimeFamilyHandler<"packages">;
  gifts: RealtimeFamilyHandler<"gifts">;
  shop: RealtimeFamilyHandler<"shop">;
  developer: RealtimeFamilyHandler<"developer">;
  dungeon: RealtimeFamilyHandler<"dungeon">;
  portal: RealtimeFamilyHandler<"portal">;
}>;

export function createRealtimeMessageRouter(
  handlers: RealtimeFamilyHandlers
): RealtimeMessageRouter {
  const router = new RealtimeMessageRouter();
  registerSessionHandler(router, handlers.session);
  registerWorldGameplayHandler(router, handlers.worldGameplay);
  registerFlagHandler(router, handlers.flag);
  registerTravelHandler(router, handlers.travel);
  registerSettlementHandler(router, handlers.settlement);
  registerPartyHandler(router, handlers.party);
  registerManorHandler(router, handlers.manor);
  registerSalonHandler(router, handlers.salon);
  registerHarvestingHandler(router, handlers.harvesting);
  registerCombatEquipmentHandler(router, handlers.combatEquipment);
  registerBackpackHandler(router, handlers.backpack);
  registerSocialHandler(router, handlers.social);
  registerMarketHandler(router, handlers.market);
  registerPetHandler(router, handlers.pet);
  registerSaplingHandler(router, handlers.sapling);
  registerPlayerPackageHandler(router, handlers.packages);
  registerPlayerGiftHandler(router, handlers.gifts);
  registerShopHandler(router, handlers.shop);
  registerDeveloperHandler(router, handlers.developer);
  registerDungeonHandler(router, handlers.dungeon);
  registerPortalHandler(router, handlers.portal);
  router.assertComplete();
  return router;
}
