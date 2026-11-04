export type DodgeResolution = Readonly<{
  base: number;
  afterFlat: number;
  iceMetalNinjaMultiplierApplied: boolean;
  final: number;
}>;

const clamp = (chance: number): number => Math.max(0, Math.min(1, chance));

/** Pure ordering authority: gather Dodge, subtract flat points, then apply Ice Metal vs Ninja. */
export function resolveDodgeChance(input: Readonly<{
  base: number;
  flatAntiDodge: number;
  defenderIsActiveNinja: boolean;
  attackerUsedIceMetalWeapon: boolean;
}>): DodgeResolution {
  const base = clamp(input.base);
  const afterFlat = clamp(base - Math.max(0, input.flatAntiDodge));
  const iceMetalNinjaMultiplierApplied = input.defenderIsActiveNinja && input.attackerUsedIceMetalWeapon;
  return {
    base,
    afterFlat,
    iceMetalNinjaMultiplierApplied,
    final: clamp(afterFlat * (iceMetalNinjaMultiplierApplied ? 0.5 : 1))
  };
}
