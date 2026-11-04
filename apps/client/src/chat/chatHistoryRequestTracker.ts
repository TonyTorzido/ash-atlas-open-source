import type { ChatChannelKey } from "@ash-atlas/shared";

export type ActiveChatHistoryRequest = {
  requestId: string;
  channelKey: ChatChannelKey;
  beforeSequence: number;
};

export type ChatHistoryRequestSnapshot = {
  active: ActiveChatHistoryRequest | null;
};

type Listener = () => void;

export class ChatHistoryRequestTracker {
  private active: ActiveChatHistoryRequest | null = null;
  private readonly listeners = new Set<Listener>();
  private snapshot: ChatHistoryRequestSnapshot = { active: null };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ChatHistoryRequestSnapshot => this.snapshot;

  start(request: ActiveChatHistoryRequest): void {
    this.active = request;
    this.publish();
  }

  completeResult(input: { requestId: string; channelKey: ChatChannelKey }): boolean {
    if (this.active === null) return false;
    if (
      this.active.requestId !== input.requestId ||
      this.active.channelKey !== input.channelKey
    ) {
      return false;
    }
    this.active = null;
    this.publish();
    return true;
  }

  completeError(input: { requestId: string }): boolean {
    if (this.active === null) return false;
    if (this.active.requestId !== input.requestId) return false;
    this.active = null;
    this.publish();
    return true;
  }

  cancel(): void {
    if (this.active === null) return;
    this.active = null;
    this.publish();
  }

  cancelForChannelChange(selectedChannelKey: ChatChannelKey | null): void {
    if (this.active === null) return;
    if (this.active.channelKey !== selectedChannelKey) {
      this.active = null;
      this.publish();
    }
  }

  private publish(): void {
    this.snapshot = { active: this.active };
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
