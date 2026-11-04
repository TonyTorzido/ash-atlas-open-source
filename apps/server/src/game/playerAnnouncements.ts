import {
  PLAYER_ANNOUNCEMENT_LIST_LIMIT,
  type DismissPlayerAnnouncementResponse,
  type PlayerAnnouncement,
  type PlayerAnnouncementListResponse,
  type PublishPlayerAnnouncementRequest,
  type PublishPlayerAnnouncementResponse
} from "@ash-atlas/shared";
import type pg from "pg";

type AnnouncementRow = {
  id: string;
  operation_key: string;
  title: string;
  message: string;
  published_at: Date;
};

type AnnouncementListRow = AnnouncementRow & { latest_dismissed: boolean };

export class PlayerAnnouncementNotFoundError extends Error {
  readonly code = "ANNOUNCEMENT_NOT_FOUND";
  readonly statusCode = 404;

  constructor() {
    super("Announcement was not found");
    this.name = "PlayerAnnouncementNotFoundError";
  }
}

export class PlayerAnnouncementConflictError extends Error {
  readonly code = "ANNOUNCEMENT_OPERATION_CONFLICT";
  readonly statusCode = 409;

  constructor() {
    super("This announcement operation key was already used with different content");
    this.name = "PlayerAnnouncementConflictError";
  }
}

export class PlayerAnnouncementService {
  constructor(private readonly pool: pg.Pool) {}

  async list(playerId: string): Promise<PlayerAnnouncementListResponse> {
    const result = await this.pool.query<AnnouncementListRow>(
      `SELECT announcement.id, announcement.operation_key, announcement.title,
              announcement.message, announcement.published_at,
              EXISTS (
                SELECT 1 FROM player_announcement_dismissals dismissal
                WHERE dismissal.player_id = $1
                  AND dismissal.announcement_id = announcement.id
              ) AS latest_dismissed
       FROM player_announcements announcement
       ORDER BY announcement.published_at DESC, announcement.id DESC
       LIMIT $2`,
      [playerId, PLAYER_ANNOUNCEMENT_LIST_LIMIT]
    );
    const announcements = result.rows.map(announcementFromRow);
    return {
      announcements,
      latestAnnouncementId: announcements[0]?.id ?? null,
      latestAnnouncementDismissed: result.rows[0]?.latest_dismissed ?? false
    };
  }

  async dismiss(playerId: string, announcementId: string): Promise<DismissPlayerAnnouncementResponse> {
    const result = await this.pool.query<{ dismissed_at: Date }>(
      `INSERT INTO player_announcement_dismissals (player_id, announcement_id)
       SELECT $1, id FROM player_announcements WHERE id = $2
       ON CONFLICT (player_id, announcement_id) DO UPDATE
         SET dismissed_at = player_announcement_dismissals.dismissed_at
       RETURNING dismissed_at`,
      [playerId, announcementId]
    );
    const dismissedAt = result.rows[0]?.dismissed_at;
    if (!dismissedAt) throw new PlayerAnnouncementNotFoundError();
    return { announcementId, dismissed: true, dismissedAt: dismissedAt.toISOString() };
  }

  async publish(
    actorAccountId: string,
    input: PublishPlayerAnnouncementRequest
  ): Promise<PublishPlayerAnnouncementResponse> {
    const inserted = await this.pool.query<AnnouncementRow>(
      `INSERT INTO player_announcements (
         operation_key, title, message, created_by_account_id
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (operation_key) DO NOTHING
       RETURNING id, operation_key, title, message, published_at`,
      [input.operationKey, input.title, input.message, actorAccountId]
    );
    if (inserted.rows[0]) {
      return { announcement: announcementFromRow(inserted.rows[0]), replayed: false };
    }

    const existing = await this.pool.query<AnnouncementRow>(
      `SELECT id, operation_key, title, message, published_at
       FROM player_announcements
       WHERE operation_key = $1`,
      [input.operationKey]
    );
    const row = existing.rows[0];
    if (!row || row.title !== input.title || row.message !== input.message) {
      throw new PlayerAnnouncementConflictError();
    }
    return { announcement: announcementFromRow(row), replayed: true };
  }
}

function announcementFromRow(row: AnnouncementRow): PlayerAnnouncement {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    publishedAt: row.published_at.toISOString()
  };
}
