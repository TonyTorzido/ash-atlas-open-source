import {
  LIBRARY_INTERACTION_RADIUS_M,
  LIBRARY_STUDY_FEE_GOLD,
  libraryOwnerCutGold,
  libraryFoliosForStudy,
  type LibrarySnapshot,
  type LibraryStudyResult,
  type LibraryUnavailableReason
} from "@ash-atlas/shared";
import type pg from "pg";

import { WalletOperationError, type WalletService } from "./wallet.js";

export class LibraryStudyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LibraryStudyError";
  }
}

type Position = Readonly<{ lat: number; lon: number }>;

export type LibraryStudyOutcome = Readonly<{
  library: LibrarySnapshot;
  result: LibraryStudyResult;
  walletGold: string;
  walletVersion: string;
}>;

type LibraryRow = {
  structure_id: string;
  owner_player_id: string;
  owner_username: string | null;
  distance_m: string;
};

/** UTC calendar day; the once-per-day limit resets at 00:00 UTC. */
export function libraryStudyDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Library study. One transaction holds the student's lock, the (player,
 * owner) and (player, day) gates, the Gold debit, the owner's Gold credit and
 * the Folios counter, so a retried or concurrent request can only apply once.
 * A repeated request id replays the stored result (and the wallet operations
 * themselves are keyed by the same operation key).
 */
