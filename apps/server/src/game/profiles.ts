import type {
  PlayerAppearanceSnapshot,
  PlayerBodyVariantId,
  ProfileAffiliation,
  PlayerPresenceState,
  ProfileTextUpdate,
  ProfileTitle,
  PublicProfile,
  SocialAction,
  SocialInboxResponse,
  SocialListEntry,
  SocialListKind,
  SocialListResponse,
  SpecializationId,
  ViewerRelationship
} from "@ash-atlas/shared";
import {
  isSpecializationAvailable,
  LEGEND_CATALOG,
  SPECIALIZATION_DEFINITIONS,
  legendPrestige,
  normalizePlayerBodyVariantId,
  PROFILE_BIOGRAPHY_MAX_CHARACTERS,
  PROFILE_TITLES,
  WEEKLY_LEADERBOARD_CATEGORY_DEFINITIONS
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppLogger } from "../logger.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;
export const NEUTRALITY_REQUEST_TTL_MS = 5 * 60_000;

export type ExpiredNeutralityRequest = Readonly<{
  playerLowId: string;
  playerHighId: string;
  requesterId: string;
}>;

type ProfileRow = {
  player_id: string;
  username: string;
  display_color: string | null;
  body_variant_id: string;
  level: number;
  folios: string;
  title: string | null;
  biography: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  player_created_at: Date | string;
  last_seen_at: Date | string | null;
  active_specialization_id: string | null;
};

export type ProfileAffiliations = {
  class: ProfileAffiliation | null;
  kingdom: ProfileAffiliation | null;
  settlement: ProfileAffiliation | null;
};

export interface ProfileAffiliationsResolver {
  resolve(playerId: string): Promise<ProfileAffiliations>;
}

export class EmptyProfileAffiliationsResolver implements ProfileAffiliationsResolver {
  async resolve(): Promise<ProfileAffiliations> {
    return { class: null, kingdom: null, settlement: null };
  }
}

export class ProfileSocialError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "ProfileSocialError";
  }
}

export type ProfileSocialServiceOptions = {
  isPlayerOnline?(playerId: string): boolean;
  playerPresence?(playerId: string): Exclude<PlayerPresenceState, "hidden">;
  playerAppearance?(
    playerId: string,
    bodyVariantId: PlayerBodyVariantId
  ): Promise<PlayerAppearanceSnapshot | null>;
  affiliations?: ProfileAffiliationsResolver;
  logger?: AppLogger;
};

