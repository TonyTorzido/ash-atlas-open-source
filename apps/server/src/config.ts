import { isIP } from "node:net";

import { z } from "zod";
import {
  DEFAULT_COMBAT_DELTA_HZ,
  DEFAULT_COMBAT_INTEREST_RADIUS_M,
  DEFAULT_COMBAT_SPATIAL_CELL_M,
  DEFAULT_DEV_MOB_SPAWN_DISTANCE_M,
  DEFAULT_FLAG_CLAIM_RADIUS_M,
  DEFAULT_INTERACTION_RADIUS_M,
  DEFAULT_FLAG_PREPARE_BUFFER_M,
  DEFAULT_FLAG_PREPARE_RADIUS_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  DEFAULT_MOVE_LEASH_RADIUS_M,
  DEFAULT_PLAYER_SPEED_MPS,
  DEFAULT_PLAYER_BASIC_DAMAGE,
  DEFAULT_PLAYER_MAX_HEALTH,
  DEFAULT_PLAYER_SPAWN,
  MARKET_MAX_MUTATION_TRADES,
  NATIVE_COMPATIBILITY_DEFAULT_BUILD,
  NATIVE_COMPATIBILITY_DEFAULT_VERSION,
  NATIVE_COMPATIBILITY_DISABLED_MIN_BUILD,
  NATIVE_COMPATIBILITY_DISABLED_MIN_VERSION,
  NATIVE_COMPATIBILITY_WS_MAX_VERSION,
  NATIVE_COMPATIBILITY_WS_MIN_VERSION,
  POPULATION_VISIBLE_PREPARATION_TERMINAL_MS,
  type SkillSystemV3RuntimeCapabilities,
  flagRadiusContractIssues
} from "@ash-atlas/shared";
import { parseCertDigestList } from "./auth/trust/attestation/playIntegrityVerdict.js";
import { collectibleHarvestDurationMs } from "./game/items.js";
import {
  POPULATION_PLAN_VERSION,
  POPULATION_SPAWN_RULES_VERSION
} from "./game/populationZonesV2Identity.js";

const numberFromEnv = z.preprocess((value) => {
  if (value === undefined || value === "") {
    return undefined;
  }
  return Number(value);
}, z.number().finite());

const booleanFromEnv = z.preprocess((value) => {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return String(value).toLowerCase() === "true";
}, z.boolean());

const positiveIntegerFromEnv = z.preprocess((value) => {
  if (value === undefined || value === "") {
    return undefined;
  }
  return Number(value);
}, z.number().int().positive());

const nonnegativeIntegerFromEnv = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  return Number(value);
}, z.number().int().nonnegative());

/**
 * Trust risk signals outside the environment family (owner decisions
 * 2026-10-04): weights apply whenever the owning gate is not off. Server-only
 * and secret: never sent to clients or shown to players.
 */
export const DEFAULT_TRUST_RISK_SIGNAL_WEIGHTS: Readonly<Record<string, number>> = {
  // Relocating within TRUST_KINGDOM_PROXIMITY_RED_KM of another account's kingdom seat/territory.
  kingdom_proximity: 3,
  // Relocating within TRUST_KINGDOM_ALERT_RADIUS_KM of another player's city or territory.
  territory_proximity: 1,
  // One account on 2+ native devices, or seen from distant places at the same time.
  account_shared: 3,
  // Repeated implausible jumps between distant regions (passive + relocation fixes).
  state_hopping: 4
};

/**
 * Environment + integrity signal weights (plan §8.9), applied only while
 * TRUST_ENVIRONMENT_SIGNALS_MODE=enforce (shadow records them at 0). Owner
 * decision F (2026-10-04): non-zero defaults; TRUST_ENVIRONMENT_SIGNAL_WEIGHTS
 * overrides single rules. Secret; server-only.
 */
export const DEFAULT_TRUST_ENVIRONMENT_SIGNAL_WEIGHTS: Readonly<Record<string, number>> = {
  env_emulator: 2,
  pi_virtual_integrity: 2,
  env_root: 2,
  env_debugger: 0.5,
  env_sideload: 0.5,
  env_vpn_active: 1,
  env_sim_country_mismatch: 1.5,
  env_network_country_mismatch: 1.5,
  env_cell_country_mismatch: 1.5,
  env_timezone_country_mismatch: 1,
  gnss_zero_satellites: 2,
  install_multi_account: 3,
  devicecheck_spoof_bit: 3,
  pi_high_device_activity: 1,
  pi_risky_app_access: 1
};

// "rule=weight,rule=weight" over the given defaults (an entry overrides one rule; 0 silences it).
function signalWeightsFromEnv(defaults: Readonly<Record<string, number>>, label: string) {
  return z.string().default("").transform((value, context) => {
    const weights: Record<string, number> = { ...defaults };
    for (const entry of value.split(",").map((part) => part.trim()).filter(Boolean)) {
      const match = /^([a-z0-9_]{1,64})=(-?\d+(?:\.\d+)?)$/u.exec(entry);
      if (!match || Math.abs(Number(match[2])) > 10) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `invalid ${label} signal weight: ${entry}` });
        return z.NEVER;
      }
      weights[match[1]!] = Number(match[2]);
    }
    return weights;
  });
}

const optionalStringFromEnv = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  return value;
}, z.string().trim().min(1).optional());

const emailAddressFromEnv = optionalStringFromEnv.superRefine((value, context) => {
  if (value === undefined) return;
  if (/[\r\n]/.test(value)) {
    context.addIssue({
      code: z.ZodIssueCode.invalid_string,
      validation: "email",
      message: "Invalid email"
    });
    return;
  }
  const displayNameMatch = value.match(/^([^<>]*)<([^<>]+)>$/);
  const address = displayNameMatch?.[2]?.trim() ?? value;
  if (!z.string().email().safeParse(address).success) {
    context.addIssue({
      code: z.ZodIssueCode.invalid_string,
      validation: "email",
      message: "Invalid email"
    });
  }
});

const DEV_SESSION_KEY = "development-only-session-hmac-key-change-me";
const DEV_DEVICE_KEY = "development-only-device-hmac-key-change-me";
const DEV_NETWORK_KEY = "development-only-network-hmac-key-change-me";
const DEV_INITIAL_SPAWN_KEY = "development-only-initial-spawn-key-change-me";
const DEV_DOG_GENETICS_KEY = "development-only-dog-genetics-key-change-me";
const DEV_EMAIL_CODE_KEY = "development-only-email-code-hmac-key-change-me";
const DEFAULT_AUTH_EMAIL_FROM = "Ash Atlas <no-reply@localhost>";
export const MAX_FLAG_CLAIM_RADIUS_M = 10_000;

