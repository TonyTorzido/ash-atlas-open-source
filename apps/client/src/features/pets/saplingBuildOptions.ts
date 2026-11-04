import {
  GIVING_BERRY_ITEM_ID,
  GIVING_SAPLING_GROWN_DISPLAY_NAME,
  GIVING_SAPLING_ITEM_ID,
  SAPLING_INTERACT_RANGE_M,
  SAPLING_PULL_GROVE_LORE_RANK,
  SHOVEL_ITEM_ID,
} from "@ash-atlas/shared";

import type { PhoneBuildOption } from "../../ui/PhoneHud.js";
import type { NearbyMapSapling, SaplingFeature } from "./useSaplingFeature.js";

function saplingStatus(entry: NearbyMapSapling): string {
  const { item } = entry;
  if (item.state === "grown") return item.berryAvailable ? "Fruiting" : "Berries growing back";
  switch (item.phase) {
    case "dying": return "Dying: tend it now";
    case "needs_tending": return "Sick: needs tending";
    default: return "Healthy";
  }
}

/**
 * Construction → Personal cards: Plant a Giving Berry or a pulled sapling where you stand, and the
 * Tend / Pull / Gather actions for saplings and grown trees within reach.
 */
export function saplingBuildOptions(input: Readonly<{
  feature: SaplingFeature;
  online: boolean;
  /** False inside interiors and dungeons: planting is open-world only. */
  openWorld: boolean;
  totals: Readonly<Partial<Record<string, number>>>;
  aggressive: boolean;
  groveLoreRank: number;
}>): PhoneBuildOption[] {
  const { feature, online, openWorld, totals, aggressive, groveLoreRank } = input;
  if (!openWorld) return [];
  const busy = feature.busy !== null || !online;
  const berries = totals[GIVING_BERRY_ITEM_ID] ?? 0;
  const saplingItems = totals[GIVING_SAPLING_ITEM_ID] ?? 0;
  const options: PhoneBuildOption[] = [];
  const plantBlock = !online ? "Disconnected" : aggressive ? "You cannot plant while aggressive." : null;
  const plant = (source: "berry" | "sapling", have: number, title: string): PhoneBuildOption => ({
    id: source === "berry" ? "sapling-plant" : "sapling-plant-item",
    category: "personal",
    icon: "sapling",
    title,
    description: "Grows into a Giving Tree that heals everyone nearby. Tend it every day or it dies; it matures in 6 days.",
    requirements: [{ itemId: source === "berry" ? GIVING_BERRY_ITEM_ID : GIVING_SAPLING_ITEM_ID, quantity: 1, have }],
    guidance: `Planted where you stand on open land: not on water, not on another player's territory, 90 m from other trees.`,
    actionLabel: "Plant here",
    enabled: !busy && plantBlock === null && have >= 1,
    disabledReason: plantBlock ?? (have >= 1 ? null : source === "berry" ? "You need a Giving Berry." : "You have no sapling."),
    affordable: have >= 1,
    execute: () => { feature.actions.plant(source); }
  });
  options.push(plant("berry", berries, "Plant Sapling"));
  if (saplingItems > 0) options.push(plant("sapling", saplingItems, "Replant Giving Tree Sapling"));

  for (const entry of feature.nearby) {
    const { item } = entry;
    const name = item.state === "grown" ? GIVING_SAPLING_GROWN_DISPLAY_NAME : "Giving Tree Sapling";
    if (item.state === "sapling") {
      const tendable = item.phase !== "healthy";
      options.push({
        id: `sapling-tend:${item.id}`,
        category: "personal",
        icon: "sapling",
        title: name,
        description: `${saplingStatus(entry)}. Tap it on the map for the owner and exact timers.`,
        requirements: [`${item.growth * 10}% grown`],
        ...(tendable ? { status: "Needs tending", active: true } : {}),
        guidance: `Anyone within ${SAPLING_INTERACT_RANGE_M} m can tend it once a day. A sick sapling does not heal until tended. With Grove Lore rank 2 your own saplings mature in 4 days.`,
        actionLabel: "Tend",
        enabled: !busy && tendable,
        disabledReason: !online ? "Disconnected" : tendable ? null : "It is not due for tending yet.",
        affordable: true,
        execute: () => { feature.actions.tend(item.id); }
      });
      const hasShovel = (totals[SHOVEL_ITEM_ID] ?? 0) > 0;
      if (hasShovel || groveLoreRank >= SAPLING_PULL_GROVE_LORE_RANK) options.push({
        id: `sapling-pull:${item.id}`,
        category: "personal",
        icon: "sapling",
        title: `Pull ${name}`,
        description: "Pull it up to carry it and replant it elsewhere as a fresh sapling.",
        requirements: [hasShovel ? "Shovel" : `Grove Lore rank ${SAPLING_PULL_GROVE_LORE_RANK}`],
        guidance: hasShovel
          ? "With a Shovel you can uproot any growing sapling, anyone's, anywhere."
          : "Your own saplings, or any on unclaimed land or your own territory. A Shovel uproots any sapling.",
        actionLabel: "Pull up",
        enabled: !busy && online,
        disabledReason: online ? null : "Disconnected",
        affordable: true,
        execute: () => { feature.actions.pull(item.id); }
      });
    } else {
      options.push({
        id: `sapling-gather:${item.id}`,
        category: "personal",
        icon: "sapling",
        title: name,
        description: `${saplingStatus(entry)}. It grows one Giving Berry back every 5 hours.`,
        requirements: [],
        ...(item.berryAvailable ? { status: "Fruiting", active: true } : {}),
        guidance: `Anyone within ${SAPLING_INTERACT_RANGE_M} m can gather its berry.`,
        actionLabel: "Gather berry",
        enabled: !busy && item.berryAvailable,
        disabledReason: !online ? "Disconnected" : item.berryAvailable ? null : "The berries are still growing back.",
        affordable: true,
        execute: () => { feature.actions.gather(item.id); }
      });
    }
  }
  return options;
}
