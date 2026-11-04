import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { GPS_RELOCATION_COOLDOWN_MS, trustLabProfileSchema, type NativeLocationSignalsParse } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../../config.js";
import { runMigrations } from "../../db/migrate.js";
import { TravelInviteError, TravelInviteService } from "../../game/travelInvites.js";
import { AccountLinkMonitor, PostgresAccountLinkStore } from "./accountLinks.js";
import { AltDoorwayGate, createSharedNetworkBlock, doorwayDestinationForAnchor } from "./altDoorway.js";
import { DestinationAnchoring } from "./anchoring.js";
import {
  attestAppFail,
  attestDeviceFail,
  attestPass,
  attestRevocationReason,
  attestSignal,
  type AttestVerdict,
  type FixAttestation
} from "./attestation/assurance.js";
import { DeviceEnvironmentService, PostgresDeviceEnvironmentStore } from "./attestation/deviceEnvironment.js";
import { DestinationAnchorGate, PostgresDestinationAnchorStore } from "./destinationAnchorGate.js";
import { HostileActionGate, PostgresHostileGateStore } from "./hostileGate.js";
import type { IpGeoLookup } from "./ipGeo.js";
import { getPopulationGrid } from "./populationGrid.js";
import { RelocationGate } from "./relocationGate.js";
import { LocationHistoryMonitor, PostgresLocationHistoryStore } from "./stateHopping.js";
import { PostgresSettlementStore, SettlementService } from "./settlement.js";
import { PostgresTrustAdminOpsStore, TrustAdminOps } from "./trustAdminOps.js";
import { PostgresTrustAlertStore } from "./trustAlerts.js";
import { TrustLab, enforceAllTrustModes, runRelocationPipeline } from "./trustLab.js";
import { LocationReportService, TrustService, type LocationFixInput, type TrustSignalSink } from "./trustService.js";
import {
  PostgresAltDoorwayStore,
  PostgresLocationReportStore,
  PostgresTrustStateStore,
  PostgresTrustZoneStore
} from "./trustStore.js";

// Simulated players (dev1..dev6) driven through the real Postgres-backed trust
// services in the order the realtime handlers call them, once with today's
// production config and once with every trust gate enforced. Each config gets
// its own disposable ash_atlas_stability_* database. Set TRUST_SIM_REPORT_PATH
// to also write a markdown report.

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const databaseSuite = adminUrl ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;

const DENVER = { lat: 39.7392, lon: -104.9903 };
const DENVER_NEAR = { lat: 39.7600, lon: -104.9600 };
// About 2 km from dev1's kingdom seat in Denver (inside the kingdom-proximity radius).
const DENVER_SUBURB = { lat: 39.748, lon: -105.008 };
const KANSAS_OUTPOST = { lat: 38.5, lon: -101.0 };
const KANSAS_NEXT_DOOR = { lat: 38.53, lon: -100.97 };
const NEVADA_RED = { lat: 40.2, lon: -117.6 };
const PHOENIX = { lat: 33.4484, lon: -112.074 };
const PARIS = { lat: 48.8566, lon: 2.3522 };
const CHICAGO = { lat: 41.8781, lon: -87.6298 };

type Platform = "web" | "ios" | "android";
type Net = Readonly<{ ip: string; asn: number; organization: string; country: string; point: { lat: number; lon: number } }>;

type SimPlayer = {
  key: string;
  label: string;
  accountId: string;
  playerId: string;
  sessionId: string;
  ageDays: number;
  platform: Platform;
  attestation: "pass" | "basic_only" | "fail" | null;
  mock: boolean;
  emulator: boolean;
  installId: string;
  deviceInstallationId: string;
  networkCountry: string | null;
  timeZone: string;
  net: Net;
  avatar: { lat: number; lon: number };
};

type Row = Readonly<{ player: string; action: string; outcome: string }>;

const NETS = {
  denverMobile: { ip: "203.0.113.11", asn: 21928, organization: "T-Mobile USA", country: "US", point: DENVER },
  phoenixFixed: { ip: "203.0.113.12", asn: 7922, organization: "Comcast Cable", country: "US", point: PHOENIX },
  denverFixed: { ip: "203.0.113.13", asn: 7922, organization: "Comcast Cable", country: "US", point: DENVER },
  vpn: { ip: "203.0.113.14", asn: 16509, organization: "Amazon.com", country: "US", point: { lat: 39.04, lon: -77.49 } },
  chicagoFixed: { ip: "203.0.113.15", asn: 7922, organization: "Comcast Cable", country: "US", point: CHICAGO }
} satisfies Record<string, Net>;

