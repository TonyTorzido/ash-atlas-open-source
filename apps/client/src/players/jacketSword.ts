/*
 * Player sword (2026-10-20, Phase 2 of docs/plans/player-sword-keyposes/README.md): drawn key poses replace the
 * rig-animated combo. The sword stays in hand while a sword-family weapon is held:
 * - swing: the server's combo step (SwingPlayback.comboIndex 0, 1, 2) picks swing 1 / 2 / 3 of the player's sword
 *   style (swordStyles.ts, owner 2026-10-21: `generic` for any sword user, `ronin` for the Ronin class); each swing
 *   shows its wind-up, the hit pose from the style's contact frame, the follow-through and the ready pose, 30 fps on the
 *   attacker's sample clock (the clock the hitstop holds), per the style's timing (SWORD_STYLE_TIMING);
 * - slash trail: a procedural crescent from the wind-up to the hit blade (port of build_preview.py slash_trail), one
 *   Graphics per player sharing a prebuilt GraphicsContext per swing (no per-frame geometry), fading over 6 frames;
 * - sword out (owner 2026-10-20: during a swing and SWORD_SHEATHE_MS after it ends; a new swing restarts it): the turned
 *   stand is the drawn ready pose (00-ready) and the walk the sword_walk clip (the live walk with the sword arm held at
 *   the ready angle, grip exported per frame), facing the attack side even when walking away from it;
 * - sword away (after that, and before any swing): the regular stand / walk / front idle with the sword on the back,
 *   diagonal behind the body, riding the chest bone (jacketb-torso.json, packages/animator/scripts/gather/
 *   torso-xf-jacketb.ts); the front idle follows SWORD_SHEATHED_IDLE_MS after the sheathe (jacketRig.ts).
 * The R side is the L key-pose sheet image-flipped (like the R clips); sword_walk has its own mirrored-input R render.
 * The equipped sword's art is drawn at the pose's grip and angle behind the body; where the drawn blade crossed in
 * front of the body (pose.bladeFront) the blade (guard to tip) is drawn again over the body, the fist staying over the
 * handle (the preview's front mask, simplified to one flag per pose so no mask pass runs).
 * Sheets load while a sword is held and release after the 45 s idle like the gather set:
 * - key poses, per style and look (2026-10-21): the 10 poses of each style drawn in the bare tank top and redrawn in
 *   each stock armour (`pack-sword-keyposes.py --set class-<style>[-<armour>]` -> sword-poses/<style>-<look>/
 *   <style>-<look>-sword.json + pages); the worn armour's set of the style, else the style's tank-top set. Adding a
 *   look or a style is only those data files (+ the style's timing).
 * - sword walk (2026-10-21): the stock body's sword_walk clip with the worn armour's sword_walk layer over it
 *   (scripts/copy-stock-armour.mjs step 3, stockArmour.ts), frame for frame like the other clips; the grip per frame
 *   is the Jacket B sword walk's (jacketb-sword.json `xf`: same skeleton and clip).
 * Axes (2026-10-21, docs/plans/player-axe-keyposes/axe-combos.md): the axe styles (swordStyles.ts `axe-generic`,
 * `axe-warrior`) use this same layer with the axe's art spec (AXE_ART: grip on the wrap, head up), the heavy head-swept
 * trail (axeTrailPolygons, port of that build_preview.py axe_trail) and the back carry BACK_AXE. Their pose sets are
 * `pack-sword-keyposes.py --weapon axe` output (axe-poses/axe-<style>-tank/). TEMPORARY: only the tank top is drawn,
 * so every armour draws the axe style's tank-top set (poseSetFor's fallback) until the armour variants are packed.
 * Walking with the axe out plays the drawn guard walk (guardWalkFrames; axe-poses sets carry walk-0..7); armoured looks draw the tank-top set's walk, never the anchor walk.
 */
import type { SwingVariant } from "@ash-atlas/player-renderer";
import { playerAppearanceAssetUrl } from "@ash-atlas/player-renderer/asset-registry";
import { Assets, Container, Graphics, GraphicsContext, Rectangle, Sprite, Texture } from "pixi.js";
import manifest from "../assets/player-rig/jacketb-sword/jacketb-sword.json";
import torso from "../assets/player-rig/jacketb/jacketb-torso.json";
import { placeFrame } from "./jacketGather.js";
import { createLazySheets, type LazySheets, type SheetView } from "./jacketSheets.js";
import { stockClip, stockClipState, type StockArmourId } from "./stockArmour.js";
import {
  MELEE_WEAPON_FAMILIES, swingTimeline, SWORD_STYLE_TIMING, SWORD_STYLE_WEAPON, SWORD_STYLES, type MeleeWeapon, type SwordPhase,
  type SwordStyle
} from "./swordStyles.js";

export type { SwordPhase, SwordStyle } from "./swordStyles.js";

type Side = "L" | "R";
export type SwordPoseId = "00-ready" | "11-swing1-windup" | "12-swing1-hit" | "13-swing1-follow" | "21-swing2-windup" |
  "22-swing2-hit" | "23-swing2-follow" | "31-swing3-windup" | "32-swing3-hit" | "33-swing3-follow" |
  /** In-between (the two-handed raise from a low finish), only in styles whose timing uses the "raise" phase. */
  "90-raise" |
  /** The drawn guard-walk frames, only in styles with guardWalkFrames. */
  `walk-${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7}`;
