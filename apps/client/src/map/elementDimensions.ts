export function hasUsableElementDimensions(element: Pick<HTMLElement, "getBoundingClientRect">): boolean {
  const { width, height } = element.getBoundingClientRect();
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}
