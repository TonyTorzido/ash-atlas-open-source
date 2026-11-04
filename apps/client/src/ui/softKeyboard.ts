/** Text fields that raise the on-screen keyboard (read-only ones, like the market number boxes, do not). */
export function isTextEntry(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly;
  if (!(element instanceof HTMLInputElement)) return false;
  if (element.readOnly) return false;
  return !["checkbox", "radio", "range", "button", "submit", "reset", "file", "color"].includes(element.type);
}

/**
 * Marks `html[data-text-entry]` while a text field has focus, so phone screens can hide
 * their bottom Back / Return to Game bar instead of letting the keyboard push it up.
 * When the keyboard is dismissed without leaving the field (Android hide-keyboard key),
 * the viewport grows back; the field is blurred so the bar returns.
 */
export function installSoftKeyboardTracking(doc: Document = document): void {
  const root = doc.documentElement;
  const view = doc.defaultView;
  const sync = (): void => {
    if (isTextEntry(doc.activeElement)) root.setAttribute("data-text-entry", "");
    else root.removeAttribute("data-text-entry");
  };
  doc.addEventListener("focusin", sync);
  doc.addEventListener("focusout", () => view?.setTimeout(sync, 0));
  const viewport = view?.visualViewport;
  if (!viewport) return;
  let lastHeight = viewport.height;
  viewport.addEventListener("resize", () => {
    const grewBy = viewport.height - lastHeight;
    lastHeight = viewport.height;
    const active = doc.activeElement;
    if (grewBy > 120 && isTextEntry(active)) (active as HTMLElement).blur();
  });
}