type Pose = { cell: number; grip: [number, number]; deg: number; len: number; bladeFront: boolean; butt?: number };
type KeyPoses = { view: SheetView; poses: Record<SwordPoseId, Pose> };
/**
 * The Jacket B sword manifest: the shared timing (scale, fps) and the sword walk's per-frame grip transform (`xf`,
 * the same clip on the same skeleton as the stock body's sword walk). Its pages are no longer drawn.
 */
const MANIFEST = manifest as unknown as {
  scale: number;
  fps: number;
  clips: { sword_walk: { frames: number; xf: number[][] } };
};

/** One style x look's 10 key poses: pose data and its lazily loaded sheet (one entry, side L; R flips it in code). */
type KeyPoseSet = Readonly<{
  /** `<style>-<look>`, the look being "tank" or the stock armour id. */
  id: string;
  style: SwordStyle;
  keyposes: KeyPoses;
  textures(nowMs?: number): Texture[] | null;
  state(): "loading" | "ready" | "failed" | "none";
}>;
/** The bare tank top's look id (no chest armour, or any other chest look). */
const TANK = "tank";
/** Per style x look sets (sword-poses/<style>-<look>/<style>-<look>-sword.json, same scale / fps as the body sheets). */
type PoseSetManifest = { style: SwordStyle; look: StockArmourId | typeof TANK; scale: number; fps: number; keyposes: KeyPoses };
const POSE_MANIFESTS = import.meta.glob<PoseSetManifest>(
  ["../assets/player-rig/sword-poses/*/*-sword.json", "../assets/player-rig/axe-poses/*/*-axe.json"], { eager: true, import: "default" });
const POSE_URLS = import.meta.glob<string>(
  ["../assets/player-rig/sword-poses/*/*.png", "../assets/player-rig/axe-poses/*/*.png"], { query: "?url", import: "default" });
const POSE_SETS = new Map<string, KeyPoseSet>();
for (const [path, data] of Object.entries(POSE_MANIFESTS)) {
  if (data.scale !== MANIFEST.scale || data.fps !== MANIFEST.fps) throw new Error(`sword poses ${data.style}-${data.look}: scale / fps differ from the body sheets'`);
  const id = `${data.style}-${data.look}`;
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  let sheets: LazySheets<"keyposes"> | null = null;
  const lazy = (): LazySheets<"keyposes"> => (sheets ??= createLazySheets<"keyposes">(`sword-${id}`,
    folder, POSE_URLS, () => data.keyposes.view));
  POSE_SETS.set(id, {
    id,
    style: data.style,
    keyposes: data.keyposes,
    textures: (nowMs) => lazy().get("keyposes", "L", nowMs),
    state: () => (sheets ? sheets.state("keyposes", "L") : "none")
  });
}
for (const style of SWORD_STYLES) if (!POSE_SETS.has(`${style}-${TANK}`)) throw new Error(`sword poses: the ${style} tank-top set (sword-poses/${style}-tank) is missing`);
// A style whose timing uses the raise needs it drawn in every one of its sets.
for (const set of POSE_SETS.values()) {
  const t = SWORD_STYLE_TIMING[set.style];
  const usesRaise = [...t.swings, ...(t.hold?.ease ?? [])].some((runs) => runs.some(([phase]) => phase === "raise"));
  if (usesRaise && !set.keyposes.poses["90-raise"]) throw new Error(`sword poses ${set.id}: the timing uses the raise but 90-raise is missing`);
  for (let i = 0; i < (t.guardWalkFrames ?? 0); i += 1) {
    if (!set.keyposes.poses[`walk-${i}` as SwordPoseId]) throw new Error(`sword poses ${set.id}: the guard walk needs walk-${i}`);
  }
}
/** The stock walk clip's length (frames): a drawn guard-walk cycle is spread over it, so the stride timing matches. */
const STOCK_WALK_FRAMES = 28;
/**
 * The key poses drawn for a look in a style: the armour's own set of the style, else the style's tank-top set.
 * TEMPORARY for the axe styles: no armour sets are packed yet, so armoured looks draw the axe tank-top poses.
 */
function poseSetFor(armour: StockArmourId | null | undefined, style: SwordStyle = "generic"): KeyPoseSet {
  return (armour ? POSE_SETS.get(`${style}-${armour}`) : undefined) ?? POSE_SETS.get(`${style}-${TANK}`)!;
}
/** Which pose set a look draws in a style (`<style>-<look>`; the look is "tank" when the armour has no set). */
export function swordPoseSetFor(armour: StockArmourId | null | undefined, style: SwordStyle = "generic"): string {
  return poseSetFor(armour, style).id;
}

