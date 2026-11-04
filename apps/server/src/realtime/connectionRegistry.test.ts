import { describe, expect, it, vi } from "vitest";

import { ConnectionRegistry, type SocketLike } from "./connectionRegistry.js";
import type { PresenceActivitySink } from "./presenceService.js";

const MARKET_VENUE_ID = "00000000-0000-4000-8000-000000000600";
const MARKET_SESSION_ID = "00000000-0000-4000-8000-000000000601";

describe("ConnectionRegistry account leases", () => {
  it("reports gameplay connections separately from later socket activity", () => {
    const registry = new ConnectionRegistry();
    const presence: PresenceActivitySink = {
      recordAuthoritativeLogin: vi.fn(),
      recordAuthoritativeActivity: vi.fn()
    };
    registry.attachPresenceActivity(presence);

    const registered = registry.addWithReplacement(connection("account-1", socket()));
    expect(presence.recordAuthoritativeLogin).toHaveBeenCalledWith(
      "player-account-1",
      "account-1",
      "Scout"
    );
    expect(presence.recordAuthoritativeActivity).not.toHaveBeenCalled();

    registry.touch(registered.connectionId);
    expect(presence.recordAuthoritativeLogin).toHaveBeenCalledOnce();
    expect(presence.recordAuthoritativeActivity).toHaveBeenCalledWith(
      "player-account-1",
      "account-1"
    );
  });

  it("does not mark keepalive or telemetry messages as economy gameplay", () => {
    const registry = new ConnectionRegistry();
    const economyActivity = {
      recordConnectionOpened: vi.fn(),
      recordConnectionHeartbeat: vi.fn(),
      recordGameplayActivity: vi.fn(),
      recordConnectionClosed: vi.fn()
    };
    registry.attachEconomyActivity(economyActivity);
    const registered = registry.addWithReplacement(connection("account-1", socket()));
    economyActivity.recordGameplayActivity.mockClear();

    registry.touch(registered.connectionId, { ping: true, messageType: "PING" });
    registry.touch(registered.connectionId, { messageType: "TELEMETRY_BATCH" });
    registry.touch(registered.connectionId, { messageType: "MOVE" });

    expect(economyActivity.recordGameplayActivity).toHaveBeenCalledOnce();
    expect(economyActivity.recordGameplayActivity).toHaveBeenCalledWith(
      "player-account-1",
      expect.any(Date)
    );
    expect(economyActivity.recordConnectionHeartbeat).toHaveBeenCalledTimes(2);
  });

  it("retains bounded social presence after the transport is removed", () => {
    const registry = new ConnectionRegistry();
    registry.setLinkDeadWorldPresence("player-1", true);
    expect(registry.hasPlayerPresence("player-1")).toBe(true);
    registry.setLinkDeadWorldPresence("player-1", false);
    expect(registry.hasPlayerPresence("player-1")).toBe(false);
  });

  it("lets the newest gameplay connection replace the previous one", () => {
    const registry = new ConnectionRegistry();
    const firstSocket = socket();
    const first = registry.addWithReplacement(connection("account-1", firstSocket));
    const secondSocket = socket();
    const second = registry.addWithReplacement(connection("account-1", secondSocket));

    expect(second.replacedConnectionId).toBe(first.connectionId);
    expect(firstSocket.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"SESSION_REPLACED"')
    );
    expect(firstSocket.close).toHaveBeenCalledWith(4002, "newer gameplay connection opened");
    expect(registry.activeConnectionIdForAccount("account-1")).toBe(second.connectionId);
    expect(registry.connectionCountForPlayer("player-account-1")).toBe(1);
  });

  it("rejects a closed socket before it can replace the active connection", () => {
    const registry = new ConnectionRegistry();
    const active = registry.addWithReplacement(connection("account-1", socket()));
    const closedSocket = socket();
    closedSocket.readyState = 3;

    expect(() => registry.addWithReplacement(connection("account-1", closedSocket)))
      .toThrow("cannot register a websocket that is not open");
    expect(registry.activeConnectionIdForAccount("account-1")).toBe(active.connectionId);
  });

  it("does not let stale disconnect cleanup remove the newer connection", () => {
    const registry = new ConnectionRegistry();
    const first = registry.addWithReplacement(connection("account-1", socket()));
    const second = registry.addWithReplacement(connection("account-1", socket()));

    registry.remove(first.connectionId);

    expect(registry.activeConnectionIdForAccount("account-1")).toBe(second.connectionId);
    expect(registry.isActiveConnection("account-1", first.connectionId)).toBe(false);
    expect(registry.isActiveConnection("account-1", second.connectionId)).toBe(true);
  });

  it("routes player delivery through the newest replacement socket", () => {
    const registry = new ConnectionRegistry();
    const staleSocket = socket();
    registry.addWithReplacement(connection("account-1", staleSocket));
    const activeSocket = socket();
    registry.addWithReplacement(connection("account-1", activeSocket));
    vi.mocked(staleSocket.send).mockClear();

    registry.send("player-account-1", {
      type: "DUNGEON_ERROR",
      requestId: "request-1",
      code: "USE_PORTAL_REQUIRED",
      message: "Use a portal."
    });

    expect(staleSocket.send).not.toHaveBeenCalled();
    expect(activeSocket.send).toHaveBeenCalledWith(expect.stringContaining(
      '"type":"DUNGEON_ERROR"'
    ));
  });

  it("keeps only the newest lease through back-to-back connection races", () => {
    const registry = new ConnectionRegistry();
    const first = registry.addWithReplacement(connection("account-1", socket()));
    const second = registry.addWithReplacement(connection("account-1", socket()));
    const third = registry.addWithReplacement(connection("account-1", socket()));

    expect(second.replacedConnectionId).toBe(first.connectionId);
    expect(third.replacedConnectionId).toBe(second.connectionId);
    expect(registry.isActiveConnection("account-1", first.connectionId)).toBe(false);
    expect(registry.isActiveConnection("account-1", second.connectionId)).toBe(false);
    expect(registry.isActiveConnection("account-1", third.connectionId)).toBe(true);
  });

  it("allows different accounts to remain connected", () => {
    const registry = new ConnectionRegistry();
    const first = registry.addWithReplacement(connection("account-1", socket()));
    const second = registry.addWithReplacement(connection("account-2", socket()));
    expect(first.replacedConnectionId).toBeNull();
    expect(second.replacedConnectionId).toBeNull();
    expect(registry.activePlayerIds()).toEqual([
      "player-account-1",
      "player-account-2"
    ]);
  });

  it("uses player, region, and zone indexes for targeted sends", () => {
    const registry = new ConnectionRegistry();
    const firstSocket = socket();
    const secondSocket = socket();
    const first = registry.addWithReplacement(connection("account-1", firstSocket));
    registry.addWithReplacement(connection("account-2", secondSocket));

    registry.send("player-account-1", { type: "PONG", clientTime: 1, serverTime: 2 });
    expect(firstSocket.send).toHaveBeenCalledOnce();
    expect(secondSocket.send).not.toHaveBeenCalled();
    expect(registry.isActivePlayerConnection("player-account-1", first.connectionId)).toBe(true);
    expect(registry.records()).toHaveLength(2);
  });

  it("contains a socket send failure and removes the unusable connection", () => {
    const registry = new ConnectionRegistry();
    const failedSocket = socket();
    vi.mocked(failedSocket.send).mockImplementation(() => {
      throw new Error("socket already closed");
    });
    const active = registry.addWithReplacement(connection("account-failed", failedSocket));

    expect(() => registry.send(
      "player-account-failed",
      { type: "PONG", clientTime: 1, serverTime: 2 }
    )).not.toThrow();
    expect(registry.isActiveConnection("account-failed", active.connectionId)).toBe(false);
  });

  it("closes every active gameplay connection for logout-all", () => {
    const registry = new ConnectionRegistry();
    const accountSocket = socket();
    const otherSocket = socket();
    registry.addWithReplacement(connection("account-1", accountSocket));
    registry.addWithReplacement(connection("account-2", otherSocket));

    registry.closeAccountConnections("account-1", 4001, "all sessions revoked");

    expect(accountSocket.close).toHaveBeenCalledWith(4001, "all sessions revoked");
    expect(otherSocket.close).not.toHaveBeenCalled();
    expect(registry.activeConnectionIdForAccount("account-1")).toBeNull();
    expect(() => registry.assertIndexConsistency()).not.toThrow();
  });

  it("keeps every secondary index consistent through replacement and removal", () => {
    const registry = new ConnectionRegistry();
    const first = registry.addWithReplacement(connection("account-1", socket()));
    const replacement = registry.addWithReplacement(connection("account-1", socket()));
    registry.addWithReplacement(connection("account-2", socket()));

    registry.remove(first.connectionId);
    expect(registry.activeConnectionIdForPlayer("player-account-1")).toBe(
      replacement.connectionId
    );
    expect(registry.connectionIdsForZone("world:NM")).toHaveLength(2);
    expect(() => registry.assertIndexConsistency()).not.toThrow();
  });

  it("skips replaceable state for a slow client without blocking healthy clients", () => {
    const registry = new ConnectionRegistry(100, 1_000, 2);
    const slowSocket = socket(150);
    const healthySocket = socket(0);
    registry.addWithReplacement(connection("account-1", slowSocket));
    registry.addWithReplacement(connection("account-2", healthySocket));

    expect(
      registry.send("player-account-1", { type: "PONG", clientTime: 1, serverTime: 2 }, "replaceable")
    ).toBe("backpressure-skipped");
    expect(
      registry.send("player-account-2", { type: "PONG", clientTime: 1, serverTime: 2 }, "replaceable")
    ).toBe("sent");
    expect(slowSocket.send).not.toHaveBeenCalled();
    expect(healthySocket.send).toHaveBeenCalledOnce();

    expect(
      registry.send("player-account-1", { type: "PONG", clientTime: 2, serverTime: 3 }, "replaceable")
    ).toBe("closed");
    expect(slowSocket.close).toHaveBeenCalledWith(4008, "websocket remained backpressured");
    expect(registry.metricsSnapshot()).toMatchObject({
      replaceableSkipped: 2,
      replaceableCoalesced: 2,
      backpressureClosures: 1
    });
  });

  it("paces snapshot work until a capable connection drains", async () => {
    const registry = new ConnectionRegistry(1_000, 4_000, 2);
    const slowSocket = socket(600);
    const active = registry.addWithReplacement({
      ...connection("account-1", slowSocket),
      protocolCapabilities: ["scoped-flag-snapshots"]
    });
    expect(registry.connectionSupports(
      active.connectionId,
      "scoped-flag-snapshots"
    )).toBe(true);
    setTimeout(() => {
      slowSocket.bufferedAmount = 0;
    }, 10);

    await expect(registry.waitForConnectionDrain(
      active.connectionId,
      250
    )).resolves.toBe(true);
    expect(slowSocket.close).not.toHaveBeenCalled();
  });

  it("records actionable context when backpressure closes a connection", () => {
    const warn = vi.fn();
    const registry = new ConnectionRegistry(100, 1_000, 2, { warn });
    const slowSocket = socket(1_000);
    const active = registry.addWithReplacement({
      ...connection("account-1", slowSocket),
      authSessionId: "session-1"
    });

    expect(registry.sendToConnection(
      active.connectionId,
      { type: "PONG", clientTime: 1, serverTime: 2 },
      "critical"
    )).toBe("closed");

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: active.connectionId,
        accountId: "account-1",
        authSessionId: "session-1",
        playerId: "player-account-1",
        messageType: "PONG",
        deliveryMode: "critical",
        bufferedAmount: 1_000,
        hardBufferedBytes: 1_000,
        closeCode: 4008,
        closeReason: "websocket backpressure limit exceeded"
      }),
      "closing websocket for backpressure"
    );
  });

  it("yields recoverable social traffic before gameplay reaches the soft limit", () => {
    const registry = new ConnectionRegistry(512 * 1024, 4 * 1024 * 1024);
    const socialSocket = socket(128 * 1024);
    const active = registry.addWithReplacement(connection("account-social", socialSocket));

    expect(registry.sendToConnection(
      active.connectionId,
      { type: "PONG", clientTime: 1, serverTime: 2 },
      "recoverable-social"
    )).toBe("backpressure-skipped");
    expect(registry.sendToConnection(
      active.connectionId,
      { type: "PONG", clientTime: 2, serverTime: 3 },
      "critical"
    )).toBe("sent");
    expect(registry.metricsSnapshot().recoverableSocialSkipped).toBe(1);
  });

  it("drops transient social traffic before it can delay gameplay", () => {
    const registry = new ConnectionRegistry(512 * 1024, 4 * 1024 * 1024);
    const socialSocket = socket(128 * 1024);
    const active = registry.addWithReplacement(connection("account-local-chat", socialSocket));

    expect(registry.sendToConnection(
      active.connectionId,
      { type: "PONG", clientTime: 1, serverTime: 2 },
      "transient-social"
    )).toBe("backpressure-skipped");
    expect(registry.sendToConnection(
      active.connectionId,
      { type: "PONG", clientTime: 2, serverTime: 3 },
      "critical"
    )).toBe("sent");
    expect(registry.metricsSnapshot()).toMatchObject({
      transientSocialSkipped: 1,
      recoverableSocialSkipped: 0
    });
  });

  it("atomically replaces bounded market subscriptions and ignores stale revisions", () => {
    const registry = new ConnectionRegistry();
    const active = registry.addWithReplacement(connection("account-1", socket()));

    expect(registry.setMarketSubscriptions(active.connectionId, {
      venueId: MARKET_VENUE_ID,
      marketSessionId: MARKET_SESSION_ID,
      visibleItemIds: ["wood", "ore", "wood"],
      focusedItemId: "ore",
      privateState: true,
      revision: 2
    })).toEqual({ applied: true, revision: 2 });
    expect(registry.connectionIdsForMarketSummary(MARKET_VENUE_ID, "wood")).toEqual([active.connectionId]);
    expect(registry.connectionIdsForMarketSummary(MARKET_VENUE_ID, "ore")).toEqual([active.connectionId]);
    expect(registry.connectionIdsForMarketBook(MARKET_VENUE_ID, "ore")).toEqual([active.connectionId]);
    expect(registry.connectionIdsForMarketPrivatePlayer(MARKET_VENUE_ID, "player-account-1"))
      .toEqual([active.connectionId]);

    expect(registry.setMarketSubscriptions(active.connectionId, {
      venueId: MARKET_VENUE_ID,
      marketSessionId: MARKET_SESSION_ID,
      visibleItemIds: ["stone"],
      focusedItemId: "stone",
      privateState: false,
      revision: 1
    })).toEqual({ applied: false, revision: 2 });
    expect(registry.connectionIdsForMarketSummary(MARKET_VENUE_ID, "stone")).toEqual([]);

    expect(registry.setMarketSubscriptions(active.connectionId, {
      venueId: MARKET_VENUE_ID,
      marketSessionId: MARKET_SESSION_ID,
      visibleItemIds: ["stone"],
      focusedItemId: null,
      privateState: false,
      revision: 3
    })).toEqual({ applied: true, revision: 3 });
    expect(registry.connectionIdsForMarketSummary(MARKET_VENUE_ID, "wood")).toEqual([]);
    expect(registry.connectionIdsForMarketBook(MARKET_VENUE_ID, "ore")).toEqual([]);
    expect(registry.connectionIdsForMarketPrivatePlayer(MARKET_VENUE_ID, "player-account-1")).toEqual([]);
    expect(registry.connectionIdsForMarketSummary(MARKET_VENUE_ID, "stone")).toEqual([active.connectionId]);
    expect(() => registry.assertIndexConsistency()).not.toThrow();
  });

  it("cleans market subscriptions through removal, replacement, backpressure, and shutdown", () => {
    const registry = new ConnectionRegistry(10, 20, 1);
    const first = registry.addWithReplacement(connection("account-1", socket()));
    registry.setMarketSubscriptions(first.connectionId, {
      venueId: MARKET_VENUE_ID,
      marketSessionId: MARKET_SESSION_ID,
      visibleItemIds: ["ore"],
      focusedItemId: "ore",
      privateState: true,
      revision: 1
    });
    const replacementSocket = socket(25);
    const replacement = registry.addWithReplacement(connection("account-1", replacementSocket));
    expect(registry.marketSubscriptionForConnection(first.connectionId)).toBeNull();
    expect(registry.connectionIdsForMarketSummary(MARKET_VENUE_ID, "ore")).toEqual([]);

    registry.setMarketSubscriptions(replacement.connectionId, {
      venueId: MARKET_VENUE_ID,
      marketSessionId: MARKET_SESSION_ID,
      visibleItemIds: ["stone"],
      focusedItemId: "stone",
      privateState: true,
      revision: 1
    });
    registry.sendToConnection(
      replacement.connectionId,
      { type: "PONG", clientTime: 1, serverTime: 2 },
      "replaceable"
    );
    expect(registry.marketSubscriptionForConnection(replacement.connectionId)).toBeNull();
    expect(registry.connectionIdsForMarketSummary(MARKET_VENUE_ID, "stone")).toEqual([]);

    const other = registry.addWithReplacement(connection("account-2", socket()));
    registry.setMarketSubscriptions(other.connectionId, {
      venueId: MARKET_VENUE_ID,
      marketSessionId: MARKET_SESSION_ID,
      visibleItemIds: ["wood"],
      focusedItemId: null,
      privateState: true,
      revision: 1
    });
    registry.closeAll();
    expect(registry.marketSubscriptionForConnection(other.connectionId)).toBeNull();
    expect(registry.connectionIdsForMarketSummary(MARKET_VENUE_ID, "wood")).toEqual([]);
    expect(registry.connectionIdsForMarketPrivatePlayer(MARKET_VENUE_ID, "player-account-2")).toEqual([]);
    expect(() => registry.assertIndexConsistency()).not.toThrow();
  });

  it("closes every connection with an explicit service-restart signal", () => {
    const registry = new ConnectionRegistry();
    const firstSocket = socket();
    const secondSocket = socket();
    registry.add(connection("account-1", firstSocket));
    registry.add(connection("account-2", secondSocket));

    registry.closeAll(1012, "service restart");

    expect(firstSocket.close).toHaveBeenCalledWith(1012, "service restart");
    expect(secondSocket.close).toHaveBeenCalledWith(1012, "service restart");
    expect(registry.activeConnectionCount()).toBe(0);
  });
});

function connection(accountId: string, value: SocketLike) {
  return {
    accountId,
    playerId: `player-${accountId}`,
    username: "Scout",
    regionCode: "NM",
    zoneId: "world:NM",
    socket: value
  };
}

function socket(bufferedAmount = 0): SocketLike {
  return {
    readyState: 1,
    bufferedAmount,
    send: vi.fn(),
    close: vi.fn()
  };
}
