/*
 * Sword styles (owner 2026-10-21, docs/plans/player-sword-keyposes/class-combos.md): who draws which combo, and its
 * rhythm. `generic` = anyone holding a sword (plain, sturdy one-handed cuts); `ronin` = the Ronin class holding a sword
 * (two-handed, low, heavy). The old fencer combo is retired.
 *
 * Timing per style and combo step, 30 fps frames from the press: the phases' frame runs (wind-up, hit hold, follow,
 * ready). The contact frame is the first hit frame; the walk may take over from the first ready frame; the swing ends
 * after the last frame. These mirror docs/plans/player-sword-keyposes/class-<style>/combo.json (the approved previews)
 * and the shared attack profiles (packages/shared attackProfiles.ts "sword:<style>"): tests keep the contact frame on
 * the profile's windup (the server's hit tick) and each swing inside its step's cycle.
 *
 * Held follow-through (owner 2026-10-21, the Ronin flow): a style with `hold` has no ready frames inside the combo.
 * Each cut STAYS where it ended (its last follow-through pose) until the next press replaces the swing, so the next
 * wind-up starts straight from there; only when the combo ends (no press within the profile's reset window) does it
 * ease back to the ready guard, through the step's `ease` frames (the two-handed raise after a low finish). Server
 * timing is unchanged: the hold only fills the time to the next press.
 */
import { ATTACK_PROFILES, type CombatStyleId } from "@ash-atlas/shared";

/**
 * Axe styles (2026-10-21, docs/plans/player-axe-keyposes/axe-combos.md) ride the same key-pose system with the axe's
 * art, grip and trail (jacketSword.ts AXE_ART): `axe-generic` = anyone holding an axe (heavy plain chops),
 * `axe-warrior` = the Warrior class holding an axe (sweeps, barge, overhead). Their timing is the art drop's combo.json
 * (packed into the axe-poses manifests by `pack-sword-keyposes.py --weapon axe`; the test keeps the two equal).
 */
export const SWORD_STYLES = ["generic", "ronin", "axe-generic", "axe-warrior"] as const;
export type SwordStyle = (typeof SWORD_STYLES)[number];
export type MeleeWeapon = "sword" | "axe";
/** The weapon a style draws and the server's combat style (attack profile) whose timing it animates. */
export const SWORD_STYLE_WEAPON: Readonly<Record<SwordStyle, MeleeWeapon>> = {
  generic: "sword", ronin: "sword", "axe-generic": "axe", "axe-warrior": "axe"
};
export const SWORD_STYLE_PROFILE: Readonly<Record<SwordStyle, CombatStyleId>> = {
  generic: "sword:generic", ronin: "sword:ronin", "axe-generic": "axe:generic", "axe-warrior": "axe:warrior"
};
/** The held weapon's appearance family -> the weapon it draws as. */
export const MELEE_WEAPON_FAMILIES: Readonly<Record<string, MeleeWeapon>> = { one_handed_sword: "sword", one_handed_axe: "axe" };
/** A weapon's style when the server's style is for another weapon (a swap the snapshot has not caught up with). */
const PLAIN_STYLE: Readonly<Record<MeleeWeapon, SwordStyle>> = { sword: "generic", axe: "axe-generic" };
export type SwordPhase = "windup" | "hit" | "follow" | "ready" | "raise";

type Run = readonly [SwordPhase, number];
type StyleTiming = Readonly<{
  /** Per combo step: the phase runs. */
  swings: readonly [readonly Run[], readonly Run[], readonly Run[]];
  /** Trail sweep sign wind-up -> hit (-1 = counter-clockwise on screen, over the top; +1 = clockwise). */
  sweep: readonly [number, number, number];
  /** Trail vertical squash around the grip (a level cut seen at 15 degrees reads as a flat ellipse). */
  flat: readonly [number, number, number];
  /**
   * Hold the last follow-through pose until the next press, or until `resetMs` after this press (the combo ended);
   * then play the step's `ease` runs back to the ready guard.
   */
  hold?: Readonly<{ resetMs: number; ease: readonly [readonly Run[], readonly Run[], readonly Run[]] }>;
  /**
   * Owner 2026-10-21: walking with the sword out, the style holds its own guard: a drawn walk cycle of this many frames
   * (poses walk-0 .. walk-N-1, the live walk's legs with the guard held), spread over the stock walk's cycle. Absent =
   * the stock sword walk (the one-handed arm held out).
   */
  guardWalkFrames?: number;
}>;

