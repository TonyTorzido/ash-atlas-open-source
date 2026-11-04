import { Container, Graphics, Sprite, Text } from "pixi.js";
import { heartPuzzleForRoom } from "@ash-atlas/shared";

import {
  heartPuzzleHub, heartPuzzleRuntime, markPellBubbleDrawn, onVaultEvent, pellBubble
} from "../heartPuzzles/heartPuzzleSession.js";
import { HEART_PUZZLE_PELL_FEET_OFFSET, heartPuzzleRoomNavigation } from "../features/interiorMap/dungeonMapInterior.js";
import { vaultRoomArtKey, vaultTexture, type VaultSpriteKey } from "../heartPuzzles/vault/vaultAssets.js";
import { ParticleField } from "../heartPuzzles/vault/vaultFx.js";
import { VaultMarbleNode } from "../heartPuzzles/vault/vaultMarbleNode.js";
import { cellRects } from "../heartPuzzles/vault/vaultSim.js";
import { VAULT_CELL, vaultBoardOrigin } from "../heartPuzzles/vault/vaultRooms.js";
import { vaultSfx } from "../heartPuzzles/vault/vaultSfx.js";
import { MARBLE_SPECS, VAULT_TUNING } from "../heartPuzzles/vault/vaultTuning.js";
import type { MarbleKind, VaultCell, VaultEvent, VaultState } from "../heartPuzzles/vault/vaultTypes.js";
import type { InteriorRoomTransform } from "./interiorRoomLayer.js";
import type { InteriorRenderState } from "./mapObjects.js";

/** Where each room's painted exit door sits relative to its door anchor (room units), measured on the room art. */
const VAULT_DOOR_ART: Readonly<Record<string, Readonly<{ dx: number; dy: number; w: number; h: number }>>> = {
  vault_r1: { dx: -30, dy: 85, w: 92, h: 96 },
  vault_r2: { dx: -50, dy: 62, w: 108, h: 84 },
  vault_r3: { dx: -45, dy: 65, w: 100, h: 76 },
  // Combat rooms paint the forward door at the same spot (centre about x 846, y 1056 in room units, measured on
  // room-combat_*.png); the anchors differ, so each dy lands on that painted arch.
  combat_a: { dx: 0, dy: 75, w: 92, h: 80 },
  combat_b: { dx: 0, dy: 89, w: 92, h: 80 },
  combat_c: { dx: 0, dy: 88, w: 92, h: 80 }
};

/** A room's forward door: runtime portal ids wrap the catalog id (dungeon:<entrance>:<catalog id>), so match the end. */
const FORWARD_DOOR_PORTAL = /(^|[^a-z0-9_])(vault_r\d+|combat_[a-z])_to_(vault_r\d+|combat_[a-z])$/;

const COLORS = {
  board: 0x1a0e0b,
  tile: 0x86817f,
  tileAlt: 0x7a7577,
  inlay: 0xa2402e,
  wall: 0x45464d,
  wallTop: 0x6d6e78,
  wallFace: 0x1f2024,
  erodible: 0x9c4a32,
  crack: 0x3a1f18,
  holeRim: 0x4a3330,
  holeInner: 0x060303,
  goal: 0xff7a3a,
  plateLight: 0x9cc4e0,
  plateHeavy: 0xe8803f,
  channel: 0xff8a45,
  grout: 0xff5a1f,
  ember: 0xff7a30,
  frame: 0x8a3526
} as const;

const C = VAULT_CELL;
/** Unit vector toward the room light on screen (upper left). */
const LIGHT = { x: -0.553, y: -0.833 };
const PELL_BUBBLE_W = 340;
/** Flat maze blocks: the art's block top is inset 9/240 of a cell; the dark lip below it is 0.08 cell. */
const BLOCK_INSET = C * 9 / 240;
const BLOCK_LIP = C * 0.08;
/** Soft block shadow offset (+8,+10 px at 240 px per cell), screen-fixed; the art pads 30 px each side. */
const SHADOW_OFFSET = { x: C * 8 / 240, y: C * 10 / 240 };
const SHADOW_PAD = C * 30 / 240;
const PLATE_TINT: Readonly<Record<MarbleKind, number>> = { light: 0xd2e2ff, heavy: 0xffffff, big: 0xfff0d8 };
const EROD_TINT = 0xd89a78;

/** Stable per-cell hash in [0, 1). */
const cellHash = (cell: number, salt: number): number => (((cell + 1) * 2654435761 + salt * 40503) >>> 0) % 1000 / 1000;

type Pt = { x: number; y: number };
type Bubble = { root: Container; bg: Graphics; text: Text; name: Text; shown: string };
type SolveAnim = { t: number; target: Pt; doorFired: boolean; flared: boolean; heart: boolean };

const centroid = (plates: ReadonlyArray<Pt>): Pt => {
  if (plates.length === 0) return { x: 0, y: 0 };
  return { x: plates.reduce((s, p) => s + p.x, 0) / plates.length, y: plates.reduce((s, p) => s + p.y, 0) / plates.length };
};

/** Pooled sprites for texture hooks: `put` draws the keyed texture and returns false when only the fallback exists. */
class Stamps {
  readonly container = new Container();
  private readonly pool: Sprite[] = [];
  private used = 0;

  begin(): void { this.used = 0; }

  put(key: VaultSpriteKey, x: number, y: number, w: number, h: number, alpha = 1, tint = 0xffffff): boolean {
    const tex = vaultTexture(key);
    if (!tex) return false;
    let sprite = this.pool[this.used];
    if (!sprite) {
      sprite = new Sprite();
      this.pool.push(sprite);
      this.container.addChild(sprite);
    }
    this.used += 1;
    sprite.visible = true;
    sprite.texture = tex;
    sprite.position.set(x, y);
    sprite.width = w;
    sprite.height = h;
    sprite.alpha = alpha;
    sprite.tint = tint;
    return true;
  }

  end(): void { for (let i = this.used; i < this.pool.length; i += 1) this.pool[i]!.visible = false; }
}

/** Deterministic little crack line set per cell, revealed stage by stage. */
const crackLines = (cell: number): ReadonlyArray<ReadonlyArray<Pt>> => {
  let seed = (cell + 7) * 2654435761 >>> 0;
  const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const lines: Pt[][] = [];
  for (let i = 0; i < 7; i += 1) {
    const a = rnd() * Math.PI * 2;
    const pts: Pt[] = [{ x: C / 2 + (rnd() - 0.5) * 12, y: C / 2 + (rnd() - 0.5) * 12 }];
    for (let k = 0; k < 3; k += 1) {
      const last = pts[pts.length - 1]!;
      const ang = a + (rnd() - 0.5) * 1.1;
      const len = 11 + rnd() * 13;
      pts.push({ x: last.x + Math.cos(ang) * len, y: last.y + Math.sin(ang) * len });
    }
    lines.push(pts);
  }
  return lines;
};