export class ProfileSocialService {
  private readonly playerPresence: (playerId: string) => Exclude<PlayerPresenceState, "hidden">;
  private readonly affiliations: ProfileAffiliationsResolver;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: ProfileSocialServiceOptions = {}
  ) {
    this.playerPresence = options.playerPresence ??
      ((playerId) => options.isPlayerOnline?.(playerId) ? "online" : "offline");
    this.affiliations = options.affiliations ?? new EmptyProfileAffiliationsResolver();
  }

  async getProfile(viewerId: string, targetId: string): Promise<PublicProfile> {
    return this.profileFrom(this.pool, viewerId, targetId, true);
  }

  async updateProfile(viewerId: string, input: ProfileTextUpdate): Promise<PublicProfile> {
    const title = input.title === undefined ? undefined : normalizeProfileTitle(input.title);
    const biography = input.biography === undefined
      ? undefined
      : normalizeProfileBiography(input.biography);
    await this.pool.query(
      `INSERT INTO player_profiles (player_id)
       VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
      [viewerId]
    );
    await this.pool.query(
      `UPDATE player_profiles
       SET title = CASE WHEN $2::boolean THEN $3::text ELSE title END,
           biography = CASE WHEN $4::boolean THEN $5::text ELSE biography END
       WHERE player_id = $1`,
      [viewerId, title !== undefined, title ?? null, biography !== undefined, biography ?? null]
    );
    this.options.logger?.info(
      {
        actorPlayerId: viewerId,
        changedFields: [
          ...(title !== undefined ? ["title"] : []),
          ...(biography !== undefined ? ["biography"] : [])
        ]
      },
      "player profile edited"
    );
    return this.getProfile(viewerId, viewerId);
  }

  async mutate(
    viewerId: string,
    targetId: string,
    action: SocialAction,
    onCommitted?: (changed: boolean) => void
  ): Promise<PublicProfile> {
    assertDifferentPlayers(viewerId, targetId);
    const client = await this.pool.connect();
    let profile: PublicProfile;
    let changed = false;
    try {
      await client.query("BEGIN");
      await lockPlayerPair(client, viewerId, targetId);
      await assertPlayerExists(client, targetId);
      changed = await this.applyMutation(client, viewerId, targetId, action);
      profile = await this.profileFrom(client, viewerId, targetId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
    onCommitted?.(changed);
    this.options.logger?.info(
      { actorPlayerId: viewerId, targetPlayerId: targetId, action, changed },
      "social relationship mutation"
    );
    return profile;
  }

  async list(
    viewerId: string,
    kind: SocialListKind,
    offset: number,
    limit: number
  ): Promise<SocialListResponse> {
    const rows = await this.pool.query<{ target_id: string }>(
      listTargetSql(kind),
      [viewerId, limit + 1, offset]
    );
    const hasMore = rows.rows.length > limit;
    const targetIds = rows.rows.slice(0, limit).map((row) => row.target_id);
    const profiles = await Promise.all(targetIds.map((targetId) =>
      this.profileFrom(this.pool, viewerId, targetId, false)
    ));
    return {
      kind,
      entries: profiles.map(profileToListEntry),
      offset,
      limit,
      hasMore
    };
  }

  /**
   * Another player's Friends or Enemies, as seen from their profile. Denied
   * when either side has blocked the other; listed players the viewer is
   * blocked with are left out. Presence follows the usual viewer rule.
   */
  async listForPlayer(
    viewerId: string,
    targetId: string,
    kind: Extract<SocialListKind, "friends" | "enemies">,
    offset: number,
    limit: number
  ): Promise<SocialListResponse> {
    if (viewerId === targetId) return this.list(viewerId, kind, offset, limit);
    await assertPlayerExists(this.pool, targetId);
    if (!await this.canDirectlyInteract(viewerId, targetId)) {
      throw new ProfileSocialError("RELATIONSHIP_UNAVAILABLE", "This player's lists are unavailable", 403);
    }
    const rows = await this.pool.query<{ target_id: string }>(
      listTargetSql(kind),
      [targetId, limit + 1, offset]
    );
    const hasMore = rows.rows.length > limit;
    const candidates = rows.rows.slice(0, limit).map((row) => row.target_id);
    const visible = await this.filterDirectlyInteractable(viewerId, candidates);
    const profiles = await Promise.all(visible.map((candidateId) =>
      this.profileFrom(this.pool, viewerId, candidateId, false)
    ));
    return {
      kind,
      entries: profiles.map(profileToListEntry),
      offset,
      limit,
      hasMore
    };
  }

  async inbox(playerId: string): Promise<SocialInboxResponse> {
    const [entries, pending] = await Promise.all([
      this.pool.query<{
        id: string;
        entry_kind: "friend_request" | "enemy_declaration";
        actor_player_id: string;
        actor_display_name: string;
        status: "pending" | "accepted" | "declined" | "cancelled" | "notice";
        created_at: Date | string;
        updated_at: Date | string;
      }>(
        `SELECT entry.id, entry.entry_kind, entry.actor_player_id,
                actor.username AS actor_display_name, entry.status,
                entry.created_at, entry.updated_at
         FROM player_inbox_entries entry
         JOIN players actor ON actor.id = entry.actor_player_id
         WHERE entry.player_id = $1
           AND entry.entry_kind IN ('friend_request', 'enemy_declaration')
         ORDER BY entry.created_at DESC, entry.id DESC
         LIMIT 200`,
        [playerId]
      ),
      this.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM friend_requests WHERE recipient_id = $1",
        [playerId]
      )
    ]);
    return {
      entries: entries.rows.map((row) => ({
        id: row.id,
        kind: row.entry_kind,
        actorPlayerId: row.actor_player_id,
        actorDisplayName: row.actor_display_name,
        state: row.status,
        createdAt: asIso(row.created_at),
        updatedAt: asIso(row.updated_at)
      })),
      pendingIncomingFriendRequestCount: Number(pending.rows[0]?.count ?? 0)
    };
  }

  async canDirectlyInteract(actorId: string, targetId: string): Promise<boolean> {
    if (actorId === targetId) return true;
    const result = await this.pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM player_blocks
         WHERE (blocker_id = $1 AND blocked_id = $2)
            OR (blocker_id = $2 AND blocked_id = $1)
       ) AS blocked`,
      [actorId, targetId]
    );
    return !result.rows[0]?.blocked;
  }

  async filterDirectlyInteractable(
    actorId: string,
    candidatePlayerIds: readonly string[]
  ): Promise<string[]> {
    const candidates = [...new Set(candidatePlayerIds.filter((candidate) => candidate.length > 0))];
    const otherCandidates = candidates.filter((candidate) => candidate !== actorId);
    if (otherCandidates.length === 0) return candidates;
    const result = await this.pool.query<{ blocker_id: string; blocked_id: string }>(
      `SELECT blocker_id, blocked_id
       FROM player_blocks
       WHERE (blocker_id = $1 AND blocked_id = ANY($2::text[]))
          OR (blocked_id = $1 AND blocker_id = ANY($2::text[]))`,
      [actorId, otherCandidates]
    );
    const unavailable = new Set(result.rows.map((row) =>
      row.blocker_id === actorId ? row.blocked_id : row.blocker_id
    ));
    return candidates.filter((candidate) => candidate === actorId || !unavailable.has(candidate));
  }

  async expireNeutralityRequests(): Promise<ExpiredNeutralityRequest[]> {
    const result = await this.pool.query<{
      player_low_id: string;
      player_high_id: string;
      requester_id: string;
    }>(
      `DELETE FROM enemy_neutrality_requests
       WHERE expires_at <= now()
       RETURNING player_low_id, player_high_id, requester_id`
    );
    return result.rows.map((row) => ({
      playerLowId: row.player_low_id,
      playerHighId: row.player_high_id,
      requesterId: row.requester_id
    }));
  }

  private async applyMutation(
    client: pg.PoolClient,
    viewerId: string,
    targetId: string,
    action: SocialAction
  ): Promise<boolean> {
    if (action === "send_friend_request" || action === "accept_friend_request") {
      await assertPairAvailable(client, viewerId, targetId);
    }
    switch (action) {
      case "send_friend_request":
        return sendFriendRequest(client, viewerId, targetId);
      case "accept_friend_request":
        return acceptFriendRequest(client, viewerId, targetId);
      case "decline_friend_request":
        return deleteDirectionalRequest(client, targetId, viewerId, "declined");
      case "cancel_friend_request":
        return deleteDirectionalRequest(client, viewerId, targetId, "cancelled");
      case "remove_friend":
        return deleteFriendship(client, viewerId, targetId);
      case "mark_enemy":
        await assertPairAvailable(client, viewerId, targetId, false);
        return markEnemy(client, viewerId, targetId);
      case "request_neutrality":
        await assertPairAvailable(client, viewerId, targetId, false);
        return requestNeutrality(client, viewerId, targetId);
      case "accept_neutrality":
        return acceptNeutrality(client, viewerId, targetId);
      case "reject_neutrality":
        return resolveNeutralityRequest(client, viewerId, targetId, false);
      case "cancel_neutrality":
        return cancelNeutralityRequest(client, viewerId, targetId);
      case "block":
        return blockPlayer(client, viewerId, targetId);
      case "unblock":
        return rowChanged(await client.query(
          "DELETE FROM player_blocks WHERE blocker_id = $1 AND blocked_id = $2",
          [viewerId, targetId]
        ));
    }
  }

  /** `detailed` adds appearance and the stat sections; list rows skip them. */
  private async profileFrom(
    queryable: Queryable,
    viewerId: string,
    targetId: string,
    detailed = true
  ): Promise<PublicProfile> {
    const result = await queryable.query<ProfileRow>(
      `SELECT p.id AS player_id, p.username, p.display_color, p.body_variant_id,
              COALESCE(progress.level, 0)::integer AS level,
              COALESCE(library.folios, 0)::text AS folios,
              profile.title, profile.biography,
              p.created_at AS created_at,
              COALESCE(profile.updated_at, p.updated_at) AS updated_at,
              p.created_at AS player_created_at, p.last_seen_at,
              specialization.active_specialization_id
       FROM players p
       LEFT JOIN player_profiles profile ON profile.player_id = p.id
       LEFT JOIN player_progression_profiles progress ON progress.player_id = p.id
       LEFT JOIN player_specialization_state specialization ON specialization.player_id = p.id
       LEFT JOIN player_library_folios library ON library.player_id = p.id
       WHERE p.id = $1`,
      [targetId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new ProfileSocialError("PLAYER_NOT_FOUND", "Player not found", 404);
    }
    const bodyVariantId = normalizePlayerBodyVariantId(row.body_variant_id);
    const [relationship, affiliations, appearance, details] = await Promise.all([
      relationshipFor(queryable, viewerId, targetId),
      this.affiliations.resolve(targetId),
      detailed && this.options.playerAppearance
        ? this.options.playerAppearance(targetId, bodyVariantId)
        : null,
      detailed ? profileDetails(queryable, targetId) : null
    ]);
    const presenceVisible = viewerId === targetId || relationship.friendship === "friends";
    return {
      playerId: row.player_id,
      displayName: row.username,
      level: row.level,
      folios: Number(row.folios),
      portrait: {
        kind: "player_sprite",
        displayColor: row.display_color,
        bodyVariantId
      },
      ...(appearance ? { appearance } : {}),
      title: storedProfileTitle(row.title),
      biography: row.biography,
      presence: presenceVisible ? this.playerPresence(targetId) : "hidden",
      class: classAffiliation(row.active_specialization_id),
      kingdom: affiliations.kingdom,
      settlement: affiliations.settlement,
      createdAt: asIso(row.created_at),
      updatedAt: asIso(row.updated_at),
      isSelf: viewerId === targetId,
      relationship,
      ...(detailed
        ? {
            playingSince: asIso(row.player_created_at),
            ...(presenceVisible
              ? { lastSeenAt: row.last_seen_at === null ? null : asIso(row.last_seen_at) }
              : {})
          }
        : {}),
      ...(details ?? {})
    };
  }
}

