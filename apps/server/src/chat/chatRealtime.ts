import {
  CHAT_CHANNEL_KEYS,
  CHAT_LOCAL_CHANNEL_KEY,
  boundedChatPreview,
  type ChatChannelKey,
  type ChatChannelCategory,
  type ChatMessage,
  type ChatMessagePreview,
  type ChatPartyListingInput,
  type ChatReadState,
  type ChatTradeListing,
  type ChatTranslationTargetLanguage,
  type ServerMessage
} from "@ash-atlas/shared";

import type { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import type { PresenceService } from "../realtime/presenceService.js";
import { ChatSubscriptionRegistry } from "./boundedMemory.js";
import type { ChatService } from "./chatService.js";
import { PartyListingError, type PartyListingService } from "./partyListings.js";
import { ChatServiceError } from "./types.js";

const DEFAULT_CHAT_CHANNEL: ChatChannelKey = CHAT_CHANNEL_KEYS[0];

export type LocalChatAudience = {
  visiblePlayerIdsFor(playerId: string): readonly string[];
  filterDirectlyInteractable(
    playerId: string,
    candidatePlayerIds: readonly string[]
  ): Promise<string[]>;
  hasActiveWorldTransition(playerId: string): boolean;
  onLocalDelivered?(senderPlayerId: string, recipientPlayerIds: readonly string[]): void;
  onDeliveryError?(error: unknown, metadata: { playerId: string; messageId: string }): void;
};

export class ChatRealtimeCoordinator {
  readonly subscriptions = new ChatSubscriptionRegistry();
  private readonly readStateByConnection = new Map<string, Map<ChatChannelKey, ChatReadState>>();
  private readonly selectionGenerationByConnection = new Map<string, number>();
  private deliveredMessages = 0;
  /** Hunting party-finder cards; attached once parties are available. */
  partyListings: PartyListingService | null = null;
  private deliveryLatencyMs = 0;

  constructor(
    readonly service: ChatService,
    private readonly registry: ConnectionRegistry,
    private readonly localAudience?: LocalChatAudience,
    private readonly presence?: PresenceService
  ) {}

  async connect(connectionId: string, playerId: string): Promise<void> {
    const previousSelection =
      this.subscriptions.activeChannelForConnection(connectionId) ?? DEFAULT_CHAT_CHANNEL;
    const snapshot = await this.service.channelsSnapshot(playerId, previousSelection);
    try {
      const durableChannels = snapshot.channels.filter(
        (channel) => channel.historyRetentionPolicy === "durable"
      );
      this.subscriptions.replacePreviews(connectionId, durableChannels.map((channel) => channel.key));
      const selectedChannelKey = snapshot.channels.some(
        (channel) => channel.key === previousSelection
      ) ? previousSelection : DEFAULT_CHAT_CHANNEL;
      this.subscriptions.selectActive(connectionId, selectedChannelKey);
      this.selectionGenerationByConnection.set(connectionId, 0);
      this.readStateByConnection.set(
        connectionId,
        new Map(snapshot.readStates.map((state) => [state.channelKey, state]))
      );
      const previews = await Promise.all(durableChannels.map(async (channel) => {
        const result = await this.service.history({
          playerId,
          channelKey: channel.key,
          limit: 1
        });
        return result.messages[0] ? previewFromMessage(result.messages[0]) : null;
      }));
      this.registry.sendToConnection(connectionId, {
        type: "CHAT_CHANNELS_SNAPSHOT",
        channels: snapshot.channels,
        readStates: snapshot.readStates,
        previews: previews.filter((preview): preview is ChatMessagePreview => preview !== null),
        selectedChannelKey,
        pinnedChannelCategories: snapshot.pinnedChannelCategories,
        onlinePlayerCount: this.presence?.aggregateSnapshot() ?? {
          count: 0,
          revision: 0,
          observedAt: new Date().toISOString(),
          players: []
        }
      });
      this.partyListings?.sendInitial(connectionId, playerId);
    } catch (error) {
      this.disconnect(connectionId);
      throw error;
    }
  }

  async select(
    connectionId: string,
    playerId: string,
    channelKey: ChatChannelKey,
    requestId?: string,
    afterSequence?: number
  ): Promise<void> {
    const generation = (this.selectionGenerationByConnection.get(connectionId) ?? 0) + 1;
    this.selectionGenerationByConnection.set(connectionId, generation);
    this.subscriptions.selectActive(connectionId, null);
    if (channelKey === CHAT_LOCAL_CHANNEL_KEY) {
      const [channel, mute] = await Promise.all([
        this.service.assertLocalChannelAccess(playerId, channelKey),
        this.service.activeMute(playerId, channelKey)
      ]);
      if (!this.isCurrentSelection(connectionId, generation)) return;
      this.subscriptions.selectActive(connectionId, channelKey);
      const readState: ChatReadState = {
        channelKey,
        lastReadSequence: 0,
        latestSequence: 0,
        unreadCount: 0,
        updatedAt: channel.updatedAt
      };
      this.rememberReadState(connectionId, readState);
      this.registry.sendToConnection(connectionId, {
        type: "CHAT_CHANNEL_SELECTED",
        ...(requestId ? { requestId } : {}),
        channelKey,
        messages: [],
        latestSequence: 0,
        hasOlder: false,
        reset: false,
        readState,
        mute
      });
      return;
    }
    await this.service.assertDurableChannelAccess(playerId, channelKey);
    if (!this.isCurrentSelection(connectionId, generation)) return;
    this.subscriptions.selectActive(connectionId, channelKey);
    const [history, mute, readState] = await Promise.all([
      this.service.history({
        playerId,
        channelKey,
        ...(afterSequence === undefined ? {} : { afterSequence }),
        limit: afterSequence === undefined ? this.service.historyPageSize : this.service.catchUpLimit
      }),
      this.service.activeMute(playerId, channelKey),
      this.service.readState(playerId, channelKey)
    ]);
    if (!this.isCurrentSelection(connectionId, generation)) return;
    this.rememberReadState(connectionId, readState);
    if (afterSequence !== undefined) {
      this.registry.sendToConnection(connectionId, {
        type: "CHAT_HISTORY_RESULT",
        requestId: requestId ?? crypto.randomUUID(),
        channelKey,
        direction: "newer",
        messages: history.messages,
        hasMore: history.hasMore,
        latestSequence: history.latestSequence,
        reset: history.resetRequired,
        maximumCatchUp: this.service.catchUpLimit,
        ...(history.channel.deletionRevision === undefined
          ? {}
          : { deletionRevision: history.channel.deletionRevision })
      });
      this.registry.sendToConnection(connectionId, {
        type: "CHAT_MUTE_SNAPSHOT",
        channelKey,
        mute
      });
      return;
    }
    this.registry.sendToConnection(connectionId, {
      type: "CHAT_CHANNEL_SELECTED",
      ...(requestId ? { requestId } : {}),
      channelKey,
      messages: history.messages,
      latestSequence: history.latestSequence,
      hasOlder: history.mode === "initial" || history.mode === "bounded-snapshot"
        ? history.hasMore
        : (history.messages[0]?.sequence ?? 1) > 1,
      reset: history.resetRequired,
      ...(history.channel.deletionRevision === undefined
        ? {}
        : { deletionRevision: history.channel.deletionRevision }),
      readState,
      mute
    });
  }

  async send(
    connectionId: string,
    playerId: string,
    senderDisplayName: string,
    input: {
      requestId: string;
      channelKey: ChatChannelKey;
      body: string;
      tradeListing?: ChatTradeListing | undefined;
      partyListing?: ChatPartyListingInput | undefined;
    }
  ): Promise<void> {
    const local = input.channelKey === CHAT_LOCAL_CHANNEL_KEY;
    if (local && this.localAudience?.hasActiveWorldTransition(playerId)) {
      throw new ChatServiceError("CHAT_ACCESS_DENIED", "Local chat is temporarily unavailable");
    }
    let partyListing;
    if (input.partyListing) {
      if (!this.partyListings) throw new ChatServiceError("CHAT_LISTING_INVALID", "Party cards are unavailable right now.");
      try {
        partyListing = await this.partyListings.prepare(playerId, input.channelKey, input.partyListing, input.requestId);
      } catch (error) {
        if (error instanceof PartyListingError) throw new ChatServiceError("CHAT_LISTING_INVALID", error.message);
        throw error;
      }
    }
    const result = await this.service.send({
      channelKey: input.channelKey,
      senderPlayerId: playerId,
      senderDisplayName,
      clientRequestId: input.requestId,
      body: input.body,
      ...(input.tradeListing ? { tradeListing: input.tradeListing } : {}),
      ...(partyListing ? { partyListing } : {})
    });
    this.partyListings?.recordPosted(result.message);
    this.registry.sendToConnection(connectionId, {
      type: "CHAT_SEND_RESULT",
      requestId: input.requestId,
      replayed: result.replayed,
      message: result.message
    });
    if (result.replayed) return;

    if (local) {
      try {
        await this.deliverLocal(playerId, result.message);
      } catch (error) {
        this.localAudience?.onDeliveryError?.(error, {
          playerId,
          messageId: result.message.id
        });
      }
      return;
    }

    const activeCandidates = this.subscriptions.activeConnectionIds(result.message.channelKey);
    const previewCandidates = this.subscriptions.previewConnectionIds(result.message.channelKey);
    const playerIdByConnectionId = new Map(
      [...new Set([...activeCandidates, ...previewCandidates])].flatMap((candidateId) => {
        const record = this.registry.recordForConnection(candidateId);
        return record ? [[candidateId, record.playerId] as const] : [];
      })
    );
    const authorizedPlayers = await this.service.authorizedRecipientPlayerIds(
      result.message.channelKey,
      [...playerIdByConnectionId.values()]
    );
    const activeConnectionIds = new Set(
      activeCandidates.filter((candidateId) => {
        const recipientPlayerId = playerIdByConnectionId.get(candidateId);
        return recipientPlayerId !== undefined && authorizedPlayers.has(recipientPlayerId);
      })
    );
    this.registry.sendToConnectionIds(activeConnectionIds, {
      type: "CHAT_MESSAGE",
      message: result.message
    });
    const preview = previewFromMessage(result.message);
    for (const subscriberId of previewCandidates) {
      const recipientPlayerId = playerIdByConnectionId.get(subscriberId);
      if (!recipientPlayerId || !authorizedPlayers.has(recipientPlayerId)) continue;
      const readState = this.readStateByConnection.get(subscriberId)?.get(result.message.channelKey);
      const lastReadSequence = readState?.lastReadSequence ?? 0;
      this.rememberReadState(subscriberId, {
        channelKey: result.message.channelKey,
        lastReadSequence,
        latestSequence: result.message.sequence,
        unreadCount: Math.max(0, result.message.sequence - lastReadSequence),
        updatedAt: readState?.updatedAt ?? result.message.serverCreatedAt
      });
      if (activeConnectionIds.has(subscriberId)) continue;
      this.registry.sendToConnection(subscriberId, {
        type: "CHAT_PREVIEW_UPDATE",
        preview,
        latestSequence: result.message.sequence,
        unreadCount: Math.max(0, result.message.sequence - lastReadSequence)
      }, "replaceable");
    }
    this.deliveredMessages += 1;
    this.deliveryLatencyMs += Math.max(0, Date.now() - Date.parse(result.message.serverCreatedAt));
  }

  /**
   * Push a newly cached shared translation to the channel's active subscribers, using the same
   * audience and authorization as message delivery. Local chat is never translated.
   */
  async broadcastTranslation(input: {
    channelId: string;
    channelKey: ChatChannelKey;
    messageCreatedAt: Date;
    messageId: string;
    targetLanguage: ChatTranslationTargetLanguage;
    translatedText: string;
    sourceLanguage?: string | undefined;
  }): Promise<void> {
    if (input.channelKey === CHAT_LOCAL_CHANNEL_KEY) return;
    const candidates = this.subscriptions.activeConnectionIds(input.channelKey);
    const playerIdByConnectionId = new Map(
      candidates.flatMap((candidateId) => {
        const record = this.registry.recordForConnection(candidateId);
        return record ? [[candidateId, record.playerId] as const] : [];
      })
    );
    if (playerIdByConnectionId.size === 0) return;
    const authorizedPlayers = await this.service.authorizedRecipientPlayerIds(
      input.channelKey,
      [...playerIdByConnectionId.values()],
      input.messageCreatedAt
    );
    this.registry.sendToConnectionIds(
      new Set(candidates.filter((candidateId) => {
        const recipientPlayerId = playerIdByConnectionId.get(candidateId);
        return recipientPlayerId !== undefined && authorizedPlayers.has(recipientPlayerId);
      })),
      {
        type: "CHAT_MESSAGE_TRANSLATION",
        channelId: input.channelId,
        channelKey: input.channelKey,
        messageId: input.messageId,
        targetLanguage: input.targetLanguage,
        translatedText: input.translatedText,
        ...(input.sourceLanguage ? { sourceLanguage: input.sourceLanguage } : {})
      }
    );
  }

  async deleteMessage(
    connectionId: string,
    playerId: string,
    requestId: string,
    messageId: string
  ): Promise<void> {
    const result = await this.service.deleteMessage(playerId, messageId);
    const requesterMessage: ServerMessage = {
      type: "CHAT_MESSAGE_DELETED",
      requestId,
      message: result.message,
      deletionRevision: result.deletionRevision,
      replayed: result.replayed
    };
    if (result.replayed) {
      this.registry.sendToConnection(connectionId, requesterMessage);
      return;
    }

    const activeCandidates = this.subscriptions.activeConnectionIds(result.message.channelKey);
    const previewCandidates = this.subscriptions.previewConnectionIds(result.message.channelKey);
    const candidateIds = new Set([connectionId, ...activeCandidates, ...previewCandidates]);
    const playerIdByConnectionId = new Map(
      [...candidateIds].flatMap((candidateId) => {
        const record = this.registry.recordForConnection(candidateId);
        return record ? [[candidateId, record.playerId] as const] : [];
      })
    );
    const authorizedPlayers = await this.service.authorizedRecipientPlayerIds(
      result.message.channelKey,
      [...playerIdByConnectionId.values()]
    );
    for (const candidateId of candidateIds) {
      const recipientPlayerId = playerIdByConnectionId.get(candidateId);
      if (candidateId !== connectionId &&
          (recipientPlayerId === undefined || !authorizedPlayers.has(recipientPlayerId))) {
        continue;
      }
      this.registry.sendToConnection(candidateId, candidateId === connectionId
        ? requesterMessage
        : {
            type: "CHAT_MESSAGE_DELETED",
            message: result.message,
            deletionRevision: result.deletionRevision,
            replayed: false
          });
    }
  }

  async updatePinnedChannels(
    connectionId: string,
    playerId: string,
    requestId: string,
    categories: readonly ChatChannelCategory[]
  ): Promise<void> {
    const pinnedChannelCategories =
      await this.service.updatePinnedChannelCategories(playerId, categories);
    this.registry.sendToConnection(connectionId, {
      type: "CHAT_PINNED_CHANNELS_UPDATED",
      requestId,
      pinnedChannelCategories
    });
  }

  async refreshAuthorizedChannels(connectionId: string, playerId: string): Promise<void> {
    await this.connect(connectionId, playerId);
  }

  async refreshAuthorizedPlayer(playerId: string): Promise<void> {
    const connectionId = this.registry.activeConnectionIdForPlayer(playerId);
    if (connectionId) await this.refreshAuthorizedChannels(connectionId, playerId);
  }

  async history(
    connectionId: string,
    playerId: string,
    input: {
      requestId: string;
      channelKey: ChatChannelKey;
      direction: "older" | "newer";
      cursorSequence: number | null;
      limit: number;
    }
  ): Promise<void> {
    if (input.channelKey === CHAT_LOCAL_CHANNEL_KEY) {
      throw new ChatServiceError("CHAT_ACCESS_DENIED", "Local chat history is unavailable");
    }
    const result = await this.service.history({
      playerId,
      channelKey: input.channelKey,
      ...(input.direction === "older"
        ? { beforeSequence: input.cursorSequence ?? undefined }
        : { afterSequence: input.cursorSequence ?? 0 }),
      limit: input.limit
    });
    this.registry.sendToConnection(connectionId, {
      type: "CHAT_HISTORY_RESULT",
      requestId: input.requestId,
      channelKey: input.channelKey,
      direction: input.direction,
      messages: result.messages,
      hasMore: result.hasMore,
      latestSequence: result.latestSequence,
      reset: result.resetRequired,
      maximumCatchUp: this.service.catchUpLimit,
      ...(result.channel.deletionRevision === undefined
        ? {}
        : { deletionRevision: result.channel.deletionRevision })
    });
  }

  async markRead(
    connectionId: string,
    playerId: string,
    requestId: string,
    channelKey: ChatChannelKey,
    lastReadSequence: number
  ): Promise<void> {
    if (channelKey === CHAT_LOCAL_CHANNEL_KEY) {
      throw new ChatServiceError("CHAT_ACCESS_DENIED", "Local chat read state is unavailable");
    }
    const readState = await this.service.markRead(playerId, channelKey, lastReadSequence);
    this.rememberReadState(connectionId, readState);
    this.registry.sendToConnection(connectionId, {
      type: "CHAT_READ_STATE",
      requestId,
      readState
    }, "replaceable");
  }

  disconnect(connectionId: string): void {
    this.subscriptions.removeConnection(connectionId);
    this.readStateByConnection.delete(connectionId);
    this.selectionGenerationByConnection.delete(connectionId);
  }

  metrics(): Record<string, number> {
    const subscriptions = this.subscriptions.metrics();
    return {
      ...subscriptions,
      readStateConnections: this.readStateByConnection.size,
      selectionConnections: this.selectionGenerationByConnection.size,
      deliveredMessages: this.deliveredMessages,
      averageDeliveryLatencyMs: this.deliveredMessages === 0
        ? 0
        : this.deliveryLatencyMs / this.deliveredMessages,
      ...this.service.metricsSnapshot()
    };
  }

  private rememberReadState(connectionId: string, state: ChatReadState): void {
    let states = this.readStateByConnection.get(connectionId);
    if (!states) {
      states = new Map();
      this.readStateByConnection.set(connectionId, states);
    }
    states.set(state.channelKey, state);
  }

  private isCurrentSelection(connectionId: string, generation: number): boolean {
    return this.selectionGenerationByConnection.get(connectionId) === generation;
  }

  private async deliverLocal(playerId: string, message: ChatMessage): Promise<void> {
    const initialAudience = this.currentLocalAudience(playerId);
    const sociallyAllowed = this.localAudience
      ? await this.localAudience.filterDirectlyInteractable(playerId, initialAudience)
      : initialAudience;
    const currentAudience = new Set(this.currentLocalAudience(playerId));
    const playerIdByConnectionId = new Map<string, string>();
    for (const recipientPlayerId of sociallyAllowed) {
      if (!currentAudience.has(recipientPlayerId)) continue;
      const recipientConnectionId = this.registry.activeConnectionIdForPlayer(recipientPlayerId);
      if (recipientConnectionId) playerIdByConnectionId.set(recipientConnectionId, recipientPlayerId);
    }
    const results = this.registry.sendToConnectionIds(new Set(playerIdByConnectionId.keys()), {
      type: "CHAT_MESSAGE",
      message
    }, "transient-social");
    const deliveredPlayerIds = [...results]
      .filter(([, result]) => result === "sent")
      .map(([connectionId]) => playerIdByConnectionId.get(connectionId)!)
      .filter((recipientPlayerId) => recipientPlayerId !== playerId);
    if (deliveredPlayerIds.length > 0) {
      this.localAudience?.onLocalDelivered?.(playerId, deliveredPlayerIds);
    }
    this.deliveredMessages += 1;
    this.deliveryLatencyMs += Math.max(0, Date.now() - Date.parse(message.serverCreatedAt));
  }

  private currentLocalAudience(playerId: string): string[] {
    if (!this.localAudience) return [playerId];
    if (this.localAudience.hasActiveWorldTransition(playerId)) return [];
    return [...new Set(this.localAudience.visiblePlayerIdsFor(playerId))]
      .filter((candidate) => !this.localAudience!.hasActiveWorldTransition(candidate));
  }
}

function previewFromMessage(message: ChatMessage): ChatMessagePreview {
  return {
    id: message.id,
    channelKey: message.channelKey,
    sequence: message.sequence,
    senderPlayerId: message.senderPlayerId,
    senderDisplayName: message.senderDisplayName,
    ...(message.chatCrestId ? { chatCrestId: message.chatCrestId } : {}),
    body: boundedChatPreview(message.body),
    serverCreatedAt: message.serverCreatedAt
  };
}
