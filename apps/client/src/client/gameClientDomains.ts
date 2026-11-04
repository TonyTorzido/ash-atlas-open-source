import type { ClientCommandPort } from "./clientCommandPort.js";
import { BackpackClient } from "./domains/backpackClient.js";
import { CombatEquipmentClient } from "./domains/combatEquipmentClient.js";
import { DeveloperClient } from "./domains/developerClient.js";
import { DungeonClient } from "./domains/dungeonClient.js";
import { FlagClient } from "./domains/flagClient.js";
import { HarvestingClient } from "./domains/harvestingClient.js";
import { ManorClient } from "./domains/manorClient.js";
import { MarketClient } from "./domains/marketClient.js";
import { PartyClient } from "./domains/partyClient.js";
import { PetClient } from "./domains/petClient.js";
import { PlayerPackageClient } from "./domains/playerPackageClient.js";
import { PlayerGiftClient } from "./domains/playerGiftClient.js";
import { SettlementClient } from "./domains/settlementClient.js";
import { SocialClient } from "./domains/socialClient.js";
import { TravelClient } from "./domains/travelClient.js";
import { WorldGameplayClient } from "./domains/worldGameplayClient.js";
import { PortalClient } from "./domains/portalClient.js";
import { SalonClient } from "./domains/salonClient.js";

export function createGameClientDomains(port: ClientCommandPort) {
  const portal = new PortalClient(port);
  return {
    backpack: new BackpackClient(port),
    combat: new CombatEquipmentClient(port),
    developer: new DeveloperClient(port),
    dungeon: new DungeonClient(port),
    flag: new FlagClient(port),
    harvesting: new HarvestingClient(port),
    manor: new ManorClient(port, portal),
    portal,
    salon: new SalonClient(port),
    market: new MarketClient(port),
    party: new PartyClient(port),
    pet: new PetClient(port),
    packages: new PlayerPackageClient(port),
    gifts: new PlayerGiftClient(port),
    settlement: new SettlementClient(port),
    social: new SocialClient(port),
    travel: new TravelClient(port),
    world: new WorldGameplayClient(port)
  } as const;
}

export type GameClientDomains = ReturnType<typeof createGameClientDomains>;