export class HeartPuzzleLayer {
  readonly container = new Container();
  /** The painted room (back facade, side walls, floor, baked doors) under everything else. */
  private readonly roomArt = new Stamps();
  /** Ground shadows under the room's standing figures (Old Pell), under the actor layer. */
  private readonly groundG = new Graphics();
  /** A still mosaic under a turning board, so its swinging corners uncover floor, not the art's bare board zone. */
  private readonly underStamps = new Stamps();
  private readonly underGrout = new Stamps();
  /** Clips the (turning) board to the painted floor so it never covers the room's walls. */
  private readonly boardMask = new Graphics();
  private maskFor = "";
  private readonly board = new Container();
  private readonly inner = new Container();
  private readonly floorG = new Graphics();
  private readonly floorStamps = new Stamps();
  /** Additive ember grout over the floor tiles. */
  private readonly groutStamps = new Stamps();
  private readonly shadowStamps = new Stamps();
  private readonly decoG = new Graphics();
  private readonly decoStamps = new Stamps();
  private readonly wallG = new Graphics();
  private readonly wallStamps = new Stamps();
  private readonly marbleLayer = new Container();
  private readonly fxG = new Graphics();
  private readonly motesG = new Graphics();
  /** Additive ember light: pulsing glow from the holes, goal and seal, plus rising ember sparks. */
  private readonly glowG = new Graphics();
  private readonly embersG = new Graphics();
  private readonly vignetteG = new Graphics();
  private vignetteFor = "";
  private embers: Array<{ x: number; y: number; vx: number; vy: number; phase: number; size: number; life: number }> = [];
  private readonly roomG = new Graphics();
  /** The exit door: iron bars while sealed; a pulsing ember glow, a light beam and an arrow once open. */
  private readonly doorG = new Graphics();
  private readonly doorGlowG = new Graphics();
  /** True while the layer shows a combat room (only the door graphics visible). */
  private combatMode = false;
  private readonly combatSavedVisibility = new Map<Container, boolean>();
  private readonly roomStamps = new Stamps();
  private readonly bubble: Bubble;
  private readonly particles = new ParticleField();
  private readonly nodes = new Map<string, VaultMarbleNode>();
  private readonly fallStart = new Map<string, Pt>();
  private readonly appear = new Map<string, number>();
  private readonly crackStage = new Map<number, number>();
  private readonly crumbling: Array<{ cell: number; t: number }> = [];
  private readonly holeReveal = new Map<number, number>();
  private readonly wallFlash = new Map<number, number>();
  private plateDepth: number[] = [];
  private platePressed: boolean[] = [];
  private motes: Array<{ x: number; y: number; vx: number; vy: number; phase: number; size: number }> = [];
  private solve: SolveAnim | null = null;
  private roomKey = "";
  private clock = 0;
  private lastFrameMs = 0;
  private wasVisible = false;
  private readonly unsubscribe: () => void;
  private pending: VaultEvent[] = [];

  constructor() {
    this.container.label = "heart-puzzle";
    this.container.visible = false;
    this.inner.addChild(
      this.floorG, this.floorStamps.container, this.groutStamps.container, this.decoG, this.decoStamps.container, this.glowG,
      this.shadowStamps.container, this.wallG, this.wallStamps.container, this.marbleLayer, this.fxG
    );
    this.glowG.blendMode = "add";
    this.groutStamps.container.blendMode = "add";
    this.embersG.blendMode = "add";
    this.board.addChild(this.inner);
    this.bubble = this.makeBubble();
    // Embers and the seal glow sit above the seal art so the light reads on top of it.
    this.underGrout.container.blendMode = "add";
    this.board.mask = this.boardMask;
    this.container.addChild(this.roomArt.container, this.underStamps.container, this.underGrout.container, this.boardMask, this.groundG, this.board, this.vignetteG, this.motesG, this.roomStamps.container, this.doorG, this.doorGlowG, this.embersG, this.roomG, this.bubble.root);
    this.doorGlowG.blendMode = "add";
    this.unsubscribe = onVaultEvent((event) => { this.pending.push(event); });
  }

  frame(transform: InteriorRoomTransform | null, interior: InteriorRenderState | null, nowMs: number): void {
    const dt = this.lastFrameMs === 0 ? 0 : Math.min(0.05, (nowMs - this.lastFrameMs) / 1000);
    this.lastFrameMs = nowMs;
    heartPuzzleRuntime.activate(transform && interior?.heartPuzzle
      ? { ...interior.heartPuzzle, roomWidth: interior.roomWidth, roomHeight: interior.roomHeight }
      : null);
    const state = heartPuzzleRuntime.state;
    const def = heartPuzzleRuntime.def;
    if (transform && interior?.vaultCombat && !interior.heartPuzzle) {
      this.frameCombatRoom(transform, interior, interior.vaultCombat, dt);
      return;
    }
    if (!transform || !state || !def || !interior) {
      this.container.visible = false;
      if (this.wasVisible) { vaultSfx.stopLoops(); this.wasVisible = false; }
      this.pending.length = 0;
      return;
    }
    if (this.combatMode) {
      for (const [child, visible] of this.combatSavedVisibility) child.visible = visible;
      this.combatSavedVisibility.clear();
      this.combatMode = false;
    }
    const key = `${interior.heartPuzzle?.sessionId}:${interior.heartPuzzle?.roomId}`;
    if (key !== this.roomKey) this.resetRoom(key, state);
    this.wasVisible = true;
    this.clock += dt;
    heartPuzzleRuntime.step(dt);
    this.container.visible = true;
    this.container.position.set(transform.x, transform.y);
    this.container.scale.set(transform.scale);
    this.container.rotation = transform.rotation;

    const puzzle = heartPuzzleForRoom(interior.heartPuzzle!.dungeonId, interior.heartPuzzle!.roomId);
    const origin = vaultBoardOrigin(def, interior.roomWidth, interior.roomHeight, puzzle?.boardOrigin);
    this.roomArt.begin();
    this.roomArt.put(vaultRoomArtKey(interior.heartPuzzle!.roomId), 0, 0, interior.roomWidth, interior.roomHeight);
    this.roomArt.end();
    this.drawUnderFloor(state.cols, state.rows, origin, (def.rotationSpeed ?? 0) !== 0);
    this.updateBoardMask(interior.heartPuzzle!.dungeonId, interior.heartPuzzle!.roomId, interior.roomWidth, interior.roomHeight);
    const w = state.cols * C;
    const h = state.rows * C;
    this.inner.position.set(origin.x, origin.y);
    this.board.pivot.set(origin.x + w / 2, origin.y + h / 2);
    this.board.position.set(origin.x + w / 2, origin.y + h / 2);
    this.board.rotation = state.angle;
    const solved = heartPuzzleRuntime.status()?.solved === true;

    this.handleEvents(state);
    this.particles.step(dt);
    for (const [cell, t] of this.wallFlash) { if (t - dt <= 0) this.wallFlash.delete(cell); else this.wallFlash.set(cell, t - dt); }
    for (const tile of this.crumbling) tile.t += dt;
    for (let i = this.crumbling.length - 1; i >= 0; i -= 1) if (this.crumbling[i]!.t > 0.7) this.crumbling.splice(i, 1);

    const seal = puzzle ? interior.objects.find((o) => o.id === puzzle.sealObjectId) : undefined;
    const pell = puzzle ? interior.objects.find((o) => o.id === puzzle.npcObjectId) : undefined;
    const door = interior.objects.find((o) => !!o.portalId && FORWARD_DOOR_PORTAL.test(o.portalId));

    this.updateLoops(state, dt, solved);
    this.drawBoard(state, solved, dt, transform.rotation + state.angle);
    this.drawSolve(state, origin, w, h, seal, door, dt, solved);
    this.drawDoor(interior.heartPuzzle!.roomId, door, solved || this.solve?.doorFired === true);
    this.drawGlows(state, seal, solved);
    this.drawMotes(origin, w, h, dt);
    this.drawEmbers(origin, w, h, dt);
    this.drawVignette(interior.roomWidth, interior.roomHeight, key);
    this.drawBubble(pell);
    this.groundG.clear();
    if (pell) {
      const fy = pell.y + HEART_PUZZLE_PELL_FEET_OFFSET;
      for (let i = 0; i < 3; i += 1) this.groundG.ellipse(pell.x, fy, 40 - i * 9, 13 - i * 3).fill({ color: 0x000000, alpha: 0.16 });
    }
  }

  /**
   * A combat room between puzzle rooms: the room art and cover props are interior sprites; this layer only draws the
   * forward door, barred until the room is cleared, then glowing like an opened seal door.
   */
  private frameCombatRoom(
    transform: InteriorRoomTransform,
    interior: InteriorRenderState,
    combat: NonNullable<InteriorRenderState["vaultCombat"]>,
    dt: number
  ): void {
    if (this.wasVisible) { vaultSfx.stopLoops(); this.wasVisible = false; }
    this.pending.length = 0;
    this.clock += dt;
    this.container.visible = true;
    this.container.position.set(transform.x, transform.y);
    this.container.scale.set(transform.scale);
    this.container.rotation = transform.rotation;
    if (!this.combatMode) {
      for (const child of this.container.children) this.combatSavedVisibility.set(child, child.visible);
      this.combatMode = true;
    }
    for (const child of this.container.children) child.visible = child === this.doorG || child === this.doorGlowG;
    const door = interior.objects.find((o) => !!o.portalId && FORWARD_DOOR_PORTAL.test(o.portalId));
    this.drawDoor(combat.roomId, door, combat.doorUnlocked);
  }

