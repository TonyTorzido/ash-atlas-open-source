import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const TARGET_SELECTOR = "[data-world-target-presentation]";
export const WORLD_TARGET_EXIT_MS = 120;
export const WORLD_TARGET_SWAP_MS = 100;

function reducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * React unmounts world target menus instantly. When a menu unmounts and no
 * other world target menu is on screen by the end of the commit, leave a
 * non-interactive clone that fades out for WORLD_TARGET_EXIT_MS. Direct
 * target-to-target switches leave no ghost, so switching never waits on an exit.
 */
export function useWorldTargetExitGhost(ref: RefObject<HTMLElement | null>): void {
  const nodeRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    nodeRef.current = ref.current;
  });
  useLayoutEffect(() => () => {
    const node = nodeRef.current;
    const parent = node?.parentNode;
    if (!node || !parent || !node.isConnected || reducedMotion()) return;
    if (!node.matches(TARGET_SELECTOR) && !node.querySelector(TARGET_SELECTOR)) return;
    const ghost = node.cloneNode(true) as HTMLElement;
    ghost.setAttribute("data-world-target-ghost", "");
    ghost.setAttribute("aria-hidden", "true");
    Array.from(ghost.querySelectorAll("[id]")).forEach((el) => el.removeAttribute("id"));
    // Neutral state (no styling) so the clone starts fully opaque, then transitions out.
    const targets = ghost.matches(TARGET_SELECTOR)
      ? [ghost, ...Array.from(ghost.querySelectorAll(TARGET_SELECTOR))]
      : Array.from(ghost.querySelectorAll(TARGET_SELECTOR));
    for (const el of targets) el.setAttribute("data-world-target-presentation", "ghost");
    parent.insertBefore(ghost, node.nextSibling);
    queueMicrotask(() => {
      const replaced = Array.from(document.querySelectorAll(TARGET_SELECTOR))
        .some((el) => !el.closest("[data-world-target-ghost]"));
      if (replaced) {
        ghost.remove();
        return;
      }
      void ghost.offsetHeight;
      for (const el of targets) el.setAttribute("data-world-target-presentation", "exiting");
      window.setTimeout(() => ghost.remove(), WORLD_TARGET_EXIT_MS + 40);
    });
  }, []);
}

/**
 * Keeps the panel still and fades its contents in when the target identity
 * changes while the menu stays mounted (even when the row count is unchanged).
 */
export function useWorldTargetSwapCue(ref: RefObject<HTMLElement | null>, identityKey: string): void {
  const previousKey = useRef(identityKey);
  useEffect(() => {
    if (previousKey.current === identityKey) return;
    previousKey.current = identityKey;
    const panel = ref.current;
    if (!panel || reducedMotion() || typeof panel.animate !== "function") return;
    for (const child of Array.from(panel.children)) {
      child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: WORLD_TARGET_SWAP_MS, easing: "ease-out" });
    }
  }, [identityKey, ref]);
}
