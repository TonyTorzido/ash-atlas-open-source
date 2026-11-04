import { Container, MeshPlane, Sprite, Texture } from "pixi.js";

import { sideX, type ArmCutPlacement, type ArmGeometry, type MutablePoint } from "./gatherAnimation.js";

/**
 * The bendable arm shared by every gathering action and flag building.
 *
 * Each arm-covering layer's cut arm piece becomes a mesh posed as a two-joint
 * arm (owner rule: the arm pivots only at the shoulder and bends only at the
 * elbow, at the middle of the arm):
 *
 * - Shoulder: one pivot at the shoulder joint, on the arm's centre line. The
 *   whole arm below it turns rigidly about that point at full width. Only
 *   the short shoulder cap above the joint blends from pinned to the full
 *   turn, so it rolls round the pivot like a ball joint instead of tearing.
 * - Elbow: one bend at the middle of the arm (the drawn elbow, template
 *   v 851), on the centre line. The forearm and fist turn rigidly about it
 *   as one piece; only a thin band of rows at the joint itself blends.
 * - Poses are an upper-arm direction and an elbow bend (no IK), capped by
 *   the ARM_RIG_TUNING limits. Bone lengths never change; the rest pose is
 *   exactly the untouched art.
 *
 * The meshes of both arms live in one group behind the torso layers
 * (a turned arm comes out from under the torso edge). The torso seam outline left by the cut
 * fades in only as the upper arm turns, so the torso shows no extra line at
 * rest. Geometry is in visualRoot layer units; sign +1 is the right arm.
 */
export const ARM_RIG_TUNING = {
  /**
   * The shoulder cap above the joint (fractions of the arm length, negative =
   * above) blends from pinned at blendStart to the full upper-arm turn at
   * blendEnd (the joint). Everything below the joint turns rigidly.
   */
  blendStart: -0.34,
  blendEnd: -0.24,
  /** Elbow joint along the arm: the middle of the drawn arm (template v 851). */
  elbowAt: 0.55,
  /** Half-width of the band of rows that blends at the elbow joint (arm lengths). */
  elbowBlend: 0.03,
  /**
   * Upper-arm turn limits in degrees away from the rest pose: outward (arm
   * raised to its own side) and inward (across the body).
   */
  maxRaiseDegrees: 130,
  maxInwardDegrees: 40,
  /** Elbow bend limit in degrees (0 = straight; the forearm folds up and out). */
  maxBendDegrees: 100,
  /**
   * Arm mesh grid, laid out along the arm (rows across it, denser at the
   * shoulder and the elbow); 3 x 32 = 96 vertices stays on Pixi's batched
   * mesh path (<= 100).
   */
  gridX: 3,
  gridY: 32,
  /** Torso seam outline: hidden below the first, full from the second upper-arm turn (degrees). */
  seamFadeDegrees: [2, 10] as readonly [number, number]
} as const;

const DEG = Math.PI / 180;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = (x - edge0) / (edge1 - edge0);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** Rest direction of a chain's arm, degrees from straight down toward its own side. */
function restArmDegrees(chain: ArmChain): number {
  return Math.atan2(chain.sign * chain.axisX, chain.axisY) / DEG;
}

/** One arm's rest frame in layer units; sign = +1 right arm, -1 left arm. */
export type ArmChain = {
  sign: number;
  shoulderX: number;
  shoulderY: number;
  fistX: number;
  fistY: number;
  /** Rest axis (shoulder to fist, unit) and outward normal. */
  axisX: number;
  axisY: number;
  normalX: number;
  normalY: number;
  length: number;
};

export function createArmChain(): ArmChain {
  return {
    sign: 1, shoulderX: 0, shoulderY: 0, fistX: 0, fistY: 0,
    axisX: 0, axisY: 1, normalX: 1, normalY: 0, length: 1
  };
}

