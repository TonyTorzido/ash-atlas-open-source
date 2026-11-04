import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_FLAG_CLAIM_RADIUS_M,
  normalizeFlagEnvironmentDetails,
  type FlagSnapshot
} from "@ash-atlas/shared";

import { loadConfig, type AppConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { createLogger } from "../logger.js";
import { WorldLookupClient } from "../world/worldLookupClient.js";
import { buildFlagEnvironmentDetails, type PersistedFlagEnvironmentRow } from "./flagEnvironment.js";
import { prepareFlagEnvironmentPersistence } from "./flagEnvironmentPersistence.js";

type AuditPoint = {
  kind: string;
  latitude: number;
  longitude: number;
  package_id?: string;
};

type MapAuditReport = {
  seed: number;
  points: AuditPoint[];
};

type AuditDatabaseRow = {
  seq: number;
  lat: number;
  lon: number;
  package_id: string | null;
  elevation_m: number | null;
  terrain_class: string | null;
  biome: string | null;
  ecoregion: string | null;
  environment_snapshot: unknown;
  snapshot_bytes: number;
};

export async function runFlagEnvironmentAudit(options: {
  inputPath: string;
  outputPath: string;
  databaseUrl: string;
  config?: AppConfig;
}): Promise<Record<string, unknown>> {
  assertDisposableDatabase(options.databaseUrl);
  const config = options.config ?? loadConfig({ DATABASE_URL: options.databaseUrl, NODE_ENV: "test" });
  const mapReport = JSON.parse(await readFile(options.inputPath, "utf8")) as MapAuditReport;
  const points = mapReport.points.filter((point) => point.kind === "land").slice(0, 1_000);
  if (points.length !== 1_000) {
    throw new Error(`game flag audit requires exactly 1000 land coordinates; received ${points.length}`);
  }
  const worldLookup = new WorldLookupClient(
    config.WORLD_API_BASE,
    createLogger("test"),
    120_000,
    {
      releaseId: config.WORLD_REQUIRED_RELEASE_ID,
      profileSetFingerprint: config.WORLD_REQUIRED_PROFILE_SET_FINGERPRINT,
      buildContractFingerprint: config.WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT,
      boundaryReleaseId: config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID
    }
  );
  const worlds = [];
  for (let offset = 0; offset < points.length; offset += 250) {
    worlds.push(
      ...(await worldLookup.lookupMany(
        points.slice(offset, offset + 250).map((point) => ({
          lat: point.latitude,
          lon: point.longitude
        }))
      ))
    );
  }

  const pool = createPool({ databaseUrl: options.databaseUrl });
  const failures: Array<{ index: number; error: string }> = [];
  let maxSnapshotBytes = 0;
  let totalSnapshotBytes = 0;
  let ecologyFallbackCount = 0;
  let hydrologyCount = 0;
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TEMP TABLE flag_environment_audit (
          seq integer PRIMARY KEY,
          lat double precision NOT NULL,
          lon double precision NOT NULL,
          package_id text NULL,
          elevation_m double precision NULL,
          terrain_class text NULL,
          biome text NULL,
          ecoregion text NULL,
          environment_snapshot jsonb NOT NULL,
          snapshot_bytes integer NOT NULL
        ) ON COMMIT DROP
      `);
      for (const [index, world] of worlds.entries()) {
        const persistence = prepareFlagEnvironmentPersistence(world);
        await client.query(
          `INSERT INTO flag_environment_audit (
             seq, lat, lon, package_id, elevation_m, terrain_class,
             biome, ecoregion, environment_snapshot, snapshot_bytes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
          [
            index,
            points[index]!.latitude,
            points[index]!.longitude,
            persistence.packageId,
            persistence.elevationM,
            persistence.terrainClass,
            persistence.biome,
            persistence.ecoregion,
            persistence.snapshotJson,
            persistence.snapshotBytes
          ]
        );
      }
      const stored = await client.query<AuditDatabaseRow>(
        "SELECT * FROM flag_environment_audit ORDER BY seq ASC"
      );
      for (const row of stored.rows) {
        try {
          const details = normalizeFlagEnvironmentDetails(
            buildFlagEnvironmentDetails(asPersistedRow(row), config)
          );
          const world = worlds[row.seq]!;
          assertEquivalent(details, world, points[row.seq]!);
          const lightweight: FlagSnapshot = {
            id: details.identity.flagId,
            controlType: "personal",
            ownerId: details.identity.ownerId,
            name: details.identity.flagName,
            lat: details.coordinates.latitude,
            lon: details.coordinates.longitude,
            packageId: details.coordinates.packageId,
            elevationM: details.terrain.elevationM,
            terrainClass: details.terrain.terrainClass,
            biome: details.ecology.biomeName,
            ecoregion: details.ecology.ecoregionName,
            claimRadiusM: details.identity.claimRadiusM,
            cityId: details.identity.cityId,
            createdAt: details.identity.createdAt
          };
          const lightweightJson = JSON.stringify(lightweight);
          if (lightweightJson.includes("rawSnapshot") || lightweightJson.includes("environment_snapshot")) {
            throw new Error("ordinary flag snapshot contains advanced environment data");
          }
          maxSnapshotBytes = Math.max(maxSnapshotBytes, row.snapshot_bytes);
          totalSnapshotBytes += row.snapshot_bytes;
          if (details.ecology.resolution === "nearest_land_fallback") ecologyFallbackCount += 1;
          if (details.water.supportingRiver.id) hydrologyCount += 1;
        } catch (error) {
          failures.push({
            index: row.seq,
            error: error instanceof Error ? error.message : "unknown audit failure"
          });
        }
      }
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  const report = {
    audit_version: "game-flag-environment-v1",
    ok: failures.length === 0,
    seed: mapReport.seed,
    point_count: points.length,
    world_lookup_batches: 4,
    persisted_jsonb_rows: points.length,
    normalized_api_rows: points.length - failures.length,
    ecology_fallback_count: ecologyFallbackCount,
    supporting_hydrology_count: hydrologyCount,
    snapshot_bytes: {
      average: Math.round(totalSnapshotBytes / points.length),
      maximum: maxSnapshotBytes,
      limit_checked: 524_288
    },
    ordinary_broadcast_contract: "lightweight FlagSnapshot",
    failures
  };
  if (maxSnapshotBytes > 524_288) {
    throw new Error(`environment snapshot exceeded 512 KiB (${maxSnapshotBytes} bytes)`);
  }
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (failures.length > 0) {
    throw new Error(`game flag environment audit found ${failures.length} failure(s)`);
  }
  return report;
}

