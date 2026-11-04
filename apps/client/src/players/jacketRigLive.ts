/*
 * LIVE Jacket B player rig (dev only, `?jacketRig=live`; the default draws the pre-rendered sheets, jacketRig.ts).
 * Kept for runtime work: the strokes cost ~65 ms per pose on desktop (2026-10-20), too slow to ship. Replaces the drawn player body with the approved
 * five-anims Jacket B rigs (2026-10-20). Render only: positions, combat and gathering are untouched.
 *
 * Views (packages/animator/scripts/views/five-anims-jacketb-rigs.sh, clips 01-03):
 * - idle            -> straight front (front-turn00-faceA), idle_weight_shift (breath + blink)
 * - walk, facing L  -> turned 15 deg left (front-turn15-faceA), walk_in_place (template light step, 28 f)
 * - walk, facing R  -> image flip of the L15 rig built with mirrored inputs (front-turn15-faceA-mirin),
 *                      exactly as the evidence renders clip 02
 * Straight down/up keep the last horizontal facing (the back views are parked).
 * Playback is 30 fps held frames (the rigs' clip fps; AnimationState.heldFrames).
 */
import {
  AnimationState,
  AnimationStateData,
  atlasPackSchema,
  loadAnimDocument,
  Skeleton,
  type AnimDocument
} from "@ash-atlas/animator/core";
import {
  AnimatorCharacter,
  DynamicAtlas,
  loadRgbaImage,
  packedAtlasImages,
  type PartImageProvider,
  type RgbaImage
} from "@ash-atlas/animator/pixi";
import { DEFAULT_PLAYER_SPEED_MPS } from "@ash-atlas/shared";
import { Container } from "pixi.js";
import frontAnimUrl from "../../../../packages/animator/rigs/jacketb/front-turn00-faceA.anim.json?url";
import frontAtlasUrl from "../../../../packages/animator/rigs/jacketb/front-turn00-faceA.atlas.json?url";
import frontPngUrl from "../../../../packages/animator/rigs/jacketb/front-turn00-faceA.atlas.png?url";
import turnLAnimUrl from "../../../../packages/animator/rigs/jacketb/front-turn15-faceA.anim.json?url";
import turnLAtlasUrl from "../../../../packages/animator/rigs/jacketb/front-turn15-faceA.atlas.json?url";
import turnLPngUrl from "../../../../packages/animator/rigs/jacketb/front-turn15-faceA.atlas.png?url";
import turnRAnimUrl from "../../../../packages/animator/rigs/jacketb/front-turn15-faceA-mirin.anim.json?url";
import turnRAtlasUrl from "../../../../packages/animator/rigs/jacketb/front-turn15-faceA-mirin.atlas.json?url";
import turnRPngUrl from "../../../../packages/animator/rigs/jacketb/front-turn15-faceA-mirin.atlas.png?url";

type RigViewId = "front" | "turnL" | "turnR";
const IDLE_CLIP = "idle_weight_shift";
const WALK_CLIP = "walk_in_place";

const RIG_SOURCES: Record<RigViewId, { anim: string; atlas: string; png: string; flip: boolean }> = {
  front: { anim: frontAnimUrl, atlas: frontAtlasUrl, png: frontPngUrl, flip: false },
  turnL: { anim: turnLAnimUrl, atlas: turnLAtlasUrl, png: turnLPngUrl, flip: false },
  turnR: { anim: turnRAnimUrl, atlas: turnRAtlasUrl, png: turnRPngUrl, flip: true }
};

/** Atlas page pixels per rig canvas pixel: the figure is ~1150 canvas px tall, ~290 px in the atlas. */
const ATLAS_SCALE = 0.25;
/** Displacement (m) a direction sample needs, so render jitter never turns the player. */
const DIRECTION_SAMPLE_M = 0.12;
/** A new facing must hold this long before the view swaps (joystick wobble). */
const FACING_HOLD_MS = 90;
/** |screen x| share of the move needed to pick a side; below it (straight up/down) the facing stays. */
const FACING_SIDE_SHARE = 0.38;
/** Within this long of a walk starting, a new side applies at once (a fresh press is never wobble). */
const WALK_START_TURN_MS = 250;
const METERS_PER_DEGREE = 111_320;
/** Walk playback follows speed in this range (1 = DEFAULT_PLAYER_SPEED_MPS). */
const WALK_RATE_MIN = 0.6;
const WALK_RATE_MAX = 1.6;

type RigAsset = {
  readonly doc: AnimDocument;
  readonly data: AnimationStateData;
  readonly images: PartImageProvider;
  readonly atlas: DynamicAtlas;
  readonly flip: boolean;
};

