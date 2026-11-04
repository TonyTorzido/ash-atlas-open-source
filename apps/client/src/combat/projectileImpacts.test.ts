import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  DEFAULT_PROJECTILE_TRANSFORM,
  projectilePresentationForAppearance
} from "@ash-atlas/shared";

import {
  SPRITE_PRESENTATION,
  dungeonProjectileBaseScale
} from "../map/spritePresentation.js";

import {
  PROJECTILE_IMPACT_LIFETIME_MS,
  ProjectileImpactState,
  projectileImpactPresentation,
  projectileImpactSpriteTransform
} from "./projectileImpacts.js";

describe("ProjectileImpactState", () => {
  it("deduplicates events and restarts one shooter's impact on the same target", () => {
    const state = new ProjectileImpactState();
    expect(state.enqueue([impact("one")], 100)).toBe(1);
    expect(state.enqueue([impact("one")], 110)).toBe(0);
    expect(state.enqueue([impact("two")], 120)).toBe(1);
    expect(state.impacts()).toHaveLength(1);
    expect(state.impacts()[0]).toMatchObject({
      eventId: "two",
      createdAtMs: 120,
      expiresAtMs: 120 + PROJECTILE_IMPACT_LIFETIME_MS
    });
  });

  it("keeps different shooters independent and removes disappeared entities", () => {
    const state = new ProjectileImpactState();
    state.enqueue([
      impact("one"),
      { ...impact("two"), sourceEntityId: "archer-2" }
    ], 0);
    expect(state.impacts()).toHaveLength(2);
    state.removeEntities(["archer-2"]);
    expect(state.impacts().map(({ eventId }) => eventId)).toEqual(["one"]);
    state.prune(PROJECTILE_IMPACT_LIFETIME_MS);
    expect(state.impacts()).toHaveLength(0);
  });

  it("keeps hit artwork alive for exactly twice the previous linger and cleans it up", () => {
    expect(PROJECTILE_IMPACT_LIFETIME_MS).toBe(240 * 2);
    const state = new ProjectileImpactState();
    state.enqueue([impact("lifetime")], 100);
    state.prune(100 + PROJECTILE_IMPACT_LIFETIME_MS - 1);
    expect(state.impacts()).toHaveLength(1);
    state.prune(100 + PROJECTILE_IMPACT_LIFETIME_MS);
    expect(state.impacts()).toHaveLength(0);
  });

  it("applies the dungeon player scale to every authored ranged PNG transform", () => {
    const baseScale = dungeonProjectileBaseScale(35);
    const rangedAppearances = DEFAULT_PLAYER_APPEARANCE_CATALOG.appearances.filter(
      ({ projectileAssetKey, projectileTransform }) => projectileAssetKey && projectileTransform
    );
    expect(rangedAppearances.length).toBeGreaterThan(0);
    for (const appearance of rangedAppearances) {
      const projectile = projectilePresentationForAppearance(appearance)!;
      const transformed = projectileImpactSpriteTransform(
        { transform: projectile.transform, aimRadians: 0 },
        null,
        { x: 0, y: 0 },
        baseScale
      );
      expect(transformed.scaleX).toBeCloseTo(
        projectile.transform.scaleX * 35 / SPRITE_PRESENTATION.player.baseHeightPx
      );
      expect(transformed.scaleY).toBeCloseTo(
        projectile.transform.scaleY * 35 / SPRITE_PRESENTATION.player.baseHeightPx
      );
    }
  });

  it("points right-authored artwork toward the target and fades only with motion enabled", () => {
    const state = new ProjectileImpactState();
    state.enqueue([impact("one")], 0);
    const entry = state.impacts()[0]!;
    const fadingAt = PROJECTILE_IMPACT_LIFETIME_MS * 0.9;
    expect(projectileImpactPresentation(entry, fadingAt, false).alpha).toBeLessThan(1);
    expect(projectileImpactPresentation(entry, fadingAt, true).alpha).toBe(1);
  });

  it.each([
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, 0],
    [{ x: 10, y: 0 }, { x: 0, y: 0 }, Math.PI],
    [{ x: 0, y: 0 }, { x: 0, y: -10 }, -Math.PI / 2],
    [{ x: 0, y: 0 }, { x: 10, y: 10 }, Math.PI / 4]
  ] as const)("uses the current source-to-target vector for %s", (source, target, expected) => {
    expect(projectileImpactSpriteTransform(
      impact("direction"),
      source,
      target
    ).rotationRadians).toBeCloseTo(expected);
  });

  it("uses the event aim when the source is unavailable and safely handles coincident points", () => {
    const entry = { ...impact("fallback"), aimRadians: Math.PI / 2 };
    expect(projectileImpactSpriteTransform(entry, null, { x: 1, y: 1 }).rotationRadians)
      .toBeCloseTo(Math.PI / 2);
    expect(projectileImpactSpriteTransform(
      entry,
      { x: 1, y: 1 },
      { x: 1, y: 1 }
    ).rotationRadians).toBe(0);
  });
});

function impact(eventId: string) {
  return {
    eventId,
    sourceEntityId: "archer",
    targetEntityId: "target",
    assetKey: "projectiles/arrow.png",
    transform: { ...DEFAULT_PROJECTILE_TRANSFORM },
    aimRadians: 0
  };
}
