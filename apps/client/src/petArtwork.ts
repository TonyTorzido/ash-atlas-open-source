import { COMPANION_SPECIES_IDS, type CompanionSpeciesId, type MinionSpeciesId, type PetSpeciesId } from "@ash-atlas/shared";

import trailHoundUrl from "./assets/dogs/DogAdult1.png";
import broodSpinnerUrl from "./assets/pets/brood-spinner.png";
import raptorHatchlingUrl from "./assets/pets/raptor-hatchling.png";
import stormChickUrl from "./assets/pets/storm-chick.png";
import thicketWolfUrl from "./assets/pets/thicket-wolf.png";
import thornbackBoarUrl from "./assets/pets/thornback-boar.png";
import emberDrakeUrl from "./assets/pets/ember-drake.png";
import deepCrawlerUrl from "./assets/pets/deep-crawler.png";
import gladeWispUrl from "./assets/pets/glade-wisp.png";
import treantDuskrootUrl from "./assets/pets/treant-duskroot.png";
import treantMendbarkUrl from "./assets/pets/treant-mendbark.png";
import treantFernguardUrl from "./assets/pets/treant-fernguard.png";
import treantFrostwillowUrl from "./assets/pets/treant-frostwillow.png";
import treantRedwoodUrl from "./assets/pets/treant-redwood.png";
import treantShadespineUrl from "./assets/pets/treant-shadespine.png";
import boneThrallUrl from "./assets/pets/bone-thrall.png";
import graveEchoUrl from "./assets/pets/grave-echo.png";
import whistleTrailUrl from "./assets/items/whistle-trail.png";
import whistleSpinnerUrl from "./assets/items/whistle-spinner.png";
import whistleRaptorUrl from "./assets/items/whistle-raptor.png";
import whistleStormUrl from "./assets/items/whistle-storm.png";
import whistleWolfUrl from "./assets/items/whistle-wolf.png";
import whistleBoarUrl from "./assets/items/whistle-boar.png";
import whistleDrakeUrl from "./assets/items/whistle-drake.png";
import whistleCrawlerUrl from "./assets/items/whistle-crawler.png";
import whistleWispUrl from "./assets/items/whistle-wisp.png";

/**
 * Pet art. Creature PNGs live in assets/pets/ (1024 canvas, feet at y=940) and use the shared
 * `petCompanion` presentation in runtime-png-presentation.json; the Trail Hound keeps the old dog
 * art and the `dog` presentation. Whistles live in assets/items/.
 */
export const PET_ARTWORK_URLS: Readonly<Record<PetSpeciesId, string>> = {
  trail_hound: trailHoundUrl,
  brood_spinner: broodSpinnerUrl,
  emberclaw_raptor: raptorHatchlingUrl,
  storm_chick: stormChickUrl,
  thicket_wolf: thicketWolfUrl,
  thornback_boar: thornbackBoarUrl,
  ember_drake: emberDrakeUrl,
  deep_crawler: deepCrawlerUrl,
  glade_wisp: gladeWispUrl
};

export const MINION_ARTWORK_URLS: Readonly<Record<MinionSpeciesId, string>> = {
  treant_duskroot: treantDuskrootUrl,
  treant_mendbark: treantMendbarkUrl,
  treant_fernguard: treantFernguardUrl,
  treant_frostwillow: treantFrostwillowUrl,
  treant_redwood: treantRedwoodUrl,
  treant_shadespine: treantShadespineUrl,
  bone_thrall: boneThrallUrl,
  grave_echo: graveEchoUrl,
  // No Valkyrie art yet: borrows the Grave Echo figure.
  valkyrie: graveEchoUrl
};

export const PET_WHISTLE_ARTWORK_URLS: Readonly<Record<PetSpeciesId, string>> = {
  trail_hound: whistleTrailUrl,
  brood_spinner: whistleSpinnerUrl,
  emberclaw_raptor: whistleRaptorUrl,
  storm_chick: whistleStormUrl,
  thicket_wolf: whistleWolfUrl,
  thornback_boar: whistleBoarUrl,
  ember_drake: whistleDrakeUrl,
  deep_crawler: whistleCrawlerUrl,
  glade_wisp: whistleWispUrl
};

export type PetTextureKey = `pet_${CompanionSpeciesId}`;

export function petTextureKey(species: CompanionSpeciesId): PetTextureKey {
  return `pet_${species}`;
}

/** Texture URLs keyed so they never collide with mob artwork keys. */
export const PET_TEXTURE_URLS = Object.fromEntries(
  COMPANION_SPECIES_IDS.map((species) => [
    petTextureKey(species),
    (PET_ARTWORK_URLS as Readonly<Record<string, string>>)[species] ?? MINION_ARTWORK_URLS[species as MinionSpeciesId]
  ])
) as Readonly<Record<PetTextureKey, string>>;

/** Presentation key in runtime-png-presentation.json sprites. */
export function petPresentationKey(species: CompanionSpeciesId): "dog" | "petCompanion" | "petWisp" | "minionLarge" {
  if (species === "trail_hound") return "dog";
  if (species === "glade_wisp") return "petWisp";
  return species.startsWith("treant_") || species === "bone_thrall" || species === "grave_echo" || species === "valkyrie" ? "minionLarge" : "petCompanion";
}
