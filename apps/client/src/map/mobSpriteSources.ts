import { MOB_ARCHETYPE_KEYS, type MobArchetypeKey } from "@ash-atlas/shared";

import { MOB_ARTWORK_URLS, mobArtworkKey as archetypeArtworkKey, type MobArtworkKey } from "./mobArtwork.js";

export type MobSilhouetteKind = "training_dummy" | "orc_brute";
export type MobVisualDescriptor =
  | Readonly<{ kind: "image"; artworkKey: MobArtworkKey; src: string }>
  /** Generic placeholder art: a solid square with a letter. Swap for real art when it exists. */
  | Readonly<{ kind: "placeholder_square"; label: string; colorNumber: number; sizePx: number }>
  | Readonly<{
      kind: "silhouette";
      silhouette: MobSilhouetteKind;
      primaryColor: string;
      primaryColorNumber: number;
    }>;

/**
 * Archetypes without a PNG that draw something other than the generic marker
 * (vector silhouettes; a PNG always wins). Placeholder squares are for mobs
 * whose art is still pending.
 */
const MOB_FALLBACK_VISUALS: Readonly<Partial<Record<MobArchetypeKey, MobVisualDescriptor>>> = {
  training_dummy: {
    kind: "silhouette", silhouette: "training_dummy",
    primaryColor: "#f59e0b", primaryColorNumber: 0xf59e0b
  },
  orc_brute: {
    kind: "silhouette", silhouette: "orc_brute",
    primaryColor: "#4d7c0f", primaryColorNumber: 0x4d7c0f
  }
};

function describe(archetypeKey: MobArchetypeKey): MobVisualDescriptor | null {
  const artworkKey = archetypeArtworkKey(archetypeKey);
  const src = artworkKey ? MOB_ARTWORK_URLS[artworkKey] : null;
  if (artworkKey && src) return { kind: "image", artworkKey, src };
  return MOB_FALLBACK_VISUALS[archetypeKey] ?? null;
}

/** Derived from MOB_ARCHETYPE_ARTWORK; archetypes with no art and no fallback visual are absent. */
export const MOB_VISUAL_DESCRIPTORS: Readonly<
  Partial<Record<MobArchetypeKey, MobVisualDescriptor>>
> = Object.fromEntries(MOB_ARCHETYPE_KEYS.flatMap((archetypeKey) => {
  const descriptor = describe(archetypeKey);
  return descriptor ? [[archetypeKey, descriptor]] : [];
}));

export function mobVisualDescriptor(archetypeKey: MobArchetypeKey): MobVisualDescriptor | null {
  return MOB_VISUAL_DESCRIPTORS[archetypeKey] ?? null;
}

export function mobArtworkKey(archetypeKey: MobArchetypeKey): MobArtworkKey | null {
  const descriptor = mobVisualDescriptor(archetypeKey);
  return descriptor?.kind === "image" ? descriptor.artworkKey : null;
}

export function mobSpriteUrl(archetypeKey: MobArchetypeKey): string | null {
  const descriptor = mobVisualDescriptor(archetypeKey);
  return descriptor?.kind === "image" ? descriptor.src : null;
}
