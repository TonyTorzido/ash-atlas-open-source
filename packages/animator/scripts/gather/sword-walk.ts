// Sword walk (Phase 2 key poses, packages/animator/README.md): the live walk_in_place with the sword
// arm held out low and forward like drawn pose 00-ready (the walk-ready preview's 8 / 28 / 0 deg), the blade at the
// ready pose's angle (keyposes.json 00-ready deg). Shared by gather-clips-jacketb.ts (Jacket B sheets + the grip
// transform) and garment-layer-sheets.ts (the stock body + armour layers), so both derive the same clip.
export const SWORD_WALK = { frames: 28, arm: { upper_arm_l: 8, forearm_l: 28, hand_l: 0 }, readyDeg: 158.5 } as const;

/** The sword_walk animation derived from a rig's walk_in_place (a deep copy; the arm bones held at SWORD_WALK.arm). */
export function swordWalkFrom<T extends { bones: Record<string, { rotate?: unknown }> }>(walkInPlace: T): T {
  const walk = structuredClone(walkInPlace);
  for (const [bone, value] of Object.entries(SWORD_WALK.arm)) {
    const b = walk.bones[bone];
    if (!b) throw new Error(`sword_walk: walk_in_place has no ${bone} timeline`);
    b.rotate = [{ time: 0, value }];
  }
  return walk;
}