export function armChainForSide(geometry: ArmGeometry, sign: number, out: ArmChain): ArmChain {
  out.sign = sign;
  out.shoulderX = sideX(geometry, geometry.shoulderX, sign);
  out.shoulderY = geometry.shoulderY;
  out.fistX = sideX(geometry, geometry.fistX, sign);
  out.fistY = geometry.fistY;
  const dx = out.fistX - out.shoulderX;
  const dy = out.fistY - out.shoulderY;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;
  out.length = length;
  out.axisX = dx / length;
  out.axisY = dy / length;
  out.normalX = sign * out.axisY;
  out.normalY = -sign * out.axisX;
  return out;
}

/**
 * A posed arm: the upper arm turned by `upperTurn` about the shoulder joint,
 * the forearm and fist a further `bend` about the elbow joint (radians,
 * layer space; positive bends fold the forearm out to the arm's own side).
 */
export type ArmBend = {
  shoulderX: number;
  shoulderY: number;
  upperTurn: number;
  /** Signed elbow turn in layer rotation (radians). */
  bend: number;
  /** Rest and posed elbow joint. */
  elbowRestX: number;
  elbowRestY: number;
  elbowX: number;
  elbowY: number;
  fistX: number;
  fistY: number;
};

export function createArmBend(): ArmBend {
  return {
    shoulderX: 0, shoulderY: 0, upperTurn: 0, bend: 0,
    elbowRestX: 0, elbowRestY: 0, elbowX: 0, elbowY: 0, fistX: 0, fistY: 1
  };
}

/** Writes the posed elbow and fist of a bend from its two turns. */
function placeBend(chain: ArmChain, out: ArmBend): ArmBend {
  const along = ARM_RIG_TUNING.elbowAt * chain.length;
  out.shoulderX = chain.shoulderX;
  out.shoulderY = chain.shoulderY;
  out.elbowRestX = chain.shoulderX + chain.axisX * along;
  out.elbowRestY = chain.shoulderY + chain.axisY * along;
  let c = Math.cos(out.upperTurn);
  let s = Math.sin(out.upperTurn);
  out.elbowX = chain.shoulderX + (c * chain.axisX - s * chain.axisY) * along;
  out.elbowY = chain.shoulderY + (s * chain.axisX + c * chain.axisY) * along;
  c = Math.cos(out.upperTurn + out.bend);
  s = Math.sin(out.upperTurn + out.bend);
  const fx = chain.fistX - out.elbowRestX;
  const fy = chain.fistY - out.elbowRestY;
  out.fistX = out.elbowX + c * fx - s * fy;
  out.fistY = out.elbowY + s * fx + c * fy;
  return out;
}

/**
 * Poses the arm: the upper arm turned `upperDegrees` away from its rest
 * direction (positive = out to its own side), the elbow bent `bendDegrees`
 * (folding the forearm up and out). Both are clamped to the tuning limits.
 * No allocation.
 */
export function poseArmBend(chain: ArmChain, upperDegrees: number, bendDegrees: number, out: ArmBend): ArmBend {
  const tuning = ARM_RIG_TUNING;
  const upper = Math.min(tuning.maxRaiseDegrees, Math.max(-tuning.maxInwardDegrees, upperDegrees));
  const bend = Math.min(tuning.maxBendDegrees, Math.max(0, bendDegrees));
  // Outward is -sign in layer rotation; the forearm folds the same way.
  out.upperTurn = -chain.sign * upper * DEG;
  out.bend = -chain.sign * bend * DEG;
  return placeBend(chain, out);
}

/**
 * Where a rest-pose point (layer units) of this arm goes on the posed arm.
 * Every row across the arm only turns about one of the two joints, so the
 * arm keeps its width everywhere and the forearm and fist move as one piece.
 */
export function bendArmPoint(chain: ArmChain, bend: ArmBend, x: number, y: number, out: MutablePoint): MutablePoint {
  const tuning = ARM_RIG_TUNING;
  const rx = x - chain.shoulderX;
  const ry = y - chain.shoulderY;
  const along = (rx * chain.axisX + ry * chain.axisY) / chain.length;
  if (along < tuning.elbowAt - tuning.elbowBlend) {
    const turn = along >= tuning.blendEnd
      ? bend.upperTurn
      : bend.upperTurn * smoothstep(tuning.blendStart, tuning.blendEnd, along);
    if (turn === 0) {
      out.x = x;
      out.y = y;
      return out;
    }
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    out.x = chain.shoulderX + c * rx - s * ry;
    out.y = chain.shoulderY + s * rx + c * ry;
    return out;
  }
  const weight = smoothstep(tuning.elbowAt - tuning.elbowBlend, tuning.elbowAt + tuning.elbowBlend, along);
  const turn = bend.upperTurn + bend.bend * weight;
  const ex = x - bend.elbowRestX;
  const ey = y - bend.elbowRestY;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  out.x = bend.elbowX + c * ex - s * ey;
  out.y = bend.elbowY + s * ex + c * ey;
  return out;
}