function asPersistedRow(row: AuditDatabaseRow): PersistedFlagEnvironmentRow {
  const suffix = String(row.seq + 1).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${suffix}`,
    owner_id: "audit-owner",
    owner_username: "Audit Player",
    owner_color: "#38bdf8",
    name: `Flag ${row.seq + 1}`,
    lat: row.lat,
    lon: row.lon,
    package_id: row.package_id,
    elevation_m: row.elevation_m,
    terrain_class: row.terrain_class,
    biome: row.biome,
    ecoregion: row.ecoregion,
    claim_radius_m: DEFAULT_FLAG_CLAIM_RADIUS_M,
    city_id: null,
    environment_snapshot: row.environment_snapshot,
    created_at: new Date("2026-07-13T00:00:00.000Z"),
    updated_at: new Date("2026-07-13T00:00:00.000Z")
  };
}

function assertEquivalent(
  details: ReturnType<typeof normalizeFlagEnvironmentDetails>,
  world: Awaited<ReturnType<WorldLookupClient["lookup"]>>,
  point: AuditPoint
): void {
  if (details.coordinates.latitude !== point.latitude || details.coordinates.longitude !== point.longitude) {
    throw new Error("coordinate changed during persistence round-trip");
  }
  if (details.coordinates.packageId !== world.packageId || details.coordinates.packageId !== point.package_id) {
    throw new Error("package ID changed during persistence round-trip");
  }
  if (details.ecology.biomeId !== (world.biomeId ?? null) || details.ecology.ecoregionId !== (world.ecoregionId ?? null)) {
    throw new Error("ecology IDs changed during persistence round-trip");
  }
  for (const id of [details.ecology.biomeId, details.ecology.ecoregionId, details.water.supportingRiver.id]) {
    if (id?.endsWith(".0")) throw new Error(`non-canonical numeric ID ${id}`);
  }
  if (details.ecology.resolution !== (world.ecologyResolution ?? null)) {
    throw new Error("ecology resolution changed during persistence round-trip");
  }
  if (details.water.nearest.sourceType !== (world.nearestWaterSourceType ?? null) ||
      details.water.nearest.distanceM !== (world.nearestWaterSourceDistanceM ?? null) ||
      details.water.supportingRiver.id !== (world.supportingRiverId ?? null)) {
    throw new Error("water metadata changed during persistence round-trip");
  }
  JSON.stringify(details);
}

function assertDisposableDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "").toLowerCase();
  if (databaseName === "ash_atlas_game" || !/(audit|test|validation)/.test(databaseName)) {
    throw new Error(`refusing flag audit against non-disposable database ${databaseName || "<unknown>"}`);
  }
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = loadConfig();
  const inputPath = argument("--input");
  const outputPath = argument("--output") ?? path.resolve("reports", "game_flag_environment_audit_v1.json");
  if (!inputPath) throw new Error("--input <map audit JSON> is required");
  runFlagEnvironmentAudit({ inputPath: path.resolve(inputPath), outputPath, databaseUrl: config.DATABASE_URL, config })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