  private drawUnderFloor(cols: number, rows: number, origin: Pt, turning: boolean): void {
    this.underStamps.begin(); this.underGrout.begin();
    if (turning) {
      for (let cy = 0; cy < rows; cy += 1) {
        for (let cx = 0; cx < cols; cx += 1) {
          const x = origin.x + cx * C;
          const y = origin.y + cy * C;
          const index = cy * cols + cx;
          if ((cellHash(index, 5) < 0.28 && this.underStamps.put("floor-alt", x, y, C, C)) || this.underStamps.put("floor", x, y, C, C)) {
            this.underGrout.put("grout", x, y, C, C, 0.6);
          }
        }
      }
    }
    this.underStamps.end(); this.underGrout.end();
  }

  private updateBoardMask(dungeonId: string, roomId: string, roomWidth: number, roomHeight: number): void {
    const key = `${dungeonId}:${roomId}:${roomWidth}:${roomHeight}`;
    if (this.maskFor === key) return;
    this.maskFor = key;
    const floor = heartPuzzleRoomNavigation({ dungeonId, spaceId: roomId })?.walkableSurfaces?.[0];
    const g = this.boardMask;
    g.clear();
    if (floor && floor.length >= 3) g.poly(floor.flatMap((p) => [p.x, p.y])).fill({ color: 0xffffff });
    else g.rect(0, 0, roomWidth, roomHeight).fill({ color: 0xffffff });
  }

  private resetRoom(key: string, state: VaultState): void {
    this.roomKey = key;
    for (const node of this.nodes.values()) node.root.destroy({ children: true });
    this.nodes.clear();
    this.fallStart.clear(); this.appear.clear(); this.crackStage.clear(); this.crumbling.length = 0;
    this.holeReveal.clear(); this.wallFlash.clear(); this.particles.items.length = 0; this.pending.length = 0;
    this.plateDepth = state.plates.map(() => 0);
    this.platePressed = state.plates.map(() => false);
    this.solve = null;
    this.embers = Array.from({ length: 22 }, () => ({
      x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 0.02, vy: -0.03 - Math.random() * 0.05,
      phase: Math.random() * 6.28, size: 1.2 + Math.random() * 2, life: Math.random()
    }));
    this.motes = Array.from({ length: 30 }, () => ({
      x: Math.random(), y: Math.random(), vx: (Math.random() - 0.3) * 0.012, vy: -0.004 - Math.random() * 0.01,
      phase: Math.random() * 6.28, size: 1 + Math.random() * 1.8
    }));
    vaultSfx.stopLoops();
  }

  private handleEvents(state: VaultState): void {
    const events = this.pending.splice(0, this.pending.length);
    for (const e of events) {
      switch (e.type) {
        case "bump": {
          if (e.marble) this.nodes.get(e.marble)?.hit(e.strength, e.nx, e.ny);
          const x = e.x * C;
          const y = e.y * C;
          if (e.strength > 0.3) this.particles.dust(x, y, Math.round(1 + e.strength * 5), 22 + e.strength * 40);
          if (e.strength > 0.55) this.particles.chips(x, y, Math.round(e.strength * 6), e.nx, e.ny, 80 + e.strength * 120);
          break;
        }
        case "fell": {
          this.fallStart.set(e.marble, { x: (e.x - e.hx) * C, y: (e.y - e.hy) * C });
          this.particles.dust(e.hx * C, e.hy * C, 6, 30, 0x20242a);
          this.particles.ring(e.hx * C, e.hy * C, 8, 34, 0x7f8c99, 0.45);
          break;
        }
        case "respawned": {
          this.appear.set(e.marble, 0);
          this.nodes.get(e.marble)?.resetTrail();
          this.fallStart.delete(e.marble);
          const x = e.x * C;
          const y = e.y * C;
          this.particles.ring(x, y, 70, 6, 0xbfe3ff, 0.55);
          this.particles.ring(x, y, 42, 4, 0xffffff, 0.45);
          this.particles.spark(x, y, 14, 90, 0xbfe3ff, 0.8);
          break;
        }
        case "crack-broke": {
          const x = ((e.cell % state.cols) + 0.5) * C;
          const y = (Math.floor(e.cell / state.cols) + 0.5) * C;
          this.crumbling.push({ cell: e.cell, t: 0 });
          this.holeReveal.set(e.cell, 0);
          this.particles.dust(x, y, 12, 55, 0x8a8372);
          for (let i = 0; i < 4; i += 1) this.particles.chips(x + (Math.random() - 0.5) * 40, y + (Math.random() - 0.5) * 40, 3, Math.random() - 0.5, Math.random() - 0.5, 60, 0x5c564a);
          break;
        }
        case "wall-chip": {
          const cx = ((e.cell % state.cols) + 0.5) * C;
          const cy = (Math.floor(e.cell / state.cols) + 0.5) * C;
          const nx = e.x * C - cx;
          const ny = e.y * C - cy;
          const len = Math.hypot(nx, ny) || 1;
          this.wallFlash.set(e.cell, 0.18);
          this.particles.chips(e.x * C, e.y * C, 7, nx / len, ny / len, 170, 0x9a7448);
          this.particles.dust(e.x * C, e.y * C, 5, 40, 0xb39a74);
          break;
        }
        case "wall-broke": {
          this.particles.dust(e.x * C, e.y * C, 22, 90, 0xb39a74);
          for (let i = 0; i < 4; i += 1) this.particles.chips(e.x * C, e.y * C, 5, Math.random() - 0.5, Math.random() - 0.5, 200, 0x84613c);
          this.particles.ring(e.x * C, e.y * C, 10, 70, 0xe3cfa6, 0.5);
          break;
        }
        default: break;
      }
    }
  }

  private updateLoops(state: VaultState, dt: number, solved: boolean): void {
    let top = 0;
    for (const m of state.marbles) if (!m.falling) top = Math.max(top, Math.hypot(m.vx, m.vy));
    vaultSfx.roll(state.status === "won" || solved ? 0 : top / VAULT_TUNING.maxSpeed);
    vaultSfx.grind((state.def.rotationSpeed ?? 0) !== 0 && state.status === "playing" && !solved);
    vaultSfx.ambience(true, dt);
  }

  private nodeFor(id: string, kind: MarbleKind): VaultMarbleNode {
    let node = this.nodes.get(id);
    if (!node) {
      node = new VaultMarbleNode(id, kind);
      this.nodes.set(id, node);
      this.marbleLayer.addChild(node.root);
    }
    return node;
  }

