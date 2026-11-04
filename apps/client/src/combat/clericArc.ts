import { activeShotProfile, type PlayerAppearanceSnapshot, type ShotProfile } from "@ash-atlas/shared";

/**
 * CLERIC_ARC_ENABLED as the server announced it in WELCOME. The client picks a scepter's shot rules from it the same
 * way the server does (actionCombat.ts `shotProfileForWeapon`): on, the scepter casts the holy arc; off, it swings.
 */
let clericArcServerFlag = false;

export function setClericArcEnabled(enabled: boolean): void {
  clericArcServerFlag = enabled;
}

export function clericArcEnabled(): boolean {
  return clericArcServerFlag;
}

/** `activeShotProfile` with this server's flags: what the readied weapon in `appearance` shoots, or null when it swings. */
export function clientShotProfile(appearance: PlayerAppearanceSnapshot): ShotProfile | null {
  return activeShotProfile(appearance, { holyArc: clericArcServerFlag });
}

/** True for the shot kinds drawn as the procedural bolt (arcane blast and holy arc) rather than a projectile sprite. */
export function isBoltShot(profile: ShotProfile | null): boolean {
  return profile?.id === "arcane_blast" || profile?.id === "holy_arc";
}
