import { createHash } from "node:crypto";

import {
  MASTERY_TITLES,
  PROFESSION_XP_AWARDS,
  PROFESSION_IDS,
  RETIRED_MASTERY_ACHIEVEMENT_IDS,
  RETIRED_MASTERY_TITLES,
  WARRIOR_MAX_RANK,
  WARRIOR_MAX_XP,
  WARRIOR_XP_THRESHOLDS,
  builderXpForConstruction,
  professionMaxXp,
  professionMaxRank,
  professionRankForXp,
  professionXpThresholds,
  warriorRankForXp,
  type MasteryGrantResult,
  type MasteryProgress,
  type MasterySnapshot,
  type ProfessionId
} from "@ash-atlas/shared";
import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type ProfessionRow = {
  profession_id: ProfessionId;
  xp: number;
  rank: number;
  curve_version: number;
  completed_at: Date | string | null;
};

export type ProfessionXpSource = "harvest" | "mining" | "construction" | "reinforcement" | "oil_harvest" | "furnace" | "development";
export type CompactMasteryGrantResult = Omit<MasteryGrantResult, "snapshot">;

export type ProfessionActivity =
  | { kind: "wood-harvest" }
  | { kind: "stone-mine" }
  | { kind: "flag-build" }
  | { kind: "flag-reinforcement" }
  | { kind: "construction"; baseDurationSeconds: number }
  | { kind: "oil-harvest"; harvestedCrude: number }
  | { kind: "iron-smelt"; outcome: "success" | "failure" }
  | { kind: "metal-bar-smelt" };

export type ProfessionGrantInput = {
  operationKey: string;
  playerId: string;
  sourceId?: string | null;
  activity: ProfessionActivity;
  randomResults?: Record<string, unknown>;
};

export type ResolvedProfessionAward = {
  professionId: ProfessionId;
  sourceType: Exclude<ProfessionXpSource, "development">;
  requestedXp: number;
  policyId: ProfessionActivity["kind"];
  policyVersion: 2;
  policyFingerprint: string;
};

export class MasteryService {
  constructor(private readonly pool: pg.Pool) {}