/** Mesh whose positions are written directly (never rebuilt on texture updates). */
export class RigMesh extends MeshPlane {
  constructor(texture: Texture, verticesX: number, verticesY: number) {
    super({ texture, verticesX, verticesY });
    this.autoResize = false;
  }

  commit(uvsChanged = false): void {
    this.geometry.getBuffer("aPosition").update();
    if (uvsChanged) this.geometry.getBuffer("aUV").update();
    this.onViewUpdate();
  }
}

type RigArm = {
  mesh: RigMesh;
  view: Texture | null;
  /** Outline of the cut edge on the piece; fades in with the seam. */
  edge: RigMesh | null;
  edgeView: Texture | null;
  sign: number;
  rest: Float32Array;
  /** Per vertex: how much of the body squash is undone (0 at the pinned cap, 1 below the shoulder blend). */
  unsquash: Float32Array;
};

const ROW_SAMPLES = 128;
const rowDensity = new Float32Array(ROW_SAMPLES + 1);

/**
 * Lays the mesh out in the arm's frame: rows across the arm (so a row never
 * spans the elbow), spaced densest where the arm bends. Writes the rest
 * positions (layer units) and the UVs into the piece's untrimmed view.
 */
function layoutArmMesh(
  mesh: RigMesh,
  piece: Texture,
  placement: ArmCutPlacement,
  chain: ArmChain
): Float32Array {
  const tuning = ARM_RIG_TUNING;
  const trim = piece.trim;
  const originX = trim ? trim.x : 0;
  const originY = trim ? trim.y : 0;
  const width = trim ? trim.width : piece.frame.width;
  const height = trim ? trim.height : piece.frame.height;
  const c = Math.cos(placement.rotation);
  const s = Math.sin(placement.rotation);
  const scaleX = placement.scaleX || 1;
  const scaleY = placement.scaleY || 1;
  // Piece rectangle in the arm frame (along in arm lengths, across in layer units).
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  for (let corner = 0; corner < 4; corner += 1) {
    const tx = originX + (corner % 2) * width;
    const ty = originY + (corner < 2 ? 0 : height);
    const lx = (tx - placement.pivotX) * placement.scaleX;
    const ly = (ty - placement.pivotY) * placement.scaleY;
    const rx = placement.x + c * lx - s * ly - chain.shoulderX;
    const ry = placement.y + s * lx + c * ly - chain.shoulderY;
    const along = (rx * chain.axisX + ry * chain.axisY) / chain.length;
    const across = rx * chain.normalX + ry * chain.normalY;
    minAlong = Math.min(minAlong, along);
    maxAlong = Math.max(maxAlong, along);
    minAcross = Math.min(minAcross, across);
    maxAcross = Math.max(maxAcross, across);
  }
  // Row spacing follows a density with bumps at the shoulder blend and the elbow.
  const blendMid = (tuning.blendStart + tuning.blendEnd) / 2;
  let total = 0;
  rowDensity[0] = 0;
  for (let index = 1; index <= ROW_SAMPLES; index += 1) {
    const along = minAlong + (maxAlong - minAlong) * (index - 0.5) / ROW_SAMPLES;
    const elbow = (along - tuning.elbowAt) / 0.14;
    const shoulder = (along - blendMid) / 0.18;
    total += 1 + 3.5 * Math.exp(-elbow * elbow) + 1.5 * Math.exp(-shoulder * shoulder);
    rowDensity[index] = total;
  }
  const columns = tuning.gridX;
  const rows = tuning.gridY;
  const positions = mesh.geometry.positions;
  const uvs = mesh.geometry.uvs;
  const rest = new Float32Array(positions.length);
  let sample = 0;
  for (let row = 0; row < rows; row += 1) {
    const goal = total * row / (rows - 1);
    while (sample < ROW_SAMPLES && rowDensity[sample + 1]! < goal) sample += 1;
    const low = rowDensity[sample]!;
    const high = rowDensity[Math.min(ROW_SAMPLES, sample + 1)]!;
    const f = high > low ? Math.min(1, Math.max(0, (goal - low) / (high - low))) : 0;
    const along = minAlong + (maxAlong - minAlong) * (sample + f) / ROW_SAMPLES;
    for (let column = 0; column < columns; column += 1) {
      const across = minAcross + (maxAcross - minAcross) * column / (columns - 1);
      const x = chain.shoulderX + chain.axisX * along * chain.length + chain.normalX * across;
      const y = chain.shoulderY + chain.axisY * along * chain.length + chain.normalY * across;
      // Layer point to texture point (inverse placement).
      const dx = x - placement.x;
      const dy = y - placement.y;
      const tx = (c * dx + s * dy) / scaleX + placement.pivotX;
      const ty = (-s * dx + c * dy) / scaleY + placement.pivotY;
      const index = (row * columns + column) * 2;
      rest[index] = x;
      rest[index + 1] = y;
      uvs[index] = (tx - originX) / width;
      uvs[index + 1] = (ty - originY) / height;
    }
  }
  positions.set(rest);
  mesh.commit(true);
  return rest;
}

