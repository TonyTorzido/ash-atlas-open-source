import type { ReactNode } from "react";

import { MOB_ARTWORK_URLS, mobArtworkSource } from "../map/mobArtwork.js";
import { itemArtworkSource, itemArtworkStyle } from "../ui/ItemArtwork.js";
import blowdartIcon from "./assets/items/blowdart.webp";
import brassKnucklesIcon from "./assets/items/brass-knuckles.webp";
import crossbowIcon from "./assets/items/crossbow.webp";
import daggerIcon from "./assets/items/dagger.webp";
import wyrmShieldIcon from "./assets/items/wyrm-shield.webp";
import shieldIcon from "./assets/items/shield.webp";
import slingIcon from "./assets/items/sling.webp";
import spearIcon from "./assets/items/spear.webp";
import unarmedIcon from "./assets/items/unarmed.webp";
import unarmoredIcon from "./assets/items/unarmored.webp";

/** Wiki-only icons for weapon and armor types that have no in-game item art yet. */
const MATCHUP_TYPE_ICONS: Readonly<Record<string, string>> = {
  unarmed: unarmedIcon,
  unarmored: unarmoredIcon,
  spear: spearIcon,
  dagger: daggerIcon,
  crossbow: crossbowIcon,
  blowdart: blowdartIcon,
  sling: slingIcon,
  brass_knuckles: brassKnucklesIcon,
  shield: shieldIcon,
  wyrm_shield: wyrmShieldIcon
};

/** Creature art for a mob archetype key, or null when the game has none yet. */
export function monsterArtSource(key: string): string | null {
  return mobArtworkSource(key as Parameters<typeof mobArtworkSource>[0])
    ?? (key === "goblin" ? MOB_ARTWORK_URLS.goblinBasic : null);
}

/** Decorative art; when no artwork exists yet the slot stays empty (no placeholder) so layouts stay aligned. */
export function WikiArt({ kind, id, name, className = "", typeId }: {
  kind: "monster" | "item";
  id: string | null;
  name: string;
  className?: string;
  /** Weapon or armor type; a wiki icon for it wins over the item art. */
  typeId?: string;
}): ReactNode {
  const typeIcon = typeId ? MATCHUP_TYPE_ICONS[typeId] : undefined;
  if (typeIcon) {
    return <img className={`wiki-art wiki-art-icon ${className}`.trim()} src={typeIcon} alt="" aria-hidden="true" loading="lazy" decoding="async" />;
  }
  const source = !id ? null : kind === "monster" ? monsterArtSource(id) : itemArtworkSource(id);
  if (!source) {
    return <span className={`wiki-art wiki-art-empty ${className}`.trim()} aria-hidden="true" data-missing-art={name} />;
  }
  return <img className={`wiki-art${kind === "item" ? " item-artwork" : ""} ${className}`.trim()} src={source} alt=""
    aria-hidden="true" loading="lazy" decoding="async" style={kind === "item" && id ? itemArtworkStyle(id) : undefined} />;
}