const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    RUNTIME_LABEL: z.string().trim().min(1).max(64).optional(),
    RUNTIME_BRANCH: z.string().trim().min(1).max(128).optional(),
    RUNTIME_SHA: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    RUNTIME_GENERATION: z.string().regex(/^test\/t[0-9]{3,}$/).optional(),
    PUBLIC_RELEASE_METADATA_PATH: optionalStringFromEnv.pipe(z.string().max(512).optional()),
    PORT: numberFromEnv.default(3001),
    CLIENT_ORIGIN: z.string().url().default("http://127.0.0.1:5173"),
    DATABASE_URL: z
      .string()
      .min(1)
      .default("postgres://ash_atlas:ash_atlas@127.0.0.1:35432/ash_atlas_game"),
    DB_POOL_MAX: positiveIntegerFromEnv.default(10),
    DB_POOL_CONNECTION_TIMEOUT_MS: nonnegativeIntegerFromEnv.default(0),
    DB_POOL_IDLE_TIMEOUT_MS: nonnegativeIntegerFromEnv.default(10_000),
    DB_READINESS_TIMEOUT_MS: positiveIntegerFromEnv.default(2_000),
    TELEMETRY_ENABLED: booleanFromEnv.default(false),
    BUG_REPORTS_ENABLED: booleanFromEnv.default(false),
    BUG_REPORTS_MAX_PER_TEN_MINUTES: positiveIntegerFromEnv
      .pipe(z.number().max(20))
      .default(3),
    BUG_REPORT_EMAIL_API_KEY: optionalStringFromEnv,
    BUG_REPORT_EMAIL_FROM: emailAddressFromEnv,
    BUG_REPORT_EMAIL_TIMEOUT_MS: positiveIntegerFromEnv
      .pipe(z.number().max(30_000))
      .default(8_000),
    TELEMETRY_CLIENT_ENABLED: booleanFromEnv.default(true),
    TELEMETRY_HOST_ENABLED: booleanFromEnv.default(false),
    TELEMETRY_EXPORT_ENABLED: booleanFromEnv.default(false),
    TELEMETRY_SEGMENT_ROTATION_ENABLED: booleanFromEnv.default(true),
    TELEMETRY_SEGMENT_DURATION_MS: positiveIntegerFromEnv
      .pipe(z.number().min(60_000).max(86_400_000))
      .default(3_600_000),
    TELEMETRY_DATABASE_URL: z.string().url().optional(),
    TELEMETRY_RELEASE_GENERATION: z
      .string()
      .regex(/^test\/t[0-9]+$/)
      .optional(),
    TELEMETRY_POPULATION_PLAN_VERSION: z.string().trim().min(1).max(160)
      .default(POPULATION_PLAN_VERSION),
    TELEMETRY_POPULATION_SPAWN_RULES_VERSION: z.string().trim().min(1).max(160)
      .default(POPULATION_SPAWN_RULES_VERSION),
    TELEMETRY_BALANCE_VERSION: z.string().trim().min(1).max(160).default("balance-v1"),
    TELEMETRY_SERVER_SAMPLE_INTERVAL_MS: positiveIntegerFromEnv.default(10_000),
    TELEMETRY_WORLD_SAMPLE_INTERVAL_MS: positiveIntegerFromEnv.default(30_000),
    TELEMETRY_WORLD_RECONCILIATION_INTERVAL_MS: positiveIntegerFromEnv.default(600_000),
    TELEMETRY_PLAYER_SAMPLE_INTERVAL_MS: positiveIntegerFromEnv.default(300_000),
    TELEMETRY_INVENTORY_CHECKPOINT_INTERVAL_MS: positiveIntegerFromEnv.default(1_800_000),
    TELEMETRY_CLIENT_SAMPLE_INTERVAL_MS: positiveIntegerFromEnv.default(30_000),
    TELEMETRY_FLUSH_INTERVAL_MS: positiveIntegerFromEnv.default(1_000),
    TELEMETRY_MAX_BATCH_ROWS: positiveIntegerFromEnv.pipe(z.number().max(2_000)).default(500),
    TELEMETRY_QUEUE_MAX_ROWS: positiveIntegerFromEnv.pipe(z.number().max(100_000))
      .default(10_000),
    TELEMETRY_DB_POOL_MAX: positiveIntegerFromEnv.pipe(z.number().max(2)).default(2),
    TELEMETRY_WRITE_TIMEOUT_MS: positiveIntegerFromEnv.default(500),
    TELEMETRY_SHUTDOWN_TIMEOUT_MS: positiveIntegerFromEnv.default(2_000),
    TELEMETRY_DEGRADE_QUEUE_PERCENT: positiveIntegerFromEnv.pipe(z.number().max(100))
      .default(80),
    TELEMETRY_DEGRADE_EVENT_LOOP_P99_MS: positiveIntegerFromEnv.default(100),
    TELEMETRY_RECOVERY_HEALTHY_INTERVALS: positiveIntegerFromEnv.default(3),
    WORLD_ID: z.string().trim().min(1).max(64).default("main"),
    WORLD_API_BASE: z.string().url().default("http://127.0.0.1:8765"),
    WORLD_REQUIRED_RELEASE_ID: z.string().min(1).default("world-packages-v1"),
    WORLD_REQUIRED_PROFILE_SET_FINGERPRINT: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .default("36dc3eb8bd36e32f7dc92084f1520d3180e6ce1a6c4f06354f7c1b34d6014553"),
    WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .default("db08e6eb96caa4755f58780f952588efc90c3e644f867d77c87b2955b51d38bd"),
    WORLD_REQUIRED_BOUNDARY_RELEASE_ID: z.string().min(1).default("world-boundaries-v1"),
    WORLD_LOOKUP_TIMEOUT_MS: positiveIntegerFromEnv.default(2_000),
    WATER_COLLECTION_CADENCE_MS: positiveIntegerFromEnv.default(
      collectibleHarvestDurationMs("water")
    ),
    HTTP_STANDARD_RATE_PER_MINUTE: positiveIntegerFromEnv.default(120),
    HTTP_EXPENSIVE_RATE_PER_MINUTE: positiveIntegerFromEnv.default(30),
    HTTP_NETWORK_RATE_MULTIPLIER: positiveIntegerFromEnv.pipe(z.number().max(100)).default(4),
    HTTP_STANDARD_CONCURRENCY: positiveIntegerFromEnv.default(64),
    HTTP_STANDARD_QUEUE_MAX: positiveIntegerFromEnv.default(128),
    HTTP_STANDARD_QUEUE_TIMEOUT_MS: positiveIntegerFromEnv.default(1_000),
    HTTP_EXPENSIVE_CONCURRENCY: positiveIntegerFromEnv.default(8),
    HTTP_EXPENSIVE_QUEUE_MAX: positiveIntegerFromEnv.default(32),
    HTTP_EXPENSIVE_QUEUE_TIMEOUT_MS: positiveIntegerFromEnv.default(2_000),
    RESOURCE_ENVIRONMENT_BATCH_TIMEOUT_MS: positiveIntegerFromEnv.default(10_000),
    RESOURCE_PREPARATION_CONCURRENCY: positiveIntegerFromEnv.pipe(z.number().max(8)).default(2),
    ENVIRONMENT_PROFILE_PREPARATION_CONCURRENCY:
      positiveIntegerFromEnv.pipe(z.number().max(8)).default(2),
    RESOURCE_JOB_PENDING_MAX: positiveIntegerFromEnv.default(1_024),
    RESOURCE_JOB_COMPLETION_SUBSCRIBERS_MAX: positiveIntegerFromEnv.default(4_096),
    RESOURCE_JOB_SUBSCRIBERS_PER_JOB_MAX: positiveIntegerFromEnv.default(128),
    RESOURCE_JOB_LEASE_MS: positiveIntegerFromEnv.default(60_000),
    RESOURCE_JOB_RETRY_POLL_MS: positiveIntegerFromEnv.default(1_000),
    RESOURCE_JOB_MAX_ATTEMPTS: positiveIntegerFromEnv.default(8),
    WORLD_OVERLAY_MAX_FEATURES: positiveIntegerFromEnv.default(2_000),
    WORLD_OVERLAY_MAX_PACKAGES: positiveIntegerFromEnv.default(64),
    WORLD_WATER_CACHE_MAX_ENTRIES: positiveIntegerFromEnv.default(256),
    WORLD_WATER_CACHE_MAX_BYTES: positiveIntegerFromEnv.default(4_194_304),
    WORLD_WATER_CACHE_TTL_MS: positiveIntegerFromEnv.default(300_000),
    ALLOW_DEGRADED_WORLD_LOOKUPS_IN_DEV: booleanFromEnv.default(false),
    REGION_CODE: z.string().min(1).default("GLOBAL"),
    DEFAULT_SPAWN_LAT: numberFromEnv.default(DEFAULT_PLAYER_SPAWN.lat),
    DEFAULT_SPAWN_LON: numberFromEnv.default(DEFAULT_PLAYER_SPAWN.lon),
    PLAYER_SPEED_MPS: numberFromEnv.default(DEFAULT_PLAYER_SPEED_MPS),
    SERVER_TICK_HZ: numberFromEnv.default(20),
    /** Action combat (SWING swing-to-hit). Off: SWING is answered with SWING_RESULT rejected "disabled". */
    ACTION_COMBAT_ENABLED: booleanFromEnv.default(false),
    /** Mob tactics (attack tokens, surround slots, separation; docs/plans/mob-ai-phase1.md). Needs ACTION_COMBAT_ENABLED too. */
    MOB_TACTICS_ENABLED: booleanFromEnv.default(false),
    /** Mob archetypes (movement style, rhythm, one signature move; docs/plans/mob-ai-phase2.md). Needs ACTION_COMBAT_ENABLED and MOB_TACTICS_ENABLED too. */
    MOB_ARCHETYPES_ENABLED: booleanFromEnv.default(false),
    /**
     * Cleric holy arc (docs/plans/class-roster-v2.md 5): a readied scepter casts the holy arc, healing allies on its
     * line. Needs ACTION_COMBAT_ENABLED too. Off: the scepter swings like any melee weapon.
     */
    CLERIC_ARC_ENABLED: booleanFromEnv.default(false),
    /** Damage matrix v4 + 5%-per-level rule for PvE, PvP and mob-versus-mob hits (docs/plans/class-roster-v2.md). Off: v3. */
    DAMAGE_MATRIX_V4_ENABLED: booleanFromEnv.default(false),
    /** Optional narrow rollout: comma list of archetype ids (brute, pack, skirmisher, caster, swarmer); empty = all. */
    MOB_ARCHETYPES_ONLY: z.string().default(""),
    /**
     * Telegraph time (docs/plans/telegraph-time.md): multiplies every managed-mob windup and telegraph. Clamped to
     * 1-3 by the engine; applies only with ACTION_COMBAT_ENABLED and MOB_TACTICS_ENABLED. Change it and restart.
     */
    MOB_TELEGRAPH_SCALE: numberFromEnv.default(1),
    /**
     * Dev/e2e only: players take no damage (every hit resolves as a dodge), so a full pack can be watched. Honoured
     * only with DEV_TOOLS_ENABLED=true and NODE_ENV other than production.
     */
    DEV_PLAYERS_INVULNERABLE: booleanFromEnv.default(false),
    /**
     * Dev/e2e only: player hits on mobs are multiplied by this (1 = off), so a long dungeon run can be cleared by a
     * fresh test character while it still takes real damage. Same gating as DEV_PLAYERS_INVULNERABLE.
     */
    DEV_PLAYER_DAMAGE_MULTIPLIER: z.coerce.number().min(1).max(1_000).default(1),
    /** Per-swing `swing_resolved` / `swing_rejected` log lines at info (off: only rejections, at debug, which the info logger drops). */
    SWING_DEBUG_LOG: booleanFromEnv.default(false),
    COMBAT_PLAYER_MAX_HEALTH: numberFromEnv.default(DEFAULT_PLAYER_MAX_HEALTH),
    COMBAT_PLAYER_BASIC_DAMAGE: numberFromEnv.default(DEFAULT_PLAYER_BASIC_DAMAGE),
    COMBAT_SPATIAL_CELL_M: numberFromEnv.default(DEFAULT_COMBAT_SPATIAL_CELL_M),
    COMBAT_INTEREST_RADIUS_M: numberFromEnv.default(DEFAULT_COMBAT_INTEREST_RADIUS_M),
    COMBAT_DELTA_HZ: numberFromEnv.default(DEFAULT_COMBAT_DELTA_HZ),
    COMBAT_MAX_CHASES_PER_TICK: positiveIntegerFromEnv.default(2_048),
    WORLD_DELTA_HZ: numberFromEnv.default(20),
    WORLD_COMMAND_QUEUE_GLOBAL_MAX: positiveIntegerFromEnv.default(4_096),
    WORLD_COMMAND_QUEUE_PER_PLAYER_MAX: positiveIntegerFromEnv.default(32),
    WORLD_COMMANDS_PER_TICK_MAX: positiveIntegerFromEnv.default(1_024),
    WORLD_RESYNC_MIN_INTERVAL_MS: positiveIntegerFromEnv.default(2_000),
    WS_BACKPRESSURE_SOFT_BYTES: positiveIntegerFromEnv.default(524_288),
    WS_BACKPRESSURE_HARD_BYTES: positiveIntegerFromEnv.default(4_194_304),
    WS_BACKPRESSURE_MAX_SKIPS: positiveIntegerFromEnv.default(20),
    WS_MAX_PAYLOAD_BYTES: positiveIntegerFromEnv.default(65_536),
    WS_BOOTSTRAP_TIMEOUT_MS: positiveIntegerFromEnv.default(15_000),
    RECONNECT_GRACE_MS: positiveIntegerFromEnv.default(180_000),
    LINKDEAD_WORLD_PRESENCE_MS: positiveIntegerFromEnv.default(30_000),
    WS_HEARTBEAT_TIMEOUT_MS: positiveIntegerFromEnv.default(20_000),
    WS_HEARTBEAT_SWEEP_MS: positiveIntegerFromEnv.default(5_000),
    WS_MARKET_REQUESTS_PER_10_SECONDS: positiveIntegerFromEnv.default(40),
    WS_MARKET_IP_REQUESTS_PER_10_SECONDS: positiveIntegerFromEnv.default(160),
    COMBAT_PERSISTENCE_BATCH_SIZE: positiveIntegerFromEnv.default(50),
    COMBAT_PERSISTENCE_CONCURRENCY: positiveIntegerFromEnv.default(2),
    PLAYER_PERSISTENCE_CONCURRENCY: positiveIntegerFromEnv.pipe(z.number().max(32)).default(8),
    COMBAT_REWARD_RETRY_INTERVAL_MS: positiveIntegerFromEnv.default(1_000),
    SHUTDOWN_FLUSH_TIMEOUT_MS: positiveIntegerFromEnv.default(5_000),
    DEV_MOB_MAX_SPAWN_DISTANCE_M: numberFromEnv.default(DEFAULT_DEV_MOB_SPAWN_DISTANCE_M),
    FLAG_CLAIM_RADIUS_M: numberFromEnv
      .pipe(z.number().positive().max(MAX_FLAG_CLAIM_RADIUS_M))
      .default(DEFAULT_FLAG_CLAIM_RADIUS_M),
    FLAG_RESOURCE_VISION_RADIUS_M: numberFromEnv
      .pipe(z.number().positive().max(MAX_FLAG_CLAIM_RADIUS_M))
      .default(DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M),
    FLAG_SCOPED_SNAPSHOT_ENABLED: booleanFromEnv.default(true),
    FLAG_PREPARE_BUFFER_M: numberFromEnv
      .pipe(z.number().positive().max(MAX_FLAG_CLAIM_RADIUS_M))
      .default(DEFAULT_FLAG_PREPARE_BUFFER_M),
    FLAG_PREPARE_RADIUS_M: numberFromEnv
      .pipe(z.number().positive().max(MAX_FLAG_CLAIM_RADIUS_M))
      .default(DEFAULT_FLAG_PREPARE_RADIUS_M),
    FLAG_BUILD_DURATION_MS: positiveIntegerFromEnv.default(10_000),
    // Full-circle global benchmarks select immediate preparation via the documented p95 formula.
    FLAG_BUILD_PREWARM_DELAY_MS: z.coerce.number().int().min(0).default(0),
    CITY_FLAG_CONVERSION_DURATION_MS: positiveIntegerFromEnv.default(10_000),
    CITY_FOUNDING_ANNEX_RADIUS_M: numberFromEnv.pipe(z.number().positive()).default(750),
    CITY_SNAPSHOT_RADIUS_M: numberFromEnv.pipe(z.number().positive()).default(10_000),
    CITY_SNAPSHOT_LIMIT: positiveIntegerFromEnv.default(500),
    MOVE_LEASH_RADIUS_M: numberFromEnv.default(DEFAULT_MOVE_LEASH_RADIUS_M),
    MAX_BUILD_DISTANCE_M: numberFromEnv.default(DEFAULT_INTERACTION_RADIUS_M),
    ALLOW_UNRESOLVED_FLAGS_IN_DEV: booleanFromEnv.default(true),
    DEV_TOOLS_ENABLED: booleanFromEnv.optional(),
    DEV_ADMIN_TOOLS_ENABLED: booleanFromEnv.default(false),
    DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED: booleanFromEnv.default(false),
    POPULATION_V2_ACTIVE_PREPARATION_CONCURRENCY:
      positiveIntegerFromEnv.pipe(z.number().max(4)).default(4),
    POPULATION_LOCALITY_MAX_FLAGS:
      positiveIntegerFromEnv.pipe(z.number().max(16)).default(12),
    POPULATION_LOCALITY_MAX_DISTINCT_ZONES:
      positiveIntegerFromEnv.pipe(z.number().max(32)).default(16),
    POPULATION_LOCALITY_INTEREST_TTL_MS:
      positiveIntegerFromEnv.pipe(z.number().max(120_000)).default(30_000),
    POPULATION_V2_PROFILE_PREPARATION_CONCURRENCY:
      positiveIntegerFromEnv.pipe(z.number().max(2)).default(2),
    POPULATION_V2_ZONE_QUEUE_MAX:
      positiveIntegerFromEnv.pipe(z.number().max(1_024)).default(128),
    POPULATION_V2_PROFILE_QUEUE_MAX:
      positiveIntegerFromEnv.pipe(z.number().max(4_096)).default(256),
    POPULATION_V2_RETRY_MIN_MS:
      positiveIntegerFromEnv.pipe(z.number().max(60_000)).default(5_000),
    POPULATION_V2_RETRY_MAX_MS:
      positiveIntegerFromEnv.pipe(z.number().max(300_000)).default(60_000),
    POPULATION_V2_VISIBLE_PREPARATION_STALE_MS:
      positiveIntegerFromEnv.pipe(z.number().max(120_000)).default(15_000),
    POPULATION_V2_VISIBLE_PREPARATION_TERMINAL_MS:
      positiveIntegerFromEnv
        .pipe(z.number().max(POPULATION_VISIBLE_PREPARATION_TERMINAL_MS))
        .default(POPULATION_VISIBLE_PREPARATION_TERMINAL_MS),
    POPULATION_V2_VISIBLE_PREPARATION_RETRY_LIMIT:
      positiveIntegerFromEnv.pipe(z.number().max(3)).default(1),
    POPULATION_V2_SLEEP_GRACE_MS:
      positiveIntegerFromEnv.pipe(z.number().max(300_000)).default(60_000),
    POPULATION_V2_DESCRIPTOR_CACHE_MAX_ZONES:
      positiveIntegerFromEnv.pipe(z.number().max(4_096)).default(128),
    POPULATION_V2_DESCRIPTOR_CACHE_MAX_BYTES:
      positiveIntegerFromEnv
        .pipe(z.number().max(512 * 1_024 * 1_024))
        .default(16 * 1_024 * 1_024),
    POPULATION_V2_DESCRIPTOR_CACHE_TTL_MS:
      positiveIntegerFromEnv.pipe(z.number().max(3_600_000)).default(300_000),
    POPULATION_TRAVEL_PREFLIGHT_ENABLED:
      booleanFromEnv.default(false),
    FLAG_VISIBLE_VISIT_PREPARATION_TTL_MS:
      positiveIntegerFromEnv.pipe(z.number().max(60_000)).default(15_000),
    POPULATION_INFLIGHT_RESULT_REUSE_ENABLED:
      booleanFromEnv.default(true),
    POPULATION_PROFILE_CLAIM_NOOP_FAST_PATH_ENABLED:
      booleanFromEnv.default(true),
    POPULATION_SOFT_TRAVEL_PREPARE_ENABLED:
      booleanFromEnv.default(false),
    POPULATION_SOFT_TRAVEL_ACTIVATION_LEAD_MS:
      z.coerce.number().int().min(0).max(15_000).default(1_250),
    POPULATION_SOFT_TRAVEL_DURABLE_CONCURRENCY:
      positiveIntegerFromEnv.pipe(z.number().max(8)).default(2),
    POPULATION_SOFT_TRAVEL_PROMOTION_CONCURRENCY:
      positiveIntegerFromEnv.pipe(z.number().max(4)).default(1),
    POPULATION_SOFT_TRAVEL_RESERVATION_TTL_MS:
      positiveIntegerFromEnv.pipe(z.number().max(120_000)).default(25_000),
    POPULATION_TELEPORT_PUBLICATION_COALESCING_ENABLED:
      booleanFromEnv.default(false),
    POPULATION_TRAVEL_OPTIONAL_ARRIVAL_SEQUENCING_ENABLED:
      booleanFromEnv.default(false),
    POPULATION_TRAVEL_PREFLIGHT_TIMEOUT_MS:
      positiveIntegerFromEnv.pipe(z.number().max(120_000)).default(15_000),
    POPULATION_TRAVEL_VISIBLE_READY_TIMEOUT_MS:
      positiveIntegerFromEnv.pipe(z.number().max(120_000)).default(15_000),
    POPULATION_V2_MOB_ROLLOUT_ENABLED:
      booleanFromEnv.default(false),
    POPULATION_V2_MOB_ROLLOUT_KINDS:
      z.string().default(""),
    POPULATION_V2_MOB_ROLLOUT_QUEUE_MAX:
      positiveIntegerFromEnv.pipe(z.number().max(256)).default(64),
    POPULATION_V2_MOB_ROLLOUT_MIN_DELAY_MS:
      z.coerce.number().int().min(0).max(60_000).default(25),
    POPULATION_V2_MOB_ROLLOUT_MAX_ATTEMPTS:
      positiveIntegerFromEnv.pipe(z.number().max(8)).default(4),
    DEV_AUTHORIZED_GOOGLE_SUBJECTS: z.string().default(""),
    DEV_PRIVATE_LEADERBOARD_GOOGLE_SUBJECTS: z.string().default(""),
    TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: z.string().default(""),
    INITIAL_SPAWN_HMAC_KEY: z.string().min(32).default(DEV_INITIAL_SPAWN_KEY),
    DOG_GENETICS_HMAC_KEY: z.string().min(32).default(DEV_DOG_GENETICS_KEY),
    INITIAL_SPAWN_MAX_ATTEMPTS: positiveIntegerFromEnv.pipe(z.number().max(1_024)).default(256),
    AUTH_RUNTIME_MODE: z.enum(["local", "private", "public"]).default("public"),
    AUTH_MODE: z.enum(["google", "dev"]).default("dev"),
    AUTH_DEV_LOGIN_ENABLED: booleanFromEnv.default(false),
    GOOGLE_CLIENT_ID: z.string().trim().default(""),
    APP_PUBLIC_ORIGIN: z.string().url().default("http://127.0.0.1:5173"),
    // Apple remains fail-closed until the production Services ID, key, and
    // runtime-only refresh-token encryption key are supplied out of band.
    APPLE_SIGN_IN_ENABLED: booleanFromEnv.default(false),
    APPLE_TEAM_ID: z.string().trim().default(""),
    APPLE_SERVICES_ID: z.string().trim().default(""),
    // Bundle id accepted as the audience of native Sign in with Apple tokens. Empty = web Services ID only.
    APPLE_NATIVE_BUNDLE_ID: z.string().trim().default(""),
    APPLE_KEY_ID: z.string().trim().default(""),
    APPLE_PRIVATE_KEY_P8_BASE64: z.string().trim().default(""),
    APPLE_REFRESH_TOKEN_KEY_ID: z.string().trim().default(""),
    APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64: z.string().trim().default(""),
    NATIVE_PUSH_REGISTRATION_ENABLED: booleanFromEnv.default(false),
    NATIVE_PUSH_ENQUEUE_ENABLED: booleanFromEnv.default(false),
    NATIVE_PUSH_DELIVERY_ENABLED: booleanFromEnv.default(false),
    NATIVE_PUSH_ACCOUNT_ALLOWLIST: z.string().default("").transform((value) => value.split(",").map((entry) => entry.trim()).filter(Boolean)).pipe(z.array(z.string().uuid())),
    NATIVE_PUSH_CATEGORY_ALLOWLIST: z.string().default("direct_message").transform((value) => value.split(",").map((entry) => entry.trim()).filter(Boolean)).pipe(z.array(z.enum(["direct_message","party_invite","kingdom_invite","package"]))),
    NATIVE_PUSH_TOKEN_KEY_ID: z.string().trim().default(""),
    NATIVE_PUSH_TOKEN_KEY_BASE64: z.string().trim().default(""),
    NATIVE_PUSH_APNS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("production"),
    NATIVE_PUSH_APNS_TEAM_ID: z.string().trim().default(""),
    NATIVE_PUSH_APNS_KEY_ID: z.string().trim().default(""),
    NATIVE_PUSH_APNS_PRIVATE_KEY_BASE64: z.string().trim().default(""),
    NATIVE_PUSH_APNS_TOPIC: z.string().trim().default("com.ashatlas.game"),
    NATIVE_PUSH_FCM_PROJECT_ID: z.string().trim().default(""),
    AUTH_ALLOWED_ORIGINS: z.string().default("http://127.0.0.1:5173"),
    // Development-only opt-in: exact https://<host>.ts.net[:port] origins (comma-separated) that may
    // sit in AUTH_ALLOWED_ORIGINS alongside development login, e.g. a Tailscale Serve phone link.
    // Rejected at boot unless development login is fully enabled in NODE_ENV=development.
    AUTH_DEV_EXTRA_ORIGINS: z.string().default(""),
    NATIVE_IOS_HARD_MIN_VERSION: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
      .default(NATIVE_COMPATIBILITY_DISABLED_MIN_VERSION),
    NATIVE_IOS_HARD_MIN_BUILD: nonnegativeIntegerFromEnv
      .default(NATIVE_COMPATIBILITY_DISABLED_MIN_BUILD),
    NATIVE_IOS_RECOMMENDED_MIN_VERSION: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
      .default(NATIVE_COMPATIBILITY_DEFAULT_VERSION),
    NATIVE_IOS_RECOMMENDED_MIN_BUILD: nonnegativeIntegerFromEnv
      .default(NATIVE_COMPATIBILITY_DEFAULT_BUILD),
    NATIVE_IOS_LATEST_VERSION: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
      .default(NATIVE_COMPATIBILITY_DEFAULT_VERSION),
    NATIVE_IOS_LATEST_BUILD: nonnegativeIntegerFromEnv.default(NATIVE_COMPATIBILITY_DEFAULT_BUILD),
    NATIVE_ANDROID_HARD_MIN_VERSION: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
      .default(NATIVE_COMPATIBILITY_DISABLED_MIN_VERSION),
    NATIVE_ANDROID_HARD_MIN_BUILD: nonnegativeIntegerFromEnv
      .default(NATIVE_COMPATIBILITY_DISABLED_MIN_BUILD),
    NATIVE_ANDROID_RECOMMENDED_MIN_VERSION: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
      .default(NATIVE_COMPATIBILITY_DEFAULT_VERSION),
    NATIVE_ANDROID_RECOMMENDED_MIN_BUILD: nonnegativeIntegerFromEnv
      .default(NATIVE_COMPATIBILITY_DEFAULT_BUILD),
    NATIVE_ANDROID_LATEST_VERSION: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
      .default(NATIVE_COMPATIBILITY_DEFAULT_VERSION),
    NATIVE_ANDROID_LATEST_BUILD: nonnegativeIntegerFromEnv
      .default(NATIVE_COMPATIBILITY_DEFAULT_BUILD),
    NATIVE_IOS_STORE_URL: z.string().url().optional(),
    NATIVE_ANDROID_STORE_URL: z.string().url().optional(),
    NATIVE_WS_MIN: positiveIntegerFromEnv.default(NATIVE_COMPATIBILITY_WS_MIN_VERSION),
    NATIVE_WS_MAX: positiveIntegerFromEnv.default(NATIVE_COMPATIBILITY_WS_MAX_VERSION),
    AUTH_TRUST_PROXY: z.string().default(""),
    AUTH_SESSION_TOKEN_HMAC_KEY: z.string().min(32).default(DEV_SESSION_KEY),
    AUTH_DEVICE_TOKEN_HMAC_KEY: z.string().min(32).default(DEV_DEVICE_KEY),
    AUTH_NETWORK_HMAC_KEY: z.string().min(32).default(DEV_NETWORK_KEY),
    AUTH_NETWORK_HMAC_KEY_VERSION: z.string().min(1).max(32).default("v1"),
    AUTH_SESSION_ABSOLUTE_DAYS: positiveIntegerFromEnv.default(30),
    AUTH_SESSION_INACTIVITY_DAYS: positiveIntegerFromEnv.default(14),
    AUTH_REQUIRE_GMAIL: booleanFromEnv.default(false),
    AUTH_DEV_ACCOUNT_EMAIL: z.string().email().default("developer@example.com"),
    AUTH_DEV_PLAYER_NAME: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9_]*[A-Za-z0-9])?$/)
      .min(3)
      .max(20)
      .default("Developer"),
    AUTH_LOGIN_IP_MAX: positiveIntegerFromEnv.default(20),
    AUTH_LOGIN_DEVICE_MAX: positiveIntegerFromEnv.default(10),
    AUTH_NEW_ACCOUNT_DEVICE_MAX: positiveIntegerFromEnv.default(3),
    AUTH_NEW_ACCOUNT_NETWORK_MAX: positiveIntegerFromEnv.default(5),
    // Email one-time-code sign-in stays hidden until a real sender is configured.
    AUTH_EMAIL_LOGIN_ENABLED: booleanFromEnv.default(false),
    AUTH_EMAIL_SENDER: z.enum(["log", "resend"]).default("log"),
    AUTH_EMAIL_RESEND_API_KEY: z.string().trim().default(""),
    AUTH_EMAIL_FROM: z.string().trim().min(3).max(320).default(DEFAULT_AUTH_EMAIL_FROM),
    AUTH_EMAIL_CODE_HMAC_KEY: z.string().min(32).default(DEV_EMAIL_CODE_KEY),
    AUTH_EMAIL_CODE_TTL_SECONDS: positiveIntegerFromEnv.pipe(z.number().max(3_600)).default(600),
    AUTH_EMAIL_CODE_RESEND_SECONDS: positiveIntegerFromEnv.pipe(z.number().max(3_600)).default(60),
    AUTH_EMAIL_CODE_PER_EMAIL_10MIN: positiveIntegerFromEnv.default(3),
    AUTH_EMAIL_CODE_PER_EMAIL_DAY: positiveIntegerFromEnv.default(10),
    AUTH_EMAIL_DOMAIN_POLICY: z.enum(["blocklist", "allowlist"]).default("allowlist"),
    AUTH_EMAIL_DOMAIN_ALLOWLIST: z.string().default(""),
    AUTH_EMAIL_DOMAIN_BLOCKLIST_EXTRA: z.string().default(""),
    AUTH_NEW_ACCOUNT_EMAIL_DEVICE_MAX: positiveIntegerFromEnv.default(2),
    AUTH_NEW_ACCOUNT_EMAIL_NETWORK_MAX: positiveIntegerFromEnv.default(3),
    AUTH_EMAIL_DEV_LOG_CODES: booleanFromEnv.default(false),
    PROFILE_LOOKUP_RATE_MAX: positiveIntegerFromEnv.default(120),
    PROFILE_EDIT_RATE_MAX: positiveIntegerFromEnv.default(10),
    SOCIAL_RELATIONSHIP_RATE_MAX: positiveIntegerFromEnv.default(120),
    FRIEND_REQUEST_SEND_RATE_MAX: positiveIntegerFromEnv.default(20),
    FRIEND_STATE_RATE_MAX: positiveIntegerFromEnv.default(60),
    ENEMY_MARK_RATE_MAX: positiveIntegerFromEnv.default(30),
    BLOCK_RATE_MAX: positiveIntegerFromEnv.default(30),
    SOCIAL_LIST_RATE_MAX: positiveIntegerFromEnv.default(60),
    CHAT_ENABLED: booleanFromEnv.default(true),
    CHAT_MESSAGE_MAX_LENGTH: positiveIntegerFromEnv.default(400),
    CHAT_TRANSLATION_GOOGLE_API_KEY: optionalStringFromEnv,
    CHAT_TRANSLATION_TIMEOUT_MS: positiveIntegerFromEnv
      .pipe(z.number().max(30_000))
      .default(5_000),
    CHAT_TRANSLATION_MONTHLY_CHAR_CAP: positiveIntegerFromEnv
      .pipe(z.number().max(450_000))
      .default(450_000),
    CHAT_HISTORY_PAGE_SIZE: positiveIntegerFromEnv.default(50),
    CHAT_CATCH_UP_LIMIT: positiveIntegerFromEnv.default(100),
    CHAT_RECENT_CACHE_LIMIT: positiveIntegerFromEnv.default(100),
    CHAT_RECENT_CACHE_TTL_MS: positiveIntegerFromEnv.default(300_000),
    CHAT_RATE_BUCKET_TTL_MS: positiveIntegerFromEnv.default(120_000),
    CHAT_MODERATION_QUEUE_LIMIT: positiveIntegerFromEnv.default(256),
    CHAT_AUTOMATED_MUTE_MAX_SECONDS: positiveIntegerFromEnv.default(900),
    KINGDOMS_FREE_CONSTRUCTION: booleanFromEnv.optional(),
    KINGDOM_INITIAL_TERRITORY_RADIUS_M: numberFromEnv.pipe(z.number().min(25).max(5_000)).default(200),
    KINGDOM_MIN_SEAT_SPACING_M: numberFromEnv.pipe(z.number().min(50).max(50_000)).default(650),
    KINGDOM_SNAPSHOT_RADIUS_M: numberFromEnv.pipe(z.number().positive()).default(25_000),
    KINGDOM_SNAPSHOT_LIMIT: positiveIntegerFromEnv.default(100),
    KINGDOM_OBJECT_SNAPSHOT_LIMIT: positiveIntegerFromEnv.default(250),
    KINGDOM_INVITATION_TTL_HOURS: positiveIntegerFromEnv.default(72),
    KINGDOM_PERK_QUALIFICATION_SECONDS: nonnegativeIntegerFromEnv.optional(),
    KINGDOM_CHAT_HISTORY_LIMIT: positiveIntegerFromEnv.default(100),
    KINGDOM_CHAT_RETENTION_LIMIT: positiveIntegerFromEnv.default(500),
    KINGDOM_DONATION_HISTORY_LIMIT: positiveIntegerFromEnv.default(100),
    KINGDOM_CHAT_RATE_MAX: positiveIntegerFromEnv.default(8),
    KINGDOM_CHAT_RATE_WINDOW_SECONDS: positiveIntegerFromEnv.default(10),
    KINGDOM_MUTATION_RATE_MAX: positiveIntegerFromEnv.default(30),
    KINGDOM_MUTATION_RATE_WINDOW_SECONDS: positiveIntegerFromEnv.default(10),
    KINGDOM_FOUNDING_QUOTE_RATE_MAX: positiveIntegerFromEnv.default(10),
    KINGDOM_SEAT_SPACING_BUFFER_M: numberFromEnv.pipe(z.number().positive()).default(50),
    KINGDOM_SEAT_FOOTPRINT_RADIUS_M: numberFromEnv.pipe(z.number().positive()).default(10),
    KINGDOM_COT_FOOTPRINT_RADIUS_M: numberFromEnv.pipe(z.number().positive()).default(2.5),
    KINGDOM_REPLAY_RETENTION_DAYS: positiveIntegerFromEnv.default(30),
    MARKET_GLOBAL_ACCESS: booleanFromEnv.default(false),
    MARKET_ALLOW_GLOBAL_ACCESS_IN_PRODUCTION: booleanFromEnv.default(false),
    MARKET_MAX_ACTIVE_ORDERS_PER_PLAYER: positiveIntegerFromEnv.default(25),
    MARKET_MAX_OPEN_ORDERS_PER_ITEM: positiveIntegerFromEnv.default(10),
    MARKET_MAX_RESTING_ORDERS_PER_ACCOUNT_BOOK: positiveIntegerFromEnv.default(5),
    MARKET_MAX_QUANTITY_PER_ORDER: positiveIntegerFromEnv.default(10_000),
    MARKET_MAX_UNIT_PRICE: positiveIntegerFromEnv.default(1_000_000_000),
    MARKET_MAX_TOTAL_ORDER_VALUE: positiveIntegerFromEnv.default(1_000_000_000_000),
    MARKET_REQUESTS_PER_MINUTE: positiveIntegerFromEnv.default(120),
    MARKET_CANCELLATIONS_PER_MINUTE: positiveIntegerFromEnv.default(60),
    MARKET_BROWSE_REQUESTS_PER_MINUTE: positiveIntegerFromEnv.default(60),
    MARKET_BOOK_REQUESTS_PER_MINUTE: positiveIntegerFromEnv.default(120),
    MARKET_QUOTE_REQUESTS_PER_MINUTE: positiveIntegerFromEnv.default(30),
    MARKET_SUBSCRIPTION_REQUESTS_PER_MINUTE: positiveIntegerFromEnv.default(30),
    MARKET_MAX_OUTSTANDING_QUOTES_PER_ACCOUNT_BOOK: positiveIntegerFromEnv.default(1),
    MARKET_MAX_CLAIMS_PER_REQUEST: positiveIntegerFromEnv.default(100),
    MARKET_MAX_SIMPLE_BUY_QUANTITY: positiveIntegerFromEnv.default(1_000),
    MARKET_MAX_DEPTH_LEVELS: positiveIntegerFromEnv.default(20),
    MARKET_MAX_SEARCH_RESULTS: positiveIntegerFromEnv.default(40),
    MARKET_QUOTE_TTL_SECONDS: positiveIntegerFromEnv.default(15),
    MARKET_READ_STATEMENT_TIMEOUT_MS: positiveIntegerFromEnv.default(3_000),
    MARKET_RECONCILIATION_INTERVAL_MS: positiveIntegerFromEnv.default(60_000),
    MARKET_RECONCILIATION_STALE_AFTER_MS: positiveIntegerFromEnv.default(180_000),
    MARKET_RECONCILIATION_STATEMENT_TIMEOUT_MS: positiveIntegerFromEnv.default(30_000),
    MARKET_RECONCILIATION_LOCK_TIMEOUT_MS: positiveIntegerFromEnv.default(15_000),
    MARKET_TRANSACTION_RETRY_LIMIT: positiveIntegerFromEnv.default(3),
    // Location trust (docs/architecture/ACCOUNT_TRUST_AND_ANTISPOOF_PLAN.md).
    TRUST_LOCATION_REJECT_MODE: z.enum(["off", "shadow", "enforce"]).default("shadow"),
    TRUST_LAND_ACTION_MODE: z.enum(["off", "shadow", "enforce"]).default("shadow"),
    TRUST_LOCATION_REPORT_RETENTION_DAYS: positiveIntegerFromEnv.default(180),
    TRUST_LAND_ACTION_MIN_DISPLACEMENT_M: nonnegativeIntegerFromEnv.default(500),
    TRUST_TRANSIT_HOLD_MINUTES: nonnegativeIntegerFromEnv.default(10),
    TRUST_SETTLE_ACCURACY_M: positiveIntegerFromEnv.default(5000),
    TRUST_QUARANTINE_MODE: z.enum(["off", "shadow", "enforce"]).default("shadow"),
    TRUST_LADDER_ACK: booleanFromEnv.default(false),
    TRUST_LADDER_MAX_TIER: nonnegativeIntegerFromEnv.pipe(z.number().max(6)).default(2),
    TRUST_DECAY_TAU_DAYS: numberFromEnv.pipe(z.number().positive()).default(7),
    TRUST_FAMILIAR_REGION_DAYS: positiveIntegerFromEnv.default(10),
    TRUST_FAMILIAR_REGION_STALE_DAYS: positiveIntegerFromEnv.default(90),
    TRUST_QUARANTINE_THRESHOLD: numberFromEnv.default(8),
    TRUST_QUARANTINE_THRESHOLD_NEW: numberFromEnv.default(6),
    TRUST_WARNING_THRESHOLD: numberFromEnv.default(15),
    TRUST_PASSIVE_FIX_ENABLED: booleanFromEnv.default(true),
    TRUST_PASSIVE_FIX_MIN_SECONDS: positiveIntegerFromEnv.pipe(z.number().min(60)).default(180),
    TRUST_PASSIVE_FIX_MAX_SECONDS: positiveIntegerFromEnv.pipe(z.number().min(60)).default(420),
    // Alt doorway protections: moving yourself is free; bringing others is earned.
    TRUST_DOORWAY_MODE: z.enum(["off", "shadow", "enforce"]).default("enforce"),
    TRUST_DOORWAY_MIN_ACCOUNT_AGE_DAYS: nonnegativeIntegerFromEnv.default(14),
    TRUST_DOORWAY_CONFIRMED_DAYS: positiveIntegerFromEnv.default(3),
    TRUST_PRESENCE_RADIUS_KM: positiveIntegerFromEnv.default(25),
    TRUST_PRESENCE_MAX_FIX_AGE_SECONDS: positiveIntegerFromEnv.default(600),
    TRUST_ARRIVAL_RAID_MODE: z.enum(["off", "shadow", "enforce"]).default("enforce"),
    TRUST_ARRIVAL_RAID_HOLD_MINUTES: positiveIntegerFromEnv.default(60),
    TRUST_LINKED_ALT_MODE: z.enum(["off", "shadow", "enforce"]).default("enforce"),
    // Settled status (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md §2). The
    // targets are secret: server-only, never in client payloads or player text.
    TRUST_SETTLED_GATE_MODE: z.enum(["off", "shadow", "enforce"]).default("enforce"),
    TRUST_SETTLE_ASSURANCE_MODE: z.enum(["shadow", "enforce"]).default("shadow"),
    TRUST_SETTLE_CHECKS_MIN: positiveIntegerFromEnv.pipe(z.number().max(500)).default(22),
    TRUST_SETTLE_CHECKS_MAX: positiveIntegerFromEnv.pipe(z.number().max(500)).default(30),
    TRUST_SETTLE_DAYS_MIN: positiveIntegerFromEnv.pipe(z.number().max(60)).default(4),
    TRUST_SETTLE_DAYS_MAX: positiveIntegerFromEnv.pipe(z.number().max(60)).default(6),
    TRUST_SETTLE_RADIUS_KM: positiveIntegerFromEnv.default(25),
    TRUST_SETTLE_MIN_GAP_SECONDS: positiveIntegerFromEnv.default(170),
    TRUST_SETTLE_MIN_DISTINCT_POSITIONS: positiveIntegerFromEnv.pipe(z.number().max(10)).default(3),
    TRUST_SETTLE_PROVISIONAL_DAYS: positiveIntegerFromEnv.default(30),
    TRUST_HOME_DESTINATION_RADIUS_KM: positiveIntegerFromEnv.default(50),
    TRUST_YOUNG_INVITER_DAYS: nonnegativeIntegerFromEnv.default(30),
    TRUST_YOUNG_INVITER_ARRIVAL_HOLD_MINUTES: positiveIntegerFromEnv.default(1440),
    // Relocation gates (NATIVE_ANTISPOOF_BUILD_PLAN.md 4.3, 6). Alert zones: red
    // refused in enforce; orange/yellow alert + difficulty in both.
    TRUST_ALERT_ZONE_MODE: z.enum(["off", "shadow", "enforce"]).default("enforce"),
    // Enforce: a red relocation by an account younger than this many days that
    // was never Settled locks the account (0 = never lock, refuse only).
    TRUST_RED_ZONE_LOCK_MAX_AGE_DAYS: nonnegativeIntegerFromEnv.pipe(z.number().max(365)).default(7),
    TRUST_KINGDOM_ALERT_RADIUS_KM: positiveIntegerFromEnv.default(10),
    // Relocating this close to another account's kingdom seat/territory: severity-4
    // alert + kingdom_proximity (no lock, no refusal). 0 disables.
    TRUST_KINGDOM_PROXIMITY_RED_KM: numberFromEnv.pipe(z.number().min(0).max(50)).default(3),
    TRUST_RISK_SIGNAL_WEIGHTS: signalWeightsFromEnv(DEFAULT_TRUST_RISK_SIGNAL_WEIGHTS, "risk"),
    TRUST_RELOCATION_NATIVE_ONLY_MODE: z.enum(["off", "shadow", "enforce"]).default("shadow"),
    // Hostile-action gate (NATIVE_ANTISPOOF_BUILD_PLAN.md 3.4): unsettled accounts
    // cannot attack players, flags or with military; nobody can hit them.
    TRUST_HOSTILE_GATE_MODE: z.enum(["off", "shadow", "enforce"]).default("shadow"),
    // Anchored destinations and private unsettled structures (plan 3.3).
    TRUST_ANCHOR_MODE: z.enum(["off", "shadow", "enforce"]).default("shadow"),
    // Mass-arrival alert (plan 3.5): distinct accounts one host brings in 60 min.
    TRUST_MASS_ARRIVAL_COUNT: positiveIntegerFromEnv.default(3),
    // Store-review accounts (Apple App Review, Play pre-launch): comma-separated
    // account ids treated as Settled, never red-zone locked or held; their trust
    // signals are recorded at weight 0 and never revoke Settled.
    // Device environment + integrity signals (plan §8.9): off records nothing,
    // shadow records every signal at weight 0, enforce applies the weights below.
    TRUST_ENVIRONMENT_SIGNALS_MODE: z.enum(["off", "shadow", "enforce"]).default("shadow"),
    // "rule=weight,rule=weight" over DEFAULT_TRUST_ENVIRONMENT_SIGNAL_WEIGHTS (e.g. env_vpn_active=0.5).
    TRUST_ENVIRONMENT_SIGNAL_WEIGHTS: signalWeightsFromEnv(DEFAULT_TRUST_ENVIRONMENT_SIGNAL_WEIGHTS, "environment"),
    // Distinct accounts on one install id (within attestation retention) that raise install_multi_account.
    // Owner decision C (2026-10-04): two accounts on one install already count.
    TRUST_INSTALL_ALT_ACCOUNT_THRESHOLD: positiveIntegerFromEnv.pipe(z.number().min(2).max(100)).default(2),
    // Account sharing (owner decision C): one account on this many native installs,
    // or seen from another device this fast (km/h) within the window.
    TRUST_ACCOUNT_SHARED_DEVICES: positiveIntegerFromEnv.pipe(z.number().min(2).max(20)).default(2),
    TRUST_ACCOUNT_SHARED_WINDOW_MINUTES: positiveIntegerFromEnv.pipe(z.number().max(1440)).default(120),
    TRUST_ACCOUNT_SHARED_MAX_KMH: positiveIntegerFromEnv.default(900),
    // State hopping (owner decision D): within the window, jumps between regions
    // farther apart than REGION_KM at more than MAX_KMH, at least MIN_HOPS of them,
    // with a return to an earlier region. Secret; server-only.
    TRUST_STATE_HOP_REGION_KM: positiveIntegerFromEnv.default(300),
    TRUST_STATE_HOP_MAX_KMH: positiveIntegerFromEnv.default(900),
    TRUST_STATE_HOP_MIN_HOPS: positiveIntegerFromEnv.pipe(z.number().max(20)).default(2),
    TRUST_STATE_HOP_WINDOW_DAYS: positiveIntegerFromEnv.pipe(z.number().max(60)).default(7),
    // gnss_zero_satellites: a native fix with 0 satellites used but accuracy at or under this many metres.
    TRUST_GNSS_ZERO_SAT_MAX_ACCURACY_M: positiveIntegerFromEnv.default(50),
    // Apple DeviceCheck: set bit0 on the device when an account is locked for spoofing.
    TRUST_DEVICECHECK_BIT_SET_ENABLED: booleanFromEnv.default(false),
    TRUST_REVIEW_ACCOUNT_IDS: z.string().default("")
      .transform((value) => value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))
      .pipe(z.array(z.string().uuid())),
    // Mismatch signals (plan section 5: IP vs GPS, carrier country, timezone, static GPS).
    // shadow records signals; enforce also revokes Settled on a hard mismatch.
    TRUST_MISMATCH_MODE: z.enum(["off", "shadow", "enforce"]).default("shadow"),
    // Owner decision F: in enforce, mismatch-family signal weight within 24 h at or
    // above this revokes Settled (hard_mismatch) even without a hard mismatch. 0 disables.
    TRUST_MISMATCH_REVOKE_WEIGHT: numberFromEnv.pipe(z.number().min(0).max(50)).default(5),
    // Directory with the DB-IP Lite MMDB files (tools/trust/update-ipgeo.mjs).
    TRUST_IPGEO_DIR: z.string().trim().optional(),
    // Device attestation and mock-location detection (NATIVE_ANTISPOOF_BUILD_PLAN.md
    // §8.7). Modes: off hides the endpoints and ignores the native block; shadow
    // records verdicts, assurance and signals; enforce also refuses mock
    // relocations and revokes Settled on hard causes. Providers stay disabled
    // until their store-side setup exists.
    TRUST_ATTESTATION_MODE: z.enum(["off", "shadow", "enforce"]).default("shadow"),
    TRUST_MOCK_LOCATION_MODE: z.enum(["off", "shadow", "enforce"]).default("shadow"),
    TRUST_PLAY_INTEGRITY_ENABLED: booleanFromEnv.default(false),
    TRUST_PLAY_INTEGRITY_PACKAGE_NAME: z.string().trim().min(1).default("com.ashatlas.game"),
    TRUST_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER: z.string().trim().regex(/^\d{0,20}$/u).default(""),
    // App signing certificate SHA-256, CSV of hex (colons accepted).
    TRUST_PLAY_INTEGRITY_CERT_SHA256: z.string().trim().default(""),
    // Service account JSON, base64; empty uses Application Default Credentials.
    TRUST_PLAY_INTEGRITY_CREDENTIALS_JSON_BASE64: z.string().trim().default(""),
    TRUST_APP_ATTEST_ENABLED: booleanFromEnv.default(false),
    TRUST_APP_ATTEST_APP_ID: z.string().trim().regex(/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/u).default("ABCDE12345.com.ashatlas.game"),
    TRUST_APP_ATTEST_ALLOW_DEVELOPMENT: booleanFromEnv.default(false),
    TRUST_DEVICECHECK_ENABLED: booleanFromEnv.default(false),
    TRUST_DEVICECHECK_KEY_ID: z.string().trim().default(""),
    TRUST_DEVICECHECK_PRIVATE_KEY_P8_BASE64: z.string().trim().default(""),
    TRUST_DEVICECHECK_ENVIRONMENT: z.enum(["production", "development"]).default("production"),
    TRUST_ATTEST_VERDICT_TTL_SECONDS: positiveIntegerFromEnv.pipe(z.number().min(300).max(86_400)).default(1800),
    TRUST_ATTEST_CHALLENGE_TTL_SECONDS: positiveIntegerFromEnv.pipe(z.number().min(30).max(3600)).default(300),
    TRUST_ATTEST_VERIFY_TIMEOUT_MS: positiveIntegerFromEnv.pipe(z.number().min(500).max(30_000)).default(4000),
    TRUST_ATTEST_RETENTION_DAYS: positiveIntegerFromEnv.default(90),
    // Real-money purchases (premium-currency-plan.md §6). Every path stays off
    // until the first official store release; disabled routes answer 404.
    PURCHASES_APPLE_ENABLED: booleanFromEnv.default(false),
    PURCHASES_GOOGLE_ENABLED: booleanFromEnv.default(false),
    PURCHASES_WEB_ENABLED: booleanFromEnv.default(false),
    ATLAS_PASS_ENABLED: booleanFromEnv.default(false),
    // Glimmer progression costs (each off until the owner turns it on).
    // Level-up: 70 Glimmer per character level; levels wait for a paid confirm.
    GLIMMER_LEVEL_UP_FEE_ENABLED: booleanFromEnv.default(false),
    // Full skill reset: 560 Glimmer, 336 with an active Atlas Pass.
    GLIMMER_SKILL_RESET_FEE_ENABLED: booleanFromEnv.default(false),
    // Dungeon entry: Atlas Pass holders pay 35% less Glimmer Oil (18 -> 11).
    ATLAS_PASS_DUNGEON_DISCOUNT_ENABLED: booleanFromEnv.default(false),
    // off: never link to the web shop in-app. storefront: link only where plan §7.3 allows.
    SHOP_LINKS_MODE: z.enum(["off", "storefront"]).default("off"),
    SHOP_WEB_URL: optionalStringFromEnv.pipe(z.string().url().startsWith("https://").optional()),
    // Grants from Apple/Google sandbox and Xsolla test payments. Test tracks only.
    PURCHASES_ACCEPT_SANDBOX: booleanFromEnv.default(false),
    PURCHASES_APPLE_BUNDLE_ID: z.string().trim().min(1).default("com.ashatlas.game"),
    PURCHASES_APPLE_APP_APPLE_ID: z.string().trim().regex(/^\d{0,20}$/u).default(""),
    // Apple Root CA certificates (DER, base64), comma-separated. Required when Apple is enabled.
    PURCHASES_APPLE_ROOT_CERTS_BASE64: z.string().trim().default(""),
    PURCHASES_APPLE_ONLINE_CHECKS: booleanFromEnv.default(true),
    PURCHASES_GOOGLE_PACKAGE_NAME: z.string().trim().min(1).default("com.ashatlas.game"),
    // androidpublisher service account JSON, base64; empty uses Application Default Credentials.
    PURCHASES_GOOGLE_CREDENTIALS_JSON_BASE64: z.string().trim().default(""),
    // Pub/Sub push: OIDC audience and the push service account that signs it.
    PURCHASES_GOOGLE_RTDN_AUDIENCE: z.string().trim().default(""),
    PURCHASES_GOOGLE_RTDN_SERVICE_ACCOUNT: z.string().trim().default(""),
    PURCHASES_GOOGLE_VOIDED_SWEEP_MINUTES: positiveIntegerFromEnv.pipe(z.number().min(15).max(10_080)).default(1440),
    PURCHASES_STORE_TIMEOUT_MS: positiveIntegerFromEnv.pipe(z.number().min(500).max(30_000)).default(8000),
    PURCHASES_XSOLLA_MERCHANT_ID: z.string().trim().regex(/^\d{0,20}$/u).default(""),
    PURCHASES_XSOLLA_PROJECT_ID: z.string().trim().regex(/^\d{0,20}$/u).default(""),
    PURCHASES_XSOLLA_API_KEY: z.string().trim().default(""),
    PURCHASES_XSOLLA_WEBHOOK_SECRET: z.string().trim().default(""),
    PURCHASES_XSOLLA_SANDBOX: booleanFromEnv.default(true),
    PURCHASES_XSOLLA_RETURN_URL: optionalStringFromEnv.pipe(z.string().url().startsWith("https://").optional())
  })
  .superRefine((config, context) => {
    if (config.TRUST_PASSIVE_FIX_MAX_SECONDS < config.TRUST_PASSIVE_FIX_MIN_SECONDS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TRUST_PASSIVE_FIX_MAX_SECONDS"],
        message: "TRUST_PASSIVE_FIX_MAX_SECONDS must be at least TRUST_PASSIVE_FIX_MIN_SECONDS."
      });
    }
    if (config.TRUST_SETTLE_CHECKS_MAX < config.TRUST_SETTLE_CHECKS_MIN) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TRUST_SETTLE_CHECKS_MAX"],
        message: "TRUST_SETTLE_CHECKS_MAX must be at least TRUST_SETTLE_CHECKS_MIN."
      });
    }
    try {
      parseCertDigestList(config.TRUST_PLAY_INTEGRITY_CERT_SHA256);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TRUST_PLAY_INTEGRITY_CERT_SHA256"],
        message: "TRUST_PLAY_INTEGRITY_CERT_SHA256 must be comma-separated SHA-256 hex digests (colons allowed)"
      });
    }
    if (config.TRUST_PLAY_INTEGRITY_CREDENTIALS_JSON_BASE64) {
      let credentials: unknown = null;
      try {
        credentials = JSON.parse(Buffer.from(config.TRUST_PLAY_INTEGRITY_CREDENTIALS_JSON_BASE64, "base64").toString("utf8"));
      } catch {
        credentials = null;
      }
      if (credentials === null || typeof credentials !== "object" || Array.isArray(credentials)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TRUST_PLAY_INTEGRITY_CREDENTIALS_JSON_BASE64"],
          message: "TRUST_PLAY_INTEGRITY_CREDENTIALS_JSON_BASE64 must be base64 of a service-account JSON object"
        });
      }
    }
    for (const issue of purchaseConfigIssues(config)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message });
    }
    if (config.TRUST_SETTLE_DAYS_MAX < config.TRUST_SETTLE_DAYS_MIN) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TRUST_SETTLE_DAYS_MAX"],
        message: "TRUST_SETTLE_DAYS_MAX must be at least TRUST_SETTLE_DAYS_MIN."
      });
    }
    const allowedOrigins = parseAllowedOrigins(config.AUTH_ALLOWED_ORIGINS);
    const devExtraOrigins = parseAllowedOrigins(config.AUTH_DEV_EXTRA_ORIGINS);
    const devExtraOriginsPermitted =
      config.NODE_ENV === "development" &&
      config.AUTH_DEV_LOGIN_ENABLED &&
      config.AUTH_MODE === "dev" &&
      config.AUTH_RUNTIME_MODE !== "public";
    const trustedProxies = parseTrustedProxies(config.AUTH_TRUST_PROXY);
    const developerSubjects = parseDeveloperSubjects(config.DEV_AUTHORIZED_GOOGLE_SUBJECTS);
    const privateLeaderboardSubjects = parseDeveloperSubjects(
      config.DEV_PRIVATE_LEADERBOARD_GOOGLE_SUBJECTS
    );
    const testAccessAdminSubjects = parseDeveloperSubjects(
      config.TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS
    );
    if (config.TELEMETRY_ENABLED && !config.TELEMETRY_DATABASE_URL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TELEMETRY_DATABASE_URL"],
        message: "enabled telemetry requires a dedicated writer connection URL"
      });
    }
    if (config.TELEMETRY_ENABLED && !config.RUNTIME_SHA) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RUNTIME_SHA"],
        message: "enabled telemetry requires the exact release SHA"
      });
    }
    if (config.BUG_REPORTS_ENABLED && !config.TELEMETRY_ENABLED) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BUG_REPORTS_ENABLED"],
        message: "bug reports require the private telemetry subsystem"
      });
    }
    if (config.BUG_REPORTS_ENABLED && !config.BUG_REPORT_EMAIL_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BUG_REPORT_EMAIL_API_KEY"],
        message: "enabled bug reports require an email notification provider key"
      });
    }
    if (config.BUG_REPORTS_ENABLED && !config.BUG_REPORT_EMAIL_FROM) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BUG_REPORT_EMAIL_FROM"],
        message: "enabled bug reports require a verified email sender"
      });
    }
    if (
      config.TELEMETRY_CLIENT_SAMPLE_INTERVAL_MS <
      config.TELEMETRY_SERVER_SAMPLE_INTERVAL_MS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TELEMETRY_CLIENT_SAMPLE_INTERVAL_MS"],
        message: "client telemetry cannot sample more frequently than server telemetry"
      });
    }
    if (
      developerSubjects.some((subject) => !isValidDeveloperSubject(subject)) ||
      new Set(developerSubjects).size !== developerSubjects.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DEV_AUTHORIZED_GOOGLE_SUBJECTS"],
        message: "developer subjects must be unique, exact non-empty provider subject IDs"
      });
    }
    if (
      privateLeaderboardSubjects.some((subject) => !isValidDeveloperSubject(subject)) ||
      new Set(privateLeaderboardSubjects).size !== privateLeaderboardSubjects.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DEV_PRIVATE_LEADERBOARD_GOOGLE_SUBJECTS"],
        message: "private leaderboard subjects must be unique exact provider subject IDs"
      });
    }
    if (
      testAccessAdminSubjects.some((subject) => !isValidDeveloperSubject(subject)) ||
      new Set(testAccessAdminSubjects).size !== testAccessAdminSubjects.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS"],
        message: "test-access administrator subjects must be unique exact provider subject IDs"
      });
    }
    if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_ALLOWED_ORIGINS"],
        message: "AUTH_ALLOWED_ORIGINS must contain explicit application origins"
      });
    }
    for (const origin of allowedOrigins) {
      if (!isExactOrigin(origin)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_ALLOWED_ORIGINS"],
          message: `AUTH_ALLOWED_ORIGINS contains an invalid origin: ${origin}`
        });
      }
    }
    if (!allowedOrigins.includes(config.APP_PUBLIC_ORIGIN)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["APP_PUBLIC_ORIGIN"],
        message: "APP_PUBLIC_ORIGIN must be included in AUTH_ALLOWED_ORIGINS"
      });
    }
    if (config.APPLE_SIGN_IN_ENABLED) {
      const requiredAppleValues = [
        ["APPLE_TEAM_ID", config.APPLE_TEAM_ID],
        ["APPLE_SERVICES_ID", config.APPLE_SERVICES_ID],
        ["APPLE_KEY_ID", config.APPLE_KEY_ID],
        ["APPLE_PRIVATE_KEY_P8_BASE64", config.APPLE_PRIVATE_KEY_P8_BASE64],
        ["APPLE_REFRESH_TOKEN_KEY_ID", config.APPLE_REFRESH_TOKEN_KEY_ID],
        [
          "APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64",
          config.APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64
        ]
      ] as const;
      for (const [key, value] of requiredAppleValues) {
        if (!value) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: "Sign in with Apple requires the complete server-side credential contract"
          });
        }
      }
      if (!config.APP_PUBLIC_ORIGIN.startsWith("https://")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["APP_PUBLIC_ORIGIN"],
          message: "Sign in with Apple requires an HTTPS APP_PUBLIC_ORIGIN"
        });
      }
      if (config.APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64) {
        try {
          const key = Buffer.from(config.APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64, "base64");
          if (key.length !== 32) throw new Error("wrong length");
        } catch {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64"],
            message: "Apple refresh-token encryption key must decode to exactly 32 bytes"
          });
        }
      }
    }
    for (const platform of ["IOS", "ANDROID"] as const) {
      const hardVersion = config[`NATIVE_${platform}_HARD_MIN_VERSION`];
      const hardBuild = config[`NATIVE_${platform}_HARD_MIN_BUILD`];
      const recommendedVersion = config[`NATIVE_${platform}_RECOMMENDED_MIN_VERSION`];
      const recommendedBuild = config[`NATIVE_${platform}_RECOMMENDED_MIN_BUILD`];
      const latestVersion = config[`NATIVE_${platform}_LATEST_VERSION`];
      const latestBuild = config[`NATIVE_${platform}_LATEST_BUILD`];
      if (compareNativeIdentity(hardVersion, hardBuild, recommendedVersion, recommendedBuild) > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [`NATIVE_${platform}_RECOMMENDED_MIN_VERSION`],
          message: `${platform.toLowerCase()} native recommended minimum cannot be below the hard minimum`
        });
      }
      if (compareNativeIdentity(recommendedVersion, recommendedBuild, latestVersion, latestBuild) > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [`NATIVE_${platform}_LATEST_VERSION`],
          message: `${platform.toLowerCase()} native latest release cannot be below the recommended minimum`
        });
      }
    }
    if (config.NATIVE_WS_MIN > config.NATIVE_WS_MAX) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NATIVE_WS_MAX"],
        message: "native WebSocket maximum cannot be below the minimum"
      });
    }
    if (config.AUTH_SESSION_INACTIVITY_DAYS > config.AUTH_SESSION_ABSOLUTE_DAYS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_SESSION_INACTIVITY_DAYS"],
        message: "session inactivity lifetime cannot exceed absolute lifetime"
      });
    }
    if (config.FLAG_BUILD_PREWARM_DELAY_MS >= config.FLAG_BUILD_DURATION_MS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FLAG_BUILD_PREWARM_DELAY_MS"],
        message: "FLAG_BUILD_PREWARM_DELAY_MS must be shorter than FLAG_BUILD_DURATION_MS"
      });
    }
    for (const issue of flagRadiusContractIssues({
      claimRadiusM: config.FLAG_CLAIM_RADIUS_M,
      movementLeashRadiusM: config.MOVE_LEASH_RADIUS_M,
      certifiedVisionRadiusM: config.FLAG_RESOURCE_VISION_RADIUS_M,
      preparationBufferM: config.FLAG_PREPARE_BUFFER_M,
      preparedRadiusM: config.FLAG_PREPARE_RADIUS_M
    })) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FLAG_PREPARE_RADIUS_M"],
        message: issue
      });
    }
    for (const key of [
      "COMBAT_PLAYER_MAX_HEALTH",
      "COMBAT_PLAYER_BASIC_DAMAGE",
      "COMBAT_SPATIAL_CELL_M",
      "COMBAT_INTEREST_RADIUS_M",
      "COMBAT_DELTA_HZ",
      "WORLD_DELTA_HZ",
      "DEV_MOB_MAX_SPAWN_DISTANCE_M",
      "FLAG_CLAIM_RADIUS_M",
      "FLAG_RESOURCE_VISION_RADIUS_M",
      "FLAG_PREPARE_BUFFER_M",
      "FLAG_PREPARE_RADIUS_M",
      "MOVE_LEASH_RADIUS_M"
    ] as const) {
      if (config[key] <= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be positive`
        });
      }
    }
    if (config.COMBAT_DELTA_HZ > config.SERVER_TICK_HZ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COMBAT_DELTA_HZ"],
        message: "COMBAT_DELTA_HZ cannot exceed SERVER_TICK_HZ"
      });
    }
    if (config.WORLD_DELTA_HZ > config.SERVER_TICK_HZ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WORLD_DELTA_HZ"],
        message: "WORLD_DELTA_HZ cannot exceed SERVER_TICK_HZ"
      });
    }
    if (config.WS_BACKPRESSURE_HARD_BYTES <= config.WS_BACKPRESSURE_SOFT_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WS_BACKPRESSURE_HARD_BYTES"],
        message: "hard WebSocket backpressure limit must exceed the soft limit"
      });
    }
    if (config.CHAT_MESSAGE_MAX_LENGTH > 400) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CHAT_MESSAGE_MAX_LENGTH"],
        message: "CHAT_MESSAGE_MAX_LENGTH cannot exceed the shared protocol limit of 400"
      });
    }
    if (
      config.CHAT_HISTORY_PAGE_SIZE > 50 ||
      config.CHAT_CATCH_UP_LIMIT > 100 ||
      config.CHAT_CATCH_UP_LIMIT < config.CHAT_HISTORY_PAGE_SIZE
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CHAT_HISTORY_PAGE_SIZE"],
        message: "chat history pages are capped at 50 and must fit within the catch-up limit capped at 100"
      });
    }
    if (config.WS_MAX_PAYLOAD_BYTES > config.WS_BACKPRESSURE_SOFT_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WS_MAX_PAYLOAD_BYTES"],
        message: "WebSocket payload limit cannot exceed the soft backpressure limit"
      });
    }
    if (config.LINKDEAD_WORLD_PRESENCE_MS > config.RECONNECT_GRACE_MS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["LINKDEAD_WORLD_PRESENCE_MS"],
        message: "link-dead world presence cannot outlive the reconnect grace"
      });
    }
    if (config.WS_HEARTBEAT_SWEEP_MS > config.WS_HEARTBEAT_TIMEOUT_MS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WS_HEARTBEAT_SWEEP_MS"],
        message: "WebSocket heartbeat sweep cannot exceed the heartbeat timeout"
      });
    }
    if (config.MARKET_MAX_TOTAL_ORDER_VALUE > Number.MAX_SAFE_INTEGER) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MARKET_MAX_TOTAL_ORDER_VALUE"],
        message: "market maximum total must remain a JavaScript safe integer"
      });
    }
    if (config.MARKET_MAX_OPEN_ORDERS_PER_ITEM > MARKET_MAX_MUTATION_TRADES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MARKET_MAX_OPEN_ORDERS_PER_ITEM"],
        message: `market open-order limit cannot exceed the ${MARKET_MAX_MUTATION_TRADES}-trade mutation-result bound`
      });
    }
    if (
      config.MARKET_MAX_RESTING_ORDERS_PER_ACCOUNT_BOOK >
      config.MARKET_MAX_OPEN_ORDERS_PER_ITEM
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MARKET_MAX_RESTING_ORDERS_PER_ACCOUNT_BOOK"],
        message: "per-account book limit cannot exceed the total open-book limit"
      });
    }
    if (
      config.MARKET_RECONCILIATION_STALE_AFTER_MS <=
      config.MARKET_RECONCILIATION_INTERVAL_MS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MARKET_RECONCILIATION_STALE_AFTER_MS"],
        message: "market reconciliation stale threshold must exceed the run interval"
      });
    }
    for (const proxy of trustedProxies) {
      if (!isTrustedProxyEntry(proxy)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_TRUST_PROXY"],
          message: `AUTH_TRUST_PROXY contains an invalid IP or CIDR: ${proxy}`
        });
      }
      if (proxy === "0.0.0.0/0" || proxy === "::/0") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_TRUST_PROXY"],
          message: "AUTH_TRUST_PROXY cannot trust every address"
        });
      }
    }
    if (config.NODE_ENV === "production" && trustedProxies.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_TRUST_PROXY"],
        message: "production requires explicit trusted reverse-proxy addresses"
      });
    }
    if (config.AUTH_DEV_LOGIN_ENABLED) {
      if (config.AUTH_RUNTIME_MODE === "public") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_DEV_LOGIN_ENABLED"],
          message: "public authentication runtime mode forbids development login"
        });
      }
      if (config.NODE_ENV !== "development") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_DEV_LOGIN_ENABLED"],
          message: "development login requires NODE_ENV=development"
        });
      }
      if (config.AUTH_MODE !== "dev") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_DEV_LOGIN_ENABLED"],
          message: "development login requires AUTH_MODE=dev"
        });
      }
      // AUTH_DEV_EXTRA_ORIGINS entries are exempt only when the opt-in is permitted; invalid
      // entries fail boot below, so the exemption never applies to an unchecked origin.
      const exemptOrigins = devExtraOriginsPermitted ? devExtraOrigins : [];
      if (
        !isDevelopmentApplicationOrigin(config.APP_PUBLIC_ORIGIN) ||
        allowedOrigins.some(
          (origin) => !isDevelopmentApplicationOrigin(origin) && !exemptOrigins.includes(origin)
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_ALLOWED_ORIGINS"],
          message: "development login requires loopback or private-LAN HTTP origins"
        });
      }
    }
    if (devExtraOrigins.length > 0) {
      if (!devExtraOriginsPermitted) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_DEV_EXTRA_ORIGINS"],
          message:
            "AUTH_DEV_EXTRA_ORIGINS requires NODE_ENV=development, AUTH_MODE=dev, AUTH_DEV_LOGIN_ENABLED=true and a non-public AUTH_RUNTIME_MODE"
        });
      }
      for (const origin of devExtraOrigins) {
        if (!isTailnetHttpsOrigin(origin)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["AUTH_DEV_EXTRA_ORIGINS"],
            message: `AUTH_DEV_EXTRA_ORIGINS entries must be exact https://<host>.ts.net[:port] origins: ${origin}`
          });
        } else if (!allowedOrigins.includes(origin)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["AUTH_DEV_EXTRA_ORIGINS"],
            message: `AUTH_DEV_EXTRA_ORIGINS entry must also be listed in AUTH_ALLOWED_ORIGINS: ${origin}`
          });
        }
      }
    }
    if (
      config.NODE_ENV === "production" &&
      config.DEV_TOOLS_ENABLED === true &&
      config.DEV_ADMIN_TOOLS_ENABLED &&
      developerSubjects.length > 0 &&
      !config.RUNTIME_SHA
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RUNTIME_SHA"],
        message:
          "production developer mutation capabilities require the active RUNTIME_SHA"
      });
    }
    if (config.DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED) {
      const productionEconomyRequirements = [
        config.NODE_ENV === "production",
        config.AUTH_RUNTIME_MODE === "public",
        config.AUTH_MODE === "google",
        !config.AUTH_DEV_LOGIN_ENABLED,
        config.DEV_TOOLS_ENABLED === true,
        config.DEV_ADMIN_TOOLS_ENABLED,
        developerSubjects.length > 0
      ];
      if (productionEconomyRequirements.some((requirement) => !requirement)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED"],
          message:
            "production economy mutation requires production public Google auth, disabled development login, enabled developer/admin tools, and an authorized Google subject"
        });
      }
    }
    if (config.AUTH_EMAIL_LOGIN_ENABLED) {
      if (config.AUTH_EMAIL_SENDER === "resend" && !config.AUTH_EMAIL_RESEND_API_KEY) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_EMAIL_RESEND_API_KEY"],
          message: "AUTH_EMAIL_SENDER=resend requires AUTH_EMAIL_RESEND_API_KEY"
        });
      }
      if (config.NODE_ENV === "production") {
        if (config.AUTH_EMAIL_SENDER !== "resend") {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["AUTH_EMAIL_SENDER"],
            message: "production email login requires AUTH_EMAIL_SENDER=resend"
          });
        }
        if (
          config.AUTH_EMAIL_FROM === DEFAULT_AUTH_EMAIL_FROM ||
          !emailAddressFromEnv.safeParse(config.AUTH_EMAIL_FROM).success
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["AUTH_EMAIL_FROM"],
            message: "production email login requires a real AUTH_EMAIL_FROM address"
          });
        }
        if (
          config.AUTH_EMAIL_CODE_HMAC_KEY === DEV_EMAIL_CODE_KEY ||
          [
            config.AUTH_SESSION_TOKEN_HMAC_KEY,
            config.AUTH_DEVICE_TOKEN_HMAC_KEY,
            config.AUTH_NETWORK_HMAC_KEY,
            config.INITIAL_SPAWN_HMAC_KEY,
            config.DOG_GENETICS_HMAC_KEY
          ].includes(config.AUTH_EMAIL_CODE_HMAC_KEY)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["AUTH_EMAIL_CODE_HMAC_KEY"],
            message: "production email login requires a unique AUTH_EMAIL_CODE_HMAC_KEY"
          });
        }
      }
    }
    if (config.NODE_ENV === "production") {
      if (config.AUTH_RUNTIME_MODE !== "public") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_RUNTIME_MODE"],
          message: "production requires AUTH_RUNTIME_MODE=public"
        });
      }
      if (config.KINGDOMS_FREE_CONSTRUCTION === true) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["KINGDOMS_FREE_CONSTRUCTION"],
          message: "production cannot enable free Kingdom construction"
        });
      }
      if (
        config.MARKET_GLOBAL_ACCESS &&
        !config.MARKET_ALLOW_GLOBAL_ACCESS_IN_PRODUCTION
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["MARKET_ALLOW_GLOBAL_ACCESS_IN_PRODUCTION"],
          message: "production global market access requires explicit acknowledgement"
        });
      }
      if (config.ALLOW_UNRESOLVED_FLAGS_IN_DEV) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ALLOW_UNRESOLVED_FLAGS_IN_DEV"],
          message: "production cannot enable unresolved development flags"
        });
      }
      if (config.AUTH_MODE !== "google") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_MODE"],
          message: "production requires AUTH_MODE=google"
        });
      }
      if (!config.GOOGLE_CLIENT_ID) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["GOOGLE_CLIENT_ID"],
          message: "production requires GOOGLE_CLIENT_ID"
        });
      }
      if (new Set([
        config.AUTH_SESSION_TOKEN_HMAC_KEY,
        config.AUTH_DEVICE_TOKEN_HMAC_KEY,
        config.AUTH_NETWORK_HMAC_KEY,
        config.INITIAL_SPAWN_HMAC_KEY,
        config.DOG_GENETICS_HMAC_KEY
      ]).size !== 5) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_SESSION_TOKEN_HMAC_KEY"],
          message: "production auth HMAC keys must be distinct"
        });
      }
      for (const [key, value, developmentValue] of [
        ["AUTH_SESSION_TOKEN_HMAC_KEY", config.AUTH_SESSION_TOKEN_HMAC_KEY, DEV_SESSION_KEY],
        ["AUTH_DEVICE_TOKEN_HMAC_KEY", config.AUTH_DEVICE_TOKEN_HMAC_KEY, DEV_DEVICE_KEY],
        ["AUTH_NETWORK_HMAC_KEY", config.AUTH_NETWORK_HMAC_KEY, DEV_NETWORK_KEY],
        ["INITIAL_SPAWN_HMAC_KEY", config.INITIAL_SPAWN_HMAC_KEY, DEV_INITIAL_SPAWN_KEY],
        ["DOG_GENETICS_HMAC_KEY", config.DOG_GENETICS_HMAC_KEY, DEV_DOG_GENETICS_KEY]
      ] as const) {
        if (value === developmentValue) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `production requires a unique ${key}`
          });
        }
      }
      if (testAccessAdminSubjects.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS"],
          message: "production test-access administration requires at least one administrator subject"
        });
      }
      if (!config.APP_PUBLIC_ORIGIN.startsWith("https://")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["APP_PUBLIC_ORIGIN"],
          message: "production APP_PUBLIC_ORIGIN must use HTTPS"
        });
      }
      if (allowedOrigins.some((origin) => !origin.startsWith("https://"))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_ALLOWED_ORIGINS"],
          message: "production allowed origins must use HTTPS"
        });
      }
    }
    if (
      config.NODE_ENV === "production"
      && config.TRUST_QUARANTINE_MODE === "enforce"
      && !config.TRUST_LADDER_ACK
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TRUST_QUARANTINE_MODE"],
        message: "production TRUST_QUARANTINE_MODE=enforce requires TRUST_LADDER_ACK=true"
      });
    }
    if (config.NODE_ENV === "production") {
      if (config.TRUST_PLAY_INTEGRITY_ENABLED && !config.TRUST_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TRUST_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER"],
          message: "production Play Integrity requires TRUST_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER"
        });
      }
      if (config.TRUST_PLAY_INTEGRITY_ENABLED && config.TRUST_PLAY_INTEGRITY_CERT_SHA256.replaceAll(",", "").trim() === "") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TRUST_PLAY_INTEGRITY_CERT_SHA256"],
          message: "production Play Integrity requires at least one app signing certificate digest"
        });
      }
      if (config.TRUST_APP_ATTEST_ALLOW_DEVELOPMENT) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TRUST_APP_ATTEST_ALLOW_DEVELOPMENT"],
          message: "production cannot accept development App Attest keys"
        });
      }
      if (config.TRUST_DEVICECHECK_ENABLED && (!config.TRUST_DEVICECHECK_KEY_ID || !config.TRUST_DEVICECHECK_PRIVATE_KEY_P8_BASE64)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TRUST_DEVICECHECK_KEY_ID"],
          message: "production DeviceCheck requires TRUST_DEVICECHECK_KEY_ID and TRUST_DEVICECHECK_PRIVATE_KEY_P8_BASE64"
        });
      }
    }
  })
  .transform((config) => ({
    ...config,
    AUTH_ALLOWED_ORIGINS: parseAllowedOrigins(config.AUTH_ALLOWED_ORIGINS),
    AUTH_DEV_EXTRA_ORIGINS: parseAllowedOrigins(config.AUTH_DEV_EXTRA_ORIGINS),
    AUTH_TRUST_PROXY: parseTrustedProxies(config.AUTH_TRUST_PROXY),
    DEV_AUTHORIZED_GOOGLE_SUBJECTS: parseDeveloperSubjects(
      config.DEV_AUTHORIZED_GOOGLE_SUBJECTS
    ),
    DEV_PRIVATE_LEADERBOARD_GOOGLE_SUBJECTS: parseDeveloperSubjects(
      config.DEV_PRIVATE_LEADERBOARD_GOOGLE_SUBJECTS
    ),
    TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: parseDeveloperSubjects(
      config.TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS
    ),
    AUTH_EMAIL_DOMAIN_ALLOWLIST: parseDomainList(config.AUTH_EMAIL_DOMAIN_ALLOWLIST),
    AUTH_EMAIL_DOMAIN_BLOCKLIST_EXTRA: parseDomainList(config.AUTH_EMAIL_DOMAIN_BLOCKLIST_EXTRA),
    AUTH_EMAIL_DEV_LOG_CODES: config.AUTH_EMAIL_DEV_LOG_CODES && config.NODE_ENV !== "production",
    DEV_TOOLS_ENABLED: config.DEV_TOOLS_ENABLED ?? config.NODE_ENV !== "production",
    AUTH_REQUIRED: config.NODE_ENV !== "test",
    KINGDOMS_FREE_CONSTRUCTION:
      config.KINGDOMS_FREE_CONSTRUCTION ?? (config.NODE_ENV !== "production"),
    KINGDOM_PERK_QUALIFICATION_SECONDS:
      config.KINGDOM_PERK_QUALIFICATION_SECONDS ?? (config.NODE_ENV === "production" ? 86_400 : 60)
  }));

