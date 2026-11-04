import type maplibregl from "maplibre-gl";

type Vec3 = readonly [number, number, number];

const DEG = Math.PI / 180;

/** Unit vector (x east at lon 0, y north pole, z toward lon 0) for a longitude/latitude. */
export function surfaceVector(lng: number, lat: number): Vec3 {
  const cosLat = Math.cos(lat * DEG);
  return [Math.sin(lng * DEG) * cosLat, Math.sin(lat * DEG), Math.cos(lng * DEG) * cosLat];
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Camera position in globe-radius units (globe centre at the origin), derived
 * from the map centre, bearing, pitch and camera distance, so pitched views
 * and polar views are handled by the same 3D math.
 */
export function globeCameraPosition(
  center: Readonly<{ lng: number; lat: number }>,
  bearingDeg: number,
  pitchDeg: number,
  cameraHeightInRadii: number
): Vec3 {
  const c = surfaceVector(center.lng, center.lat);
  const lng = center.lng * DEG;
  const lat = center.lat * DEG;
  const east: Vec3 = [Math.cos(lng), 0, -Math.sin(lng)];
  const north: Vec3 = [
    -Math.sin(lat) * Math.sin(lng),
    Math.cos(lat),
    -Math.sin(lat) * Math.cos(lng)
  ];
  const bearing = bearingDeg * DEG;
  const forward: Vec3 = [
    north[0] * Math.cos(bearing) + east[0] * Math.sin(bearing),
    north[1] * Math.cos(bearing) + east[1] * Math.sin(bearing),
    north[2] * Math.cos(bearing) + east[2] * Math.sin(bearing)
  ];
  const pitch = pitchDeg * DEG;
  const up = cameraHeightInRadii * Math.cos(pitch);
  const back = cameraHeightInRadii * Math.sin(pitch);
  return [
    c[0] + c[0] * up - forward[0] * back,
    c[1] + c[1] * up - forward[1] * back,
    c[2] + c[2] * up - forward[2] * back
  ];
}

/** A surface point faces the camera only when its unit vector dotted with the camera position exceeds 1. */
export function isSurfacePointOnNearSide(camera: Vec3, lng: number, lat: number): boolean {
  return dot(surfaceVector(lng, lat), camera) > 1;
}

type TransformInternals = { cameraToCenterDistance?: number; worldSize?: number };

/** Camera position for the map's current view, or null when the map is not a globe. */
export function mapGlobeCamera(map: maplibregl.Map): Vec3 | null {
  if (map.getProjection?.()?.type !== "globe") return null;
  const transform = (map as unknown as { transform?: TransformInternals }).transform;
  const radiusPx = (transform?.worldSize ?? 512 * 2 ** map.getZoom()) / (2 * Math.PI);
  const cameraPx = transform?.cameraToCenterDistance ??
    1.5 * (map.getContainer?.().clientHeight ?? 600);
  return globeCameraPosition(
    map.getCenter(),
    map.getBearing?.() ?? 0,
    map.getPitch?.() ?? 0,
    cameraPx / radiusPx
  );
}

/** Hides every marker on the far side of the globe; returns an unbind function. */
export function bindGlobeMarkerOcclusion(
  map: maplibregl.Map,
  markers: () => Iterable<maplibregl.Marker>
): () => void {
  const apply = (): void => {
    const camera = mapGlobeCamera(map);
    if (!camera) return;
    for (const marker of markers()) {
      const at = marker.getLngLat();
      const hidden = !isSurfacePointOnNearSide(camera, at.lng, at.lat);
      marker.getElement().style.visibility = hidden ? "hidden" : "";
    }
  };
  map.on("render", apply);
  apply();
  return () => map.off("render", apply);
}
