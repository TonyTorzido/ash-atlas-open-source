import { useEffect, useRef } from "react";
import { PLAYER_CAMERA, indicatorPlacement } from "../map/playerFollow.js";
import "./PlayerOffscreenIndicator.css";

type LatLon = Readonly<{ lat: number; lon: number }>;
type IndicatorMap = Readonly<{
  project(lngLat: [number, number]): { x: number; y: number };
  getCanvas(): HTMLCanvasElement;
}>;

type Props = Readonly<{
  getMap(): IndicatorMap | null;
  /** Rendered (predicted) position of the local player. */
  getPlayerPosition(): LatLon | null;
  /** Same action as the recenter control (it also clears the combat camera lock). */
  onRecenter(): void;
}>;

/**
 * A small chevron badge on the screen edge, shown only while the player's sprite is outside the visible map.
 * It points toward the player and slides along the edge; tapping it recenters. Positioned imperatively every frame
 * so camera pans never re-render the game.
 */
export function PlayerOffscreenIndicator({ getMap, getPlayerPosition, onRecenter }: Props): React.JSX.Element {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const latest = useRef({ getMap, getPlayerPosition });
  latest.current = { getMap, getPlayerPosition };

  useEffect(() => {
    let raf = 0;
    let shown = false;
    let lastKey = "";
    const frame = (): void => {
      raf = requestAnimationFrame(frame);
      const button = buttonRef.current;
      const map = latest.current.getMap();
      const player = latest.current.getPlayerPosition();
      if (!button || !map || !player) {
        if (shown) { button?.setAttribute("data-visible", "false"); shown = false; }
        return;
      }
      const canvas = map.getCanvas();
      const rect = canvas.getBoundingClientRect();
      const size = { width: canvas.clientWidth || rect.width, height: canvas.clientHeight || rect.height };
      if (size.width <= 0 || size.height <= 0) return;
      const point = map.project([player.lon, player.lat]);
      const placement = indicatorPlacement(point, size);
      if (placement.visible !== shown) {
        button.setAttribute("data-visible", placement.visible ? "true" : "false");
        shown = placement.visible;
      }
      if (!placement.visible) return;
      const x = Math.round((rect.left + placement.x) * 2) / 2;
      const y = Math.round((rect.top + placement.y) * 2) / 2;
      const angle = Math.round(placement.angleDeg * 2) / 2;
      const key = `${x}|${y}|${angle}`;
      if (key === lastKey) return;
      lastKey = key;
      button.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      button.style.setProperty("--offscreen-angle", `${angle}deg`);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <button
      ref={buttonRef}
      type="button"
      className="player-offscreen-indicator"
      data-visible="false"
      data-fade-ms={PLAYER_CAMERA.indicator.fadeMs}
      aria-label="Your character is off screen. Recenter."
      onClick={onRecenter}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}
