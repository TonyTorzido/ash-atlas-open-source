import { isFiniteLatLon } from "@ash-atlas/shared";
import type { LatLon } from "@ash-atlas/shared";

export function validateMoveTarget(lat: unknown, lon: unknown): LatLon {
  if (!isFiniteLatLon(lat, lon)) {
    throw new Error("MOVE_TO requires finite latitude and longitude");
  }
  return { lat: lat as number, lon: lon as number };
}

export function sanitizeUsername(username: string): string {
  const normalized = username.trim().replace(/\s+/g, " ");
  if (normalized.length < 1 || normalized.length > 32) {
    throw new Error("username must be between 1 and 32 characters");
  }
  return normalized;
}

export function sanitizeFlagName(name: string | undefined, fallbackIndex: number): string {
  const normalized = name?.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return `Flag ${fallbackIndex}`;
  }
  if (normalized.length > 64) {
    throw new Error("flag name must be 64 characters or fewer");
  }
  return normalized;
}

export function sanitizeFlagRename(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (normalized.length < 1) {
    throw new Error("flag name is required");
  }
  if (normalized.length > 40) {
    throw new Error("flag name must be 40 characters or fewer");
  }
  return normalized;
}

export function sanitizeAtlasShrineRename(name: string): string {
  const normalized = name.trim();
  if (normalized.length > 15) {
    throw new Error("Atlas Shrine name must be 15 characters or fewer");
  }
  return normalized;
}

export function sanitizePlayerColor(color: string): string {
  const normalized = color.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error("player color must be a #RRGGBB hex color");
  }
  return normalized.toLowerCase();
}
