import type { DungeonObjectSnapshot, DungeonPlayerSnapshot } from "@ash-atlas/shared";

const APPROACH_RADIUS_FACTOR = 0.75;

export function dungeonObjectApproachPoint(
  player: Pick<DungeonPlayerSnapshot, "x" | "y">,
  object: Pick<DungeonObjectSnapshot, "x" | "y" | "interactionRadius">
): { x: number; y: number } {
  const dx = player.x - object.x;
  const dy = player.y - object.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: object.x, y: object.y };
  const safeRadius = object.interactionRadius * APPROACH_RADIUS_FACTOR;
  return {
    x: object.x + dx / distance * safeRadius,
    y: object.y + dy / distance * safeRadius
  };
}

const FIXTURE_VERBS: Partial<Record<DungeonObjectSnapshot["kind"], string>> = {
  chest: "Open",
  door: "Open",
  ladder: "Climb",
  exit_ladder: "Climb",
  valve: "Turn",
  switch: "Pull",
  shrine: "Activate",
  destructible: "Break",
  npc: "Talk to"
};

/** One-tap verb label for a dungeon fixture: authored label first, else a kind verb plus the object name. */
export function dungeonObjectActionLabel(
  object: Pick<DungeonObjectSnapshot, "kind" | "name" | "interactionLabel">
): string {
  const authored = object.interactionLabel?.trim();
  if (authored) return authored;
  return `${FIXTURE_VERBS[object.kind] ?? "Use"} ${object.name}`;
}
