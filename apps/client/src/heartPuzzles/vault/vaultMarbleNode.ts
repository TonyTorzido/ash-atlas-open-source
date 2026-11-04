/**
 * One marble as a small scene node: a soft contact shadow, a body that squashes
 * on wall hits, a surface whose pattern rotates as the ball rolls (a real 3D
 * rotation, so bands and spots foreshorten) and a specular highlight that stays
 * lit toward the room light however the surface turns. With the `marble` art
 * the painted ball's veins become a sphere surface rendered through the same 3D
 * orientation (vaultMarbleSphere), so it visibly rolls; the outline, shading,
 * painted highlight and contact shadow stay put.
 */
import { Container, Graphics, Sprite, Texture } from "pixi.js";

import { VAULT_MARBLE_CANVAS_RATIO, vaultTexture } from "./vaultAssets.js";
import { buildMarbleSurface, renderMarbleSphere, type MarbleSurface } from "./vaultMarbleSphere.js";

/** Rendered ball size in canvas pixels (drawn at 2 * radius board units). */
const SPHERE_PX = 72;
/** Painted ball radius on the 216 px art canvas. */
const ART_BALL_RADIUS = 84;
const surfaces = new WeakMap<Texture, MarbleSurface | null>();

/** The surface map for the painted ball, built once per texture from its pixels; null if it cannot be read. */
const surfaceFor = (tex: Texture): MarbleSurface | null => {
  const hit = surfaces.get(tex);
  if (hit !== undefined) return hit;
  let surface: MarbleSurface | null = null;
  try {
    const resource = (tex.source as unknown as { resource?: CanvasImageSource }).resource;
    if (resource && typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = tex.source.pixelWidth || 216;
      canvas.height = tex.source.pixelHeight || 216;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(resource, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        surface = buildMarbleSurface(data, canvas.width, canvas.height, ART_BALL_RADIUS * (canvas.width / 216));
      }
    }
  } catch {
    surface = null;
  }
  surfaces.set(tex, surface);
  return surface;
};
import type { MarbleKind } from "./vaultTypes.js";

type Mat3 = [number, number, number, number, number, number, number, number, number];

const BASE: Readonly<Record<MarbleKind, Readonly<{ body: number; dark: number; mark: number; markDark: number }>>> = {
  light: { body: 0xdde6f0, dark: 0x8fa0b4, mark: 0x5e86b8, markDark: 0x3e5c86 },
  heavy: { body: 0x8a97a8, dark: 0x4a5463, mark: 0xc9d2de, markDark: 0x2e3642 },
  big: { body: 0xcf9f5a, dark: 0x7e5528, mark: 0xf0d79a, markDark: 0x4e3015 }
};

/** Multiplied over the painted (white veined) ball per kind. */
const ART_TINT: Readonly<Record<MarbleKind, number>> = { light: 0xffffff, heavy: 0x8f9cb0, big: 0xf2c27a };

/** Fixed points on the sphere (golden spiral) used as the surface speckle. */
const SPOTS: ReadonlyArray<readonly [number, number, number]> = Array.from({ length: 16 }, (_, i) => {
  const y = 1 - (i + 0.5) / 8;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const a = i * 2.399963;
  return [Math.cos(a) * r, y, Math.sin(a) * r] as const;
});

const mul = (a: Mat3, b: Mat3): Mat3 => {
  const o: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return o;
};

/** Rodrigues rotation about a unit axis (ax, ay, 0). */
const axisAngle = (ax: number, ay: number, angle: number): Mat3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [t * ax * ax + c, t * ax * ay, ay * s, t * ax * ay, t * ay * ay + c, -ax * s, -ay * s, ax * s, c];
};

export type MarbleFrameOptions = Readonly<{
  /** 1 normally, down to 0 while falling into a hole. */
  shrink: number;
  /** 0..1 fade to black while falling. */
  darken: number;
  /** 0..1 materialise alpha. */
  appear: number;
  rolling: boolean;
}>;

