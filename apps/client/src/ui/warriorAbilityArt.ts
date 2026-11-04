import cleaveArt from "../assets/abilities/warrior-cleave.svg";
import fortifyArt from "../assets/abilities/warrior-fortify.svg";
import guardedStrikeArt from "../assets/abilities/warrior-guarded-strike.svg";
import punishingStrikeArt from "../assets/abilities/warrior-punishing-strike.svg";
import tauntArt from "../assets/abilities/warrior-taunt.svg";

export const WARRIOR_ABILITY_ART: Readonly<Record<string, string>> = Object.freeze({
  warrior_empowered_hit: punishingStrikeArt,
  warrior_anger_explosion: cleaveArt,
  warrior_concussive_blow: guardedStrikeArt,
  warrior_battle_cry: fortifyArt,
  warrior_punishing_strike: punishingStrikeArt,
  warrior_guarded_strike: guardedStrikeArt,
  warrior_cleave: cleaveArt,
  warrior_fortify: fortifyArt,
  universal_taunt: tauntArt
});

export function warriorAbilityArt(abilityId: string | null): string | null {
  return abilityId ? WARRIOR_ABILITY_ART[abilityId] ?? null : null;
}