/** Trail alpha per frame from the contact frame (the axe's heavier smear fades over 5 frames, as its previews). */
const TRAIL_FADE: Readonly<Record<MeleeWeapon, readonly number[]>> = {
  sword: [1, 0.85, 0.65, 0.45, 0.28, 0.12],
  axe: [1, 0.82, 0.6, 0.38, 0.18]
};
/** Swing length (ms) of a style's combo step: its last frame ends here. */
export function swordSwingMs(style: SwordStyle, comboIndex: 0 | 1 | 2): number {
  return (swingTimeline(style, comboIndex).endFrame * 1000) / MANIFEST.fps;
}
/** The follow-through ends here (ms after the swing starts): the swing's aim stops deciding the facing. */
export function swordFollowEndMs(style: SwordStyle, comboIndex: 0 | 1 | 2): number {
  return (swingTimeline(style, comboIndex).readyFrame * 1000) / MANIFEST.fps;
}
/** Owner 2026-10-20: the sword stays out this long after the last swing ends, then goes on the back. */
export const SWORD_SHEATHE_MS = 2000;
/** Standing still once the sword is away: the front idle this long after the sheathe (4 s after the swing). */
export const SWORD_SHEATHED_IDLE_MS = 2000;
/** Body clips with an exported chest transform (jacketb-torso.json), one row per sheet frame. */
export type JacketBodyClip = "idle" | "walkL" | "walkR" | "standL" | "standR";
const TORSO = (torso as unknown as { clips: Record<JacketBodyClip, number[][]> }).clips;
/**
 * The sword on the back, on the setup pose (canvas px from the skeleton origin, y down; L-view canvas, the R view is
 * the image-flipped mirror): grip and the canvas direction from the grip to the tip. The hilt and guard show over the
 * trailing shoulder (screen right on the front and L views), the tip below the opposite hip; drawn behind the body.
 */
const BACK_SWORD: Readonly<Record<"front" | "side", readonly [number, number, number]>> = {
  front: [145, -290, 133],
  side: [145, -290, 133]
};
/**
 * The axe on the back (same frame as BACK_SWORD): the haft along the sword's diagonal but head UP, the head over the
 * trailing shoulder where the sword's hilt sits and the grip low behind the opposite hip.
 */
const BACK_AXE: Readonly<Record<"front" | "side", readonly [number, number, number]>> = {
  front: [-125, -19, -47],
  side: [-125, -19, -47]
};
/** Appearance families drawn with the key poses: swords, and axes (2026-10-21). */
export const SWORD_FAMILIES: ReadonlySet<string> = new Set(Object.keys(MELEE_WEAPON_FAMILIES));
type WeaponArt = Readonly<{ grip: readonly [number, number]; k: number; refHeight: number; mx: number; tip: number; bladeEnd: number }>;
/** Sword art (1024 px canvas, blade up): grip = the fist on the handle, k = canvas px per art px, tip / guard rows. */
const SWORD_ART: WeaponArt = { grip: [0.5, 0.735], k: 0.8, refHeight: 1024, mx: -1, tip: 0.099, bladeEnd: 0.665 };
/**
 * Axe art (the stock Double Axe, 1024 px canvas, head up; swag axes share the canvas): grip = the fist on the wrap (the
 * catalog pivot, jacketGather.ts TOOL_ART.axe, build_preview.py AXE_SPEC); tip = the head's top row; bladeEnd = the
 * haft row just above the fist (what is drawn over the body when the drawn axe crossed in front: head and haft, the fist
 * staying over the wrap). headLow = the lower bit corners' row (the trail band spans headLow .. tip along the haft).
 */
const AXE_ART: WeaponArt & { headLow: number } = { grip: [0.496, 0.648], k: 0.8, refHeight: 1024, mx: -1, tip: 0.138, bladeEnd: 0.56, headLow: 0.349 };
const WEAPON_ART: Readonly<Record<MeleeWeapon, WeaponArt>> = { sword: SWORD_ART, axe: AXE_ART };
const styleWeapon = (style: SwordStyle | undefined): MeleeWeapon => SWORD_STYLE_WEAPON[style ?? "generic"];

export function swordPoseFor(swing: 0 | 1 | 2, phase: SwordPhase): SwordPoseId {
  if (phase === "ready") return "00-ready";
  if (phase === "raise") return "90-raise";
  const n = swing + 1;
  return `${n}${phase === "windup" ? 1 : phase === "hit" ? 2 : 3}-swing${n}-${phase}` as SwordPoseId;
}

export type JacketSwordInput = Readonly<{
  /** Server combo step of this swing (0, 1, 2). */
  comboIndex: 0 | 1 | 2;
  /** The swinging player's sword style (swordStyleFor); absent = generic. */
  style?: SwordStyle;
  startedAtMs: number;
  side: "left" | "right";
  /** The equipped sword's loaded art. */
  weapon: Texture;
}>;

/** Dev/test: the swing pose and frame shown at nowMs in the input's style (frame past the end = the swing is over). */
export function jacketSwordFrame(input: Pick<JacketSwordInput, "comboIndex" | "startedAtMs" | "style">, nowMs: number): {
  swing: 0 | 1 | 2; phase: SwordPhase; pose: SwordPoseId; frame: number; done: boolean; contactFrame: number; readyFrame: number;
} {
  const swing = input.comboIndex === 1 || input.comboIndex === 2 ? input.comboIndex : 0;
  const t = swingTimeline(input.style ?? "generic", swing);
  const frame = Math.floor(Math.max(0, nowMs - input.startedAtMs) * MANIFEST.fps / 1000 + 1e-6);
  // Held styles: past the swing frames the last follow-through pose holds to the reset window, then the ease frames.
  const phase = frame < t.phases.length ? t.phases[frame]!
    : t.holdUntilFrame !== null && frame < t.holdUntilFrame ? t.phases[t.phases.length - 1]!
      : t.holdUntilFrame !== null && frame < t.endFrame ? t.ease[frame - t.holdUntilFrame]!
        : t.phases[t.phases.length - 1]!;
  return { swing, phase, pose: swordPoseFor(swing, phase), frame, done: frame >= t.endFrame, contactFrame: t.contactFrame, readyFrame: t.readyFrame };
}

