import { describe, expect, it } from "vitest";

import {
  GLOBE_SPACE_BACKGROUND_CLASS,
  GLOBE_SPACE_BACKGROUND_MAX_ZOOM,
  globeSpaceBackgroundVisibleAtZoom,
  syncGlobeSpaceBackground
} from "./globeSpace.js";

describe("globe-space background", () => {
  it("enters only at the shared distant-map threshold", () => {
    expect(globeSpaceBackgroundVisibleAtZoom(GLOBE_SPACE_BACKGROUND_MAX_ZOOM)).toBe(true);
    expect(globeSpaceBackgroundVisibleAtZoom(GLOBE_SPACE_BACKGROUND_MAX_ZOOM + 0.01)).toBe(false);
    expect(globeSpaceBackgroundVisibleAtZoom(Number.NaN)).toBe(false);
  });

  it("keeps the map container state synchronized while zooming", () => {
    const classes = new Set<string>();
    const classList = {
      toggle(className: string, force?: boolean): boolean {
        const next = force ?? !classes.has(className);
        if (next) classes.add(className);
        else classes.delete(className);
        return next;
      },
      contains(className: string): boolean {
        return classes.has(className);
      }
    } as unknown as DOMTokenList;
    const container = { classList } as HTMLElement;
    let zoom = GLOBE_SPACE_BACKGROUND_MAX_ZOOM;
    const map = {
      getContainer: () => container,
      getZoom: () => zoom
    };

    syncGlobeSpaceBackground(map);
    expect(classList.contains(GLOBE_SPACE_BACKGROUND_CLASS)).toBe(true);
    zoom = GLOBE_SPACE_BACKGROUND_MAX_ZOOM + 1;
    syncGlobeSpaceBackground(map);
    expect(classList.contains(GLOBE_SPACE_BACKGROUND_CLASS)).toBe(false);
  });
});
