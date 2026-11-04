import type {
  ChatChannelCategory,
  ChatPartyListingInput,
  ChatTradeListing,
  ClientMessage,
  DirectMessagePreferences
} from "@ash-atlas/shared";
import { requestIdCrypto as crypto } from "../../requestId.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

export class SocialClient {
  constructor(private readonly port: ClientCommandPort) {}

  selectChatChannel(channelKey: string, afterSequence?: number): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "CHAT_SELECT_CHANNEL",
        requestId,
        channelKey,
        ...(afterSequence === undefined ? {} : { afterSequence })
      }) ? requestId : null;
    }

  requestChatBootstrap(): boolean {
      return this.send({ type: "REQUEST_CHAT_BOOTSTRAP" });
    }

  sendChatMessage(
      channelKey: string,
      body: string,
      requestId: string = crypto.randomUUID(),
      tradeListing?: ChatTradeListing,
      partyListing?: ChatPartyListingInput
    ): string | null {
      return this.send({
        type: "CHAT_SEND",
        requestId,
        channelKey,
        body,
        ...(tradeListing ? { tradeListing } : {}),
        ...(partyListing ? { partyListing } : {})
      }) ? requestId : null;
    }

  deleteChatMessage(
      messageId: string,
      requestId: string = crypto.randomUUID()
    ): string | null {
      return this.send({ type: "CHAT_MESSAGE_DELETE", requestId, messageId }) ? requestId : null;
    }

  bootstrapDirectMessages(afterEventSequence?: string): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "DM_BOOTSTRAP",
        requestId,
        ...(afterEventSequence === undefined ? {} : { afterEventSequence })
      }) ? requestId : null;
    }

  listDirectMessages(cursor: string | null = null, search?: string, limit = 25): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "DM_LIST",
        requestId,
        cursor,
        limit,
        ...(search === undefined ? {} : { search })
      }) ? requestId : null;
    }

  openDirectMessage(peerPlayerId: string): string | null {
      const requestId = crypto.randomUUID();
      return this.send({ type: "DM_OPEN", requestId, peerPlayerId }) ? requestId : null;
    }

  requestDirectMessageHistory(
      conversationId: string,
      beforeSequence: string | null,
      limit = 50
    ): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "DM_HISTORY",
        requestId,
        conversationId,
        beforeSequence,
        limit
      }) ? requestId : null;
    }

  sendDirectMessage(
      conversationId: string,
      clientMessageId: string,
      body: string
    ): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "DM_SEND",
        requestId,
        conversationId,
        clientMessageId,
        body
      }) ? requestId : null;
    }

  updateDirectMessageRead(conversationId: string, throughSequence: string): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "DM_READ",
        requestId,
        conversationId,
        throughSequence
      }) ? requestId : null;
    }

  acknowledgeDirectMessageDelivery(conversationId: string, throughSequence: string): boolean {
      return this.send({
        type: "DM_DELIVERED",
        requestId: crypto.randomUUID(),
        conversationId,
        throughSequence
      });
    }

  setDirectMessageMute(conversationId: string, muted: boolean): boolean {
      return this.send({
        type: "DM_MUTE",
        requestId: crypto.randomUUID(),
        conversationId,
        muted
      });
    }

  setDirectMessagePreferences(preferences: DirectMessagePreferences): boolean {
      return this.send({
        type: "DM_PREFERENCES",
        requestId: crypto.randomUUID(),
        preferences
      });
    }

  syncDirectMessages(afterEventSequence: string, limit = 100): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "DM_SYNC",
        requestId,
        afterEventSequence,
        limit
      }) ? requestId : null;
    }

  acknowledgeDirectMessageEvents(throughEventSequence: string): boolean {
      return this.send({
        type: "DM_EVENT_ACK",
        requestId: crypto.randomUUID(),
        throughEventSequence
      });
    }

  requestChatHistory(
      channelKey: string,
      direction: "older" | "newer",
      cursorSequence: number | null,
      limit = 50
    ): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "CHAT_HISTORY_REQUEST",
        requestId,
        channelKey,
        direction,
        cursorSequence,
        limit
      }) ? requestId : null;
    }

  updateChatRead(channelKey: string, lastReadSequence: number): boolean {
      return this.send({
        type: "CHAT_READ_UPDATE",
        requestId: crypto.randomUUID(),
        channelKey,
        lastReadSequence
      });
    }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }

  updatePinnedChatChannels(categories: readonly ChatChannelCategory[]): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "CHAT_PINNED_CHANNELS_UPDATE",
      requestId,
      categories: [...categories]
    }) ? requestId : null;
  }
}
