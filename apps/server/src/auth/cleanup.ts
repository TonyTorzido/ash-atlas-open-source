import { PostgresAuthStore } from "./authStore.js";
import { PostgresAttestationStore } from "./trust/attestation/attestationStore.js";
import { DeviceEnvironmentService, PostgresDeviceEnvironmentStore } from "./trust/attestation/deviceEnvironment.js";
import { ALERT_RETENTION_DAYS, PostgresTrustAlertStore } from "./trust/trustAlerts.js";
import { ARRIVAL_RETENTION_DAYS, PostgresTrustArrivalStore } from "./trust/trustArrivals.js";
import { PostgresLocationReportStore, locationReportRetentionCutoffs } from "./trust/trustStore.js";
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";

const RETENTION_DAYS = 90;

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({ databaseUrl: config.DATABASE_URL });
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000);
    const result = await new PostgresAuthStore(pool, config).cleanup({
      sessionExpiry: cutoff,
      telemetryCreatedAt: cutoff,
      credentialExpiry: new Date(),
      emailLoginCodeExpiry: new Date(Date.now() - 7 * 24 * 60 * 60_000)
    });
    console.info(
      `Authentication cleanup complete: ${result.sessionsDeleted} sessions, ${result.authEventsDeleted} telemetry events, ${result.credentialUsesDeleted} expired credential-use records, ${result.emailLoginCodesDeleted ?? 0} email sign-in codes removed.`
    );
    const { cutoff: reportCutoff, passiveCutoff } = locationReportRetentionCutoffs(
      config.TRUST_LOCATION_REPORT_RETENTION_DAYS,
      new Date()
    );
    const locationReportsDeleted = await new PostgresLocationReportStore(pool).deleteLocationReportsBefore(
      reportCutoff,
      passiveCutoff
    );
    console.info(`Location report cleanup complete: ${locationReportsDeleted} reports removed.`);
    const arrivalsDeleted = await new PostgresTrustArrivalStore(pool).deleteArrivalsBefore(
      new Date(Date.now() - ARRIVAL_RETENTION_DAYS * 24 * 60 * 60_000)
    );
    console.info(`Trust arrival cleanup complete: ${arrivalsDeleted} arrivals removed.`);
    const alertsDeleted = await new PostgresTrustAlertStore(pool).deleteDecidedAlertsBefore(
      new Date(Date.now() - ALERT_RETENTION_DAYS * 24 * 60 * 60_000)
    );
    console.info(`Trust alert cleanup complete: ${alertsDeleted} decided alerts removed.`);
    // Attestations after TRUST_ATTEST_RETENTION_DAYS; challenges 1 day after
    // expiry; App Attest keys 180 days after last use.
    const attestation = await new PostgresAttestationStore(pool).cleanup({
      now: new Date(),
      retentionDays: config.TRUST_ATTEST_RETENTION_DAYS,
      challengeGraceDays: 1,
      keyIdleDays: 180
    });
    console.info(
      `Attestation cleanup complete: ${attestation.attestations} attestations, ${attestation.challenges} challenges, ${attestation.keys} keys removed.`
    );
    // Environment summaries share the attestation retention; DeviceCheck tokens 7 days.
    const environment = await new DeviceEnvironmentService(new PostgresDeviceEnvironmentStore(pool), config).cleanup();
    console.info(`Device environment cleanup complete: ${environment} rows removed.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Authentication cleanup failed");
  process.exitCode = 1;
});
