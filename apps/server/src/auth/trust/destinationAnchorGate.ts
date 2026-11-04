import type pg from "pg";

import type { AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import type { DestinationAnchoring } from "./anchoring.js";
import { isSettledNow } from "./settlement.js";
import { isTrustReviewAccount, type TrustReviewConfig } from "./trustReviewAccounts.js";
import { noopTrustSignalSink, type TrustSignalSink } from "./trustService.js";

// Anchored destinations and private unsettled structures
// (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md 3.3, owner decisions
// 2026-10-02 and 2026-10-15). TRUST_ANCHOR_MODE off|shadow|enforce:
// - Travel: another player reaches a city flag, kingdom flag, city or Castle
//   only while its anchor (city founder, kingdom founder) is Settled with a
//   Settled home within TRUST_HOME_DESTINATION_RADIUS_KM. The owner always
//   reaches their own destinations, and an invite/party arrival whose host
//   owns the destination is skipped (the doorway already ran).
// - Personal flags are not anchored (owner decision 2026-10-15): their own
//   access mode (public/normal/private) and enemy marks decide who may jump,
//   whether or not the owner is Settled. The anti-spoof concern is
//   invites/referrals, which the alt doorway gate covers.
// - Ownership: an account that is not Settled cannot open harvest access or
//   found/convert a city, and revocation for cause reverts its public harvest
//   access to private. Personal flag access is never forced private.
// Shadow records a 0-weight signal and changes nothing. Failures fail open.

export const DESTINATION_UNANCHORED_CODE = "DESTINATION_UNANCHORED";
export const DESTINATION_UNANCHORED_MESSAGE = "This destination isn't open to travellers yet.";
export const PRIVATE_UNTIL_SETTLED_CODE = "PRIVATE_UNTIL_SETTLED";
// Numberless copy: thresholds are secret.
export const PRIVATE_UNTIL_SETTLED_MESSAGE =
  "Your flags and buildings stay private until you've settled in. Keep playing from your home area.";

export const ANCHOR_SIGNAL_RULES = {
  travel_unanchored_destination: 0,
  structure_open_unsettled: 0,
  structure_revert_private: 0
} as const;

export type AnchorDestinationRef =
  | Readonly<{ kind: "flag"; id: string }>
  | Readonly<{ kind: "city"; id: string }>;

export type ResolvedAnchorDestination = Readonly<{
  kind: "flag" | "kingdom_seat" | "city";
  id: string;
  // Player and account whose Settled home anchors the destination.
  anchorPlayerId: string;
  anchorAccountId: string | null;
  // Flag owner (may differ from the anchor for city and kingdom flags).
  ownerPlayerId: string;
  anchorDevProfile: boolean;
  lat: number;
  lon: number;
  // False for a personal private flag (access control already admits only the owner).
  openToOthers: boolean;
  // A personal flag: never anchored, its access mode decides.
  personalFlag: boolean;
}>;

export type AnchorPlayerStatus = Readonly<{
  accountId: string | null;
  settledAt: Date | null;
  provisionalUntil: Date | null;
  devProfile: boolean;
}>;

export interface DestinationAnchorStore {
  resolveDestination(ref: AnchorDestinationRef): Promise<ResolvedAnchorDestination | null>;
  loadPlayerStatus(playerId: string): Promise<AnchorPlayerStatus | null>;
  // Enforce: public harvest access -> private. Personal flags keep their access mode.
  revertOpenStructures(accountId: string): Promise<Readonly<{ harvestAssets: number }>>;
  countOpenStructures(accountId: string): Promise<Readonly<{ harvestAssets: number }>>;
}

export type AnchorTravelKind = "flag" | "city" | "invite" | "party_manual" | "party_auto_follow";

export type AnchorTravelInput = Readonly<{
  travellerPlayerId: string;
  kind: string;
  destination: Readonly<{
    kind: string;
    id: string | null;
    personalFlagId?: string | undefined;
    travelAnchor?: Readonly<{ sourceType: string; sourceId: string | null }> | undefined;
  }>;
  companionHostPlayerId?: string | undefined;
}>;

export type AnchorRefusal = Readonly<{ code: string; message: string }>;

export type StructureOpenKind = "harvest_access" | "city_found" | "city_convert";

const TRAVEL_KINDS = new Set<string>(["flag", "city", "invite", "party_manual", "party_auto_follow"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The anchored destination a travel lands on, or null (open world, manor). */
export function anchorDestinationRef(input: AnchorTravelInput): AnchorDestinationRef | null {
  const destination = input.destination;
  if (destination.kind === "city" && destination.id) return { kind: "city", id: destination.id };
  const flagId = destination.personalFlagId
    ?? (destination.kind === "flag" ? destination.id : null)
    ?? ((destination.travelAnchor?.sourceType === "flag" || destination.travelAnchor?.sourceType === "kingdom_seat")
      ? destination.travelAnchor.sourceId
      : null);
  return flagId && UUID_PATTERN.test(flagId) ? { kind: "flag", id: flagId } : null;
}

export class DestinationAnchorGate {
  private readonly sink: TrustSignalSink;
  private readonly logger: Pick<AppLogger, "warn" | "info"> | undefined;
  private readonly now: () => Date;
  private readonly devProfilesExempt: () => boolean;

  constructor(
    private readonly store: DestinationAnchorStore,
    private readonly anchoring: Pick<DestinationAnchoring, "isDestinationAnchored" | "invalidate">,
    private readonly config: Pick<AppConfig, "TRUST_ANCHOR_MODE"> & TrustReviewConfig,
    options: Readonly<{
      sink?: TrustSignalSink;
      logger?: Pick<AppLogger, "warn" | "info">;
      now?: () => Date;
      devProfilesExempt?: () => boolean;
    }> = {}
  ) {
    this.sink = options.sink ?? noopTrustSignalSink;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.devProfilesExempt = options.devProfilesExempt ?? (() => false);
  }

  get mode(): AppConfig["TRUST_ANCHOR_MODE"] {
    return this.config.TRUST_ANCHOR_MODE;
  }

  /** Settled gained or lost: drop the owner's cached anchoring at once. */
  invalidate(accountId: string): void {
    this.anchoring.invalidate(accountId);
  }

  /**
   * Travel to a destination someone else owns. Returns a refusal only in
   * enforce; shadow records travel_unanchored_destination.
   */
  async checkTravel(input: AnchorTravelInput): Promise<AnchorRefusal | null> {
    const mode = this.mode;
    if (mode === "off" || !TRAVEL_KINDS.has(input.kind)) return null;
    const ref = anchorDestinationRef(input);
    if (!ref) return null;
    try {
      const destination = await this.store.resolveDestination(ref);
      if (!destination || destination.personalFlag || !destination.openToOthers) return null;
      const ownPlayers = [destination.anchorPlayerId, destination.ownerPlayerId];
      if (ownPlayers.includes(input.travellerPlayerId)) return null;
      if (input.companionHostPlayerId && ownPlayers.includes(input.companionHostPlayerId)) return null;
      if (!destination.anchorAccountId) return null;
      if (destination.anchorDevProfile && this.devProfilesExempt()) return null;
      const traveller = await this.store.loadPlayerStatus(input.travellerPlayerId);
      if (traveller?.accountId && traveller.accountId === destination.anchorAccountId) return null;
      if (await this.anchoring.isDestinationAnchored(destination.anchorAccountId, destination.lat, destination.lon)) {
        return null;
      }
      if (traveller?.accountId) {
        const day = this.now().toISOString().slice(0, 10);
        this.signal(
          traveller.accountId,
          "travel_unanchored_destination",
          `travel_unanchored_destination:${traveller.accountId}:${destination.kind}:${destination.id}:${day}`,
          {
            destinationKind: destination.kind,
            destinationId: destination.id,
            ownerAccountId: destination.anchorAccountId,
            travelKind: input.kind,
            hostPlayerId: input.companionHostPlayerId ?? null,
            mode
          }
        );
      }
      return mode === "enforce"
        ? { code: DESTINATION_UNANCHORED_CODE, message: DESTINATION_UNANCHORED_MESSAGE }
        : null;
    } catch (error) {
      this.logger?.warn({ err: error, playerId: input.travellerPlayerId }, "Destination anchoring could not be checked");
      return null;
    }
  }

  /**
   * An owner opening a structure to others (public harvest access, founding
   * or converting a city). Refused in enforce while the owner's account is
   * not Settled. Personal flag access is not gated (owner decision 2026-10-15).
   */
  async checkOpenStructure(input: Readonly<{ playerId: string; kind: StructureOpenKind }>): Promise<AnchorRefusal | null> {
    const mode = this.mode;
    if (mode === "off") return null;
    try {
      const owner = await this.store.loadPlayerStatus(input.playerId);
      if (!owner?.accountId || this.settledOrExempt(owner)) return null;
      this.signal(
        owner.accountId,
        "structure_open_unsettled",
        `structure_open_unsettled:${owner.accountId}:${input.kind}:${this.now().toISOString().slice(0, 10)}`,
        { action: input.kind, mode }
      );
      return mode === "enforce"
        ? { code: PRIVATE_UNTIL_SETTLED_CODE, message: PRIVATE_UNTIL_SETTLED_MESSAGE }
        : null;
    } catch (error) {
      this.logger?.warn({ err: error, playerId: input.playerId }, "Private-structure rule could not be checked");
      return null;
    }
  }

  /** Revocation for cause: public harvest access reverts to private (enforce). Flags are untouched. */
  async onRevoked(accountId: string): Promise<void> {
    const mode = this.mode;
    this.anchoring.invalidate(accountId);
    if (mode === "off") return;
    const counts = mode === "enforce"
      ? await this.store.revertOpenStructures(accountId)
      : await this.store.countOpenStructures(accountId);
    if (counts.harvestAssets === 0) return;
    this.signal(
      accountId,
      "structure_revert_private",
      `structure_revert_private:${accountId}:${this.now().toISOString()}`,
      { ...counts, reverted: mode === "enforce", mode }
    );
    this.logger?.info({ accountId, ...counts, mode }, "Settled revoked: public harvest access reverted to private");
  }

  private settledOrExempt(status: AnchorPlayerStatus): boolean {
    if (status.devProfile && this.devProfilesExempt()) return true;
    if (isTrustReviewAccount(this.config, status.accountId)) return true;
    return isSettledNow(status, this.now());
  }

  private signal(
    accountId: string,
    rule: keyof typeof ANCHOR_SIGNAL_RULES,
    dedupeKey: string,
    metadata: Record<string, unknown>
  ): void {
    void this.sink.recordSignals({
      accountId,
      signals: [{ rule, weight: ANCHOR_SIGNAL_RULES[rule], metadata: { ...metadata, dedupeKey } }]
    }).catch((error: unknown) => {
      this.logger?.warn({ err: error, accountId, rule }, "Anchoring trust signal could not be recorded");
    });
  }
}

export type UnanchoredRouteRow = Readonly<{
  destinationKind: string;
  destinationId: string;
  ownerAccountId: string | null;
  attempts: number;
  travellers: number;
  lastAttemptAt: Date;
}>;

const DEV_PROFILE_SQL = (accountColumn: string) => `EXISTS (
  SELECT 1 FROM account_identities i
   WHERE i.account_id = ${accountColumn} AND i.provider_subject LIKE 'ash-atlas-dev:%')`;

export class PostgresDestinationAnchorStore implements DestinationAnchorStore {
  constructor(private readonly pool: pg.Pool) {}

  async resolveDestination(ref: AnchorDestinationRef): Promise<ResolvedAnchorDestination | null> {
    type Row = {
      kind: "flag" | "kingdom_seat" | "city";
      id: string;
      anchor_player_id: string;
      anchor_account_id: string | null;
      owner_player_id: string;
      anchor_dev_profile: boolean;
      lat: number;
      lon: number;
      open_to_others: boolean;
      personal_flag: boolean;
    };
    const map = (row: Row | undefined): ResolvedAnchorDestination | null => row ? {
      kind: row.kind,
      id: row.id,
      anchorPlayerId: row.anchor_player_id,
      anchorAccountId: row.anchor_account_id,
      ownerPlayerId: row.owner_player_id,
      anchorDevProfile: row.anchor_dev_profile,
      lat: Number(row.lat),
      lon: Number(row.lon),
      openToOthers: row.open_to_others,
      personalFlag: row.personal_flag
    } : null;
    if (ref.kind === "city") {
      const city = await this.pool.query<Row>(
        `SELECT 'city' AS kind, c.id::text AS id, c.founder_player_id AS anchor_player_id,
                p.account_id::text AS anchor_account_id, c.founder_player_id AS owner_player_id,
                ${DEV_PROFILE_SQL("p.account_id")} AS anchor_dev_profile,
                c.hall_lat AS lat, c.hall_lon AS lon, true AS open_to_others, false AS personal_flag
           FROM cities c
           LEFT JOIN players p ON p.id = c.founder_player_id
          WHERE c.id = $1::uuid`,
        [ref.id]
      );
      return map(city.rows[0]);
    }
    const flag = await this.pool.query<Row>(
      `SELECT 'flag' AS kind, f.id::text AS id,
              CASE
                WHEN f.control_type IN ('city', 'city_seat') THEN COALESCE(c.founder_player_id, f.owner_id)
                WHEN f.control_type IN ('kingdom', 'kingdom_seat') THEN COALESCE(k.founder_player_id, f.owner_id)
                ELSE f.owner_id
              END AS anchor_player_id,
              f.owner_id AS owner_player_id,
              f.lat, f.lon,
              (f.control_type <> 'personal' OR f.access_mode IN ('public', 'normal')) AS open_to_others,
              (f.control_type = 'personal') AS personal_flag
         FROM flags f
         LEFT JOIN cities c ON c.id = f.city_id
         LEFT JOIN kingdoms k ON k.id = f.kingdom_id
        WHERE f.id = $1::uuid`,
      [ref.id]
    );
    const flagRow = flag.rows[0];
    if (flagRow) {
      const anchor = await this.pool.query<{ account_id: string | null; dev_profile: boolean }>(
        `SELECT p.account_id::text AS account_id, ${DEV_PROFILE_SQL("p.account_id")} AS dev_profile
           FROM players p WHERE p.id = $1`,
        [flagRow.anchor_player_id]
      );
      return map({
        ...flagRow,
        anchor_account_id: anchor.rows[0]?.account_id ?? null,
        anchor_dev_profile: anchor.rows[0]?.dev_profile ?? false
      });
    }
    const seat = await this.pool.query<Row>(
      `SELECT 'kingdom_seat' AS kind, seat.id::text AS id, k.founder_player_id AS anchor_player_id,
              p.account_id::text AS anchor_account_id, k.founder_player_id AS owner_player_id,
              ${DEV_PROFILE_SQL("p.account_id")} AS anchor_dev_profile,
              seat.lat, seat.lon, true AS open_to_others, false AS personal_flag
         FROM kingdom_seats seat
         JOIN kingdoms k ON k.id = seat.kingdom_id
         LEFT JOIN players p ON p.id = k.founder_player_id
        WHERE seat.id = $1::uuid`,
      [ref.id]
    );
    return map(seat.rows[0]);
  }

  async loadPlayerStatus(playerId: string): Promise<AnchorPlayerStatus | null> {
    const result = await this.pool.query<{
      account_id: string | null;
      settled_at: Date | null;
      provisional_until: Date | null;
      dev_profile: boolean;
    }>(
      `SELECT p.account_id::text AS account_id, st.settled_at, st.provisional_until,
              ${DEV_PROFILE_SQL("p.account_id")} AS dev_profile
         FROM players p
         LEFT JOIN account_settlement st ON st.account_id = p.account_id
        WHERE p.id = $1`,
      [playerId]
    );
    const row = result.rows[0];
    return row
      ? { accountId: row.account_id, settledAt: row.settled_at, provisionalUntil: row.provisional_until, devProfile: row.dev_profile }
      : null;
  }

  async revertOpenStructures(accountId: string): Promise<Readonly<{ harvestAssets: number }>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const mines = await client.query(
        `UPDATE repeatable_resource_nodes n
            SET harvest_access_mode = 'private', harvest_access_revision = harvest_access_revision + 1
           FROM players p
          WHERE p.account_id = $1 AND n.owner_player_id = p.id AND n.harvest_access_mode = 'public'`,
        [accountId]
      );
      const wells = await client.query(
        `UPDATE city_structures s
            SET harvest_access_mode = 'private', harvest_access_revision = harvest_access_revision + 1
           FROM players p
          WHERE p.account_id = $1 AND s.owner_player_id = p.id AND s.harvest_access_mode = 'public'`,
        [accountId]
      );
      await client.query("COMMIT");
      return { harvestAssets: (mines.rowCount ?? 0) + (wells.rowCount ?? 0) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async countOpenStructures(accountId: string): Promise<Readonly<{ harvestAssets: number }>> {
    const result = await this.pool.query<{ harvest_assets: string }>(
      `SELECT
         ((SELECT count(*) FROM repeatable_resource_nodes n JOIN players p ON p.id = n.owner_player_id
            WHERE p.account_id = $1 AND n.harvest_access_mode = 'public')
          + (SELECT count(*) FROM city_structures s JOIN players p ON p.id = s.owner_player_id
            WHERE p.account_id = $1 AND s.harvest_access_mode = 'public'))::text AS harvest_assets`,
      [accountId]
    );
    const row = result.rows[0];
    return { harvestAssets: Number(row?.harvest_assets ?? 0) };
  }

  /**
   * Admin report (plan 3.3, A8): routes the anchoring rule refused or would
   * have refused since a time, grouped by destination, most attempted first.
   */
  async unanchoredRoutesReport(since: Date, limit = 100): Promise<UnanchoredRouteRow[]> {
    const result = await this.pool.query<{
      destination_kind: string;
      destination_id: string;
      owner_account_id: string | null;
      attempts: string;
      travellers: string;
      last_attempt_at: Date;
    }>(
      `SELECT metadata->>'destinationKind' AS destination_kind,
              metadata->>'destinationId' AS destination_id,
              max(metadata->>'ownerAccountId') AS owner_account_id,
              count(*)::text AS attempts,
              count(DISTINCT account_id)::text AS travellers,
              max(created_at) AS last_attempt_at
         FROM account_trust_events
        WHERE kind = 'signal' AND rule = 'travel_unanchored_destination' AND created_at >= $1
        GROUP BY 1, 2
        ORDER BY count(*) DESC, max(created_at) DESC
        LIMIT $2`,
      [since, Math.max(1, Math.min(limit, 1000))]
    );
    return result.rows.map((row) => ({
      destinationKind: row.destination_kind,
      destinationId: row.destination_id,
      ownerAccountId: row.owner_account_id,
      attempts: Number(row.attempts),
      travellers: Number(row.travellers),
      lastAttemptAt: row.last_attempt_at
    }));
  }
}