  private drawBoard(state: VaultState, solved: boolean, dt: number, totalRotation: number): void {
    const floor = this.floorG;
    const deco = this.decoG;
    const wall = this.wallG;
    floor.clear(); deco.clear(); wall.clear(); this.fxG.clear();
    this.floorStamps.begin(); this.groutStamps.begin(); this.decoStamps.begin(); this.shadowStamps.begin(); this.wallStamps.begin();
    // Screen-fixed directions in board space: the block shadow falls lower right, the lip faces screen south.
    const cr = Math.cos(-totalRotation);
    const sr = Math.sin(-totalRotation);
    const shadow = { x: SHADOW_OFFSET.x * cr - SHADOW_OFFSET.y * sr, y: SHADOW_OFFSET.x * sr + SHADOW_OFFSET.y * cr };
    const south = { x: -sr, y: cr };

    const at = (cx: number, cy: number): VaultCell => (cx < 0 || cy < 0 || cx >= state.cols || cy >= state.rows ? "#" : state.cells[cy * state.cols + cx]!);
    const isWall = (cell: VaultCell): boolean => cell === "#" || cell === "w";

    for (let cy = 0; cy < state.rows; cy += 1) {
      for (let cx = 0; cx < state.cols; cx += 1) {
        const index = cy * state.cols + cx;
        const cell = state.cells[index]!;
        const x = cx * C;
        const y = cy * C;
        // Flat mosaic floor everywhere, under the blocks too (their inset gap shows it).
        const alt = cellHash(index, 1) < 0.28;
        const stamped = (alt && this.floorStamps.put("floor-alt", x, y, C, C)) || this.floorStamps.put("floor", x, y, C, C);
        if (stamped) {
          this.groutStamps.put("grout", x, y, C, C, 0.6);
        } else {
          floor.rect(x, y, C, C).fill({ color: alt ? COLORS.tileAlt : COLORS.tile });
          floor.rect(x + 1, y + 1, C - 2, 2).fill({ color: 0xffffff, alpha: 0.06 });
          const mx = x + C / 2; const my = y + C / 2;
          floor.poly([mx, my - 17, mx + 17, my, mx, my + 17, mx - 17, my]).fill({ color: COLORS.inlay });
          floor.poly([mx, my - 10, mx + 10, my, mx, my + 10, mx - 10, my]).fill({ color: 0x000000, alpha: 0.18 });
          floor.rect(x, y, C, C).stroke({ color: COLORS.grout, width: 2.5, alpha: 0.38 + 0.12 * Math.sin(this.clock * 1.3 + (cx + cy) * 0.7) });
        }
        if (cell === "o") this.drawHole(deco, index, x, y);
        else if (cell === "c") this.drawCrackTile(deco, state, index, x, y);
        else if (cell === "#" || cell === "w") {
          const hp = cell === "w" ? (state.wallHp.get(index) ?? 0) / VAULT_TUNING.erodeWallHp : 1;
          this.drawWall(wall, index, x, y, isWall(at(cx, cy + 1)), cell === "w", hp, this.wallFlash.get(index) ?? 0, shadow, south);
        } else if (cell === "v" || cell === "h") {
          if (!this.wallStamps.put(cell === "v" ? "slit-v" : "slit-h", x, y, C, C)) {
            for (const r of cellRects(cell, cx, cy)) {
              const rx = r.x0 * C; const ry = r.y0 * C; const rw = (r.x1 - r.x0) * C; const rh = (r.y1 - r.y0) * C;
              wall.roundRect(rx + south.x * BLOCK_LIP, ry + south.y * BLOCK_LIP, rw, rh, 2).fill({ color: 0x15161b, alpha: 0.9 });
              wall.roundRect(rx, ry, rw, rh, 2).fill({ color: 0x7b808e });
              wall.roundRect(rx, ry, rw, rh, 2).stroke({ color: 0x17181d, width: 1.5, alpha: 0.8 });
            }
          }
        }
      }
    }
    // Tiles that just gave way: the slab sinks and fades while the hole opens under it.
    for (const tile of this.crumbling) {
      const k = Math.min(1, tile.t / 0.55);
      const x = (tile.cell % state.cols) * C;
      const y = Math.floor(tile.cell / state.cols) * C;
      const s = 1 - 0.45 * k;
      deco.rect(x + C * (1 - s) / 2, y + C * (1 - s) / 2 + k * 16, C * s, C * s).fill({ color: 0x4a463d, alpha: 1 - k });
    }
    for (const [cell, t] of this.holeReveal) { if (t >= 1) this.holeReveal.delete(cell); else this.holeReveal.set(cell, Math.min(1, t + dt * 3)); }

    for (let i = 0; i < state.plates.length; i += 1) this.drawPlate(deco, state, i, dt);
    if (state.goal) this.drawGoal(deco, state.goal, solved);
    this.decoStamps.end(); this.floorStamps.end(); this.groutStamps.end(); this.shadowStamps.end(); this.wallStamps.end();

    // Marbles. The light stays fixed on screen, so it is rotated back into board space.
    const lx = LIGHT.x * Math.cos(-totalRotation) - LIGHT.y * Math.sin(-totalRotation);
    const ly = LIGHT.x * Math.sin(-totalRotation) + LIGHT.y * Math.cos(-totalRotation);
    for (const m of state.marbles) {
      const node = this.nodeFor(m.id, m.kind);
      // The light marble reads bigger than its physics radius (0.375 vs 0.3 cell) so it stays clear on the mosaic.
      const radius = MARBLE_SPECS[m.kind].radius * C * (m.kind === "light" ? 1.25 : 1);
      let px = m.x * C;
      let py = m.y * C;
      let shrink = 1;
      let darken = 0;
      let appear = 1;
      if (m.falling) {
        // Spiral down the hole: the orbit tightens while the ball shrinks and darkens.
        const t = Math.min(1, m.falling.t);
        const ease = t * t * (3 - 2 * t);
        const start = this.fallStart.get(m.id) ?? { x: px - m.falling.hx * C, y: py - m.falling.hy * C };
        const a = ease * Math.PI * 2.6;
        const k = (1 - ease) * 0.9;
        px = m.falling.hx * C + (start.x * Math.cos(a) - start.y * Math.sin(a)) * k;
        py = m.falling.hy * C + (start.x * Math.sin(a) + start.y * Math.cos(a)) * k;
        shrink = m.falling.t >= 1 ? 0 : Math.pow(1 - ease, 1.4);
        darken = Math.min(1, ease * 1.15);
      } else {
        const a = this.appear.get(m.id);
        if (a !== undefined) {
          const next = Math.min(1, a + dt / 0.6);
          if (next >= 1) this.appear.delete(m.id); else this.appear.set(m.id, next);
          const e = 1 - (1 - next) * (1 - next);
          appear = Math.max(0.02, e);
          shrink = 0.55 + 0.45 * e;
          // Materialise glow gathering at the start spot.
          this.fxG.circle(m.x * C, m.y * C, radius * (2.1 - 1.1 * e)).fill({ color: 0xbfe3ff, alpha: 0.35 * (1 - e) });
        }
      }
      node.frame(px, py, radius, dt, lx, ly, { shrink, darken, appear, rolling: !m.falling });
    }
    this.particles.draw(this.fxG);
  }

  private drawWall(
    g: Graphics, index: number, x: number, y: number, belowIsWall: boolean, erodible: boolean, hp: number, flash: number,
    shadow: Pt, south: Pt
  ): void {
    const key = `wall-${Math.floor(cellHash(index, 3) * 4)}` as VaultSpriteKey;
    const tint = erodible ? EROD_TINT : 0xffffff;
    if (this.wallStamps.put(key, x, y, C, C, 1, tint)) {
      // Flat block: soft offset shadow on the floor, a thin dark lip on its screen-south edge, then the painted top.
      this.shadowStamps.put("wall-shadow", x - SHADOW_PAD + shadow.x, y - SHADOW_PAD + shadow.y, C + SHADOW_PAD * 2, C + SHADOW_PAD * 2, 0.55);
      const i = BLOCK_INSET;
      g.roundRect(x + i + south.x * BLOCK_LIP, y + i + south.y * BLOCK_LIP, C - i * 2, C - i * 2, 7).fill({ color: erodible ? 0x2a1810 : 0x17181d });
      if (erodible) {
        this.drawErodibleOverlay(index, x, y, hp, flash, 1 + Math.round((1 - hp) * 5));
      }
      return;
    }
    const base = erodible ? COLORS.erodible : COLORS.wall;
    g.rect(x, y, C, C).fill({ color: base });
    // Bevelled stone: lit top edge, dark face where the wall meets open floor below.
    g.rect(x, y, C, 7).fill({ color: erodible ? 0xa8805a : COLORS.wallTop });
    g.rect(x, y + 7, C, 2).fill({ color: 0x000000, alpha: 0.28 });
    if (!belowIsWall) g.rect(x, y + C - 12, C, 12).fill({ color: erodible ? 0x4a3420 : COLORS.wallFace, alpha: 0.85 });
    g.moveTo(x, y + C / 2).lineTo(x + C, y + C / 2).stroke({ color: 0x000000, width: 2, alpha: 0.2 });
    if (erodible) {
      const cracks = Math.round((1 - hp) * 6);
      for (let k = 0; k < cracks; k += 1) {
        const fx = x + 8 + ((k * 29) % (C - 16));
        g.moveTo(fx, y + 6).lineTo(fx + 10 - (k % 3) * 8, y + C * 0.5).lineTo(fx + 4, y + C - 6);
      }
      if (cracks > 0) g.stroke({ color: 0x1a120a, width: 3 });
      if (flash > 0) g.rect(x, y, C, C).fill({ color: 0xffffff, alpha: Math.min(0.5, flash * 3) });
    }
  }

