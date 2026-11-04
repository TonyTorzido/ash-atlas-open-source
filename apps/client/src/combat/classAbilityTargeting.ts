export type AbilityTargetingPoint = Readonly<{ x: number; y: number }>;

export function resolveAbilityDragTargetPoint(
  start: AbilityTargetingPoint,
  current: AbilityTargetingPoint,
  minimumDragPx = 8
): AbilityTargetingPoint | null {
  if (Math.hypot(current.x - start.x, current.y - start.y) < minimumDragPx) return null;
  return current;
}

export function restoreAbilityTargetingDragPan(lock: {
  map: { dragPan: { enable(): void } };
  enabled: boolean;
} | null): void {
  if (lock?.enabled) lock.map.dragPan.enable();
}
