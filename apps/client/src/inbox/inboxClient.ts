import {
  gameInboxNoticesResponseSchema,
  inboxReadStateSchema,
  type GameInboxNotice,
  type InboxReadReceipt,
  type InboxReadTarget
} from "@ash-atlas/shared";

export class InboxApiClient {
  constructor(
    private readonly serverHttpBase: string,
    private readonly csrfToken: string
  ) {}

  async readState(): Promise<InboxReadReceipt[]> {
    const payload = await this.request("/api/inbox/read-state", { method: "GET" });
    return inboxReadStateSchema.parse(payload).receipts;
  }

  async notices(): Promise<GameInboxNotice[]> {
    const payload = await this.request("/api/inbox/notices", { method: "GET" });
    return gameInboxNoticesResponseSchema.parse(payload).notices;
  }

  async markRead(entries: readonly InboxReadTarget[]): Promise<InboxReadReceipt[]> {
    const payload = await this.request("/api/inbox/read", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": this.csrfToken
      },
      body: JSON.stringify({ entries })
    });
    return inboxReadStateSchema.parse(payload).receipts;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(new URL(path, this.serverHttpBase), {
      ...init,
      credentials: "include"
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "message" in payload
        && typeof payload.message === "string"
        ? payload.message
        : "Messages read state is unavailable";
      throw new Error(message);
    }
    return payload;
  }
}
