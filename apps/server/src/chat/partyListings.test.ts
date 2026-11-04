import type { ChatMessage, ChatPartyListing, ServerMessage } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import type { CombatEngine } from "../game/combat/combatEngine.js";
import { InMemoryPartyAuthority } from "../game/party/PartyAuthority.js";
import type { GameState } from "../game/state.js";
import { PartyListingService, partyListingTeleportDenial, type PartyListingProfile } from "./partyListings.js";

type Harness = ReturnType<typeof harness>;

function harness(levels: Record<string, number> = {}) {
  const authority = new InMemoryPartyAuthority();
  const sent: Array<{ playerId: string; message: ServerMessage }> = [];
  let now = Date.parse("2026-10-06T12:00:00.000Z");
  let sequence = 0;
  const listings = new PartyListingService({
    chat: {
      recentPartyListings: async () => [],
      cancelPartyListing: async () => true
    },
    partyAuthority: () => authority,
    profile: async (playerId): Promise<PartyListingProfile> => ({
      displayName: playerId,
      classId: "warrior",
      level: levels[playerId] ?? 30
    }),
    send: (playerId, message) => sent.push({ playerId, message }),
    sendToConnection: () => undefined,
    sendToConnectionIds: () => undefined,
    huntingConnectionIds: () => [],
    partyCreated: () => undefined,
    now: () => now
  });
  const post = (senderPlayerId: string, listing: ChatPartyListing): string => {
    const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    listings.recordPosted({
      id,
      senderPlayerId,
      createdAt: new Date(now).toISOString(),
      partyListing: listing
    } as ChatMessage);
    return id;
  };
  /** The same authority calls the realtime handler makes on accept. */
  const join = (leaderPlayerId: string) => async (request: { joinRequestId: string; requesterPlayerId: string }) => {
    await Promise.resolve();
    const invite = authority.inviteToParty(request.requesterPlayerId, leaderPlayerId, `invite:${request.joinRequestId}`);
    authority.acceptInvite(invite.invitationId, request.requesterPlayerId, `accept:${request.joinRequestId}`);
  };
  const leaderCard = async (leaderPlayerId: string, dungeonId: ChatPartyListing["dungeonId"] = "fangrock_cavern") => {
    const listing = await listings.prepare(leaderPlayerId, "public:hunting", { kind: "leader", dungeonId }, `post-${leaderPlayerId}`);
    return post(leaderPlayerId, listing);
  };
  return {
    authority,
    listings,
    sent,
    post,
    join,
    leaderCard,
    advance: (ms: number) => { now += ms; }
  };
}

async function fillParty(h: Harness, leaderPlayerId: string, members: string[]): Promise<void> {
  for (const member of members) {
    const invite = h.authority.inviteToParty(member, leaderPlayerId, `fill-${member}`);
    h.authority.acceptInvite(invite.invitationId, member, `fill-accept-${member}`);
  }
}

describe("Hunting join teleport", () => {
  const world = (inDungeon: Set<string>, fighting = new Set<string>(), pvp = new Set<string>()) => ({
    gameState: {
      isWorldPresent: (playerId: string) => !inDungeon.has(playerId),
      getPlayer: () => ({ online: true }),
      getAuthoritativeTravelAnchor: () => ({ kind: "world" }),
      isMovementBlocked: () => false
    } as unknown as GameState,
    combat: {
      isInCombat: (playerId: string) => fighting.has(playerId),
      isPlayerAlive: () => true,
      aggressionRemainingMs: () => 0,
      hasQueuedAbility: () => false,
      hasBattleDraught: () => false
    } as unknown as CombatEngine,
    pvpTimerActive: (playerId: string) => pvp.has(playerId),
    inManor: () => false,
    connected: () => true
  });

  it("teleports when the leader is on the overworld and nobody is fighting", () => {
    expect(partyListingTeleportDenial(world(new Set()), "leader", "joiner")).toBeNull();
  });

  it("does not teleport into a dungeon, or during combat or a PvP timer", () => {
    expect(partyListingTeleportDenial(world(new Set(["leader"])), "leader", "joiner"))
      .toBe("the leader is inside a dungeon or building");
    expect(partyListingTeleportDenial(world(new Set(), new Set(["joiner"])), "leader", "joiner"))
      .toBe("you are in combat");
    expect(partyListingTeleportDenial(world(new Set(), new Set(), new Set(["leader"])), "leader", "joiner"))
      .toBe("the leader is under a PvP timer");
  });
});