export const SWORD_STYLE_TIMING: Readonly<Record<SwordStyle, StyleTiming>> = {
  // Quick and sturdy: contact 100 / 100 / 133 ms, next press 500 / 500 / 650 ms. Held like the Ronin (the same
  // bounce through the guard between cuts): each follow-through already sits where the next wind-up starts (13 -> 21
  // low on the far side, 23 -> 31 high), so no in-between pose; the guard comes back when the combo ends.
  generic: {
    swings: [
      [["windup", 3], ["hit", 2], ["follow", 4]],
      [["windup", 3], ["hit", 2], ["follow", 4]],
      [["windup", 4], ["hit", 3], ["follow", 5]]
    ],
    sweep: [-1, 1, -1],
    flat: [1, 0.22, 1],
    hold: { resetMs: ATTACK_PROFILES["sword:generic"].comboResetMs, ease: [[], [], []] },
    // Walking with the sword out: the generic guard (blade up at 45 degrees, off fist raised), drawn over the live
    // walk's legs (8 frames), so the guard no longer drops to the arm-out stock walk.
    guardWalkFrames: 8
  },
  // Slower, heavier: contact 133 / 133 / 200 ms, next press 667 / 800 / 1000 ms. Each cut is held until the next press
  // (the rising cut stays high, the kesa and the finisher stay low); swing 3 lifts from the low kesa finish through
  // the two-handed raise into jodan (contact still f6); after a low finish the combo end eases up through the raise.
  ronin: {
    swings: [
      [["windup", 4], ["hit", 3], ["follow", 7]],
      [["windup", 4], ["hit", 4], ["follow", 8]],
      [["raise", 3], ["windup", 3], ["hit", 5], ["follow", 14]]
    ],
    sweep: [1, -1, -1],
    flat: [0.6, 1, 1],
    hold: { resetMs: ATTACK_PROFILES["sword:ronin"].comboResetMs, ease: [[], [["raise", 3]], [["raise", 3]]] },
    // Walking with the sword out: the two-handed hasso guard, drawn over the live walk's legs (8 frames).
    guardWalkFrames: 8
  },
  // Heavy plain chops: contact 200 / 200 / 300 ms, next press 800 / 800 / 1100 ms; each swing returns to the ready
  // guard inside its own cadence (no held follow-through).
  // Walking with the axe out: the drawn guard walk (owner 2026-10-21: the stock walk with the axe pinned at the hand
  // anchor, held out at arm's length, was "super ugly"): both fists on the haft across the body, drawn over the live
  // walk's legs (8 frames, class-generic/drawings/pose-walk-*.png).
  "axe-generic": {
    swings: [
      [["windup", 6], ["hit", 3], ["follow", 7], ["ready", 8]],
      [["windup", 6], ["hit", 3], ["follow", 7], ["ready", 8]],
      [["windup", 9], ["hit", 4], ["follow", 10], ["ready", 10]]
    ],
    sweep: [-1, 1, -1],
    flat: [1, 0.3, 1],
    guardWalkFrames: 8
  },
  // Momentum: contact 233 / 133 / 367 ms, next press 800 / 600 / 1200 ms. The two sweeps hold their follow-through until
  // the next press (the next wind-up starts from there); only the barge-overhead finisher recovers to the ready carry.
  // Walking: the Warrior's own drawn guard walk (the axe held low and ready in the right fist, left fist on the hip).
  "axe-warrior": {
    swings: [
      [["windup", 7], ["hit", 3], ["follow", 14]],
      [["windup", 4], ["hit", 3], ["follow", 11]],
      [["windup", 11], ["hit", 5], ["follow", 12], ["ready", 8]]
    ],
    sweep: [1, -1, -1],
    flat: [0.3, 1, 1],
    hold: { resetMs: ATTACK_PROFILES["axe:warrior"].comboResetMs, ease: [[], [], []] },
    guardWalkFrames: 8
  }
};

