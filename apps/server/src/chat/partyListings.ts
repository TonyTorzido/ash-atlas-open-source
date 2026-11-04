import {
  CHAT_HUNTING_CHANNEL_KEY,
  CHAT_PARTY_LISTING_TARGET_SIZE,
  CHAT_PARTY_LISTING_TTL_MS,
  chatPartyListingDungeonName,
  chatPartyListingRequiredLevel,
  type ChatChannelKey,
  type ChatMessage,
  type ChatPartyJoinRequest,
  type ChatPartyListing,
  type ChatPartyListingInput,
  type ChatPartyListingState,
  type SpecializationId,
  type ServerMessage
} from "@ash-atlas/shared";

import type { CombatEngine } from "../game/combat/combatEngine.js";
import type { MutablePartyAuthority, PartySnapshot } from "../game/party/PartyAuthority.js";
import type { GameState } from "../game/state.js";
import { getTravelBlockReason } from "../game/travelEligibility.js";
import type { WorldRuntime } from "../game/worldRuntime.js";

/**
 * Why an accepted Hunting requester is not teleported to the leader, or null when they may be.
 * Only from the overworld (no dungeon, manor, or other interior), and never while either player
 * is in combat or under a PvP timer; the requester must also pass ordinary travel eligibility.
 */
export function partyListingTeleportDenial(
  deps: Readonly<{
    gameState: GameState;
    worldRuntime?: WorldRuntime | undefined;
    combat?: CombatEngine | undefined;
    pvpTimerActive?: ((playerId: string) => boolean) | undefined;
    inManor(playerId: string): boolean;
    connected(playerId: string): boolean;
  }>,
  leaderPlayerId: string,
  requesterPlayerId: string
): string | null {
  const { gameState } = deps;
  if (deps.inManor(leaderPlayerId) || !gameState.isWorldPresent(leaderPlayerId)) {
    return "the leader is inside a dungeon or building";
  }
  if (!gameState.getPlayer(leaderPlayerId)?.online || !deps.connected(leaderPlayerId)) return "the leader is offline";
  if (!gameState.getAuthoritativeTravelAnchor(leaderPlayerId)) return "the leader is not on the overworld";
  const sides = [[leaderPlayerId, "the leader is"], [requesterPlayerId, "you are"]] as const;
  for (const [playerId, who] of sides) {
    if (deps.combat?.isInCombat(playerId)) return who + " in combat";
    if (deps.pvpTimerActive?.(playerId)) return who + " under a PvP timer";
  }
  if (deps.inManor(requesterPlayerId) || !gameState.isWorldPresent(requesterPlayerId)) {
    return "you are inside a dungeon or building";
  }
  const blocked = getTravelBlockReason({
    playerId: requesterPlayerId,
    gameState,
    ...(deps.worldRuntime ? { worldRuntime: deps.worldRuntime } : {}),
    ...(deps.combat ? { combat: deps.combat } : {})
  });
  return blocked ? blocked.message : null;
}

/** Pending requests a single leader can hold at once; older ones must be answered first. */
const MAX_PENDING_PER_LEADER = 12;
const DEFAULT_TICK_MS = 2_000;

export type PartyListingProfile = Readonly<{ displayName: string; classId: SpecializationId | null; level: number }>;

export type PartyListingErrorCode =
  | "PARTY_LISTING_INVALID"
  | "PARTY_LISTING_CLOSED"
  | "PARTY_LISTING_FULL"
  | "PARTY_LISTING_LEVEL"
  | "PARTY_LISTING_IN_PARTY"
  | "PARTY_LISTING_NOT_LEADER"
  | "PARTY_LISTING_REQUEST_GONE"
  | "PARTY_LISTING_BUSY";

export class PartyListingError extends Error {
  constructor(readonly code: PartyListingErrorCode, message: string) {
    super(message);
    this.name = "PartyListingError";
  }
}

type IndexedListing = {
  messageId: string;
  senderPlayerId: string;
  createdAtMs: number;
  listing: ChatPartyListing;
};

