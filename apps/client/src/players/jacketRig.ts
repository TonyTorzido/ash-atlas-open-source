/*
 * Jacket B player (2026-10-20): replaces the drawn player body with the approved five-anims Jacket B clips,
 * pre-rendered by the Atlas Animator (scripts/copy-jacket-rig.mjs: copy the rigs, `animator render`, pack sheets).
 * Render only: positions, combat and gathering are untouched.
 *
 * - idle            -> straight front, idle_weight_shift (96 f, breath + blink)
 * - walk, facing L  -> turned 15 deg left, walk_in_place (28 f)
 * - walk, facing R  -> the L15 rig built with mirrored inputs, image-flipped here (as the evidence renders clip 02)
 * - stopped          -> the turned stance of the last side (idle clip on the turned rigs, all 30 fps poses) for
 *                      5 s, then the straight-front idle; any movement restarts the 5 s
 * - sword held       -> sword out (a swing and 2 s after it): the turned stance is the drawn ready pose and the walk
 *                      the sword walk, sword in hand; the attack side wins over the walk direction only during
 *                      the swing (to its follow-through end) and while attack input is held; then sword
 *                      away: the regular clips with the sword on the back, and when standing still since before
 *                      the sheathe the front idle comes 2 s after it (jacketSword.ts)
 * The side flips on the frame the local input's horizontal sign changes (remote players: their screen direction);
 * straight down/up keep the last side (the back views are parked).
 * Playback: 30 fps held frames; walk speed follows movement speed. One Sprite per player; the frame textures are
 * shared by every player.
 *
 * Looks (owner 2026-10-21, stockArmour.ts): every player draws the bare stock body sheets (tank top + black pants),
 * and a player whose chest look is one of the four stock armours gets that armour's garment layer on top, frame for
 * frame, in every clip above, in gathering and in the sword walk. The sword swing and ready stand draw the look's own
 * redrawn key poses (jacketSword.ts). Jacket B is no longer drawn: its sheets' manifest (jacketb-sheets.json) only
 * gives the shared render metrics (fps, figure height, foot line), as the stock sheets use the same render frame.
 *
 * `?jacketRig=0` shows the old body; `?jacketRig=live` (dev builds only) draws the live rig (jacketRigLive.ts).
 */
import { DEFAULT_PLAYER_SPEED_MPS } from "@ash-atlas/shared";
import { Container, Sprite, type Texture } from "pixi.js";
import sheets from "../assets/player-rig/jacketb/jacketb-sheets.json";
import { JacketGatherLayer, placeFrame, type JacketGatherInput } from "./jacketGather.js";
import {
  frontIdleAtMs, JacketSwordLayer, markSwordSwing, preloadJacketSwordSheets, swordAimSide, swordOut, type JacketSwordInput,
  type SwordSwingMark
} from "./jacketSword.js";
import { stockBaseClips, type StockArmourId } from "./stockArmour.js";
import type { SwordStyle } from "./swordStyles.js";

type JacketRigMode = "sheets" | "live" | "off";
export const JACKET_RIG_MODE: JacketRigMode = (() => {
  try {
    const value = new URLSearchParams(globalThis.location?.search ?? "").get("jacketRig");
    if (value === "0" || value === "off") return "off";
    if (value === "live" && import.meta.env.DEV) return "live";
  } catch {
    // no location (tests): default
  }
  return "sheets";
})();
export const JACKET_RIG_ENABLED = JACKET_RIG_MODE !== "off";

type ClipId = "idle" | "walkL" | "walkR" | "standL" | "standR";
type SheetClip = {
  flip: boolean;
  frameWidth: number;
  frameHeight: number;
  rootX: number;
  rootY: number;
  pages: string[];
  frames: [number, number, number][];
};
const SHEETS = sheets as unknown as {
  fps: number;
  figureHeightPx: number;
  footBelowRootPx: number;
  clips: Record<ClipId, SheetClip>;
};

/**
 * The old drawn body's visible head-to-feet height per unit of baseHeightPx * overallScale (measured side by side in
 * the feature runtime, 2026-10-20: 75 vs 60 device px at the same zoom), so the jacket player stands as tall.
 */