  /** Cracks and the hit flash on an erodible block, above its painted top. */
  private drawErodibleOverlay(index: number, x: number, y: number, hp: number, flash: number, cracks: number): void {
    const g = this.fxG;
    const i = BLOCK_INSET;
    let seed = (index + 11) * 2654435761 >>> 0;
    const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let k = 0; k < cracks; k += 1) {
      let px = x + i + 8 + rnd() * (C - i * 2 - 16);
      let py = y + i + 6;
      g.moveTo(px, py);
      for (let step = 0; step < 4; step += 1) {
        px = Math.min(x + C - i - 4, Math.max(x + i + 4, px + (rnd() - 0.5) * 22));
        py += (C - i * 2 - 12) / 4;
        g.lineTo(px, py);
      }
    }
    if (cracks > 0) g.stroke({ color: 0x24140c, width: 2.5 + (1 - hp) * 1.5, alpha: 0.9 });
    if (flash > 0) g.roundRect(x + i, y + i, C - i * 2, C - i * 2, 7).fill({ color: 0xffffff, alpha: Math.min(0.5, flash * 3) });
  }

  private drawHole(g: Graphics, index: number, x: number, y: number): void {
    const cx = x + C / 2;
    const cy = y + C / 2;
    const reveal = this.holeReveal.get(index) ?? 1;
    const r = VAULT_TUNING.holeRadius * C;
    if (this.decoStamps.put("hole", x, y, C, C, reveal)) return;
    g.circle(cx, cy, (r + 7) * (0.8 + 0.2 * reveal)).fill({ color: 0x000000, alpha: 0.35 * reveal });
    g.circle(cx, cy, r + 4).fill({ color: COLORS.holeRim, alpha: reveal });
    g.circle(cx, cy - 1.5, r + 1).fill({ color: 0x1b2026, alpha: reveal });
    g.circle(cx, cy, r).fill({ color: COLORS.holeInner, alpha: reveal });
    g.circle(cx, cy + 1.5, r * 0.66).fill({ color: 0x000000, alpha: 0.7 * reveal });
    g.arc(cx, cy, r + 2, 0.15 * Math.PI, 0.85 * Math.PI).stroke({ color: 0xffffff, width: 2, alpha: 0.12 * reveal });
  }

  private drawCrackTile(g: Graphics, state: VaultState, index: number, x: number, y: number): void {
    // Stage 0 untouched, 1 stepped on, 2 about to give way.
    let stage = 0;
    for (const m of state.marbles) {
      if (m.onCrack !== index) continue;
      const d = Math.hypot(m.x - ((index % state.cols) + 0.5), m.y - (Math.floor(index / state.cols) + 0.5));
      stage = Math.max(stage, d > 0.4 ? 2 : 1);
    }
    const before = this.crackStage.get(index) ?? 0;
    if (stage !== before) {
      this.crackStage.set(index, stage);
      if (stage > before) {
        vaultSfx.crackStage();
        heartPuzzleHub().haptic(stage === 2 ? 14 : 8);
        this.particles.dust(x + C / 2, y + C / 2, stage === 2 ? 5 : 2, 24, 0x8a8372);
      }
    }
    const shake = stage === 2 ? Math.sin(this.clock * 70) * 1.3 : 0;
    const sag = stage === 2 ? 0.96 : 1;
    const inset = 3 + (C - 6) * (1 - sag) / 2;
    const sx = x + inset + shake;
    const sy = y + inset + (stage === 2 ? 1.5 : 0);
    const size = (C - 6) * sag;
    const stamped = this.decoStamps.put(`crack-${stage + 1}` as VaultSpriteKey, x, y, C, C);
    if (!stamped) {
      g.rect(sx + 2, sy + 3, size, size).fill({ color: 0x000000, alpha: 0.3 });
      g.rect(sx, sy, size, size).fill({ color: stage === 2 ? 0x2c2a25 : 0x3c3a34 });
      g.rect(sx, sy, size, 3).fill({ color: 0xffffff, alpha: 0.08 });
      const lines = crackLines(index);
      const visible = stage === 0 ? 2 : stage === 1 ? 4 : 7;
      for (let i = 0; i < visible; i += 1) {
        const pts = lines[i]!;
        g.moveTo(x + pts[0]!.x + shake, y + pts[0]!.y);
        for (let k = 1; k < pts.length; k += 1) g.lineTo(x + pts[k]!.x + shake, y + pts[k]!.y);
      }
      g.stroke({ color: stage === 0 ? COLORS.crack : 0xcdbf9a, width: stage === 0 ? 2 : 3, alpha: stage === 0 ? 0.75 : 1 });
      if (stage === 2) g.rect(sx, sy, size, size).fill({ color: 0x000000, alpha: 0.18 });
    }
    if (stage === 2 && Math.random() < 0.22) {
      this.particles.emit({ kind: "dust", x: x + 10 + Math.random() * (C - 20), y: y + 10 + Math.random() * (C - 20), vy: 14, max: 0.5, size: 3, color: 0x7d7370 });
    }
  }

  private drawPlate(g: Graphics, state: VaultState, i: number, dt: number): void {
    const plate = state.plates[i]!;
    const pressed = state.marbles.some((m) => m.kind === plate.kind && !m.falling
      && Math.hypot(m.x - plate.x, m.y - plate.y) < VAULT_TUNING.plateRadius
      && Math.hypot(m.vx, m.vy) < VAULT_TUNING.plateMaxSpeed);
    if (pressed !== this.platePressed[i]) {
      this.platePressed[i] = pressed;
      vaultSfx.plate(pressed);
      heartPuzzleHub().haptic(pressed ? 16 : 6);
      if (pressed) this.particles.ring(plate.x * C, plate.y * C, 10, 44, plate.kind === "light" ? COLORS.plateLight : COLORS.plateHeavy, 0.5);
    }
    const depth = this.plateDepth[i] ?? 0;
    this.plateDepth[i] = Math.min(1, Math.max(0, depth + (pressed ? 1 : -1) * dt * 9));
    const d = this.plateDepth[i]!;
    const color = plate.kind === "light" ? COLORS.plateLight : COLORS.plateHeavy;
    const px = plate.x * C;
    const py = plate.y * C;
    const R = VAULT_TUNING.plateRadius * C;
    if (this.decoStamps.put(d > 0.5 ? "plate-pressed" : "plate", px - C / 2, py - C / 2, C, C, 1, PLATE_TINT[plate.kind])) {
      // The plate's kind as a coloured rim (blue light, orange heavy), brighter while held.
      const pulse = 0.5 + 0.5 * Math.sin(this.clock * 4);
      g.roundRect(px - C * 0.3, py - C * 0.3, C * 0.6, C * 0.6, 6).stroke({ color, width: 3, alpha: 0.55 + d * (0.25 + 0.2 * pulse) });
      return;
    }
    // Recess in the floor, then the plate sitting proud (unpressed) or flush (pressed).
    g.circle(px, py, R + 7).fill({ color: 0x000000, alpha: 0.5 });
    g.circle(px, py, R + 5).fill({ color: 0x1a1e23 });
    const lift = (1 - d) * 4;
    g.circle(px, py + lift * 0.6, R * (1 - 0.06 * d)).fill({ color: 0x15181c });
    g.circle(px, py - lift * 0.4, R * (1 - 0.06 * d)).fill({ color, alpha: 0.55 + 0.4 * d });
    g.circle(px, py - lift * 0.4, R * (0.62 - 0.05 * d)).stroke({ color: 0xffffff, width: 2, alpha: 0.25 + 0.55 * d });
    g.arc(px, py - lift * 0.4, R * 0.86, 1.15 * Math.PI, 1.75 * Math.PI).stroke({ color: 0xffffff, width: 2, alpha: 0.22 * (1 - d) });
    if (d > 0.05) {
      const pulse = 0.5 + 0.5 * Math.sin(this.clock * 4);
      g.circle(px, py, R + 12 + pulse * 3).fill({ color, alpha: d * (0.12 + 0.08 * pulse) });
      g.circle(px, py, R + 8).stroke({ color, width: 3, alpha: d * 0.8 });
    }
  }

  private drawGoal(g: Graphics, goal: Pt, solved: boolean): void {
    const px = goal.x * C;
    const py = goal.y * C;
    const R = VAULT_TUNING.goalRadius * C;
    if (this.decoStamps.put(solved ? "seal-open" : "goal", px - C * 0.5, py - C * 0.56, C, C)) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 2.2);
    g.circle(px, py, R + 16 + pulse * 4).fill({ color: COLORS.goal, alpha: 0.06 + 0.05 * pulse });
    g.circle(px, py, R + 6).stroke({ color: COLORS.goal, width: 4, alpha: 0.9 });
    g.circle(px, py, R - 6).fill({ color: COLORS.goal, alpha: solved ? 0.6 : 0.25 + 0.1 * pulse });
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2 + this.clock * 0.25;
      g.moveTo(px + Math.cos(a) * (R + 10), py + Math.sin(a) * (R + 10)).lineTo(px + Math.cos(a) * (R + 17), py + Math.sin(a) * (R + 17));
    }
    g.stroke({ color: COLORS.goal, width: 2, alpha: 0.7 });
  }

  /** Board point (relative to the board origin) to the room frame, following the turning floor. */
  private toRoom(state: VaultState, origin: Pt, w: number, h: number, p: Pt): Pt {
    const bc = { x: origin.x + w / 2, y: origin.y + h / 2 };
    const rx = origin.x + p.x - bc.x;
    const ry = origin.y + p.y - bc.y;
    const c = Math.cos(state.angle);
    const s = Math.sin(state.angle);
    return { x: bc.x + rx * c - ry * s, y: bc.y + rx * s + ry * c };
  }

  /** Room frame to board pixels (inverse of toRoom), so particles share the board layer. */
  private fromRoom(state: VaultState, origin: Pt, w: number, h: number, p: Pt): Pt {
    const bc = { x: origin.x + w / 2, y: origin.y + h / 2 };
    const rx = p.x - bc.x;
    const ry = p.y - bc.y;
    const c = Math.cos(-state.angle);
    const s = Math.sin(-state.angle);
    return { x: bc.x + rx * c - ry * s - origin.x, y: bc.y + rx * s + ry * c - origin.y };
  }

  private flareAt(state: VaultState, origin: Pt, w: number, h: number, p: Pt): void {
    const b = this.fromRoom(state, origin, w, h, p);
    this.particles.ring(b.x, b.y, 8, 70, COLORS.channel, 0.6);
    this.particles.ring(b.x, b.y, 8, 110, 0xffffff, 0.8);
    this.particles.spark(b.x, b.y, 22, 170, COLORS.channel, 0.9);
  }

  /** Solve sequence: light runs along the board channel to the seal, the seal flares, then the door (or the Heart) answers. */
  private drawSolve(
    state: VaultState, origin: Pt, w: number, h: number,
    seal: Readonly<{ x: number; y: number }> | undefined, door: Readonly<{ x: number; y: number }> | undefined,
    dt: number, solvedByServer: boolean
  ): void {
    const g = this.roomG;
    g.clear();
    this.roomStamps.begin();
    if (state.status === "won" && !this.solve) {
      const target = state.goal ?? centroid(state.plates);
      this.solve = { t: 0, target: { x: target.x * C, y: target.y * C }, doorFired: false, flared: false, heart: !door };
    }
    const solve = this.solve;
    const open = !!solve || solvedByServer;
    if (seal) {
      const glow = solve ? Math.min(1, Math.max(0, (solve.t - 1.1) / 0.5)) : solvedByServer ? 1 : 0;
      if (!this.roomStamps.put(open ? "seal-open" : "seal", seal.x - 50, seal.y - 62, 100, 100)) {
        const spin = solve ? solve.t * (1.5 - Math.min(1, solve.t / 3)) : 0;
        const col = open ? 0xff9a55 : 0x7a3a2a;
        g.circle(seal.x, seal.y, 54).stroke({ color: col, width: 3, alpha: open ? 0.4 + 0.5 * glow : 0.6 });
        for (let i = 0; i < 12; i += 1) {
          const a = (i / 12) * Math.PI * 2 + spin;
          g.moveTo(seal.x + Math.cos(a) * 46, seal.y + Math.sin(a) * 46).lineTo(seal.x + Math.cos(a) * 60, seal.y + Math.sin(a) * 60);
        }
        g.stroke({ color: col, width: 3, alpha: open ? 0.5 + 0.5 * glow : 0.5 });
        if (glow > 0) g.circle(seal.x, seal.y, 70).fill({ color: 0xff9a55, alpha: 0.18 * glow });
      }
    }
    if (solve) {
      solve.t += dt;
      const t = solve.t;
      const pad = 24;
      const x0 = -pad; const y0 = -pad; const x1 = state.cols * C + pad; const y1 = state.rows * C + pad;
      const perimeter = 2 * ((x1 - x0) + (y1 - y0));
      const at = (d: number): Pt => {
        let k = ((d % perimeter) + perimeter) % perimeter;
        if (k < x1 - x0) return { x: x0 + k, y: y0 };
        k -= x1 - x0;
        if (k < y1 - y0) return { x: x1, y: y0 + k };
        k -= y1 - y0;
        if (k < x1 - x0) return { x: x1 - k, y: y1 };
        k -= x1 - x0;
        return { x: x0, y: y1 - k };
      };
      const nearest = (p: Pt): number => {
        const cx = Math.min(x1, Math.max(x0, p.x));
        const cy = Math.min(y1, Math.max(y0, p.y));
        const dl = [cy - y0, x1 - cx, y1 - cy, cx - x0];
        const side = dl.indexOf(Math.min(...dl));
        if (side === 0) return cx - x0;
        if (side === 1) return (x1 - x0) + (cy - y0);
        if (side === 2) return (x1 - x0) + (y1 - y0) + (x1 - cx);
        return 2 * (x1 - x0) + (y1 - y0) + (y1 - cy);
      };
      const sealBoard = seal ? { x: seal.x - origin.x, y: seal.y - origin.y } : { x: state.cols * C, y: state.rows * C };
      const start = nearest(solve.target);
      const end = nearest(sealBoard);
      const cw = (((end - start) % perimeter) + perimeter) % perimeter;
      const arms: Array<{ dir: 1 | -1; len: number }> = [{ dir: 1, len: cw }, { dir: -1, len: perimeter - cw }];
      const run = 2.0;
      const k = Math.min(1, t / run);
      const head = k * k * (3 - 2 * k);
      const afterglow = k < 1 ? 1 : Math.max(0.25, 1 - (t - run) / 1.2);
      for (const arm of arms) {
        const travelled = arm.len * head;
        const segs = Math.max(2, Math.round(travelled / 14));
        for (let i = 0; i < segs; i += 1) {
          const a = start + arm.dir * (travelled * i) / segs;
          const b = start + arm.dir * (travelled * (i + 1)) / segs;
          const pa = this.toRoom(state, origin, w, h, at(a));
          const pb = this.toRoom(state, origin, w, h, at(b));
          g.moveTo(pa.x, pa.y).lineTo(pb.x, pb.y).stroke({ color: COLORS.channel, width: 9, alpha: 0.18 + 0.7 * ((i + 1) / segs) * afterglow });
        }
        if (k < 1) {
          const hp = this.toRoom(state, origin, w, h, at(start + arm.dir * travelled));
          g.circle(hp.x, hp.y, 20).fill({ color: COLORS.channel, alpha: 0.35 });
          g.circle(hp.x, hp.y, 8).fill({ color: 0xffffff, alpha: 0.95 });
          if (Math.random() < 0.7) {
            const bp = this.fromRoom(state, origin, w, h, hp);
            this.particles.spark(bp.x, bp.y, 1, 40, COLORS.channel, 0.45);
          }
        }
      }
      // A spark carries the light from the end of the channel into the seal.
      const endRoom = this.toRoom(state, origin, w, h, at(end));
      const sealPos: Pt = seal ? { x: seal.x, y: seal.y } : endRoom;
      if (t >= run && t < run + 0.35) {
        const u = (t - run) / 0.35;
        const p = { x: endRoom.x + (sealPos.x - endRoom.x) * u, y: endRoom.y + (sealPos.y - endRoom.y) * u };
        g.circle(p.x, p.y, 12).fill({ color: COLORS.channel, alpha: 0.4 });
        g.circle(p.x, p.y, 5).fill({ color: 0xffffff });
      }
      if (t >= run + 0.35 && !solve.flared) {
        solve.flared = true;
        this.flareAt(state, origin, w, h, sealPos);
      }
      if (door && !solve.heart) {
        const doorStart = run + 0.55;
        if (t >= doorStart && t < doorStart + 0.45) {
          const u = (t - doorStart) / 0.45;
          const p = { x: sealPos.x + (door.x - sealPos.x) * u, y: sealPos.y + (door.y - sealPos.y) * u };
          g.circle(p.x, p.y, 10).fill({ color: COLORS.channel, alpha: 0.4 });
          g.circle(p.x, p.y, 4).fill({ color: 0xffffff });
        }
        if (t >= doorStart + 0.45 && !solve.doorFired) {
          solve.doorFired = true;
          vaultSfx.doorUnlock();
          heartPuzzleHub().haptic([30, 30, 60, 20, 90]);
          const dp = this.fromRoom(state, origin, w, h, { x: door.x, y: door.y });
          this.particles.dust(dp.x, dp.y, 26, 110, 0xb8ab90);
          this.particles.chips(dp.x, dp.y, 10, 0, 1, 160, 0x7a7266);
          this.particles.ring(dp.x, dp.y, 10, 90, COLORS.channel, 0.7);
          this.particles.spark(dp.x, dp.y, 18, 160, COLORS.channel, 0.9);
        }
        if (t >= doorStart + 0.45 && t < doorStart + 1.6) {
          const u = (t - doorStart - 0.45) / 1.15;
          g.circle(door.x, door.y, 70 * (0.6 + 0.4 * u)).fill({ color: COLORS.channel, alpha: 0.28 * (1 - u) });
          g.rect(door.x - 34, door.y - 70 * (1 - u * 0.3), 68, 70).fill({ color: 0xffd2a0, alpha: 0.16 * (1 - u) });
        }
      } else if (solve.heart && t >= run + 0.35 && !solve.doorFired) {
        // The Heart room has no door: a celebration beat at the goal instead.
        solve.doorFired = true;
        vaultSfx.celebrate();
        heartPuzzleHub().haptic([40, 40, 40, 40, 90, 60, 140]);
        const c = solve.target;
        for (let i = 0; i < 4; i += 1) this.particles.ring(c.x, c.y, 12, 90 + i * 55, COLORS.channel, 0.8 + i * 0.15);
        this.particles.spark(c.x, c.y, 60, 260, COLORS.channel, 1.4);
        this.particles.spark(c.x, c.y, 30, 160, 0xffffff, 1.2);
      }
      if (solve.heart && t >= run + 0.35 && t < run + 2.2) {
        const u = (t - run - 0.35) / 1.85;
        const c = this.toRoom(state, origin, w, h, solve.target);
        g.circle(c.x, c.y, 80 + 220 * u).fill({ color: COLORS.channel, alpha: 0.2 * (1 - u) });
      }
    }
    this.roomStamps.end();
  }

  /**
   * The painted exit door: clearly barred while the seal is closed; once it opens, an ember glow pulses on the door,
   * a beam of light rises from it and an arrow bobs above it, for as long as the player is in the room.
   */
  private drawDoor(roomId: string, door: Readonly<{ x: number; y: number }> | undefined, unlocked: boolean): void {
    const g = this.doorG;
    const glow = this.doorGlowG;
    g.clear();
    glow.clear();
    const art = VAULT_DOOR_ART[roomId];
    if (!door || !art) return;
    const cx = door.x + art.dx;
    const cy = door.y + art.dy;
    const hw = art.w / 2;
    const hh = art.h / 2;
    const top = cy - hh;
    const archR = hw;
    const doorShape = (target: Graphics, inset: number): Graphics => target
      .moveTo(cx - hw + inset, cy + hh)
      .lineTo(cx - hw + inset, top + archR)
      .arc(cx, top + archR, archR - inset, Math.PI, 0)
      .lineTo(cx + hw - inset, cy + hh)
      .closePath();
    if (!unlocked) {
      // Sealed: the doorway darkens and two iron bars with a padlock cross it.
      doorShape(g, 6).fill({ color: 0x120a08, alpha: 0.42 });
      for (const y of [cy - hh * 0.15, cy + hh * 0.45]) {
        g.roundRect(cx - hw - 6, y - 7, art.w + 12, 14, 4).fill({ color: 0x2f2a2a }).stroke({ color: 0x0d0b0b, width: 2.5 });
        for (const x of [cx - hw + 4, cx + hw - 4]) g.circle(x, y, 3).fill({ color: 0x8c8580 });
      }
      const ly = cy + hh * 0.15;
      g.roundRect(cx - 15, ly - 4, 30, 24, 5).fill({ color: 0x3a3433 }).stroke({ color: 0x0d0b0b, width: 2.5 });
      // The shackle is an explicit polyline with round joins: arc() after moveTo() left a zero-length first
      // segment whose miter spiked a long diagonal line across the room at phone zoom.
      const shackle = (target: Graphics): Graphics => {
        for (let i = 0; i <= 12; i += 1) {
          const a = Math.PI + (Math.PI * i) / 12;
          const x = cx + Math.cos(a) * 10;
          const y = ly - 4 + Math.sin(a) * 10;
          if (i === 0) target.moveTo(x, y); else target.lineTo(x, y);
        }
        return target;
      };
      shackle(g).stroke({ color: 0x2f2a2a, width: 5, join: "round", cap: "round" });
      shackle(g).stroke({ color: 0x0d0b0b, width: 1.5, alpha: 0.6, join: "round", cap: "round" });
      g.circle(cx, ly + 6, 3.2).fill({ color: 0x0d0b0b });
      g.rect(cx - 1.4, ly + 6, 2.8, 8).fill({ color: 0x0d0b0b });
      return;
    }
    // Open: a pulsing ember glow on the door, a soft halo, a beam rising into the room and a bobbing arrow.
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 3.2);
    // The halo is cut flat at the door's foot (the bottom wall's edge), so none of it spills into the void below.
    for (let i = 0; i < 4; i += 1) {
      haloAbove(glow, cx, cy - art.h * 0.3, art.w * (0.7 + i * 0.28) * (0.92 + 0.08 * pulse), cy + hh)
        .fill({ color: COLORS.channel, alpha: (0.11 - i * 0.022) * (0.7 + 0.3 * pulse) });
    }
    doorShape(glow, 8).fill({ color: 0xffb070, alpha: 0.32 + 0.22 * pulse });
    doorShape(glow, 22).fill({ color: 0xffe2b8, alpha: 0.16 + 0.16 * pulse });
    const beamH = 260;
    for (let i = 0; i < 10; i += 1) {
      const y0 = cy + hh - (beamH * i) / 10;
      const k = 1 - i / 10;
      glow.rect(cx - hw * (0.62 + 0.25 * k), y0 - beamH / 10, art.w * (0.62 + 0.25 * k), beamH / 10).fill({ color: 0xffa860, alpha: 0.075 * k * (0.75 + 0.25 * pulse) });
    }
    const bob = Math.sin(this.clock * 4) * 9;
    const ay = top - 70 + bob;
    for (const [w2, a] of [[34, 0.35], [26, 1]] as const) {
      g.moveTo(cx - w2, ay - w2 * 0.55).lineTo(cx, ay + w2 * 0.45).lineTo(cx + w2, ay - w2 * 0.55)
        .stroke({ color: a < 1 ? 0x000000 : 0xffc27a, width: a < 1 ? 13 : 8, alpha: a, cap: "round", join: "round" });
    }
    glow.circle(cx, ay, 30).fill({ color: COLORS.channel, alpha: 0.18 + 0.12 * pulse });
  }

  private drawMotes(origin: Pt, w: number, h: number, dt: number): void {
    const g = this.motesG;
    g.clear();
    for (const m of this.motes) {
      m.x += m.vx * dt + Math.sin(this.clock * 0.6 + m.phase) * 0.0006;
      m.y += m.vy * dt;
      if (m.y < -0.05) m.y = 1.05;
      if (m.x < -0.05) m.x = 1.05;
      if (m.x > 1.05) m.x = -0.05;
      const tw = 0.5 + 0.5 * Math.sin(this.clock * 0.9 + m.phase * 3);
      g.circle(origin.x + m.x * w, origin.y + m.y * h, m.size).fill({ color: 0xf0e2c0, alpha: 0.06 + 0.2 * tw });
    }
  }

  /** Soft ember glow breathing slowly out of every hole, the goal and the seal. */
  private drawGlows(state: VaultState, seal: Readonly<{ x: number; y: number }> | undefined, solved: boolean): void {
    const g = this.glowG;
    g.clear();
    const breathe = 0.5 + 0.5 * Math.sin(this.clock * 1.1);
    const blob = (x: number, y: number, r: number, a: number): void => {
      for (let i = 0; i < 4; i += 1) g.circle(x, y, r * (1 - i * 0.22)).fill({ color: COLORS.ember, alpha: a * (0.35 + i * 0.22) });
    };
    for (let i = 0; i < state.cells.length; i += 1) {
      if (state.cells[i] !== "o") continue;
      const x = ((i % state.cols) + 0.5) * C;
      const y = (Math.floor(i / state.cols) + 0.5) * C;
      blob(x, y, 62 + breathe * 10, 0.07 + 0.04 * breathe);
    }
    if (state.goal) blob(state.goal.x * C, state.goal.y * C, 70 + breathe * 8, 0.07 + (solved ? 0.08 : 0));
    if (seal) {
      // The seal sits in the room frame; the board layer is rotated, so draw it on the room glow instead.
      this.sealGlow = { x: seal.x, y: seal.y, a: (solved || this.solve ? 0.2 : 0.07) + 0.05 * breathe };
    }
  }

  private sealGlow: { x: number; y: number; a: number } | null = null;

  /** Rising ember sparks, additive, drifting up across the whole room. */
  private drawEmbers(origin: Pt, w: number, h: number, dt: number): void {
    const g = this.embersG;
    g.clear();
    for (const e of this.embers) {
      e.x += (e.vx + Math.sin(this.clock * 0.9 + e.phase) * 0.012) * dt;
      e.y += e.vy * dt;
      if (e.y < -0.08) { e.y = 1.05; e.x = Math.random(); }
      const flicker = 0.55 + 0.45 * Math.sin(this.clock * 6 + e.phase * 5);
      const px = origin.x + e.x * w;
      const py = origin.y + e.y * h;
      g.circle(px, py, e.size * 3).fill({ color: COLORS.ember, alpha: 0.05 * flicker });
      g.circle(px, py, e.size).fill({ color: 0xffb070, alpha: 0.55 * flicker });
    }
    const sg = this.sealGlow;
    if (sg) {
      for (let i = 0; i < 4; i += 1) g.circle(sg.x, sg.y, 90 * (1 - i * 0.22)).fill({ color: COLORS.ember, alpha: sg.a * (0.35 + i * 0.2) });
    }
  }

  /** Warm dark vignette around the room edges so the vault reads as lit by its own embers. */
  private drawVignette(rw: number, rh: number, key: string): void {
    if (this.vignetteFor === key + rw + rh) return;
    this.vignetteFor = key + rw + rh;
    const g = this.vignetteG;
    g.clear();
    const steps = 14;
    for (let i = 0; i < steps; i += 1) {
      const inset = (i / steps) * Math.min(rw, rh) * 0.16;
      g.roundRect(-30 + inset, -30 + inset, rw + 60 - inset * 2, rh + 60 - inset * 2, 60).stroke({ color: 0x120604, width: (Math.min(rw, rh) * 0.16) / steps + 1, alpha: 0.012 + 0.005 * (steps - i) });
    }
  }

  private makeBubble(): Bubble {
    const root = new Container();
    root.visible = false;
    const bg = new Graphics();
    const font = "Georgia, 'Times New Roman', serif";
    const name = new Text({ text: "", style: { fontFamily: font, fontSize: 19, fontWeight: "bold", fill: 0x6c481f } });
    const text = new Text({ text: "", style: { fontFamily: font, fontSize: 23, fill: 0x37291f, wordWrap: true, wordWrapWidth: PELL_BUBBLE_W - 40, lineHeight: 29 } });
    root.addChild(bg, name, text);
    return { root, bg, text, name, shown: "" };
  }

  /** Old Pell's line, as a parchment speech bubble beside him. */
  private drawBubble(pell: Readonly<{ x: number; y: number }> | undefined): void {
    const b = this.bubble;
    const line = pellBubble();
    if (!line || !pell) { b.root.visible = false; return; }
    markPellBubbleDrawn();
    if (b.shown !== line.text) {
      b.shown = line.text;
      b.name.text = "Old Pell";
      b.text.text = line.text;
      const hgt = 18 + b.name.height + 6 + b.text.height + 18;
      b.name.position.set(20, 14);
      b.text.position.set(20, 14 + b.name.height + 6);
      b.bg.clear();
      b.bg.roundRect(3, 4, PELL_BUBBLE_W, hgt, 14).fill({ color: 0x000000, alpha: 0.25 });
      b.bg.roundRect(0, 0, PELL_BUBBLE_W, hgt, 14).fill({ color: 0xf0e4cb }).stroke({ color: 0x94692c, width: 4 });
      b.bg.roundRect(8, 8, PELL_BUBBLE_W - 16, hgt - 16, 9).stroke({ color: 0xb49a70, width: 1.5, alpha: 0.7 });
      // Tail toward Pell.
      b.bg.poly([2, 30, -30, 52, 2, 58]).fill({ color: 0xf0e4cb }).stroke({ color: 0x94692c, width: 4 });
      b.bg.rect(0, 33, 6, 22).fill({ color: 0xf0e4cb });
    }
    const now = performance.now();
    b.root.visible = true;
    b.root.alpha = Math.max(0, Math.min(1, (line.until - now) / 400, (now - line.from) / 180));
    b.root.position.set(pell.x + 62, pell.y - 28);
  }

  destroy(): void {
    this.unsubscribe();
    vaultSfx.stopLoops();
    this.container.destroy({ children: true });
  }
}

/** A disc of radius r round (x, y) with everything below maxY cut off along a flat chord. */
export function haloAbove(target: Graphics, x: number, y: number, r: number, maxY: number): Graphics {
  const d = maxY - y;
  if (d >= r) return target.circle(x, y, r);
  const below = Math.asin(Math.max(-1, Math.min(1, d / r)));
  const from = Math.PI - below;
  const to = 2 * Math.PI + below;
  const steps = 40;
  for (let i = 0; i <= steps; i += 1) {
    const a = from + ((to - from) * i) / steps;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) target.moveTo(px, py); else target.lineTo(px, py);
  }
  return target.closePath();
}
