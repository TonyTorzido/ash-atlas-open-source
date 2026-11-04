import {
  SALON_CHAIR,
  SALON_DOOR,
  SALON_FLOOR_SIZE,
  type IndoorPoint
} from "@ash-atlas/shared";

import type { InteriorSpriteItem } from "../../map/mapObjects.js";
import { svgDataUrl } from "./roomMapInterior.js";

/**
 * The Salon on the map renderer (INTERIOR_MAP_RENDERER.md P4). Its room has no painted art:
 * the DOM scene drew the floor, mirror, chair and door with CSS, so the same shapes and palette
 * are drawn here as SVG sprites in room units.
 */

export const SALON_ROOM = { width: SALON_FLOOR_SIZE, height: SALON_FLOOR_SIZE } as const;

/** Chair and door boxes in room units (the DOM scene's `.salon-chair { width: 15%; aspect-ratio: .8 }` etc.). */
export const SALON_CHAIR_BOX = { width: SALON_FLOOR_SIZE * 0.15, height: SALON_FLOOR_SIZE * 0.15 / 0.8 } as const;
export const SALON_DOOR_BOX = { width: SALON_FLOOR_SIZE * 0.13, height: SALON_FLOOR_SIZE * 0.13 / 0.62 } as const;

// The compact UI palette the CSS scene used (GameCompactUi.css / ashAtlasTheme.css).
const LEATHER_700 = "#35251b";
const LEATHER_900 = "#18110d";
const WOOD_700 = "#493121";
const WOOD_800 = "#342319";
const BRONZE_500 = "#97703d";
const BRONZE_700 = "#624728";
const PARCHMENT_100 = "#e7dcc2";
const PARCHMENT_200 = "#c5ad7c";
const IRON_500 = "#5d5b52";

export function salonMapSpaceKey(structureId: string): string {
  return `salon:${structureId}`;
}

function floorSvg(size: number): string {
  const border = size * 0.013;
  const plank = size * 0.12;
  const seam = size * 0.005;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<defs><pattern id="p" width="${size}" height="${plank}" patternUnits="userSpaceOnUse">` +
    `<rect width="${size}" height="${plank}" fill="${WOOD_700}"/>` +
    `<rect y="${plank - seam}" width="${size}" height="${seam}" fill="${WOOD_800}"/></pattern></defs>` +
    `<rect x="${border / 2}" y="${border / 2}" width="${size - border}" height="${size - border}" rx="${border * 1.5}" ` +
    `fill="url(#p)" stroke="${LEATHER_700}" stroke-width="${border}"/></svg>`;
}

function mirrorSvg(width: number, height: number): string {
  const stroke = width * 0.02;
  const radius = width * 0.48;
  const inner = stroke / 2;
  const path = `M ${inner} ${height - inner - 8} L ${inner} ${Math.min(radius, height / 2)} ` +
    `Q ${inner} ${inner} ${width / 2} ${inner} Q ${width - inner} ${inner} ${width - inner} ${Math.min(radius, height / 2)} ` +
    `L ${width - inner} ${height - inner - 8} Q ${width - inner} ${height - inner} ${width - inner - 8} ${height - inner} ` +
    `L ${inner + 8} ${height - inner} Q ${inner} ${height - inner} ${inner} ${height - inner - 8} Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${PARCHMENT_100}"/>` +
    `<stop offset="1" stop-color="${IRON_500}"/></linearGradient></defs>` +
    `<path d="${path}" fill="url(#g)" stroke="${BRONZE_500}" stroke-width="${stroke}"/>` +
    `<path d="${path}" fill="none" stroke="${BRONZE_700}" stroke-width="${stroke * 0.6}" transform="translate(${width * 0.02} ${height * 0.035}) scale(0.96 0.93)"/>` +
    `<text x="${width / 2}" y="${height * 0.86}" text-anchor="middle" font-family="Georgia, serif" font-weight="800" ` +
    `font-size="${height * 0.13}" letter-spacing="${height * 0.13 * 0.18}" fill="${LEATHER_900}">SALON</text></svg>`;
}

