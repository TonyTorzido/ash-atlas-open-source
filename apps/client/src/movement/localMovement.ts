export type LocalPoint = { x: number; y: number };

export function moveLocalPointToward(from: LocalPoint, to: LocalPoint, distance: number): LocalPoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const remaining = Math.hypot(dx, dy);
  if (remaining === 0 || remaining <= distance) return { ...to };
  return { x: from.x + dx / remaining * distance, y: from.y + dy / remaining * distance };
}