type ProfileDetails = Pick<
  PublicProfile,
  "legendRank" | "stats" | "weeklyPlacements" | "recentAchievements" | "pet"
>;

const LEGEND_TITLES = new Map(LEGEND_CATALOG.map((entry) => [entry.id, entry.title]));
const LEGEND_IDS = [...LEGEND_TITLES.keys()];
const WEEKLY_LABELS = new Map<string, string>(
  WEEKLY_LEADERBOARD_CATEGORY_DEFINITIONS.map(({ key, label }) => [key, label])
);

/** Profile stat sections, read in three queries with no new caching. */
async function profileDetails(queryable: Queryable, playerId: string): Promise<ProfileDetails> {
  const [statsResult, achievementsResult, weeklyResult] = await Promise.all([
    queryable.query<{
      gold: string;
      flags: string;
      oil_wells: string;
      city_coins: string;
      creatures_hunted: string;
      kills: string | null;
      deaths: string | null;
      pvp_kills: string | null;
      pet_species: string | null;
      pet_name: string | null;
      pet_level: number | null;
    }>(
      `SELECT
         (SELECT COALESCE(sum(gold_balance), 0) FROM player_wallets WHERE player_id = p.id)::text AS gold,
         (SELECT count(*) FROM flags WHERE owner_id = p.id)::text AS flags,
         (SELECT count(*) FROM city_structures
          WHERE owner_player_id = p.id AND structure_type = 'oil_well' AND destroyed_at IS NULL)::text AS oil_wells,
         (SELECT COALESCE(sum(lifetime_contributed), 0) FROM city_coin_contributions
          WHERE player_id = p.id)::text AS city_coins,
         (SELECT count(*) FROM creature_book_kill_occurrences WHERE player_id = p.id)::text AS creatures_hunted,
         record.kills::text, record.deaths::text, record.pvp_kills::text,
         pet.species AS pet_species, pet.name AS pet_name, pet.level::integer AS pet_level
       FROM players p
       LEFT JOIN player_combat_records record ON record.player_id = p.id
       LEFT JOIN LATERAL (
         SELECT species, name, level FROM account_pet_whistles
         WHERE account_id = p.account_id
         ORDER BY (active_until IS NOT NULL) DESC, level DESC, created_at ASC
         LIMIT 1
       ) pet ON true
       WHERE p.id = $1`,
      [playerId]
    ),
    queryable.query<{ achievement_id: string; unlocked_at: Date | string }>(
      `SELECT achievement_id, unlocked_at FROM player_achievements
       WHERE player_id = $1 AND achievement_id = ANY($2::text[])
       ORDER BY unlocked_at DESC, achievement_id`,
      [playerId, LEGEND_IDS]
    ),
    // Rank = 1 + players ahead of this one, using the leaderboard's ordering
    // (value desc, reached_at asc, player_id asc) and active accounts only.
    queryable.query<{ is_current: boolean; category: string; rank: string }>(
      `WITH week AS (SELECT weekly_leaderboard_week_start(now()) AS current_start)
       SELECT own.week_start = week.current_start AS is_current, own.category,
              (1 + (
                SELECT count(*) FROM weekly_leaderboard_totals other
                JOIN players player ON player.id = other.player_id
                LEFT JOIN accounts account ON account.id = player.account_id
                WHERE other.week_start = own.week_start AND other.category = own.category
                  AND (player.account_id IS NULL OR account.status = 'active')
                  AND (other.value > own.value
                    OR (other.value = own.value AND (other.reached_at < own.reached_at
                      OR (other.reached_at = own.reached_at AND other.player_id < own.player_id))))
              ))::text AS rank
       FROM weekly_leaderboard_totals own, week
       WHERE own.player_id = $1 AND own.value > 0
         AND own.week_start IN (week.current_start, week.current_start - 7)`,
      [playerId]
    )
  ]);
  const stats = statsResult.rows[0];
  const achievements = achievementsResult.rows;
  const completed = Object.fromEntries(achievements.map((row) => [row.achievement_id, asIso(row.unlocked_at)]));
  const weeklyPlacements = weeklyResult.rows
    .map((row) => ({
      week: row.is_current ? "current" as const : "previous" as const,
      category: row.category,
      label: WEEKLY_LABELS.get(row.category) ?? row.category,
      rank: Number(row.rank)
    }))
    .filter((placement) => placement.rank <= 100)
    .sort((left, right) =>
      (left.week === right.week ? 0 : left.week === "current" ? -1 : 1) || left.rank - right.rank
    );
  return {
    legendRank: legendPrestige(LEGEND_CATALOG, completed).rank.title,
    stats: {
      gold: Number(stats?.gold ?? 0),
      flags: Number(stats?.flags ?? 0),
      oilWells: Number(stats?.oil_wells ?? 0),
      achievements: achievements.length,
      creaturesHunted: Number(stats?.creatures_hunted ?? 0),
      cityCoinsGiven: Number(stats?.city_coins ?? 0),
      kills: Number(stats?.kills ?? 0),
      deaths: Number(stats?.deaths ?? 0),
      pvpKills: Number(stats?.pvp_kills ?? 0)
    },
    weeklyPlacements,
    recentAchievements: achievements.slice(0, 3).map((row) => ({
      id: row.achievement_id,
      name: LEGEND_TITLES.get(row.achievement_id) ?? row.achievement_id,
      unlockedAt: asIso(row.unlocked_at)
    })),
    pet: stats?.pet_species && stats.pet_name
      ? { species: stats.pet_species, name: stats.pet_name, level: stats.pet_level ?? 0 }
      : null
  };
}

