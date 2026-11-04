import type { z } from "zod";

import { backpackServerMessageSchemas } from "./backpackServerSchemas.js";
import { combatEquipmentServerMessageSchemas } from "./combatEquipmentServerMessageSchemas.js";
import { developerServerMessageSchemas } from "./developerServerSchemas.js";
import { dungeonServerMessageSchemas } from "./dungeonServerSchemas.js";
import { flagServerMessageSchemas } from "./flagServerSchemas.js";
import { harvestingServerMessageSchemas } from "./harvestingServerSchemas.js";
import { manorServerMessageSchemas } from "./manorServerSchemas.js";
import { salonServerMessageSchemas } from "./salonServerSchemas.js";
import { marketServerMessageSchemas } from "./marketServerSchemas.js";
import { partyServerMessageSchemas } from "./partyServerMessageSchemas.js";
import { playerPackageServerMessageSchemas } from "./playerPackageServerSchemas.js";
import { playerGiftServerMessageSchemas } from "./playerGiftServerSchemas.js";
import { shopServerMessageSchemas } from "./shopServerSchemas.js";
import { petServerMessageSchemas } from "./petServerSchemas.js";
import { portalServerMessageSchemas } from "./portalServerSchemas.js";
import { sessionServerMessageSchemas } from "./sessionServerSchemas.js";
import { settlementServerMessageSchemas } from "./settlementServerSchemas.js";
import { socialServerMessageSchemas } from "./socialServerSchemas.js";
import type { ServerMessage } from "./serverMessages.js";
import { travelServerMessageSchemas } from "./travelServerSchemas.js";
import { worldServerMessageSchemas } from "./worldServerSchemas.js";
import { skillSystemV3ServerMessageSchemas } from "./skillSystemV3ServerSchemas.js";
import { announcementServerMessageSchemas } from "./announcementServerSchemas.js";

export const SERVER_MESSAGE_VALIDATION_ROUTES = {
  ...announcementServerMessageSchemas,
  ...skillSystemV3ServerMessageSchemas,
  ...portalServerMessageSchemas,
  ...dungeonServerMessageSchemas,
  ...backpackServerMessageSchemas,
  ...sessionServerMessageSchemas,
  ...worldServerMessageSchemas,
  ...flagServerMessageSchemas,
  ...settlementServerMessageSchemas,
  ...travelServerMessageSchemas,
  ...partyServerMessageSchemas,
  ...playerPackageServerMessageSchemas,
  ...playerGiftServerMessageSchemas,
  ...shopServerMessageSchemas,
  ...manorServerMessageSchemas,
  ...salonServerMessageSchemas,
  ...harvestingServerMessageSchemas,
  ...combatEquipmentServerMessageSchemas,
  ...socialServerMessageSchemas,
  ...marketServerMessageSchemas,
  ...petServerMessageSchemas,
  ...developerServerMessageSchemas
} satisfies Record<ServerMessage["type"], z.ZodTypeAny>;
