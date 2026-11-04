/*
 * Jacket B gathering + flag building (2026-10-20, docs/plans/player-gather-anims.md): the body clips pre-rendered by
 * scripts/copy-jacket-gather.mjs (L15 turned view and the mirrored-input R view drawn image-flipped, never the
 * straight front), with the in-game item (tool texture from the player renderer, the Soft Flag art) drawn on the
 * exported per-frame grip transform, behind or in front of the body.
 *
 * Timing: the clip is sampled on the clock the player renderer counts impacts on (nowMs - action.startedAtMs), time
 * warped so the program's impact lands on the clip's contact frame (the particles and the node reaction line up;
 * the bare-hand programs and the reduced-motion cadence reuse the same clips).
 * Flag: flag_work loops until 1 s before the build completes, then flag_plant plays its 1 s; the flag stays held
 * (never set down) until the plant frame.
 * Sheets load lazily per clip and side, the first time that action plays.
 * Owner 2026-10-21: the body is always the stock body's gather clip (the tank top), with the stock armour's gather
 * layer over it when one is worn (stockArmour.ts); the Jacket B gather sheets are no longer drawn. Their manifest
 * still gives the clip timing and the item transforms (the same skeleton and bone clips).
 */
import {
  FLAG_BUILD_PROGRAM,
  GATHER_PROGRAMS,
  GATHER_TUNING,
  gatherProgramId,
  type FlagBuildArt,
  type GatheringAction,
  type PlayerRenderer
} from "@ash-atlas/player-renderer";
import { Container, Sprite, type Texture } from "pixi.js";
import manifest from "../assets/player-rig/jacketb-gather/jacketb-gather.json";
import type { SheetView } from "./jacketSheets.js";
import { stockClip, type StockArmourId } from "./stockArmour.js";

export type GatherClipId = "chop" | "mine" | "harvest" | "fish_cast" | "fish_hold" | "flag_work" | "flag_plant";
type Side = "L" | "R";
type View = SheetView;
type Clip = { frames: number; loop: boolean; contact: number | null; item: "axe" | "pick" | "pole" | "flag" | null; xf: number[][]; views: Record<Side, View> };
const MANIFEST = manifest as unknown as { scale: number; fps: number; clips: Record<GatherClipId, Clip> };

/** Held item art: grip (normalized art point), canvas px per art px at the art's authored size, mirror on the L view. Same as scripts/jacket-gather-evidence.py. */
const ITEM_ART = {
  // impact = the art point impacts spawn from (the old tools' head tuning, the flag's base)
  axe: { grip: [0.496, 0.648], impact: [0.66, 0.25], k: 0.8, refHeight: 1024, mx: -1 },
  pick: { grip: [0.496, 0.648], impact: [0.74, 0.29], k: 0.8, refHeight: 1024, mx: -1 },
  pole: { grip: [0.4966, 0.5098], impact: [0.4966, 0.03], k: 1.03, refHeight: 1024, mx: -1 },
  flag: { grip: [0.1208, 0.62], impact: [0.1208, 0.977], k: 3.0, refHeight: 320, mx: -1 }
} as const;
/** The plant clip's length: it starts this long before the build completes (owner: "final animation 1 s before"). */
export const FLAG_PLANT_MS = 1000;
/** A plant first shown this many frames after its contact (sheet just loaded) still dusts; later, none. */
const PLANT_IMPACT_LATE_FRAMES = 2;

export type JacketGatherInput = Readonly<{
  action: GatheringAction;
  tool: Texture | null;
  flagArt: FlagBuildArt | null;
  /** Flag builds: ms until the build completes (null = unknown, e.g. remote players: work loop only). */
  flagRemainingMs: number | null;
}>;


type Loaded = { clip: Clip; view: View; textures: Texture[]; layerView: View | null; layer: Texture[] | null };

/**
 * The stock body's gather sheets, plus the armour's gather layer (none for the tank top). The Jacket B gather
 * manifest only supplies the clip timing and the per-frame item transforms (same skeleton and clips).
 */
function load(id: GatherClipId, side: Side, armour: StockArmourId | null): Loaded | null {
  const clip = MANIFEST.clips[id];
  const stock = stockClip(armour, `${id}${side}`);
  if (!stock) return null;
  return { clip, view: stock.bodyView, textures: stock.body, layerView: stock.layerView, layer: stock.layer };
}

/** Program phase t (0..1) -> clip phase with the program's impact on the middle of the clip's contact frame. */
function warp(t: number, impactAt: number | null, clip: Clip): number {
  if (impactAt === null || clip.contact === null) return t;
  const q = (clip.contact + 0.5) / clip.frames;
  return t < impactAt ? (t / impactAt) * q : q + ((t - impactAt) / (1 - impactAt)) * (1 - q);
}