export type AppConfig = z.infer<typeof configSchema>;

type PurchaseConfigInput = Readonly<{
  PURCHASES_APPLE_ENABLED: boolean;
  PURCHASES_GOOGLE_ENABLED: boolean;
  PURCHASES_WEB_ENABLED: boolean;
  PURCHASES_ACCEPT_SANDBOX: boolean;
  PURCHASES_APPLE_APP_APPLE_ID: string;
  PURCHASES_APPLE_ROOT_CERTS_BASE64: string;
  PURCHASES_GOOGLE_CREDENTIALS_JSON_BASE64: string;
  PURCHASES_GOOGLE_RTDN_AUDIENCE: string;
  PURCHASES_GOOGLE_RTDN_SERVICE_ACCOUNT: string;
  PURCHASES_XSOLLA_MERCHANT_ID: string;
  PURCHASES_XSOLLA_PROJECT_ID: string;
  PURCHASES_XSOLLA_API_KEY: string;
  PURCHASES_XSOLLA_WEBHOOK_SECRET: string;
  PURCHASES_XSOLLA_SANDBOX: boolean;
}>;

/** Enabled purchase paths fail closed at startup when their secrets are missing. */
export function purchaseConfigIssues(config: PurchaseConfigInput): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const require = (enabled: boolean, path: keyof PurchaseConfigInput, label: string) => {
    if (enabled && !String(config[path]).trim()) issues.push({ path, message: `${label} requires ${path}` });
  };
  require(config.PURCHASES_APPLE_ENABLED, "PURCHASES_APPLE_ROOT_CERTS_BASE64", "PURCHASES_APPLE_ENABLED");
  require(config.PURCHASES_APPLE_ENABLED, "PURCHASES_APPLE_APP_APPLE_ID", "PURCHASES_APPLE_ENABLED");
  require(config.PURCHASES_GOOGLE_ENABLED, "PURCHASES_GOOGLE_RTDN_AUDIENCE", "PURCHASES_GOOGLE_ENABLED");
  require(config.PURCHASES_GOOGLE_ENABLED, "PURCHASES_GOOGLE_RTDN_SERVICE_ACCOUNT", "PURCHASES_GOOGLE_ENABLED");
  require(config.PURCHASES_WEB_ENABLED, "PURCHASES_XSOLLA_MERCHANT_ID", "PURCHASES_WEB_ENABLED");
  require(config.PURCHASES_WEB_ENABLED, "PURCHASES_XSOLLA_PROJECT_ID", "PURCHASES_WEB_ENABLED");
  require(config.PURCHASES_WEB_ENABLED, "PURCHASES_XSOLLA_API_KEY", "PURCHASES_WEB_ENABLED");
  require(config.PURCHASES_WEB_ENABLED, "PURCHASES_XSOLLA_WEBHOOK_SECRET", "PURCHASES_WEB_ENABLED");
  if (config.PURCHASES_WEB_ENABLED && config.PURCHASES_XSOLLA_SANDBOX && !config.PURCHASES_ACCEPT_SANDBOX) {
    issues.push({
      path: "PURCHASES_XSOLLA_SANDBOX",
      message: "Xsolla sandbox checkout requires PURCHASES_ACCEPT_SANDBOX=true"
    });
  }
  for (const [index, entry] of config.PURCHASES_APPLE_ROOT_CERTS_BASE64.split(",").entries()) {
    if (entry.trim() && !/^[A-Za-z0-9+/]+={0,2}$/u.test(entry.trim())) {
      issues.push({ path: "PURCHASES_APPLE_ROOT_CERTS_BASE64", message: `Apple root certificate ${index + 1} is not base64` });
    }
  }
  if (config.PURCHASES_GOOGLE_CREDENTIALS_JSON_BASE64) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(config.PURCHASES_GOOGLE_CREDENTIALS_JSON_BASE64, "base64").toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    } catch {
      issues.push({
        path: "PURCHASES_GOOGLE_CREDENTIALS_JSON_BASE64",
        message: "PURCHASES_GOOGLE_CREDENTIALS_JSON_BASE64 must be base64 of a service-account JSON object"
      });
    }
  }
  return issues;
}