type JoinRequestRecord = ChatPartyJoinRequest & {
  leaderPlayerId: string;
  partyId: string;
  status: "pending" | "accepted" | "declined" | "closed";
};

export type PartyListingDependencies = Readonly<{
  chat: Readonly<{
    recentPartyListings(since: Date): Promise<Array<{
      messageId: string;
      senderPlayerId: string;
      createdAt: string;
      listing: ChatPartyListing;
    }>>;
    cancelPartyListing(playerId: string, messageId: string): Promise<boolean>;
  }>;
  partyAuthority: () => MutablePartyAuthority | undefined;
  /** Display name, active class and level, read from the database (never from the client). */
  profile(playerId: string): Promise<PartyListingProfile>;
  send(playerId: string, message: ServerMessage): void;
  sendToConnection(connectionId: string, message: ServerMessage): void;
  /** Connections that can see the Hunting room (active or preview subscribers). */
  huntingConnectionIds(): Iterable<string>;
  sendToConnectionIds(connectionIds: Set<string>, message: ServerMessage): void;
  /** Pushes a fresh party snapshot after the service created a party for a leader card. */
  partyCreated(playerId: string, requestId: string): void;
  now?: () => number;
}>;

/**
 * Hunting party-finder cards. Cards are ordinary chat messages; their live state
 * (open / Party full / Closed) is projected here from party state and expiry and
 * pushed to Hunting viewers, so chat history is never rewritten. Join requests
 * live only in memory: they are short-lived and bounded by the card's 15 minutes.
 */