/** Which combo step a swing variant implies when no index is known. */
export function comboIndexForVariant(variant: SwingVariant): 0 | 1 | 2 {
  return variant === "finisher" ? 2 : 0;
}

/**
 * The last swing a rig saw: when it started, its follow-through ends and it ends (ms, sample clock), and the side it
 * aimed at.
 */
export type SwordSwingMark = Readonly<{ startedAtMs: number; followEndMs: number; endMs: number; side: "L" | "R" }>;

/** Folds a swing input into the last-swing mark (a newer swing replaces it; the same swing keeps it). */
export function markSwordSwing(mark: SwordSwingMark | null, input: Pick<JacketSwordInput, "startedAtMs" | "side" | "comboIndex" | "style">): SwordSwingMark {
  if (mark && input.startedAtMs <= mark.startedAtMs) return mark;
  const style = input.style ?? "generic";
  return {
    startedAtMs: input.startedAtMs,
    followEndMs: input.startedAtMs + swordFollowEndMs(style, input.comboIndex),
    endMs: input.startedAtMs + swordSwingMs(style, input.comboIndex),
    side: input.side === "right" ? "R" : "L"
  };
}

/** The sword is out (in hand): during the last swing and SWORD_SHEATHE_MS after it ends. */
export function swordOut(mark: SwordSwingMark | null, nowMs: number): boolean {
  return mark !== null && nowMs >= mark.startedAtMs && nowMs < mark.endMs + SWORD_SHEATHE_MS;
}

/**
 * The side the attack forces on the body this frame, or null when the movement decides (owner 2026-10-20): the swing's
 * aim side up to the end of its follow-through; after it, while the sword is out and attack input is held, the held
 * aim's side (`attackAimX`, screen x) or else the swing's side. Released (or a remote player) after the follow-through:
 * null, so a move turns the body at once even though the sword is still out; standing still keeps the last side.
 */
export function swordAimSide(mark: SwordSwingMark | null, nowMs: number, attackHeld: boolean, attackAimX: number | null): "L" | "R" | null {
  if (!mark) return null;
  if (nowMs < mark.followEndMs) return mark.side;
  if (!attackHeld || !swordOut(mark, nowMs)) return null;
  if (attackAimX !== null && Math.abs(attackAimX) >= 0.04) return attackAimX > 0 ? "R" : "L";
  return mark.side;
}

/**
 * When a player standing still turns to the front idle: standTurnedMs after the last move, or, when they stopped
 * before the sheathe, SWORD_SHEATHED_IDLE_MS after it (4 s after the swing ends).
 */
export function frontIdleAtMs(lastMoveMs: number, standTurnedMs: number, mark: SwordSwingMark | null): number {
  if (mark) {
    const sheatheAt = mark.endMs + SWORD_SHEATHE_MS;
    if (lastMoveMs < sheatheAt) return sheatheAt + SWORD_SHEATHED_IDLE_MS;
  }
  return lastMoveMs + standTurnedMs;
}

/** Whether a held weapon draws with the sword poses. */
export function isJacketSwordWeapon(weapon: Readonly<{ familyId: string }> | null | undefined): boolean {
  return weapon != null && SWORD_FAMILIES.has(weapon.familyId);
}

/** The held weapon's art when it is a sword-family weapon (drawn in hand while standing and walking), else null. */
export function heldSwordTexture(weapon: Readonly<{ texture: Texture; familyId: string }> | null | undefined): Texture | null {
  return weapon && isJacketSwordWeapon(weapon) ? weapon.texture : null;
}

/**
 * A sword is held: starts (or keeps warm) the look's key-pose sheet (only that one) and, for a style without its own
 * drawn guard walk, its two stock sword walks (the stock body's, + the armour's layer). Called per frame while held.
 */
export function preloadJacketSwordSheets(nowMs?: number, armour?: StockArmourId | null, style: SwordStyle = "generic"): void {
  poseSetFor(armour, style).textures(nowMs);
  if (SWORD_STYLE_TIMING[style].guardWalkFrames) return;
  stockClip(armour ?? null, "sword_walkL", nowMs);
  stockClip(armour ?? null, "sword_walkR", nowMs);
}

/** Dev/test: load state of a look's sword walk (body, layer; layer "none" for the tank top). */
export function jacketSwordWalkState(armour: StockArmourId | null, side: Side): { body: string; layer: string } {
  return stockClipState(armour, `sword_walk${side}`);
}

/** Dev/test: load state of a look's key-pose sheet in a style (the armour's own set, else the style's tank top's). */
export function jacketSwordPoseSheetState(armour: StockArmourId | null | undefined, style: SwordStyle = "generic"): "loading" | "ready" | "failed" | "none" {
  return poseSetFor(armour, style).state();
}

/** Pose data (tests, dev): the look's own set in the style, else the style's tank top's. */
export function jacketSwordPose(id: SwordPoseId, armour?: StockArmourId | null, style: SwordStyle = "generic"): Readonly<Pose> {
  return poseSetFor(armour, style).keyposes.poses[id];
}

/** Rig units: the art's grip-to-tip length. */
const BLADE_LEN = SWORD_ART.k * (SWORD_ART.grip[1] - SWORD_ART.tip) * SWORD_ART.refHeight;
const reversedPoints = (pts: number[]): number[] => {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i]!, pts[i + 1]!);
  return out;
};

