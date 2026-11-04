export function restoreSuppressedStaticOverlay(input: {
  resetTransform(): void;
  redraw(): void;
  reveal(): void;
}): void {
  input.resetTransform();
  input.redraw();
  input.reveal();
}
