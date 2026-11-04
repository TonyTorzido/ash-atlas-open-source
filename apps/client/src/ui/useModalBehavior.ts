import { useEffect, useRef, type RefObject } from "react";

type ModalBehaviorOptions = {
  open: boolean;
  onClose(): void;
  closeOnEscape?: boolean;
  containEscape?: boolean;
  initialFocus?: "first" | "container";
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function useModalBehavior<T extends HTMLElement>({
  open,
  onClose,
  closeOnEscape = true,
  containEscape = false,
  initialFocus = "first"
}: ModalBehaviorOptions): RefObject<T | null> {
  const containerRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const container = containerRef.current;
    const focusable = focusableElements(container);
    (initialFocus === "container" ? container : focusable[0] ?? container)?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && (closeOnEscape || containEscape)) {
        event.preventDefault();
        event.stopPropagation();
        if (closeOnEscape) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const current = focusableElements(containerRef.current);
      if (current.length === 0) {
        event.preventDefault();
        containerRef.current?.focus();
        return;
      }
      const first = current[0];
      const last = current[current.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [closeOnEscape, containEscape, initialFocus, open]);

  return containerRef;
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}