/**
 * Axe trail (port of docs/plans/player-axe-keyposes/build_preview.py axe_trail): a heavy crescent swept by the axe
 * HEAD wind-up -> hit. The head centre's path (grip moving, haft turning, the head slamming in late) is stroked with a
 * band as wide as the head's span along the haft, a blunt fifth at the tail, full by 80 %; the core is the outer 70 %.
 */
export function axeTrailPolygons(swing: 0 | 1 | 2, segments = 32, armour?: StockArmourId | null, style: SwordStyle = "axe-generic"): { rim: number[]; core: number[] } {
  const poses = poseSetFor(armour, style).keyposes.poses;
  const { sweep, flat: flats } = SWORD_STYLE_TIMING[style];
  const wind = poses[swordPoseFor(swing, "windup")];
  const hit = poses[swordPoseFor(swing, "hit")];
  const rTop = AXE_ART.k * (AXE_ART.grip[1] - AXE_ART.tip) * AXE_ART.refHeight;
  const rLow = AXE_ART.k * (AXE_ART.grip[1] - AXE_ART.headLow) * AXE_ART.refHeight;
  const d0 = wind.deg, d1 = hit.deg;
  const mod = (v: number) => ((v % 360) + 360) % 360;
  const delta = sweep[swing]! > 0 ? mod(d1 - d0) : -mod(d0 - d1);
  const flat = flats[swing]!;
  const path: [number, number][] = [], grips: [number, number][] = [];
  for (let i = 0; i <= segments; i += 1) {
    const e = 1 - (1 - i / segments) ** 3;
    const gx = wind.grip[0] + (hit.grip[0] - wind.grip[0]) * e;
    const gy = wind.grip[1] + (hit.grip[1] - wind.grip[1]) * e;
    const ang = ((d0 + delta * e) * Math.PI) / 180;
    const rc = ((rTop + rLow) / 2) * (wind.len + (hit.len - wind.len) * e);
    path.push([gx + Math.cos(ang) * rc, gy + Math.sin(ang) * rc * flat]);
    grips.push([gx, gy]);
  }
  const half = ((rTop - rLow) / 2) * 1.15;
  const outer: number[] = [], inner: number[] = [], coreIn: number[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = path[Math.max(0, i - 1)]!, b = path[Math.min(segments, i + 1)]!;
    const tx = b[0] - a[0], ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1;
    let nx = -ty / tl, ny = tx / tl;
    const [px, py] = path[i]!;
    if ((px - grips[i]![0]) * nx + (py - grips[i]![1]) * ny < 0) { nx = -nx; ny = -ny; } // outer side away from the fist
    const hw = half * Math.min(1, 0.2 + i / segments);
    outer.push(px + nx * hw, py + ny * hw);
    inner.push(px - nx * hw, py - ny * hw);
    // the core runs from the outer edge 70 % of the way across the band
    coreIn.push(px + nx * hw * (1 - 2 * 0.7), py + ny * hw * (1 - 2 * 0.7));
  }
  return { rim: [...outer, ...reversedPoints(inner)], core: [...outer, ...reversedPoints(coreIn)] };
}

/** Trail polygons (rig units from the root, y down, L view) for one swing: the band the blade sweeps wind-up -> hit. */
export function swordTrailPolygons(swing: 0 | 1 | 2, segments = 32, armour?: StockArmourId | null, style: SwordStyle = "generic"): { rim: number[]; core: number[] } {
  if (styleWeapon(style) === "axe") return axeTrailPolygons(swing, segments, armour, style);
  const poses = poseSetFor(armour, style).keyposes.poses;
  const { sweep, flat: flats } = SWORD_STYLE_TIMING[style];
  const wind = poses[swordPoseFor(swing, "windup")];
  const hit = poses[swordPoseFor(swing, "hit")];
  const d0 = wind.deg, d1 = hit.deg;
  const mod = (v: number) => ((v % 360) + 360) % 360;
  const delta = sweep[swing]! > 0 ? mod(d1 - d0) : -mod(d0 - d1);
  const flat = flats[swing]!;
  const outer: number[] = [], inner: number[] = [], coreIn: number[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const e = 1 - (1 - t) ** 2; // the blade accelerates into the hit
    const gx = wind.grip[0] + (hit.grip[0] - wind.grip[0]) * e;
    const gy = wind.grip[1] + (hit.grip[1] - wind.grip[1]) * e;
    const ang = ((d0 + delta * e) * Math.PI) / 180;
    const ln = BLADE_LEN * (wind.len + (hit.len - wind.len) * e);
    const thick = 0.72 * t ** 1.2; // tapered: thin tail at the wind-up end, widest at the hit
    const rOut = ln * 1.04, rIn = ln * (1.04 - thick), rCore = rOut + (rIn - rOut) * 0.62;
    const c = Math.cos(ang), s = Math.sin(ang) * flat;
    outer.push(gx + c * rOut, gy + s * rOut);
    inner.push(gx + c * rIn, gy + s * rIn);
    coreIn.push(gx + c * rCore, gy + s * rCore);
  }
  return { rim: [...outer, ...reversedPoints(inner)], core: [...outer, ...reversedPoints(coreIn)] };
}

