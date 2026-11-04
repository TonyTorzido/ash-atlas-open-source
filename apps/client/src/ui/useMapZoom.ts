import type maplibregl from "maplibre-gl";
import { useEffect, useState } from "react";

import { mapGroundScaleZoom } from "../map/groundScaleZoom.js";

const ZOOM_UPDATE_INTERVAL_MS = 160;

/**
 * Live map GROUND zoom (equator-equivalent, what sprite sizing speaks) for leaf components (dev panels). Lives outside GameApp so a pinch re-renders only the
 * component that shows the number. `null` map returns the fallback and subscribes to nothing.
 */
export function useMapZoom(map: maplibregl.Map | null | undefined, fallback: number): number {
  const [reading, setReading] = useState<{ map: maplibregl.Map; zoom: number } | null>(null);
  useEffect(() => {
    if (!map) return;
    let lastAt = 0;
    const flush = (): void => {
      lastAt = performance.now();
      const zoom = mapGroundScaleZoom(map);
      // The follow pans the map every frame (moveend each time); an unchanged zoom must not commit a render.
      setReading((current) => current && current.map === map && current.zoom === zoom ? current : { map, zoom });
    };
    const throttled = (): void => {
      if (performance.now() - lastAt >= ZOOM_UPDATE_INTERVAL_MS) flush();
    };
    flush();
    map.on("zoom", throttled);
    map.on("zoomend", flush);
    map.on("moveend", flush);
    return () => {
      map.off("zoom", throttled);
      map.off("zoomend", flush);
      map.off("moveend", flush);
    };
  }, [map]);
  return map && reading?.map === map ? reading.zoom : fallback;
}