function players(): SimPlayer[] {
  const sharedInstall = randomUUID();
  const make = (input: Omit<SimPlayer, "accountId" | "playerId" | "sessionId" | "installId" | "deviceInstallationId"> & {
    deviceInstallationId?: string;
  }): SimPlayer => ({
    accountId: randomUUID(),
    playerId: `p-${randomUUID()}`,
    sessionId: randomUUID(),
    deviceInstallationId: input.deviceInstallationId ?? randomUUID(),
    installId: `install-${(input.deviceInstallationId ?? randomUUID()).replaceAll("-", "")}`,
    ...input
  });
  return [
    make({
      key: "dev1", label: "dev1 honest veteran", ageDays: 220, platform: "android", attestation: "pass", mock: false,
      emulator: false, networkCountry: "US", timeZone: "America/Denver", net: NETS.denverMobile, avatar: DENVER
    }),
    make({
      key: "dev2", label: "dev2 new honest", ageDays: 0.3, platform: "ios", attestation: "pass", mock: false,
      emulator: false, networkCountry: null, timeZone: "America/Denver", net: NETS.denverFixed, avatar: DENVER
    }),
    make({
      key: "dev3", label: "dev3 web-only", ageDays: 45, platform: "web", attestation: null, mock: false,
      emulator: false, networkCountry: null, timeZone: "America/Denver", net: NETS.denverFixed, avatar: DENVER_SUBURB
    }),
    make({
      key: "dev4", label: "dev4 emulator spoofer", ageDays: 0.5, platform: "android", attestation: "basic_only", mock: true,
      emulator: true, networkCountry: "US", timeZone: "America/Denver", net: NETS.vpn, avatar: DENVER_NEAR,
      deviceInstallationId: sharedInstall
    }),
    make({
      key: "dev5", label: "dev5 provisional veteran turned spoofer", ageDays: 400, platform: "android", attestation: "pass",
      mock: false, emulator: false, networkCountry: "US", timeZone: "America/Phoenix", net: NETS.phoenixFixed, avatar: PHOENIX
    }),
    make({
      key: "dev6", label: "dev6 alt farm (shares dev4's device)", ageDays: 0.5, platform: "android", attestation: "pass",
      mock: false, emulator: false, networkCountry: "US", timeZone: "America/Chicago", net: NETS.chicagoFixed, avatar: CHICAGO,
      deviceInstallationId: sharedInstall
    }),
    make({
      key: "dev7", label: "dev7 Settled veteran tries a rare area", ageDays: 300, platform: "ios", attestation: "pass",
      mock: false, emulator: false, networkCountry: null, timeZone: "America/Denver", net: NETS.denverMobile, avatar: DENVER_NEAR
    })
  ];
}

// Production after the owner's planned VPS flips (report section "Env lines").
function afterFlipsConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: "development",
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "client-id",
    TRUST_RELOCATION_NATIVE_ONLY_MODE: "enforce",
    TRUST_LOCATION_REJECT_MODE: "enforce",
    TRUST_HOSTILE_GATE_MODE: "enforce",
    TRUST_ENVIRONMENT_SIGNALS_MODE: "enforce",
    TRUST_MISMATCH_MODE: "enforce"
  });
}

function prodConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: "development",
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "client-id",
    // Production today (2026-10-04): phone-only relocation enforced, other trust modes at their defaults.
    TRUST_RELOCATION_NATIVE_ONLY_MODE: "enforce"
  });
}

function verdictFor(player: SimPlayer): AttestVerdict | null {
  if (player.platform === "web" || !player.attestation) return null;
  if (player.attestation === "pass") return attestPass("attested");
  if (player.attestation === "basic_only") return attestDeviceFail("basic_integrity_only");
  return attestAppFail("app_not_recognized");
}

function nativeBlock(player: SimPlayer, at: Date): NativeLocationSignalsParse {
  if (player.platform === "web") return { status: "absent", signals: null };
  return {
    status: "ok",
    signals: {
      v: 1,
      plugin: true,
      mock: player.mock,
      ...(player.emulator ? { gnssSatellitesUsed: 0 } : {}),
      ...(player.networkCountry ? { networkCountryIso: player.networkCountry } : {}),
      fixTimestampMs: at.getTime()
    }
  };
}