const trailContexts = new Map<KeyPoseSet, GraphicsContext[]>();
/** One shared context per pose set and swing, built once: the per-player Graphics only swaps it and sets alpha. */
function getTrailContexts(set: KeyPoseSet, armour: StockArmourId | null): GraphicsContext[] {
  let contexts = trailContexts.get(set);
  if (!contexts) {
    contexts = ([0, 1, 2] as const).map((swing) => {
      const { rim, core } = swordTrailPolygons(swing, 32, armour, set.style);
      // The axe's smear is warm and dusty (axe_trail's rim / core colours), the sword's cool.
      return styleWeapon(set.style) === "axe"
        ? new GraphicsContext()
          .poly(rim).fill({ color: 0xe8decd, alpha: 175 / 255 })
          .poly(core).fill({ color: 0xfffbf2, alpha: 240 / 255 })
        : new GraphicsContext()
          .poly(rim).fill({ color: 0xd6e8ff, alpha: 150 / 255 })
          .poly(core).fill({ color: 0xfafcff, alpha: 235 / 255 });
    });
    trailContexts.set(set, contexts);
  }
  return contexts;
}

/** Dev debug suffix naming the pose set. */
const setTag = (set: KeyPoseSet): string => `@${set.id}`;

/**
 * Held / sheathed sword art (owner t1572): the weapon's 1024 px art is drawn ~26 css px tall and ROTATED at runtime, so
 * bilinear reads skipped most texels and near-vertical blade edges turned jagged. Each one-handed sword has a 192 px copy
 * (scripts/make-held-sword-art.py: Lanczos, linear light, premultiplied; same canvas, so the grip anchor is unchanged)
 * loaded with mipmaps. The weapon texture is matched to its copy by the asset URL pixi labels it with; until the copy
 * loads (or for an art-pack blob override, which has no copy) the original art draws.
 */
const HELD_URLS = import.meta.glob<string>(
  ["../assets/player-rig/sword-held/*.png", "../assets/player-rig/axe-held/*.png"], { query: "?url", import: "default", eager: true });
const absoluteUrl = (url: string): string => {
  try {
    return new URL(url, globalThis.location?.href).href;
  } catch {
    return url;
  }
};
const heldByAssetUrl = new Map<string, string>();
for (const [path, url] of Object.entries(HELD_URLS)) {
  const stem = path.slice(path.lastIndexOf("/") + 1, -".png".length);
  const assetUrl = playerAppearanceAssetUrl(`weapons/${stem.replace("__", "/")}.png`);
  if (assetUrl) heldByAssetUrl.set(absoluteUrl(assetUrl), url);
}
const heldArt = new Map<string, Texture | null>();
export function heldSwordArt(weapon: Texture): Texture {
  const label = weapon.source.label;
  const url = label ? heldByAssetUrl.get(absoluteUrl(label)) : undefined;
  if (!url) return weapon;
  const have = heldArt.get(url);
  if (have) return have;
  if (have === undefined) {
    heldArt.set(url, null);
    Assets.load<Texture>({ src: url, data: { autoGenerateMipmaps: true, scaleMode: "linear" } }).then(
      (texture) => { if (texture) heldArt.set(url, texture); },
      (error: unknown) => console.warn("[jacket-rig] held sword art failed to load; drawing the original", error),
    );
  }
  return weapon;
}

/** Blade-only (guard to tip; the axe's head and upper haft) sub-texture of the art, drawn over the body when it was in front. */
const bladeTextures = new WeakMap<Texture, Texture>();
function bladeTexture(weapon: Texture, art: WeaponArt): Texture {
  let blade = bladeTextures.get(weapon);
  if (!blade) {
    const f = weapon.frame;
    blade = new Texture({ source: weapon.source, frame: new Rectangle(f.x, f.y, f.width, Math.max(1, Math.round(f.height * art.bladeEnd))) });
    bladeTextures.set(weapon, blade);
  }
  return blade;
}

/**
 * Held axe clipped past the fist (axe art drop `butt`: rig units of haft drawn past the grip toward the butt end, at most
 * 90, so the art's dark butt cap, 91.6-118, never shows under the fists). Rows below grip row + butt / (k * refHeight)
 * are cut, as build_preview.py place_axe does. Sub-textures are cached per weapon texture and clip row.
 */
const buttTextures = new WeakMap<Texture, Map<number, Texture>>();
function buttClippedTexture(weapon: Texture, art: WeaponArt, butt: number): Texture {
  const f = weapon.frame;
  const rows = Math.min(f.height, Math.max(1, Math.round(f.height * (art.grip[1] + butt / (art.k * art.refHeight)))));
  let byRows = buttTextures.get(weapon);
  if (!byRows) buttTextures.set(weapon, (byRows = new Map()));
  let clipped = byRows.get(rows);
  if (!clipped) {
    clipped = new Texture({ source: weapon.source, frame: new Rectangle(f.x, f.y, f.width, rows) });
    byRows.set(rows, clipped);
  }
  return clipped;
}

/** One player's sword: the body pose / walk frame, the sword art (behind, and the blade over the body) and the trail. */
export class JacketSwordLayer {
  readonly back = new Container({ label: "JacketSwordBack" });
  readonly front = new Container({ label: "JacketSwordFront" });
  private readonly blade = new Sprite();
  private readonly bladeFront = new Sprite();
  /** The sheathed sword on the back (behind the body). */
  private readonly backSword = new Sprite();
  private trail: Graphics | null = null;
  /** The swing a move broke out of (its held cut is not shown again). */
  private leftSwingAtMs = Number.NaN;
  debug = "";