/**
 * Both arms of one player as bendable meshes. The renderer cuts the arm
 * pieces, attaches them here, and poses each side with a fist target.
 */
export class ArmRig {
  /** Arm meshes of both sides, in front of the torso layers. */
  readonly group = new Container();
  /** Shoulder caps, in front of the torso layers (behind the hands and head). */
  readonly capGroup = new Container();
  private readonly caps: { sprite: Sprite; sign: number }[] = [];
  private readonly arms: RigArm[] = [];
  private readonly seams: { sprite: Sprite; sign: number }[] = [];
  private readonly chains = { right: createArmChain(), left: createArmChain() };
  private readonly bends = { right: createArmBend(), left: createArmBend() };
  private readonly point: MutablePoint = { x: 0, y: 0 };

  /** beforeLayer: the first visualRoot layer drawn over the arms (the head). */
  /** beforeLayer: the first layer drawn over the arms; capLayer: the first drawn over the shoulder caps. */
  constructor(visualRoot: Container, beforeLayer: Container, capLayer: Container) {
    this.capGroup.label = "arm-rig-caps";
    this.capGroup.eventMode = "none";
    this.group.label = "arm-rig";
    this.group.eventMode = "none";
    visualRoot.addChildAt(this.group, Math.max(0, visualRoot.getChildIndex(beforeLayer)));
    visualRoot.addChildAt(this.capGroup, Math.max(0, visualRoot.getChildIndex(capLayer)));
  }

  /** Attached arm meshes (tests). */
  get armCount(): number {
    return this.arms.length;
  }

  /** Last solved bend of a side. */
  bendFor(sign: number): Readonly<ArmBend> {
    return sign > 0 ? this.bends.right : this.bends.left;
  }

