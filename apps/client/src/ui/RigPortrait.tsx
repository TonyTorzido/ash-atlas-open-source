/*
 * The one portrait component for the player's rig look (2026-10-21, owner: the Game Menu card still showed the old
 * long-haired renderer): the animated straight-front idle of the stock body (tank top + black pants) with the equipped
 * stock chest armour's garment layer, the same frames the map draws (stockArmour.ts), so a portrait matches the player.
 *
 * - No Pixi app and no GL context per portrait: frames are drawn onto a plain 2D canvas straight from the lazily loaded
 *   sheet pages (the same shared sheets the map player uses, so a portrait of the player's own look adds no GPU memory).
 *   Sheet loading, the upload-before-use queue and the 45 s release are jacketSheets.ts's; this only asks for frames.
 * - animate: the 96-frame idle loop at the sheet fps (a still frame 0 under reduced motion). Otherwise a static avatar:
 *   one cached still frame per look (a few hundred KB each, at most one per stock look), which never touches the sheets again.
 * - focus "bust": the head and shoulders, for the small round medallions.
 */
import type { PlayerAppearanceSnapshot } from "@ash-atlas/shared";
import { useEffect, useRef } from "react";
import sheets from "../assets/player-rig/jacketb/jacketb-sheets.json";
import { prefersReducedMotion } from "../combat/hitFeedback.js";
import { playerLayerResolution } from "../perf/renderQuality.js";
import { devStockArmourOverride, stockArmourForAppearance, stockClip, type StockArmourId, type StockFrames } from "../players/stockArmour.js";

const FIGURE_HEIGHT_PX = (sheets as { figureHeightPx: number }).figureHeightPx;
const FOOT_BELOW_ROOT_PX = (sheets as { footBelowRootPx: number }).footBelowRootPx;
const FPS = (sheets as { fps: number }).fps;
/** Empty space around the figure, as a share of the canvas height. */
const MARGIN = 0.05;
/** The share of the figure height a bust shows (head and shoulders). */
const BUST_SHARE = 0.4;
/** Padding (frame px) around the cached native still, so the garment layer is never clipped. */
const STILL_PAD = 24;

export type RigPortraitFocus = "full" | "bust";

type Still = { canvas: HTMLCanvasElement; anchorX: number; feetY: number };
const stills = new Map<string, Still>();

const lookKey = (armour: StockArmourId | null): string => armour ?? "tank";

/** The stock look a portrait shows: the dev override, else the equipped stock chest armour, else the tank top. */
export function portraitArmour(appearance: PlayerAppearanceSnapshot | null | undefined): StockArmourId | null {
  const forced = devStockArmourOverride();
  return forced === undefined ? stockArmourForAppearance(appearance) : forced;
}

type Place = { rootX: number; rootY: number };

/** Draws one sheet frame so its root pixel lands on (rootDestX, rootDestY), scaled by s. */
function drawSheetFrame(ctx: CanvasRenderingContext2D, texture: StockFrames["body"][number], place: Place, rootDestX: number, rootDestY: number, s: number): void {
  const frame = texture.frame;
  const image = texture.source.resource as CanvasImageSource | undefined;
  if (!image) return;
  ctx.drawImage(image, frame.x, frame.y, frame.width, frame.height, rootDestX - place.rootX * s, rootDestY - place.rootY * s, frame.width * s, frame.height * s);
}

/** Body frame i, then the armour layer's frame i, feet at (cx, feetY), scale s. */
function drawLook(ctx: CanvasRenderingContext2D, clip: StockFrames, index: number, cx: number, feetY: number, s: number): void {
  const rootY = feetY - FOOT_BELOW_ROOT_PX * s;
  drawSheetFrame(ctx, clip.body[index]!, clip.bodyView, cx, rootY, s);
  if (clip.layer && clip.layerView) drawSheetFrame(ctx, clip.layer[index]!, clip.layerView, cx, rootY, s);
}

function stillFor(armour: StockArmourId | null, clip: StockFrames): Still | null {
  const key = lookKey(armour);
  const cached = stills.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = clip.bodyView.frameWidth + STILL_PAD * 2;
  canvas.height = clip.bodyView.frameHeight + STILL_PAD * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const anchorX = clip.bodyView.rootX + STILL_PAD;
  const feetY = clip.bodyView.rootY + FOOT_BELOW_ROOT_PX + STILL_PAD;
  drawLook(ctx, clip, 0, anchorX, feetY, 1);
  const still = { canvas, anchorX, feetY };
  stills.set(key, still);
  return still;
}

/** The figure's widest extent (arm to arm) in frame px, so a narrow canvas fits it by width instead of cropping the arms. */
const FIGURE_WIDTH_PX = 215;

/** Where the figure sits in a w x h canvas: its scale, centre x and feet y (fit by height or width, whichever is tighter). */
function layout(w: number, h: number, focus: RigPortraitFocus): { s: number; cx: number; feetY: number } {
  const shown = focus === "bust" ? FIGURE_HEIGHT_PX * BUST_SHARE : FIGURE_HEIGHT_PX;
  const s = Math.min((h * (1 - MARGIN * 2)) / shown, (w * (1 - MARGIN * 2)) / FIGURE_WIDTH_PX);
  // A bust keeps the head near the top; a full figure is centred.
  const top = focus === "bust" ? h * MARGIN : (h - FIGURE_HEIGHT_PX * s) / 2;
  return { s, cx: w / 2, feetY: top + FIGURE_HEIGHT_PX * s };
}

export function RigPortrait({
  appearance,
  animate = false,
  focus = "full",
  className = "rig-portrait",
  ariaLabel = "Character appearance"
}: {
  appearance?: PlayerAppearanceSnapshot | null;
  animate?: boolean;
  focus?: RigPortraitFocus;
  className?: string;
  ariaLabel?: string;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const armour = portraitArmour(appearance);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.className = "salon-preview-canvas";
    host.replaceChildren(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let disposed = false;
    let raf = 0;
    let drawnIndex = -2;
    let drawnW = 0;
    let drawnH = 0;
    const loop = animate && !prefersReducedMotion();

    const paint = (): void => {
      raf = 0;
      if (disposed) return;
      const dpr = playerLayerResolution();
      const w = Math.max(1, Math.round(host.clientWidth * dpr));
      const h = Math.max(1, Math.round(host.clientHeight * dpr));
      const resized = w !== drawnW || h !== drawnH;
      if (resized) {
        canvas.width = w;
        canvas.height = h;
        drawnW = w;
        drawnH = h;
        drawnIndex = -2;
      }
      // A static avatar with a cached still never asks for the sheets; an animated one keeps them warm every tick.
      const cached = stills.get(lookKey(armour));
      const clip = loop || !cached ? stockClip(armour, "idle") : null;
      const index = loop && clip ? Math.floor((performance.now() * FPS) / 1000) % clip.body.length : 0;
      const ready = clip !== null || cached !== undefined;
      if (ready && (index !== drawnIndex || resized)) {
        const { s, cx, feetY } = layout(w, h, focus);
        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        if (clip) {
          stillFor(armour, clip);
          drawLook(ctx, clip, index, cx, feetY, s);
        } else if (cached) {
          ctx.drawImage(cached.canvas, cx - cached.anchorX * s, feetY - cached.feetY * s, cached.canvas.width * s, cached.canvas.height * s);
        }
        drawnIndex = index;
      }
      if (loop || !ready) raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => { if (!raf && !disposed) raf = requestAnimationFrame(paint); })
      : null;
    observer?.observe(host);
    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [armour, animate, focus]);

  return <div ref={hostRef} className={className} role="img" aria-label={ariaLabel} />;
}