type RigAssets = {
  readonly views: Record<RigViewId, RigAsset>;
  /** Front idle setup-pose figure: height and lowest point (feet), skeleton units. */
  figureHeight: number;
  figureBottom: number;
};

/** Dev builds only: live rigs, for browser inspection and perf probes (`window.__jacketRigs`). */

let assetsPromise: Promise<RigAssets> | null = null;
let loadedAssets: RigAssets | null = null;
let loadFailed = false;

async function loadRigAsset(source: (typeof RIG_SOURCES)[RigViewId]): Promise<RigAsset> {
  const [docJson, packJson, page] = await Promise.all([
    fetch(source.anim).then((response) => {
      if (!response.ok) throw new Error(`jacket rig ${source.anim}: ${response.status}`);
      return response.json() as Promise<unknown>;
    }),
    fetch(source.atlas).then((response) => {
      if (!response.ok) throw new Error(`jacket rig ${source.atlas}: ${response.status}`);
      return response.json() as Promise<unknown>;
    }),
    loadRgbaImage(source.png)
  ]);
  const doc = loadAnimDocument(docJson);
  const pack = atlasPackSchema.parse(packJson);
  // Hashed bundle URLs: the page is supplied by our import, whatever file name the manifest gives.
  const pages = new Map<string, RgbaImage>(pack.pages.map((entry) => [entry.file, page]));
  return {
    doc,
    data: new AnimationStateData(doc),
    images: packedAtlasImages(pack, pages),
    atlas: new DynamicAtlas({ pageSize: 1024, scale: ATLAS_SCALE, budgetPages: 1, maxPages: 2 }),
    flip: source.flip
  };
}

/** Starts (once) loading the three rigs; resolves to the shared assets. */
export function loadJacketRigAssets(): Promise<RigAssets> {
  if (!assetsPromise) {
    assetsPromise = (async () => {
      const [front, turnL, turnR] = await Promise.all([
        loadRigAsset(RIG_SOURCES.front),
        loadRigAsset(RIG_SOURCES.turnL),
        loadRigAsset(RIG_SOURCES.turnR)
      ]);
      const assets: RigAssets = { views: { front, turnL, turnR }, figureHeight: 1, figureBottom: 0 };
      // Measure the front idle setup pose once: the scale and the foot anchor for every view.
      const probe = createCharacter(front, 0);
      probe.character.step(probe.state, 0);
      const bounds = probe.character.getLocalBounds();
      assets.figureHeight = Math.max(1, bounds.maxY - bounds.minY);
      assets.figureBottom = bounds.maxY;
      probe.character.destroy({ children: true });
      loadedAssets = assets;
      return assets;
    })();
    assetsPromise.catch((error: unknown) => {
      loadFailed = true;
      console.warn("[jacket-rig] rig assets failed to load; keeping the drawn player body", error);
    });
  }
  return assetsPromise;
}

function createCharacter(asset: RigAsset, seed: number | string): { character: AnimatorCharacter; state: AnimationState } {
  const skeleton = new Skeleton(asset.doc);
  skeleton.setActiveSkins(["body"]);
  const character = new AnimatorCharacter({ skeleton, atlas: asset.atlas, images: asset.images });
  const state = new AnimationState(asset.data, { phaseSeed: seed });
  state.heldFrames = true;
  return { character, state };
}

type RigView = { character: AnimatorCharacter; state: AnimationState; clip: string | null };

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
};

/**
 * One player's rig: a Container placed in the player artwork (feet at its origin). Only the view on
 * screen is created, posed and drawn; the other views are created the first time they are needed.
 */
export class JacketPlayerRig {
  readonly root = new Container({ label: "JacketPlayerRig" });
  private readonly views: Partial<Record<RigViewId, RigView>> = {};
  private activeView: RigViewId | null = null;
  private facing: "turnL" | "turnR" = "turnL";
  private pendingFacing: "turnL" | "turnR" = "turnL";
  private pendingSinceMs = 0;
  private anchorLat = Number.NaN;
  private anchorLon = Number.NaN;
  private anchorMs = 0;
  private walkRate = 1;
  private lastMs = -1;
  private walkStartMs = Number.NaN;
  private destroyed = false;

  constructor(private readonly seed: string, private readonly displayResolution: number) {
    this.root.visible = false;
    void loadJacketRigAssets().catch(() => undefined);
  }

  /** True once the rig draws (assets loaded); until then the caller keeps the old body visible. */
  get ready(): boolean {
    return loadedAssets !== null && !this.destroyed && this.activeView !== null;
  }

  static get failed(): boolean {
    return loadFailed;
  }