/**
 * The player's active class (Ronin, Warrior), or null for no class. A stored class that is hidden on this server
 * (Ninja and the other old classes) reads as no class, the same as the skill snapshot and PlayerSnapshot.classId.
 */
function classAffiliation(classId: string | null): ProfileAffiliation | null {
  if (classId === null || !(classId in SPECIALIZATION_DEFINITIONS)) return null;
  const id = classId as SpecializationId;
  if (!isSpecializationAvailable(id)) return null;
  return {
    id,
    name: SPECIALIZATION_DEFINITIONS[id].displayName,
    iconKey: id,
    emblemKey: null,
    tier: null,
    memberRole: null
  };
}

export function normalizeProfileTitle(value: string | null): ProfileTitle | null {
  if (value === null) return null;
  if ((PROFILE_TITLES as readonly string[]).includes(value)) return value as ProfileTitle;
  throw new ProfileSocialError("PROFILE_TITLE_INVALID", "Select an unlocked profile title.", 400);
}

function storedProfileTitle(value: string | null): ProfileTitle | null {
  return value !== null && (PROFILE_TITLES as readonly string[]).includes(value)
    ? value as ProfileTitle
    : null;
}

export function normalizeProfileBiography(value: string | null): string | null {
  if (value === null) return null;
  rejectUnsupportedControlCharacters(value, true);
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/ {2,}/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length === 0) return null;
  assertUnicodeLength(normalized, PROFILE_BIOGRAPHY_MAX_CHARACTERS, "Profile biography");
  return normalized;
}