  constructor() {
    this.back.addChild(this.backSword, this.blade);
    this.front.addChild(this.bladeFront);
    this.backSword.visible = false;
    this.blade.visible = false;
    this.bladeFront.visible = false;
  }

  /**
   * Shows the swing on `sprite` in the input's style and the look's pose set (`armour`'s own, else the style's tank
   * top's); false when it is over, walked out of, or the key-pose sheet is still loading.
   */
  apply(input: JacketSwordInput, nowMs: number, walking: boolean, sprite: Sprite, scale: number, footBelowRootPx: number, armour: StockArmourId | null = null): boolean {
    const { swing, phase, pose, frame, done, contactFrame, readyFrame } = jacketSwordFrame(input, nowMs);
    // Owner 2026-10-21: a move after the follow-through leaves the held cut for the style's walk, and that swing stays
    // over (stopping again shows the guard, not the cut pose again); a new press starts fresh.
    if (input.startedAtMs === this.leftSwingAtMs) return false;
    if (walking && frame >= readyFrame && !done) this.leftSwingAtMs = input.startedAtMs;
    if (done || (walking && frame >= readyFrame)) return false;
    const side: Side = input.side === "right" ? "R" : "L";
    const set = poseSetFor(armour, input.style ?? "generic");
    if (!this.showPose(set, pose, side, input.weapon, nowMs, sprite, scale, footBelowRootPx)) return false;
    this.debug = `swing${swing + 1}${side}:${phase}:${pose}:f${frame}${setTag(set)}`;
    const fade = frame >= contactFrame ? TRAIL_FADE[styleWeapon(set.style)][frame - contactFrame] : undefined;
    if (fade === undefined) {
      if (this.trail) this.trail.visible = false;
    } else {
      const contexts = getTrailContexts(set, armour);
      if (!this.trail) {
        this.trail = new Graphics(contexts[swing]);
        this.front.addChildAt(this.trail, 0);
      }
      const trail = this.trail;
      if (trail.context !== contexts[swing]) trail.context = contexts[swing]!;
      const px = MANIFEST.scale * scale; // trail polygons are in rig units
      trail.scale.set(side === "R" ? -px : px, px);
      trail.position.set(0, -footBelowRootPx * scale);
      trail.alpha = fade;
      trail.visible = true;
    }
    return true;
  }

  /**
   * Sword held, no swing: the drawn ready pose (turned stand, in the look's pose set) or the sword walk frame (the stock
   * body's sword walk, with the armour's layer on `layerSprite`). False while loading.
   */
  applyHeld(kind: "stand" | "walk", side: Side, walkFrame: number, weapon: Texture, nowMs: number, sprite: Sprite, scale: number, footBelowRootPx: number, armour: StockArmourId | null = null, layerSprite: Sprite | null = null, style: SwordStyle = "generic"): boolean {
    if (this.trail) this.trail.visible = false;
    if (kind === "stand") {
      const set = poseSetFor(armour, style);
      if (!this.showPose(set, "00-ready", side, weapon, nowMs, sprite, scale, footBelowRootPx)) return false;
      this.debug = `ready${side}${setTag(set)}`;
      return true;
    }
    const guardFrames = SWORD_STYLE_TIMING[style].guardWalkFrames;
    if (guardFrames) {
      // Owner 2026-10-21: the style walks holding its own guard (drawn frames over the live walk's legs); the full
      // figure is in the drawing, so no garment layer.
      const set = poseSetFor(armour, style);
      const i = Math.floor(((walkFrame % STOCK_WALK_FRAMES) * guardFrames) / STOCK_WALK_FRAMES);
      if (!this.showPose(set, `walk-${i}` as SwordPoseId, side, weapon, nowMs, sprite, scale, footBelowRootPx)) return false;
      if (layerSprite) layerSprite.visible = false;
      this.debug = `guardwalk${side}:g${i}${setTag(set)}`;
      return true;
    }
    const stock = stockClip(armour, `sword_walk${side}`, nowMs);
    if (!stock) return false;
    const clip = MANIFEST.clips.sword_walk;
    const index = walkFrame % stock.body.length;
    const view = stock.bodyView;
    this.placeBody(sprite, stock.body[index]!, view, view.flip, scale, footBelowRootPx);
    if (layerSprite) {
      layerSprite.visible = stock.layer !== null;
      if (stock.layer && stock.layerView) placeFrame(layerSprite, stock.layer[index]!, stock.layerView, view.flip ? -scale : scale, scale, footBelowRootPx);
    }
    const [gx, gy, deg, , , len] = clip.xf[index % clip.xf.length]!;
    // (Every shipped axe style has a drawn guard walk, so this stock sword walk is only reached by a style without one.)
    this.placeBlades(weapon, WEAPON_ART[styleWeapon(style)], gx!, gy!, deg!, len ?? 1, false, view.flip, scale, footBelowRootPx);
    this.debug = `walk${side}:f${index}${armour ? `@${armour}` : "@tank"}${styleWeapon(style) === "axe" ? ":axe" : ""}`;
    return true;
  }

