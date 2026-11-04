import { distanceMeters } from "@ash-atlas/shared";

export function formatFlagRelativeCity(flag: Readonly<{
  lat: number;
  lon: number;
  city_name: string | null;
  city_lat: number | null;
  city_lon: number | null;
}>): string | null {
  if (flag.city_name === null || flag.city_lat === null || flag.city_lon === null) return null;
  const city = { lat: Number(flag.city_lat), lon: Number(flag.city_lon) };
  const destination = { lat: Number(flag.lat), lon: Number(flag.lon) };
  const distance = Math.round(distanceMeters(city, destination));
  return `${distance.toLocaleString()} meters ${direction(city, destination)} of ${flag.city_name}`;
}

function direction(from: { lat: number; lon: number }, to: { lat: number; lon: number }): string {
  const y = Math.sin((to.lon - from.lon) * Math.PI / 180) * Math.cos(to.lat * Math.PI / 180);
  const x = Math.cos(from.lat * Math.PI / 180) * Math.sin(to.lat * Math.PI / 180) -
    Math.sin(from.lat * Math.PI / 180) * Math.cos(to.lat * Math.PI / 180) *
    Math.cos((to.lon - from.lon) * Math.PI / 180);
  const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][
    Math.round(bearing / 45) % 8
  ]!;
}