export class LibraryStudyService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly wallet: WalletService,
    private readonly now: () => Date = () => new Date()
  ) {}

  async open(playerId: string, structureId: string, position: Position): Promise<LibrarySnapshot> {
    const client = await this.pool.connect();
    try {
      const library = await lockActiveLibrary(client, structureId, position, false);
      return await this.snapshot(client, playerId, library);
    } finally {
      client.release();
    }
  }

  async study(
    playerId: string,
    structureId: string,
    position: Position,
    requestId: string
  ): Promise<LibraryStudyOutcome> {
    const operationKey = `library-study:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`library-study-player:${playerId}`]);
      const account = await client.query<{ account_id: string }>("SELECT account_id FROM players WHERE id=$1", [playerId]);
      const accountId = account.rows[0]?.account_id;
      if (!accountId) throw new LibraryStudyError("LIBRARY_PLAYER_MISSING", "Player not found.");

      const replay = await client.query<{ structure_id: string; folios_gained: number; fee_gold: string }>(
        `SELECT structure_id::text,folios_gained,fee_gold::text FROM library_studies
         WHERE operation_key=$1 AND player_id=$2`,
        [operationKey, playerId]
      );
      if (replay.rows[0]) {
        if (replay.rows[0].structure_id !== structureId) {
          throw new LibraryStudyError("LIBRARY_REQUEST_CONFLICT", "That request id was already used for another Library.");
        }
        const wallet = await this.wallet.snapshotInTransaction(client, playerId, accountId);
        const library = await this.snapshotAtStructure(client, playerId, structureId);
        await client.query("COMMIT");
        return {
          library,
          result: { foliosGained: replay.rows[0].folios_gained, feeGold: replay.rows[0].fee_gold, replayed: true },
          walletGold: wallet.gold,
          walletVersion: wallet.revision
        };
      }

      const row = await lockActiveLibrary(client, structureId, position, true);
      const day = libraryStudyDay(this.now());
      const state = await this.studyState(client, playerId, row.owner_player_id, day, true);
      if (state.studiedHere) {
        throw new LibraryStudyError("LIBRARY_ALREADY_STUDIED", "You have already studied at this Library.");
      }
      if (state.studiedToday) {
        throw new LibraryStudyError("LIBRARY_STUDIED_TODAY", "You have already studied today. Come back tomorrow.");
      }
      const fee = BigInt(LIBRARY_STUDY_FEE_GOLD);
      const ownerCut = row.owner_player_id === playerId ? 0n : libraryOwnerCutGold(fee);
      const folios = libraryFoliosForStudy(state.studyCount);

      for (const id of new Set([playerId, row.owner_player_id].sort())) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`library-study-wallet:${id}`]);
      }
      let debit;
      try {
        debit = await this.wallet.debitForOperationInTransaction(client, {
          playerId,
          accountId,
          amount: fee,
          operationKey: `library-study-debit:${operationKey}`,
          reason: "library_study_fee",
          metadata: { structureId, ownerPlayerId: row.owner_player_id }
        });
      } catch (error) {
        if (error instanceof WalletOperationError && error.code === "WALLET_INSUFFICIENT_FUNDS") {
          throw new LibraryStudyError("INSUFFICIENT_GOLD", `Studying here costs ${fee} Gold.`);
        }
        throw error;
      }
      if (ownerCut > 0n) {
        const ownerAccount = await client.query<{ account_id: string }>("SELECT account_id FROM players WHERE id=$1", [row.owner_player_id]);
        const ownerAccountId = ownerAccount.rows[0]?.account_id;
        if (!ownerAccountId) throw new LibraryStudyError("LIBRARY_OWNER_MISSING", "The Library owner is unavailable.");
        await this.wallet.creditForOperationInTransaction(client, {
          playerId: row.owner_player_id,
          accountId: ownerAccountId,
          amount: ownerCut,
          operationKey: `library-study-credit:${operationKey}`,
          reason: "library_study_owner_cut",
          metadata: { structureId, studentPlayerId: playerId }
        });
      }
      const study = await client.query<{ study_id: string; studied_at: Date }>(
        `INSERT INTO library_studies (
           operation_key,player_id,structure_id,owner_player_id,study_day,folios_gained,fee_gold,owner_gold
         ) VALUES ($1,$2,$3::uuid,$4,$5::date,$6,$7,$8)
         RETURNING study_id::text,studied_at`,
        [operationKey, playerId, structureId, row.owner_player_id, day, folios, fee.toString(), ownerCut.toString()]
      );
      await client.query(
        `INSERT INTO player_library_folios (player_id,folios,study_count)
         VALUES ($1,$2,1)
         ON CONFLICT (player_id) DO UPDATE
           SET folios=player_library_folios.folios+EXCLUDED.folios,
               study_count=player_library_folios.study_count+1,
               updated_at=clock_timestamp()`,
        [playerId, folios]
      );
      await client.query(
        `INSERT INTO weekly_leaderboard_events (
           source_type,source_id,player_id,category,value,occurred_at,week_start
         ) VALUES ('library_study',$1,$2,'folios_studied',$3,$4,weekly_leaderboard_week_start($4))
         ON CONFLICT DO NOTHING`,
        [study.rows[0]!.study_id, playerId, folios, study.rows[0]!.studied_at]
      );
      const library = await this.snapshotAtStructure(client, playerId, structureId);
      await client.query("COMMIT");
      return {
        library,
        result: { foliosGained: folios, feeGold: fee.toString(), replayed: false },
        walletGold: debit.goldBalance.toString(),
        walletVersion: debit.version.toString()
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Lifetime Folios for the profile. */
  async foliosForPlayer(playerId: string): Promise<{ folios: number; studyCount: number }> {
    const result = await this.pool.query<{ folios: string; study_count: number }>(
      "SELECT folios::text,study_count FROM player_library_folios WHERE player_id=$1",
      [playerId]
    );
    return { folios: Number(result.rows[0]?.folios ?? 0), studyCount: result.rows[0]?.study_count ?? 0 };
  }

  private async studyState(
    client: pg.PoolClient,
    playerId: string,
    ownerPlayerId: string,
    day: string,
    lock: boolean
  ): Promise<{ studiedHere: boolean; studiedToday: boolean; studyCount: number; totalFolios: number }> {
    const stats = await client.query<{ folios: string; study_count: number }>(
      `SELECT folios::text,study_count FROM player_library_folios WHERE player_id=$1${lock ? " FOR UPDATE" : ""}`,
      [playerId]
    );
    const gates = await client.query<{ studied_here: boolean; studied_today: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM library_studies WHERE player_id=$1 AND owner_player_id=$2) AS studied_here,
              EXISTS (SELECT 1 FROM library_studies WHERE player_id=$1 AND study_day=$3::date) AS studied_today`,
      [playerId, ownerPlayerId, day]
    );
    return {
      studiedHere: gates.rows[0]!.studied_here,
      studiedToday: gates.rows[0]!.studied_today,
      studyCount: stats.rows[0]?.study_count ?? 0,
      totalFolios: Number(stats.rows[0]?.folios ?? 0)
    };
  }

  private async snapshotAtStructure(client: pg.PoolClient, playerId: string, structureId: string): Promise<LibrarySnapshot> {
    const row = await client.query<LibraryRow>(
      `SELECT structure_id::text,owner_player_id,
              (SELECT username FROM players WHERE id=city_structures.owner_player_id) AS owner_username,
              '0' AS distance_m
       FROM city_structures WHERE structure_id=$1::uuid AND structure_type='library'`,
      [structureId]
    );
    if (!row.rows[0]) throw new LibraryStudyError("LIBRARY_NOT_FOUND", "That Library is no longer standing.");
    return this.snapshot(client, playerId, row.rows[0]);
  }

  private async snapshot(client: pg.PoolClient, playerId: string, library: LibraryRow): Promise<LibrarySnapshot> {
    const now = this.now();
    const day = libraryStudyDay(now);
    const state = await this.studyState(client, playerId, library.owner_player_id, day, false);
    const isOwner = library.owner_player_id === playerId;
    const fee = BigInt(LIBRARY_STUDY_FEE_GOLD);
    const account = await client.query<{ account_id: string }>("SELECT account_id FROM players WHERE id=$1", [playerId]);
    const gold = account.rows[0]
      ? BigInt((await this.wallet.snapshotInTransaction(client, playerId, account.rows[0].account_id)).gold)
      : 0n;
    const reason: LibraryUnavailableReason | null = state.studiedHere
      ? "studied_here"
      : state.studiedToday
        ? "studied_today"
        : gold < fee
          ? "insufficient_gold"
          : null;
    return {
      structureId: library.structure_id,
      ownerPlayerId: library.owner_player_id,
      ownerUsername: library.owner_username,
      isOwner,
      feeGold: fee.toString(),
      ownerCutGold: (isOwner ? 0n : libraryOwnerCutGold(fee)).toString(),
      foliosPerStudy: libraryFoliosForStudy(state.studyCount),
      studyCount: state.studyCount,
      totalFolios: state.totalFolios,
      canStudy: reason === null,
      unavailableReason: reason,
      day,
      serverTime: now.getTime()
    };
  }
}

async function lockActiveLibrary(
  client: pg.PoolClient,
  structureId: string,
  position: Position,
  lock: boolean
): Promise<LibraryRow> {
  const result = await client.query<LibraryRow>(
    `SELECT structure_id::text,owner_player_id,
            (SELECT username FROM players WHERE id=city_structures.owner_player_id) AS owner_username,
            ST_Distance(geom::geography,ST_SetSRID(ST_MakePoint($2,$3),4326)::geography)::text AS distance_m
     FROM city_structures
     WHERE structure_id=$1::uuid AND structure_type='library' AND state='active'${lock ? " FOR SHARE" : ""}`,
    [structureId, position.lon, position.lat]
  );
  const row = result.rows[0];
  if (!row) throw new LibraryStudyError("LIBRARY_NOT_FOUND", "That Library is no longer standing.");
  if (Number(row.distance_m) > LIBRARY_INTERACTION_RADIUS_M) {
    throw new LibraryStudyError(
      "LIBRARY_PROXIMITY_REQUIRED",
      `Stand within ${LIBRARY_INTERACTION_RADIUS_M} meters of the Library.`
    );
  }
  return row;
}
