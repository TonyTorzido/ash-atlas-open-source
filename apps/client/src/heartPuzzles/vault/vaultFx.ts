/** Small particle system for the vault board (room units, drawn into one Graphics). */
import type { Graphics } from "pixi.js";

export type ParticleKind = "dust" | "chip" | "spark" | "mote" | "ring";

export type Particle = {
  kind: ParticleKind;
  x: number; y: number; vx: number; vy: number;
  life: number; max: number;
  size: number; color: number;
  /** Drag per second and fall (room units/s^2, chips only). */
  drag: number; gravity: number;
  spin: number; rot: number;
  /** Rings grow to this radius. */
  grow: number;
};

const MAX_PARTICLES = 420;

export class ParticleField {
  readonly items: Particle[] = [];

  emit(p: Partial<Particle> & Pick<Particle, "kind" | "x" | "y" | "max" | "size" | "color">): void {
    if (this.items.length >= MAX_PARTICLES) this.items.shift();
    this.items.push({ vx: 0, vy: 0, life: 0, drag: 2, gravity: 0, spin: 0, rot: Math.random() * 6.28, grow: 0, ...p });
  }

  /** Puff of dust, drifting outward. */
  dust(x: number, y: number, count: number, spread: number, color = 0x9a9486): void {
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const s = spread * (0.25 + Math.random() * 0.75);
      this.emit({ kind: "dust", x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - spread * 0.1, max: 0.6 + Math.random() * 0.7, size: 5 + Math.random() * 8, color, drag: 2.4 });
    }
  }

  /** Stone chips thrown along a direction (nx, ny). */
  chips(x: number, y: number, count: number, nx: number, ny: number, speed: number, color = 0x6a625a): void {
    for (let i = 0; i < count; i += 1) {
      const a = Math.atan2(ny, nx) + (Math.random() - 0.5) * 1.8;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.emit({ kind: "chip", x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, max: 0.5 + Math.random() * 0.5, size: 2.5 + Math.random() * 4, color, drag: 1.2, gravity: 120, spin: (Math.random() - 0.5) * 18 });
    }
  }

  spark(x: number, y: number, count: number, speed: number, color: number, max = 0.7): void {
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.emit({ kind: "spark", x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, max: max * (0.6 + Math.random() * 0.6), size: 2 + Math.random() * 3, color, drag: 2.5 });
    }
  }

  ring(x: number, y: number, from: number, to: number, color: number, max = 0.5): void {
    this.emit({ kind: "ring", x, y, max, size: from, grow: to, color, drag: 0 });
  }

  step(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const p = this.items[i]!;
      p.life += dt;
      if (p.life >= p.max) { this.items.splice(i, 1); continue; }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy = p.vy * k + p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
  }

  draw(g: Graphics): void {
    for (const p of this.items) {
      const t = p.life / p.max;
      switch (p.kind) {
        case "dust":
          g.circle(p.x, p.y, p.size * (0.7 + t * 0.9)).fill({ color: p.color, alpha: 0.32 * (1 - t) });
          break;
        case "chip": {
          const s = p.size * (1 - t * 0.4);
          const c = Math.cos(p.rot) * s;
          const sn = Math.sin(p.rot) * s;
          g.poly([p.x - c, p.y - sn, p.x + sn, p.y - c, p.x + c, p.y + sn]).fill({ color: p.color, alpha: 1 - t * t });
          break;
        }
        case "spark":
          g.circle(p.x, p.y, p.size * (1 - t * 0.6)).fill({ color: p.color, alpha: 1 - t });
          g.circle(p.x, p.y, p.size * 2.2 * (1 - t)).fill({ color: p.color, alpha: 0.22 * (1 - t) });
          break;
        case "mote":
          g.circle(p.x, p.y, p.size).fill({ color: p.color, alpha: 0.5 * Math.sin(Math.PI * t) });
          break;
        case "ring":
          g.circle(p.x, p.y, p.size + (p.grow - p.size) * (1 - (1 - t) * (1 - t))).stroke({ color: p.color, width: 3, alpha: 0.9 * (1 - t) });
          break;
      }
    }
  }
}
