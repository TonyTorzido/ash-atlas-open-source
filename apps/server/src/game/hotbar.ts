import {
  decodePersistedHotbarSlots,
  defaultHotbarSettings,
  hotbarSettingsSchema,
  hotbarUpdateSchema,
  normalizeHotbarLayoutForPersistence,
  type HotbarSettings,
  type HotbarUpdate
} from "@ash-atlas/shared";
import type pg from "pg";

type HotbarRow = {
  revision: number | string;
  slots: unknown;
  row_count?: number | string | null;
  row_positions?: unknown;
};

export class HotbarError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "HotbarError";
  }
}

export class HotbarService {
  constructor(private readonly pool: pg.Pool) {}

  async get(playerId: string): Promise<HotbarSettings> {
    const result = await this.pool.query<HotbarRow>(
      `SELECT revision, slots, row_count, row_positions
       FROM player_hotbar_settings
       WHERE player_id = $1`,
      [playerId]
    );
    const row = result.rows[0];
    return row ? decodeHotbarRow(row) : defaultHotbarSettings();
  }

  async update(playerId: string, input: HotbarUpdate): Promise<HotbarSettings> {
    const parsed = hotbarUpdateSchema.safeParse(input);
    if (!parsed.success) {
      throw new HotbarError("HOTBAR_INVALID", "Hotbar slots are invalid.", 400);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<HotbarRow>(
        `SELECT revision, slots, row_count, row_positions
         FROM player_hotbar_settings
         WHERE player_id = $1
         FOR UPDATE`,
        [playerId]
      );
      let row = current.rows[0];
      if (!row) {
        if (parsed.data.revision !== 0) throw changedError();
        const layout = normalizeHotbarLayoutForPersistence(parsed.data.rowCount, parsed.data.rowPositions);
        const inserted = await client.query<HotbarRow>(
          `INSERT INTO player_hotbar_settings (player_id, revision, slots, row_count, row_positions)
           VALUES ($1, 1, $2::jsonb, $3, $4::jsonb)
           ON CONFLICT (player_id) DO NOTHING
           RETURNING revision, slots, row_count, row_positions`,
          [
            playerId,
            JSON.stringify(parsed.data.slots),
            layout.rowCount,
            JSON.stringify(layout.rowPositions)
          ]
        );
        if (inserted.rows[0]) {
          await client.query("COMMIT");
          return decodeHotbarRow(inserted.rows[0]);
        }
        // A concurrent first write won the unique-key race. Lock and
        // compare its revision through the same optimistic-concurrency path
        // used for already-populated rows instead of returning a generic DB
        // failure.
        const concurrent = await client.query<HotbarRow>(
          `SELECT revision, slots, row_count, row_positions
           FROM player_hotbar_settings
           WHERE player_id = $1
           FOR UPDATE`,
          [playerId]
        );
        row = concurrent.rows[0];
        if (!row) throw unavailableError();
      }
      const revision = safeRevision(row.revision);
      if (revision !== parsed.data.revision) throw changedError();
      const nextRevision = revision + 1;
      // Older clients may still send only the slot payload. Preserve the
      // user's saved layout when those optional fields are omitted.
      const layout = normalizeHotbarLayoutForPersistence(
        parsed.data.rowCount ?? (row.row_count === null || row.row_count === undefined ? undefined : Number(row.row_count)),
        parsed.data.rowPositions ?? parseJsonValue(row.row_positions)
      );
      const updated = await client.query<HotbarRow>(
        `UPDATE player_hotbar_settings
         SET revision = $2, slots = $3::jsonb, row_count = $4, row_positions = $5::jsonb
         WHERE player_id = $1
         RETURNING revision, slots, row_count, row_positions`,
        [playerId, nextRevision, JSON.stringify(parsed.data.slots), layout.rowCount, JSON.stringify(layout.rowPositions)]
      );
      await client.query("COMMIT");
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw unavailableError();
      return decodeHotbarRow(updatedRow);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof HotbarError) throw error;
      throw unavailableError();
    } finally {
      client.release();
    }
  }
}

function decodeHotbarRow(row: HotbarRow): HotbarSettings {
  const slots = typeof row.slots === "string"
    ? parseJson(row.slots)
    : row.slots;
  const normalizedSlots = decodePersistedHotbarSlots(slots);
  if (!normalizedSlots) throw unavailableError();
  const layout = normalizeHotbarLayoutForPersistence(
    row.row_count === null || row.row_count === undefined ? undefined : Number(row.row_count),
    parseJsonValue(row.row_positions)
  );
  const parsed = hotbarSettingsSchema.safeParse({
    revision: safeRevision(row.revision),
    slots: normalizedSlots,
    ...layout
  });
  if (!parsed.success) throw unavailableError();
  return parsed.data;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function safeRevision(value: number | string): number {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw unavailableError();
  return revision;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw unavailableError();
  }
}

function changedError(): HotbarError {
  return new HotbarError("HOTBAR_CHANGED", "Your hotbar changed elsewhere. Refresh and try again.", 409);
}

function unavailableError(): HotbarError {
  return new HotbarError("HOTBAR_UNAVAILABLE", "Hotbar settings are temporarily unavailable.", 503);
}
