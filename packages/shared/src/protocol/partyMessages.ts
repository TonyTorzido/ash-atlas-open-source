import type { ClassId } from "../classContracts.js";
import type { CombatLifeState } from "../combat.js";

export type PartyMemberSlot = Readonly<{
  playerId: string;
  slotIndex: number;
}>;

export type PartySnapshot = Readonly<{
  partyId: string;
  leaderPlayerId: string;
  memberPlayerIds: readonly string[];
  /**
   * Added after the original sorted member list. Optional on legacy snapshots,
   * but current authorities always publish it.
   */
  memberSlots?: readonly PartyMemberSlot[] | undefined;
  membershipRevision?: number | undefined;
  allowTravel: boolean;
  autoFollowPlayerIds: readonly string[];
  revision: number;
}>;

export type PartyInviteSnapshot = Readonly<{
  invitationId: string;
  partyId: string;
  leaderPlayerId: string;
  inviterPlayerId: string;
  targetPlayerId: string;
  perspective: "incoming" | "outgoing";
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired" | "invalidated";
  createdAt: string;
  expiresAt: string;
  respondedAt: string | null;
  updatedAt: string;
}>;

export type PartyOutgoingInviteSnapshot = Readonly<{
  invitationId?: string | undefined;
  targetPlayerId: string;
  expiresAt: string;
}>;

export type PartyPriorityEffectSnapshot = Readonly<{
  id: string;
  label: string;
  tone: "beneficial" | "harmful";
  stacks?: number | undefined;
  expiresAt?: number | undefined;
}>;

export type PartyCombatPresence = "online" | "reconnecting" | "offline";
export type PartyCombatWorldRelation = "same_layer" | "different_area";

export type PartyCombatMemberSnapshot = Readonly<{
  playerId: string;
  slotIndex: number;
  displayName: string;
  classId: ClassId | null;
  role?: "tank" | "healer" | "damage" | null | undefined;
  currentHealth: number;
  maxHealth: number;
  ward?: number | undefined;
  downedUntil?: number | null | undefined;
  lifeState: CombatLifeState;
  presence: PartyCombatPresence;
  worldRelation: PartyCombatWorldRelation;
  distanceMeters?: number | undefined;
  priorityEffects?: readonly PartyPriorityEffectSnapshot[] | undefined;
}>;

export type PartyCombatMemberDelta = Readonly<{
  playerId: string;
  slotIndex?: number | undefined;
  displayName?: string | undefined;
  classId?: ClassId | null | undefined;
  role?: "tank" | "healer" | "damage" | null | undefined;
  currentHealth?: number | undefined;
  maxHealth?: number | undefined;
  ward?: number | undefined;
  downedUntil?: number | null | undefined;
  lifeState?: CombatLifeState | undefined;
  presence?: PartyCombatPresence | undefined;
  worldRelation?: PartyCombatWorldRelation | undefined;
  distanceMeters?: number | null | undefined;
  priorityEffects?: readonly PartyPriorityEffectSnapshot[] | undefined;
}>;

export type PartyCombatSnapshot = Readonly<{
  type: "PARTY_COMBAT_SNAPSHOT";
  partyId: string;
  membershipRevision: number;
  sequence: number;
  serverTime: number;
  members: readonly PartyCombatMemberSnapshot[];
}>;

export type PartyCombatDelta = Readonly<{
  type: "PARTY_COMBAT_DELTA";
  partyId: string;
  membershipRevision: number;
  sequence: number;
  serverTime: number;
  members: readonly PartyCombatMemberDelta[];
}>;

export type PartyReadyCheckResponse = "pending" | "ready" | "not_ready";
export type PartyReadyCheckStatus = "pending" | "complete" | "cancelled";

export type PartyReadyCheckSnapshot = Readonly<{
  readyCheckId: string;
  partyId: string;
  membershipRevision: number;
  startedByPlayerId: string;
  startedAt: number;
  expiresAt: number;
  status: PartyReadyCheckStatus;
  responses: readonly Readonly<{
    playerId: string;
    response: PartyReadyCheckResponse;
  }>[];
}>;

export type PartyServerMessage =
  | {
      type: "PARTY_SNAPSHOT";
      requestId?: string;
      party: PartySnapshot | null;
      invites: PartyInviteSnapshot[];
      inboxInvites?: PartyInviteSnapshot[];
      outgoingInvites: PartyOutgoingInviteSnapshot[];
    }
  | PartyCombatSnapshot
  | PartyCombatDelta
  | {
      type: "PARTY_READY_CHECK_SNAPSHOT";
      requestId?: string;
      readyCheck: PartyReadyCheckSnapshot | null;
    };