function chairSvg(width: number, height: number): string {
  const stroke = width * 0.04;
  const legWidth = width * 0.06;
  const legTop = height * 0.72;
  const legHeight = height * 0.26;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="${width * 0.24}" y="${legTop}" width="${legWidth}" height="${legHeight}" fill="${BRONZE_700}" transform="rotate(5 ${width * 0.27} ${legTop})"/>` +
    `<rect x="${width * 0.7}" y="${legTop}" width="${legWidth}" height="${legHeight}" fill="${BRONZE_700}" transform="rotate(-5 ${width * 0.73} ${legTop})"/>` +
    `<rect x="${width * 0.2}" y="${height * 0.02}" width="${width * 0.6}" height="${height * 0.58}" rx="${width * 0.2}" ` +
    `fill="${LEATHER_700}" stroke="${BRONZE_700}" stroke-width="${stroke}"/>` +
    `<rect x="${width * 0.2 + stroke}" y="${height * 0.02 + stroke}" width="${width * 0.6 - stroke * 2}" height="${height * 0.58 - stroke * 2}" rx="${width * 0.16}" ` +
    `fill="none" stroke="${LEATHER_900}" stroke-width="${stroke * 0.75}"/>` +
    `<rect x="${width * 0.09}" y="${height * 0.51}" width="${width * 0.82}" height="${height * 0.24}" rx="${stroke}" ` +
    `fill="${WOOD_700}" stroke="${BRONZE_700}" stroke-width="${stroke}"/></svg>`;
}

function doorSvg(width: number, height: number): string {
  const stroke = width * 0.04;
  const radius = width * 0.38;
  const half = stroke / 2;
  const bottom = height - stroke * 0.9;
  const path = `M ${half} ${bottom} L ${half} ${radius} Q ${half} ${half} ${width / 2} ${half} ` +
    `Q ${width - half} ${half} ${width - half} ${radius} L ${width - half} ${bottom} Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="d" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${WOOD_800}"/>` +
    `<stop offset="0.48" stop-color="${WOOD_700}"/><stop offset="0.52" stop-color="${WOOD_800}"/>` +
    `<stop offset="1" stop-color="${WOOD_800}"/></linearGradient></defs>` +
    `<path d="${path}" fill="url(#d)" stroke="${BRONZE_700}" stroke-width="${stroke}"/>` +
    `<rect x="0" y="${bottom}" width="${width}" height="${height - bottom}" fill="${BRONZE_700}"/>` +
    `<circle cx="${width * 0.785}" cy="${height * 0.55}" r="${width * 0.045}" fill="${PARCHMENT_200}"/></svg>`;
}

const SALON_SPRITE_URLS = (() => {
  const mirror = { width: SALON_FLOOR_SIZE * 0.4, height: SALON_FLOOR_SIZE * 0.22 };
  return {
    floor: svgDataUrl(floorSvg(SALON_FLOOR_SIZE)),
    mirror: svgDataUrl(mirrorSvg(mirror.width, mirror.height)),
    mirrorBox: mirror,
    chair: svgDataUrl(chairSvg(SALON_CHAIR_BOX.width, SALON_CHAIR_BOX.height)),
    door: svgDataUrl(doorSvg(SALON_DOOR_BOX.width, SALON_DOOR_BOX.height))
  };
})();

/** Floor, mirror, door and styling chair as map sprites. */
export function salonSprites(): InteriorSpriteItem[] {
  const urls = SALON_SPRITE_URLS;
  return [
    {
      key: "salon-floor", url: urls.floor, layerId: "background",
      x: 0, y: 0, width: SALON_FLOOR_SIZE, height: SALON_FLOOR_SIZE, anchorX: 0, anchorY: 0, zIndex: -1
    },
    {
      key: "salon-mirror", url: urls.mirror, layerId: "background",
      x: SALON_FLOOR_SIZE * 0.3, y: SALON_FLOOR_SIZE * 0.04, width: urls.mirrorBox.width, height: urls.mirrorBox.height,
      anchorX: 0, anchorY: 0, zIndex: 1
    },
    {
      key: "salon-door", url: urls.door, layerId: "below_player",
      x: SALON_DOOR.x, y: SALON_DOOR.y, width: SALON_DOOR_BOX.width, height: SALON_DOOR_BOX.height, anchorX: 0.5, anchorY: 0.5
    },
    {
      key: "salon-chair", url: urls.chair, layerId: "actors",
      x: SALON_CHAIR.x, y: SALON_CHAIR.y, width: SALON_CHAIR_BOX.width, height: SALON_CHAIR_BOX.height, anchorX: 0.5, anchorY: 0.5
    }
  ];
}

/** Which Salon fixture a room-unit map tap lands on (the chair draws over the door). */
export function salonFixtureAt(local: IndoorPoint): "chair" | "door" | null {
  const inside = (center: IndoorPoint, box: Readonly<{ width: number; height: number }>): boolean =>
    Math.abs(local.x - center.x) <= box.width / 2 && Math.abs(local.y - center.y) <= box.height / 2;
  if (inside(SALON_CHAIR, SALON_CHAIR_BOX)) return "chair";
  if (inside(SALON_DOOR, SALON_DOOR_BOX)) return "door";
  return null;
}