  update(frame: JacketRigFrame): void {
    const assets = loadedAssets;
    if (!assets || this.destroyed) return;
    this.observeDirection(frame);
    const viewId: RigViewId = frame.walking ? this.facing : "front";
    const clip = frame.walking ? WALK_CLIP : IDLE_CLIP;
    const view = this.ensureView(assets, viewId);
    if (this.activeView !== viewId) {
      if (this.activeView) {
        const previous = this.views[this.activeView];
        if (previous) previous.character.visible = false;
      }
      view.character.visible = true;
      this.activeView = viewId;
    }
    if (view.clip !== clip) {
      view.state.setAnimation(0, clip);
      view.clip = clip;
    }
    view.state.timeScale = frame.walking ? this.walkRate : 1;
    // Feet on the origin, height matched to the old body.
    const scale = frame.targetHeight / assets.figureHeight;
    view.character.scale.set(assets.views[viewId].flip ? -scale : scale, scale);
    view.character.position.set(0, -assets.figureBottom * scale);
    view.character.displayResolution = this.displayResolution;
    const dt = this.lastMs < 0 ? 0 : Math.min(0.1, Math.max(0, (frame.nowMs - this.lastMs) / 1000));
    this.lastMs = frame.nowMs;
    view.character.step(view.state, dt);
    this.root.visible = true;
  }

  private ensureView(assets: RigAssets, id: RigViewId): RigView {
    let view = this.views[id];
    if (!view) {
      const created = createCharacter(assets.views[id], this.seed);
      created.character.visible = false;
      view = { ...created, clip: null };
      this.views[id] = view;
      this.root.addChild(created.character);
    }
    return view;
  }

  /** Facing from accumulated screen-space displacement, with a size gate and a hold time. */
  private observeDirection(frame: JacketRigFrame): void {
    if (!Number.isFinite(this.anchorLat)) {
      this.anchorLat = frame.lat;
      this.anchorLon = frame.lon;
      this.anchorMs = frame.nowMs;
      return;
    }
    const north = (frame.lat - this.anchorLat) * METERS_PER_DEGREE;
    const east = (frame.lon - this.anchorLon) * METERS_PER_DEGREE * Math.cos(frame.lat * Math.PI / 180);
    const distance = Math.hypot(east, north);
    if (!frame.walking) {
      // Standing: re-anchor so the next walk measures from where it starts.
      this.anchorLat = frame.lat;
      this.anchorLon = frame.lon;
      this.anchorMs = frame.nowMs;
      this.pendingFacing = this.facing;
      this.walkStartMs = Number.NaN;
      return;
    }
    if (!Number.isFinite(this.walkStartMs)) this.walkStartMs = frame.nowMs;
    if (distance < DIRECTION_SAMPLE_M) return;
    const elapsed = Math.max(1, frame.nowMs - this.anchorMs);
    const rate = (distance * 1000 / elapsed) / DEFAULT_PLAYER_SPEED_MPS;
    this.walkRate = Math.min(WALK_RATE_MAX, Math.max(WALK_RATE_MIN, rate));
    const bearing = frame.bearingDeg * Math.PI / 180;
    const screenX = east * Math.cos(bearing) - north * Math.sin(bearing);
    this.anchorLat = frame.lat;
    this.anchorLon = frame.lon;
    this.anchorMs = frame.nowMs;
    const share = screenX / distance;
    const candidate = share > FACING_SIDE_SHARE ? "turnR" : share < -FACING_SIDE_SHARE ? "turnL" : this.facing;
    if (candidate === this.facing) {
      this.pendingFacing = candidate;
      return;
    }
    if (candidate !== this.pendingFacing) {
      this.pendingFacing = candidate;
      this.pendingSinceMs = frame.nowMs;
      // The first step of a walk from standing turns at once (no visible lag on a fresh press).
      if (frame.nowMs - this.walkStartMs < WALK_START_TURN_MS) this.facing = candidate;
      return;
    }
    if (frame.nowMs - this.pendingSinceMs >= FACING_HOLD_MS) this.facing = candidate;
  }

  /** Dev inspection: the view on screen and its clip. */
  get debugState(): { view: RigViewId | null; clip: string | null; facing: string; walkRate: number } {
    const view = this.activeView ? this.views[this.activeView] : undefined;
    return { view: this.activeView, clip: view?.clip ?? null, facing: this.facing, walkRate: this.walkRate };
  }

  destroy(): void {
    this.destroyed = true;
    // The views are children of root; the owner destroys root with its parent (children: true).
    if (!this.root.destroyed && !this.root.parent) this.root.destroy({ children: true });
  }
}
