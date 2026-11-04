import { performance } from "node:perf_hooks";

import { loadConfig } from "../../config.js";
import { createPool } from "../../db/pool.js";
import { runMigrations } from "../../db/migrate.js";
import { PostgresPartyAuthority } from "./PostgresPartyAuthority.js";

const config = loadConfig();
const database = new URL(config.DATABASE_URL).pathname.slice(1);
if (!database.startsWith("ash_atlas_stability_") && database !== "ash_atlas_stability") {
  throw new Error("party cache benchmark requires an ash_atlas_stability database");
}
await runMigrations(config.DATABASE_URL);
const pool = createPool({ databaseUrl: config.DATABASE_URL });
const runId = crypto.randomUUID();
const results = [];
const seededPrefixes = new Set<string>();

try {
  for (const population of [1_000, 10_000]) {
    const prefix = `party-cache-${population}-${runId}`;
    await seed(population, prefix);
    seededPrefixes.add(prefix);
    const authority = new PostgresPartyAuthority(pool);
    try {
      const initializeStartedAt = performance.now();
      await authority.initialize();
      const initializeMs = performance.now() - initializeStartedAt;
      const leader = `${prefix}-player-${population}`;
      const mutationStartedAt = performance.now();
      const updated = await authority.setTravelAllowed(leader, `allow-${population}`, true);
      const incrementalMutationMs = performance.now() - mutationStartedAt;
      const reconcileStartedAt = performance.now();
      await authority.reconcileCache();
      const fullReconciliationMs = performance.now() - reconcileStartedAt;
      results.push({
        population,
        initializeMs,
        incrementalMutationMs,
        fullReconciliationMs,
        updatedRevision: updated.revision,
        unaffectedPartyPresent: authority.partyForPlayer(`${prefix}-player-1`)?.partyId === `${prefix}-party-1`
      });
    } finally {
      await authority.close().catch(() => undefined);
      await cleanup(prefix);
      seededPrefixes.delete(prefix);
    }
  }
} finally {
  for (const prefix of seededPrefixes) await cleanup(prefix).catch(() => undefined);
  await pool.end();
}

console.table(results.map((result) => ({
  ...result,
  initializeMs: Number(result.initializeMs.toFixed(1)),
  incrementalMutationMs: Number(result.incrementalMutationMs.toFixed(1)),
  fullReconciliationMs: Number(result.fullReconciliationMs.toFixed(1))
})));
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));

async function seed(population: number, prefix: string): Promise<void> {
  await pool.query(
    `INSERT INTO players (
       id,username,username_normalized,region_code,lat,lon,anchor_lat,anchor_lon,
       move_leash_radius_m,online,geom
     ) SELECT $1 || '-player-' || n, 'Party Player ' || n, lower('Party Player ' || n),
              'GLOBAL',0,0,0,0,1250,false,ST_SetSRID(ST_MakePoint(0,0),4326)
       FROM generate_series(1,$2) AS n`,
    [prefix, population]
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      `INSERT INTO parties (party_id,leader_player_id,revision)
       SELECT $1 || '-party-' || n, $1 || '-player-' || n, 1
       FROM generate_series(1,$2) AS n`,
      [prefix, population]
    );
    await client.query(
      `INSERT INTO party_members (party_id,player_id)
       SELECT $1 || '-party-' || n, $1 || '-player-' || n
       FROM generate_series(1,$2) AS n`,
      [prefix, population]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(prefix: string): Promise<void> {
  await pool.query("DELETE FROM parties WHERE party_id LIKE $1", [`${prefix}-%`]);
  await pool.query("DELETE FROM players WHERE id LIKE $1", [`${prefix}-%`]);
}