const HEIGHT_MATCH = 1.25;
/** Displacement (m) a position direction sample needs (remote players, tap moves): the render jitter floor. */
const DIRECTION_SAMPLE_M = 0.04;
/**
 * Owner 2026-10-20: the stance flips the moment the horizontal direction crosses the middle, no hold. Only a near
 * vertical move (|x| share under this, the stick noise floor) keeps the last side.
 */
const FACING_SIDE_SHARE = 0.04;
/**
 * Leaving that near-vertical deadzone needs this share (audit 2026-10-20): a thumb wobbling around straight down
 * must not flip the side back and forth. Outside the deadzone, crossing the middle still flips at once.
 */
const FACING_SIDE_LEAVE_SHARE = 0.06;
/** Remote players' screen-direction share is low-passed with this weight per sample (position noise). */
const REMOTE_SHARE_SMOOTH = 0.5;
/** After stopping, the turned stance stands this long before the straight-front idle (owner 2026-10-20). */
const STAND_TURNED_MS = 5000;
const METERS_PER_DEGREE = 111_320;
/** Walk playback follows speed in this range (1 = DEFAULT_PLAYER_SPEED_MPS). */
const WALK_RATE_MIN = 0.6;
const WALK_RATE_MAX = 1.6;
/** Walk rate low-pass time constant (s): position samples jitter, the stride rate should not. */
const WALK_RATE_SMOOTH_S = 0.25;
/**
 * A walk that resumes within this long of stopping keeps its stride phase: a one-frame stop/start flicker of the walk
 * detector (or a quick re-press) must not snap the legs back to the first frame.
 */
const WALK_RESUME_MS = 300;

export type JacketRigFrame = {
  /** The interpolated render position (lat/lon or interior equivalents). */
  readonly lat: number;
  readonly lon: number;
  /** Whether the player walks this frame (the existing walk detector, with its stop hysteresis). */
  readonly walking: boolean;
  /** Animation clock (ms): hitstop holds it like the old walk cycle. */
  readonly nowMs: number;
  /** Map bearing (deg) so screen left/right follows a rotated map. */
  readonly bearingDeg: number;
  /** Visible height of the old body in the parent's units (baseHeightPx * overallScale). */
  readonly targetHeight: number;
  /** Local player only: held move input x (screen, unit vector), or null (remote players, no input held). */
  readonly inputX?: number | null;
  /** Gathering or flag building (turned L/R clips only; the front idle timer waits until it ends). */
  readonly gather?: JacketGatherInput | null;
  /** An action-combat sword swing in progress (the combo clip for its step), or null. */
  readonly sword?: JacketSwordInput | null;
  /**
   * The held sword-family weapon's art, or null: drawn in hand on the ready stand and the sword walk, and the sword
   * sheets load and stay warm before the first swing.
   */
  readonly heldSword?: Texture | null;
  /** Local player only: attack input held (touch attack stick, right mouse, pad aim stick); else false / absent. */
  readonly attackHeld?: boolean;
  /** Local player only: the held attack aim's screen x (unit vector), or null (no direction held / remote). */
  readonly attackAimX?: number | null;
  /** The player's sword style (swordStyleFor): which combo and ready stand a held sword draws; absent = generic. */
  readonly swordStyle?: SwordStyle;
  /** The stock chest armour shown (stockArmourForAppearance), or null / absent for the bare tank top. */
  readonly armour?: StockArmourId | null;
  /** Downed: the rig hides and the old body shows its downed pose (until a downed clip exists). */
  readonly downed?: boolean;
};

export interface JacketRig {
  readonly root: Container;
  readonly ready: boolean;
  /** While a gathering clip shows: where its impacts land (rig root units = the player renderer's root), else null. */
  readonly gatherImpactPoint?: Readonly<{ x: number; y: number }> | null;
  /** The flag plant clip shows: it owns the flag impacts (the drawn body's work loop must count none). */
  readonly flagPlanting?: boolean;
  /** True once per plant, on the frame the plant clip drives the flag into the ground. */
  takeFlagPlantImpact?(): boolean;
  update(frame: JacketRigFrame): void;
  destroy(): void;
}

