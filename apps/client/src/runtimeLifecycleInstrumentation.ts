export type GameRuntimeLifecycleEvent =
  | "map-runtime-created"
  | "map-runtime-destroyed"
  | "pixi-overlay-created"
  | "pixi-overlay-destroyed"
  | "game-client-created"
  | "game-client-connected"
  | "game-client-disconnected";

declare global {
  interface Window {
    __ASH_ATLAS_RUNTIME_LIFECYCLE_OBSERVER__?: (
      event: GameRuntimeLifecycleEvent
    ) => void;
  }
}

export function observeGameRuntimeLifecycle(event: GameRuntimeLifecycleEvent): void {
  window.__ASH_ATLAS_RUNTIME_LIFECYCLE_OBSERVER__?.(event);
}
