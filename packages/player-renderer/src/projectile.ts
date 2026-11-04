import type { ProjectileTransform } from "@ash-atlas/shared";

export type ProjectilePoint = Readonly<{ x: number; y: number }>;

export type ProjectileSpriteTransform = {
  anchorX: number;
  anchorY: number;
  positionX: number;
  positionY: number;
  rotationRadians: number;
  scaleX: number;
  scaleY: number;
};

export function projectileAimRadians(
  source: ProjectilePoint,
  target: ProjectilePoint
): number {
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  return deltaX === 0 && deltaY === 0 ? 0 : Math.atan2(deltaY, deltaX);
}

export function resolveProjectileSpriteTransform(
  transform: ProjectileTransform,
  aimRadians: number,
  target: ProjectilePoint,
  baseScale = 1
): ProjectileSpriteTransform {
  const authoredAxisRadians = Math.atan2(
    (transform.impactY - transform.tailY) * transform.scaleY,
    (transform.impactX - transform.tailX) * transform.scaleX
  );
  const rotationRadians = aimRadians - authoredAxisRadians +
    transform.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(aimRadians);
  const sine = Math.sin(aimRadians);
  return {
    anchorX: transform.impactX,
    anchorY: transform.impactY,
    positionX: target.x + cosine * transform.offsetX - sine * transform.offsetY,
    positionY: target.y + sine * transform.offsetX + cosine * transform.offsetY,
    rotationRadians,
    scaleX: baseScale * transform.scaleX,
    scaleY: baseScale * transform.scaleY
  };
}
