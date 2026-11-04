export type OverlayTransformPoint = {
  x: number;
  y: number;
};

export type StaticOverlayTransformReference = {
  origin: OverlayTransformPoint;
  axis: OverlayTransformPoint;
};

export type StaticOverlayContainerTransform = {
  pivotX: number;
  pivotY: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
};

export type StaticOverlayTransformTarget = {
  pivot: {
    set(x: number, y: number): void;
  };
  position: {
    set(x: number, y: number): void;
  };
  scale: {
    set(value: number): void;
  };
  rotation: number;
};

export function computeStaticOverlayContainerTransform(
  frozen: StaticOverlayTransformReference,
  current: StaticOverlayTransformReference
): StaticOverlayContainerTransform {
  const frozenVector = vectorBetween(frozen.origin, frozen.axis);
  const currentVector = vectorBetween(current.origin, current.axis);
  const frozenLength = vectorLength(frozenVector);
  const currentLength = vectorLength(currentVector);
  const scale = frozenLength === 0 ? 1 : currentLength / frozenLength;
  const rotation = Math.atan2(currentVector.y, currentVector.x) -
    Math.atan2(frozenVector.y, frozenVector.x);
  return {
    pivotX: frozen.origin.x,
    pivotY: frozen.origin.y,
    x: current.origin.x,
    y: current.origin.y,
    scale,
    rotation
  };
}

export function applyStaticOverlayContainerTransform(
  target: StaticOverlayTransformTarget,
  transform: StaticOverlayContainerTransform
): void {
  target.pivot.set(transform.pivotX, transform.pivotY);
  target.position.set(transform.x, transform.y);
  target.scale.set(transform.scale);
  target.rotation = transform.rotation;
}

export function resetStaticOverlayContainerTransform(
  target: StaticOverlayTransformTarget
): void {
  target.pivot.set(0, 0);
  target.position.set(0, 0);
  target.scale.set(1);
  target.rotation = 0;
}

function vectorBetween(
  from: OverlayTransformPoint,
  to: OverlayTransformPoint
): OverlayTransformPoint {
  return {
    x: to.x - from.x,
    y: to.y - from.y
  };
}

function vectorLength(vector: OverlayTransformPoint): number {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y);
}
