import {
  MONOLITH_BUILD_SPARKS,
  MONOLITH_DISPLAY_NAMES,
  MONOLITH_EFFECT_TEXT,
  MONOLITH_IGNITE_ITEM_ID,
  MONOLITH_IGNITE_QUANTITY,
  MONOLITH_INERT_TYPES,
  MONOLITH_INTERACTION_RADIUS_M,
  MONOLITH_RANGE_DIAMETER_M,
  MONOLITH_RECHARGE_SPARKS,
  MONOLITH_REQUIRED_RANK,
  MONOLITH_SPARK_ITEM_ID,
  MONOLITH_TYPES,
  monolithTypeUnlocked,
  type MonolithSnapshot
} from "@ash-atlas/shared";

import type { PhoneBuildOption } from "../../ui/PhoneHud.js";
import type { MonolithFeature } from "./useMonolithFeature.js";

function formatRemaining(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** "Active · 23h 10m left", "Remnant · 12h 0m left", "Burning · 42m left". */
export function monolithLifetimeLabel(monolith: MonolithSnapshot, nowMs: number): string {
  switch (monolith.phase) {
    case "active":
      return `Active · ${formatRemaining(Date.parse(monolith.expiresAt) - nowMs)} left`;
    case "remnant":
      return `Remnant · ${formatRemaining(Date.parse(monolith.remnantUntil) - nowMs)} until it crumbles`;
    case "burning":
      return `Burning · falls in ${formatRemaining(Date.parse(monolith.burnUntil ?? monolith.expiresAt) - nowMs)}`;
    default:
      return "Gone";
  }
}

/**
 * Construction → War cards: the six monolith
 * builds (gated by rank, placed at the player's position), and the
 * monoliths standing nearby with their lifetime and Recharge / Ignite.
 */
export function monolithBuildOptions(feature: MonolithFeature, online: boolean): PhoneBuildOption[] {
  const state = feature.state;
  if (!state) return [];
  const options: PhoneBuildOption[] = [];
  const busy = feature.pending || !online;
  const { discovered, rank } = state.skill;
  for (const type of MONOLITH_TYPES) {
    const required = MONOLITH_REQUIRED_RANK[type];
    // The server gates on rank alone (a rank implies discovery).
    const unlocked = monolithTypeUnlocked(type, rank);
    const own = state.monoliths.find((monolith) => monolith.own && monolith.type === type &&
      (monolith.phase === "active" || monolith.phase === "burning"));
    const affordable = state.sparks >= MONOLITH_BUILD_SPARKS;
    const disabledReason = !online
      ? "Disconnected"
      : !discovered && rank === 0
        ? "Discover Field Engineering at the Spark Forge in the Golem Forge first."
        : !unlocked
          ? `Needs Field Engineering rank ${required}.`
          : own
            ? `Your ${MONOLITH_DISPLAY_NAMES[type]} is still standing.`
            : !affordable
              ? `Requires ${MONOLITH_BUILD_SPARKS} Forge Spark.`
              : null;
    options.push({
      id: `monolith-build:${type}`,
      category: "war",
      icon: "monolith",
      title: MONOLITH_DISPLAY_NAMES[type],
      description: MONOLITH_EFFECT_TEXT[type],
      requirements: [
        { itemId: MONOLITH_SPARK_ITEM_ID, quantity: MONOLITH_BUILD_SPARKS, have: state.sparks },
        `Field Engineering ${required}`
      ],
      ...(own ? { status: "Active", active: true } : {}),
      guidance: MONOLITH_INERT_TYPES.has(type)
        ? "Coming soon: it stands, but its effect is not live yet."
        : `Placed where you stand; reaches ${MONOLITH_RANGE_DIAMETER_M} m across for 20 hours.`,
      actionLabel: "Place here",
      enabled: !busy && disabledReason === null,
      disabledReason,
      affordable,
      execute: () => feature.place(type)
    });
  }
  for (const monolith of state.monoliths) {
    if (monolith.phase === "gone") continue;
    const reachable = monolith.distanceM <= MONOLITH_INTERACTION_RADIUS_M;
    const burning = monolith.phase === "burning";
    const recharge = monolith.allied;
    const have = recharge ? state.sparks : state.crudeOil;
    const need = recharge ? MONOLITH_RECHARGE_SPARKS : MONOLITH_IGNITE_QUANTITY;
    const disabledReason = !online
      ? "Disconnected"
      : burning
        ? recharge ? "It is burning and cannot be recharged." : "It is already burning."
        : !reachable
          ? `Move within ${MONOLITH_INTERACTION_RADIUS_M} m (${monolith.distanceM} m away).`
          : have < need
            ? `Requires ${need} ${recharge ? "Forge Spark" : "Crude Oil"}.`
            : null;
    const owner = monolith.own ? "Yours" : monolith.allied ? `Ally · ${monolith.ownerName}` : `Enemy · ${monolith.ownerName}`;
    options.push({
      id: `monolith:${monolith.id}`,
      category: "war",
      icon: "monolith",
      title: `${MONOLITH_DISPLAY_NAMES[monolith.type]} · ${owner}`,
      description: `${monolithLifetimeLabel(monolith, feature.serverNowMs)}. ${monolith.distanceM} m away.${monolith.inert ? " Effect coming soon." : ""}`,
      requirements: [recharge
        ? { itemId: MONOLITH_SPARK_ITEM_ID, quantity: need, have }
        : { itemId: MONOLITH_IGNITE_ITEM_ID, quantity: need, have }],
      ...(monolith.phase === "active" ? { status: "Active", active: true } : {}),
      guidance: recharge
        ? "Recharging restarts its 24-hour life."
        : "Igniting sets it burning; it falls in 1 hour.",
      actionLabel: recharge ? "Recharge" : "Ignite",
      enabled: !busy && disabledReason === null,
      disabledReason,
      affordable: have >= need,
      execute: () => recharge ? feature.recharge(monolith.id) : feature.ignite(monolith.id)
    });
  }
  return options;
}