export type SwingTimeline = Readonly<{
  /** Phase per frame (30 fps from the press) of the swing itself (wind-up, hit, follow-through[, ready]). */
  phases: readonly SwordPhase[];
  /** First hit frame (the frame on screen when the hit lands). */
  contactFrame: number;
  /** First ready frame (or the end of the swing frames): a walk takes over from here, and the swing's aim stops
   *  deciding the facing. */
  readyFrame: number;
  /** Held styles: the last follow-through pose shows until this frame (the reset window), then `ease`. */
  holdUntilFrame: number | null;
  ease: readonly SwordPhase[];
  /** The swing is over (the rig falls back to the ready stand / walk) from this frame on, with no newer press. */
  endFrame: number;
}>;

const timelines = new Map<string, SwingTimeline>();
/** The frame timeline of one combo step in a style. */
export function swingTimeline(style: SwordStyle, comboIndex: 0 | 1 | 2): SwingTimeline {
  const key = `${style}:${comboIndex}`;
  let t = timelines.get(key);
  if (!t) {
    const timing = SWORD_STYLE_TIMING[style];
    const runs = (list: readonly Run[]): SwordPhase[] => list.flatMap(([phase, n]) => Array<SwordPhase>(n).fill(phase));
    const phases = runs(timing.swings[comboIndex]);
    const ready = phases.indexOf("ready");
    const holdUntilFrame = timing.hold ? Math.max(phases.length, Math.round((timing.hold.resetMs * 30) / 1000)) : null;
    const ease = timing.hold ? runs(timing.hold.ease[comboIndex]) : [];
    t = {
      phases, contactFrame: phases.indexOf("hit"), readyFrame: ready >= 0 ? ready : phases.length,
      holdUntilFrame, ease, endFrame: holdUntilFrame === null ? phases.length : holdUntilFrame + ease.length
    };
    timelines.set(key, t);
  }
  return t;
}

/**
 * Dev builds only: a forced style for every player (`?swordStyle=generic|ronin|axe-generic|axe-warrior` or
 * `globalThis.__swordStyleOverride`), for runtime checks; it applies to players holding that style's weapon.
 * Undefined = no override.
 */
export function devSwordStyleOverride(): SwordStyle | undefined {
  if (!import.meta.env.DEV) return undefined;
  let value: unknown = (globalThis as { __swordStyleOverride?: unknown }).__swordStyleOverride;
  if (value === undefined) {
    try {
      value = new URLSearchParams(globalThis.location?.search ?? "").get("swordStyle") ?? undefined;
    } catch {
      value = undefined;
    }
  }
  return (SWORD_STYLES as readonly unknown[]).includes(value) ? value as SwordStyle : undefined;
}

/**
 * The style a player draws, from the combat style the server resolved for them (the combat entity's `combatStyle`,
 * attackProfiles.ts combatStyleFor(class, weapon family)) and the held weapon's appearance family: "sword:ronin" =
 * Ronin, "axe:warrior" = Warrior axe, "axe:generic" = generic axe, anything else the generic sword. A style for another
 * weapon than the one held (the snapshot lags a swap) draws the held weapon's plain style. The dev override
 * (?swordStyle=...) wins in dev builds for players holding its weapon.
 */
export function swordStyleFor(combat: Readonly<{ combatStyle?: string | null }> | null | undefined, weaponFamily?: string | null): SwordStyle {
  const held = weaponFamily ? MELEE_WEAPON_FAMILIES[weaponFamily] : undefined;
  const forced = devSwordStyleOverride();
  if (forced && (!held || SWORD_STYLE_WEAPON[forced] === held)) return forced;
  const style = (SWORD_STYLES as readonly SwordStyle[]).find((s) => SWORD_STYLE_PROFILE[s] === combat?.combatStyle) ?? "generic";
  return held && SWORD_STYLE_WEAPON[style] !== held ? PLAIN_STYLE[held] : style;
}