/** Dev builds only: live rigs, for browser inspection and perf probes (`window.__jacketRigs`). */
const DEV_RIGS: Set<JacketRig> | null = import.meta.env.DEV ? new Set() : null;
if (DEV_RIGS) (globalThis as { __jacketRigs?: Set<JacketRig> }).__jacketRigs = DEV_RIGS;

/**
 * Facing: the local player's held input decides on the frame its horizontal sign changes; otherwise (remote players,
 * tap moves) the screen direction of the render position. Near-vertical moves keep the last side. Also the walk rate.
 */
export class JacketFacing {
  facing: "L" | "R" = "L";
  /** Inside the near-vertical deadzone: leaving it needs FACING_SIDE_LEAVE_SHARE. */
  private inDeadzone = false;
  private remoteShare = 0;
  walkRate = 1;
  private walkRateFresh = true;
  private anchorLat = Number.NaN;
  private anchorLon = Number.NaN;
  private anchorMs = 0;

  observe(frame: JacketRigFrame): void {
    const inputX = frame.inputX ?? null;
    if (inputX !== null) this.side(inputX);
    if (!Number.isFinite(this.anchorLat) || !frame.walking) {
      // Standing: re-anchor so the next walk measures from where it starts.
      if (!frame.walking) this.walkRateFresh = true;
      this.anchorLat = frame.lat;
      this.anchorLon = frame.lon;
      this.anchorMs = frame.nowMs;
      return;
    }
    const north = (frame.lat - this.anchorLat) * METERS_PER_DEGREE;
    const east = (frame.lon - this.anchorLon) * METERS_PER_DEGREE * Math.cos(frame.lat * Math.PI / 180);
    const distance = Math.hypot(east, north);
    if (distance < DIRECTION_SAMPLE_M) return;
    const elapsed = Math.max(1, frame.nowMs - this.anchorMs);
    const rate = Math.min(WALK_RATE_MAX, Math.max(WALK_RATE_MIN, (distance * 1000 / elapsed) / DEFAULT_PLAYER_SPEED_MPS));
    // First sample of a walk takes the rate as is; later ones ease toward it.
    const k = this.walkRateFresh ? 1 : 1 - Math.exp(-(elapsed / 1000) / WALK_RATE_SMOOTH_S);
    this.walkRate += (rate - this.walkRate) * k;
    this.walkRateFresh = false;
    this.anchorLat = frame.lat;
    this.anchorLon = frame.lon;
    this.anchorMs = frame.nowMs;
    if (inputX !== null) return;
    const bearing = frame.bearingDeg * Math.PI / 180;
    const share = (east * Math.cos(bearing) - north * Math.sin(bearing)) / distance;
    // A sign change passes at once (crossing the middle flips); same-sign samples are smoothed against noise.
    this.remoteShare = Math.sign(share) !== Math.sign(this.remoteShare) ? share : this.remoteShare + (share - this.remoteShare) * REMOTE_SHARE_SMOOTH;
    this.side(this.remoteShare);
  }

  /** Side from a horizontal share (unit x): instant flip across the middle, hysteresis only at the deadzone edge. */
  private side(x: number): void {
    const magnitude = Math.abs(x);
    if (magnitude < FACING_SIDE_SHARE) {
      this.inDeadzone = true;
      return;
    }
    if (this.inDeadzone && magnitude <= FACING_SIDE_LEAVE_SHARE) return;
    this.inDeadzone = false;
    this.facing = x > 0 ? "R" : "L";
  }
}

type BaseClip = { clip: SheetClip; textures: Texture[]; layer?: { clip: SheetClip; textures: Texture[] } };
/** The stock body's base clips, with the armour's layer when one is worn (none for the tank top); null until ready. */
function stockBase(armour: StockArmourId | null): Record<ClipId, BaseClip> | null {
  const clips = stockBaseClips(armour);
  if (!clips) return null;
  const out = {} as Record<ClipId, BaseClip>;
  for (const id of Object.keys(clips) as ClipId[]) {
    const c = clips[id];
    out[id] = c.layer && c.layerView
      ? { clip: c.bodyView, textures: c.body, layer: { clip: c.layerView, textures: c.layer } }
      : { clip: c.bodyView, textures: c.body };
  }
  return out;
}