/** The clip and frame to show for an action at nowMs. */
function pick(input: JacketGatherInput, nowMs: number): { id: GatherClipId; frame: number } {
  const { action } = input;
  const elapsed = Math.max(0, nowMs - action.startedAtMs);
  const cadence = action.reducedMotion ? GATHER_TUNING.reducedCadence : 1;
  const fps = MANIFEST.fps;
  if (action.kind === "flag") {
    const remaining = input.flagRemainingMs;
    if (remaining !== null && remaining <= FLAG_PLANT_MS) {
      const clip = MANIFEST.clips.flag_plant;
      return { id: "flag_plant", frame: Math.min(clip.frames, Math.floor(((FLAG_PLANT_MS - Math.max(0, remaining)) / 1000) * fps)) };
    }
    const cycle = FLAG_BUILD_PROGRAM.cycleMs * cadence;
    const clip = MANIFEST.clips.flag_work;
    return { id: "flag_work", frame: Math.floor(warp((elapsed % cycle) / cycle, FLAG_BUILD_PROGRAM.impactAt, clip) * clip.frames) % clip.frames };
  }
  if (action.kind === "fish") {
    const castMs = GATHER_TUNING.fish.castMs;
    if ((action.fishPhase ?? "wait") === "wait" && elapsed < castMs) {
      return { id: "fish_cast", frame: Math.min(MANIFEST.clips.fish_cast.frames, Math.floor((elapsed / 1000) * fps)) };
    }
    return { id: "fish_hold", frame: Math.floor((elapsed / 1000) * fps) % MANIFEST.clips.fish_hold.frames };
  }
  const programId = gatherProgramId(action.kind, action.tool !== null);
  const program = GATHER_PROGRAMS[programId as keyof typeof GATHER_PROGRAMS];
  const id: GatherClipId = action.kind === "chop" ? "chop" : action.kind === "mine" ? "mine" : "harvest";
  const clip = MANIFEST.clips[id];
  const cycle = program.cycleMs * cadence;
  return { id, frame: Math.floor(warp((elapsed % cycle) / cycle, program.impactAt, clip) * clip.frames) % clip.frames };
}

/** One sheet frame on a sprite: anchored at the frame's root, the feet (front idle foot line) on the origin. */
export function placeFrame(sprite: Sprite, texture: Texture, view: View, scaleX: number, scale: number, footBelowRootPx: number): void {
  if (sprite.texture !== texture) sprite.texture = texture;
  sprite.anchor.set(view.rootX / view.frameWidth, view.rootY / view.frameHeight);
  sprite.scale.set(scaleX, scale);
  sprite.position.set(0, -footBelowRootPx * scale);
}

/** The flag plant's impact edge: once per plant, on the frame the clip crosses its contact (the drive into the ground). */
export class FlagPlantImpact {
  /** The last observed frame showed flag_plant. */
  planting = false;
  private pending = false;
  private done = false;

  /** The clip shown this frame (null = none) and its frame (-1 = not drawn, e.g. its sheet is loading). */
  observe(id: GatherClipId | null, frame: number): void {
    this.planting = id === "flag_plant" && frame >= 0;
    if (id !== "flag_plant") {
      this.done = false;
      return;
    }
    const contact = MANIFEST.clips.flag_plant.contact;
    if (frame < 0 || contact === null || this.done || frame < contact) return;
    this.done = true;
    // A plant first drawn well after its contact (its sheet just loaded) gets no late dust.
    if (frame <= contact + PLANT_IMPACT_LATE_FRAMES) this.pending = true;
  }

  /** True once after the contact frame was observed. */
  take(): boolean {
    const pending = this.pending;
    this.pending = false;
    return pending;
  }
}

/** One player's gathering body + held item. */
export class JacketGatherLayer {
  /** Item behind / in front of the body: the caller puts these around its body sprite. */
  readonly back = new Container({ label: "JacketGatherItemBack" });
  readonly front = new Container({ label: "JacketGatherItemFront" });
  private readonly item = new Container({ label: "JacketGatherItem" });
  private readonly itemMain = new Sprite();
  private readonly itemCloth = new Sprite();
  /** Root-space point the current frame's impact spawns from (tool head, flag base, the picking hand); null = none. */
  readonly impactPoint = { x: 0, y: 0 };
  impactValid = false;
  private readonly plant = new FlagPlantImpact();
  /** Dev inspection: clip, side and frame last shown. */
  debug = "";

  constructor() {
    this.item.addChild(this.itemMain, this.itemCloth);
    this.back.addChild(this.item);
  }

