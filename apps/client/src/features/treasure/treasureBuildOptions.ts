import {
  SHOVEL_ITEM_ID,
  SHOVEL_MAX_USES,
  TREASURE_DIG_RADIUS_M,
  TREASURE_LANDMARK_NAMES,
  TREASURE_TIER_NAMES,
  TREASURE_TIER_REQUIRED_CARTOGRAPHY_RANK,
  TRADE_SKILL_GATES,
  tradeSkillGateMessage,
  tradeSkillGateMet,
  type ResourceType,
  type TreasureCacheSnapshot
} from "@ash-atlas/shared";

import type { PhoneBuildOption } from "../../ui/PhoneHud.js";
import type { TreasureFeature } from "./useTreasureFeature.js";

function formatRemaining(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** "Buried near Albuquerque, close to an Atlas Shrine. 3h 10m left." */
export function treasureCacheDescription(cache: TreasureCacheSnapshot, nowMs: number): string {
  const where = [
    cache.placeLabel ? `Buried near ${cache.placeLabel}` : "Buried nearby",
    cache.landmarkKind ? `close to ${TREASURE_LANDMARK_NAMES[cache.landmarkKind]}` : null
  ].filter((part): part is string => part !== null).join(", ");
  return `${where}. ${cache.distanceM} m away. ${formatRemaining(Date.parse(cache.expiresAt) - nowMs)} left.`;
}

/**
 * Construction cards for buried treasure: craft a Shovel, then Dig each cache
 * in reach. The Shovel needs Cartography rank 2; the server lists only the tiers
 * this player may see (silver rank 2, gold rank 3), so a hidden tier never
 * reaches the client; a note says what unlocks the rest.
 */
export function treasureBuildOptions(feature: TreasureFeature, online: boolean): PhoneBuildOption[] {
  const state = feature.state;
  if (!state) return [];
  const options: PhoneBuildOption[] = [];
  const busy = feature.pending || !online;
  const affordable = state.recipe.every((entry) => entry.have >= entry.quantity);
  const skilled = tradeSkillGateMet(TRADE_SKILL_GATES.artisan_shovel, state.cartographyRank);
  const hidden = state.hiddenTiers
    .map((entry) => `${TREASURE_TIER_NAMES[entry.tier]}s appear at Cartography rank ${entry.requiredRank}`)
    .join(", ");
  options.push({
    id: "treasure-shovel",
    category: "personal",
    icon: "treasure",
    title: "Shovel",
    description: `Digs up buried treasure within ${TREASURE_DIG_RADIUS_M} m. Wears out after ${SHOVEL_MAX_USES} digs.`,
    requirements: state.recipe.map((entry) => ({
      itemId: entry.itemId as ResourceType,
      quantity: entry.quantity,
      have: entry.have
    })),
    ...(state.shovels > 0
      ? { status: `${state.shovels} carried · ${state.shovelUsesRemaining ?? SHOVEL_MAX_USES} digs left`, active: true }
      : {}),
    guidance: hidden ? `Bronze caches are open to everyone. ${hidden}.` : "Every cache tier is open to you.",
    actionLabel: "Craft",
    enabled: !busy && affordable && skilled,
    disabledReason: !online ? "Disconnected"
      : !skilled ? tradeSkillGateMessage(TRADE_SKILL_GATES.artisan_shovel)
        : affordable ? null : "You need the listed materials in personal Inventory.",
    affordable,
    execute: feature.artisanShovel
  });
  for (const cache of state.caches) {
    const disabledReason = !online
      ? "Disconnected"
      : state.shovels < 1
        ? "You need a Shovel to dig."
        : !cache.reachable
          ? `Move within ${TREASURE_DIG_RADIUS_M} m (${cache.distanceM} m away).`
          : null;
    options.push({
      id: `treasure:${cache.id}`,
      category: "personal",
      icon: "treasure",
      title: TREASURE_TIER_NAMES[cache.tier],
      description: treasureCacheDescription(cache, feature.serverNowMs),
      requirements: [{ itemId: SHOVEL_ITEM_ID, quantity: 1, have: state.shovels }],
      guidance: cache.tier === "bronze"
        ? "Anyone can dig a Bronze Cache. The first digger takes everything."
        : `Needs Cartography rank ${TREASURE_TIER_REQUIRED_CARTOGRAPHY_RANK[cache.tier]}. The first digger takes everything.`,
      actionLabel: "Dig",
      enabled: !busy && disabledReason === null,
      disabledReason,
      affordable: state.shovels >= 1,
      execute: () => feature.dig(cache.id)
    });
  }
  return options;
}
