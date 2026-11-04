import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { loadConfig } from "../config.js";
import {
  POPULATION_CANDIDATE_LAYOUT_VERSION,
  POPULATION_PLAN_VERSION,
  POPULATION_SPAWN_RULES_VERSION,
  POPULATION_STONE_PLACEMENT_VERSION
} from "../game/populationZonesV2Identity.js";
import { runMigrations } from "../db/migrate.js";
import { PostgresPopulationZonesV2Store } from "../game/populationZonesV2Store.js";
import { createLogger } from "../logger.js";
import { ClosedTestTelemetryService } from "./service.js";
import { loadGlobalWorldTelemetry } from "./worldReconciliation.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const execFileAsync = promisify(execFile);

describeDatabase("closed-test telemetry PostgreSQL integration", () => {
  const databaseName =
    `ash_atlas_stability_telemetry_${randomUUID().replaceAll("-", "")}`;
  const runId = randomUUID();
  const sessionId = randomUUID();
  const playerId = `telemetry-test-${randomUUID()}`;
  const releaseSha = "a".repeat(40);
  const serverInstanceId = `telemetry-test-${randomUUID()}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  let databaseUrl = "";
  let service: ClosedTestTelemetryService | null = null;

  beforeAll(async () => {
    const parsed = assertStabilityLabAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl);
    const database = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    await database.query(
      `INSERT INTO telemetry.test_runs (
         run_id, telemetry_schema_version, run_name, started_at, ended_at, status,
         release_sha, release_generation, world_release_id,
         population_plan_version, population_spawn_rules_version,
         population_candidate_layout_version, permanent_stone_placement_version,
         balance_version, server_instance_id
       ) VALUES (
         $1,1,'telemetry service integration',clock_timestamp(),clock_timestamp(),
         'frozen',$2,'test/t182','world-test',$3,$4,$5,$6,'balance-test',$7
       )`,
      [
        runId,
        releaseSha,
        POPULATION_PLAN_VERSION,
        POPULATION_SPAWN_RULES_VERSION,
        POPULATION_CANDIDATE_LAYOUT_VERSION,
        POPULATION_STONE_PLACEMENT_VERSION,
        serverInstanceId
      ]
    );
    for (const roleFile of [
      "../../../../db/admin/telemetry_roles.sql",
      "../../../../db/admin/telemetry_operator_role.sql"
    ]) {
      const roleSql = (await readFile(new URL(roleFile, import.meta.url), "utf8"))
        .replace(/^\\set[^\r\n]*(?:\r?\n|$)/gmu, "")
        .replaceAll(':"DBNAME"', quoteIdentifier(databaseName));
      await database.query(roleSql);
    }
    await database.end();
  }, 30_000);

  afterAll(async () => {
    await service?.shutdown();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
  });

  it("flushes every server-owned row family and strips forbidden metadata", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_LABEL: serverInstanceId,
      RUNTIME_SHA: releaseSha,
      TELEMETRY_ENABLED: "true",
      TELEMETRY_CLIENT_ENABLED: "true",
      TELEMETRY_DATABASE_URL: databaseUrl,
      TELEMETRY_RELEASE_GENERATION: "test/t182",
      TELEMETRY_WRITE_TIMEOUT_MS: "2000",
      TELEMETRY_SHUTDOWN_TIMEOUT_MS: "2000",
      WORLD_REQUIRED_RELEASE_ID: "world-test"
    });
    service = new ClosedTestTelemetryService(config, createLogger("test"));
    service.setActiveRunForTest({
      runId,
      segmentId: null,
      campaignId: null,
      segmentSequence: null,
      segmentStartAt: null,
      segmentEndAt: null,
      releaseSha,
      releaseGeneration: "test/t182",
      worldReleaseId: "world-test",
      populationPlanVersion: POPULATION_PLAN_VERSION,
      populationSpawnRulesVersion: POPULATION_SPAWN_RULES_VERSION,
      balanceVersion: "balance-test"
    });

    service.observeTick(2);
    const logicalSessionId = service.openSession({
      playerId,
      sessionId,
      connectionGeneration: 1,
      gameplayZoneId: "zone:test"
    });
    expect(logicalSessionId).not.toBeNull();
    expect(logicalSessionId).not.toBe(sessionId);
    expect(service.recordServerSample({
      active_players: 1,
      connections_by_state: { active: 1 },
      websocket_messages_by_family: { session: 1 },
      gameplay_query_timing: {},
      population_preparation_timing: {},
      resource_vision_timing: {},
      eventLoopDelayP99Ms: 1
    })).toBe(true);
    expect(service.recordWorldSamples([{
      scopeType: "zone",
      scopeId: "zone:test",
      entityCategory: "wolf",
      plannedCount: 2,
      persistedCount: 2,
      readyAliveCount: 2
    }])).toBe(1);
    expect(service.recordEvent({
      eventFamily: "travel",
      eventType: "transition_succeeded",
      priority: "important",
      playerId,
      sessionId,
      operationId: "telemetry-test-operation",
      metadata: {
        durationCategory: "fast",
        message_text: "must not be stored",
        accountId: "must not be stored"
      }
    })).toBe(true);
    expect(service.recordEvent({
      eventFamily: "social",
      eventType: "request_received_chat_send",
      priority: "routine",
      playerId,
      sessionId,
      metadata: { messageType: "CHAT_SEND" }
    })).toBe(true);
    expect(service.recordPlayerSnapshot({
      playerId,
      sessionId,
      snapshotReason: "interval",
      onlineDurationSeconds: 1,
      inventoryRevision: 0,
      partyId: `party:${randomUUID()}`
    })).not.toBeNull();
    const inventorySnapshotId = service.recordInventorySnapshot({
      playerId,
      sessionId,
      snapshotReason: "login",
      inventoryRevision: 1,
      items: [{ itemId: "ash_log", quantity: 3 }],
      itemStackCount: 1,
      totalQuantity: 3
    });
    expect(inventorySnapshotId).not.toBeNull();
    expect(service.recordPlayerSnapshot({
      playerId,
      sessionId,
      snapshotReason: "login",
      onlineDurationSeconds: 0,
      level: 1,
      totalXp: 0,
      gold: 10,
      inventoryRevision: 1,
      inventorySnapshotId
    })).not.toBeNull();
    expect(service.acceptClientBatch({
      playerId,
      sessionId,
      connectionGeneration: 1,
      samples: [{
        sequence: 1,
        reason: "interval",
        deviceCategory: "desktop",
        operatingSystemFamily: "Windows",
        browserFamily: "Chrome",
        browserMajorVersion: 140,
        installedPwa: false,
        foregroundState: "foreground",
        viewportWidth: 1280,
        viewportHeight: 720,
        screenSizeClass: "large",
        fpsMean: 60,
        frameTimeP50Ms: 16,
        frameTimeP95Ms: 22,
        frameTimeP99Ms: 30,
        frameTimeMaxMs: 40,
        longFramesOver50Ms: 0,
        longFramesOver100Ms: 0,
        rttMeanMs: 30,
        rttP95Ms: 40,
        authoritativeSnapshotAgeMs: 20,
        websocketReconnectCount: 0,
        websocketSendFailures: { closed: 0, failed: 0 },
        staleSocketEvents: 0,
        visibleFlagCount: 1,
        visibleCollectibleCount: 2,
        visibleCombatEntityCount: 0,
        retainedDisplayObjectCount: 10,
        collectibleRedrawCount: 1,
        collectibleRedrawDurationMs: 2,
        staticOverlayRedrawCount: 1,
        staticOverlayRedrawDurationMs: 1,
        clientReleaseIdentifier: releaseSha
      }]
    })).toBe(1);
    service.closeSession({
      playerId,
      sessionId,
      connectionGeneration: 1,
      clean: true,
      retryable: false,
      closeCode: 1000,
      closeReasonCategory: "normal"
    });

    await service.flush();
    expect(service.metricsSnapshot().lastDatabaseError).toBeNull();

    const verification = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    await expect(
      new PostgresPopulationZonesV2Store(verification)
        .telemetryReconciliationSnapshot()
    ).resolves.toEqual([]);
    const globalWorld = await loadGlobalWorldTelemetry(verification);
    expect(globalWorld).toHaveLength(10);
    expect(globalWorld.every((sample) => sample.persistedCount === 0)).toBe(true);
    const counts = await verification.query<{ table_name: string; row_count: number }>(
      `SELECT table_name, row_count::int
       FROM (
         SELECT 'server_samples' AS table_name, count(*) AS row_count
           FROM telemetry.server_samples WHERE run_id=$1
         UNION ALL SELECT 'world_samples', count(*)
           FROM telemetry.world_samples WHERE run_id=$1
         UNION ALL SELECT 'gameplay_events', count(*)
           FROM telemetry.gameplay_events WHERE run_id=$1
         UNION ALL SELECT 'player_snapshots', count(*)
           FROM telemetry.player_snapshots WHERE run_id=$1
         UNION ALL SELECT 'player_inventory_snapshots', count(*)
           FROM telemetry.player_inventory_snapshots WHERE run_id=$1
         UNION ALL SELECT 'client_samples', count(*)
           FROM telemetry.client_samples WHERE run_id=$1
         UNION ALL SELECT 'session_summaries', count(*)
           FROM telemetry.session_summaries WHERE run_id=$1
       ) AS counts
       ORDER BY table_name`,
      [runId]
    );
    expect(Object.fromEntries(
      counts.rows.map((row) => [row.table_name, row.row_count])
    )).toEqual({
      client_samples: 1,
      gameplay_events: 4,
      player_inventory_snapshots: 1,
      player_snapshots: 2,
      server_samples: 1,
      session_summaries: 1,
      world_samples: 1
    });
    const event = await verification.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM telemetry.gameplay_events
       WHERE run_id=$1 AND event_type='transition_succeeded'`,
      [runId]
    );
    expect(event.rows[0]?.metadata).toEqual({ durationCategory: "fast" });
    await expect(verification.query(
      `SELECT party_id LIKE 'party:%' AS namespaced_party
       FROM telemetry.player_snapshots
       WHERE run_id=$1 AND snapshot_reason='interval'`,
      [runId]
    )).resolves.toMatchObject({ rows: [{ namespaced_party: true }] });
    await expect(verification.query(
      "SELECT 1 FROM telemetry.telemetry_health WHERE server_instance_id=$1",
      [serverInstanceId]
    )).resolves.toMatchObject({ rowCount: 1 });
    expect(service.metricsSnapshot()).toMatchObject({
      rowsFlushed: 11,
      writeFailures: 0,
      queue: { depth: 0 }
    });
    const freezeSessionId = randomUUID();
    const freezeLogicalSessionId = service.openSession({
      playerId,
      sessionId: freezeSessionId,
      connectionGeneration: 2
    });
    expect(freezeLogicalSessionId).not.toBeNull();
    service.setRunFreezeHandler(() => {
      service!.recordPlayerSnapshot({
        playerId,
        sessionId: freezeSessionId,
        snapshotReason: "run_freeze",
        onlineDurationSeconds: 1
      });
      service!.freezeSessions();
    });
    await service.refreshActiveRunForTest();
    await expect(verification.query(
      `SELECT ingestion_closed_at IS NOT NULL AS closed,
              EXISTS (
                SELECT 1 FROM telemetry.player_snapshots
                WHERE run_id=$1 AND snapshot_reason='run_freeze'
              ) AS final_snapshot,
              EXISTS (
                SELECT 1 FROM telemetry.session_summaries
                WHERE run_id=$1 AND session_id=$2
              ) AS final_session
       FROM telemetry.test_runs WHERE run_id=$1`,
      [runId, freezeLogicalSessionId]
    )).resolves.toMatchObject({
      rows: [{ closed: true, final_snapshot: true, final_session: true }]
    });
    await verification.end();
  }, 15_000);

  it("starts, reports, and freezes a reset-boundary run through the operator CLI", async () => {
    const environment = {
      ...process.env,
      TELEMETRY_OPERATOR_DATABASE_URL: databaseUrl,
      RUNTIME_SHA: releaseSha,
      TELEMETRY_RELEASE_GENERATION: "test/t182",
      WORLD_REQUIRED_RELEASE_ID: "world-test"
    };
    const start = await runTelemetryCli(
      [
        "start",
        "--name",
        "operator CLI integration",
        "--reset-wipe"
      ],
      environment
    );
    const started = JSON.parse(start.stdout) as {
      runId: string;
      status: string;
      resetWipeMarker: boolean;
    };
    expect(started).toMatchObject({
      status: "active",
      resetWipeMarker: true
    });

    const status = await runTelemetryCli(["status"], environment);
    const reported = JSON.parse(status.stdout) as {
      runs: Array<{ run_id: string; status: string }>;
    };
    expect(reported.runs).toContainEqual(
      expect.objectContaining({ run_id: started.runId, status: "active" })
    );

    const freeze = await runTelemetryCli(
      ["freeze", "--run-id", started.runId],
      environment
    );
    expect(JSON.parse(freeze.stdout)).toMatchObject({
      run_id: started.runId,
      status: "frozen"
    });
  }, 30_000);

  it("atomically rotates two consecutive segmented child runs", async () => {
    const database = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    const campaignId = randomUUID();
    const firstRunId = randomUUID();
    const firstSegmentId = randomUUID();
    try {
      const inserted = await database.query<{ segment_end_at: Date }>(
        `INSERT INTO telemetry.test_runs (
           run_id, telemetry_schema_version, run_name, started_at, status,
           release_sha, release_generation, world_release_id,
           population_plan_version, population_spawn_rules_version,
           population_candidate_layout_version, permanent_stone_placement_version,
           balance_version, server_instance_id, segment_id, campaign_id,
           segment_sequence, segment_start_at, segment_end_at,
           segment_duration_seconds
         ) VALUES (
           $1,1,'segment rotation integration',clock_timestamp(),'active',
           $2,'test/t182','world-test',$3,$4,$5,$6,'balance-test',$7,$8,$9,
           0,clock_timestamp(),date_trunc('second',clock_timestamp())+interval '60 seconds',60
         )
         RETURNING segment_end_at`,
        [
          firstRunId,
          releaseSha,
          POPULATION_PLAN_VERSION,
          POPULATION_SPAWN_RULES_VERSION,
          POPULATION_CANDIDATE_LAYOUT_VERSION,
          POPULATION_STONE_PLACEMENT_VERSION,
          serverInstanceId,
          firstSegmentId,
          campaignId
        ]
      );
      const client = await database.connect();
      try {
        await client.query("SET ROLE ash_atlas_telemetry_writer");
        let currentRunId = firstRunId;
        let boundary = inserted.rows[0]!.segment_end_at;
        for (let sequence = 1; sequence <= 2; sequence += 1) {
          const previousRunId = currentRunId;
          const nextRunId = randomUUID();
          const nextSegmentId = randomUUID();
          const rotated = await client.query<{
            run_id: string;
            segment_sequence: string;
            segment_end_at: Date;
          }>(
            `SELECT run_id, segment_sequence, segment_end_at
             FROM telemetry.rotate_hourly_segment($1,$2,$3,$4)`,
            [currentRunId, boundary, nextRunId, nextSegmentId]
          );
          expect(rotated.rows[0]).toMatchObject({
            run_id: nextRunId,
            segment_sequence: String(sequence)
          });
          if (sequence === 1) {
            const restartRetry = await client.query<{ run_id: string }>(
              `SELECT run_id
               FROM telemetry.rotate_hourly_segment($1,$2,$3,$4)`,
              [previousRunId, boundary, randomUUID(), randomUUID()]
            );
            expect(restartRetry.rows).toEqual([{ run_id: nextRunId }]);
          }
          currentRunId = nextRunId;
          boundary = rotated.rows[0]!.segment_end_at;
        }
        await client.query("RESET ROLE");
        await client.query(
          `UPDATE telemetry.test_runs
           SET status='failed', ended_at=clock_timestamp(),
               ingestion_closed_at=clock_timestamp(), updated_at=clock_timestamp()
           WHERE run_id=$1`,
          [currentRunId]
        );
      } finally {
        client.release();
      }
      const segments = await database.query<{
        segment_sequence: string;
        status: string;
        ingestion_closed: boolean;
      }>(
        `SELECT segment_sequence, status, ingestion_closed_at IS NOT NULL AS ingestion_closed
         FROM telemetry.test_runs
         WHERE campaign_id=$1
         ORDER BY segment_sequence`,
        [campaignId]
      );
      expect(segments.rows).toEqual([
        { segment_sequence: "0", status: "frozen", ingestion_closed: true },
        { segment_sequence: "1", status: "frozen", ingestion_closed: true },
        { segment_sequence: "2", status: "failed", ingestion_closed: true }
      ]);
    } finally {
      await database.query(
        `UPDATE telemetry.test_runs
         SET status='failed', ended_at=clock_timestamp(),
             ingestion_closed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE campaign_id=$1 AND status='active'`,
        [campaignId]
      ).catch(() => undefined);
      await database.end();
    }
  });

  it("recovers one expired segment under concurrent activation", async () => {
    const database = new DisposableTestPool({ connectionString: databaseUrl, max: 3 });
    const campaignId = randomUUID();
    const expiredRunId = randomUUID();
    try {
      await database.query(
        `INSERT INTO telemetry.test_runs (
           run_id, telemetry_schema_version, run_name, started_at, status,
           release_sha, release_generation, world_release_id,
           population_plan_version, population_spawn_rules_version,
           population_candidate_layout_version, permanent_stone_placement_version,
           balance_version, server_instance_id, segment_id, campaign_id,
           segment_sequence, segment_start_at, segment_end_at,
           segment_duration_seconds
         ) VALUES (
           $1,1,'expired segment recovery',clock_timestamp()-interval '2 minutes',
           'active',$2,'test/t182','world-test',$3,$4,$5,$6,'balance-test',$7,
           $8,$9,0,clock_timestamp()-interval '2 minutes',
           clock_timestamp()-interval '1 minute',60
         )`,
        [
          expiredRunId,
          releaseSha,
          POPULATION_PLAN_VERSION,
          POPULATION_SPAWN_RULES_VERSION,
          POPULATION_CANDIDATE_LAYOUT_VERSION,
          POPULATION_STONE_PLACEMENT_VERSION,
          serverInstanceId,
          randomUUID(),
          campaignId
        ]
      );
      const ensure = async () => {
        const client = await database.connect();
        try {
          await client.query("SET ROLE ash_atlas_telemetry_writer");
          return await client.query<{
            run_id: string;
            activation_action: string;
          }>(
            `SELECT run_id, activation_action
             FROM telemetry.ensure_runtime_hourly_segment(
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
             )`,
            [
              randomUUID(),
              randomUUID(),
              releaseSha,
              "test/t182",
              "world-test",
              POPULATION_PLAN_VERSION,
              POPULATION_SPAWN_RULES_VERSION,
              "balance-test",
              serverInstanceId,
              60
            ]
          );
        } finally {
          await client.query("RESET ROLE").catch(() => undefined);
          client.release();
        }
      };
      const [first, second] = await Promise.all([ensure(), ensure()]);
      expect(new Set([
        first.rows[0]?.activation_action,
        second.rows[0]?.activation_action
      ])).toEqual(new Set(["created", "retained"]));
      expect(first.rows[0]?.run_id).toBe(second.rows[0]?.run_id);
      const state = await database.query<{
        active_count: number;
        expired_status: string;
      }>(
        `SELECT count(*) FILTER (WHERE status='active')::int AS active_count,
                max(status) FILTER (WHERE run_id=$1) AS expired_status
         FROM telemetry.test_runs
         WHERE campaign_id=$2`,
        [expiredRunId, campaignId]
      );
      expect(state.rows).toEqual([{
        active_count: 1,
        expired_status: "frozen"
      }]);
    } finally {
      await database.query(
        `UPDATE telemetry.test_runs
         SET status='failed', ended_at=clock_timestamp(),
             ingestion_closed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE campaign_id=$1 AND status='active'`,
        [campaignId]
      ).catch(() => undefined);
      await database.end();
    }
  });

  it("replaces a future segment whose deployment identity no longer matches", async () => {
    const mismatchedRunId = randomUUID();
    const campaignId = randomUUID();
    const database = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    try {
      await database.query(
        `INSERT INTO telemetry.test_runs (
           run_id, telemetry_schema_version, run_name, started_at, status,
           release_sha, release_generation, world_release_id,
           population_plan_version, population_spawn_rules_version,
           population_candidate_layout_version, permanent_stone_placement_version,
           balance_version, server_instance_id, segment_id, campaign_id,
           segment_sequence, segment_start_at, segment_end_at,
           segment_duration_seconds
         ) VALUES (
           $1,1,'mismatched telemetry run',clock_timestamp(),'active',
           $2,'test/t182','world-test',$3,$4,$5,$6,'balance-test',$7,
           $8,$9,0,date_trunc('hour',clock_timestamp()),
           date_trunc('hour',clock_timestamp())+interval '1 hour',3600
         )`,
        [
          mismatchedRunId,
          "b".repeat(40),
          POPULATION_PLAN_VERSION,
          POPULATION_SPAWN_RULES_VERSION,
          POPULATION_CANDIDATE_LAYOUT_VERSION,
          POPULATION_STONE_PLACEMENT_VERSION,
          serverInstanceId,
          randomUUID(),
          campaignId
        ]
      );

      await service!.refreshActiveRunForTest();

      expect(service!.metricsSnapshot().activeRunId).not.toBeNull();
      expect(service!.metricsSnapshot().activeRunId).not.toBe(mismatchedRunId);
      expect(service!.recordEvent({
        eventFamily: "persistence",
        eventType: "recovered_run_probe",
        priority: "critical"
      })).toBe(true);
      const state = await database.query<{
        run_id: string;
        status: string;
        release_sha: string;
      }>(
        `SELECT run_id, status, release_sha
         FROM telemetry.test_runs
         WHERE campaign_id=$1
         ORDER BY segment_sequence`,
        [campaignId]
      );
      expect(state.rows).toEqual([
        {
          run_id: mismatchedRunId,
          status: "frozen",
          release_sha: "b".repeat(40)
        },
        expect.objectContaining({
          status: "active",
          release_sha: releaseSha
        })
      ]);
    } finally {
      service!.setActiveRunForTest(null);
      await database.query(
        `UPDATE telemetry.test_runs
         SET status='failed', ended_at=clock_timestamp(),
             ingestion_closed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE campaign_id=$1 AND status='active'`,
        [campaignId]
      ).catch(() => undefined);
      await database.end();
    }
  });

  it("enforces writer and exporter least privilege in PostgreSQL", async () => {
    const writer = new pg.Client({ connectionString: databaseUrl });
    await writer.connect();
    try {
      await writer.query("SET ROLE ash_atlas_telemetry_writer");
      await expect(writer.query(
        `INSERT INTO telemetry.gameplay_events (
           event_id, telemetry_schema_version, run_id, release_sha,
           release_generation, world_release_id, population_plan_version,
           population_spawn_rules_version, balance_version, server_instance_id,
           event_time, event_family, event_type, event_schema_version, priority,
           metadata
         ) VALUES (
           $1,1,$2,$3,'test/t182','world-test',$4,$5,'balance-test',$6,
           clock_timestamp(),'persistence','writer_role_probe',1,'important','{}'
         )`,
        [
          randomUUID(),
          runId,
          releaseSha,
          POPULATION_PLAN_VERSION,
          POPULATION_SPAWN_RULES_VERSION,
          serverInstanceId
        ]
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(writer.query(
         `INSERT INTO telemetry.telemetry_health (
            server_instance_id, telemetry_schema_version, run_id, release_sha,
            release_generation, world_release_id, population_plan_version,
            population_spawn_rules_version, balance_version, recorded_at, enabled,
            degraded, queue_depth_critical, queue_depth_important, queue_depth_routine,
            rows_flushed, telemetry_pool_total, telemetry_pool_idle,
            telemetry_pool_waiting, consecutive_write_failures
          ) VALUES (
            $1,1,$2,$3,'test/t182','world-test',$4,$5,'balance-test',
            clock_timestamp(),true,false,0,0,0,0,1,1,0,0
          )
         ON CONFLICT (server_instance_id) DO UPDATE SET
           run_id=EXCLUDED.run_id,
           recorded_at=EXCLUDED.recorded_at,
           enabled=EXCLUDED.enabled`,
        [
          serverInstanceId,
          runId,
          releaseSha,
          POPULATION_PLAN_VERSION,
          POPULATION_SPAWN_RULES_VERSION
        ]
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(writer.query(
        "SELECT enabled FROM telemetry.telemetry_health WHERE server_instance_id=$1",
        [serverInstanceId]
      )).resolves.toMatchObject({ rows: [{ enabled: true }] });
      await expect(writer.query("SELECT count(*) FROM accounts"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(writer.query("SELECT count(*) FROM telemetry.gameplay_events"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(writer.query(
        `SELECT activation_action
         FROM telemetry.ensure_runtime_hourly_segment(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
         )`,
        [
          randomUUID(),
          randomUUID(),
          releaseSha,
          "test/t182",
          "world-test",
          POPULATION_PLAN_VERSION,
          POPULATION_SPAWN_RULES_VERSION,
          "balance-test",
          serverInstanceId,
          3600
        ]
      )).resolves.toMatchObject({ rowCount: 0 });
      await expect(writer.query("UPDATE players SET online=false"))
        .rejects.toMatchObject({ code: "42501" });
    } finally {
      await writer.end();
    }

    const exporter = new pg.Client({ connectionString: databaseUrl });
    await exporter.connect();
    try {
      await exporter.query("SET ROLE ash_atlas_telemetry_exporter");
      await expect(exporter.query(
        "SELECT count(*) FROM telemetry.gameplay_events WHERE run_id=$1",
        [runId]
      )).resolves.toMatchObject({ rows: [{ count: "7" }] });
      await expect(exporter.query(
        "DELETE FROM telemetry.gameplay_events WHERE run_id=$1",
        [runId]
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      await exporter.end();
    }

    const operator = new pg.Client({ connectionString: databaseUrl });
    await operator.connect();
    try {
      await operator.query("SET ROLE ash_atlas_telemetry_operator");
      await expect(operator.query(
        "SELECT status FROM telemetry.test_runs WHERE run_id=$1",
        [runId]
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(operator.query("SELECT count(*) FROM telemetry.export_receipts"))
        .resolves.toMatchObject({ rowCount: 1 });
      await expect(operator.query("SELECT count(*) FROM accounts"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(operator.query("UPDATE players SET online=false"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(operator.query(
        `INSERT INTO telemetry.gameplay_events (
           event_id, telemetry_schema_version, run_id, release_sha,
           world_release_id, population_plan_version,
           population_spawn_rules_version, balance_version, server_instance_id,
           event_time, event_family, event_type, event_schema_version, priority
         ) VALUES ($1,1,$2,$3,'world-test',$4,$5,'balance-test',$6,
                   clock_timestamp(),'persistence','operator_probe',1,'important')`,
        [
          randomUUID(),
          runId,
          releaseSha,
          POPULATION_PLAN_VERSION,
          POPULATION_SPAWN_RULES_VERSION,
          serverInstanceId
        ]
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      await operator.end();
    }
  });
});

function runTelemetryCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform === "win32") {
    return execFileAsync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "pnpm", "telemetry", ...args],
      { cwd: process.cwd(), env }
    );
  }
  return execFileAsync(
    "pnpm",
    ["telemetry", ...args],
    { cwd: process.cwd(), env }
  );
}

function assertStabilityLabAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !["postgres:", "postgresql:"].includes(parsed.protocol)
    || database !== "ash_atlas_stability"
  ) {
    throw new Error(
      "MIGRATION_RUNNER_TEST_ADMIN_URL must target the local stability lab ash_atlas_stability database"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