  /**
   * Shows the action on `sprite` (the rig's body sprite). Returns false while that clip's sheet is still loading
   * (the caller keeps its own clip for the frame).
   */
  apply(
    input: JacketGatherInput, nowMs: number, sprite: Sprite, scale: number, footBelowRootPx: number,
    armour: StockArmourId | null = null, layerSprite: Sprite | null = null
  ): boolean {
    const side: Side = input.action.side === "right" ? "R" : "L";
    const { id, frame } = pick(input, nowMs);
    this.debug = `${id}${side}:${frame}${armour ? `:${armour}` : ""}`;
    const entry = load(id, side, armour);
    this.plant.observe(id, entry ? frame : -1);
    if (!entry) {
      this.item.visible = false;
      return false;
    }
    const { clip, view, textures, layer, layerView } = entry;
    // A one-shot clip's stock sheets stop one pose short of Jacket B's end pose: both hold their last frame.
    const index = Math.min(frame, textures.length - 1, (layer ?? textures).length - 1);
    const flip = view.flip ? -1 : 1;
    placeFrame(sprite, textures[index]!, view, flip * scale, scale, footBelowRootPx);
    if (layerSprite) {
      layerSprite.visible = layer !== null;
      if (layer && layerView) placeFrame(layerSprite, layer[index]!, layerView, flip * scale, scale, footBelowRootPx);
    }
    this.placeItem(input, clip, Math.min(frame, clip.xf.length - 1), flip, scale, footBelowRootPx, nowMs);
    return true;
  }

  /** The last apply showed flag_plant. */
  get planting(): boolean {
    return this.plant.planting;
  }

  /** True once per plant, on the contact frame (the caller spawns the dust then). */
  takePlantImpact(): boolean {
    return this.plant.take();
  }

  private placeItem(input: JacketGatherInput, clip: Clip, frame: number, flip: number, scale: number, footBelowRootPx: number, nowMs: number): void {
    const art = clip.item ? ITEM_ART[clip.item] : null;
    const main = clip.item === "flag" ? input.flagArt?.pole ?? null : input.tool;
    const [gx, gy, deg, order] = clip.xf[frame]!;
    const px = MANIFEST.scale * scale;
    // Bare hands: impacts at the hand.
    this.impactPoint.x = flip * gx! * px;
    this.impactPoint.y = -footBelowRootPx * scale + gy! * px;
    this.impactValid = true;
    if (!art || !main) {
      this.item.visible = false;
      return;
    }
    let d = deg!;
    const phase = input.action.fishPhase;
    if (clip.item === "pole" && (phase === "bite" || phase === "fight")) {
      // The rod twitches on a bite and tugs in a fight (the old program's rates).
      const f = GATHER_TUNING.fish;
      d += Math.sin((nowMs / 1000) * Math.PI * 2 * (phase === "bite" ? f.biteHz : f.fightHz)) * (phase === "bite" ? f.biteDegrees : f.fightDegrees);
    }
    this.item.position.set(flip * gx! * px, -footBelowRootPx * scale + gy! * px);
    // Canvas direction d (y down) -> the art's up axis; the R view mirrors it like the body.
    const dir = flip < 0 ? 180 - d : d;
    this.item.rotation = ((dir + 90) * Math.PI) / 180;
    const k = (art.k * px * art.refHeight) / main.height;
    const mx = art.mx * flip;
    for (const [sprite, texture, tint] of [
      [this.itemMain, main, 0xffffff],
      [this.itemCloth, clip.item === "flag" ? input.flagArt?.cloth ?? null : null, input.flagArt?.clothTint ?? 0xffffff]
    ] as const) {
      sprite.visible = texture !== null;
      if (!texture) continue;
      if (sprite.texture !== texture) sprite.texture = texture;
      sprite.anchor.set(art.grip[0], art.grip[1]);
      sprite.scale.set(mx * k, k);
      sprite.tint = tint;
    }
    // The impact point: the art's impact point through the item transform.
    const lx = (art.impact[0] - art.grip[0]) * main.width * mx * k;
    const ly = (art.impact[1] - art.grip[1]) * main.height * k;
    const c = Math.cos(this.item.rotation), sn = Math.sin(this.item.rotation);
    this.impactPoint.x = this.item.position.x + c * lx - sn * ly;
    this.impactPoint.y = this.item.position.y + sn * lx + c * ly;
    const parent = order === 1 ? this.front : this.back;
    if (this.item.parent !== parent) parent.addChild(this.item);
    this.item.visible = true;
  }

  hide(): void {
    this.item.visible = false;
    this.impactValid = false;
    this.plant.observe(null, -1);
  }
}

/** Dev/test: the clip and frame an action shows at nowMs. */
export function jacketGatherFrame(input: JacketGatherInput, nowMs: number): { id: GatherClipId; frame: number } {
  return pick(input, nowMs);
}

/** The rig's view of a player renderer's current gathering action (null = none). */
export function jacketGatherInput(renderer: PlayerRenderer, flagCompletesAtMs: number | undefined, nowMs = performance.now()): JacketGatherInput | null {
  const action = renderer.gatheringAction;
  if (!action) return null;
  return {
    action,
    tool: renderer.gatheringToolTexture,
    flagArt: action.kind === "flag" ? renderer.flagBuildArt : null,
    flagRemainingMs: flagCompletesAtMs !== undefined ? flagCompletesAtMs - nowMs : null
  };
}
