import type maplibregl from "maplibre-gl";
import { useEffect, useState } from "react";

import { mapGroundScaleZoom } from "../map/groundScaleZoom.js";

type Props = {
  map: maplibregl.Map | null;
  enabled: boolean;
  developerAccessEnabled: boolean;
};

type ZoomReading = {
  map: maplibregl.Map;
  zoom: number;
};

export function MapZoomIndicator({
  map,
  enabled,
  developerAccessEnabled
}: Props): React.JSX.Element | null {
  const [reading, setReading] = useState<ZoomReading | null>(null);

  useEffect(() => {
    if (!map || !enabled || !developerAccessEnabled) return;

    const updateZoom = (): void => {
      // Ground zoom: the same number at every latitude for the same framing.
      // Only a changed value sets state: the follow fires moveend every frame.
      const zoom = mapGroundScaleZoom(map);
      setReading((prev) => (prev && prev.map === map && prev.zoom === zoom ? prev : { map, zoom }));
    };
    const updateWhenVisible = (): void => {
      if (document.visibilityState === "visible") updateZoom();
    };

    updateZoom();
    map.on("zoom", updateZoom);
    map.on("moveend", updateZoom);
    window.addEventListener("pageshow", updateZoom);
    document.addEventListener("visibilitychange", updateWhenVisible);
    return () => {
      map.off("zoom", updateZoom);
      map.off("moveend", updateZoom);
      window.removeEventListener("pageshow", updateZoom);
      document.removeEventListener("visibilitychange", updateWhenVisible);
    };
  }, [developerAccessEnabled, enabled, map]);

  if (!map || !enabled || !developerAccessEnabled || reading?.map !== map) return null;

  return (
    <output
      aria-label="Current map zoom level"
      aria-live="off"
      className="map-zoom-indicator"
      style={{ pointerEvents: "none" }}
    >
      Zoom: {reading.zoom.toFixed(2)}
    </output>
  );
}