async function createDatabase(label: string): Promise<{ admin: pg.Pool; name: string; url: string }> {
  const url = new URL(adminUrl!);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname)
    || url.pathname !== "/ash_atlas_stability"
    || !["postgres:", "postgresql:"].includes(url.protocol)
  ) {
    throw new Error("The trust simulation requires a local disposable ash_atlas_stability admin database");
  }
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const name = `ash_atlas_stability_trust_sim_${label}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  return { admin, name, url: url.toString() };
}

/** One world (database + services) under one config. */
class SimWorld {
  readonly rows: Row[] = [];
  readonly pool: pg.Pool;
  readonly cast = players();
  private readonly captured: Array<{ accountId: string; rule: string; weight: number }> = [];
  private readonly sink: TrustSignalSink;
  private readonly trust: TrustService;
  private readonly settlement: SettlementService;
  private readonly reports: LocationReportService;
  private readonly relocationGate: RelocationGate;
  private readonly doorway: AltDoorwayGate;
  private readonly invites: TravelInviteService;
  private readonly environment: DeviceEnvironmentService;
  private readonly zones: PostgresTrustZoneStore;
  private readonly adminOps: TrustAdminOps;
  private readonly adminAccountId = randomUUID();
  private readonly flags = new Map<string, string>();
  private readonly locked = new Set<string>();

  constructor(readonly label: string, readonly config: AppConfig, url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 8 });
    this.trust = new TrustService(new PostgresTrustStateStore(this.pool), config);
    const capture = this.captured;
    const trust = this.trust;
    this.sink = {
      async recordSignals(input) {
        for (const signal of input.signals) capture.push({ accountId: input.accountId, rule: signal.rule, weight: signal.weight });
        await trust.recordSignals(input);
      }
    };
    this.invites = new TravelInviteService(this.pool);
    this.settlement = new SettlementService(new PostgresSettlementStore(this.pool), config, { sink: this.sink, invites: this.invites });
    this.zones = new PostgresTrustZoneStore(this.pool);
    const grid = getPopulationGrid();
    const adminOps = this.adminOps = new TrustAdminOps({
      store: new PostgresTrustAdminOpsStore(this.pool),
      settlement: this.settlement,
      anchors: new PostgresDestinationAnchorStore(this.pool),
      closeConnections: async () => undefined
    });
    this.relocationGate = new RelocationGate({
      config,
      classify: (lat, lon) => grid.classify(lat, lon),
      yellowOwners: (lat, lon, radiusKm, excludeAccountId, limit) =>
        this.zones.yellowOwners(lat, lon, radiusKm, excludeAccountId, limit),
      kingdomOwners: (lat, lon, radiusKm, excludeAccountId, limit) =>
        this.zones.kingdomOwners(lat, lon, radiusKm, excludeAccountId, limit),
      alerts: new PostgresTrustAlertStore(this.pool),
      redZoneLock: adminOps,
      settlement: this.settlement,
      sink: this.sink
    });
    const byIp = new Map(this.cast.map((player) => [player.net.ip, player.net]));
    const ipGeo: IpGeoLookup = {
      isAvailable: () => true,
      lookup: (ip) => {
        const net = byIp.get(ip);
        return net ? { asn: net.asn, organization: net.organization, country: net.country, point: net.point } : null;
      }
    };
    const attestations = new Map(this.cast.map((player) => {
      const verdict = verdictFor(player);
      const attestation: FixAttestation | null = verdict
        ? { id: randomUUID(), method: "play_integrity", outcome: verdict.outcome, assurance: verdict.assurance, tamper: false }
        : null;
      return [player.accountId, attestation] as const;
    }));
    this.reports = new LocationReportService(new PostgresLocationReportStore(this.pool), config, {
      sink: this.sink,
      familiarity: this.trust.isFamiliar,
      settlement: this.settlement,
      ipGeo,
      // Play Integrity / App Attest crypto is not simulated: each player's verdict is injected.
      attestations: { resolve: async ({ accountId }) => attestations.get(accountId) ?? null },
      accountLinks: new AccountLinkMonitor(new PostgresAccountLinkStore(this.pool), config, {
        sink: this.sink,
        alerts: new PostgresTrustAlertStore(this.pool)
      }),
      locationHistory: new LocationHistoryMonitor(new PostgresLocationHistoryStore(this.pool), config, {
        sink: this.sink,
        alerts: new PostgresTrustAlertStore(this.pool)
      })
    });
    const doorwayStore = new PostgresAltDoorwayStore(this.pool);
    this.doorway = new AltDoorwayGate(doorwayStore, config, {
      sink: this.sink,
      devProfilesExempt: () => false,
      sharedNetworkBlock: createSharedNetworkBlock(doorwayStore)
    });
    this.environment = new DeviceEnvironmentService(new PostgresDeviceEnvironmentStore(this.pool), config, { sink: this.sink });
  }

  player(key: string): SimPlayer {
    return this.cast.find((player) => player.key === key)!;
  }

  async seed(): Promise<void> {
    const now = Date.now();
    for (const player of this.cast) {
      await this.pool.query(
        `INSERT INTO accounts (id, status, trust_tier, created_at) VALUES ($1, 'active', $2, $3)`,
        [player.accountId, player.ageDays > 30 ? "standard" : "new", new Date(now - player.ageDays * DAY_MS)]
      );
      await this.pool.query(
        `INSERT INTO players (id, account_id, username, username_normalized, display_color, region_code,
           lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, geom, last_relocated_at)
         VALUES ($1, $2, $3, lower($3), '#3366cc', 'CO', $4, $5, $4, $5, 600, ST_SetSRID(ST_MakePoint($5, $4), 4326), $6)`,
        [player.playerId, player.accountId, `Sim${player.key}${randomUUID().slice(0, 6)}`, player.avatar.lat, player.avatar.lon,
          player.ageDays > 30 ? new Date(now - 40 * DAY_MS) : null]
      );
      await this.pool.query(
        `INSERT INTO device_installations (id, token_hash) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [player.deviceInstallationId, createHash("sha256").update(player.deviceInstallationId).digest("hex")]
      );
      // The login path links every account to the device it signs in on.
      await this.pool.query(
        `INSERT INTO account_device_links (account_id, device_installation_id) VALUES ($1, $2)`,
        [player.accountId, player.deviceInstallationId]
      );
    }
    // dev1: Settled at home in Denver for months. dev5: grandfathered provisional Settled in Phoenix.
    const settled = async (player: SimPlayer, home: { lat: number; lon: number }, provisional: boolean) => {
      await this.pool.query(
        `INSERT INTO account_settlement (account_id, home_lat, home_lon, home_set_at, settled_home_lat, settled_home_lon,
           settled_home_at, target_checks, target_days, counted_checks, counted_days, distinct_positions, settled_at,
           provisional_until)
         VALUES ($1, $2, $3, $4, $2, $3, $4, 26, 5, $5, $6, 4, $4, $7)`,
        [player.accountId, home.lat, home.lon, new Date(now - 60 * DAY_MS), provisional ? 3 : 26, provisional ? 1 : 5,
          provisional ? new Date(now + 20 * DAY_MS) : null]
      );
    };
    await settled(this.player("dev1"), DENVER, false);
    await settled(this.player("dev5"), PHOENIX, true);
    await settled(this.player("dev7"), DENVER, false);
    await this.pool.query(`INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'standard')`, [this.adminAccountId]);
    // dev1 founded a kingdom with its seat in Denver.
    const kingdomId = randomUUID();
    const dev1 = this.player("dev1");
    await this.pool.query(
      `INSERT INTO kingdoms (id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id)
       VALUES ($1, 'sim kingdom', 'Sim Kingdom', $2, $2, $3)`,
      [kingdomId, dev1.playerId, randomUUID()]
    );
    await this.pool.query(
      `INSERT INTO kingdom_seats (id, kingdom_id, lat, lon, geom, territory_radius_m, is_land, is_saltwater,
         inside_major_lake, environment_rules_version, environment_lookup_at, construction_state, completed_at)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($4, $3), 4326), 800, true, false, false, 1, now(), 'complete', now())`,
      [randomUUID(), kingdomId, DENVER.lat, DENVER.lon]
    );
    // dev1's territory: a public home flag in Denver and a rural outpost in Kansas.
    this.flags.set("dev1-home", await this.insertFlag(this.player("dev1"), DENVER, "public"));
    this.flags.set("dev1-outpost", await this.insertFlag(this.player("dev1"), KANSAS_OUTPOST, "public"));
  }

  async insertFlag(owner: SimPlayer, at: { lat: number; lon: number }, accessMode: string): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, access_mode)
       VALUES ($1, $2, 'Trust Sim', $3, $4, 120, ST_SetSRID(ST_MakePoint($4, $3), 4326), $5)`,
      [id, owner.playerId, at.lat, at.lon, accessMode]
    );
    return id;
  }

  private fix(
    player: SimPlayer,
    source: "passive" | "relocation",
    at: { lat: number; lon: number },
    when: Date,
    deviceInstallationId = player.deviceInstallationId
  ): LocationFixInput {
    return {
      accountId: player.accountId,
      playerId: player.playerId,
      source,
      requestId: randomUUID(),
      lat: at.lat,
      lon: at.lon,
      accuracyM: 12,
      clientPlatform: player.platform,
      deviceInstallationId,
      networkHash: null,
      networkPrefixHash: null,
      deviceTimeZone: player.timeZone,
      clientIp: player.net.ip,
      ...(player.networkCountry ? { networkCountryIso: player.networkCountry } : {}),
      sessionId: player.sessionId,
      native: nativeBlock(player, when),
      ...(player.platform !== "web" && player.attestation ? { attestationRef: `simref${player.key}000000000000` } : {}),
      avatarPosition: player.avatar,
      now: when
    };
  }

  // Runs one action and records player × action × outcome (+ alerts, lock, signals it caused).
  async act(
    player: SimPlayer,
    action: string,
    run: () => Promise<Readonly<{ allowed: boolean; detail?: string }>>
  ): Promise<boolean> {
    if (this.locked.has(player.key)) {
      this.rows.push({ player: player.label, action, outcome: "n/a (account locked)" });
      return false;
    }
    const signalStart = this.captured.length;
    const alertsBefore = await this.alertKeys(player);
    const result = await run();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const signals = this.captured.slice(signalStart).filter((signal) => signal.accountId === player.accountId);
    const alerts = (await this.alertKeys(player)).filter((key) => !alertsBefore.includes(key));
    const status = await this.pool.query<{ status: string }>("SELECT status FROM accounts WHERE id = $1", [player.accountId]);
    const lockedNow = status.rows[0]?.status === "suspended";
    if (lockedNow) this.locked.add(player.key);
    const parts = [
      lockedNow ? "**LOCKED**" : result.allowed ? "allowed" : "refused",
      result.detail ?? null,
      alerts.length > 0 ? `alert ${alerts.join(", ")}` : null,
      signals.length > 0 ? `signals ${signals.map((signal) => `${signal.rule}${signal.weight ? ` ${signal.weight > 0 ? "+" : ""}${signal.weight}` : " 0"}`).join(", ")}` : null
    ].filter(Boolean);
    this.rows.push({ player: player.label, action, outcome: parts.join(" · ") });
    return result.allowed && !lockedNow;
  }

  private async alertKeys(player: SimPlayer): Promise<string[]> {
    const result = await this.pool.query<{ id: string; kind: string; status: string }>(
      "SELECT id, kind, status FROM trust_alerts WHERE account_id = $1",
      [player.accountId]
    );
    return result.rows.map((row) => `${row.kind.replace("zone_", "")}/${row.status}`);
  }

  async attest(player: SimPlayer): Promise<void> {
    await this.act(player, "attest (per relocation)", async () => {
      const verdict = verdictFor(player);
      if (!verdict) return { allowed: true, detail: "no attestation (web)" };
      const now = new Date();
      if (this.config.TRUST_ATTESTATION_MODE !== "off") {
        await this.sink.recordSignals({
          accountId: player.accountId,
          signals: verdict.signals.map((rule) => attestSignal(rule, player.accountId, now, randomUUID()))
        });
        const revocation = attestRevocationReason(verdict.signals);
        if (revocation && this.config.TRUST_ATTESTATION_MODE === "enforce") await this.settlement.revoke(player.accountId, revocation);
      }
      await this.environment.record({
        accountId: player.accountId,
        attestationId: null,
        platform: player.platform as "ios" | "android",
        environment: {
          v: 1,
          installId: player.installId,
          ...(player.emulator ? { emulatorHints: ["qemu_props"] } : {}),
          vpnActive: player.net.asn === NETS.vpn.asn,
          ...(player.networkCountry ? { simCountryIso: player.networkCountry, networkCountryIso: player.networkCountry } : {}),
          timeZone: player.timeZone
        },
        fix: player.avatar
      });
      return { allowed: true, detail: `${verdict.outcome} (${verdict.assurance})` };
    });
  }

  async passiveFix(
    player: SimPlayer,
    at: { lat: number; lon: number },
    minutesAgo: number,
    action = "play at home (passive fix)",
    otherDevice = false
  ): Promise<void> {
    await this.act(player, action, async () => {
      if (player.platform === "web") return { allowed: true, detail: "web sends no passive fixes" };
      let device = player.deviceInstallationId;
      if (otherDevice) {
        device = randomUUID();
        await this.pool.query("INSERT INTO device_installations (id, token_hash) VALUES ($1, $2)", [
          device, createHash("sha256").update(device).digest("hex")
        ]);
      }
      const input = this.fix(player, "passive", at, new Date(Date.now() - minutesAgo * MINUTE_MS), device);
      const evaluation = await this.reports.evaluate(input);
      await this.reports.record(input, evaluation, "accepted");
      return { allowed: evaluation.verdict !== "rejected", detail: `${evaluation.verdict}, assurance ${evaluation.assurance ?? "none"}` };
    });
  }

  async relocate(player: SimPlayer, to: { lat: number; lon: number }, action: string): Promise<boolean> {
    return this.act(player, action, async () => {
      const result = await runRelocationPipeline({
        gate: this.relocationGate,
        settlement: this.settlement,
        reports: this.reports,
        relocationStatus: async () => {
          const row = await this.pool.query<{ last_relocated_at: Date | null }>(
            "SELECT last_relocated_at FROM players WHERE id = $1",
            [player.playerId]
          );
          const last = row.rows[0]?.last_relocated_at ?? null;
          return { lastRelocatedAt: last, inCooldown: last !== null && last.getTime() + GPS_RELOCATION_COOLDOWN_MS > Date.now() };
        },
        commitTravel: async (exemption) => {
          // performAuthoritativeTravel: a return home never starts the cooldown.
          await this.pool.query(
            `UPDATE players SET lat = $2, lon = $3, anchor_lat = $2, anchor_lon = $3,
                    geom = ST_SetSRID(ST_MakePoint($3, $2), 4326),
                    last_relocated_at = CASE WHEN $4::boolean THEN last_relocated_at ELSE now() END
              WHERE id = $1`,
            [player.playerId, to.lat, to.lon, exemption === "return_home"]
          );
          player.avatar = to;
          return true;
        }
      }, { clientPlatform: player.platform, fix: this.fix(player, "relocation", to, new Date()) });
      const settled = await this.settlement.isSettled(player.accountId);
      return {
        allowed: result.outcome === "relocated",
        detail: `"${result.message}"${result.evaluation ? ` · fix ${result.evaluation.verdict}` : ""}`
          + `${result.exemption ? ` · ${result.exemption.replace("_", " ")}` : ""} · ${settled ? "Settled" : "not Settled"} after`
      };
    });
  }

  async invite(host: SimPlayer, guest: SimPlayer, action = `invite ${guest.key}`): Promise<string | null> {
    let inviteId: string | null = null;
    await this.act(host, action, async () => {
      const anchor = {
        scopeId: "world" as const,
        layerId: "world",
        center: host.avatar,
        relocationRevision: 0,
        layerGeneration: 0,
        sourceType: "player_anchor" as const,
        sourceId: null
      };
      try {
        const sent = await this.invites.send({
          inviterPlayerId: host.playerId,
          inviteePlayerId: guest.playerId,
          inviterSessionId: host.sessionId,
          anchor,
          requestId: randomUUID(),
          // partyHandler SEND_TRAVEL_INVITE: the doorway runs before a new send.
          beforeCreate: async () => {
            const decision = await this.doorway.check({
              kind: "invite",
              hostPlayerId: host.playerId,
              guestPlayerId: guest.playerId,
              hostPosition: host.avatar,
              destination: doorwayDestinationForAnchor(anchor, host.playerId),
              hostClientPlatform: host.platform
            });
            if (!decision.allowed) throw new TravelInviteError(decision.code as never, decision.message);
          }
        });
        inviteId = sent.inviteId;
        return { allowed: true };
      } catch (error) {
        if (error instanceof TravelInviteError) return { allowed: false, detail: `${error.code}` };
        throw error;
      }
    });
    return inviteId;
  }

  async accept(guest: SimPlayer, host: SimPlayer, inviteId: string | null): Promise<void> {
    await this.act(guest, `accept ${host.key}'s invite`, async () => {
      if (!inviteId) return { allowed: false, detail: "no invite to accept" };
      const requestId = randomUUID();
      const destination = await this.invites.reserveAcceptance(inviteId, guest.playerId, requestId);
      const unanchored = await this.anchors().checkTravel({
        travellerPlayerId: guest.playerId,
        kind: "invite",
        destination: { kind: "world", id: null, travelAnchor: destination.anchor },
        companionHostPlayerId: host.playerId
      });
      if (unanchored) {
        await this.invites.releaseAcceptance(inviteId, guest.playerId, requestId);
        return { allowed: false, detail: unanchored.code };
      }
      await this.invites.completeAcceptance(inviteId, guest.playerId, requestId);
      await this.pool.query(
        `UPDATE players SET lat = $2, lon = $3, geom = ST_SetSRID(ST_MakePoint($3, $2), 4326) WHERE id = $1`,
        [guest.playerId, destination.anchor.center.lat, destination.anchor.center.lon]
      );
      guest.avatar = destination.anchor.center;
      this.doorway.noteArrival(guest.playerId, host.playerId);
      return { allowed: true, detail: "arrived (arrival raid hold starts)" };
    });
  }

  async adminApproveRed(player: SimPlayer): Promise<void> {
    await this.act(player, "admin approves the red alert", async () => {
      const pending = await this.pool.query<{ id: string }>(
        "SELECT id FROM trust_alerts WHERE account_id = $1 AND kind = 'zone_red' AND status = 'pending' LIMIT 1",
        [player.accountId]
      );
      const alertId = pending.rows[0]?.id;
      if (!alertId) return { allowed: false, detail: "no pending red alert" };
      await this.adminOps.decideAlert(alertId, "approve", this.adminAccountId);
      const settled = await this.settlement.isSettled(player.accountId);
      return { allowed: true, detail: settled ? "Settled restored" : "still not Settled" };
    });
  }

  async leadParty(host: SimPlayer, guest: SimPlayer): Promise<void> {
    await this.act(host, `lead Party Travel (${guest.key})`, async () => {
      const decision = await this.doorway.check({
        kind: "party_manual",
        hostPlayerId: host.playerId,
        guestPlayerId: guest.playerId,
        hostPosition: host.avatar,
        destination: { kind: "world" }
      });
      return decision.allowed ? { allowed: true } : { allowed: false, detail: decision.code };
    });
  }

  async placePublicFlag(player: SimPlayer, key: string): Promise<void> {
    await this.act(player, "place flag, public", async () => {
      // The owner's chosen mode applies whether or not they are Settled (owner decision 2026-10-15).
      this.flags.set(key, await this.insertFlag(player, player.avatar, "public"));
      return { allowed: true, detail: "flag is public" };
    });
  }

  async travelToFlag(traveller: SimPlayer, flagKey: string): Promise<void> {
    await this.act(traveller, `travel to ${flagKey}`, async () => {
      const refusal = await this.anchors().checkTravel({
        travellerPlayerId: traveller.playerId,
        kind: "flag",
        destination: { kind: "flag", id: this.flags.get(flagKey)! }
      });
      return refusal ? { allowed: false, detail: refusal.code } : { allowed: true };
    });
  }

  async attackFlag(attacker: SimPlayer, flagKey: string): Promise<void> {
    await this.act(attacker, `attack ${flagKey}`, async () => {
      const flagId = this.flags.get(flagKey)!;
      // landActionGuard.raidAllowed: hostile gate, then the arrival raid hold.
      const hostile = await this.hostile().checkFlagRaid({ playerId: attacker.playerId, flagId, action: "flag_attack" });
      if (!hostile.allowed) return { allowed: false, detail: hostile.code };
      const raid = await this.doorway.checkRaid({ accountId: attacker.accountId, playerId: attacker.playerId, action: "flag_attack", flagId });
      return raid.allowed ? { allowed: true } : { allowed: false, detail: raid.code };
    });
  }

  async attackPlayer(attacker: SimPlayer, target: SimPlayer): Promise<void> {
    await this.act(attacker, `PvP attack ${target.key}`, async () => {
      const decision = await this.hostile().checkPvp({ attackerPlayerId: attacker.playerId, targetPlayerId: target.playerId });
      return decision.allowed ? { allowed: true } : { allowed: false, detail: `${decision.code} (${decision.role})` };
    });
  }

  // Fresh gate instances so a status change is never hidden by the 30 s caches
  // (the live server refreshes them from Settled status listeners).
  private hostile(): HostileActionGate {
    return new HostileActionGate(new PostgresHostileGateStore(this.pool), this.config, { sink: this.sink });
  }

  private anchors(): DestinationAnchorGate {
    return new DestinationAnchorGate(
      new PostgresDestinationAnchorStore(this.pool),
      new DestinationAnchoring(this.zones, this.config),
      this.config,
      { sink: this.sink }
    );
  }

  async scenario(): Promise<void> {
    const [dev1, dev2, dev3, dev4, dev5, dev6, dev7] = ["dev1", "dev2", "dev3", "dev4", "dev5", "dev6", "dev7"]
      .map((key) => this.player(key)) as [SimPlayer, SimPlayer, SimPlayer, SimPlayer, SimPlayer, SimPlayer, SimPlayer];
    // dev1 honest veteran: plays at home, re-relocates home, opens doorways.
    await this.attest(dev1);
    await this.passiveFix(dev1, DENVER, 3);
    await this.relocate(dev1, DENVER_NEAR, "relocate home (Denver)");
    await this.passiveFix(dev1, DENVER_NEAR, 0, "passive fix after relocating");
    // dev2 new honest player in the same city.
    await this.attest(dev2);
    await this.relocate(dev2, DENVER, "first relocate (Denver)");
    await this.passiveFix(dev2, DENVER, 0);
    const dev1Invite = await this.invite(dev1, dev2);
    await this.accept(dev2, dev1, dev1Invite);
    await this.leadParty(dev1, dev2);
    await this.invite(dev2, dev1);
    await this.placePublicFlag(dev2, "dev2-flag");
    await this.travelToFlag(dev1, "dev2-flag");
    await this.attackFlag(dev2, "dev1-home");
    await this.attackPlayer(dev2, dev1);
    await this.attackPlayer(dev1, dev2);
    // dev3 web-only.
    await this.attest(dev3);
    await this.relocate(dev3, DENVER, "relocate from the browser");
    await this.invite(dev3, dev1);
    await this.placePublicFlag(dev3, "dev3-flag");
    // dev4 emulator spoofer: real phone fix near Denver, then "relocates" into the Nevada desert.
    await this.attest(dev4);
    await this.passiveFix(dev4, DENVER_NEAR, 20, "passive fix (emulator)");
    await this.relocate(dev4, NEVADA_RED, "relocate into a red zone (Nevada desert)");
    await this.invite(dev4, dev6);
    await this.attackFlag(dev4, "dev1-home");
    // dev5 provisional veteran starts spoofing: Phoenix -> Paris with US carrier + US fixed-line IP.
    await this.attest(dev5);
    await this.passiveFix(dev5, PHOENIX, 10);
    await this.relocate(dev5, PARIS, "relocate far (Phoenix -> Paris)");
    for (let index = 1; index <= 3; index += 1) await this.passiveFix(dev5, PARIS, 0, `passive fix in Paris #${index}`);
    // The real owner is still in Phoenix on a second phone (shared account), then the spoof app goes off.
    await this.passiveFix(dev5, PHOENIX, 0, "passive fix from a second phone in Phoenix", true);
    await this.passiveFix(dev5, PHOENIX, 0, "passive fix back in Phoenix (spoof off)");
    await this.invite(dev5, dev2);
    await this.placePublicFlag(dev5, "dev5-flag");
    await this.attackFlag(dev5, "dev1-home");
    // dev6 alt farm on dev4's phone: real fixes in Chicago, spoofs next to dev1's territory.
    await this.attest(dev6);
    await this.passiveFix(dev6, CHICAGO, 30);
    await this.relocate(dev6, DENVER_SUBURB, "relocate next to dev1's home flag (urban)");
    await this.relocate(dev6, KANSAS_NEXT_DOOR, "free re-pick next to dev1's rural outpost");
    await this.invite(dev6, dev4, "invite dev4 (same device)");
    await this.invite(dev6, dev1);
    await this.leadParty(dev6, dev1);
    await this.placePublicFlag(dev6, "dev6-flag");
    await this.travelToFlag(dev1, "dev6-flag");
    await this.attackFlag(dev6, "dev1-outpost");
    await this.attackPlayer(dev6, dev1);
    // dev7 Settled veteran tries a rare (red) area, is held for review, then approved.
    await this.attest(dev7);
    await this.passiveFix(dev7, DENVER_NEAR, 600);
    await this.relocate(dev7, NEVADA_RED, "relocate into a red zone (Nevada desert)");
    await this.passiveFix(dev7, DENVER_NEAR, 0, "passive fix back home");
    await this.invite(dev7, dev2, "invite dev2 while held");
    await this.adminApproveRed(dev7);
    await this.invite(dev7, dev1, "invite dev1 after approval");
  }

  async counts(): Promise<Record<string, number>> {
    const tables = [
      "location_reports", "account_trust_events", "trust_alerts", "account_settlement", "account_location_state",
      "device_environment_reports", "travel_invites", "trust_arrivals", "flags"
    ];
    const out: Record<string, number> = {};
    for (const table of tables) {
      out[table] = Number((await this.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]!.n);
    }
    out.suspended = Number((await this.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM accounts WHERE status = 'suspended'")).rows[0]!.n);
    out.relocated = Number((await this.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM players WHERE last_relocated_at > now() - interval '1 day'"
    )).rows[0]!.n);
    const settlementHash = await this.pool.query<{ h: string }>(
      "SELECT md5(coalesce(string_agg(s::text, '|' ORDER BY account_id), '')) AS h FROM account_settlement s"
    );
    out.settlementHash = parseInt(settlementHash.rows[0]!.h.slice(0, 8), 16);
    return out;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function outcomeFor(rows: readonly Row[], player: string, action: string): string {
  return rows.find((row) => row.player.startsWith(player) && row.action === action)?.outcome ?? "";
}

function markdown(worlds: readonly SimWorld[]): string {
  const [production, afterFlips, enforced] = worlds as [SimWorld, SimWorld, SimWorld];
  const lines = [
    "# Trust simulation report (dev1-dev7)",
    "",
    `Generated ${new Date().toISOString()} by \`apps/server/src/auth/trust/trustSimulation.integration.test.ts\` on disposable`,
    "`ash_atlas_stability_trust_sim_*` databases (one per config). Real Postgres-backed trust services, called in handler",
    "order; attestation verdicts and IP geolocation are injected test data (no Play Integrity / DB-IP).",
    "",
    "Configs: **Production** = defaults + `TRUST_RELOCATION_NATIVE_ONLY_MODE=enforce`; **After flips** = production +",
    "`TRUST_LOCATION_REJECT_MODE`, `TRUST_HOSTILE_GATE_MODE`, `TRUST_ENVIRONMENT_SIGNALS_MODE`, `TRUST_MISMATCH_MODE` = enforce;",
    "**Enforce** = every `TRUST_*_MODE=enforce`.",
    "",
    "| Player | Action | Production | After flips | Enforce |",
    "|---|---|---|---|---|"
  ];
  const cell = (world: SimWorld, row: Row) => (world.rows.find((candidate) =>
    candidate.player === row.player && candidate.action === row.action)?.outcome ?? "").replaceAll("|", "/");
  for (const row of production.rows) {
    lines.push(`| ${row.player} | ${row.action} | ${row.outcome.replaceAll("|", "/")} | ${cell(afterFlips, row)} | ${cell(enforced, row)} |`);
  }
  return `${lines.join("\n")}\n`;
}

databaseSuite("trust simulation: dev1..dev7 in production, after-flips and everything-enforce configs", () => {
  const worlds: SimWorld[] = [];
  const databases: Array<{ admin: pg.Pool; name: string }> = [];

  beforeAll(async () => {
    for (const [label, config] of [
      ["prod", prodConfig()],
      ["flips", afterFlipsConfig()],
      ["enforce", enforceAllTrustModes(prodConfig())]
    ] as const) {
      const database = await createDatabase(label);
      databases.push(database);
      const world = new SimWorld(label, config, database.url);
      worlds.push(world);
      await world.seed();
      await world.scenario();
    }
    const reportPath = process.env.TRUST_SIM_REPORT_PATH;
    if (reportPath) {
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, markdown(worlds), "utf8");
    }
  }, 600_000);

  afterAll(async () => {
    for (const world of worlds) await world.close();
    for (const database of databases) {
      await database.admin.query(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
      await database.admin.end();
    }
  });

  it("keeps honest players working and stops the obvious spoofers", () => {
    const [, afterFlips, enforced] = worlds as [SimWorld, SimWorld, SimWorld];
    for (const world of worlds) {
      expect(outcomeFor(world.rows, "dev1", "relocate home (Denver)")).toMatch(/^allowed/u);
      expect(outcomeFor(world.rows, "dev1", "invite dev2")).toMatch(/^allowed/u);
      expect(outcomeFor(world.rows, "dev1", "lead Party Travel (dev2)")).toMatch(/^allowed/u);
      expect(outcomeFor(world.rows, "dev2", "first relocate (Denver)")).toMatch(/^allowed/u);
      expect(outcomeFor(world.rows, "dev2", "accept dev1's invite")).toMatch(/^allowed/u);
      expect(outcomeFor(world.rows, "dev2", "invite dev1")).toContain("TRAVEL_DOORWAY_UNCONFIRMED");
      expect(outcomeFor(world.rows, "dev3", "relocate from the browser")).toMatch(/^refused/u);
      expect(outcomeFor(world.rows, "dev6", "invite dev4 (same device)")).toMatch(/^refused/u);
      // Honest players: never locked, never revoked, no mismatch evidence.
      for (const row of world.rows.filter((entry) => /^dev[123] /u.test(entry.player))) {
        expect(row.outcome, `${row.player} ${row.action}`).not.toMatch(/LOCKED|settled_revoked|mismatch|state_hopping|account_shared/u);
      }
      // Owner decision A: the spoofer is locked whether the mock fix is rejected or not.
      expect(outcomeFor(world.rows, "dev4", "relocate into a red zone (Nevada desert)")).toContain("LOCKED");
      // Owner decision E: the veteran is held, approved and opens doorways again.
      expect(outcomeFor(world.rows, "dev7", "relocate into a red zone (Nevada desert)")).toContain("Settled status is paused");
      expect(outcomeFor(world.rows, "dev7", "invite dev2 while held")).toContain("TRAVEL_DOORWAY_UNCONFIRMED");
      expect(outcomeFor(world.rows, "dev7", "admin approves the red alert")).toContain("Settled restored");
      expect(outcomeFor(world.rows, "dev7", "invite dev1 after approval")).toMatch(/^allowed/u);
      // Owner decisions C/D: Phoenix -> Paris -> Phoenix and two devices far apart.
      expect(outcomeFor(world.rows, "dev5", "passive fix from a second phone in Phoenix")).toMatch(/state_hopping.*account_shared/u);
      expect(outcomeFor(world.rows, "dev6", "play at home (passive fix)")).toContain("multi_account");
    }
    // After the planned flips: the spoofing veteran loses Settled and unsettled spoofers cannot attack.
    expect(outcomeFor(afterFlips.rows, "dev5", "relocate far (Phoenix -> Paris)")).toMatch(/^refused.*settled_revoked/u);
    expect(outcomeFor(afterFlips.rows, "dev6", "attack dev1-outpost")).toContain("HOSTILE_UNSETTLED");
    expect(outcomeFor(enforced.rows, "dev2", "attack dev1-home")).toContain("HOSTILE_UNSETTLED");
  });

  it("dry-runs the Trust Lab against the populated world without writing anything", async () => {
    const world = worlds[0]!;
    const grid = getPopulationGrid();
    const zones = new PostgresTrustZoneStore(world.pool);
    const lab = new TrustLab({
      config: world.config,
      classify: (lat, lon) => grid.classify(lat, lon),
      zoneGridLoaded: () => grid.isAvailable(),
      yellowOwners: (lat, lon, radiusKm, excludeAccountId, limit) => zones.yellowOwners(lat, lon, radiusKm, excludeAccountId, limit)
    });
    const before = await world.counts();
    const spoofer = await lab.dryRun(trustLabProfileSchema.parse({
      ...NEVADA_RED, platform: "android", accountAgeDays: 0.5, mock: true, emulator: true, attestation: "basic_only",
      homeLat: DENVER.lat, homeLon: DENVER.lon, lastFixMinutesAgo: 20, network: "vpn"
    }));
    const neighbour = await lab.dryRun(trustLabProfileSchema.parse({
      ...KANSAS_NEXT_DOOR, platform: "android", accountAgeDays: 2, network: "mobile"
    }));
    const veteran = await lab.dryRun(trustLabProfileSchema.parse({
      ...DENVER_NEAR, platform: "ios", settled: "settled", accountAgeDays: 300, homeLat: DENVER.lat, homeLon: DENVER.lon
    }));
    expect(spoofer.runs[0]!.relocation.outcome).toBe("locked");
    expect(neighbour.yellowOwners).toBeGreaterThan(0);
    expect(neighbour.runs[0]!.relocation.alerts.map((alert) => alert.kind)).toContain("zone_yellow");
    expect(veteran.runs[0]!.relocation.outcome).toBe("relocated");
    expect(await world.counts()).toEqual(before);
  });
});