/** One player's sheet sprite (stock body + armour layer): a Container placed in the player artwork, feet at its origin. */
export class JacketSheetRig implements JacketRig {
  readonly root = new Container({ label: "JacketPlayerRig" });
  private readonly sprite = new Sprite();
  /** The stock armour's garment layer, over the stock body in `sprite` (hidden for the tank top). */
  private readonly layerSprite = new Sprite();
  /** This frame's base clips are on the GPU (the stock body's, + the armour layer's when one is worn). */
  private baseReady = false;
  private armour: StockArmourId | null = null;
  private readonly facing = new JacketFacing();
  private readonly gatherLayer = new JacketGatherLayer();
  private readonly swordLayer = new JacketSwordLayer();
  private swordShown = false;
  /** The ready stand / sword walk drew this frame. */
  private heldShown = false;
  private clipId: ClipId | null = null;
  private clipTimeS = 0;
  private walkTimeS = 0;
  /** When the player last walked (ms, animation clock); -inf = never, so a fresh spawn stands front. */
  private lastWalkMs = Number.NEGATIVE_INFINITY;
  private lastMs = -1;
  /** Animation clock of the last frame that showed a walk clip. */
  private lastWalkFrameMs = Number.NEGATIVE_INFINITY;
  private destroyed = false;
  private gatherShown = false;
  private downed = false;
  /** Dev inspection: the last frame's sword inputs. */
  private lastSwordHeld = false;
  private lastSword: JacketSwordInput | null = null;
  /** The last sword swing seen (sword out during it and 2 s after; its aim side wins over the walk direction). */
  private swingMark: SwordSwingMark | null = null;
  /** The sword was out on the last frame. */
  private lastSwordOut = false;

  constructor() {
    this.root.visible = false;
    this.root.addChild(this.gatherLayer.back, this.swordLayer.back, this.sprite, this.layerSprite, this.swordLayer.front, this.gatherLayer.front);
    this.layerSprite.visible = false;
    DEV_RIGS?.add(this);
  }

  get gatherImpactPoint(): Readonly<{ x: number; y: number }> | null {
    return this.gatherShown && this.gatherLayer.impactValid ? this.gatherLayer.impactPoint : null;
  }

  get flagPlanting(): boolean {
    return this.gatherShown && this.gatherLayer.planting;
  }

  takeFlagPlantImpact(): boolean {
    return this.gatherLayer.takePlantImpact();
  }

  /** True once the sprite draws (sheets loaded); until then the caller keeps the old body visible. */
  get ready(): boolean {
    return this.baseReady && !this.destroyed && !this.downed && (this.clipId !== null || this.gatherShown || this.swordShown);
  }

