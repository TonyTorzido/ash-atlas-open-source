import type { GatherActionKind } from "@ash-atlas/player-renderer";
import type { CollectibleNode, LatLon } from "@ash-atlas/shared";

/**
 * How the worked object reacts to each strike or pick: trees shake, plants
 * rustle, rocks jolt. Fishing and flag building have no target reaction.
 */
export type GatherReactionKind = "tree" | "plant" | "rock";

export function gatherReactionKind(kind: GatherActionKind): GatherReactionKind | null {
  return kind === "chop" ? "tree" : kind === "mine" ? "rock" : kind === "harvest" ? "plant" : null;
}

/**
 * Reaction tuning. Angles in degrees (a skew of the marker about its ground
 * point, so the base row never moves), offsets in screen px, times in ms.
 */
export const GATHER_REACTION_TUNING = {
  /** Tree: sways away from the hit and settles with a damped wobble. */
  tree: { durationMs: 850, degrees: 4.5, hz: 2.4, decayMs: 260 },
  /** Plant: a quick, light, bouncy jiggle with a small squash on the pick. */
  plant: { durationMs: 460, degrees: 3.5, hz: 6, decayMs: 120, squash: 0.035 },
  /** Rock: no sway; one hard nudge that snaps back with a single small rebound (owner: fewer vibrations). */
  rock: { durationMs: 140, px: 2, hz: 7, decayMs: 45 }
} as const;

/** Phase lead (radians) of the sway, so the first frame already shows the hit. */
const GATHER_REACTION_LEAD = 0.6;

/** Marker transform of a reaction; identity is skewX 0, scaleY 1, offsetX 0. */
export type GatherReactionPose = { skewX: number; scaleY: number; offsetX: number };

/**
 * Pose of a reaction elapsedMs after the impact. sign is the screen side the
 * object is struck toward (+1: it moves right). Returns false once settled
 * (out is then the identity).
 */
export function sampleGatherReaction(
  kind: GatherReactionKind,
  elapsedMs: number,
  sign: number,
  out: GatherReactionPose
): boolean {
  out.skewX = 0;
  out.scaleY = 1;
  out.offsetX = 0;
  if (!(elapsedMs >= 0)) return true;
  const tuning = GATHER_REACTION_TUNING[kind];
  if (elapsedMs >= tuning.durationMs) return false;
  // Fades to exactly zero at the end so the last frame is the untouched art.
  const tail = 1 - elapsedMs / tuning.durationMs;
  const decay = Math.exp(-elapsedMs / tuning.decayMs) * Math.min(1, tail * 4);
  // Phase-led so the object is already moving on the impact frame itself.
  const wave = Math.sin(2 * Math.PI * tuning.hz * elapsedMs / 1000 + GATHER_REACTION_LEAD);
  if (kind === "rock") {
    // Starts at full push away from the strike, then snaps back to rest.
    out.offsetX = sign * GATHER_REACTION_TUNING.rock.px * decay * Math.cos(2 * Math.PI * tuning.hz * elapsedMs / 1000);
    return true;
  }
  // Pixi skew.x leans the marker's vertical axis; negative leans the top right.
  const degrees = kind === "tree" ? GATHER_REACTION_TUNING.tree.degrees : GATHER_REACTION_TUNING.plant.degrees;
  out.skewX = -sign * degrees * Math.PI / 180 * decay * wave;
  if (kind === "plant") {
    out.scaleY = 1 - GATHER_REACTION_TUNING.plant.squash * decay * (0.5 + 0.5 * Math.cos(4 * Math.PI * tuning.hz * elapsedMs / 1000));
  }
  return true;
}

type Transformable = {
  destroyed: boolean;
  skew: { x: number };
  scale: { y: number };
  pivot: { x: number };
};

type ActiveReaction = { kind: GatherReactionKind; startedAtMs: number; sign: number; target: Transformable | null };

/**
 * The running reactions, one per struck object (a new strike restarts it).
 * Nothing runs and nothing allocates while no reaction is active.
 */
export class GatherTargetReactions {
  private readonly active = new Map<string, ActiveReaction>();
  private readonly pose: GatherReactionPose = { skewX: 0, scaleY: 1, offsetX: 0 };

  get size(): number {
    return this.active.size;
  }

  trigger(targetId: string, kind: GatherReactionKind, sign: number, nowMs: number): void {
    const existing = this.active.get(targetId);
    if (existing) {
      existing.kind = kind;
      existing.startedAtMs = nowMs;
      existing.sign = sign;
      return;
    }
    this.active.set(targetId, { kind, startedAtMs: nowMs, sign, target: null });
  }

  /** Applies every running reaction to its marker (looked up each frame: markers are rebuilt on zoom). */
  update(nowMs: number, markerFor: (targetId: string) => Transformable | undefined): void {
    if (this.active.size === 0) return;
    const pose = this.pose;
    for (const [targetId, reaction] of this.active) {
      const marker = markerFor(targetId);
      if (reaction.target && reaction.target !== marker && !reaction.target.destroyed) reset(reaction.target);
      reaction.target = marker ?? null;
      const running = sampleGatherReaction(reaction.kind, nowMs - reaction.startedAtMs, reaction.sign, pose);
      if (marker && !marker.destroyed) {
        marker.skew.x = pose.skewX;
        marker.scale.y = pose.scaleY;
        // A pivot shift moves the art without touching the position the layer sets.
        marker.pivot.x = 0 - pose.offsetX;
      }
      if (!running) this.active.delete(targetId);
    }
  }

  clear(): void {
    for (const reaction of this.active.values()) {
      if (reaction.target && !reaction.target.destroyed) reset(reaction.target);
    }
    this.active.clear();
  }
}

function reset(marker: Transformable): void {
  marker.skew.x = 0;
  marker.scale.y = 1;
  marker.pivot.x = 0;
}

/**
 * The collectible being worked at a gathering target point (remote players
 * only carry the point). Exact match first, else the nearest within a metre
 * or so; null when none is near.
 */
export function collectibleAtGatherTarget(
  collectibles: readonly Pick<CollectibleNode, "id" | "lat" | "lon">[],
  target: LatLon
): string | null {
  let best: string | null = null;
  let bestDistance = 2e-5 * 2e-5;
  for (const collectible of collectibles) {
    const dLat = collectible.lat - target.lat;
    const dLon = collectible.lon - target.lon;
    const distance = dLat * dLat + dLon * dLon;
    if (distance === 0) return collectible.id;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = collectible.id;
    }
  }
  return best;
}