export type SkillSystemV3ServerCapabilities = SkillSystemV3RuntimeCapabilities & Readonly<{
  fullBuildRespecAvailable: boolean;
}>;

/** One immutable-identity-derived policy for player-facing Skill System V3 capabilities. */
export function skillSystemV3RuntimeCapabilities(
  config: Pick<AppConfig, "NODE_ENV" | "RUNTIME_LABEL" | "RUNTIME_BRANCH" | "RUNTIME_SHA">
): SkillSystemV3ServerCapabilities {
  const publicTestServer = config.NODE_ENV === "production"
    && config.RUNTIME_LABEL === "production"
    && config.RUNTIME_BRANCH === "master"
    && typeof config.RUNTIME_SHA === "string"
    && /^[a-f0-9]{40}$/.test(config.RUNTIME_SHA);
  const testRuntime = config.NODE_ENV === "development" || config.NODE_ENV === "test" || publicTestServer;
  return Object.freeze({
    fullBuildRespecAvailable: testRuntime,
    fullClassRosterEnabled: false,
    ultimatesEnabled: false
  });
}

/** Authoritative capability gate for destructive full-build respecs. */
export function isFullBuildRespecRuntime(
  config: Pick<AppConfig, "NODE_ENV" | "RUNTIME_LABEL" | "RUNTIME_BRANCH" | "RUNTIME_SHA">
): boolean {
  return skillSystemV3RuntimeCapabilities(config).fullBuildRespecAvailable;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(env);
}