  update(frame: JacketRigFrame): void {
    if (this.destroyed) return;
    const heldSword = frame.heldSword ?? null;
    this.lastSwordHeld = heldSword !== null;
    this.lastSword = frame.sword ?? null;
    this.heldShown = false;
    const armour = frame.armour ?? null;
    const swordStyle = frame.swordStyle ?? "generic";
    if (heldSword) preloadJacketSwordSheets(frame.nowMs, armour, swordStyle);
    this.armour = armour;
    // Only the sheets this look needs: the stock body, + the armour's layer when one is worn.
    const loaded = stockBase(armour);
    this.baseReady = loaded !== null;
    this.layerSprite.visible = false;
    if (!loaded) {
      this.root.visible = false;
      return;
    }
    // Downed: hidden, the old body shows its downed pose (audit H2).
    this.downed = frame.downed === true;
    if (this.downed) {
      this.root.visible = false;
      return;
    }
    this.facing.observe(frame);
    if (!heldSword) this.swingMark = null;
    const swordInput = frame.sword ?? null;
    if (heldSword && swordInput) this.swingMark = markSwordSwing(this.swingMark, swordInput);
    const out = heldSword !== null && swordOut(this.swingMark, frame.nowMs);
    this.lastSwordOut = out;
    // Owner 2026-10-20: the attack aim wins over the walk direction during the swing (to the end of its
    // follow-through) and while attack input is held; after that the movement decides at once even with the sword
    // still out (the sword walk / ready stand face the move), and standing still keeps the last attack side.
    const aimSide = heldSword !== null
      ? swordAimSide(this.swingMark, frame.nowMs, frame.attackHeld === true, frame.attackAimX ?? null)
      : null;
    if (aimSide) this.facing.facing = aimSide;
    const dt = this.lastMs < 0 ? 0 : Math.min(0.1, Math.max(0, (frame.nowMs - this.lastMs) / 1000));
    this.lastMs = frame.nowMs;
    const gather = frame.gather ?? null;
    // Owner 2026-10-20: gathering / building is turned L/R only, and the 5 s front-idle timer starts when it ends.
    const moving = frame.walking || (frame.inputX ?? null) !== null || gather !== null;
    if (moving) this.lastWalkMs = frame.nowMs;
    const scale = frame.targetHeight * HEIGHT_MATCH / SHEETS.figureHeightPx;
    const sword = gather ? null : frame.sword ?? null;
    if (sword) {
      // A held move ends the swing clip after the follow-through like a walk does (the ready frames then face the move).
      if (this.swordLayer.apply(sword, frame.nowMs, frame.walking || (frame.inputX ?? null) !== null, this.sprite, scale, SHEETS.footBelowRootPx, armour)) {
        // Faces the target; the turned stand follows the swing (the 5 s front-idle timer restarts).
        this.facing.facing = sword.side === "right" ? "R" : "L";
        this.lastWalkMs = frame.nowMs;
        this.gatherLayer.hide();
        this.clipId = null;
        this.swordShown = true;
        this.root.visible = true;
        return;
      }
    }
    this.swordLayer.hide();
    if (this.swordShown) {
      this.swordShown = false;
      this.clipTimeS = 0;
    }
    if (gather && !frame.walking) {
      // Stand facing the worked object afterwards too.
      this.facing.facing = gather.action.side === "right" ? "R" : "L";
      if (this.gatherLayer.apply(gather, frame.nowMs, this.sprite, scale, SHEETS.footBelowRootPx, armour, this.layerSprite)) {
        this.clipId = null;
        this.gatherShown = true;
        this.root.visible = true;
        return;
      }
    }
    this.gatherLayer.hide();
    if (this.gatherShown) {
      this.gatherShown = false;
      this.clipTimeS = 0;
    }
    const side = this.facing.facing;
    const clipId: ClipId = frame.walking
      ? (side === "R" ? "walkR" : "walkL")
      : frame.nowMs < frontIdleAtMs(this.lastWalkMs, STAND_TURNED_MS, heldSword ? this.swingMark : null)
        ? (side === "R" ? "standR" : "standL")
        : "idle";
    if (clipId !== this.clipId) {
      // L <-> R keeps the stride phase; starting a walk or going idle starts the clip over.
      const walkToWalk = clipId.startsWith("walk") && this.clipId !== null &&
        (this.clipId.startsWith("walk") || frame.nowMs - this.lastWalkFrameMs <= WALK_RESUME_MS);
      const standToStand = clipId.startsWith("stand") && this.clipId !== null && this.clipId.startsWith("stand");
      // A stand L <-> R (turning in place) keeps its breath phase too.
      this.clipTimeS = walkToWalk ? this.walkTimeS : standToStand ? this.clipTimeS : 0;
      this.clipId = clipId;
    } else {
      this.clipTimeS += dt * (frame.walking ? this.facing.walkRate : 1);
    }
    if (frame.walking) {
      this.walkTimeS = this.clipTimeS;
      this.lastWalkFrameMs = frame.nowMs;
    }
    const { clip, textures, layer } = loaded[clipId];
    // 30 fps held frames: frame k shows from k/30 s until (k+1)/30 s.
    const frameIndex = Math.floor(this.clipTimeS * SHEETS.fps + 1e-6);
    const index = frameIndex % textures.length;
    if (heldSword && out && clipId !== "idle" &&
      this.swordLayer.applyHeld(frame.walking ? "walk" : "stand", side, frameIndex, heldSword, frame.nowMs, this.sprite, scale, SHEETS.footBelowRootPx, armour, this.layerSprite, swordStyle)) {
      this.heldShown = true;
      this.root.visible = true;
      return;
    }
    if (heldSword && !out) this.swordLayer.applyBack(clipId, index, clip.flip, heldSword, scale, SHEETS.footBelowRootPx, swordStyle);
    else this.swordLayer.hide();
    if (heldSword && !out) this.heldShown = true;
    const sprite = this.sprite;
    const texture = textures[index]!;
    if (sprite.texture !== texture) sprite.texture = texture;
    sprite.anchor.set(clip.rootX / clip.frameWidth, clip.rootY / clip.frameHeight);
    sprite.scale.set(clip.flip ? -scale : scale, scale);
    // Feet (the front idle foot line) on the origin.
    sprite.position.set(0, -SHEETS.footBelowRootPx * scale);
    if (layer) placeFrame(this.layerSprite, layer.textures[index]!, layer.clip, clip.flip ? -scale : scale, scale, SHEETS.footBelowRootPx);
    this.layerSprite.visible = layer !== undefined;
    this.root.visible = true;
  }

