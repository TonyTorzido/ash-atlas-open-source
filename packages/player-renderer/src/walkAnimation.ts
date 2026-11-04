import { MeshPlane, type Texture } from "pixi.js";

/**
 * Procedural walk-cycle tuning. All distances are in visualRoot layer units
 * (the same space as the anchor coordinates; one unit is about 1.3 screen px
 * at the default body scale and 60 px player height).
 */
export const WALK_TUNING = {
  /** Full stride cycles (two steps) per second at speedFactor 1: about 2 steps/s. */
  strideHz: 1,
  /** Time to blend the walk cycle in or out so it never pops. */
  easeMs: 120,
  /** Peak lift of a stepping sole. */
  liftUnits: 1.6,
  /** Peak body rise at mid-step; the soles are compensated so feet stay planted. */
  bobUnits: 0.7,
  /** Peak held-weapon rotation about the hand anchor. */
  swayDegrees: 3,
  /** Where the leg deformation starts, as a fraction from the legs anchor to the foot anchors. */
  hipRampStart: 0.3,
  /** Half width of the left/right blend across the crotch. */
  sideBlendUnits: 4,
  /** Frame gaps longer than this (tab switch, hitch) are clamped. */
  maxFrameMs: 100,
  /** Leg mesh grid; 8 x 12 = 96 vertices keeps Pixi's batched-mesh path (<= 100). */
  gridX: 8,
  gridY: 12,
  /** Hand-layer sway strength by combat pose (yields to attack poses). */
  swayPoseWeight: { idle: 1, combat_ready: 0.5 } as Readonly<Record<string, number>>
} as const;

export type LegDeformParams = {
  /** Lift of the left (negative x) / right (positive x) sole, layer units, >= 0. */
  liftLeft: number;
  liftRight: number;
  /** Downward compensation applied with the same weight as the lift (the bob). */
  compensation: number;
  hipY: number;
  groundY: number;
  centerX: number;
  sideBlendUnits: number;
};

type AnchorLike = { x: number; y: number; set(x: number, y?: number): void };

/**
 * A MeshPlane that quacks like a Sprite for the appearance code (anchor,
 * position, scale, tint, texture) but can be deformed around the legs.
 */
export class LegMesh extends MeshPlane {
  readonly anchor: AnchorLike;
  readonly rest: Float32Array;
  deformed = false;

  /** Tells Pixi the vertices changed (re-batch and re-bound). */
  geometryChanged(): void {
    this.geometry.getBuffer("aPosition").update();
    this.onViewUpdate();
  }

  constructor(texture: Texture) {
    super({
      texture,
      verticesX: WALK_TUNING.gridX,
      verticesY: WALK_TUNING.gridY
    });
    // The rest vertices must stay valid; never rebuild on texture updates.
    this.autoResize = false;
    this.rest = Float32Array.from(this.geometry.positions);
    const mesh = this;
    this.anchor = {
      x: 0,
      y: 0,
      set(x: number, y: number = x): void {
        this.x = x;
        this.y = y;
        mesh.pivot.set(x * mesh.texture.width, y * mesh.texture.height);
      }
    };
  }
}

/** 0 at the hip line, 1 at the ground, smooth in between. */
export function legWeight(y: number, hipY: number, groundY: number): number {
  const span = groundY - hipY;
  if (!(span > 0)) return 0;
  const t = (y - hipY) / span;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** Lift of the left foot at the given phase; the right foot is up in the other half-cycle. */
export function strideLeft(phase: number): number {
  const s = Math.sin(phase);
  return s > 0 ? s : 0;
}

export function strideRight(phase: number): number {
  const s = Math.sin(phase);
  return s < 0 ? -s : 0;
}

/** 0 at both foot plants, 1 mid-step; twice per stride cycle. */
export function strideBob(phase: number): number {
  return Math.abs(Math.sin(phase));
}

export function restoreLegMesh(mesh: LegMesh): void {
  if (!mesh.deformed) return;
  mesh.geometry.positions.set(mesh.rest);
  mesh.deformed = false;
  mesh.geometryChanged();
}

/**
 * Writes the deformed vertices of one leg-covering mesh. No allocation.
 * Meshes that are rotated (not part of the normal layering) stay at rest.
 */
export function deformLegMesh(mesh: LegMesh, p: LegDeformParams): void {
  const scaleX = mesh.scale.x;
  const scaleY = mesh.scale.y;
  if (mesh.rotation !== 0 || scaleY === 0 || !mesh.visible) {
    restoreLegMesh(mesh);
    return;
  }
  const rest = mesh.rest;
  const out = mesh.geometry.positions;
  const px = mesh.position.x - scaleX * mesh.pivot.x;
  const py = mesh.position.y - scaleY * mesh.pivot.y;
  const blend = p.sideBlendUnits > 0 ? p.sideBlendUnits : 1;
  for (let i = 0; i < rest.length; i += 2) {
    const vx = rest[i]!;
    const vy = rest[i + 1]!;
    const weight = legWeight(py + scaleY * vy, p.hipY, p.groundY);
    if (weight === 0) {
      out[i] = vx;
      out[i + 1] = vy;
      continue;
    }
    let side = (px + scaleX * vx - p.centerX) / blend;
    side = side < -1 ? -1 : side > 1 ? 1 : side;
    const lift = p.liftLeft * (1 - side) * 0.5 + p.liftRight * (1 + side) * 0.5;
    out[i] = vx;
    out[i + 1] = vy + weight * (p.compensation - lift) / scaleY;
  }
  mesh.deformed = true;
  mesh.geometryChanged();
}