export function publicConfigSummary(config: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: config.NODE_ENV,
    port: config.PORT,
    clientOrigin: config.CLIENT_ORIGIN,
    telemetryEnabled: config.TELEMETRY_ENABLED,
    // Only the feature boolean is safe to expose; never include Apple
    // identifiers, private key material, or encryption-key metadata here.
    appleSignInEnabled: config.APPLE_SIGN_IN_ENABLED,
    emailSignInEnabled: config.AUTH_EMAIL_LOGIN_ENABLED,
    emailSender: config.AUTH_EMAIL_SENDER,
    bugReportsEnabled: config.BUG_REPORTS_ENABLED,
    actionCombatEnabled: config.ACTION_COMBAT_ENABLED,
    mobTacticsEnabled: config.MOB_TACTICS_ENABLED,
    clericArcEnabled: config.CLERIC_ARC_ENABLED,
    mobTelegraphScale: config.MOB_TELEGRAPH_SCALE,
    bugReportEmailConfigured: Boolean(
      config.BUG_REPORT_EMAIL_API_KEY && config.BUG_REPORT_EMAIL_FROM
    ),
    telemetryClientEnabled: config.TELEMETRY_CLIENT_ENABLED,
    telemetryHostEnabled: config.TELEMETRY_HOST_ENABLED,
    telemetryExportEnabled: config.TELEMETRY_EXPORT_ENABLED,
    telemetrySegmentRotationEnabled: config.TELEMETRY_SEGMENT_ROTATION_ENABLED,
    telemetrySegmentDurationMs: config.TELEMETRY_SEGMENT_DURATION_MS,
    telemetryServerSampleIntervalMs: config.TELEMETRY_SERVER_SAMPLE_INTERVAL_MS,
    telemetryWorldSampleIntervalMs: config.TELEMETRY_WORLD_SAMPLE_INTERVAL_MS,
    telemetryPlayerSampleIntervalMs: config.TELEMETRY_PLAYER_SAMPLE_INTERVAL_MS,
    telemetryClientSampleIntervalMs: config.TELEMETRY_CLIENT_SAMPLE_INTERVAL_MS,
    telemetryQueueMaxRows: config.TELEMETRY_QUEUE_MAX_ROWS,
    telemetryMaxBatchRows: config.TELEMETRY_MAX_BATCH_ROWS,
    telemetryPoolMax: config.TELEMETRY_DB_POOL_MAX,
    worldApiBase: config.WORLD_API_BASE,
    worldId: config.WORLD_ID,
    worldRequiredReleaseId: config.WORLD_REQUIRED_RELEASE_ID,
    worldLookupTimeoutMs: config.WORLD_LOOKUP_TIMEOUT_MS,
    waterCollectionCadenceMs: config.WATER_COLLECTION_CADENCE_MS,
    resourceEnvironmentBatchTimeoutMs: config.RESOURCE_ENVIRONMENT_BATCH_TIMEOUT_MS,
    resourcePreparationConcurrency: config.RESOURCE_PREPARATION_CONCURRENCY,
    environmentProfilePreparationConcurrency:
      config.ENVIRONMENT_PROFILE_PREPARATION_CONCURRENCY,
    resourceJobPendingMax: config.RESOURCE_JOB_PENDING_MAX,
    resourceJobLeaseMs: config.RESOURCE_JOB_LEASE_MS,
    worldWaterCacheMaxEntries: config.WORLD_WATER_CACHE_MAX_ENTRIES,
    worldWaterCacheMaxBytes: config.WORLD_WATER_CACHE_MAX_BYTES,
    worldWaterCacheTtlMs: config.WORLD_WATER_CACHE_TTL_MS,
    regionCode: config.REGION_CODE,
    defaultSpawn: {
      lat: config.DEFAULT_SPAWN_LAT,
      lon: config.DEFAULT_SPAWN_LON
    },
    playerSpeedMps: config.PLAYER_SPEED_MPS,
    serverTickHz: config.SERVER_TICK_HZ,
    combatPlayerMaxHealth: config.COMBAT_PLAYER_MAX_HEALTH,
    combatPlayerBasicDamage: config.COMBAT_PLAYER_BASIC_DAMAGE,
    combatSpatialCellM: config.COMBAT_SPATIAL_CELL_M,
    combatInterestRadiusM: config.COMBAT_INTEREST_RADIUS_M,
    combatDeltaHz: config.COMBAT_DELTA_HZ,
    combatMaxChasesPerTick: config.COMBAT_MAX_CHASES_PER_TICK,
    worldDeltaHz: config.WORLD_DELTA_HZ,
    worldCommandQueueGlobalMax: config.WORLD_COMMAND_QUEUE_GLOBAL_MAX,
    worldCommandQueuePerPlayerMax: config.WORLD_COMMAND_QUEUE_PER_PLAYER_MAX,
    worldCommandsPerTickMax: config.WORLD_COMMANDS_PER_TICK_MAX,
    flagClaimRadiusM: config.FLAG_CLAIM_RADIUS_M,
    flagResourceVisionRadiusM: config.FLAG_RESOURCE_VISION_RADIUS_M,
    flagPrepareBufferM: config.FLAG_PREPARE_BUFFER_M,
    flagPrepareRadiusM: config.FLAG_PREPARE_RADIUS_M,
    flagBuildDurationMs: config.FLAG_BUILD_DURATION_MS,
    flagBuildPrewarmDelayMs: config.FLAG_BUILD_PREWARM_DELAY_MS,
    cityFoundingAnnexRadiusM: config.CITY_FOUNDING_ANNEX_RADIUS_M,
    citySnapshotRadiusM: config.CITY_SNAPSHOT_RADIUS_M,
    citySnapshotLimit: config.CITY_SNAPSHOT_LIMIT,
    moveLeashRadiusM: config.MOVE_LEASH_RADIUS_M,
    allowUnresolvedFlagsInDev: config.ALLOW_UNRESOLVED_FLAGS_IN_DEV,
    devToolsEnabled: config.DEV_TOOLS_ENABLED,
    devAdminToolsEnabled: config.DEV_ADMIN_TOOLS_ENABLED,
    devProductionEconomyMutationEnabled:
      config.DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED,
    testAccessAdministratorCount: config.TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS.length,
    initialSpawnAlgorithmVersion: "initial-spawn:v1",
    populationV2ActivePreparationConcurrency:
      config.POPULATION_V2_ACTIVE_PREPARATION_CONCURRENCY,
    populationV2ProfilePreparationConcurrency:
      config.POPULATION_V2_PROFILE_PREPARATION_CONCURRENCY,
    populationV2ZoneQueueMax: config.POPULATION_V2_ZONE_QUEUE_MAX,
    populationV2ProfileQueueMax: config.POPULATION_V2_PROFILE_QUEUE_MAX,
    populationV2RetryMinMs: config.POPULATION_V2_RETRY_MIN_MS,
    populationV2RetryMaxMs: config.POPULATION_V2_RETRY_MAX_MS,
    populationV2SleepGraceMs: config.POPULATION_V2_SLEEP_GRACE_MS,
    populationV2DescriptorCacheMaxZones:
      config.POPULATION_V2_DESCRIPTOR_CACHE_MAX_ZONES,
    populationV2DescriptorCacheMaxBytes:
      config.POPULATION_V2_DESCRIPTOR_CACHE_MAX_BYTES,
    populationV2DescriptorCacheTtlMs:
      config.POPULATION_V2_DESCRIPTOR_CACHE_TTL_MS,
    populationTravelPreflightEnabled:
      config.POPULATION_TRAVEL_PREFLIGHT_ENABLED,
    populationInflightResultReuseEnabled:
      config.POPULATION_INFLIGHT_RESULT_REUSE_ENABLED,
    populationProfileClaimNoopFastPathEnabled:
      config.POPULATION_PROFILE_CLAIM_NOOP_FAST_PATH_ENABLED,
    populationSoftTravelPrepareEnabled:
      config.POPULATION_SOFT_TRAVEL_PREPARE_ENABLED,
    populationSoftTravelActivationLeadMs:
      config.POPULATION_SOFT_TRAVEL_ACTIVATION_LEAD_MS,
    populationSoftTravelDurableConcurrency:
      config.POPULATION_SOFT_TRAVEL_DURABLE_CONCURRENCY,
    populationSoftTravelPromotionConcurrency:
      config.POPULATION_SOFT_TRAVEL_PROMOTION_CONCURRENCY,
    populationSoftTravelReservationTtlMs:
      config.POPULATION_SOFT_TRAVEL_RESERVATION_TTL_MS,
    populationTeleportPublicationCoalescingEnabled:
      config.POPULATION_TELEPORT_PUBLICATION_COALESCING_ENABLED,
    populationTravelOptionalArrivalSequencingEnabled:
      config.POPULATION_TRAVEL_OPTIONAL_ARRIVAL_SEQUENCING_ENABLED,
    developerSubjectAllowlistConfigured:
      config.DEV_AUTHORIZED_GOOGLE_SUBJECTS.length > 0,
    authRuntimeMode: config.AUTH_RUNTIME_MODE,
    authMode: config.AUTH_MODE,
    developmentLoginEnabled: config.AUTH_DEV_LOGIN_ENABLED,
    appPublicOrigin: config.APP_PUBLIC_ORIGIN,
    authAllowedOrigins: config.AUTH_ALLOWED_ORIGINS,
    authTrustedProxies: config.AUTH_TRUST_PROXY,
    authRequired: config.AUTH_REQUIRED,
    chatEnabled: config.CHAT_ENABLED,
    chatMessageMaxLength: config.CHAT_MESSAGE_MAX_LENGTH,
    chatTranslationProviderConfigured: Boolean(config.CHAT_TRANSLATION_GOOGLE_API_KEY),
    chatTranslationTimeoutMs: config.CHAT_TRANSLATION_TIMEOUT_MS,
    chatTranslationMonthlyCharacterCap: config.CHAT_TRANSLATION_MONTHLY_CHAR_CAP,
    chatHistoryPageSize: config.CHAT_HISTORY_PAGE_SIZE,
    chatCatchUpLimit: config.CHAT_CATCH_UP_LIMIT,
    chatRecentCacheLimit: config.CHAT_RECENT_CACHE_LIMIT,
    chatModerationQueueLimit: config.CHAT_MODERATION_QUEUE_LIMIT,
    kingdomsFreeConstruction: config.KINGDOMS_FREE_CONSTRUCTION,
    kingdomInitialTerritoryRadiusM: config.KINGDOM_INITIAL_TERRITORY_RADIUS_M,
    kingdomMinSeatSpacingM: config.KINGDOM_MIN_SEAT_SPACING_M,
    kingdomSnapshotRadiusM: config.KINGDOM_SNAPSHOT_RADIUS_M,
    kingdomPerkQualificationSeconds: config.KINGDOM_PERK_QUALIFICATION_SECONDS,
    marketGlobalAccess: config.MARKET_GLOBAL_ACCESS,
    marketGlobalAccessProductionAcknowledged:
      config.MARKET_ALLOW_GLOBAL_ACCESS_IN_PRODUCTION,
    wsMaxPayloadBytes: config.WS_MAX_PAYLOAD_BYTES,
    wsBootstrapTimeoutMs: config.WS_BOOTSTRAP_TIMEOUT_MS,
    reconnectGraceMs: config.RECONNECT_GRACE_MS,
    linkdeadWorldPresenceMs: config.LINKDEAD_WORLD_PRESENCE_MS,
    wsHeartbeatTimeoutMs: config.WS_HEARTBEAT_TIMEOUT_MS,
    wsHeartbeatSweepMs: config.WS_HEARTBEAT_SWEEP_MS,
    marketReconciliationIntervalMs: config.MARKET_RECONCILIATION_INTERVAL_MS,
    marketReconciliationStaleAfterMs: config.MARKET_RECONCILIATION_STALE_AFTER_MS
  };
}