  async getOrCreate(playerId: string): Promise<MasterySnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.ensureRows(client, playerId);
      const snapshot = await this.snapshot(client, playerId);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async grantProfessionXp(input: ProfessionGrantInput): Promise<MasteryGrantResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.grantProfessionXpInTransaction(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async grantProfessionXpInTransaction(
    queryable: Queryable,
    input: ProfessionGrantInput
  ): Promise<MasteryGrantResult> {
    const result = await this.grantProfessionXpCore(queryable, input, true);
    return result as MasteryGrantResult;
  }

  async grantProfessionXpCompactInTransaction(
    queryable: Queryable,
    input: ProfessionGrantInput
  ): Promise<CompactMasteryGrantResult> {
    return this.grantProfessionXpCore(queryable, input, false);
  }

  private async grantProfessionXpCore(
    queryable: Queryable,
    input: ProfessionGrantInput,
    includeSnapshot: boolean
  ): Promise<MasteryGrantResult | CompactMasteryGrantResult> {
    if (!input.operationKey || input.operationKey.length > 240) throw new Error("Mastery operation key is invalid");
    const award = resolveProfessionAward(input);
    if (includeSnapshot) {
      await this.ensureRows(queryable, input.playerId);
    } else {
      await queryable.query(
        `INSERT INTO player_profession_progress (player_id, profession_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [input.playerId, award.professionId]
      );
    }
    const existing = await queryable.query<{
      player_id: string; profession_id: ProfessionId; requested_xp: number; source_type: string; source_id: string | null;
      policy_id: string | null; policy_version: number | null; policy_fingerprint: string | null;
      result: CompactMasteryGrantResult;
    }>(`SELECT player_id, profession_id, requested_xp, source_type, source_id,
               policy_id, policy_version, policy_fingerprint, result
        FROM mastery_progression_operations WHERE operation_key = $1`, [input.operationKey]);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      const stableIdentityMatches = row.player_id === input.playerId &&
        row.profession_id === award.professionId && row.source_type === award.sourceType &&
        row.source_id === (input.sourceId ?? null);
      const v2PolicyMatches = row.policy_id === null || (
        row.policy_id === award.policyId && Number(row.policy_version) === award.policyVersion &&
        row.policy_fingerprint === award.policyFingerprint && Number(row.requested_xp) === award.requestedXp
      );
      if (!stableIdentityMatches || !v2PolicyMatches) {
        throw new Error("Mastery idempotency key conflicts with another operation");
      }
      const replayed = { ...row.result, replayed: true };
      return includeSnapshot
        ? { ...replayed, snapshot: await this.snapshot(queryable, input.playerId) }
        : replayed;
    }
    const locked = await queryable.query<ProfessionRow>(
      `SELECT profession_id, xp, rank, curve_version, completed_at FROM player_profession_progress
       WHERE player_id = $1 AND profession_id = $2 FOR UPDATE`,
      [input.playerId, award.professionId]
    );
    const row = locked.rows[0];
    if (!row) throw new Error("Profession progress does not exist");
    if (Number(row.curve_version) !== 2) throw new Error("Unsupported profession curve version");
    const maximumXp = professionMaxXp(award.professionId);
    const previousXp = Math.min(maximumXp, Math.max(0, Number(row.xp)));
    const previousRank = professionRankForXp(previousXp, award.professionId);
    const resultingXp = Math.min(maximumXp, previousXp + award.requestedXp);
    const resultingRank = professionRankForXp(resultingXp, award.professionId);
    const grantedXp = resultingXp - previousXp;
    const maximumRank = professionMaxRank(award.professionId);
    const newlyMastered = previousRank < maximumRank && resultingRank === maximumRank;
    await queryable.query(
      `UPDATE player_profession_progress
       SET xp = $3, rank = $4::smallint, completed_at = CASE WHEN $4::smallint = $5::smallint THEN COALESCE(completed_at, now()) ELSE completed_at END,
           revision = revision + 1 WHERE player_id = $1 AND profession_id = $2`,
      [input.playerId, award.professionId, resultingXp, resultingRank, maximumRank]
    );
    if (resultingRank === maximumRank) {
      await this.recordAchievement(queryable, input.playerId, award.professionId, MASTERY_TITLES[award.professionId]);
    }
    const result: CompactMasteryGrantResult = {
      operationKey: input.operationKey,
      playerId: input.playerId,
      trackId: award.professionId,
      requestedXp: award.requestedXp,
      grantedXp,
      previousXp,
      resultingXp,
      previousRank,
      resultingRank,
      replayed: false,
      newlyMastered
    };
    await queryable.query(
      `INSERT INTO mastery_progression_operations (
         operation_key, player_id, profession_id, source_type, source_id, requested_xp, granted_xp,
         previous_xp, resulting_xp, previous_rank, resulting_rank, random_results, result,
         policy_id, policy_version, policy_fingerprint
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16)`,
      [input.operationKey, input.playerId, award.professionId, award.sourceType, input.sourceId ?? null,
       award.requestedXp, grantedXp, previousXp, resultingXp, previousRank, resultingRank,
       JSON.stringify(input.randomResults ?? {}), JSON.stringify(result),
       award.policyId, award.policyVersion, award.policyFingerprint]
    );
    return includeSnapshot
      ? { ...result, snapshot: await this.snapshot(queryable, input.playerId) }
      : result;
  }

  async recordWarriorMastery(queryable: Queryable, playerId: string): Promise<void> {
    await this.ensureRows(queryable, playerId);
    await this.recordAchievement(queryable, playerId, "warrior", MASTERY_TITLES.warrior);
  }

  async adjustProfessionForDevelopmentInTransaction(
    queryable: Queryable,
    playerId: string,
    professionId: ProfessionId,
    targetRank: number
  ): Promise<void> {
    const maximumRank = professionMaxRank(professionId);
    if (!PROFESSION_IDS.includes(professionId) ||
        !Number.isInteger(targetRank) || targetRank < 0 || targetRank > maximumRank) {
      throw new Error("Development profession target is invalid");
    }
    await this.ensureRows(queryable, playerId);
    const locked = await queryable.query<{ curve_version: number }>(
      `SELECT curve_version FROM player_profession_progress
       WHERE player_id = $1 AND profession_id = $2 FOR UPDATE`,
      [playerId, professionId]
    );
    if (Number(locked.rows[0]?.curve_version) !== 2) {
      throw new Error("Unsupported profession curve version");
    }
    await queryable.query(
      `UPDATE player_profession_progress
       SET xp = $3::integer, rank = $4::smallint,
           completed_at = CASE WHEN $4::smallint = $5::smallint THEN COALESCE(completed_at, now()) ELSE NULL END,
           revision = revision + 1
       WHERE player_id = $1 AND profession_id = $2`,
      [playerId, professionId, professionXpThresholds(professionId)[targetRank], targetRank, maximumRank]
    );
    await this.reconcileDevelopmentMasteryAchievement(
      queryable, playerId, professionId, targetRank === maximumRank
    );
  }

  async reconcileDevelopmentMasteryAchievement(
    queryable: Queryable,
    playerId: string,
    trackId: ProfessionId | "warrior",
    mastered: boolean
  ): Promise<void> {
    const title = MASTERY_TITLES[trackId];
    if (mastered) {
      await this.recordAchievement(queryable, playerId, trackId, title);
      return;
    }
    await queryable.query(
      `DELETE FROM player_mastery_achievements WHERE player_id = $1 AND achievement_id = $2`,
      [playerId, `master_${trackId}`]
    );
    await queryable.query(`INSERT INTO player_profiles (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [playerId]);
    const state = await queryable.query<{ equipped_title: string | null }>(
      `SELECT equipped_title FROM player_mastery_state WHERE player_id = $1 FOR UPDATE`,
      [playerId]
    );
    const earned = await queryable.query<{ title: string }>(
      `SELECT title FROM player_mastery_achievements
       WHERE player_id = $1 ORDER BY completed_at, achievement_id`,
      [playerId]
    );
    const earnedTitles = earned.rows.map((row) => row.title).filter((title) => !isRetiredMasteryTitle(title));
    const current = state.rows[0]?.equipped_title ?? null;
    const equippedTitle = current !== null && earnedTitles.includes(current) ? current : earnedTitles[0] ?? null;
    await queryable.query(
      `UPDATE player_mastery_state SET equipped_title = $2, revision = revision + 1 WHERE player_id = $1`,
      [playerId, equippedTitle]
    );
    await queryable.query(`UPDATE player_profiles SET title = $2 WHERE player_id = $1`, [playerId, equippedTitle]);
  }

  async professionRankInTransaction(queryable: Queryable, playerId: string, professionId: ProfessionId): Promise<number> {
    const result = await queryable.query<{ rank: number }>(
      `SELECT rank FROM player_profession_progress WHERE player_id = $1 AND profession_id = $2`,
      [playerId, professionId]
    );
    return Math.min(professionMaxRank(professionId), Math.max(0, Number(result.rows[0]?.rank ?? 0)));
  }

  async professionRank(playerId: string, professionId: ProfessionId): Promise<number> {
    return this.professionRankInTransaction(this.pool, playerId, professionId);
  }

  private async recordAchievement(queryable: Queryable, playerId: string, trackId: string, title: string): Promise<void> {
    await queryable.query(
      `INSERT INTO player_mastery_achievements (player_id, achievement_id, title, badge_id)
       VALUES ($1,$2,$3,$2) ON CONFLICT DO NOTHING`,
      [playerId, `master_${trackId}`, title]
    );
    await queryable.query(`INSERT INTO player_profiles (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [playerId]);
    await queryable.query(
      `UPDATE player_mastery_state
       SET equipped_title = CASE WHEN equipped_title IS NULL OR equipped_title = ANY($3::text[]) THEN $2 ELSE equipped_title END,
           revision = revision + 1
       WHERE player_id = $1`, [playerId, title, RETIRED_MASTERY_TITLES]
    );
    await queryable.query(
      `UPDATE player_profiles SET title = COALESCE(title, $2) WHERE player_id = $1`, [playerId, title]
    );
  }

  private async ensureRows(queryable: Queryable, playerId: string): Promise<void> {
    await queryable.query(
      `INSERT INTO player_profession_progress (player_id, profession_id)
       SELECT $1, profession_id
       FROM unnest($2::text[]) AS profession_id
       ON CONFLICT DO NOTHING`,
      [playerId, PROFESSION_IDS]
    );
    await queryable.query(`INSERT INTO player_mastery_state (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [playerId]);
    await queryable.query(
      `INSERT INTO player_mastery_achievements (player_id, achievement_id, title, badge_id, completed_at)
       SELECT player_id, 'master_warrior', 'Master Warrior', 'master_warrior', COALESCE(completed_at, now())
       FROM player_class_progress WHERE player_id = $1 AND class_id = 'warrior' AND mastery_rank = 15
      ON CONFLICT DO NOTHING`, [playerId]
    );
    const warriorMastered = await queryable.query(
      `SELECT 1 FROM player_class_progress WHERE player_id = $1 AND class_id = 'warrior' AND mastery_rank = 15`, [playerId]
    );
    if (warriorMastered.rowCount) {
      await queryable.query(`INSERT INTO player_profiles (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [playerId]);
      await queryable.query(`UPDATE player_mastery_state SET equipped_title = COALESCE(equipped_title, 'Master Warrior') WHERE player_id = $1`, [playerId]);
      await queryable.query(`UPDATE player_profiles SET title = COALESCE(title, 'Master Warrior') WHERE player_id = $1`, [playerId]);
    }
  }

  async snapshotInTransaction(queryable: Queryable, playerId: string): Promise<MasterySnapshot> {
    await this.ensureRows(queryable, playerId);
    return this.snapshot(queryable, playerId);
  }

  private async snapshot(queryable: Queryable, playerId: string): Promise<MasterySnapshot> {
    const warriorResult = await queryable.query<{ mastery_xp: number; mastery_rank: number; completed_at: Date | string | null }>(
        `SELECT mastery_xp, mastery_rank, completed_at FROM player_class_progress
         WHERE player_id = $1 AND class_id = 'warrior'`, [playerId]
      );
    const professionResult = await queryable.query<ProfessionRow>(
        `SELECT profession_id, xp, rank, curve_version, completed_at FROM player_profession_progress
         WHERE player_id = $1 ORDER BY profession_id`, [playerId]
      );
    const achievements = await queryable.query<{ achievement_id: string }>(
        `SELECT achievement_id FROM player_mastery_achievements WHERE player_id = $1 ORDER BY achievement_id`, [playerId]
      );
    const state = await queryable.query<{ equipped_title: string | null }>(
        `SELECT equipped_title FROM player_mastery_state WHERE player_id = $1`, [playerId]
      );
    const warrior = warriorResult.rows[0] ?? { mastery_xp: 0, mastery_rank: 0, completed_at: null };
    const professions = Object.fromEntries(PROFESSION_IDS.map((professionId) => {
      const row = professionResult.rows.find((candidate) => candidate.profession_id === professionId)
        ?? { profession_id: professionId, xp: 0, rank: 0, curve_version: 2, completed_at: null };
      return [professionId, progress(professionId, Number(row.xp), Number(row.rank), row.completed_at)];
    })) as MasterySnapshot["professions"];
    return {
      playerId,
      warrior: progress("warrior", Number(warrior.mastery_xp), warriorRankForXp(Number(warrior.mastery_xp)), warrior.completed_at),
      professions,
      achievementIds: achievements.rows.map((row) => row.achievement_id)
        .filter((id) => !(RETIRED_MASTERY_ACHIEVEMENT_IDS as readonly string[]).includes(id)),
      equippedTitle: visibleMasteryTitle(state.rows[0]?.equipped_title ?? null),
      serverTime: Date.now()
    };
  }
}

export function resolveProfessionAward(input: ProfessionGrantInput): ResolvedProfessionAward {
  let professionId: ProfessionId;
  let sourceType: ResolvedProfessionAward["sourceType"];
  let requestedXp: number;
  let policyInput: Record<string, unknown>;
  switch (input.activity.kind) {
    case "wood-harvest":
      professionId = "woodcutter";
      sourceType = "harvest";
      requestedXp = PROFESSION_XP_AWARDS.woodHarvest;
      policyInput = { kind: input.activity.kind };
      break;
    case "stone-mine":
      professionId = "miner";
      sourceType = "mining";
      requestedXp = PROFESSION_XP_AWARDS.stoneMine;
      policyInput = { kind: input.activity.kind };
      break;
    case "flag-build":
      professionId = "builder";
      sourceType = "construction";
      requestedXp = PROFESSION_XP_AWARDS.flagBuild;
      policyInput = { kind: input.activity.kind };
      break;
    case "flag-reinforcement":
      professionId = "builder";
      sourceType = "reinforcement";
      requestedXp = PROFESSION_XP_AWARDS.flagReinforcement;
      policyInput = { kind: input.activity.kind };
      break;
    case "construction":
      professionId = "builder";
      sourceType = "construction";
      requestedXp = builderXpForConstruction(input.activity.baseDurationSeconds);
      policyInput = {
        kind: input.activity.kind,
        baseDurationSeconds: input.activity.baseDurationSeconds
      };
      break;
    case "oil-harvest":
      professionId = "oil_worker";
      sourceType = "oil_harvest";
      requestedXp = input.activity.harvestedCrude;
      policyInput = { kind: input.activity.kind, harvestedCrude: input.activity.harvestedCrude };
      break;
    case "iron-smelt":
      professionId = "metallurgy";
      sourceType = "furnace";
      requestedXp = input.activity.outcome === "success"
        ? PROFESSION_XP_AWARDS.metallurgyIronSuccess
        : PROFESSION_XP_AWARDS.metallurgyIronFailure;
      policyInput = { kind: input.activity.kind, outcome: input.activity.outcome };
      break;
    case "metal-bar-smelt":
      professionId = "metallurgy";
      sourceType = "furnace";
      requestedXp = PROFESSION_XP_AWARDS.metallurgyMetalBar;
      policyInput = { kind: input.activity.kind };
      break;
    default:
      throw new Error("Unknown profession activity policy");
  }
  if (!Number.isSafeInteger(requestedXp) || requestedXp < 0) {
    throw new Error("Profession award policy produced invalid XP");
  }
  return {
    professionId,
    sourceType,
    requestedXp,
    policyId: input.activity.kind,
    policyVersion: 2,
    policyFingerprint: createHash("sha256").update(JSON.stringify(policyInput)).digest("hex")
  };
}

function isRetiredMasteryTitle(title: string): boolean {
  return (RETIRED_MASTERY_TITLES as readonly string[]).includes(title);
}

/** Retired Hunter/Breeder titles stay stored but are never shown. */
function visibleMasteryTitle(title: string | null): string | null {
  return title !== null && isRetiredMasteryTitle(title) ? null : title;
}

function progress(
  trackId: MasteryProgress["trackId"],
  xp: number,
  rank: number,
  completedAt: Date | string | null
): MasteryProgress {
  const thresholds = trackId === "warrior" ? WARRIOR_XP_THRESHOLDS : professionXpThresholds(trackId);
  const maximumRank = trackId === "warrior" ? WARRIOR_MAX_RANK : professionMaxRank(trackId);
  const maximumXp = trackId === "warrior" ? WARRIOR_MAX_XP : professionMaxXp(trackId);
  const safeXp = Math.min(maximumXp, Math.max(0, Math.trunc(xp)));
  const safeRank = Math.min(maximumRank, Math.max(0, Math.trunc(rank)));
  return {
    trackId,
    xp: safeXp,
    rank: safeRank,
    maximumRank,
    nextRankXp: safeRank >= maximumRank ? null : thresholds[safeRank + 1]!,
    completedAt: completedAt ? new Date(completedAt).toISOString() : null,
    mastered: safeRank === maximumRank,
    title: MASTERY_TITLES[trackId]
  };
}
