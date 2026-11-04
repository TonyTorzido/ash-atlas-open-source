import type { FishingWaterbodyKind } from "@ash-atlas/shared";

import pixelFishUrl from "../assets/fishing/PixelFish.png";
import lakeBackgroundUrl from "../assets/fishing/LakeBackground.png";
import oceanBackgroundUrl from "../assets/fishing/OceanBackground.png";
import riverBackgroundUrl from "../assets/fishing/RiverBackground.png";

/**
 * Fishing encounter art is kept separate from the world hut presentation.
 * Only approved source-kind art is registered here; a missing kind deliberately
 * falls back to the canonical scene surface instead of pretending an asset
 * exists.
 */
export const FISHING_HUT_ARTWORK_URL: string | null = null;

const FISHING_BACKGROUND_BY_KIND: Partial<Record<FishingWaterbodyKind, string>> = {
  river: riverBackgroundUrl,
  lake: lakeBackgroundUrl,
  ocean: oceanBackgroundUrl
};

export const FISHING_ENCOUNTER_ARTWORK = {
  fish: pixelFishUrl,
  backgrounds: FISHING_BACKGROUND_BY_KIND
} as const;

export function fishingEncounterBackgroundUrl(
  kind: FishingWaterbodyKind
): string | null {
  return FISHING_ENCOUNTER_ARTWORK.backgrounds[kind] ?? null;
}

export function fishingWaterbodyLabel(kind: FishingWaterbodyKind): string {
  return kind === "river" ? "River" : kind === "lake" ? "Lake" : "Ocean";
}
