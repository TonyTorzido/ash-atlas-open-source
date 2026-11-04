import catalogJson from "./data/boss-appearance-catalog.json" with { type: "json" };

import {
  parseBossAppearanceCatalog,
  type BossAppearanceCatalog
} from "./bossAppearance.js";

export const DEFAULT_BOSS_APPEARANCE_CATALOG =
  parseBossAppearanceCatalog(catalogJson) as BossAppearanceCatalog;
