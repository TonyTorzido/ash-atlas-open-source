import type { LocationType, PlayerLocationSnapshot } from "@ash-atlas/shared";
import { useLayoutEffect, type ReactNode } from "react";

type FixedLocationSceneRegistryKey =
  | "world"
  | "manor/manor_foyer"
  | "manor/manor_main_room"
  | "salon/salon_main_room"
  | "greenhouse/greenhouse_main_room";
export type DynamicCisternWarrensSceneKey = `cistern_warrens/${string}`;
export type DynamicDungeonSceneKey = `dungeon/${string}`;
export type LocationSceneKey = "world" | `${LocationType}/${string}`;
export type LocationSceneRegistryKey = FixedLocationSceneRegistryKey | "manor/*" | "greenhouse/*" | "cistern_warrens/*" | "dungeon/*";

const FIXED_LOCATION_SCENE_KEYS = new Set<string>([
  "world", "manor/manor_foyer", "manor/manor_main_room", "salon/salon_main_room", "greenhouse/greenhouse_main_room"
]);

export function locationSceneKey(location: PlayerLocationSnapshot | null): LocationSceneKey {
  return location?.kind === "interior"
    ? `${location.locationType}/${location.spaceId}`
    : "world";
}

export function LocationSceneHost({
  location,
  scenes,
  onSceneMounted
}: {
  location: PlayerLocationSnapshot | null;
  scenes: Partial<Record<LocationSceneRegistryKey, ReactNode>>;
  onSceneMounted?: (key: LocationSceneKey) => void;
}) {
  const key = locationSceneKey(location);
  const scene = isFixedLocationSceneRegistryKey(key)
    ? scenes[key] ?? (key.startsWith("manor/")
      ? scenes["manor/*"]
      : key.startsWith("greenhouse/") ? scenes["greenhouse/*"] : null)
    : isDynamicCisternWarrensSceneKey(key)
      ? scenes["cistern_warrens/*"]
      : isDynamicDungeonSceneKey(key)
        ? scenes["dungeon/*"]
      : key.startsWith("manor/") ? scenes["manor/*"]
        : key.startsWith("greenhouse/") ? scenes["greenhouse/*"]
          : null;
  useLayoutEffect(() => {
    if (scene !== null && scene !== undefined) onSceneMounted?.(key);
  }, [key, onSceneMounted, scene]);
  return <>{scene}</>;
}

function isFixedLocationSceneRegistryKey(key: LocationSceneKey): key is FixedLocationSceneRegistryKey {
  return FIXED_LOCATION_SCENE_KEYS.has(key);
}

function isDynamicCisternWarrensSceneKey(key: LocationSceneKey): key is DynamicCisternWarrensSceneKey {
  return key.startsWith("cistern_warrens/");
}

function isDynamicDungeonSceneKey(key: LocationSceneKey): key is DynamicDungeonSceneKey {
  return key.startsWith("dungeon/");
}
