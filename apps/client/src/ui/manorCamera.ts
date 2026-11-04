export type ManorCameraPan = Readonly<{
  x: number;
  y: number;
}>;

export type ManorCameraBounds = Readonly<{
  roomWidth: number;
  roomHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  zoom: number;
}>;

/** Keep the fitted authored room covering the viewport on every visible axis. */
export function clampManorCameraPan(
  pan: ManorCameraPan,
  bounds: ManorCameraBounds
): ManorCameraPan {
  if (
    !Number.isFinite(bounds.roomWidth) || bounds.roomWidth <= 0 ||
    !Number.isFinite(bounds.roomHeight) || bounds.roomHeight <= 0 ||
    !Number.isFinite(bounds.viewportWidth) || bounds.viewportWidth <= 0 ||
    !Number.isFinite(bounds.viewportHeight) || bounds.viewportHeight <= 0 ||
    !Number.isFinite(bounds.zoom) || bounds.zoom <= 0
  ) {
    return { x: 0, y: 0 };
  }

  const fittedScale = Math.min(
    bounds.viewportWidth / bounds.roomWidth,
    bounds.viewportHeight / bounds.roomHeight
  );
  const renderedWidth = bounds.roomWidth * fittedScale * bounds.zoom;
  const renderedHeight = bounds.roomHeight * fittedScale * bounds.zoom;
  const maxX = Math.max(0, (renderedWidth - bounds.viewportWidth) / 2);
  const maxY = Math.max(0, (renderedHeight - bounds.viewportHeight) / 2);

  return {
    x: clampFinite(pan.x, -maxX, maxX),
    y: clampFinite(pan.y, -maxY, maxY)
  };
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(minimum, value));
}