export class PartyListingService {
  private readonly listings = new Map<string, IndexedListing>();
  private readonly joinRequests = new Map<string, JoinRequestRecord>();
  private readonly partyLocks = new Map<string, Promise<unknown>>();
  private lastStatesKey = "";
  private readonly lastRequestsKeyByLeader = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: PartyListingDependencies) {
    this.now = deps.now ?? Date.now;
  }

  async load(): Promise<void> {
    const recent = await this.deps.chat.recentPartyListings(new Date(this.now() - CHAT_PARTY_LISTING_TTL_MS));
    for (const entry of recent) {
      this.listings.set(entry.messageId, {
        messageId: entry.messageId,
        senderPlayerId: entry.senderPlayerId,
        createdAtMs: Date.parse(entry.createdAt),
        listing: entry.listing
      });
    }
  }

  start(intervalMs = DEFAULT_TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Builds the stored card for a post. A leader card needs the poster to lead a
   * party (one is created when they have none); a seeker card carries the
   * poster's class and level from the database.
   */
  async prepare(
    playerId: string,
    channelKey: ChatChannelKey,
    input: ChatPartyListingInput,
    requestId: string
  ): Promise<ChatPartyListing> {
    if (channelKey !== CHAT_HUNTING_CHANNEL_KEY) {
      throw new PartyListingError("PARTY_LISTING_INVALID", "Party cards can only be posted in Hunting.");
    }
    if (input.kind === "seeker") {
      const profile = await this.deps.profile(playerId);
      return {
        kind: "seeker",
        dungeonId: input.dungeonId,
        level: profile.level,
        ...(profile.classId ? { classId: profile.classId } : {})
      };
    }
    const authority = this.requireAuthority();
    let party: PartySnapshot | null = authority.partyForPlayer(playerId);
    if (party && party.leaderPlayerId !== playerId) {
      throw new PartyListingError("PARTY_LISTING_NOT_LEADER", "Only your party leader can post a party card.");
    }
    if (party && party.memberPlayerIds.length >= CHAT_PARTY_LISTING_TARGET_SIZE) {
      throw new PartyListingError("PARTY_LISTING_FULL", "Your party is already full.");
    }
    if (!party) {
      party = await authority.createParty(`party:${crypto.randomUUID()}`, playerId, `party-listing:${requestId}`);
      this.deps.partyCreated(playerId, requestId);
    }
    return { kind: "leader", dungeonId: input.dungeonId, partyId: party.partyId };
  }

  recordPosted(message: ChatMessage): void {
    if (!message.partyListing || this.listings.has(message.id)) return;
    this.listings.set(message.id, {
      messageId: message.id,
      senderPlayerId: message.senderPlayerId,
      createdAtMs: Date.parse(message.createdAt),
      listing: message.partyListing
    });
    this.tick();
  }

  stateOf(messageId: string): ChatPartyListingState {
    const entry = this.listings.get(messageId);
    return entry ? this.project(entry) : { messageId, status: "closed", memberCount: 0 };
  }

  states(): ChatPartyListingState[] {
    return [...this.listings.values()].map((entry) => this.project(entry));
  }

  pendingRequestsFor(leaderPlayerId: string): ChatPartyJoinRequest[] {
    return [...this.joinRequests.values()]
      .filter((request) => request.status === "pending" && request.leaderPlayerId === leaderPlayerId)
      .map(publicRequest);
  }

  /** Current states and this player's pending requests, for a (re)connecting client. */
  sendInitial(connectionId: string, playerId: string): void {
    this.deps.sendToConnection(connectionId, { type: "CHAT_PARTY_LISTING_STATES", states: this.states() });
    this.deps.sendToConnection(connectionId, {
      type: "CHAT_PARTY_JOIN_REQUESTS",
      requests: this.pendingRequestsFor(playerId)
    });
  }

  async cancel(playerId: string, messageId: string): Promise<void> {
    const entry = this.listings.get(messageId);
    if (!entry || entry.senderPlayerId !== playerId) {
      throw new PartyListingError("PARTY_LISTING_CLOSED", "That card is already closed.");
    }
    if (!entry.listing.cancelled) {
      await this.deps.chat.cancelPartyListing(playerId, messageId);
      entry.listing = { ...entry.listing, cancelled: true };
    }
    this.tick();
  }

  /** Requester side. Repeating a pending request returns the same one without notifying again. */
  async requestJoin(playerId: string, messageId: string): Promise<ChatPartyJoinRequest> {
    const entry = this.listings.get(messageId);
    if (!entry || entry.listing.kind !== "leader" || !entry.listing.partyId) {
      throw new PartyListingError("PARTY_LISTING_CLOSED", "This party card is closed.");
    }
    if (entry.senderPlayerId === playerId) {
      throw new PartyListingError("PARTY_LISTING_INVALID", "This is your own party card.");
    }
    this.assertOpen(entry);
    const existing = [...this.joinRequests.values()].find((request) =>
      request.listingMessageId === messageId &&
      request.requesterPlayerId === playerId &&
      request.status === "pending"
    );
    if (existing) return publicRequest(existing);
    const profile = await this.deps.profile(playerId);
    this.assertRequesterEligible(entry, playerId, profile);
    const leaderPending = this.pendingRequestsFor(entry.senderPlayerId).length;
    if (leaderPending >= MAX_PENDING_PER_LEADER) {
      throw new PartyListingError("PARTY_LISTING_BUSY", "This leader has too many requests waiting. Try again soon.");
    }
    // Re-check after the profile read: another request may have landed meanwhile.
    const raced = [...this.joinRequests.values()].find((request) =>
      request.listingMessageId === messageId &&
      request.requesterPlayerId === playerId &&
      request.status === "pending"
    );
    if (raced) return publicRequest(raced);
    const record: JoinRequestRecord = {
      joinRequestId: crypto.randomUUID(),
      listingMessageId: messageId,
      dungeonId: entry.listing.dungeonId,
      requesterPlayerId: playerId,
      requesterName: profile.displayName,
      classId: profile.classId,
      level: profile.level,
      createdAt: new Date(this.now()).toISOString(),
      leaderPlayerId: entry.senderPlayerId,
      partyId: entry.listing.partyId,
      status: "pending"
    };
    this.joinRequests.set(record.joinRequestId, record);
    this.deps.send(record.leaderPlayerId, {
      type: "CHAT_PARTY_LISTING_NOTICE",
      tone: "info",
      text: `${record.requesterName} asks to join your ${chatPartyListingDungeonName(record.dungeonId)} party. See Party chat.`
    });
    this.tick();
    return publicRequest(record);
  }

  /** Who asked, for a request this leader may answer; throws when it is not theirs or gone. */
  requesterFor(leaderPlayerId: string, joinRequestId: string): string {
    const record = this.joinRequests.get(joinRequestId);
    if (!record || record.leaderPlayerId !== leaderPlayerId) {
      throw new PartyListingError("PARTY_LISTING_REQUEST_GONE", "That join request is no longer available.");
    }
    return record.requesterPlayerId;
  }

  decline(leaderPlayerId: string, joinRequestId: string): void {
    const record = this.joinRequests.get(joinRequestId);
    if (!record || record.leaderPlayerId !== leaderPlayerId) {
      throw new PartyListingError("PARTY_LISTING_REQUEST_GONE", "That join request is no longer available.");
    }
    if (record.status !== "pending") return;
    record.status = "declined";
    this.deps.send(record.requesterPlayerId, {
      type: "CHAT_PARTY_LISTING_NOTICE",
      tone: "warning",
      text: `Your request to join the ${chatPartyListingDungeonName(record.dungeonId)} party was declined.`
    });
    this.tick();
  }

  /**
   * Leader side. Accepts for one party run strictly one at a time, and every
   * check is repeated inside that turn, so two accepts for the last slot can
   * never both add a member. A repeated accept of an accepted request is a no-op.
   */
  async accept(
    leaderPlayerId: string,
    joinRequestId: string,
    join: (request: ChatPartyJoinRequest) => Promise<void>
  ): Promise<{ request: ChatPartyJoinRequest; alreadyAccepted: boolean }> {
    const record = this.joinRequests.get(joinRequestId);
    if (!record || record.leaderPlayerId !== leaderPlayerId) {
      throw new PartyListingError("PARTY_LISTING_REQUEST_GONE", "That join request is no longer available.");
    }
    return this.withPartyLock(record.partyId, async () => {
      if (record.status === "accepted") return { request: publicRequest(record), alreadyAccepted: true };
      const entry = this.listings.get(record.listingMessageId);
      if (record.status !== "pending") {
        // A request closed because the party filled up says so, rather than just "gone".
        if (record.status === "closed" && entry && this.project(entry).status === "full") {
          throw new PartyListingError("PARTY_LISTING_FULL", "This party is full.");
        }
        throw new PartyListingError("PARTY_LISTING_REQUEST_GONE", "That join request is no longer available.");
      }
      if (!entry) throw new PartyListingError("PARTY_LISTING_CLOSED", "This party card is closed.");
      this.assertOpen(entry);
      const profile = await this.deps.profile(record.requesterPlayerId);
      this.assertRequesterEligible(entry, record.requesterPlayerId, profile);
      await join(publicRequest(record));
      record.status = "accepted";
      this.tick();
      return { request: publicRequest(record), alreadyAccepted: false };
    });
  }

  /** Recomputes card states and leader request lists, and pushes whatever changed. */
  tick(): void {
    const now = this.now();
    for (const [messageId, entry] of this.listings) {
      // Keep expired cards one extra minute so viewers still receive their Closed state.
      if (now - entry.createdAtMs > CHAT_PARTY_LISTING_TTL_MS + 60_000) this.listings.delete(messageId);
    }
    const states = this.states();
    const statesKey = JSON.stringify(states);
    if (statesKey !== this.lastStatesKey) {
      this.lastStatesKey = statesKey;
      this.deps.sendToConnectionIds(new Set(this.deps.huntingConnectionIds()), {
        type: "CHAT_PARTY_LISTING_STATES",
        states
      });
    }
    const stateByMessage = new Map(states.map((state) => [state.messageId, state]));
    const leaders = new Set(this.lastRequestsKeyByLeader.keys());
    for (const [joinRequestId, record] of this.joinRequests) {
      if (record.status === "pending" && stateByMessage.get(record.listingMessageId)?.status !== "open") {
        record.status = "closed";
        this.deps.send(record.requesterPlayerId, {
          type: "CHAT_PARTY_LISTING_NOTICE",
          tone: "warning",
          text: `The ${chatPartyListingDungeonName(record.dungeonId)} party is no longer taking requests.`
        });
      }
      if (record.status !== "pending" && now - Date.parse(record.createdAt) > CHAT_PARTY_LISTING_TTL_MS * 2) {
        this.joinRequests.delete(joinRequestId);
      }
      leaders.add(record.leaderPlayerId);
    }
    for (const leaderPlayerId of leaders) {
      const requests = this.pendingRequestsFor(leaderPlayerId);
      const key = JSON.stringify(requests);
      if ((this.lastRequestsKeyByLeader.get(leaderPlayerId) ?? "[]") === key) continue;
      if (requests.length === 0) this.lastRequestsKeyByLeader.delete(leaderPlayerId);
      else this.lastRequestsKeyByLeader.set(leaderPlayerId, key);
      this.deps.send(leaderPlayerId, { type: "CHAT_PARTY_JOIN_REQUESTS", requests });
    }
  }

  private project(entry: IndexedListing): ChatPartyListingState {
    const closed = { messageId: entry.messageId, status: "closed" as const, memberCount: 0 };
    if (entry.listing.cancelled || this.now() - entry.createdAtMs >= CHAT_PARTY_LISTING_TTL_MS) return closed;
    if (entry.listing.kind === "seeker") return { messageId: entry.messageId, status: "open", memberCount: 0 };
    const party = this.deps.partyAuthority()?.partyForPlayer(entry.senderPlayerId) ?? null;
    if (!party || party.partyId !== entry.listing.partyId || party.leaderPlayerId !== entry.senderPlayerId) {
      return closed;
    }
    const memberCount = party.memberPlayerIds.length;
    return {
      messageId: entry.messageId,
      status: memberCount >= CHAT_PARTY_LISTING_TARGET_SIZE ? "full" : "open",
      memberCount
    };
  }

  private assertOpen(entry: IndexedListing): void {
    const state = this.project(entry);
    if (state.status === "full") throw new PartyListingError("PARTY_LISTING_FULL", "This party is full.");
    if (state.status === "closed") throw new PartyListingError("PARTY_LISTING_CLOSED", "This party card is closed.");
  }

  private assertRequesterEligible(entry: IndexedListing, playerId: string, profile: PartyListingProfile): void {
    const requiredLevel = chatPartyListingRequiredLevel(entry.listing.dungeonId);
    if (profile.level < requiredLevel) {
      throw new PartyListingError("PARTY_LISTING_LEVEL", `Requires level ${requiredLevel}.`);
    }
    const current = this.requireAuthority().partyForPlayer(playerId);
    if (current?.partyId === entry.listing.partyId) {
      throw new PartyListingError("PARTY_LISTING_IN_PARTY", "You are already in this party.");
    }
    // A party of one is just you; joining folds it in. A real party has to be left first.
    if (current && current.memberPlayerIds.length > 1) {
      throw new PartyListingError("PARTY_LISTING_IN_PARTY", "Leave your current party before joining another.");
    }
  }

  private requireAuthority(): MutablePartyAuthority {
    const authority = this.deps.partyAuthority();
    if (!authority) throw new PartyListingError("PARTY_LISTING_INVALID", "Parties are unavailable right now.");
    return authority;
  }

  private async withPartyLock<T>(partyId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.partyLocks.get(partyId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.then(() => undefined, () => undefined);
    this.partyLocks.set(partyId, settled);
    try {
      return await run;
    } finally {
      if (this.partyLocks.get(partyId) === settled) this.partyLocks.delete(partyId);
    }
  }
}

function publicRequest(record: JoinRequestRecord): ChatPartyJoinRequest {
  return {
    joinRequestId: record.joinRequestId,
    listingMessageId: record.listingMessageId,
    dungeonId: record.dungeonId,
    requesterPlayerId: record.requesterPlayerId,
    requesterName: record.requesterName,
    classId: record.classId,
    level: record.level,
    createdAt: record.createdAt
  };
}
