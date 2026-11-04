import {
  playerAnnouncementListResponseSchema,
  dismissPlayerAnnouncementResponseSchema,
  type DismissPlayerAnnouncementResponse,
  publishPlayerAnnouncementResponseSchema,
  type PlayerAnnouncementListResponse,
  type PublishPlayerAnnouncementRequest,
  type PublishPlayerAnnouncementResponse
} from "@ash-atlas/shared";

export class AnnouncementClient {
  constructor(
    private readonly serverHttpBase: string,
    private readonly csrfToken?: string
  ) {}

  async list(signal?: AbortSignal): Promise<PlayerAnnouncementListResponse> {
    const response = await fetch(new URL("/api/announcements", this.serverHttpBase), {
      credentials: "include",
      ...(signal ? { signal } : {})
    });
    return parseResponse(response, playerAnnouncementListResponseSchema, "Could not load announcements");
  }

  async publish(input: PublishPlayerAnnouncementRequest): Promise<PublishPlayerAnnouncementResponse> {
    const response = await fetch(new URL("/api/admin/announcements", this.serverHttpBase), {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(this.csrfToken ? { "x-csrf-token": this.csrfToken } : {})
      },
      body: JSON.stringify(input)
    });
    return parseResponse(response, publishPlayerAnnouncementResponseSchema, "Could not publish announcement");
  }

  async dismiss(announcementId: string): Promise<DismissPlayerAnnouncementResponse> {
    const response = await fetch(
      new URL(`/api/announcements/${encodeURIComponent(announcementId)}/dismiss`, this.serverHttpBase),
      {
        method: "POST",
        credentials: "include",
        keepalive: true,
        headers: {
          ...(this.csrfToken ? { "x-csrf-token": this.csrfToken } : {})
        }
      }
    );
    return parseResponse(response, dismissPlayerAnnouncementResponseSchema, "Could not dismiss announcement");
  }
}

async function parseResponse<T>(
  response: Response,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  fallback: string
): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
      ? body.error.message
      : `${fallback} (${response.status})`;
    throw new Error(message);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(`${fallback}: invalid server response`);
  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
