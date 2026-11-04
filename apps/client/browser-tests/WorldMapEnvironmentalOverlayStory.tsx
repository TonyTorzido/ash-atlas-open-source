import "maplibre-gl/dist/maplibre-gl.css";
import "../src/styles.css";
import "../src/ashAtlasTheme.css";
import type { PlayerAppearanceSnapshot } from "@ash-atlas/shared";
import { useEffect } from "react";

import { WorldMapOverlay } from "../src/ui/WorldMapOverlay.js";

const representativeAppearance: PlayerAppearanceSnapshot = {
  schemaVersion: 1,
  catalogRevision: 1,
  revision: 7,
  bodyVariantId: "default",
  poseId: "idle",
  slots: {},
  styles: { hair: "hair-1" },
  activeHand: null
};

export function WorldMapEnvironmentalOverlayStory({
  layout,
  uiProfile = layout,
  fixture = "default"
}: {
  layout: "desktop" | "phone";
  uiProfile?: "desktop" | "phone";
  fixture?: "default" | "baker" | "destination-kinds" | "cluster-transition";
}): React.JSX.Element {
  useEffect(() => {
    const previousProfile = document.documentElement.dataset.uiProfile;
    document.documentElement.dataset.uiProfile = uiProfile;
    return () => {
      if (previousProfile) document.documentElement.dataset.uiProfile = previousProfile;
      else delete document.documentElement.dataset.uiProfile;
    };
  }, [uiProfile]);

  const baker = {
    kind: "city" as const,
    id: "baker",
    name: "Baker",
    lat: 46.3679,
    lon: -104.2758
  };
  const destinations = fixture === "baker" ? [baker] : fixture === "destination-kinds" ? [
    baker,
    { kind: "manor" as const, id: "plains-manor", name: "Plains Manor", lat: 46.3679, lon: -94.2758 },
    { kind: "kingdom" as const, id: "lake-kingdom", seatId: "lake-seat", name: "Lake Kingdom", lat: 46.3679, lon: -84.2758 },
    { kind: "atlas_shrine" as const, id: "east-shrine", name: "Eastern Shrine", lat: 46.3679, lon: -74.2758 }
  ] : fixture === "cluster-transition" ? [
    baker,
    { kind: "city" as const, id: "near-baker", name: "Near Baker", lat: baker.lat, lon: baker.lon + 2 }
  ] : [
    { kind: "city" as const, id: "albuquerque", name: "Albuquerque", lat: 35.0844, lon: -106.6504 },
    { kind: "kingdom" as const, id: "london", seatId: "london-seat", name: "London", lat: 51.5072, lon: -0.1276 },
    { kind: "manor" as const, id: "tokyo", name: "Tokyo Manor", lat: 35.6762, lon: 139.6503 }
  ];
  const fallbackCenter = fixture === "baker"
    ? { lat: baker.lat, lon: baker.lon }
    : fixture === "cluster-transition"
      ? { lat: baker.lat, lon: baker.lon + 1 }
      : fixture === "destination-kinds"
        ? { lat: baker.lat, lon: baker.lon + 15 }
        : { lat: 35.0844, lon: -106.6504 };
  return <WorldMapOverlay
    open
    layout={layout}
    snapshot={{
      serverTime: 1,
      destinations
    }}
    fallbackCenter={fallbackCenter}
    appearance={representativeAppearance}
    travelDisabled={false}
    developerAccessEnabled={layout === "phone"}
    developerMenuOpen={false}
    teleportMode="idle"
    onClose={() => undefined}
    onTravel={() => null}
    onOpenDeveloperTools={() => undefined}
    onTeleportTarget={() => undefined}
    onCancelTeleport={() => undefined}
  />;
}
