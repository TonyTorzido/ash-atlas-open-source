import { chatPartyListingDungeonName, type ServerMessage } from "@ash-atlas/shared";
import type pg from "pg";

import {
  doorwayDestinationForAnchor,
  doorwayDestinationForTravel,
  type AltDoorwayGate,
  type DoorwayDecision
} from "../../auth/trust/altDoorway.js";
import type { AuthenticatedSession } from "../../auth/types.js";
import type { ChatRealtimeCoordinator } from "../../chat/chatRealtime.js";
import {
  PartyListingError,
  partyListingTeleportDenial,
  type PartyListingService
} from "../../chat/partyListings.js";
import type { CombatEngine } from "../../game/combat/combatEngine.js";
import type { AppLogger } from "../../logger.js";
import { ClassRequestError } from "../../game/classes/classService.js";
import { ManorError, type ManorEntryAuthorization, type ManorPresenceService, type ManorRuntime } from "../../game/manor.js";
import { PartyAuthorityError, type MutablePartyAuthority } from "../../game/party/PartyAuthority.js";
import type { PlayerAuthorityFence } from "../../game/playerAuthorityFence.js";
import type { RecentPlayersService } from "../../game/recentPlayers.js";
import type { AuthoritativeTravelAnchor, GameState } from "../../game/state.js";
import type { TravelBlockReason } from "../../game/travelEligibility.js";
import {
  TravelInviteError,
  type TravelInviteErrorCode,
  type TravelInviteService
} from "../../game/travelInvites.js";
import type { WorldRuntime } from "../../game/worldRuntime.js";
import type { OverworldBossParticipantLeaseCoordinator } from "../../game/overworldBossParticipantLeases.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type { PartyRealtimeState } from "../partyRealtimeState.js";
import type { PartyCombatPublisher } from "../partyCombatPublisher.js";
import type { PartyReadyCheckService } from "../partyReadyCheckService.js";
import type { RelocationPopulationReadiness } from "../populationRealtimeOperations.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import { requireHello, type RealtimeConnectionState } from "./handlerExecutionContext.js";
import type { ResolvedTravelDestination, TravelArrivalMode } from "../travelContracts.js";

type Position = { lat: number; lon: number };
type PopulationRelocation = Readonly<{
  playerId: string;
  connectionId: string;
  connectionGeneration: number;
  relocationRevision: number;
  resourceVisionRevision: number;
  gameplayViewGeneration: number;
  isCurrent(): boolean;
}>;
type TravelInput = {
  playerId: string;
  destination: ResolvedTravelDestination;
  requestId: string;
  arrivalMode: TravelArrivalMode;
  kind: "flag" | "invite" | "party_manual" | "party_auto_follow" | "manor_jump" | "dev_mine";
  sendResult?: boolean;
  playerSpawnPosition?: Position;
  transitionToken?: symbol;
  companionHostPlayerId?: string;
  beforePublish?: (client?: pg.PoolClient) => Promise<void>;
};
type TravelResult =
  | { success: true; player: ReturnType<GameState["snapshotForPlayer"]> }
  | { success: false; reason: TravelBlockReason };

export type PartyHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId">;
  socket: SocketLike;
  authenticatedSession: AuthenticatedSession | null | undefined;
  altDoorway?: AltDoorwayGate | undefined;
  // The connection's client platform (WS claim); picks the web doorway copy.
  clientPlatform?: "web" | "ios" | "android" | undefined;
  registry: ConnectionRegistry;
  gameState: GameState;
  worldRuntime?: WorldRuntime | undefined;
  partyAuthority?: MutablePartyAuthority | undefined;
  partyCombatPublisher?: PartyCombatPublisher | undefined;
  partyReadyChecks?: PartyReadyCheckService | undefined;
  chats?: ChatRealtimeCoordinator | undefined;
  /** Combat and PvP-timer reads for the Hunting join teleport decision. */
  combat?: CombatEngine | undefined;
  pvpTimerActive?: ((playerId: string) => boolean) | undefined;
  manorPresence?: ManorPresenceService | undefined;
  manorRuntime?: ManorRuntime | undefined;
  travelInvites?: TravelInviteService | undefined;
  recentPlayers?: RecentPlayersService | undefined;
  overworldBossParticipantLeases?: OverworldBossParticipantLeaseCoordinator | undefined;
  partyRealtimeState: PartyRealtimeState;
  playerAuthorityFence: PlayerAuthorityFence;
  applyAuthoritativeTravelPhase1(
    input: Omit<TravelInput, "transitionToken">
  ): Promise<
    | {
        success: true;
        player: ReturnType<GameState["snapshotForPlayer"]>;
        phase2(): Promise<void>;
        populationRelocation: PopulationRelocation | null;
      }
    | { success: false; reason: TravelBlockReason }
  >;
  beginSmoothTravelTransition(playerId: string, requestId: string): symbol | null;
  endSmoothTravelTransition(
    playerId: string,
    requestId: string,
    transition: symbol,
    outcome: "committed" | "failed",
    releaseReason?: string
  ): boolean;
  enforcePartyManorAccess(playerIds: Iterable<string>): Promise<void>;
  enterManorNow(input: {
    playerId: string;
    manorId: string;
    requestId: string;
    expectedPlacementRevision?: number;
    reservedInviteId?: string;
    skipProximity?: boolean;
    transitionToken?: symbol;
  }): Promise<boolean>;
  performAuthoritativeTravel(input: TravelInput): Promise<TravelResult>;
  resolveFlagTravelDestination(flagId: string): Promise<ResolvedTravelDestination | null>;
  resolveManorEntryAuthorization(playerId: string, manorId: string): Promise<ManorEntryAuthorization>;
  safeSendServerMessage(
    socket: SocketLike,
    message: ServerMessage,
    logger?: Pick<AppLogger, "warn">,
    context?: Record<string, unknown>
  ): boolean;
  sendCombatError(
    socket: SocketLike,
    requestId: string,
    code: string,
    message: string,
    details?: {
      retryAfterMs?: number;
      retryable?: boolean;
      currentTollGold?: string;
      requiredGold?: string;
    }
  ): void;
  sendTravelFailure(
    playerId: string,
    kind: "invite" | "party_manual" | "party_auto_follow" | "manor_jump",
    reason: TravelBlockReason,
    requestId?: string
  ): void;
  sendTravelInboxForPlayers(playerIds: Iterable<string>, isCurrent?: () => boolean): Promise<void>;
  waitForRelocationPopulationV2(input: Readonly<{
    playerId: string;
    requestId: string;
    destination: Position;
    transitionToken: symbol;
    relocation: PopulationRelocation | null;
  }>): Promise<RelocationPopulationReadiness>;
}>;

