import type { FlagSnapshot } from "@ash-atlas/shared";

export function formatServerWarning(message: string): string {
  if (message.includes("inside existing claimed territory")) {
    return "Cannot build here: inside existing claimed territory";
  }
  if (message.includes("inside your claimed territory")) {
    return "Cannot build here: inside your claimed territory";
  }
  return message;
}

export function isTerritoryFlagPlacementWarning(message: string): boolean {
  return message.includes("claimed territory");
}

export function upsertFlag(
  flags: FlagSnapshot[],
  next: FlagSnapshot
): FlagSnapshot[] {
  const existingIndex = flags.findIndex((flag) => flag.id === next.id);
  if (existingIndex === -1) return [next, ...flags];
  return flags.map((flag) => flag.id === next.id ? next : flag);
}

export function removeFlagById(
  flags: FlagSnapshot[],
  flagId: string
): FlagSnapshot[] {
  return flags.filter((flag) => flag.id !== flagId);
}