export function canonicalPlayerPair(left: string, right: string): [string, string] {
  if (left === right) throw new ProfileSocialError("SELF_TARGET_NOT_ALLOWED", "Cannot target yourself", 400);
  return left < right ? [left, right] : [right, left];
}

async function relationshipFor(
  queryable: Queryable,
  viewerId: string,
  targetId: string
): Promise<ViewerRelationship> {
  if (viewerId === targetId) return { friendship: "none", enemyMarkedByViewer: false };
  const result = await queryable.query<{
    viewer_blocked: boolean;
    target_blocked: boolean;
    friends: boolean;
    outgoing: boolean;
    incoming: boolean;
    enemy: boolean;
    neutrality_requester_id: string | null;
  }>(
    `SELECT
       EXISTS (SELECT 1 FROM player_blocks WHERE blocker_id = $1 AND blocked_id = $2) AS viewer_blocked,
       EXISTS (SELECT 1 FROM player_blocks WHERE blocker_id = $2 AND blocked_id = $1) AS target_blocked,
       EXISTS (SELECT 1 FROM friendships
               WHERE player_low_id = LEAST($1, $2) AND player_high_id = GREATEST($1, $2)) AS friends,
       EXISTS (SELECT 1 FROM friend_requests WHERE requester_id = $1 AND recipient_id = $2) AS outgoing,
       EXISTS (SELECT 1 FROM friend_requests WHERE requester_id = $2 AND recipient_id = $1) AS incoming,
       EXISTS (SELECT 1 FROM player_enemy_marks
               WHERE owner_id = LEAST($1, $2) AND target_id = GREATEST($1, $2)) AS enemy,
       (SELECT requester_id FROM enemy_neutrality_requests
        WHERE player_low_id = LEAST($1, $2) AND player_high_id = GREATEST($1, $2)
          AND expires_at > now()) AS neutrality_requester_id`,
    [viewerId, targetId]
  );
  const row = result.rows[0];
  if (!row) return { friendship: "none", enemyMarkedByViewer: false };
  const friendship = row.viewer_blocked
    ? "blocked_by_viewer"
    : row.target_blocked
      ? "unavailable"
      : row.friends
        ? "friends"
        : row.outgoing
          ? "outgoing_request"
          : row.incoming
            ? "incoming_request"
            : "none";
  const neutralityRequest = row.neutrality_requester_id === viewerId
    ? "outgoing"
    : row.neutrality_requester_id === targetId
      ? "incoming"
      : "none";
  return { friendship, enemyMarkedByViewer: row.enemy, neutralityRequest };
}

