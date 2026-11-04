import type { CombatEvent, LatLon } from "@ash-atlas/shared";

/**
 * One-shot pet ability visuals (Tail Lash sweep, Squall Burst ring, Ember Spit, Rage, Mend, hit
 * flashes) from the server's PET_ABILITY_EFFECT combat events. Drawn at true ground scale into one
 * reused Graphics; reduced motion swaps every animation for a static fade.
 */
export type PetAbilityEffectKind = "sweep" | "gust" | "ember_spit" | "fury" | "mend" | "flash";

export type PetAbilityEffect = {
  readonly id: string;
  readonly kind: PetAbilityEffectKind;
  readonly position: LatLon;
  /** Where the effect starts (the pet) for projectiles and Mend's second pulse; null when unseen. */
  readonly origin: LatLon | null;
  readonly radiusM: number | null;
  readonly startedAtMs: number;
  readonly durationMs: number;
};

const MAX_ACTIVE_EFFECTS = 48;

export function petAbilityEffectKind(abilityId: string): PetAbilityEffectKind {
  switch (abilityId) {
    case "tail_lash": return "sweep";
    case "squall_burst": return "gust";
    case "ember_spit": return "ember_spit";
    case "fury": return "fury";
    case "mend": return "mend";
    default: return "flash";
  }
}

export class PetAbilityEffectState {
  private readonly active = new Map<string, PetAbilityEffect>();

  enqueue(events: readonly CombatEvent[], nowMs: number, originFor: (entityId: string) => LatLon | null): void {
    for (const event of events) {
      if (event.type !== "PET_ABILITY_EFFECT" || !event.abilityId || !event.position || !event.sourceEntityId) continue;
      if (this.active.size >= MAX_ACTIVE_EFFECTS) this.active.delete(this.active.keys().next().value!);
      const kind = petAbilityEffectKind(event.abilityId);
      this.active.set(event.eventId, {
        id: event.eventId,
        kind,
        position: { lat: event.position.lat, lon: event.position.lon },
        origin: kind === "ember_spit" || kind === "mend" ? originFor(event.sourceEntityId) : null,
        radiusM: event.radiusM ?? null,
        startedAtMs: nowMs,
        durationMs: event.durationMs ?? 500
      });
    }
  }

  /** Calls `draw` for each live effect with its 0..1 progress; finished effects are dropped. */
  forEach(nowMs: number, draw: (effect: PetAbilityEffect, progress: number) => void): void {
    for (const [id, effect] of this.active) {
      const progress = (nowMs - effect.startedAtMs) / effect.durationMs;
      if (progress >= 1) {
        this.active.delete(id);
        continue;
      }
      draw(effect, Math.max(0, progress));
    }
  }

  get size(): number {
    return this.active.size;
  }

  clear(): void {
    this.active.clear();
  }
}

type FillStyle = { color: number; alpha: number };
type StrokeStyle = { color: number; width: number; alpha: number };
/** The slice of a Pixi Graphics the effects use (kept small so tests can record calls). */
export interface PetEffectCanvas {
  circle(x: number, y: number, radius: number): this;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): this;
  moveTo(x: number, y: number): this;
  lineTo(x: number, y: number): this;
  fill(style: FillStyle): this;
  stroke(style: StrokeStyle): this;
}

export type PetEffectView = Readonly<{
  project(position: LatLon): Readonly<{ x: number; y: number }>;
  radiusPx(position: LatLon, radiusM: number): number;
  reducedMotion: boolean;
  /** Globe/overlay fade at the effect's position. */
  opacity(position: LatLon): number;
}>;

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const TAU = Math.PI * 2;