describe("Hunting party cards", () => {
  it("rejects party cards outside the Hunting channel", async () => {
    const h = harness();
    await expect(h.listings.prepare("leader", "public:general", { kind: "leader", dungeonId: "the_eyrie" }, "r1"))
      .rejects.toMatchObject({ code: "PARTY_LISTING_INVALID" });
    await expect(h.listings.prepare("seeker", "public:trading", { kind: "seeker", dungeonId: "the_eyrie" }, "r2"))
      .rejects.toMatchObject({ code: "PARTY_LISTING_INVALID" });
    expect(h.authority.partyForPlayer("leader")).toBeNull();
  });

  it("makes the poster a leader and projects the seeker's class and level", async () => {
    const h = harness({ seeker: 12 });
    const leader = await h.listings.prepare("leader", "public:hunting", { kind: "leader", dungeonId: "the_eyrie" }, "r1");
    expect(leader).toMatchObject({ kind: "leader", partyId: h.authority.partyForPlayer("leader")?.partyId });
    await fillParty(h, "leader", ["member"]);
    await expect(h.listings.prepare("member", "public:hunting", { kind: "leader", dungeonId: "the_eyrie" }, "r2"))
      .rejects.toMatchObject({ code: "PARTY_LISTING_NOT_LEADER" });
    const seeker = await h.listings.prepare("seeker", "public:hunting", { kind: "seeker", dungeonId: "the_eyrie" }, "r3");
    expect(seeker).toEqual({ kind: "seeker", dungeonId: "the_eyrie", classId: "warrior", level: 12 });
  });

  it("rejects a join below the dungeon's required level", async () => {
    const h = harness({ low: 10 });
    const card = await h.leaderCard("leader", "the_eyrie");
    await expect(h.listings.requestJoin("low", card)).rejects.toMatchObject({
      code: "PARTY_LISTING_LEVEL",
      message: "Requires level 11."
    });
  });

  it("rejects joins on a full, expired, or cancelled card", async () => {
    const h = harness();
    const full = await h.leaderCard("leader");
    await fillParty(h, "leader", ["a", "b", "c"]);
    expect(h.listings.stateOf(full)).toMatchObject({ status: "full", memberCount: 4 });
    await expect(h.listings.requestJoin("joiner", full)).rejects.toMatchObject({ code: "PARTY_LISTING_FULL" });

    const expired = await h.leaderCard("other");
    h.advance(15 * 60_000);
    expect(h.listings.stateOf(expired).status).toBe("closed");
    await expect(h.listings.requestJoin("joiner", expired)).rejects.toMatchObject({ code: "PARTY_LISTING_CLOSED" });

    const cancelled = await h.leaderCard("third");
    await h.listings.cancel("third", cancelled);
    await expect(h.listings.requestJoin("joiner", cancelled)).rejects.toMatchObject({ code: "PARTY_LISTING_CLOSED" });
  });

  it("joins a requester on accept, and repeated Join and Accept taps are no-ops", async () => {
    const h = harness();
    const card = await h.leaderCard("leader");
    const first = await h.listings.requestJoin("joiner", card);
    const second = await h.listings.requestJoin("joiner", card);
    expect(second.joinRequestId).toBe(first.joinRequestId);
    expect(h.listings.pendingRequestsFor("leader")).toHaveLength(1);
    expect(h.sent.filter(({ message }) => message.type === "CHAT_PARTY_LISTING_NOTICE" && message.text.includes("asks to join")))
      .toHaveLength(1);

    const accepted = await h.listings.accept("leader", first.joinRequestId, h.join("leader"));
    expect(accepted.alreadyAccepted).toBe(false);
    expect(h.authority.sameParty("leader", "joiner")).toBe(true);
    const again = await h.listings.accept("leader", first.joinRequestId, h.join("leader"));
    expect(again.alreadyAccepted).toBe(true);
    expect(h.authority.partyForPlayer("leader")?.memberPlayerIds).toHaveLength(2);
    await expect(h.listings.requestJoin("joiner", card)).rejects.toMatchObject({ code: "PARTY_LISTING_IN_PARTY" });
  });

  it("lets only one of two accepts take the last slot", async () => {
    const h = harness();
    const card = await h.leaderCard("leader");
    await fillParty(h, "leader", ["a", "b"]);
    const left = await h.listings.requestJoin("left", card);
    const right = await h.listings.requestJoin("right", card);
    const results = await Promise.allSettled([
      h.listings.accept("leader", left.joinRequestId, h.join("leader")),
      h.listings.accept("leader", right.joinRequestId, h.join("leader"))
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "PARTY_LISTING_FULL" }
    });
    expect(h.authority.partyForPlayer("leader")?.memberPlayerIds).toHaveLength(4);
    expect(h.listings.stateOf(card).status).toBe("full");
  });

  it("closes the card and its requests when the leader leaves, and refuses requesters in another party", async () => {
    const h = harness();
    const card = await h.leaderCard("leader");
    await fillParty(h, "leader", ["a"]);
    const request = await h.listings.requestJoin("joiner", card);
    h.authority.leaveParty("leader", "leave-1");
    h.listings.tick();
    expect(h.listings.stateOf(card).status).toBe("closed");
    expect(h.listings.pendingRequestsFor("leader")).toEqual([]);
    await expect(h.listings.accept("leader", request.joinRequestId, h.join("leader")))
      .rejects.toMatchObject({ code: "PARTY_LISTING_REQUEST_GONE" });

    const open = await h.leaderCard("host");
    await fillParty(h, "busy", ["busy-friend"]);
    await expect(h.listings.requestJoin("busy", open)).rejects.toMatchObject({ code: "PARTY_LISTING_IN_PARTY" });
  });
});