export async function lockPlayerPair(client: Queryable, left: string, right: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended(LEAST($1, $2) || chr(31) || GREATEST($1, $2), 0)
     )`,
    [left, right]
  );
}

async function assertPlayerExists(client: Queryable, playerId: string): Promise<void> {
  const result = await client.query("SELECT id FROM players WHERE id = $1", [playerId]);
  if (result.rowCount === 0) throw new ProfileSocialError("PLAYER_NOT_FOUND", "Player not found", 404);
}

async function assertPairAvailable(
  client: Queryable,
  viewerId: string,
  targetId: string,
  checkEnemies = true
): Promise<void> {
  const result = await client.query<{ blocked: boolean; enemies: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM player_blocks
               WHERE (blocker_id = $1 AND blocked_id = $2)
                  OR (blocker_id = $2 AND blocked_id = $1)) AS blocked,
       EXISTS (SELECT 1 FROM player_enemy_marks
               WHERE ((owner_id = $1 AND target_id = $2) OR (owner_id = $2 AND target_id = $1))) AS enemies`,
    [viewerId, targetId]
  );
  if (result.rows[0]?.blocked || (checkEnemies && result.rows[0]?.enemies)) {
    throw new ProfileSocialError("RELATIONSHIP_UNAVAILABLE", "This relationship action is unavailable", 409);
  }
}

async function sendFriendRequest(
  client: pg.PoolClient,
  viewerId: string,
  targetId: string
): Promise<boolean> {
  const friends = await friendshipExists(client, viewerId, targetId);
  if (friends) return false;
  const reverse = await client.query(
    `SELECT requester_id FROM friend_requests
     WHERE requester_id = $2 AND recipient_id = $1 FOR UPDATE`,
    [viewerId, targetId]
  );
  if ((reverse.rowCount ?? 0) > 0) {
    await insertFriendship(client, viewerId, targetId);
    await resolveFriendRequestInbox(client, targetId, viewerId, "accepted");
    await deleteBothRequests(client, viewerId, targetId);
    return true;
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO friend_requests (requester_id, recipient_id)
     VALUES ($1, $2) ON CONFLICT (requester_id, recipient_id) DO NOTHING
     RETURNING id`,
    [viewerId, targetId]
  );
  const requestId = inserted.rows[0]?.id;
  if (!requestId) return false;
  await client.query(
    `INSERT INTO player_inbox_entries (
       id, player_id, entry_kind, actor_player_id, friend_request_id,
       status, message, created_at
     ) VALUES (
       gen_random_uuid(), $2, 'friend_request', $1, $3,
       'pending', 'Friendship request', now()
     )
     ON CONFLICT (friend_request_id) WHERE friend_request_id IS NOT NULL DO NOTHING`,
    [viewerId, targetId, requestId]
  );
  await pruneSocialInbox(client, targetId);
  return true;
}

async function acceptFriendRequest(
  client: pg.PoolClient,
  viewerId: string,
  targetId: string
): Promise<boolean> {
  if (await friendshipExists(client, viewerId, targetId)) return false;
  const pending = await client.query(
    `SELECT requester_id FROM friend_requests
     WHERE requester_id = $2 AND recipient_id = $1 FOR UPDATE`,
    [viewerId, targetId]
  );
  if ((pending.rowCount ?? 0) === 0) return false;
  await insertFriendship(client, viewerId, targetId);
  await resolveFriendRequestInbox(client, targetId, viewerId, "accepted");
  await deleteBothRequests(client, viewerId, targetId);
  return true;
}

async function markEnemy(
  client: pg.PoolClient,
  viewerId: string,
  targetId: string
): Promise<boolean> {
  const removedFriend = await deleteFriendship(client, viewerId, targetId);
  await deleteBothRequests(client, viewerId, targetId);
  const removedNeutrality = rowChanged(await client.query(
    `DELETE FROM enemy_neutrality_requests
     WHERE player_low_id = LEAST($1, $2) AND player_high_id = GREATEST($1, $2)`,
    [viewerId, targetId]
  ));
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO player_enemy_marks (owner_id, target_id)
     VALUES (LEAST($1, $2), GREATEST($1, $2))
     ON CONFLICT (owner_id, target_id) DO NOTHING
     RETURNING id`,
    [viewerId, targetId]
  );
  const declarationId = inserted.rows[0]?.id;
  if (declarationId) {
    await client.query(
      `INSERT INTO player_inbox_entries (
         id, player_id, entry_kind, actor_player_id, enemy_declaration_id,
         status, message, created_at
       ) VALUES (
         gen_random_uuid(), $2, 'enemy_declaration', $1, $3,
         'notice', 'Enemy declaration', now()
       )
       ON CONFLICT (enemy_declaration_id) WHERE enemy_declaration_id IS NOT NULL DO NOTHING`,
      [viewerId, targetId, declarationId]
    );
    await pruneSocialInbox(client, targetId);
  }
  return removedFriend || removedNeutrality || declarationId !== undefined;
}

async function requestNeutrality(
  client: pg.PoolClient,
  viewerId: string,
  targetId: string
): Promise<boolean> {
  await deleteExpiredNeutralityRequest(client, viewerId, targetId);
  if (!await enemyRelationshipExists(client, viewerId, targetId)) {
    throw new ProfileSocialError("ENEMY_RELATIONSHIP_REQUIRED", "You are not enemies", 409);
  }
  return rowChanged(await client.query(
    `INSERT INTO enemy_neutrality_requests (
       player_low_id, player_high_id, requester_id, expires_at
     ) VALUES (LEAST($1, $2), GREATEST($1, $2), $1, $3)
     ON CONFLICT (player_low_id, player_high_id) DO NOTHING`,
    [viewerId, targetId, new Date(Date.now() + NEUTRALITY_REQUEST_TTL_MS)]
  ));
}

