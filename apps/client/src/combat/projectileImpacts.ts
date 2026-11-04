import type { ProjectileTransform } from "@ash-atlas/shared";
import {
  projectileAimRadians,
  resolveProjectileSpriteTransform,
  type ProjectilePoint,
  type ProjectileSpriteTransform
} from "@ash-atlas/player-renderer";

export const PROJECTILE_IMPACT_LIFETIME_MS = 480;
export const MAX_ACTIVE_PROJECTILE_IMPACTS = 64;
export const MAX_SEEN_PROJECTILE_EVENT_IDS = 256;

export type ProjectileImpactInput = Readonly<{
  eventId: string;
  sourceEntityId: string;
  targetEntityId: string;
  assetKey: string;
  transform: ProjectileTransform;
  aimRadians: number;
  /** World position of a non-entity source (a firing tower); renderers project it. */
  sourcePosition?: Readonly<{ lat: number; lon: number }>;
}>;

export type ProjectileImpact = ProjectileImpactInput & Readonly<{
  createdAtMs: number;
  expiresAtMs: number;
}>;

/**
 * Resolves impact artwork using the same authored-axis and travel-direction
 * convention for every renderer. A missing source falls back to the
 * authoritative event aim, while coincident points are safely treated as zero.
 */
export function projectileImpactSpriteTransform(
  impact: Pick<ProjectileImpactInput, "transform" | "aimRadians">,
  sourcePoint: ProjectilePoint | null,
  targetPoint: ProjectilePoint,
  baseScale = 1
): ProjectileSpriteTransform {
  const aimRadians = sourcePoint
    ? projectileAimRadians(sourcePoint, targetPoint)
    : Number.isFinite(impact.aimRadians)
      ? impact.aimRadians
      : 0;
  return resolveProjectileSpriteTransform(
    impact.transform,
    aimRadians,
    targetPoint,
    baseScale
  );
}

export class ProjectileImpactState {
  private readonly seenEventIds = new Map<string, number>();
  private active: ProjectileImpact[] = [];

  enqueue(entries: readonly ProjectileImpactInput[], nowMs: number): number {
    this.prune(nowMs);
    let created = 0;
    for (const entry of entries) {
      if (
        !entry.eventId ||
        !entry.sourceEntityId ||
        !entry.targetEntityId ||
        !entry.assetKey ||
        !Number.isFinite(entry.aimRadians) ||
        this.seenEventIds.has(entry.eventId)
      ) continue;
      this.rememberEvent(entry.eventId, nowMs);
      this.active = this.active.filter((impact) =>
        impact.sourceEntityId !== entry.sourceEntityId ||
        impact.targetEntityId !== entry.targetEntityId
      );
      this.active.push({
        ...entry,
        createdAtMs: nowMs,
        expiresAtMs: nowMs + PROJECTILE_IMPACT_LIFETIME_MS
      });
      created += 1;
      if (this.active.length > MAX_ACTIVE_PROJECTILE_IMPACTS) {
        this.active.splice(0, this.active.length - MAX_ACTIVE_PROJECTILE_IMPACTS);
      }
    }
    return created;
  }

  prune(nowMs: number): void {
    this.active = this.active.filter((impact) => impact.expiresAtMs > nowMs);
  }

  removeEntities(entityIds: readonly string[]): void {
    if (entityIds.length === 0) return;
    const removed = new Set(entityIds);
    this.active = this.active.filter((impact) =>
      !removed.has(impact.sourceEntityId) && !removed.has(impact.targetEntityId)
    );
  }

  impacts(): readonly ProjectileImpact[] {
    return this.active;
  }

  has(eventId: string): boolean {
    return this.active.some((impact) => impact.eventId === eventId);
  }

  clear(): void {
    this.active = [];
    this.seenEventIds.clear();
  }

  private rememberEvent(eventId: string, nowMs: number): void {
    this.seenEventIds.set(eventId, nowMs);
    while (this.seenEventIds.size > MAX_SEEN_PROJECTILE_EVENT_IDS) {
      const oldest = this.seenEventIds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seenEventIds.delete(oldest);
    }
  }
}

export function projectileImpactPresentation(
  impact: ProjectileImpact,
  nowMs: number,
  reducedMotion: boolean
): Readonly<{ alpha: number }> {
  if (reducedMotion) return { alpha: 1 };
  const progress = Math.min(
    1,
    Math.max(0, (nowMs - impact.createdAtMs) / PROJECTILE_IMPACT_LIFETIME_MS)
  );
  return { alpha: progress < 0.7 ? 1 : 1 - (progress - 0.7) / 0.3 };
}
