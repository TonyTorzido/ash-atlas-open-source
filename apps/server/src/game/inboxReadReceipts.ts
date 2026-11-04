import type { GameInboxNotice, InboxReadReceipt, InboxReadTarget } from "@ash-atlas/shared";
import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export class InboxReadReceiptService {
  constructor(private readonly pool: pg.Pool) {}

  async list(playerId: string): Promise<InboxReadReceipt[]> {
    const result = await this.pool.query<{
      entry_key: string;
      read_revision: string;
      read_at: Date | string;
    }>(
      `SELECT entry_key, read_revision, read_at
       FROM player_inbox_read_receipts
       WHERE player_id = $1
       ORDER BY entry_key`,
      [playerId]
    );
    return result.rows.map((row) => ({
      entryKey: row.entry_key,
      revision: row.read_revision,
      readAt: new Date(row.read_at).toISOString()
    }));
  }

  async listGameNotices(playerId: string): Promise<GameInboxNotice[]> {
    const result = await this.pool.query<{
      event_kind: string;
      event_id: string;
      message: string;
      created_at: Date | string;
    }>(
      `SELECT event_kind,event_id::text,message,created_at
       FROM player_inbox_entries
       WHERE player_id=$1 AND entry_kind='game_notice'
       ORDER BY created_at DESC,id DESC
       LIMIT 200`,
      [playerId]
    );
    return result.rows.map((row) => ({
      eventKind: row.event_kind,
      eventId: row.event_id,
      message: row.message,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  async markRead(playerId: string, entries: readonly InboxReadTarget[]): Promise<InboxReadReceipt[]> {
    const unique = new Map(entries.map((entry) => [entry.entryKey, entry]));
    if (unique.size === 0) return this.list(playerId);
    const values = [...unique.values()];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const entry of values) {
        const packageId = packageIdFromEntryKey(entry.entryKey);
        if (packageId) {
          await markPlayerPackageReadInTransaction(client, playerId, packageId);
          continue;
        }
        await client.query(
          `INSERT INTO player_inbox_read_receipts (
             player_id, entry_key, read_revision, read_at
           ) VALUES ($1,$2,$3,now())
           ON CONFLICT (player_id, entry_key) DO UPDATE SET
             read_revision = EXCLUDED.read_revision,
             read_at = EXCLUDED.read_at`,
          [playerId, entry.entryKey, entry.revision]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.list(playerId);
  }
}

export async function markPlayerPackageReadInTransaction(
  queryable: Queryable,
  playerId: string,
  packageId: string
): Promise<string | null> {
  const updated = await queryable.query<{ revision: string }>(
    `UPDATE player_packages
     SET read_at = COALESCE(read_at, now())
     WHERE id = $1
       AND recipient_player_id = $2
     RETURNING revision::text`,
    [packageId, playerId]
  );
  const revision = updated.rows[0]?.revision ?? null;
  if (!revision) return null;
  await queryable.query(
    `INSERT INTO player_inbox_read_receipts (
       player_id, entry_key, read_revision, read_at
     ) VALUES ($1,$2,$3,now())
     ON CONFLICT (player_id, entry_key) DO UPDATE SET
       read_revision = EXCLUDED.read_revision,
       read_at = EXCLUDED.read_at`,
    [playerId, `package:${packageId}`, revision]
  );
  return revision;
}

function packageIdFromEntryKey(entryKey: string): string | null {
  const match = /^package:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu
    .exec(entryKey);
  return match?.[1] ?? null;
}