function requirePartyListings(chats: ChatRealtimeCoordinator | undefined): PartyListingService {
  const listings = chats?.partyListings;
  if (!listings) throw new PartyListingError("PARTY_LISTING_INVALID", "Party cards are unavailable right now.");
  return listings;
}

function requirePartyAuthority(
  authority: MutablePartyAuthority | undefined
): MutablePartyAuthority {
  if (!authority) {
    throw new PartyAuthorityError("PARTY_UNAVAILABLE", "Party service is unavailable");
  }
  return authority;
}

function sameTravelAnchor(
  current: AuthoritativeTravelAnchor,
  stored: AuthoritativeTravelAnchor
): boolean {
  return current.scopeId === stored.scopeId &&
    current.layerId === stored.layerId &&
    current.relocationRevision === stored.relocationRevision &&
    current.layerGeneration === stored.layerGeneration &&
    current.center.lat === stored.center.lat &&
    current.center.lon === stored.center.lon;
}

export function createPartyHandler(
  context: PartyHandlerContext
): RealtimeFamilyHandler<"party"> {
  let partyRequestTimestamps: number[] = [];
  const beginPartyRequest = (): void => {
    const now = Date.now();
    partyRequestTimestamps = partyRequestTimestamps.filter(
      (timestamp) => now - timestamp < 10_000
    );
    if (partyRequestTimestamps.length >= 20) {
      throw new ClassRequestError("CLASS_RATE_LIMITED", "Too many class requests; try again shortly");
    }
    partyRequestTimestamps.push(now);
  };
  return async (message) => {
    const {
      state,
      socket,
      authenticatedSession,
      altDoorway,
      registry,
      gameState,
      worldRuntime,
      partyAuthority,
      partyCombatPublisher,
      partyReadyChecks,
      chats,
      manorPresence,
      manorRuntime,
      travelInvites,
      recentPlayers,
      overworldBossParticipantLeases,
      partyRealtimeState,
      playerAuthorityFence,
      applyAuthoritativeTravelPhase1,
      beginSmoothTravelTransition,
      endSmoothTravelTransition,
      enforcePartyManorAccess,
      enterManorNow,
      performAuthoritativeTravel,
      resolveFlagTravelDestination,
      resolveManorEntryAuthorization,
      safeSendServerMessage,
      sendCombatError,
      sendTravelFailure,
      sendTravelInboxForPlayers,
      waitForRelocationPopulationV2
    } = context;
    const sendPartySnapshots = (
      targetRegistry: ConnectionRegistry,
      authority: MutablePartyAuthority,
      playerIds: Iterable<string>,
      requesterPlayerId: string,
      requestId: string
    ): void => {
      const orderedPlayerIds = [...new Set(playerIds)]
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      for (const memberPlayerId of orderedPlayerIds) {
        const party = authority.partyForPlayer(memberPlayerId);
        const invites = [...authority.invitesForPlayer(memberPlayerId)];
        const inboxInvites = [...authority.inboxInvitesForPlayer(memberPlayerId)];
        const outgoingInvites = party
          ? [...authority.outgoingInvitesForParty(party.partyId)]
          : [];
        targetRegistry.send(memberPlayerId, memberPlayerId === requesterPlayerId
          ? { type: "PARTY_SNAPSHOT", requestId, party, invites, inboxInvites, outgoingInvites }
          : { type: "PARTY_SNAPSHOT", party, invites, inboxInvites, outgoingInvites });
        void chats?.refreshAuthorizedPlayer(memberPlayerId).catch(() => {
          // The authoritative party mutation already succeeded. The chat
          // coordinator will reconcile this player again on the next bootstrap.
        });
      }
      partyCombatPublisher?.sendSnapshots(orderedPlayerIds);
      partyReadyChecks?.reconcileMembership(orderedPlayerIds);
    };
    const sendPartyError = (
      targetSocket: SocketLike,
      requestId: string,
      error: unknown
    ): void => {
      safeSendServerMessage(targetSocket, {
        type: "ERROR",
        requestId,
        code: error instanceof PartyAuthorityError || error instanceof PartyListingError
          ? error.code
          : "PARTY_REQUEST_REJECTED",
        message: error instanceof Error ? error.message : "Party request rejected"
      });
    };
    // Sends the refusal and returns true when the alt doorway refuses.
    const doorwayRefused = (
      targetSocket: SocketLike,
      requestId: string,
      decision: DoorwayDecision
    ): boolean => {
      if (decision.allowed) return false;
      sendCombatError(targetSocket, requestId, decision.code, decision.message, {
        retryable: false,
        ...(decision.retryAfterMs === undefined ? {} : { retryAfterMs: decision.retryAfterMs })
      });
      return true;
    };
    const sendTravelInviteError = (
      targetSocket: SocketLike,
      requestId: string,
      error: unknown
    ): void => {
      safeSendServerMessage(targetSocket, {
        type: "ERROR",
        requestId,
        code: error instanceof TravelInviteError ? error.code : "TRAVEL_INVITE_REQUEST_REJECTED",
        message: error instanceof Error ? error.message : "Travel Invite request rejected",
        ...(error instanceof TravelInviteError && error.retryAfterMs !== undefined
          ? { details: { retryAfterMs: error.retryAfterMs } }
          : {})
      });
    };
    /** Why the joined requester is not teleported, or null when they may be. Server-decided. */
    const listingTeleportDenial = (leaderPlayerId: string, requesterPlayerId: string): string | null =>
      partyListingTeleportDenial({
        gameState,
        worldRuntime,
        combat: context.combat,
        pvpTimerActive: context.pvpTimerActive,
        inManor: (playerId) => Boolean(manorRuntime?.get(playerId)),
        connected: (playerId) => Boolean(registry.activeConnectionIdForPlayer(playerId))
      }, leaderPlayerId, requesterPlayerId);
    const sendListingNotice = (playerId: string, tone: "info" | "success" | "warning", text: string): void => {
      registry.send(playerId, { type: "CHAT_PARTY_LISTING_NOTICE", tone, text });
    };
    /**
     * After an accepted Hunting join: move the requester to the leader through the same
     * party-travel path as Travel to Leader, but only from the overworld and never in
     * combat or under a PvP timer. Otherwise they stay put and are told why.
     */
    const bringJoinedRequesterToLeader = async (
      leaderPlayerId: string,
      requesterPlayerId: string,
      dungeonId: string
    ): Promise<void> => {
      const joined = "You joined the " + chatPartyListingDungeonName(dungeonId) + " party.";
      const denial = listingTeleportDenial(leaderPlayerId, requesterPlayerId);
      const travelRequestId = crypto.randomUUID();
      const transitionToken = denial || !worldRuntime
        ? null
        : beginSmoothTravelTransition(requesterPlayerId, travelRequestId);
      if (!transitionToken) {
        sendListingNotice(requesterPlayerId, "warning",
          joined + " No teleport: " + (denial ?? "another travel is already pending") + ".");
        return;
      }
      let delegated = false;
      try {
        const leader = gameState.getPlayer(leaderPlayerId)!;
        const resourceVision = gameState.getResourceVision(leaderPlayerId);
        const destination = {
          kind: "world" as const,
          id: null,
          center: { ...leader.anchor },
          travelAnchor: gameState.getAuthoritativeTravelAnchor(leaderPlayerId)!,
          ...(resourceVision ? { resourceVision } : {})
        };
        if (altDoorway) {
          const decision = await altDoorway.check({
            kind: "party_manual",
            hostPlayerId: leaderPlayerId,
            guestPlayerId: requesterPlayerId,
            hostPosition: { ...leader.position },
            destination: doorwayDestinationForTravel(destination)
          });
          if (!decision.allowed) {
            sendListingNotice(requesterPlayerId, "warning", joined + " No teleport: " + decision.message);
            return;
          }
        }
        delegated = true;
        const result = await performAuthoritativeTravel({
          playerId: requesterPlayerId,
          destination,
          requestId: travelRequestId,
          arrivalMode: "ordinary_relocation",
          kind: "party_manual",
          transitionToken,
          companionHostPlayerId: leaderPlayerId
        });
        sendListingNotice(requesterPlayerId, result.success ? "success" : "warning", result.success
          ? joined + " You travelled to your leader."
          : joined + " No teleport: " + result.reason.message);
      } finally {
        if (!delegated) endSmoothTravelTransition(requesterPlayerId, travelRequestId, transitionToken, "failed");
      }
    };
    const assertBossRosterPartyMutable = (
      authority: MutablePartyAuthority,
      ...playerIds: string[]
    ): void => {
      const affectedPlayerIds = new Set(playerIds);
      for (const playerId of playerIds) {
        for (const memberPlayerId of authority.partyForPlayer(playerId)?.memberPlayerIds ?? []) {
          affectedPlayerIds.add(memberPlayerId);
        }
      }
      if ([...affectedPlayerIds].some(
        (playerId) => overworldBossParticipantLeases?.isReserved(playerId)
      )) {
        throw new Error("The party roster and leader are frozen during an overworld boss event");
      }
    };
    const runBossRosterMutation = <T>(
      playerIds: readonly string[],
      operation: (authority: MutablePartyAuthority) => T | Promise<T>
    ): Promise<T> => {
      const run = (): T | Promise<T> => {
        const authority = requirePartyAuthority(partyAuthority);
        assertBossRosterPartyMutable(authority, ...playerIds);
        return operation(authority);
      };
      if (overworldBossParticipantLeases) {
        return overworldBossParticipantLeases.runRosterMutation(run);
      }
      try {
        return Promise.resolve(run());
      } catch (error) {
        return Promise.reject(error);
      }
    };
    switch (message.type) {
      case "CREATE_PARTY": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        try {
          await partyRealtimeState.runMutation(actorPlayerId, async () => {
            beginPartyRequest();
            await runBossRosterMutation([actorPlayerId], async (authority) => {
              const snapshot = await authority.createParty(
                `party:${crypto.randomUUID()}`,
                actorPlayerId,
                message.requestId
              );
              sendPartySnapshots(registry, authority, snapshot.memberPlayerIds, actorPlayerId, message.requestId);
            });
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "ADD_PARTY_MEMBER": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        try {
          await partyRealtimeState.runMutation(actorPlayerId, async () => {
            beginPartyRequest();
            await runBossRosterMutation(
              [actorPlayerId, message.targetPlayerId],
              async (authority) => {
                const before = authority.partyForPlayer(actorPlayerId);
                const affected = new Set([...(before?.memberPlayerIds ?? []), message.targetPlayerId, actorPlayerId]);
                await authority.inviteMember(message.targetPlayerId, actorPlayerId, message.requestId);
                sendPartySnapshots(registry, authority, affected, actorPlayerId, message.requestId);
              }
            );
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "INVITE_TO_PARTY": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        try {
          await partyRealtimeState.runMutation(actorPlayerId, async () => {
            beginPartyRequest();
            await runBossRosterMutation(
              [actorPlayerId, message.targetPlayerId],
              async (authority) => {
                const before = authority.partyForPlayer(actorPlayerId);
                await authority.inviteToParty(
                  message.targetPlayerId,
                  actorPlayerId,
                  message.requestId
                );
                const after = authority.partyForPlayer(actorPlayerId);
                sendPartySnapshots(
                  registry,
                  authority,
                  new Set([
                    ...(before?.memberPlayerIds ?? []),
                    ...(after?.memberPlayerIds ?? []),
                    actorPlayerId,
                    message.targetPlayerId
                  ]),
                  actorPlayerId,
                  message.requestId
                );
              }
            );
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "ACCEPT_PARTY_INVITE": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        const invitationId = message.invitationId ?? message.partyId!;
        try {
          await partyRealtimeState.runMutation(actorPlayerId, async () => {
            beginPartyRequest();
            await runBossRosterMutation([actorPlayerId], async (authority) => {
              const invitations = authority.invitesForPlayer(actorPlayerId);
              const invite = invitations
                .find((candidate) =>
                  candidate.invitationId === invitationId || candidate.partyId === invitationId
                );
              if (invite) {
                assertBossRosterPartyMutable(authority, actorPlayerId, invite.leaderPlayerId);
              }
              const before = invite ? authority.partyForPlayer(invite.leaderPlayerId) : null;
              const mergingParty = authority.partyForPlayer(actorPlayerId);
              const invitingPartyMembers = invitations.flatMap((candidate) =>
                authority.partyForPlayer(candidate.leaderPlayerId)?.memberPlayerIds ?? []
              );
              const snapshot = await authority.acceptInvite(invitationId, actorPlayerId, message.requestId);
              for (const joinedPlayerId of mergingParty?.partyId !== snapshot.partyId
                ? mergingParty?.memberPlayerIds ?? [actorPlayerId]
                : [actorPlayerId]) {
                recentPlayers?.recordPartyJoin(
                  joinedPlayerId,
                  before?.memberPlayerIds ?? snapshot.memberPlayerIds.filter(
                    (memberPlayerId) => memberPlayerId !== joinedPlayerId
                  )
                );
              }
              const affected = new Set([
                ...invitingPartyMembers,
                ...(before?.memberPlayerIds ?? []),
                ...(mergingParty?.memberPlayerIds ?? []),
                ...snapshot.memberPlayerIds,
                actorPlayerId
              ]);
              sendPartySnapshots(registry, authority, affected, actorPlayerId, message.requestId);
            });
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "FORWARD_PARTY_INVITE": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        try {
          await partyRealtimeState.runMutation(actorPlayerId, async () => {
            beginPartyRequest();
            await runBossRosterMutation([actorPlayerId], async (authority) => {
              const invite = authority.invitesForPlayer(actorPlayerId)
                .find((candidate) => candidate.invitationId === message.invitationId);
              const sourceParty = authority.partyForPlayer(actorPlayerId);
              if (invite) assertBossRosterPartyMutable(authority, invite.leaderPlayerId);
              const destinationParty = invite ? authority.partyForPlayer(invite.leaderPlayerId) : null;
              const forwarded = await authority.forwardInvite(
                message.invitationId,
                actorPlayerId,
                message.requestId
              );
              sendPartySnapshots(
                registry,
                authority,
                new Set([
                  actorPlayerId,
                  forwarded.targetPlayerId,
                  ...(sourceParty?.memberPlayerIds ?? []),
                  ...(destinationParty?.memberPlayerIds ?? [])
                ]),
                actorPlayerId,
                message.requestId
              );
            });
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "DECLINE_PARTY_INVITE": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        const invitationId = message.invitationId ?? message.partyId!;
        try {
          await partyRealtimeState.runMutation(actorPlayerId, async () => {
            beginPartyRequest();
            const authority = requirePartyAuthority(partyAuthority);
            const invite = authority.invitesForPlayer(actorPlayerId)
              .find((candidate) =>
                candidate.invitationId === invitationId || candidate.partyId === invitationId
              );
            const invitingParty = invite ? authority.partyForPlayer(invite.leaderPlayerId) : null;
            await authority.declineInvite(invitationId, actorPlayerId, message.requestId);
            sendPartySnapshots(
              registry,
              authority,
              [actorPlayerId, ...(invitingParty?.memberPlayerIds ?? [])],
              actorPlayerId,
              message.requestId
            );
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "CANCEL_PARTY_INVITE": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        try {
          await partyRealtimeState.runMutation(actorPlayerId, async () => {
            beginPartyRequest();
            const authority = requirePartyAuthority(partyAuthority);
            const invite = authority.inboxInvitesForPlayer(actorPlayerId)
              .find((candidate) => candidate.invitationId === message.invitationId);
            if (!invite) {
              throw new PartyAuthorityError("PARTY_INVITE_NOT_FOUND", "Party invitation does not exist");
            }
            const party = authority.partyForPlayer(actorPlayerId);
            await authority.cancelInvite(message.invitationId, actorPlayerId, message.requestId);
            sendPartySnapshots(
              registry,
              authority,
              [actorPlayerId, invite.targetPlayerId, ...(party?.memberPlayerIds ?? [])],
              actorPlayerId,
              message.requestId
            );
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "JOIN_PARTY_LISTING": {
        requireHello(state.playerId);
        try {
          beginPartyRequest();
          const request = await requirePartyListings(chats).requestJoin(state.playerId, message.messageId);
          safeSendServerMessage(socket, {
            type: "CHAT_PARTY_LISTING_NOTICE",
            requestId: message.requestId,
            tone: "info",
            text: `Join request sent for ${chatPartyListingDungeonName(request.dungeonId)}. The leader answers in Party chat.`
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "CANCEL_PARTY_LISTING": {
        requireHello(state.playerId);
        try {
          await requirePartyListings(chats).cancel(state.playerId, message.messageId);
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "RESPOND_PARTY_JOIN_REQUEST": {
        requireHello(state.playerId);
        const leaderPlayerId = state.playerId;
        try {
          const listings = requirePartyListings(chats);
          if (message.response === "decline") {
            listings.decline(leaderPlayerId, message.joinRequestId);
            return;
          }
          // Fence leader and requester together, in a stable order, so two leaders accepting
          // each other's requests at once cannot block each other.
          const requesterPlayerId = listings.requesterFor(leaderPlayerId, message.joinRequestId);
          const outcome = await partyRealtimeState.runMutations([leaderPlayerId, requesterPlayerId], async () => {
            beginPartyRequest();
            return listings.accept(leaderPlayerId, message.joinRequestId, (request) =>
                runBossRosterMutation([leaderPlayerId, requesterPlayerId], async (authority) => {
                  const before = authority.partyForPlayer(leaderPlayerId);
                  const requesterBefore = authority.partyForPlayer(requesterPlayerId);
                  // The requester already asked to join, so the leader's invite is accepted on
                  // their behalf. Request ids derive from the join request: a repeat is a replay.
                  const invite = await authority.inviteToParty(
                    requesterPlayerId,
                    leaderPlayerId,
                    `listing-invite:${request.joinRequestId}`
                  );
                  const snapshot = await authority.acceptInvite(
                    invite.invitationId,
                    requesterPlayerId,
                    `listing-accept:${request.joinRequestId}`
                  );
                  recentPlayers?.recordPartyJoin(requesterPlayerId, before?.memberPlayerIds ?? [leaderPlayerId]);
                  sendPartySnapshots(registry, authority, new Set([
                    ...(before?.memberPlayerIds ?? []),
                    ...(requesterBefore?.memberPlayerIds ?? []),
                    ...snapshot.memberPlayerIds,
                    leaderPlayerId,
                    requesterPlayerId
                  ]), leaderPlayerId, message.requestId);
                })
            );
          });
          // Travel runs after the fences are released so it never holds party mutations.
          if (!outcome.alreadyAccepted) {
            await bringJoinedRequesterToLeader(leaderPlayerId, requesterPlayerId, outcome.request.dungeonId);
          }
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "REMOVE_PARTY_MEMBER": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        try {
          await partyRealtimeState.runMutation(actorPlayerId, async () => {
            beginPartyRequest();
            await runBossRosterMutation(
              [actorPlayerId, message.targetPlayerId],
              async (authority) => {
                const before = authority.partyForPlayer(actorPlayerId);
                const affected = new Set([...(before?.memberPlayerIds ?? []), message.targetPlayerId, actorPlayerId]);
                await authority.removePartyMember(message.targetPlayerId, actorPlayerId, message.requestId);
                sendPartySnapshots(registry, authority, affected, actorPlayerId, message.requestId);
                await enforcePartyManorAccess(affected);
              }
            );
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "LEAVE_PARTY": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        try {
          await partyRealtimeState.runMutation(actorPlayerId, async () => {
            beginPartyRequest();
            await runBossRosterMutation([actorPlayerId], async (authority) => {
              const before = authority.partyForPlayer(actorPlayerId);
              const affected = new Set([...(before?.memberPlayerIds ?? []), actorPlayerId]);
              await authority.leaveParty(actorPlayerId, message.requestId);
              sendPartySnapshots(registry, authority, affected, actorPlayerId, message.requestId);
              await enforcePartyManorAccess(affected);
            });
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "DISBAND_PARTY": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        try {
          await partyRealtimeState.runMutation(actorPlayerId, async () => {
            beginPartyRequest();
            await runBossRosterMutation([actorPlayerId], async (authority) => {
              const before = authority.partyForPlayer(actorPlayerId);
              if (!before) {
                throw new PartyAuthorityError("PARTY_NOT_FOUND", "Player does not belong to a party");
              }
              const affected = new Set([...before.memberPlayerIds, actorPlayerId]);
              await authority.disbandParty(before.partyId, actorPlayerId, message.requestId);
              sendPartySnapshots(registry, authority, affected, actorPlayerId, message.requestId);
              await enforcePartyManorAccess(affected);
            });
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "REQUEST_PARTY_COMBAT_SNAPSHOT": {
        requireHello(state.playerId);
        partyCombatPublisher?.sendSnapshot(state.playerId);
        return;
      }
      case "START_PARTY_READY_CHECK": {
        requireHello(state.playerId);
        try {
          beginPartyRequest();
          if (!partyReadyChecks) {
            throw new PartyAuthorityError("PARTY_UNAVAILABLE", "Ready checks are unavailable");
          }
          partyReadyChecks.start(state.playerId, message.requestId);
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "RESPOND_PARTY_READY_CHECK": {
        requireHello(state.playerId);
        try {
          beginPartyRequest();
          if (!partyReadyChecks) {
            throw new PartyAuthorityError("PARTY_UNAVAILABLE", "Ready checks are unavailable");
          }
          partyReadyChecks.respond(
            state.playerId,
            message.readyCheckId,
            message.response,
            message.requestId
          );
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "CANCEL_PARTY_READY_CHECK": {
        requireHello(state.playerId);
        try {
          beginPartyRequest();
          if (!partyReadyChecks) {
            throw new PartyAuthorityError("PARTY_UNAVAILABLE", "Ready checks are unavailable");
          }
          partyReadyChecks.cancel(
            state.playerId,
            message.readyCheckId,
            message.requestId
          );
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "CHANGE_PARTY_LEADER": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        try {
          await partyRealtimeState.runMutation(actorPlayerId, async () => {
            beginPartyRequest();
            await runBossRosterMutation(
              [actorPlayerId, message.targetPlayerId],
              async (authority) => {
                const before = authority.partyForPlayer(actorPlayerId);
                await authority.changePartyLeader(message.targetPlayerId, actorPlayerId, message.requestId);
                sendPartySnapshots(
                  registry,
                  authority,
                  new Set([...(before?.memberPlayerIds ?? []), message.targetPlayerId, actorPlayerId]),
                  actorPlayerId,
                  message.requestId
                );
                await enforcePartyManorAccess([
                  ...(before?.memberPlayerIds ?? []),
                  message.targetPlayerId,
                  actorPlayerId
                ]);
              }
            );
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "SET_PARTY_TRAVEL_ALLOWED": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        try {
          await partyRealtimeState.runMutation(actorPlayerId, async () => {
            beginPartyRequest();
            const authority = requirePartyAuthority(partyAuthority);
            const before = authority.partyForPlayer(actorPlayerId);
            const snapshot = await authority.setTravelAllowed(actorPlayerId, message.requestId, message.allowed);
            sendPartySnapshots(
              registry,
              authority,
              new Set([...(before?.memberPlayerIds ?? []), ...snapshot.memberPlayerIds]),
              actorPlayerId,
              message.requestId
            );
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "SET_PARTY_AUTO_FOLLOW": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        try {
          await partyRealtimeState.runMutation(actorPlayerId, async () => {
            beginPartyRequest();
            const authority = requirePartyAuthority(partyAuthority);
            const snapshot = await authority.setAutoFollow(actorPlayerId, message.requestId, message.enabled);
            sendPartySnapshots(registry, authority, snapshot.memberPlayerIds, actorPlayerId, message.requestId);
          });
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        }
        return;
      }
      case "TRAVEL_TO_PARTY_LEADER": {
        requireHello(state.playerId);
        const actorPlayerId = state.playerId;
        let transitionToken: symbol | null = null;
        let transitionDelegated = false;
        try {
          const authority = requirePartyAuthority(partyAuthority);
          const party = authority.partyForPlayer(actorPlayerId);
          if (!party || !party.memberPlayerIds.includes(actorPlayerId)) {
            throw new PartyAuthorityError("PARTY_NOT_FOUND", "Player does not belong to a party");
          }
          if (party.leaderPlayerId === actorPlayerId) {
            throw new PartyAuthorityError("PARTY_NOT_LEADER", "The party leader is already at the party destination");
          }
          if (!party.allowTravel) {
            throw new PartyAuthorityError("PARTY_UNAVAILABLE", "The party leader has not enabled Party Travel");
          }
          transitionToken = beginSmoothTravelTransition(actorPlayerId, message.requestId);
          if (!transitionToken || !worldRuntime) {
            sendCombatError(
              socket,
              message.requestId,
              "PLAYER_WORLD_TRANSITION_PENDING",
              "Another travel transition is already pending."
            );
            return;
          }
          const leaderManorSession = manorRuntime?.get(party.leaderPlayerId) ?? null;
          if (leaderManorSession) {
            if (!manorPresence) throw new ManorError("UNAVAILABLE", "Manor travel is unavailable.");
            const leaderPresence = await manorPresence.load(party.leaderPlayerId);
            if (!leaderPresence || leaderPresence.manorId !== leaderManorSession.manorId) {
              throw new ManorError("MANOR_NOT_BUILT", "The party manor destination is no longer available.");
            }
            const authorization = await resolveManorEntryAuthorization(
              actorPlayerId,
              leaderPresence.manorId
            );
            if (authorization.accessSource !== "PARTY") {
              throw new ManorError("MANOR_ACCESS_DENIED", "Party travel does not grant access to this manor.");
            }
            if (altDoorway && doorwayRefused(socket, message.requestId, await altDoorway.check({
              kind: "party_manual",
              hostPlayerId: party.leaderPlayerId,
              guestPlayerId: actorPlayerId,
              hostPosition: gameState.getPlayer(party.leaderPlayerId)?.position ?? null,
              destination: { kind: "manor", ownerPlayerId: leaderPresence.ownerPlayerId }
            }))) return;
            await playerAuthorityFence.runMany(
              [actorPlayerId, leaderPresence.ownerPlayerId],
              () => enterManorNow({
                playerId: actorPlayerId,
                manorId: leaderPresence.manorId,
                requestId: message.requestId,
                expectedPlacementRevision: authorization.manor.placementRevision,
                skipProximity: true,
                transitionToken: transitionToken!
              })
            );
            transitionDelegated = true;
            endSmoothTravelTransition(
              actorPlayerId,
              message.requestId,
              transitionToken,
              "committed"
            );
            return;
          }
          const leader = gameState.getPlayer(party.leaderPlayerId);
          if (!leader?.online || !registry.activeConnectionIdForPlayer(party.leaderPlayerId) || !gameState.isWorldPresent(party.leaderPlayerId)) {
            throw new PartyAuthorityError("PARTY_TARGET_OFFLINE", "The party leader is not available in a compatible world location");
          }
          const leaderVision = gameState.getResourceVision(party.leaderPlayerId);
          const leaderTravelAnchor =
            gameState.getAuthoritativeTravelAnchor(party.leaderPlayerId);
          const destination = leaderVision && !leaderVision.destinationKind
            ? await resolveFlagTravelDestination(leaderVision.flagId)
            : leaderTravelAnchor
              ? {
                  kind: "world" as const,
                  id: null,
                  center: { ...leader.anchor },
                  travelAnchor: leaderTravelAnchor,
                  ...(leaderVision ? { resourceVision: leaderVision } : {})
                }
              : null;
          if (!destination) throw new Error("The party leader's destination is no longer valid");
          if (altDoorway && doorwayRefused(socket, message.requestId, await altDoorway.check({
            kind: "party_manual",
            hostPlayerId: party.leaderPlayerId,
            guestPlayerId: actorPlayerId,
            hostPosition: { ...leader.position },
            destination: doorwayDestinationForTravel(destination)
          }))) return;
          transitionDelegated = true;
          const result = await performAuthoritativeTravel({
            playerId: actorPlayerId,
            destination,
            requestId: message.requestId,
            arrivalMode: destination.kind === "world"
              ? "ordinary_relocation"
              : "protected_jump",
            kind: "party_manual",
            transitionToken,
            companionHostPlayerId: party.leaderPlayerId
          });
          if (!result.success) sendTravelFailure(actorPlayerId, "party_manual", result.reason, message.requestId);
        } catch (error) {
          sendPartyError(socket, message.requestId, error);
        } finally {
          if (transitionToken && !transitionDelegated) {
            endSmoothTravelTransition(
              actorPlayerId,
              message.requestId,
              transitionToken,
              "failed"
            );
          }
        }
        return;
      }
      case "REQUEST_TRAVEL_INBOX": {
        requireHello(state.playerId);
        try {
          if (!travelInvites) throw new Error("Travel Invites are unavailable");
          await sendTravelInboxForPlayers([state.playerId]);
        } catch (error) {
          sendTravelInviteError(socket, message.requestId, error);
        }
        return;
      }
      case "SEND_TRAVEL_INVITE": {
        requireHello(state.playerId);
        try {
          if (!travelInvites || !authenticatedSession) throw new Error("Travel Invites are unavailable");
          let anchor = gameState.getAuthoritativeTravelAnchor(state.playerId);
          const manorSession = manorRuntime?.get(state.playerId) ?? null;
          if (manorSession) {
            if (!manorPresence) throw new ManorError("UNAVAILABLE", "Manor invitations are unavailable.");
            const presence = await manorPresence.load(state.playerId);
            const manor = presence ? await manorPresence.builtManor(presence.manorId) : null;
            if (!presence || !manor || presence.ownerPlayerId !== state.playerId) {
              throw new ManorError("MANOR_OWNER_REQUIRED", "Only the manor owner may invite guests.");
            }
            if (await manorPresence.isBanned(manor.manorId, message.targetPlayerId)) {
              throw new ManorError("MANOR_BANNED", "That player is banned from this manor.");
            }
            anchor = {
              scopeId: "manor",
              layerId: `manor:${manor.manorId}`,
              center: { lat: manor.lat, lon: manor.lon },
              relocationRevision: manorSession.position.revision,
              layerGeneration: manor.placementRevision,
              sourceType: "manor",
              sourceId: manor.manorId
            };
          }
          if (!anchor) {
            throw new TravelInviteError(
              "TRAVEL_INVITE_TARGET_INVALID",
              "You must be in an active gameplay area to send a Travel Invite."
            );
          }
          const inviteAnchor = anchor;
          const inviterPlayerId = state.playerId;
          const result = await travelInvites.send({
            inviterPlayerId,
            inviteePlayerId: message.targetPlayerId,
            inviterSessionId: authenticatedSession.sessionId,
            anchor,
            requestId: message.requestId,
            // Alt doorway: new sends only, so a replay returns the original result.
            ...(altDoorway
              ? {
                  beforeCreate: async () => {
                    const decision = await altDoorway.check({
                      kind: "invite",
                      hostPlayerId: inviterPlayerId,
                      guestPlayerId: message.targetPlayerId,
                      hostPosition: gameState.getPlayer(inviterPlayerId)?.position ?? null,
                      destination: doorwayDestinationForAnchor(inviteAnchor, inviterPlayerId),
                      hostClientPlatform: context.clientPlatform
                    });
                    if (!decision.allowed) {
                      throw new TravelInviteError(
                        decision.code as TravelInviteErrorCode,
                        decision.message,
                        decision.retryAfterMs
                      );
                    }
                  }
                }
              : {})
          });
          await sendTravelInboxForPlayers(result.playerIds);
          registry.send(state.playerId, {
            type: "TRAVEL_RESULT",
            requestId: message.requestId,
            kind: "invite_sent",
            success: true,
            message: result.replayed ? "Travel Invite already sent." : "Travel Invite sent."
          });
        } catch (error) {
          sendTravelInviteError(socket, message.requestId, error);
        }
        return;
      }
      case "RESPOND_TRAVEL_INVITE": {
        requireHello(state.playerId);
        const inviteePlayerId = state.playerId;
        if (!travelInvites) {
          sendTravelInviteError(socket, message.requestId, new Error("Travel Invites are unavailable"));
          return;
        }
        if (message.response === "decline") {
          try {
            const affected = await travelInvites.decline(message.inviteId, inviteePlayerId, message.requestId);
            await sendTravelInboxForPlayers(affected);
            registry.send(inviteePlayerId, {
              type: "TRAVEL_RESULT",
              requestId: message.requestId,
              kind: "invite",
              success: true,
              message: "Travel Invite declined."
            });
          } catch (error) {
            sendTravelInviteError(socket, message.requestId, error);
          }
          return;
        }
        if (!worldRuntime) {
          sendTravelInviteError(
            socket,
            message.requestId,
            new Error("World runtime is unavailable")
          );
          return;
        }
        const transitionToken =
          beginSmoothTravelTransition(inviteePlayerId, message.requestId);
        if (!transitionToken) {
          sendCombatError(
            socket,
            message.requestId,
            "PLAYER_WORLD_TRANSITION_PENDING",
            "Another travel transition is already pending."
          );
          return;
        }
        let reserved = false;
        let travelCompleted = false;
        let affectedInboxPlayerIds: string[] = [];
        let phase1Result:
          Awaited<ReturnType<typeof applyAuthoritativeTravelPhase1>> | null =
          null;
        const committedTravel: {
          destination: ResolvedTravelDestination | null;
        } = { destination: null };
        let failure: unknown = null;
        try {
          const invite = await travelInvites.reserveAcceptance(
            message.inviteId,
            inviteePlayerId,
            message.requestId
          );
          reserved = true;
          if (invite.anchor.sourceType === "manor" && invite.anchor.sourceId) {
            if (!manorPresence || !manorRuntime) {
              throw new ManorError("UNAVAILABLE", "Manor invitations are unavailable.");
            }
            const manor = await manorPresence.builtManor(invite.anchor.sourceId);
            const ownerSession = manorRuntime.get(invite.inviterPlayerId);
            if (
              !manor ||
              manor.ownerPlayerId !== invite.inviterPlayerId ||
              ownerSession?.manorId !== manor.manorId ||
              await manorPresence.isBanned(manor.manorId, inviteePlayerId)
            ) {
              await travelInvites.releaseAcceptance(
                message.inviteId,
                inviteePlayerId,
                message.requestId
              );
              reserved = false;
              affectedInboxPlayerIds = await travelInvites.invalidateForManor(
                invite.anchor.sourceId,
                "The manor invitation is no longer valid.",
                inviteePlayerId
              );
              throw new TravelInviteError(
                "TRAVEL_INVITE_NOT_PENDING",
                "The manor invitation is no longer valid."
              );
            }
            await playerAuthorityFence.runMany(
              [inviteePlayerId, invite.inviterPlayerId],
              () => enterManorNow({
                playerId: inviteePlayerId,
                manorId: manor.manorId,
                requestId: message.requestId,
                expectedPlacementRevision: manor.placementRevision,
                reservedInviteId: invite.inviteId,
                skipProximity: true,
                transitionToken
              })
            );
            reserved = false;
            travelCompleted = true;
            endSmoothTravelTransition(
              inviteePlayerId,
              message.requestId,
              transitionToken,
              "committed"
            );
            await sendTravelInboxForPlayers([
              invite.inviterPlayerId,
              inviteePlayerId,
              ...affectedInboxPlayerIds
            ]);
            return;
          }
          phase1Result = await playerAuthorityFence.runMany(
            [inviteePlayerId, invite.inviterPlayerId],
            async () => {
              const inviterConnectionId =
                registry.activeConnectionIdForPlayer(invite.inviterPlayerId);
              const inviterConnection = inviterConnectionId
                ? registry.recordForConnection(inviterConnectionId)
                : null;
              const currentAnchor =
                gameState.getAuthoritativeTravelAnchor(invite.inviterPlayerId);
              const inviterVision =
                gameState.getResourceVision(invite.inviterPlayerId);
              if (
                !inviterConnection ||
                inviterConnection.authSessionId !== invite.inviterSessionId ||
                !currentAnchor ||
                !sameTravelAnchor(currentAnchor, invite.anchor)
              ) {
                await travelInvites.releaseAcceptance(
                  message.inviteId,
                  inviteePlayerId,
                  message.requestId
                );
                reserved = false;
                affectedInboxPlayerIds =
                  await travelInvites.invalidateForInviter(
                    invite.inviterPlayerId,
                    "The inviter is no longer in the original gameplay layer."
                  );
                throw new TravelInviteError(
                  "TRAVEL_INVITE_NOT_PENDING",
                  "The inviter is no longer in the original gameplay layer."
                );
              }

              let destination: ResolvedTravelDestination;
              if (
                invite.anchor.sourceType === "flag" &&
                invite.anchor.sourceId
              ) {
                const flagDestination = await resolveFlagTravelDestination(
                  invite.anchor.sourceId
                );
                if (!flagDestination || !inviterVision) {
                  await travelInvites.releaseAcceptance(
                    message.inviteId,
                    inviteePlayerId,
                    message.requestId
                  );
                  reserved = false;
                  affectedInboxPlayerIds =
                    await travelInvites.invalidateForInviter(
                      invite.inviterPlayerId,
                      "The inviter gameplay layer is no longer available."
                    );
                  throw new TravelInviteError(
                    "TRAVEL_INVITE_NOT_PENDING",
                    "The inviter gameplay layer is no longer available."
                  );
                }
                destination = {
                  ...flagDestination,
                  travelAnchor: invite.anchor,
                  resourceVision: inviterVision
                };
              } else {
                destination = {
                  kind: "world",
                  id: null,
                  center: { ...invite.anchor.center },
                  travelAnchor: invite.anchor,
                  ...(inviterVision ? { resourceVision: inviterVision } : {})
                };
              }

              committedTravel.destination = destination;
              return applyAuthoritativeTravelPhase1({
                playerId: inviteePlayerId,
                destination,
                requestId: message.requestId,
                arrivalMode: destination.kind === "world"
                  ? "ordinary_relocation"
                  : "protected_jump",
                kind: "invite",
                companionHostPlayerId: invite.inviterPlayerId,
                beforePublish: async (client) => {
                  const confirmedAnchor =
                    gameState.getAuthoritativeTravelAnchor(
                      invite.inviterPlayerId
                    );
                  const inviterStillConnected =
                    registry.activeConnectionIdForPlayer(
                      invite.inviterPlayerId
                    );
                  if (
                    !confirmedAnchor ||
                    !inviterStillConnected ||
                    !sameTravelAnchor(confirmedAnchor, invite.anchor)
                  ) {
                    if (!client) {
                      await travelInvites.releaseAcceptance(
                        message.inviteId,
                        inviteePlayerId,
                        message.requestId
                      );
                      reserved = false;
                      affectedInboxPlayerIds =
                        await travelInvites.invalidateForInviter(
                          invite.inviterPlayerId,
                          "The inviter is no longer in the original gameplay layer."
                        );
                    }
                    throw new TravelInviteError(
                      "TRAVEL_INVITE_NOT_PENDING",
                      "The inviter is no longer in the original gameplay layer."
                    );
                  }
                  affectedInboxPlayerIds = client
                    ? await travelInvites.completeAcceptanceInTransaction(
                        client,
                        message.inviteId,
                        inviteePlayerId,
                        message.requestId
                      )
                    : await travelInvites.completeAcceptance(
                        message.inviteId,
                        inviteePlayerId,
                        message.requestId
                      );
                  travelCompleted = true;
                  reserved = false;
                }
              });
            }
          );
          if (!phase1Result.success) {
            if (reserved) {
              await travelInvites.releaseAcceptance(
                message.inviteId,
                inviteePlayerId,
                message.requestId
              );
              reserved = false;
            }
            sendTravelFailure(
              inviteePlayerId,
              "invite",
              phase1Result.reason,
              message.requestId
            );
          }
        } catch (error) {
          failure = error;
          if (reserved && !travelCompleted) {
            await travelInvites.releaseAcceptance(
              message.inviteId,
              inviteePlayerId,
              message.requestId
            ).catch(() => undefined);
            reserved = false;
          }
        }
        const committedDestination = committedTravel.destination;
        if (phase1Result?.success && committedDestination !== null) {
          void waitForRelocationPopulationV2({
            playerId: inviteePlayerId,
            requestId: message.requestId,
            destination: committedDestination.center,
            transitionToken,
            relocation: phase1Result.populationRelocation
          }).catch(() => undefined);
        }
        endSmoothTravelTransition(
          inviteePlayerId,
          message.requestId,
          transitionToken,
          phase1Result?.success ? "committed" : "failed"
        );
        if (phase1Result?.success) {
          void phase1Result.phase2();
        }
        if (affectedInboxPlayerIds.length > 0) {
          void sendTravelInboxForPlayers(affectedInboxPlayerIds);
        }
        if (failure) {
          sendTravelInviteError(socket, message.requestId, failure);
        }
        return;
      }
      case "CANCEL_TRAVEL_INVITE": {
        requireHello(state.playerId);
        try {
          if (!travelInvites) throw new Error("Travel Invites are unavailable");
          const affected = await travelInvites.cancel(message.inviteId, state.playerId, message.requestId);
          await sendTravelInboxForPlayers(affected);
          registry.send(state.playerId, {
            type: "TRAVEL_RESULT",
            requestId: message.requestId,
            kind: "invite",
            success: true,
            message: "Travel Invite cancelled."
          });
        } catch (error) {
          sendTravelInviteError(socket, message.requestId, error);
        }
        return;
      }
    }
  };
}

export function registerPartyHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"party">
): void {
  router.register("party", handler);
}
