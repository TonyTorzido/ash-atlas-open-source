import type {
  AshAtlasProtocolCapability,
  CombatEntitySnapshot,
  ServerMessage
} from "@ash-atlas/shared";

import type { AppLogger } from "../logger.js";
import type { OutboundSendMode } from "./deliveryPolicy.js";
import {
  RealtimePublisher,
  type PublisherDeliveryResult,
  type RealtimePublisherMetrics
} from "./realtimePublisher.js";
import type { PresenceActivitySink } from "./presenceService.js";
import {
  isEconomyGameplayActivityMessage,
  type EconomyGameplayActivitySink
} from "../game/economyObservatory.js";

export type SocketLike = {
  readyState: number;
  bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type ConnectionRecord = {
  connectionId: string;
  accountId: string | null;
  authSessionId: string | null;
  playerId: string;
  username: string;
  regionCode: string;
  zoneId: string;
  interestZoneIds: string[];
  protocolCapabilities: readonly AshAtlasProtocolCapability[];
  greenhouseCropCatalogVersion?: number;
  greenhouseCropPackId?: string | null;
  socket: SocketLike;
  connectedAt: Date;
  lastMessageAt: Date;
  lastPingAt: Date | null;
  consecutiveBackpressureSkips: number;
};

export type SendMode = OutboundSendMode;

export type ConnectionRegistryMetrics = {
  messagesSent: number;
  messagesReceived: number;
  bytesReceived: number;
  messagesReceivedByFamily: Record<string, number>;
  replaceableSkipped: number;
  replaceableCoalesced: number;
  recoverableSocialSkipped: number;
  transientSocialSkipped: number;
  backpressureClosures: number;
};

export type SendResult = "sent" | "missing" | "not-open" | "backpressure-skipped" | "closed";

export type MarketSubscriptionState = {
  venueId: string;
  marketSessionId: string;
  visibleItemIds: readonly string[];
  focusedItemId: string | null;
  privateState: boolean;
  revision: number;
};

export type MarketSubscriptionUpdateResult = {
  applied: boolean;
  revision: number;
};

const OPEN = 1;

export class ConnectionRegistry {
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly activeConnectionByAccount = new Map<string, string>();
  private readonly activeConnectionByPlayer = new Map<string, string>();
  private readonly connectionIdsByAccount = new Map<string, Set<string>>();
  private readonly connectionIdsByPlayer = new Map<string, Set<string>>();
  private readonly connectionIdsByRegion = new Map<string, Set<string>>();
  private readonly connectionIdsByZone = new Map<string, Set<string>>();
  private readonly marketSubscriptions = new Map<string, MarketSubscriptionState>();
  private readonly connectionIdsByMarketSummaryItem = new Map<string, Set<string>>();
  private readonly connectionIdsByMarketBookItem = new Map<string, Set<string>>();
  private readonly connectionIdsByMarketPrivatePlayer = new Map<string, Set<string>>();
  private readonly linkDeadWorldPresencePlayerIds = new Set<string>();
  private readonly publisher = new RealtimePublisher();
  private presenceActivity: PresenceActivitySink | null = null;
  private economyActivity: EconomyGameplayActivitySink | null = null;
  private combatPresentationObserver: ((
    playerId: string,
    entities: readonly CombatEntitySnapshot[]
  ) => void) | null = null;
  private readonly metrics: ConnectionRegistryMetrics = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesReceived: 0,
    messagesReceivedByFamily: {},
    replaceableSkipped: 0,
    replaceableCoalesced: 0,
    recoverableSocialSkipped: 0,
    transientSocialSkipped: 0,
    backpressureClosures: 0
  };

  constructor(
    private readonly softBufferedBytes = 512 * 1024,
    private readonly hardBufferedBytes = 4 * 1024 * 1024,
    private readonly maximumBackpressureSkips = 20,
    private readonly logger?: Pick<AppLogger, "warn">
  ) {}

  setCombatPresentationObserver(
    observer: (playerId: string, entities: readonly CombatEntitySnapshot[]) => void
  ): void {
    this.combatPresentationObserver = observer;
  }

  attachPresenceActivity(sink: PresenceActivitySink): void {
    this.presenceActivity = sink;
  }

  attachEconomyActivity(sink: EconomyGameplayActivitySink): void {
    this.economyActivity = sink;
  }

  add(input: {
    accountId?: string | null;
    authSessionId?: string | null;
    playerId: string;
    username: string;
    regionCode: string;
    zoneId: string;
    interestZoneIds?: string[];
    protocolCapabilities?: readonly AshAtlasProtocolCapability[];
    socket: SocketLike;
  }): string {
    return this.addWithReplacement(input).connectionId;
  }

  addWithReplacement(input: {
    accountId?: string | null;
    authSessionId?: string | null;
    playerId: string;
    username: string;
    regionCode: string;
    zoneId: string;
    interestZoneIds?: string[];
    protocolCapabilities?: readonly AshAtlasProtocolCapability[];
    socket: SocketLike;
  }): { connectionId: string; replacedConnectionId: string | null } {
    if (input.socket.readyState !== OPEN) {
      throw new Error("cannot register a websocket that is not open");
    }
    const connectionId = crypto.randomUUID();
    const now = new Date();
    const accountId = input.accountId ?? null;
    const replacedConnectionId = accountId
      ? this.activeConnectionByAccount.get(accountId) ?? null
      : null;
    const interestZoneIds = [...new Set([input.zoneId, ...(input.interestZoneIds ?? [])])].sort();
    const record: ConnectionRecord = {
      connectionId,
      accountId,
      authSessionId: input.authSessionId ?? null,
      playerId: input.playerId,
      username: input.username,
      regionCode: input.regionCode,
      zoneId: input.zoneId,
      interestZoneIds,
      protocolCapabilities: [...(input.protocolCapabilities ?? [])],
      socket: input.socket,
      connectedAt: now,
      lastMessageAt: now,
      lastPingAt: null,
      consecutiveBackpressureSkips: 0
    };
    this.connections.set(connectionId, record);
    if (accountId) {
      addToIndex(this.connectionIdsByAccount, accountId, connectionId);
    }
    addToIndex(this.connectionIdsByPlayer, record.playerId, connectionId);
    addToIndex(this.connectionIdsByRegion, record.regionCode, connectionId);
    for (const zoneId of record.interestZoneIds) {
      addToIndex(this.connectionIdsByZone, zoneId, connectionId);
    }
    if (accountId) {
      this.activeConnectionByAccount.set(accountId, connectionId);
    }
    this.activeConnectionByPlayer.set(record.playerId, connectionId);
    this.presenceActivity?.recordAuthoritativeLogin(
      record.playerId,
      record.accountId,
      record.username
    );
    this.economyActivity?.recordConnectionOpened({
      connectionId: record.connectionId,
      accountId: record.accountId,
      authSessionId: record.authSessionId,
      playerId: record.playerId,
      connectedAt: record.connectedAt
    });
    if (replacedConnectionId) {
      const replaced = this.connections.get(replacedConnectionId);
      if (replaced && replaced.socket.readyState === OPEN) {
        this.sendToConnection(
          replacedConnectionId,
          {
            type: "SESSION_REPLACED",
            message: "This account connected from another gameplay tab or device."
          },
          "critical"
        );
        replaced.socket.close(4002, "newer gameplay connection opened");
      }
      this.deleteConnection(replacedConnectionId);
    }
    return { connectionId, replacedConnectionId };
  }

  remove(connectionId: string): ConnectionRecord | null {
    return this.deleteConnection(connectionId);
  }

  touch(connectionId: string, options: { ping?: boolean; messageType?: string } = {}): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }
    const now = new Date();
    connection.lastMessageAt = now;
    this.presenceActivity?.recordAuthoritativeActivity(connection.playerId, connection.accountId);
    const gameplayActivity = !options.ping &&
      (options.messageType === undefined || isEconomyGameplayActivityMessage(options.messageType));
    if (gameplayActivity) {
      this.economyActivity?.recordGameplayActivity(connection.playerId, now);
    } else {
      this.economyActivity?.recordConnectionHeartbeat(connection.playerId, now);
    }
    if (options.ping) {
      connection.lastPingAt = now;
    }
  }

  noteInboundMessage(byteLength: number, family: string): void {
    this.metrics.messagesReceived += 1;
    this.metrics.bytesReceived += Math.max(0, byteLength);
    this.metrics.messagesReceivedByFamily[family] =
      (this.metrics.messagesReceivedByFamily[family] ?? 0) + 1;
  }

  connectionCountForPlayer(playerId: string): number {
    return this.connectionIdsByPlayer.get(playerId)?.size ?? 0;
  }

  setLinkDeadWorldPresence(playerId: string, present: boolean): void {
    if (present) this.linkDeadWorldPresencePlayerIds.add(playerId);
    else this.linkDeadWorldPresencePlayerIds.delete(playerId);
  }

  hasPlayerPresence(playerId: string): boolean {
    return this.connectionCountForPlayer(playerId) > 0 ||
      this.linkDeadWorldPresencePlayerIds.has(playerId);
  }

  setMarketSubscriptions(
    connectionId: string,
    input: MarketSubscriptionState
  ): MarketSubscriptionUpdateResult | null {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return null;
    }
    const current = this.marketSubscriptions.get(connectionId);
    if (current && input.revision <= current.revision) {
      return { applied: false, revision: current.revision };
    }
    const visibleItemIds = [...new Set(input.visibleItemIds)].sort();
    if (visibleItemIds.length > 40) {
      throw new Error("Market visible-item subscription exceeds its bound");
    }
    this.clearMarketSubscriptions(connectionId);
    const subscription: MarketSubscriptionState = {
      venueId: input.venueId,
      marketSessionId: input.marketSessionId,
      visibleItemIds,
      focusedItemId: input.focusedItemId,
      privateState: input.privateState,
      revision: input.revision
    };
    this.marketSubscriptions.set(connectionId, subscription);
    for (const itemId of visibleItemIds) {
      addToIndex(
        this.connectionIdsByMarketSummaryItem,
        marketItemKey(subscription.venueId, itemId),
        connectionId
      );
    }
    if (subscription.focusedItemId) {
      addToIndex(
        this.connectionIdsByMarketBookItem,
        marketItemKey(subscription.venueId, subscription.focusedItemId),
        connectionId
      );
    }
    if (subscription.privateState) {
      addToIndex(
        this.connectionIdsByMarketPrivatePlayer,
        marketPlayerKey(subscription.venueId, connection.playerId),
        connectionId
      );
    }
    return { applied: true, revision: subscription.revision };
  }

  marketSubscriptionForConnection(connectionId: string): MarketSubscriptionState | null {
    const value = this.marketSubscriptions.get(connectionId);
    return value ? { ...value, visibleItemIds: [...value.visibleItemIds] } : null;
  }

  connectionIdsForMarketSummary(venueId: string, itemId: string): string[] {
    return [
      ...(this.connectionIdsByMarketSummaryItem.get(
        marketItemKey(venueId, itemId)
      ) ?? [])
    ].sort();
  }

  connectionIdsForMarketBook(venueId: string, itemId: string): string[] {
    return [
      ...(this.connectionIdsByMarketBookItem.get(
        marketItemKey(venueId, itemId)
      ) ?? [])
    ].sort();
  }

  connectionIdsForMarketPrivatePlayer(
    venueId: string,
    playerId: string
  ): string[] {
    return [
      ...(this.connectionIdsByMarketPrivatePlayer.get(
        marketPlayerKey(venueId, playerId)
      ) ?? [])
    ].sort();
  }

  send(playerId: string, message: ServerMessage, mode: SendMode = "critical"): SendResult {
    const connectionId = this.activeConnectionByPlayer.get(playerId);
    if (!connectionId) return "missing";
    return this.publish([connectionId], message, mode).get(connectionId) ?? "missing";
  }

  sendToConnection(
    connectionId: string,
    message: ServerMessage,
    mode: SendMode = "critical"
  ): SendResult {
    return this.publish([connectionId], message, mode).get(connectionId) ?? "missing";
  }

  sendToConnectionIds(
    connectionIds: Iterable<string>,
    message: ServerMessage,
    mode: SendMode = "critical"
  ): Map<string, SendResult> {
    return this.publish(connectionIds, message, mode, true);
  }

  broadcast(message: ServerMessage): void {
    this.publish(this.connections.keys(), message, "critical", true);
  }

  broadcastToRegion(regionCode: string, message: ServerMessage): void {
    this.publish(this.connectionIdsByRegion.get(regionCode) ?? [], message, "critical", true);
  }

  broadcastToZone(zoneId: string, message: ServerMessage): void {
    this.publish(this.connectionIdsByZone.get(zoneId) ?? [], message, "critical", true);
  }

  closeAll(code = 1001, reason = "server shutting down"): void {
    for (const connection of [...this.connections.values()]) {
      connection.socket.close(code, reason);
      this.deleteConnection(connection.connectionId);
    }
  }

  closeAccountConnections(accountId: string, code: number, reason: string): void {
    for (const connectionId of [...(this.connectionIdsByAccount.get(accountId) ?? [])]) {
      const connection = this.connections.get(connectionId);
      connection?.socket.close(code, reason);
      this.deleteConnection(connectionId);
    }
  }

  activeConnectionIdForAccount(accountId: string): string | null {
    return this.activeConnectionByAccount.get(accountId) ?? null;
  }

  isActiveConnection(accountId: string, connectionId: string): boolean {
    return this.activeConnectionByAccount.get(accountId) === connectionId;
  }

  isActivePlayerConnection(playerId: string, connectionId: string): boolean {
    return this.activeConnectionByPlayer.get(playerId) === connectionId;
  }

  activePlayerIds(): string[] {
    return [...this.connectionIdsByPlayer.keys()].sort();
  }

  activeConnectionCount(): number {
    return this.connections.size;
  }

  linkDeadPlayerCount(): number {
    return this.linkDeadWorldPresencePlayerIds.size;
  }

  records(): ConnectionRecord[] {
    return [...this.connections.values()];
  }

  recordForConnection(connectionId: string): ConnectionRecord | null {
    return this.connections.get(connectionId) ?? null;
  }

  connectionSupports(
    connectionId: string,
    capability: AshAtlasProtocolCapability
  ): boolean {
    return this.connections.get(connectionId)?.protocolCapabilities.includes(
      capability
    ) ?? false;
  }

  setGreenhouseCropCapability(
    connectionId: string,
    version: number | undefined,
    packId: string | null | undefined
  ): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    if (version === 1 && typeof packId === "string" && /^[a-f0-9]{64}$/u.test(packId)) {
      connection.greenhouseCropCatalogVersion = version;
      connection.greenhouseCropPackId = packId;
    } else {
      delete connection.greenhouseCropCatalogVersion;
      delete connection.greenhouseCropPackId;
    }
  }

  async waitForConnectionDrain(
    connectionId: string,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const connection = this.connections.get(connectionId);
      if (!connection || connection.socket.readyState !== OPEN) return false;
      if (
        (connection.socket.bufferedAmount ?? 0) <
          Math.max(1, Math.floor(this.softBufferedBytes / 2))
      ) return true;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(50, remainingMs));
      });
    }
  }

  activeConnectionIdForPlayer(playerId: string): string | null {
    return this.activeConnectionByPlayer.get(playerId) ?? null;
  }

  connectionIdsForZone(zoneId: string): string[] {
    return [...(this.connectionIdsByZone.get(zoneId) ?? [])].sort();
  }

  updateSpatialMembership(input: {
    playerId: string;
    regionCode: string;
    zoneId: string;
    interestZoneIds: string[];
  }): void {
    for (const connectionId of this.connectionIdsByPlayer.get(input.playerId) ?? []) {
      const connection = this.connections.get(connectionId);
      if (!connection) continue;
      if (connection.regionCode !== input.regionCode) {
        removeFromIndex(this.connectionIdsByRegion, connection.regionCode, connectionId);
        connection.regionCode = input.regionCode;
        addToIndex(this.connectionIdsByRegion, connection.regionCode, connectionId);
      }
      const nextZones = [...new Set([input.zoneId, ...input.interestZoneIds])].sort();
      if (connection.zoneId === input.zoneId && arraysEqual(connection.interestZoneIds, nextZones)) {
        continue;
      }
      for (const zoneId of connection.interestZoneIds) {
        removeFromIndex(this.connectionIdsByZone, zoneId, connectionId);
      }
      connection.zoneId = input.zoneId;
      connection.interestZoneIds = nextZones;
      for (const zoneId of nextZones) addToIndex(this.connectionIdsByZone, zoneId, connectionId);
    }
  }

  metricsSnapshot(): ConnectionRegistryMetrics {
    return {
      ...this.metrics,
      messagesReceivedByFamily: { ...this.metrics.messagesReceivedByFamily }
    };
  }

  realtimePublisherMetricsSnapshot(): RealtimePublisherMetrics {
    const currentBufferedAmount = [...this.connections.values()].reduce(
      (maximum, connection) => Math.max(maximum, connection.socket.bufferedAmount ?? 0),
      0
    );
    return this.publisher.metricsSnapshot(currentBufferedAmount);
  }

  assertIndexConsistency(): void {
    for (const [connectionId, connection] of this.connections) {
      if (
        !this.connectionIdsByPlayer.get(connection.playerId)?.has(connectionId) ||
        !this.connectionIdsByRegion.get(connection.regionCode)?.has(connectionId) ||
        connection.interestZoneIds.some(
          (zoneId) => !this.connectionIdsByZone.get(zoneId)?.has(connectionId)
        ) ||
        (connection.accountId !== null &&
          !this.connectionIdsByAccount.get(connection.accountId)?.has(connectionId))
      ) {
        throw new Error(`connection index is inconsistent for ${connectionId}`);
      }
    }
    for (const index of [
      this.connectionIdsByAccount,
      this.connectionIdsByPlayer,
      this.connectionIdsByRegion,
      this.connectionIdsByZone,
      this.connectionIdsByMarketSummaryItem,
      this.connectionIdsByMarketBookItem,
      this.connectionIdsByMarketPrivatePlayer
    ]) {
      for (const connectionIds of index.values()) {
        for (const connectionId of connectionIds) {
          if (!this.connections.has(connectionId)) {
            throw new Error(`connection index retained stale id ${connectionId}`);
          }
        }
      }
    }
    for (const [connectionId, subscription] of this.marketSubscriptions) {
      const connection = this.connections.get(connectionId);
      if (!connection) {
        throw new Error(`market subscription retained stale id ${connectionId}`);
      }
      for (const itemId of subscription.visibleItemIds) {
        if (
          !this.connectionIdsByMarketSummaryItem
            .get(marketItemKey(subscription.venueId, itemId))
            ?.has(connectionId)
        ) {
          throw new Error(`market summary subscription is inconsistent for ${connectionId}`);
        }
      }
      if (
        subscription.focusedItemId &&
        !this.connectionIdsByMarketBookItem
          .get(marketItemKey(subscription.venueId, subscription.focusedItemId))
          ?.has(connectionId)
      ) {
        throw new Error(`market book subscription is inconsistent for ${connectionId}`);
      }
      if (
        subscription.privateState &&
        !this.connectionIdsByMarketPrivatePlayer
          .get(marketPlayerKey(subscription.venueId, connection.playerId))
          ?.has(connectionId)
      ) {
        throw new Error(`market private subscription is inconsistent for ${connectionId}`);
      }
    }
  }

  private publish(
    connectionIds: Iterable<string>,
    message: ServerMessage,
    mode?: SendMode,
    broadcast = false
  ): Map<string, SendResult> {
    const results = this.publisher.publish(
      connectionIds,
      message,
      (connectionId, payload, deliveryMode) =>
        this.sendPayload(connectionId, payload, deliveryMode, message.type),
      { ...(mode === undefined ? {} : { mode }), broadcast }
    );
    if (message.type === "COMBAT_SNAPSHOT" || message.type === "COMBAT_DELTA") {
      for (const [connectionId, result] of results) {
        if (result !== "sent") continue;
        const playerId = this.connections.get(connectionId)?.playerId;
        if (playerId) this.combatPresentationObserver?.(playerId, message.state.upserts);
      }
    }
    return results;
  }

  private sendPayload(
    connectionId: string,
    payload: string,
    mode: SendMode,
    messageType: ServerMessage["type"]
  ): PublisherDeliveryResult {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return deliveryResult("missing");
    }
    if (connection.socket.readyState !== OPEN) {
      return deliveryResult("not-open", connection.socket.bufferedAmount ?? 0);
    }
    const bufferedAmount = connection.socket.bufferedAmount ?? 0;
    if (bufferedAmount >= this.hardBufferedBytes) {
      return this.closeForBackpressure(
        connection,
        bufferedAmount,
        mode,
        messageType,
        "websocket backpressure limit exceeded"
      );
    }
    if (mode === "replaceable" && bufferedAmount >= this.softBufferedBytes) {
      connection.consecutiveBackpressureSkips += 1;
      this.metrics.replaceableSkipped += 1;
      this.metrics.replaceableCoalesced += 1;
      if (connection.consecutiveBackpressureSkips >= this.maximumBackpressureSkips) {
        return this.closeForBackpressure(
          connection,
          bufferedAmount,
          mode,
          messageType,
          "websocket remained backpressured"
        );
      }
      return deliveryResult("backpressure-skipped", bufferedAmount);
    }
    // Social traffic yields well before gameplay reaches the general soft limit.
    // Durable traffic recovers by cursor; transient traffic is intentionally
    // dropped instead of delaying authoritative world acknowledgements.
    const socialBufferedBytes = Math.min(this.softBufferedBytes, 128 * 1024);
    if (
      (mode === "recoverable-social" || mode === "transient-social") &&
      bufferedAmount >= socialBufferedBytes
    ) {
      if (mode === "recoverable-social") this.metrics.recoverableSocialSkipped += 1;
      else this.metrics.transientSocialSkipped += 1;
      return deliveryResult("backpressure-skipped", bufferedAmount);
    }
    try {
      connection.socket.send(payload);
    } catch {
      this.deleteConnection(connectionId);
      return deliveryResult("closed", bufferedAmount, { sendFailure: true });
    }
    connection.consecutiveBackpressureSkips = 0;
    this.metrics.messagesSent += 1;
    return deliveryResult("sent", bufferedAmount);
  }

  private closeForBackpressure(
    connection: ConnectionRecord,
    bufferedAmount: number,
    deliveryMode: SendMode,
    messageType: ServerMessage["type"],
    closeReason: string
  ): PublisherDeliveryResult {
    this.metrics.backpressureClosures += 1;
    this.logger?.warn({
      connectionId: connection.connectionId,
      accountId: connection.accountId,
      authSessionId: connection.authSessionId,
      playerId: connection.playerId,
      regionCode: connection.regionCode,
      zoneId: connection.zoneId,
      messageType,
      deliveryMode,
      bufferedAmount,
      softBufferedBytes: this.softBufferedBytes,
      hardBufferedBytes: this.hardBufferedBytes,
      consecutiveBackpressureSkips: connection.consecutiveBackpressureSkips,
      connectedForMs: Math.max(0, Date.now() - connection.connectedAt.getTime()),
      closeCode: 4008,
      closeReason
    }, "closing websocket for backpressure");
    connection.socket.close(4008, closeReason);
    this.deleteConnection(connection.connectionId);
    return deliveryResult("closed", bufferedAmount, { backpressureClosure: true });
  }

  private deleteConnection(connectionId: string): ConnectionRecord | null {
    const connection = this.connections.get(connectionId) ?? null;
    if (!connection) {
      return null;
    }
    this.clearMarketSubscriptions(connectionId);
    this.connections.delete(connectionId);
    if (connection.accountId) {
      removeFromIndex(this.connectionIdsByAccount, connection.accountId, connectionId);
    }
    removeFromIndex(this.connectionIdsByPlayer, connection.playerId, connectionId);
    removeFromIndex(this.connectionIdsByRegion, connection.regionCode, connectionId);
    for (const zoneId of connection.interestZoneIds) {
      removeFromIndex(this.connectionIdsByZone, zoneId, connectionId);
    }
    if (
      connection.accountId &&
      this.activeConnectionByAccount.get(connection.accountId) === connectionId
    ) {
      this.activeConnectionByAccount.delete(connection.accountId);
    }
    if (this.activeConnectionByPlayer.get(connection.playerId) === connectionId) {
      const replacement = [...(this.connectionIdsByPlayer.get(connection.playerId) ?? [])].sort()[0];
      if (replacement) {
        this.activeConnectionByPlayer.set(connection.playerId, replacement);
      } else {
        this.activeConnectionByPlayer.delete(connection.playerId);
      }
    }
    this.economyActivity?.recordConnectionClosed({
      connectionId: connection.connectionId,
      accountId: connection.accountId,
      authSessionId: connection.authSessionId,
      playerId: connection.playerId,
      connectedAt: connection.connectedAt
    }, new Date());
    return connection;
  }

  private clearMarketSubscriptions(connectionId: string): void {
    const subscription = this.marketSubscriptions.get(connectionId);
    if (!subscription) {
      return;
    }
    for (const itemId of subscription.visibleItemIds) {
      removeFromIndex(
        this.connectionIdsByMarketSummaryItem,
        marketItemKey(subscription.venueId, itemId),
        connectionId
      );
    }
    if (subscription.focusedItemId) {
      removeFromIndex(
        this.connectionIdsByMarketBookItem,
        marketItemKey(subscription.venueId, subscription.focusedItemId),
        connectionId
      );
    }
    const connection = this.connections.get(connectionId);
    if (connection && subscription.privateState) {
      removeFromIndex(
        this.connectionIdsByMarketPrivatePlayer,
        marketPlayerKey(subscription.venueId, connection.playerId),
        connectionId
      );
    }
    this.marketSubscriptions.delete(connectionId);
  }
}

function marketItemKey(venueId: string, itemId: string): string {
  return `${venueId}:${itemId}`;
}

function marketPlayerKey(venueId: string, playerId: string): string {
  return `${venueId}:${playerId}`;
}

function deliveryResult(
  result: SendResult,
  bufferedAmount = 0,
  flags: Readonly<{
    backpressureClosure?: boolean;
    sendFailure?: boolean;
  }> = {}
): PublisherDeliveryResult {
  return {
    result,
    bufferedAmount,
    backpressureClosure: flags.backpressureClosure ?? false,
    sendFailure: flags.sendFailure ?? false
  };
}

function addToIndex(index: Map<string, Set<string>>, key: string, connectionId: string): void {
  let values = index.get(key);
  if (!values) {
    values = new Set();
    index.set(key, values);
  }
  values.add(connectionId);
}

function removeFromIndex(index: Map<string, Set<string>>, key: string, connectionId: string): void {
  const values = index.get(key);
  values?.delete(connectionId);
  if (values?.size === 0) {
    index.delete(key);
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
