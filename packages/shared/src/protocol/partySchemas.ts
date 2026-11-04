import { z } from "zod";

import { CLASS_IDS } from "../classContracts.js";
import { COMBAT_LIFE_STATES } from "../combat.js";
import type {
  PartyCombatDelta,
  PartyCombatMemberDelta,
  PartyCombatMemberSnapshot,
  PartyCombatSnapshot,
  PartyInviteSnapshot,
  PartyOutgoingInviteSnapshot,
  PartyReadyCheckSnapshot,
  PartySnapshot
} from "./partyMessages.js";

const requestIdSchema = z.string().min(1).max(128);
const partyTargetMessageFields = {
  requestId: requestIdSchema,
  targetPlayerId: z.string().min(1).max(160)
} as const;

export const createPartyMessageSchema = z.object({
  type: z.literal("CREATE_PARTY"),
  requestId: requestIdSchema
}).strict();

export const addPartyMemberMessageSchema = z.object({
  type: z.literal("ADD_PARTY_MEMBER"),
  ...partyTargetMessageFields
}).strict();

export const inviteToPartyMessageSchema = z.object({
  type: z.literal("INVITE_TO_PARTY"),
  ...partyTargetMessageFields
}).strict();

export const removePartyMemberMessageSchema = z.object({
  type: z.literal("REMOVE_PARTY_MEMBER"),
  ...partyTargetMessageFields
}).strict();

export const leavePartyMessageSchema = z.object({
  type: z.literal("LEAVE_PARTY"),
  requestId: requestIdSchema
}).strict();

export const disbandPartyMessageSchema = z.object({
  type: z.literal("DISBAND_PARTY"),
  requestId: requestIdSchema
}).strict();

export const changePartyLeaderMessageSchema = z.object({
  type: z.literal("CHANGE_PARTY_LEADER"),
  ...partyTargetMessageFields
}).strict();

export const acceptPartyInviteMessageSchema = z.object({
  type: z.literal("ACCEPT_PARTY_INVITE"),
  requestId: requestIdSchema,
  invitationId: z.string().uuid().optional(),
  partyId: z.string().min(1).max(200).optional()
}).strict();

export const forwardPartyInviteMessageSchema = z.object({
  type: z.literal("FORWARD_PARTY_INVITE"),
  requestId: requestIdSchema,
  invitationId: z.string().uuid()
}).strict();

export const declinePartyInviteMessageSchema = z.object({
  type: z.literal("DECLINE_PARTY_INVITE"),
  requestId: requestIdSchema,
  invitationId: z.string().uuid().optional(),
  partyId: z.string().min(1).max(200).optional()
}).strict();

export const cancelPartyInviteMessageSchema = z.object({
  type: z.literal("CANCEL_PARTY_INVITE"),
  requestId: requestIdSchema,
  invitationId: z.string().uuid()
}).strict();

export const sendTravelInviteMessageSchema = z.object({
  type: z.literal("SEND_TRAVEL_INVITE"),
  requestId: requestIdSchema,
  targetPlayerId: z.string().min(1).max(160)
}).strict();

export const respondTravelInviteMessageSchema = z.object({
  type: z.literal("RESPOND_TRAVEL_INVITE"),
  requestId: requestIdSchema,
  inviteId: z.string().uuid(),
  response: z.enum(["accept", "decline"])
}).strict();

export const cancelTravelInviteMessageSchema = z.object({
  type: z.literal("CANCEL_TRAVEL_INVITE"),
  requestId: requestIdSchema,
  inviteId: z.string().uuid()
}).strict();

export const requestTravelInboxMessageSchema = z.object({
  type: z.literal("REQUEST_TRAVEL_INBOX"),
  requestId: requestIdSchema
}).strict();

export const setPartyTravelAllowedMessageSchema = z.object({
  type: z.literal("SET_PARTY_TRAVEL_ALLOWED"),
  requestId: requestIdSchema,
  allowed: z.boolean()
}).strict();

export const setPartyAutoFollowMessageSchema = z.object({
  type: z.literal("SET_PARTY_AUTO_FOLLOW"),
  requestId: requestIdSchema,
  enabled: z.boolean()
}).strict();

export const travelToPartyLeaderMessageSchema = z.object({
  type: z.literal("TRAVEL_TO_PARTY_LEADER"),
  requestId: requestIdSchema
}).strict();

export const requestPartyCombatSnapshotMessageSchema = z.object({
  type: z.literal("REQUEST_PARTY_COMBAT_SNAPSHOT"),
  requestId: requestIdSchema
}).strict();

export const startPartyReadyCheckMessageSchema = z.object({
  type: z.literal("START_PARTY_READY_CHECK"),
  requestId: requestIdSchema
}).strict();

export const respondPartyReadyCheckMessageSchema = z.object({
  type: z.literal("RESPOND_PARTY_READY_CHECK"),
  requestId: requestIdSchema,
  readyCheckId: z.string().uuid(),
  response: z.enum(["ready", "not_ready"])
}).strict();