  /** Dev inspection: the clip on screen. */
  get debugState(): {
    view: ClipId | null; armour: StockArmourId | null; layer: boolean; facing: string; walkRate: number; frame: number; gather: string | null;
    downed: boolean; swordHeld: boolean; swing: { comboIndex: number; startedAtMs: number } | null; sampleMs: number;
    sword: string | null; swordOut: boolean;
  } {
    const base = stockBase(this.armour);
    const textures = this.clipId && base ? base[this.clipId].textures : null;
    const swing = this.lastSword;
    return {
      view: this.clipId, armour: this.armour, layer: this.layerSprite.visible, facing: this.facing.facing, walkRate: this.facing.walkRate,
      frame: textures ? textures.indexOf(this.sprite.texture) : -1, gather: this.gatherShown ? this.gatherLayer.debug : this.swordShown ? this.swordLayer.debug : null,
      downed: this.downed, swordHeld: this.lastSwordHeld,
      swing: swing ? { comboIndex: swing.comboIndex, startedAtMs: swing.startedAtMs } : null, sampleMs: this.lastMs,
      sword: this.swordShown || this.heldShown ? this.swordLayer.debug : null,
      swordOut: this.lastSwordOut
    };
  }

  destroy(): void {
    DEV_RIGS?.delete(this);
    this.destroyed = true;
    // root is a child of the player artwork; the owner destroys it with its parent (children: true).
    if (!this.root.destroyed && !this.root.parent) this.root.destroy({ children: true });
  }
}

/** Dev-only live rig, behind `?jacketRig=live`: a holder that fills in when the live module has loaded. */
class JacketLiveHolder implements JacketRig {
  readonly root = new Container({ label: "JacketPlayerRigLive" });
  private inner: (JacketRig & { readonly debugState?: unknown }) | null = null;
  private destroyed = false;

  constructor(seed: string, displayResolution: number) {
    DEV_RIGS?.add(this);
    if (import.meta.env.DEV) {
      void import("./jacketRigLive.js").then(({ JacketPlayerRig }) => {
        if (this.destroyed) return;
        this.inner = new JacketPlayerRig(seed, displayResolution);
        this.root.addChild(this.inner.root);
      });
    }
  }

  get ready(): boolean {
    return this.inner?.ready ?? false;
  }

  get debugState(): unknown {
    return this.inner?.debugState ?? null;
  }

  update(frame: JacketRigFrame): void {
    this.inner?.update(frame);
  }

  destroy(): void {
    DEV_RIGS?.delete(this);
    this.destroyed = true;
    this.inner?.destroy();
    if (!this.root.destroyed && !this.root.parent) this.root.destroy({ children: true });
  }
}

/** The player's Jacket B rig for the current mode, or null when it is off (`?jacketRig=0`). */
export function createJacketRig(seed: string, displayResolution: number): JacketRig | null {
  if (JACKET_RIG_MODE === "off") return null;
  if (JACKET_RIG_MODE === "live") return new JacketLiveHolder(seed, displayResolution);
  return new JacketSheetRig();
}