  /**
   * Sword away: the sword on the back of the body clip's frame (the body sprite is drawn by the caller), placed with
   * the frame's chest transform so it bobs with the walk and breathes with the idle.
   */
  applyBack(clip: JacketBodyClip, frame: number, flip: boolean, weapon: Texture, scale: number, footBelowRootPx: number, style: SwordStyle = "generic"): void {
    this.blade.visible = false;
    this.bladeFront.visible = false;
    if (this.trail) this.trail.visible = false;
    const rows = TORSO[clip];
    const index = frame % rows.length;
    const [a, b, c, d, tx, ty] = rows[index]!;
    const axe = styleWeapon(style) === "axe";
    const [gx, gy, deg] = (axe ? BACK_AXE : BACK_SWORD)[clip === "idle" ? "front" : "side"];
    const rad = (deg * Math.PI) / 180;
    const dx = Math.cos(rad), dy = Math.sin(rad);
    const x = a! * gx + b! * gy + tx!, y = c! * gx + d! * gy + ty!;
    const turned = (Math.atan2(c! * dx + d! * dy, a! * dx + b! * dy) * 180) / Math.PI;
    this.placeSword(this.backSword, heldSwordArt(weapon), WEAPON_ART[axe ? "axe" : "sword"], x, y, turned, 1, flip, scale, footBelowRootPx);
    this.debug = `back:${clip}:f${index}${axe ? ":axe" : ""}`;
  }

  private showPose(set: KeyPoseSet, id: SwordPoseId, side: Side, weapon: Texture, nowMs: number, sprite: Sprite, scale: number, footBelowRootPx: number): boolean {
    const textures = set.textures(nowMs);
    if (!textures) return false;
    const pose = set.keyposes.poses[id];
    const flip = side === "R";
    this.placeBody(sprite, textures[pose.cell]!, set.keyposes.view, flip, scale, footBelowRootPx);
    this.placeBlades(weapon, WEAPON_ART[styleWeapon(set.style)], pose.grip[0], pose.grip[1], pose.deg, pose.len, pose.bladeFront, flip, scale, footBelowRootPx, pose.butt);
    return true;
  }

  private placeBody(sprite: Sprite, texture: Texture, view: SheetView, flip: boolean, scale: number, footBelowRootPx: number): void {
    if (sprite.texture !== texture) sprite.texture = texture;
    sprite.anchor.set(view.rootX / view.frameWidth, view.rootY / view.frameHeight);
    sprite.scale.set(flip ? -scale : scale, scale);
    sprite.position.set(0, -footBelowRootPx * scale);
  }

  /** The sword art at a grip (rig units from the root, y down) and canvas blade direction, mirrored for R. */
  private placeBlades(weaponArt: Texture, art: WeaponArt, gx: number, gy: number, deg: number, len: number, bladeFront: boolean, flip: boolean, scale: number, footBelowRootPx: number, butt?: number): void {
    this.backSword.visible = false;
    const weapon = heldSwordArt(weaponArt);
    const { x, y, rotation, k, f } = this.placeSword(this.blade, weapon, art, gx, gy, deg, len, flip, scale, footBelowRootPx, butt);
    const front = this.bladeFront;
    front.visible = bladeFront;
    if (!bladeFront) return;
    const bt = bladeTexture(weapon, art);
    if (front.texture !== bt) front.texture = bt;
    front.anchor.set(art.grip[0], (art.grip[1] * weapon.frame.height) / bt.frame.height);
    front.position.set(x, y);
    front.rotation = rotation;
    front.scale.set(art.mx * f * k, k * len);
  }

  /** One sword sprite: the art's grip at (gx, gy) rig units from the root, blade toward canvas direction deg. */
  private placeSword(sprite: Sprite, weapon: Texture, art: WeaponArt, gx: number, gy: number, deg: number, len: number, flip: boolean, scale: number, footBelowRootPx: number, butt?: number): { x: number; y: number; rotation: number; k: number; f: number } {
    const f = flip ? -1 : 1;
    // Rig units -> parent units (sheet frames are drawn at MANIFEST.scale; `scale` = parent units per sheet px).
    const px = MANIFEST.scale * scale;
    const x = f * gx * px, y = -footBelowRootPx * scale + gy * px;
    // Canvas direction (y down) -> the art's up axis; the R view mirrors it like the body.
    const rotation = (((flip ? 180 - deg : deg) + 90) * Math.PI) / 180;
    const k = (art.k * px * art.refHeight) / weapon.height;
    const drawn = butt === undefined ? weapon : buttClippedTexture(weapon, art, butt);
    if (sprite.texture !== drawn) sprite.texture = drawn;
    sprite.anchor.set(art.grip[0], (art.grip[1] * weapon.frame.height) / drawn.frame.height);
    sprite.position.set(x, y);
    sprite.rotation = rotation;
    sprite.scale.set(art.mx * f * k, k * len);
    sprite.visible = true;
    return { x, y, rotation, k, f };
  }

  hide(): void {
    this.backSword.visible = false;
    this.blade.visible = false;
    this.bladeFront.visible = false;
    if (this.trail) this.trail.visible = false;
  }
}

/** The rig's sword input for a player's latest swing playback, held weapon and sword style (null = no sword swing to show). */
export function jacketSwordInput(
  playback: Readonly<{ variant: SwingVariant; comboIndex: 0 | 1 | 2; side: "left" | "right"; startedAtMs: number; cancelled: boolean }> | null,
  weapon: Readonly<{ texture: Texture; familyId: string }> | null,
  style: SwordStyle = "generic"
): JacketSwordInput | null {
  if (!playback || playback.cancelled || playback.variant === "shot" || !weapon || !isJacketSwordWeapon(weapon)) return null;
  return { comboIndex: playback.comboIndex, style, startedAtMs: playback.startedAtMs, side: playback.side, weapon: weapon.texture };
}