export const cancelPartyReadyCheckMessageSchema = z.object({
  type: z.literal("CANCEL_PARTY_READY_CHECK"),
  requestId: requestIdSchema,
  readyCheckId: z.string().uuid()
}).strict();

/** Hunting chat: ask the leader of a listed party to let you in. */
export const joinPartyListingMessageSchema = z.object({
  type: z.literal("JOIN_PARTY_LISTING"),
  requestId: requestIdSchema,
  messageId: z.string().uuid()
}).strict();

/** Hunting chat: the poster closes their own card early. */
export const cancelPartyListingMessageSchema = z.object({
  type: z.literal("CANCEL_PARTY_LISTING"),
  requestId: requestIdSchema,
  messageId: z.string().uuid()
}).strict();

/** Party chat: the leader accepts or declines a Hunting join request. */
export const respondPartyJoinRequestMessageSchema = z.object({
  type: z.literal("RESPOND_PARTY_JOIN_REQUEST"),
  requestId: requestIdSchema,
  joinRequestId: z.string().uuid(),
  response: z.enum(["accept", "decline"])
}).strict();

export const PARTY_MEMBER_CAPACITY = 5;

const partyMemberSlotSchema = z.object({
  playerId: z.string().min(1).max(160),
  slotIndex: z.number().int().min(0).max(PARTY_MEMBER_CAPACITY - 1)
}).strict();

export const partySnapshotSchema: z.ZodType<PartySnapshot> = z.object({
  partyId: z.string().min(1).max(200),
  leaderPlayerId: z.string().min(1).max(160),
  memberPlayerIds: z.array(z.string().min(1).max(160)).min(1).refine(
    (playerIds) => playerIds.every((playerId, index) => index === 0 || playerIds[index - 1]! < playerId),
    "party members must be unique and stably sorted"
  ),
  memberSlots: z.array(partyMemberSlotSchema).min(1).max(PARTY_MEMBER_CAPACITY).optional(),
  membershipRevision: z.number().int().positive().optional(),
  allowTravel: z.boolean(),
  autoFollowPlayerIds: z.array(z.string().min(1).max(160)).refine(
    (playerIds) => playerIds.every((playerId, index) => index === 0 || playerIds[index - 1]! < playerId),
    "auto-follow members must be unique and stably sorted"
  ),
  revision: z.number().int().positive()
}).strict().refine(
  (party) => party.memberPlayerIds.includes(party.leaderPlayerId),
  "party leader must be a member"
).refine(
  (party) => party.autoFollowPlayerIds.every((playerId) => party.memberPlayerIds.includes(playerId)),
  "auto-follow players must be party members"
).refine(
  (party) => !party.memberSlots || (
    party.memberSlots.length === party.memberPlayerIds.length &&
    new Set(party.memberSlots.map(({ playerId }) => playerId)).size === party.memberSlots.length &&
    new Set(party.memberSlots.map(({ slotIndex }) => slotIndex)).size === party.memberSlots.length &&
    party.memberSlots.every(({ playerId }) => party.memberPlayerIds.includes(playerId))
  ),
  "party slots must uniquely cover every party member"
);

