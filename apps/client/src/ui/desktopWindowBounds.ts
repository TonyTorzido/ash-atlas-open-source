export type WindowBounds = { x: number; y: number; width: number; height: number };
/** `top` is the lowest edge of HUD above the windows (the chat plaque); windows stay below it. */
export type WindowArea = { width: number; height: number; top?: number };
export type WindowResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
/** Includes small forced-desktop previews: minimums can never exceed the host. */
export function clampWindowBounds(bounds: WindowBounds, area: WindowArea, minimum = { width: 420, height: 360 }): WindowBounds {
  const maxWidth = Math.max(1, area.width - 16);
  const maxHeight = Math.max(1, area.height - 16);
  const width = Math.min(maxWidth, Math.max(Math.min(minimum.width, maxWidth), bounds.width));
  const height = Math.min(maxHeight, Math.max(Math.min(minimum.height, maxHeight), bounds.height));
  return { width, height, x: Math.max(8, Math.min(bounds.x, area.width - width - 8)), y: Math.max(area.top ?? 8, Math.min(bounds.y, area.height - height - 8)) };
}

/** Resize the selected corner without moving its opposite, including at limits. */
export function resizeWindowBounds(bounds: WindowBounds, area: WindowArea, corner: WindowResizeCorner, dx: number, dy: number, minimum = { width: 420, height: 360 }): WindowBounds {
  const current = clampWindowBounds(bounds, area, minimum);
  const left = corner.endsWith("left"), top = corner.startsWith("top");
  const right = current.x + current.width, bottom = current.y + current.height;
  const maxWidth = left ? right - 8 : area.width - 8 - current.x;
  const maxHeight = top ? bottom - (area.top ?? 8) : area.height - 8 - current.y;
  const width = Math.max(1, Math.min(maxWidth, Math.max(Math.min(minimum.width, maxWidth), current.width + (left ? -dx : dx))));
  const height = Math.max(1, Math.min(maxHeight, Math.max(Math.min(minimum.height, maxHeight), current.height + (top ? -dy : dy))));
  return { x: left ? right - width : current.x, y: top ? bottom - height : current.y, width, height };
}