async function acceptNeutrality(
  client: pg.PoolClient,
  viewerId: string,
  targetId: string
): Promise<boolean> {
  const accepted = await resolveNeutralityRequest(client, viewerId, targetId, true);
  if (!accepted) return false;
  await client.query(
    `DELETE FROM player_enemy_marks
     WHERE owner_id = LEAST($1, $2) AND target_id = GREATEST($1, $2)`,
    [viewerId, targetId]
  );
  return true;
}

async function resolveNeutralityRequest(
  client: pg.PoolClient,
  viewerId: string,
  targetId: string,
  accepting: boolean
): Promise<boolean> {
  await deleteExpiredNeutralityRequest(client, viewerId, targetId);
  const removed = rowChanged(await client.query(
    `DELETE FROM enemy_neutrality_requests
     WHERE player_low_id = LEAST($1, $2) AND player_high_id = GREATEST($1, $2)
       AND requester_id = $2
     RETURNING requester_id`,
    [viewerId, targetId]
  ));
  if (!removed && accepting) {
    throw new ProfileSocialError(
      "NEUTRALITY_REQUEST_NOT_FOUND",
      "No incoming neutrality request exists",
      409
    );
  }
  return removed;
}

async function cancelNeutralityRequest(
  client: pg.PoolClient,
  viewerId: string,
  targetId: string
): Promise<boolean> {
  await deleteExpiredNeutralityRequest(client, viewerId, targetId);
  return rowChanged(await client.query(
    `DELETE FROM enemy_neutrality_requests
     WHERE player_low_id = LEAST($1, $2) AND player_high_id = GREATEST($1, $2)
       AND requester_id = $1`,
    [viewerId, targetId]
  ));
}

async function deleteExpiredNeutralityRequest(
  client: Queryable,
  left: string,
  right: string
): Promise<void> {
  await client.query(
    `DELETE FROM enemy_neutrality_requests
     WHERE player_low_id = LEAST($1, $2) AND player_high_id = GREATEST($1, $2)
       AND expires_at <= now()`,
    [left, right]
  );
}

async function enemyRelationshipExists(
  client: Queryable,
  left: string,
  right: string
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM player_enemy_marks
     WHERE owner_id = LEAST($1, $2) AND target_id = GREATEST($1, $2)`,
    [left, right]
  );
  return (result.rowCount ?? 0) > 0;
}

async function blockPlayer(
  client: pg.PoolClient,
  viewerId: string,
  targetId: string
): Promise<boolean> {
  await client.query(
    `INSERT INTO recent_player_pair_suppressions (
       player_low_id, player_high_id, suppressed_at
     ) VALUES (LEAST($1, $2), GREATEST($1, $2), clock_timestamp())
     ON CONFLICT (player_low_id, player_high_id) DO UPDATE
     SET suppressed_at = GREATEST(
       recent_player_pair_suppressions.suppressed_at,
       EXCLUDED.suppressed_at
     )`,
    [viewerId, targetId]
  );
  const inserted = rowChanged(await client.query(
    `INSERT INTO player_blocks (blocker_id, blocked_id)
     VALUES ($1, $2) ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
    [viewerId, targetId]
  ));
  const removedFriend = await deleteFriendship(client, viewerId, targetId);
  const removedRequests = await deleteBothRequests(client, viewerId, targetId);
  const removedRecent = rowChanged(await client.query(
    `DELETE FROM recent_players
     WHERE (owner_player_id = $1 AND recent_player_id = $2)
        OR (owner_player_id = $2 AND recent_player_id = $1)`,
    [viewerId, targetId]
  ));
  return inserted || removedFriend || removedRequests || removedRecent;
}