function parseAllowedOrigins(value: string): string[] {
  return [...new Set(value.split(",").map((origin) => origin.trim()).filter(Boolean))];
}

function parseTrustedProxies(value: string): string[] {
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function parseDeveloperSubjects(value: string): string[] {
  if (value.trim() === "") return [];
  return value.split(",").map((subject) => subject.trim());
}

function parseDomainList(value: string): string[] {
  return value
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

function isValidDeveloperSubject(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 255 &&
    /^[\x21-\x7e]+$/.test(value) &&
    !value.includes(",")
  );
}

function isTrustedProxyEntry(value: string): boolean {
  const [address, prefix, extra] = value.split("/");
  if (!address || extra !== undefined) {
    return false;
  }
  const version = isIP(address);
  if (version === 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits >= 0 && bits <= (version === 4 ? 32 : 128);
}

function isExactOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function compareSemanticVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number] => {
    const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
    return match
      ? [Number(match[1]), Number(match[2]), Number(match[3])]
      : [0, 0, 0];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

function compareNativeIdentity(
  leftVersion: string,
  leftBuild: number,
  rightVersion: string,
  rightBuild: number
): number {
  const versionComparison = compareSemanticVersions(leftVersion, rightVersion);
  return versionComparison === 0 ? leftBuild - rightBuild : versionComparison;
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

// Exact https://<host>.ts.net[:port] origin: no wildcard, path, query, credentials or trailing slash.
function isTailnetHttpsOrigin(value: string): boolean {
  if (value.includes("*")) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.ts\.net$/u.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function isDevelopmentApplicationOrigin(value: string): boolean {
  if (isLoopbackOrigin(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || isIP(url.hostname) !== 4) return false;
    const [first, second] = url.hostname.split(".").map(Number);
    return (
      first === 10 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  } catch {
    return false;
  }
}
