import catalogJson from "./data/player-appearance-catalog.json" with { type: "json" };

import {
  parsePlayerAppearanceCatalog,
  type PlayerAppearanceCatalog
} from "./appearance.js";

export const DEFAULT_PLAYER_APPEARANCE_CATALOG =
  parsePlayerAppearanceCatalog(catalogJson) as PlayerAppearanceCatalog;
