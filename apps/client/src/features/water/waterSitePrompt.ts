import {
  PEARL_DIVE_MIN_RANK,
  TIDECRAFT_UNLOCK_COST,
  WATER_SITE_INTERACTION_RADIUS_M,
  WHIRLPOOL_MIN_RANK,
  WHIRLPOOL_PLATE_COST,
  distanceMeters,
  waterSiteBlockerText,
  type LatLon,
  type WaterSiteBlocker,
  type WaterSiteSnapshot
} from "@ash-atlas/shared";

export type WaterSiteActionType = "DIVE_PEARL_BED" | "ENTER_WHIRLPOOL" | "PRESENT_ABYSSAL_ORBS";
/** Prompt actions: the site actions plus entering the Drowned City (a USE_PORTAL, not a site message). */
export type WaterSitePromptActionType = WaterSiteActionType | "ENTER_DROWNED_CITY";

export type WaterSitePromptContext = Readonly<{
  position: LatLon | null;
  afloat: boolean;
  tidecraftRank: number;
  tidecraftDiscovered: boolean;
  plates: number;
  orbs: number;
  nowMs: number;
}>;

export type WaterSitePromptModel = Readonly<{
  title: string;
  category: string;
  detail: string;
  /** The actions this site offers right now (the standard hides unusable actions). */
  actions: readonly Readonly<{ type: WaterSitePromptActionType; label: string }>[];
  /** Why no action is available. */
  blocker: string | null;
}>;

/**
 * The popup for a water site: the action it offers and, when the player cannot
 * use it yet, why (no rank, not afloat, too far, not enough plates or orbs, or
 * the dive timer). The server re-checks every rule.
 */
export function waterSitePromptModel(site: WaterSiteSnapshot, context: WaterSitePromptContext): WaterSitePromptModel {
  const distanceM = context.position ? distanceMeters(context.position, site) : Number.POSITIVE_INFINITY;
  const tooFar = distanceM > WATER_SITE_INTERACTION_RADIUS_M;
  const blocked = (blocker: WaterSiteBlocker, detail: Parameters<typeof waterSiteBlockerText>[1] = {}) =>
    waterSiteBlockerText(blocker, detail);
  switch (site.kind) {
    case "pearl_bed": {
      const readyInMs = (site.diveReadyAt ?? 0) - context.nowMs;
      const blocker = context.tidecraftRank < PEARL_DIVE_MIN_RANK ? blocked("no_rank")
        : !context.afloat ? blocked("not_afloat")
          : readyInMs > 0 ? blocked("cooldown", { readyInMs })
            : tooFar ? blocked("too_far")
              : null;
      return {
        title: "Pearl Bed",
        category: "WATER",
        detail: "Dive for pearls once every 6 hours. Tidecraft rank 2 may bring up two; rank 3 always does.",
        actions: blocker ? [] : [{ type: "DIVE_PEARL_BED", label: "Dive" }],
        blocker
      };
    }
    case "whirlpool": {
      const km = site.destination ? Math.max(1, Math.round(site.destination.distanceM / 1_000)) : null;
      const blocker = context.tidecraftRank < WHIRLPOOL_MIN_RANK ? blocked("no_rank")
        : !context.afloat ? blocked("not_afloat")
          : context.plates < WHIRLPOOL_PLATE_COST ? blocked("not_enough_plates", { have: context.plates, need: WHIRLPOOL_PLATE_COST })
            : tooFar ? blocked("too_far")
              : null;
      return {
        title: "Whirlpool",
        category: "WATER",
        detail: `Ride it ${km === null ? "across the sea" : `${km} km`} for ${WHIRLPOOL_PLATE_COST} Shellback Plates. You arrive afloat.`,
        actions: blocker ? [] : [{ type: "ENTER_WHIRLPOOL", label: `Ride (${WHIRLPOOL_PLATE_COST} plates)` }],
        blocker
      };
    }
    case "drowned_city_site": {
      // The raid is entered afloat; the server also checks level, lockout and the torch.
      const enterBlocker = !context.afloat ? blocked("not_afloat") : tooFar ? blocked("too_far") : null;
      const orbBlocker = context.tidecraftDiscovered ? blocked("already_known")
        : context.orbs < TIDECRAFT_UNLOCK_COST ? blocked("not_enough_orbs", { have: context.orbs, need: TIDECRAFT_UNLOCK_COST })
          : tooFar ? blocked("too_far")
            : null;
      const actions = [
        ...(enterBlocker ? [] : [{ type: "ENTER_DROWNED_CITY" as const, label: "Enter the Drowned City" }]),
        ...(orbBlocker ? [] : [{ type: "PRESENT_ABYSSAL_ORBS" as const, label: `Present ${TIDECRAFT_UNLOCK_COST} orbs` }])
      ];
      return {
        title: "Drowned City",
        category: "WATER",
        detail: `A level 32 raid, entered afloat (one torch per party). Leaving before the end locks you out for 6 days. Present ${TIDECRAFT_UNLOCK_COST} Abyssal Orbs here to learn Tidecraft.`,
        actions,
        blocker: actions.length > 0 ? null : enterBlocker ?? orbBlocker
      };
    }
  }
}
