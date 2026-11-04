import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";

let mapTilesProtocolInstalled = false;

export function installMapTilesProtocol(): void {
  if (mapTilesProtocolInstalled) return;
  const protocol = new Protocol({ metadata: true, errorOnMissingTile: false });
  maplibregl.addProtocol("pmtiles", protocol.tile);
  mapTilesProtocolInstalled = true;
}