async function friendshipExists(client: Queryable, left: string, right: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM friendships
     WHERE player_low_id = LEAST($1, $2) AND player_high_id = GREATEST($1, $2)`,
    [left, right]
  );
  return (result.rowCount ?? 0) > 0;
}

async function insertFriendship(client: Queryable, left: string, right: string): Promise<void> {
  await client.query(
    `INSERT INTO friendships (player_low_id, player_high_id)
     VALUES (LEAST($1, $2), GREATEST($1, $2))
     ON CONFLICT (player_low_id, player_high_id) DO NOTHING`,
    [left, right]
  );
}

async function deleteFriendship(client: Queryable, left: string, right: string): Promise<boolean> {
  return rowChanged(await client.query(
    `DELETE FROM friendships
     WHERE player_low_id = LEAST($1, $2) AND player_high_id = GREATEST($1, $2)`,
    [left, right]
  ));
}

async function deleteDirectionalRequest(
  client: Queryable,
  requesterId: string,
  recipientId: string,
  status: "declined" | "cancelled"
): Promise<boolean> {
  await resolveFriendRequestInbox(client, requesterId, recipientId, status);
  return rowChanged(await client.query(
    "DELETE FROM friend_requests WHERE requester_id = $1 AND recipient_id = $2",
    [requesterId, recipientId]
  ));
}

async function deleteBothRequests(client: Queryable, left: string, right: string): Promise<boolean> {
  await client.query(
    `UPDATE player_inbox_entries
     SET status = 'cancelled'
     WHERE entry_kind = 'friend_request'
       AND status = 'pending'
       AND ((actor_player_id = $1 AND player_id = $2)
         OR (actor_player_id = $2 AND player_id = $1))`,
    [left, right]
  );
  return rowChanged(await client.query(
    `DELETE FROM friend_requests
     WHERE (requester_id = $1 AND recipient_id = $2)
        OR (requester_id = $2 AND recipient_id = $1)`,
    [left, right]
  ));
}

async function resolveFriendRequestInbox(
  client: Queryable,
  requesterId: string,
  recipientId: string,
  status: "accepted" | "declined" | "cancelled"
): Promise<void> {
  await client.query(
    `UPDATE player_inbox_entries
     SET status = $3
     WHERE entry_kind = 'friend_request'
       AND actor_player_id = $1
       AND player_id = $2
       AND status = 'pending'`,
    [requesterId, recipientId, status]
  );
}

async function pruneSocialInbox(client: Queryable, playerId: string): Promise<void> {
  await client.query(
    `WITH ranked AS (
       SELECT id, status,
              row_number() OVER (ORDER BY created_at DESC, id DESC) AS position
       FROM player_inbox_entries
       WHERE player_id = $1
         AND entry_kind IN ('friend_request', 'enemy_declaration')
     )
     DELETE FROM player_inbox_entries entry
     USING ranked
     WHERE entry.id = ranked.id
       AND ranked.position > 200
       AND ranked.status <> 'pending'`,
    [playerId]
  );
}

function listTargetSql(kind: SocialListKind): string {
  switch (kind) {
    case "friends":
      return `SELECT CASE WHEN player_low_id = $1 THEN player_high_id ELSE player_low_id END AS target_id
              FROM friendships WHERE player_low_id = $1 OR player_high_id = $1
              ORDER BY created_at DESC, target_id LIMIT $2 OFFSET $3`;
    case "incoming_requests":
      return `SELECT requester_id AS target_id FROM friend_requests WHERE recipient_id = $1
              ORDER BY created_at DESC, requester_id LIMIT $2 OFFSET $3`;
    case "outgoing_requests":
      return `SELECT recipient_id AS target_id FROM friend_requests WHERE requester_id = $1
              ORDER BY created_at DESC, recipient_id LIMIT $2 OFFSET $3`;
    case "enemies":
      return `SELECT CASE WHEN owner_id = $1 THEN target_id ELSE owner_id END AS target_id
              FROM player_enemy_marks WHERE owner_id = $1 OR target_id = $1
              ORDER BY created_at DESC, target_id LIMIT $2 OFFSET $3`;
    case "blocked":
      return `SELECT blocked_id AS target_id FROM player_blocks WHERE blocker_id = $1
              ORDER BY created_at DESC, blocked_id LIMIT $2 OFFSET $3`;
  }
}

function profileToListEntry(profile: PublicProfile): SocialListEntry {
  return {
    playerId: profile.playerId,
    displayName: profile.displayName,
    level: profile.level,
    portrait: profile.portrait,
    title: profile.title,
    presence: profile.presence,
    class: profile.class,
    kingdom: profile.kingdom,
    settlement: profile.settlement,
    relationship: profile.relationship
  };
}

function assertDifferentPlayers(viewerId: string, targetId: string): void {
  if (viewerId === targetId) {
    throw new ProfileSocialError("SELF_TARGET_NOT_ALLOWED", "Cannot target yourself", 400);
  }
}

function rejectUnsupportedControlCharacters(value: string, allowLineFeed: boolean): void {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 32 && !(allowLineFeed && (code === 10 || code === 13 || code === 9))) || code === 127) {
      throw new ProfileSocialError("INVALID_PROFILE_TEXT", "Profile text contains unsupported control characters", 400);
    }
  }
}

function assertUnicodeLength(value: string, maximum: number, label: string): void {
  if (Array.from(value).length > maximum) {
    throw new ProfileSocialError("PROFILE_TEXT_TOO_LONG", `${label} must be at most ${maximum} characters`, 400);
  }
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowChanged(result: { rowCount: number | null }): boolean {
  return (result.rowCount ?? 0) > 0;
}

function mapDatabaseError(error: unknown): Error {
  if (error instanceof ProfileSocialError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  if (code === "23503") return new ProfileSocialError("PLAYER_NOT_FOUND", "Player not found", 404);
  if (code === "23514") return new ProfileSocialError("INVALID_RELATIONSHIP", "Relationship action is invalid", 400);
  return error instanceof Error ? error : new Error("Profile/social operation failed");
}
