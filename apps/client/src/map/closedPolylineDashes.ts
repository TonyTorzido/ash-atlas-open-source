export type PolylinePoint = Readonly<{ x: number; y: number }>;

export function closedPolylineDashSegments(
  points: readonly PolylinePoint[],
  dashPx = 8,
  gapPx = 7
): PolylinePoint[][] {
  if (points.length < 2 || dashPx <= 0 || gapPx < 0) return [];
  const edges = points.map((start, index) => {
    const end = points[(index + 1) % points.length]!;
    return { start, end, length: Math.hypot(end.x - start.x, end.y - start.y) };
  }).filter((edge) => edge.length > 0);
  const perimeter = edges.reduce((total, edge) => total + edge.length, 0);
  if (perimeter === 0) return [];

  const cycleCount = Math.max(1, Math.round(perimeter / (dashPx + gapPx)));
  const period = perimeter / cycleCount;
  const adjustedDash = period * dashPx / (dashPx + gapPx);
  const cumulative = [0];
  for (const edge of edges) cumulative.push(cumulative.at(-1)! + edge.length);

  const pointAt = (distance: number): PolylinePoint => {
    const wrapped = Math.max(0, Math.min(perimeter, distance));
    let edgeIndex = edges.length - 1;
    for (let index = 0; index < edges.length; index += 1) {
      if (wrapped <= cumulative[index + 1]!) {
        edgeIndex = index;
        break;
      }
    }
    const edge = edges[edgeIndex]!;
    const progress = (wrapped - cumulative[edgeIndex]!) / edge.length;
    return {
      x: edge.start.x + (edge.end.x - edge.start.x) * progress,
      y: edge.start.y + (edge.end.y - edge.start.y) * progress
    };
  };

  return Array.from({ length: cycleCount }, (_, index) => {
    const startDistance = index * period;
    const endDistance = startDistance + adjustedDash;
    const segment = [pointAt(startDistance)];
    for (let edgeIndex = 1; edgeIndex < cumulative.length - 1; edgeIndex += 1) {
      const vertexDistance = cumulative[edgeIndex]!;
      if (vertexDistance > startDistance && vertexDistance < endDistance) {
        segment.push(pointAt(vertexDistance));
      }
    }
    segment.push(pointAt(endDistance));
    return segment;
  });
}