  /**
   * Adds one cut arm piece (attach in layer order) and, when given, the
   * outline of its cut edge (pieceSeam, same frame as the piece) and the torso
   * seam outline of that cut, shown in the source layer above the armless art.
   * Both outlines, and the shoulder cap (the arm's own shoulder kept in place
   * in front of the torso), fade in only as the arm leaves its rest pose.
   */
  attach(
    geometry: ArmGeometry,
    piece: Texture,
    pieceSeam: Texture | null,
    cap: Texture | null,
    seam: Texture | null,
    placement: ArmCutPlacement,
    sign: number,
    tint: number,
    sourceLayer: Container,
    sourceIndex: number
  ): void {
    const tuning = ARM_RIG_TUNING;
    // Pixi maps mesh UVs over a trimmed texture's untrimmed (orig) rectangle;
    // the mesh samples an untrimmed view of the same frame instead.
    const view = piece.trim ? new Texture({ source: piece.source, frame: piece.frame }) : null;
    const mesh = new RigMesh(view ?? piece, tuning.gridX, tuning.gridY);
    mesh.tint = tint;
    const chain = armChainForSide(geometry, sign, sign > 0 ? this.chains.right : this.chains.left);
    const rest = layoutArmMesh(mesh, piece, placement, chain);
    const unsquash = new Float32Array(rest.length / 2);
    for (let index = 0; index < unsquash.length; index += 1) {
      const along = ((rest[index * 2]! - chain.shoulderX) * chain.axisX +
        (rest[index * 2 + 1]! - chain.shoulderY) * chain.axisY) / chain.length;
      unsquash[index] = smoothstep(tuning.blendStart, tuning.blendEnd, along);
    }
    this.group.addChild(mesh);
    let edge: RigMesh | null = null;
    let edgeView: Texture | null = null;
    if (pieceSeam) {
      edgeView = pieceSeam.trim ? new Texture({ source: pieceSeam.source, frame: pieceSeam.frame }) : null;
      edge = new RigMesh(edgeView ?? pieceSeam, tuning.gridX, tuning.gridY);
      edge.tint = tint;
      edge.alpha = 0;
      edge.geometry.uvs.set(mesh.geometry.uvs);
      edge.geometry.positions.set(rest);
      edge.commit(true);
      this.group.addChild(edge);
    }
    this.arms.push({ mesh, view, edge, edgeView, sign, rest, unsquash });
    if (cap) {
      const sprite = new Sprite(cap);
      sprite.anchor.set(placement.pivotX / (cap.orig.width || 1), placement.pivotY / (cap.orig.height || 1));
      sprite.position.set(placement.x, placement.y);
      sprite.scale.set(placement.scaleX, placement.scaleY);
      sprite.rotation = placement.rotation;
      sprite.tint = tint;
      sprite.alpha = 0;
      sprite.visible = false;
      this.capGroup.addChild(sprite);
      this.caps.push({ sprite, sign });
    }
    if (seam) {
      const sprite = new Sprite(seam);
      const width = seam.orig.width || 1;
      const height = seam.orig.height || 1;
      sprite.anchor.set(placement.pivotX / width, placement.pivotY / height);
      sprite.position.set(placement.x, placement.y);
      sprite.scale.set(placement.scaleX, placement.scaleY);
      sprite.rotation = placement.rotation;
      sprite.tint = tint;
      sprite.alpha = 0;
      sourceLayer.addChildAt(sprite, Math.min(sourceLayer.children.length, sourceIndex + 1));
      this.seams.push({ sprite, sign });
    }
  }

  detach(): void {
    for (const arm of this.arms) {
      if (!arm.mesh.destroyed) {
        arm.mesh.removeFromParent();
        arm.mesh.destroy();
      }
      arm.view?.destroy(false);
      if (arm.edge && !arm.edge.destroyed) {
        arm.edge.removeFromParent();
        arm.edge.destroy();
      }
      arm.edgeView?.destroy(false);
    }
    this.arms.length = 0;
    for (const seam of this.seams) {
      if (seam.sprite.destroyed) continue;
      seam.sprite.removeFromParent();
      seam.sprite.destroy();
    }
    this.seams.length = 0;
    for (const cap of this.caps) {
      if (cap.sprite.destroyed) continue;
      cap.sprite.removeFromParent();
      cap.sprite.destroy();
    }
    this.caps.length = 0;
  }

  /**
   * The body's squash and stretch as the visualRoot scale relative to its
   * uniform scale. Arms undo it below the shoulder (about the shoulder
   * joint), so a squashed body never makes an arm thinner or fatter; the
   * shoulder cap squashes with the torso it sits on. Set before pose().
   */
  setBodyScale(scaleX: number, scaleY: number): void {
    this.unsquashX = scaleX > 0 ? 1 / scaleX : 1;
    this.unsquashY = scaleY > 0 ? 1 / scaleY : 1;
  }

