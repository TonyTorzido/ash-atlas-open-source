import type { PlayerAppearanceSnapshot } from "./appearance.js";
import type { HungerSnapshot } from "./hunger.js";
import type { PersonalFlagColor } from "./personalFlagColors.js";
import type { SpecializationId } from "./skillSystemV3.js";

/**
 * What a player is gathering right now, for other players to animate. Set by the server from
 * harvest/mining sessions and fishing encounters; absent when the player is not gathering.
 */
export type PlayerGatheringActivity = {
  kind: "chop" | "mine" | "fish";
  /** Equipped tool of the matching kind, or null when gathering by hand (no matching tool). */
  toolDefinitionId: string | null;
  /** The tree, rock or mine being worked, or the accepted fishing cast spot. */
  targetLat: number;
  targetLon: number;
  /** ISO timestamps, like harvest sessions. Fishing has no fixed end, so completesAt is null. */
  startedAt: string;
  completesAt: string | null;
};

export type PlayerSnapshot = {
  playerId: string;
  username: string;
  displayColor: string | null;
  personalFlagColor?: PersonalFlagColor;
  regionCode: string;
  zoneId: string;
  lat: number;
  lon: number;
  anchorLat: number;
  anchorLon: number;
  moveLeashRadiusM: number;
  movementRevision: number;
  relocationRevision?: number;
  targetLat: number | null;
  targetLon: number | null;
  moving: boolean;
  currentFlagId?: string | null;
  currentKingdomSeatId?: string | null;
  online: boolean;
  updatedAt: string;
  appearance?: PlayerAppearanceSnapshot;
  hunger?: HungerSnapshot;
  /** Server-set: the player is on a raft (ocean/lake). Overworld only. */
  afloat?: boolean;
  /** Server-set while gathering; omitted (or null) when idle. */
  gathering?: PlayerGatheringActivity | null;
  /** Server-set while a dash is moving or cooling down; omitted otherwise. */
  dash?: PlayerDashSnapshot | null;
  /**
   * Server-set: the player's active class ("ronin" | "warrior" today), the same value as their own
   * SkillSystemV3Snapshot.activeSpecializationId. Omitted when the player has no class, or a hidden class
   * (read as no class). Source: CombatEngine.playerActiveSpecializationId via GameState.
   */
  classId?: SpecializationId | null;
};

/** Overworld dash state. Times are server epoch ms; positions are the authoritative path. */
export type PlayerDashSnapshot = {
  active: boolean;
  startedAt: number;
  until: number;
  cooldownUntil: number;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
};
