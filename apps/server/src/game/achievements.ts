import {
  BITTER_BLOOD_ACHIEVEMENT_ID,
  BITTER_BLOOD_POISON_DAMAGE_REQUIRED,
  POISON_DAMAGE_TAKEN_STAT_KEY,
  type AchievementSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

export type PoisonDamageProgressResult = Readonly<{
  value: number;
  newlyUnlocked: boolean;
  snapshot: AchievementSnapshot;
}>;

type AchievementRuntime = {
  playerId: string;
  value: number;
  persistedValue: number;
  pendingDamage: number;
  persistedCompleted: boolean;
  completedAt: string | null;
  flushTail: Promise<boolean>;
};

export class AchievementService {
  private readonly runtimes = new Map<string, AchievementRuntime>();
  private readonly loading = new Map<string, Promise<AchievementRuntime>>();

  constructor(private readonly pool: pg.Pool, private readonly now: () => number = Date.now) {}

  async snapshot(playerId: string): Promise<AchievementSnapshot> {
    const runtime = this.runtimes.get(playerId);
    return runtime ? runtimeSnapshot(runtime, this.now()) : loadSnapshot(this.pool, playerId, this.now());
  }

  async connectRuntime(playerId: string): Promise<AchievementSnapshot> {
    return runtimeSnapshot(await this.requireRuntime(playerId), this.now());
  }

  achievementIds(playerId: string): ReadonlySet<string> | null {
    const runtime = this.runtimes.get(playerId);
    if (!runtime) return null;
    return runtime.persistedCompleted ? new Set([BITTER_BLOOD_ACHIEVEMENT_ID]) : new Set();
  }

  async hasAchievement(playerId: string, achievementId: string): Promise<boolean> {
    const runtime = this.runtimes.get(playerId);
    if (runtime) {
      return achievementId === BITTER_BLOOD_ACHIEVEMENT_ID && runtime.persistedCompleted;
    }
    const result = await this.pool.query(
      `SELECT 1 FROM player_achievements
       WHERE player_id=$1 AND achievement_id=$2`,
      [playerId, achievementId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordPoisonDamage(
    playerId: string,
    appliedDamage: number
  ): Promise<PoisonDamageProgressResult> {
    if (!playerId || playerId.length > 160) throw new Error("Invalid poison stat player ID");
    if (!Number.isSafeInteger(appliedDamage) || appliedDamage <= 0) {
      throw new Error("Poison damage progress must be a positive safe integer");
    }
    const runtime = this.runtimes.get(playerId) ?? await this.requireRuntime(playerId);
    runtime.value += appliedDamage;
    runtime.pendingDamage += appliedDamage;
    const newlyUnlocked = !runtime.persistedCompleted &&
      runtime.value >= BITTER_BLOOD_POISON_DAMAGE_REQUIRED
      ? await this.enqueueFlush(runtime)
      : false;
    return {
      value: runtime.value,
      newlyUnlocked,
      snapshot: runtimeSnapshot(runtime, this.now())
    };
  }

  async flushDirty(): Promise<readonly string[]> {
    const newlyUnlockedPlayerIds: string[] = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.pendingDamage > 0 || shouldPersistUnlock(runtime)) {
        if (await this.enqueueFlush(runtime)) {
          newlyUnlockedPlayerIds.push(runtime.playerId);
        }
      }
    }
    return newlyUnlockedPlayerIds;
  }

  async flushPlayer(playerId: string): Promise<boolean> {
    const runtime = this.runtimes.get(playerId) ?? await this.loading.get(playerId);
    return runtime ? this.enqueueFlush(runtime) : false;
  }

  async flushAndRelease(playerId: string): Promise<void> {
    const runtime = this.runtimes.get(playerId) ?? await this.loading.get(playerId);
    if (!runtime) return;
    do {
      await this.enqueueFlush(runtime);
    } while (runtime.pendingDamage > 0 || shouldPersistUnlock(runtime));
    if (this.runtimes.get(playerId) === runtime) this.runtimes.delete(playerId);
  }

  private async requireRuntime(playerId: string): Promise<AchievementRuntime> {
    const existing = this.runtimes.get(playerId);
    if (existing) return existing;
    const loading = this.loading.get(playerId);
    if (loading) return loading;
    const next = loadSnapshot(this.pool, playerId, this.now()).then((snapshot) => {
      const progress = snapshot.achievements[0]!;
      const runtime: AchievementRuntime = {
        playerId,
        value: progress.value,
        persistedValue: progress.value,
        pendingDamage: 0,
        persistedCompleted: progress.completed,
        completedAt: progress.completedAt,
        flushTail: Promise.resolve(false)
      };
      this.runtimes.set(playerId, runtime);
      return runtime;
    }).finally(() => {
      this.loading.delete(playerId);
    });
    this.loading.set(playerId, next);
    return next;
  }

  private enqueueFlush(runtime: AchievementRuntime): Promise<boolean> {
    const run = () => this.flushRuntime(runtime);
    const next = runtime.flushTail.then(run, run);
    runtime.flushTail = next;
    return next;
  }

  private async flushRuntime(runtime: AchievementRuntime): Promise<boolean> {
    const pendingDamage = runtime.pendingDamage;
    const needsUnlock = shouldPersistUnlock(runtime);
    if (pendingDamage === 0 && !needsUnlock) return false;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let persistedValue = runtime.persistedValue;
      if (pendingDamage > 0) {
        const stat = await client.query<{ value: string | number }>(
          `INSERT INTO player_stats (player_id,stat_key,value)
           VALUES ($1,$2,$3)
           ON CONFLICT (player_id,stat_key) DO UPDATE
           SET value=player_stats.value + EXCLUDED.value,updated_at=now()
           RETURNING value`,
          [runtime.playerId, POISON_DAMAGE_TAKEN_STAT_KEY, pendingDamage]
        );
        persistedValue = Number(stat.rows[0]?.value ?? persistedValue);
      }
      let newlyUnlocked = false;
      let completedAt = runtime.completedAt;
      if (needsUnlock && persistedValue >= BITTER_BLOOD_POISON_DAMAGE_REQUIRED) {
        const unlocked = await client.query<{ unlocked_at: Date | string }>(
          `INSERT INTO player_achievements (player_id,achievement_id)
           VALUES ($1,$2)
           ON CONFLICT (player_id,achievement_id) DO NOTHING
           RETURNING unlocked_at`,
          [runtime.playerId, BITTER_BLOOD_ACHIEVEMENT_ID]
        );
        newlyUnlocked = (unlocked.rowCount ?? 0) > 0;
        let unlockedAt = unlocked.rows[0]?.unlocked_at;
        if (!unlockedAt) {
          const existing = await client.query<{ unlocked_at: Date | string }>(
            `SELECT unlocked_at FROM player_achievements
             WHERE player_id=$1 AND achievement_id=$2`,
            [runtime.playerId, BITTER_BLOOD_ACHIEVEMENT_ID]
          );
          unlockedAt = existing.rows[0]?.unlocked_at;
        }
        if (unlockedAt) completedAt = new Date(unlockedAt).toISOString();
      }
      await client.query("COMMIT");
      runtime.pendingDamage -= pendingDamage;
      runtime.persistedValue = persistedValue;
      runtime.value = Math.max(runtime.value, persistedValue + runtime.pendingDamage);
      if (needsUnlock && completedAt) {
        runtime.persistedCompleted = true;
        runtime.completedAt = completedAt;
      }
      return newlyUnlocked;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function runtimeSnapshot(runtime: AchievementRuntime, serverTime: number): AchievementSnapshot {
  return {
    playerId: runtime.playerId,
    achievements: [{
      achievementId: BITTER_BLOOD_ACHIEVEMENT_ID,
      title: "Bitter Blood",
      badgeId: BITTER_BLOOD_ACHIEVEMENT_ID,
      completed: runtime.persistedCompleted,
      completedAt: runtime.completedAt,
      statKey: POISON_DAMAGE_TAKEN_STAT_KEY,
      value: runtime.value,
      requiredValue: BITTER_BLOOD_POISON_DAMAGE_REQUIRED
    }],
    serverTime
  };
}

function shouldPersistUnlock(runtime: AchievementRuntime): boolean {
  return !runtime.persistedCompleted && runtime.value >= BITTER_BLOOD_POISON_DAMAGE_REQUIRED;
}

async function loadSnapshot(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string,
  serverTime: number
): Promise<AchievementSnapshot> {
  const result = await queryable.query<{
    value: string | number;
    unlocked_at: Date | string | null;
  }>(
    `SELECT COALESCE(stats.value,0) AS value,achievement.unlocked_at
     FROM (SELECT $1::text AS player_id) player
     LEFT JOIN player_stats stats
       ON stats.player_id=player.player_id AND stats.stat_key=$2
     LEFT JOIN player_achievements achievement
       ON achievement.player_id=player.player_id AND achievement.achievement_id=$3`,
    [playerId, POISON_DAMAGE_TAKEN_STAT_KEY, BITTER_BLOOD_ACHIEVEMENT_ID]
  );
  const row = result.rows[0] ?? { value: 0, unlocked_at: null };
  return {
    playerId,
    achievements: [{
      achievementId: BITTER_BLOOD_ACHIEVEMENT_ID,
      title: "Bitter Blood",
      badgeId: BITTER_BLOOD_ACHIEVEMENT_ID,
      completed: row.unlocked_at !== null,
      completedAt: row.unlocked_at ? new Date(row.unlocked_at).toISOString() : null,
      statKey: POISON_DAMAGE_TAKEN_STAT_KEY,
      value: Number(row.value),
      requiredValue: BITTER_BLOOD_POISON_DAMAGE_REQUIRED
    }],
    serverTime
  };
}