  private unsquashX = 1;
  private unsquashY = 1;

  /**
   * Poses one side: upper arm direction in degrees from straight down toward
   * its own side, elbow bend in degrees. Returns the fist (layer units).
   */
  pose(
    geometry: ArmGeometry,
    sign: number,
    armDegrees: number,
    bendDegrees: number,
    out: MutablePoint
  ): MutablePoint {
    const chain = armChainForSide(geometry, sign, sign > 0 ? this.chains.right : this.chains.left);
    const bend = poseArmBend(
      chain, armDegrees - restArmDegrees(chain), bendDegrees, sign > 0 ? this.bends.right : this.bends.left
    );
    const point = this.point;
    const fade = ARM_RIG_TUNING.seamFadeDegrees;
    const seamAlpha = smoothstep(fade[0], fade[1], Math.abs(bend.upperTurn) * 180 / Math.PI);
    for (const arm of this.arms) {
      if (arm.sign !== sign) continue;
      const rest = arm.rest;
      const positions = arm.mesh.geometry.positions;
      const ux = this.unsquashX - 1;
      const uy = this.unsquashY - 1;
      for (let index = 0; index < rest.length; index += 2) {
        bendArmPoint(chain, bend, rest[index]!, rest[index + 1]!, point);
        const w = arm.unsquash[index / 2]!;
        positions[index] = point.x + (point.x - chain.shoulderX) * ux * w;
        positions[index + 1] = point.y + (point.y - chain.shoulderY) * uy * w;
      }
      arm.mesh.commit();
      const edge = arm.edge;
      if (edge) {
        edge.alpha = seamAlpha;
        edge.visible = seamAlpha > 0;
        if (edge.visible) {
          edge.geometry.positions.set(positions);
          edge.commit();
        }
      }
    }
    for (const seam of this.seams) if (seam.sign === sign) seam.sprite.alpha = seamAlpha;
    // The shoulder cap only shows while the arm is raised outward; an arm that
    // swings in tucks under the shoulder art it came from.
    const outward = -chain.sign * bend.upperTurn * 180 / Math.PI;
    const capAlpha = smoothstep(fade[0], fade[1], outward);
    for (const cap of this.caps) {
      if (cap.sign !== sign) continue;
      cap.sprite.alpha = capAlpha;
      cap.sprite.visible = capAlpha > 0;
    }
    out.x = bend.fistX + (bend.fistX - chain.shoulderX) * (this.unsquashX - 1);
    out.y = bend.fistY + (bend.fistY - chain.shoulderY) * (this.unsquashY - 1);
    return out;
  }

  /**
   * The striking face of a side's fist after its last pose: the fist centre
   * pushed out along the forearm by `reach` arm lengths (layer units).
   */
  knuckles(geometry: ArmGeometry, sign: number, reach: number, out: MutablePoint): MutablePoint {
    const chain = armChainForSide(geometry, sign, sign > 0 ? this.chains.right : this.chains.left);
    const bend = sign > 0 ? this.bends.right : this.bends.left;
    const turn = bend.upperTurn + bend.bend;
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const x = bend.fistX + (c * chain.axisX - s * chain.axisY) * reach * chain.length;
    const y = bend.fistY + (s * chain.axisX + c * chain.axisY) * reach * chain.length;
    out.x = x + (x - chain.shoulderX) * (this.unsquashX - 1);
    out.y = y + (y - chain.shoulderY) * (this.unsquashY - 1);
    return out;
  }

  /** Fist (layer units) of a pose without moving any mesh. */
  static fist(geometry: ArmGeometry, sign: number, armDegrees: number, bendDegrees: number, out: MutablePoint): MutablePoint {
    const chain = armChainForSide(geometry, sign, createArmChain());
    const bend = poseArmBend(chain, armDegrees - restArmDegrees(chain), bendDegrees, createArmBend());
    out.x = bend.fistX;
    out.y = bend.fistY;
    return out;
  }

  destroy(): void {
    this.detach();
    for (const group of [this.group, this.capGroup]) {
      if (group.destroyed) continue;
      group.removeFromParent();
      group.destroy({ children: true });
    }
  }
}