export const partyInviteSnapshotSchema: z.ZodType<PartyInviteSnapshot> = z.object({
  invitationId: z.string().uuid(),
  partyId: z.string().min(1).max(200),
  leaderPlayerId: z.string().min(1).max(160),
  inviterPlayerId: z.string().min(1).max(160),
  targetPlayerId: z.string().min(1).max(160),
  perspective: z.enum(["incoming", "outgoing"]),
  status: z.enum(["pending", "accepted", "declined", "cancelled", "expired", "invalidated"]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  respondedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime()
}).strict();

export const partyOutgoingInviteSnapshotSchema: z.ZodType<PartyOutgoingInviteSnapshot> = z.object({
  invitationId: z.string().uuid().optional(),
  targetPlayerId: z.string().min(1).max(160),
  expiresAt: z.string().datetime()
}).strict();

export const partyServerMessageSchema = z.object({
  type: z.literal("PARTY_SNAPSHOT"),
  requestId: requestIdSchema.optional(),
  party: partySnapshotSchema.nullable(),
  invites: z.array(partyInviteSnapshotSchema).refine(
    (invites) => invites.every((invite, index) => {
      if (index === 0) return true;
      const previous = invites[index - 1]!;
      return previous.partyId < invite.partyId
        || (previous.partyId === invite.partyId && previous.invitationId < invite.invitationId);
    }),
    "party invitations must be unique and stably sorted"
  ),
  inboxInvites: z.array(partyInviteSnapshotSchema).optional().default([]),
  outgoingInvites: z.array(partyOutgoingInviteSnapshotSchema).refine(
    (invites) => invites.every(
      (invite, index) => index === 0 || invites[index - 1]!.targetPlayerId < invite.targetPlayerId
    ),
    "outgoing party invitations must be unique and stably sorted"
  )
}).strict();

const partyPriorityEffectSchema = z.object({
  id: z.string().min(1).max(160),
  label: z.string().min(1).max(80),
  tone: z.enum(["beneficial", "harmful"]),
  stacks: z.number().int().positive().max(99).optional(),
  expiresAt: z.number().int().nonnegative().optional()
}).strict();

const partyCombatMemberFields = {
  slotIndex: z.number().int().min(0).max(PARTY_MEMBER_CAPACITY - 1),
  displayName: z.string().min(1).max(160),
  classId: z.enum(CLASS_IDS).nullable(),
  role: z.enum(["tank", "healer", "damage"]).nullable().optional(),
  currentHealth: z.number().int().nonnegative(),
  maxHealth: z.number().int().positive(),
  ward: z.number().int().nonnegative().optional(),
  downedUntil: z.number().int().nonnegative().nullable().optional(),
  lifeState: z.enum(COMBAT_LIFE_STATES),
  presence: z.enum(["online", "reconnecting", "offline"]),
  worldRelation: z.enum(["same_layer", "different_area"]),
  distanceMeters: z.number().finite().nonnegative().optional(),
  priorityEffects: z.array(partyPriorityEffectSchema).max(2).optional()
} as const;

export const partyCombatMemberSnapshotSchema: z.ZodType<PartyCombatMemberSnapshot> = z.object({
  playerId: z.string().min(1).max(160),
  ...partyCombatMemberFields
}).strict().refine(
  (member) => member.currentHealth <= member.maxHealth,
  "party member health cannot exceed maximum health"
);

export const partyCombatMemberDeltaSchema: z.ZodType<PartyCombatMemberDelta> = z.object({
  playerId: z.string().min(1).max(160),
  slotIndex: partyCombatMemberFields.slotIndex.optional(),
  displayName: partyCombatMemberFields.displayName.optional(),
  classId: partyCombatMemberFields.classId.optional(),
  role: partyCombatMemberFields.role,
  currentHealth: partyCombatMemberFields.currentHealth.optional(),
  maxHealth: partyCombatMemberFields.maxHealth.optional(),
  ward: partyCombatMemberFields.ward,
  downedUntil: partyCombatMemberFields.downedUntil,
  lifeState: partyCombatMemberFields.lifeState.optional(),
  presence: partyCombatMemberFields.presence.optional(),
  worldRelation: partyCombatMemberFields.worldRelation.optional(),
  distanceMeters: partyCombatMemberFields.distanceMeters.nullable(),
  priorityEffects: partyCombatMemberFields.priorityEffects
}).strict().refine(
  (member) => Object.keys(member).some((key) => key !== "playerId"),
  "party combat delta must include at least one dirty field"
);

export const partyCombatSnapshotSchema: z.ZodType<PartyCombatSnapshot> = z.object({
  type: z.literal("PARTY_COMBAT_SNAPSHOT"),
  partyId: z.string().min(1).max(200),
  membershipRevision: z.number().int().positive(),
  sequence: z.number().int().positive(),
  serverTime: z.number().int().nonnegative(),
  members: z.array(partyCombatMemberSnapshotSchema).min(1).max(PARTY_MEMBER_CAPACITY)
}).strict().refine(
  (snapshot) => (
    new Set(snapshot.members.map(({ playerId }) => playerId)).size === snapshot.members.length &&
    new Set(snapshot.members.map(({ slotIndex }) => slotIndex)).size === snapshot.members.length
  ),
  "party combat members and slots must be unique"
);

export const partyCombatDeltaSchema: z.ZodType<PartyCombatDelta> = z.object({
  type: z.literal("PARTY_COMBAT_DELTA"),
  partyId: z.string().min(1).max(200),
  membershipRevision: z.number().int().positive(),
  sequence: z.number().int().positive(),
  serverTime: z.number().int().nonnegative(),
  members: z.array(partyCombatMemberDeltaSchema).min(1).max(PARTY_MEMBER_CAPACITY)
}).strict().refine(
  (delta) => new Set(delta.members.map(({ playerId }) => playerId)).size === delta.members.length,
  "party combat delta members must be unique"
);

export const partyReadyCheckSnapshotSchema: z.ZodType<PartyReadyCheckSnapshot> = z.object({
  readyCheckId: z.string().uuid(),
  partyId: z.string().min(1).max(200),
  membershipRevision: z.number().int().positive(),
  startedByPlayerId: z.string().min(1).max(160),
  startedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  status: z.enum(["pending", "complete", "cancelled"]),
  responses: z.array(z.object({
    playerId: z.string().min(1).max(160),
    response: z.enum(["pending", "ready", "not_ready"])
  }).strict()).min(1).max(PARTY_MEMBER_CAPACITY)
}).strict().refine(
  (snapshot) => (
    snapshot.expiresAt >= snapshot.startedAt &&
    new Set(snapshot.responses.map(({ playerId }) => playerId)).size === snapshot.responses.length &&
    snapshot.responses.some(({ playerId }) => playerId === snapshot.startedByPlayerId)
  ),
  "ready check roster and timing must be valid"
);

export const partyReadyCheckServerMessageSchema = z.object({
  type: z.literal("PARTY_READY_CHECK_SNAPSHOT"),
  requestId: requestIdSchema.optional(),
  readyCheck: partyReadyCheckSnapshotSchema.nullable()
}).strict();
