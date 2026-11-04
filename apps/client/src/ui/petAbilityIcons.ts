import type { PetAbilityId } from "@ash-atlas/shared";

import trackHide from "../assets/abilities/pets/ability-track-hide.png";
import findOpenLand from "../assets/abilities/pets/ability-find-open-land.png";
import webSnare from "../assets/abilities/pets/ability-web-snare.png";
import envenom from "../assets/abilities/pets/ability-envenom.png";
import pounce from "../assets/abilities/pets/ability-pounce.png";
import rendingBite from "../assets/abilities/pets/ability-rending-bite.png";
import galeGust from "../assets/abilities/pets/ability-squall-burst.png";
import skySight from "../assets/abilities/pets/ability-sky-sight.png";
import holdFast from "../assets/abilities/pets/ability-hold-fast.png";
import shadowHide from "../assets/abilities/pets/ability-shadow-hide.png";
import bullRush from "../assets/abilities/pets/ability-bull-rush.png";
import fury from "../assets/abilities/pets/ability-fury.png";
import emberSpit from "../assets/abilities/pets/ability-ember-spit.png";
import tailLash from "../assets/abilities/pets/ability-tail-lash.png";
import hug from "../assets/abilities/pets/ability-hug.png";
import latch from "../assets/abilities/pets/ability-latch.png";
import mend from "../assets/abilities/pets/ability-mend.png";
import mischief from "../assets/abilities/pets/ability-mischief.png";
import petCall from "../assets/abilities/pets/ability-pet-call.png";
import petStay from "../assets/abilities/pets/ability-pet-stay.png";

/** Round 256px ability badges in assets/abilities/pets/ (`ability-<kebab id>.png`). */
export const PET_ABILITY_ICON_URLS: Readonly<Record<PetAbilityId, string>> = {
  track_hide: trackHide,
  find_open_land: findOpenLand,
  web_snare: webSnare,
  envenom,
  pounce,
  rending_bite: rendingBite,
  squall_burst: galeGust,
  sky_sight: skySight,
  hold_fast: holdFast,
  shadow_hide: shadowHide,
  bull_rush: bullRush,
  fury,
  ember_spit: emberSpit,
  tail_lash: tailLash,
  hug,
  latch,
  mend,
  mischief
};

export const PET_CALL_ICON_URL = petCall;
export const PET_STAY_ICON_URL = petStay;