export class VaultMarbleNode {
  readonly root = new Container();
  private readonly shadow = new Graphics();
  private readonly body = new Container();
  private readonly disc = new Graphics();
  private readonly surface = new Graphics();
  private readonly art = new Sprite();
  private readonly artShadow = new Sprite();
  private readonly artHighlight = new Sprite();
  private readonly highlight = new Graphics();
  private orient: Mat3 = axisAngle(0.6, 0.8, Math.random() * 6);
  /** The rolled sphere: a small canvas re-rendered whenever the orientation changes. */
  private sphere: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; image: ImageData; texture: Texture } | null = null;
  private sphereOrient: Mat3 | null = null;
  private prevX = Number.NaN;
  private prevY = Number.NaN;
  /** Squash impulse 0..1 and the wall normal it pushes along. */
  private squash = 0;
  private squashAngle = 0;

  constructor(readonly id: string, private readonly kind: MarbleKind) {
    for (const sprite of [this.art, this.artShadow, this.artHighlight]) {
      sprite.anchor.set(0.5);
      sprite.visible = false;
    }
    this.art.tint = ART_TINT[kind];
    this.body.addChild(this.disc, this.art, this.surface, this.artHighlight, this.highlight);
    this.root.addChild(this.shadow, this.artShadow, this.body);
  }

  hit(strength: number, nx: number, ny: number): void {
    this.squash = Math.max(this.squash, Math.min(1, 0.35 + strength));
    this.squashAngle = Math.atan2(ny, nx);
  }

  /** Forget the previous position (after a respawn) so the roll does not spin across the board. */
  resetTrail(): void {
    this.prevX = Number.NaN;
    this.prevY = Number.NaN;
  }

  /** Draw for this frame. Positions are board pixels; `lightX/Y` is the unit direction toward the light in board space. */
  frame(px: number, py: number, radius: number, dt: number, lightX: number, lightY: number, opts: MarbleFrameOptions): void {
    if (opts.rolling && Number.isFinite(this.prevX)) {
      const dx = px - this.prevX;
      const dy = py - this.prevY;
      const dist = Math.hypot(dx, dy);
      // Rolling without slipping: spin about the axis perpendicular to travel.
      if (dist > 1e-3 && dist < radius * 3) this.orient = mul(axisAngle(-dy / dist, dx / dist, dist / radius), this.orient);
    }
    this.prevX = px;
    this.prevY = py;
    this.squash = Math.max(0, this.squash - dt * 7);
    const q = this.squash * this.squash * 0.24;
    const s = Math.max(0.02, opts.shrink);

    this.root.position.set(px, py);
    this.root.alpha = opts.appear;
    this.root.visible = opts.shrink > 0.02 && opts.appear > 0.01;
    this.body.rotation = this.squashAngle;
    this.body.scale.set((1 - q) * s, (1 + q * 0.7) * s);
    const unrot = -this.squashAngle;
    this.surface.rotation = unrot;
    this.highlight.rotation = unrot;
    this.disc.rotation = unrot;
    const dark = Math.round(255 * (1 - opts.darken));
    this.body.tint = (dark << 16) | (dark << 8) | dark;

    const r = radius;
    const tex = vaultTexture("marble");
    if (tex) {
      this.drawArt(tex, r, s, unrot, opts);
      return;
    }
    this.art.visible = false;
    this.artShadow.visible = false;
    this.artHighlight.visible = false;
    // Contact shadow: a tight dark core under the ball plus a soft penumbra away from the light.
    const sh = this.shadow;
    sh.clear();
    const fade = 1 - opts.darken * 0.6;
    for (let i = 0; i < 5; i += 1) {
      const k = 1 + i * 0.16;
      const o = r * 0.34 * s * (1 + i * 0.12);
      sh.ellipse(-lightX * o, -lightY * o + r * 0.14 * s, r * 0.98 * k * s, r * 0.82 * k * s).fill({ color: 0x000000, alpha: 0.09 * fade });
    }
    sh.ellipse(-lightX * r * 0.08, -lightY * r * 0.08 + r * 0.1 * s, r * 0.82 * s, r * 0.7 * s).fill({ color: 0x000000, alpha: 0.38 * fade });

    const colors = BASE[this.kind];
    const d = this.disc;
    d.clear();
    const surf = this.surface;
    surf.clear();
    d.circle(0, 0, r).fill({ color: colors.dark });
    d.circle(-lightX * r * 0.08, -lightY * r * 0.08, r * 0.9).fill({ color: colors.body });
    this.drawSurface(surf, r, colors);

    // Specular highlight: fixed toward the light, independent of the rolling surface.
    const hl = this.highlight;
    hl.clear();
    const hx = lightX * r * 0.38;
    const hy = lightY * r * 0.38;
    hl.circle(hx, hy, r * 0.34).fill({ color: 0xffffff, alpha: 0.16 });
    hl.circle(hx, hy, r * 0.2).fill({ color: 0xffffff, alpha: 0.34 });
    hl.ellipse(hx - lightX * r * 0.03, hy - lightY * r * 0.03, r * 0.1, r * 0.07).fill({ color: 0xffffff, alpha: 0.95 });
    // Dark rim on the shadow side keeps the ball round against stone.
    const away = Math.atan2(-lightY, -lightX);
    hl.arc(0, 0, r - 1, away - 0.9, away + 0.9).stroke({ color: 0x000000, width: Math.max(1.5, r * 0.09), alpha: 0.28 });
  }

  /** The painted ball: it turns with the roll; the painted highlight and shadow keep the screen light. */
  private drawArt(tex: Texture, r: number, s: number, unrot: number, opts: MarbleFrameOptions): void {
    this.shadow.clear();
    this.disc.clear();
    this.surface.clear();
    this.highlight.clear();
    const size = r * 2 * VAULT_MARBLE_CANVAS_RATIO;
    this.art.visible = true;
    const surface = surfaceFor(tex);
    if (surface && typeof document !== "undefined") {
      if (!this.sphere) {
        const canvas = document.createElement("canvas");
        canvas.width = SPHERE_PX;
        canvas.height = SPHERE_PX;
        const ctx = canvas.getContext("2d");
        if (ctx) this.sphere = { canvas, ctx, image: ctx.createImageData(SPHERE_PX, SPHERE_PX), texture: Texture.from(canvas) };
      }
    }
    if (surface && this.sphere) {
      if (this.sphereOrient !== this.orient) {
        renderMarbleSphere(this.sphere.image.data, SPHERE_PX, this.orient, surface);
        this.sphere.ctx.putImageData(this.sphere.image, 0, 0);
        this.sphere.texture.source.update();
        this.sphereOrient = this.orient;
      }
      // The sphere canvas is the ball itself (the art canvas pads the ball), and it never spins as a flat disc.
      this.art.texture = this.sphere.texture;
      this.art.width = r * 2;
      this.art.height = r * 2;
      this.art.rotation = unrot;
    } else {
      this.art.texture = tex;
      this.art.width = size;
      this.art.height = size;
      this.art.rotation = unrot + Math.atan2(this.orient[3], this.orient[0]);
    }
    const hl = vaultTexture("marble-highlight");
    this.artHighlight.visible = !!hl;
    if (hl) {
      this.artHighlight.texture = hl;
      this.artHighlight.width = size;
      this.artHighlight.height = size;
      this.artHighlight.rotation = unrot;
    }
    const sh = vaultTexture("marble-shadow");
    this.artShadow.visible = !!sh;
    if (sh) {
      this.artShadow.texture = sh;
      this.artShadow.width = size * s;
      this.artShadow.height = size * s;
      this.artShadow.alpha = 0.75 * (1 - opts.darken * 0.6);
    }
  }

  private drawSurface(g: Graphics, r: number, colors: Readonly<{ mark: number; markDark: number }>): void {
    const m = this.orient;
    // Two great-circle bands that turn with the ball.
    for (const axisX of [false, true]) {
      let drawing = false;
      for (let i = 0; i <= 48; i += 1) {
        const a = (i / 48) * Math.PI * 2;
        const lx = axisX ? 0 : Math.cos(a);
        const ly = axisX ? Math.cos(a) : 0;
        const lz = Math.sin(a);
        const x = m[0] * lx + m[1] * ly + m[2] * lz;
        const y = m[3] * lx + m[4] * ly + m[5] * lz;
        const z = m[6] * lx + m[7] * ly + m[8] * lz;
        if (z > 0.04) {
          if (!drawing) { g.moveTo(x * r * 0.97, y * r * 0.97); drawing = true; } else g.lineTo(x * r * 0.97, y * r * 0.97);
        } else if (drawing) {
          g.stroke({ color: colors.mark, width: r * 0.2, alpha: 0.85 });
          drawing = false;
        }
      }
      if (drawing) g.stroke({ color: colors.mark, width: r * 0.2, alpha: 0.85 });
    }
    for (const [sx, sy, sz] of SPOTS) {
      const x = m[0] * sx + m[1] * sy + m[2] * sz;
      const y = m[3] * sx + m[4] * sy + m[5] * sz;
      const z = m[6] * sx + m[7] * sy + m[8] * sz;
      if (z <= 0.1) continue;
      g.ellipse(x * r * 0.94, y * r * 0.94, r * 0.11 * z, r * 0.11).fill({ color: colors.markDark, alpha: 0.55 * z });
    }
  }
}
