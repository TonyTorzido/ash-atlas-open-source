import type { ChatChannelKey } from "@ash-atlas/shared";

export const CHAT_READ_COALESCE_MS = 150;

type PendingReadUpdate = {
  channelKey: ChatChannelKey;
  sequence: number;
};

export class ChatReadUpdateCoalescer {
  private pending: PendingReadUpdate | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (channelKey: ChatChannelKey, sequence: number) => void,
    private readonly delayMs = CHAT_READ_COALESCE_MS
  ) {}

  enqueue(channelKey: ChatChannelKey, sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return;
    if (this.pending && this.pending.channelKey !== channelKey) {
      this.flush();
    }
    this.pending = {
      channelKey,
      sequence: Math.max(this.pending?.sequence ?? 0, sequence)
    };
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flushPending();
      }, this.delayMs);
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushPending();
  }

  get size(): number {
    return this.pending === null ? 0 : 1;
  }

  private flushPending(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) this.send(pending.channelKey, pending.sequence);
  }
}