export function drawPetAbilityEffect(g: PetEffectCanvas, effect: PetAbilityEffect, progress: number, view: PetEffectView): void {
  const center = view.project(effect.position);
  const fade = (1 - progress) * view.opacity(effect.position);
  if (fade <= 0) return;
  const still = view.reducedMotion;
  const grow = still ? 1 : easeOut(progress);
  const radius = effect.radiusM === null ? 0 : view.radiusPx(effect.position, effect.radiusM);
  switch (effect.kind) {
    case "sweep": {
      // Drake colours: a shockwave ring out to the full radius with a sweeping crescent.
      const r = radius * grow;
      g.circle(center.x, center.y, r).fill({ color: 0xd9481f, alpha: 0.1 * fade })
        .circle(center.x, center.y, r).stroke({ color: 0xff7a2f, width: 5, alpha: 0.85 * fade });
      if (!still) {
        const start = -Math.PI / 2 + progress * TAU * 0.75;
        const arcR = r * 0.92;
        g.moveTo(center.x + Math.cos(start) * arcR, center.y + Math.sin(start) * arcR)
          .arc(center.x, center.y, arcR, start, start + Math.PI * 0.9)
          .stroke({ color: 0xffb347, width: 9, alpha: 0.9 * fade });
      }
      return;
    }
    case "gust": {
      const r = radius * grow;
      g.circle(center.x, center.y, r).fill({ color: 0xcfeaff, alpha: 0.08 * fade })
        .circle(center.x, center.y, r).stroke({ color: 0xcfeaff, width: 4, alpha: 0.8 * fade });
      if (!still) {
        const swirlR = r * 0.6;
        for (let i = 0; i < 3; i += 1) {
          const start = i * (TAU / 3) + progress * Math.PI;
          g.moveTo(center.x + Math.cos(start) * swirlR, center.y + Math.sin(start) * swirlR)
            .arc(center.x, center.y, swirlR, start, start + 0.9)
            .stroke({ color: 0xeef8ff, width: 3, alpha: 0.75 * fade });
        }
      }
      return;
    }
    case "ember_spit": {
      const flight = 0.4;
      if (!still && effect.origin && progress < flight) {
        const from = view.project(effect.origin);
        const q = progress / flight;
        const tail = Math.max(0, q - 0.3);
        const headX = from.x + (center.x - from.x) * q;
        const headY = from.y + (center.y - from.y) * q;
        g.moveTo(from.x + (center.x - from.x) * tail, from.y + (center.y - from.y) * tail)
          .lineTo(headX, headY)
          .stroke({ color: 0xffb347, width: 4, alpha: 0.7 })
          .circle(headX, headY, 7).fill({ color: 0xff7a2f, alpha: 0.95 })
          .circle(headX, headY, 7).stroke({ color: 0xfff0c2, width: 2, alpha: 0.9 });
        return;
      }
      const burst = still || !effect.origin ? progress : (progress - flight) / (1 - flight);
      const burstFade = (1 - burst) * view.opacity(effect.position);
      const r = radius * (still ? 1 : 0.4 + 0.6 * easeOut(burst));
      g.circle(center.x, center.y, r).fill({ color: 0xff6a00, alpha: 0.28 * burstFade })
        .circle(center.x, center.y, r).stroke({ color: 0xffb347, width: 4, alpha: 0.9 * burstFade });
      return;
    }
    case "fury": {
      g.circle(center.x, center.y, radius).fill({ color: 0xd62828, alpha: 0.08 * fade })
        .circle(center.x, center.y, radius).stroke({ color: 0xd62828, width: 4, alpha: 0.85 * fade });
      if (!still) {
        g.circle(center.x, center.y, radius * (0.6 + 0.4 * grow)).stroke({ color: 0xff8a7a, width: 2, alpha: 0.6 * fade });
      }
      return;
    }
    case "mend": {
      const r = 22 * (still ? 1 : 0.6 + 0.4 * grow);
      g.circle(center.x, center.y, r).fill({ color: 0x7ddc8a, alpha: 0.25 * fade })
        .circle(center.x, center.y, r).stroke({ color: 0x7ddc8a, width: 3, alpha: 0.8 * fade });
      if (effect.origin) {
        const wisp = view.project(effect.origin);
        g.circle(wisp.x, wisp.y, r * 0.7).fill({ color: 0x7ddc8a, alpha: 0.22 * fade })
          .circle(wisp.x, wisp.y, r * 0.7).stroke({ color: 0xb8f0c0, width: 2, alpha: 0.7 * fade });
      }
      return;
    }
    case "flash": {
      const r = 12 * (still ? 1 : 1 + 0.5 * progress);
      g.circle(center.x, center.y, r).fill({ color: 0xfff3c4, alpha: 0.5 * fade })
        .circle(center.x, center.y, r).stroke({ color: 0xffffff, width: 2, alpha: 0.8 * fade });
      return;
    }
  }
}
