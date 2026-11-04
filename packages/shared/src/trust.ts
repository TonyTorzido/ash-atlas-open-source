import { z } from "zod";

// Operator-facing account trust views (docs/architecture/ACCOUNT_TRUST_AND_ANTISPOOF_PLAN.md, WP7).
// Timestamps are ISO-8601 strings. Providers are the raw account_identities.provider values.

export type TrustAdminAccountTier = "new" | "standard" | "trusted" | "restricted";

export type TrustAdminAccountSummary = Readonly<{
  accountId: string;
  playerName: string | null;
  trustTier: TrustAdminAccountTier;
  shadowTier: number;
  // decayedLogodds + priorLogodds, evaluated at generatedAt.
  effectiveLogodds: number;
  decayedLogodds: number;
  priorLogodds: number;
  peakLogodds: number;
  providers: readonly string[];
  createdAt: string;
  lastSignalAt: string | null;
}>;

export type TrustAdminAccountListResponse = Readonly<{
  accounts: readonly TrustAdminAccountSummary[];
  generatedAt: string;
}>;

export type TrustAdminEventView = Readonly<{
  id: string;
  kind: "signal" | "shadow_tier_change" | "tier_change" | "reversal" | "note";
  rule: string;
  weight: number;
  logoddsAfter: number;
  createdAt: string;
  reversedAt: string | null;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type TrustAdminLocationReportView = Readonly<{
  id: string;
  receivedAt: string;
  source: "relocation" | "passive";
  lat: number;
  lon: number;
  accuracyM: number | null;
  speedBucket: string | null;
  impliedKmh: number | null;
  distanceM: number | null;
  verdict: string;
  verdictReason: string | null;
  score: number;
}>;

// Settled status for operators (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md 2, 4.4).
// Targets and progress are server-only for players; only this admin view shows them.
// Homes are rounded to 0.01 degrees.
export type TrustAdminCoordinate = Readonly<{ lat: number; lon: number }>;

export type TrustAdminSettlementView = Readonly<{
  // Settled right now (a provisional row past its window is not).
  settled: boolean;
  settledAt: string | null;
  provisionalUntil: string | null;
  home: TrustAdminCoordinate | null;
  settledHome: TrustAdminCoordinate | null;
  difficulty: number;
  targetChecks: number;
  targetDays: number;
  countedChecks: number;
  countedDays: number;
  distinctPositions: number;
  unsettledAt: string | null;
  unsettleReason: string | null;
}>;

export type TrustAdminAttestationView = Readonly<{
  id: string;
  method: string;
  outcome: string;
  assurance: string;
  reason: string | null;
  createdAt: string;
}>;

// Summarized device environment from one attestation request (raw locale and
// time zone are never stored; only the countries derived from them).
export type TrustAdminEnvironmentView = Readonly<{
  id: string;
  platform: string;
  installIdHash: string;
  installIdPersistent: boolean | null;
  installSource: string | null;
  emulatorHints: readonly string[];
  rootHints: readonly string[];
  debuggerAttached: boolean | null;
  devOptions: boolean | null;
  adbEnabled: boolean | null;
  autoTimeEnabled: boolean | null;
  vpnActive: boolean | null;
  simCountry: string | null;
  networkCountry: string | null;
  cellCountries: readonly string[];
  timeZoneCountries: readonly string[];
  localeCountry: string | null;
  gpsCountries: readonly string[];
  playIntegrity: Readonly<Record<string, unknown>> | null;
  deviceCheckBit0: boolean | null;
  createdAt: string;
}>;

export const TRUST_ARRIVAL_KINDS = ["invite", "party_manual", "party_auto_follow"] as const;

// One trust_arrivals row seen from the account being inspected; `otherAccountId`
// is the host for "brought by" rows and the guest for "brought in" rows.
export type TrustAdminArrivalView = Readonly<{
  id: string;
  otherAccountId: string;
  otherPlayerName: string | null;
  kind: (typeof TRUST_ARRIVAL_KINDS)[number];
  lat: number | null;
  lon: number | null;
  createdAt: string;
}>;

export type TrustAdminAccountDetail = TrustAdminAccountSummary & Readonly<{
  landActionHoldUntil: string | null;
  landActionHoldReason: string | null;
  events: readonly TrustAdminEventView[];
  locationReports: readonly TrustAdminLocationReportView[];
  settlement: TrustAdminSettlementView | null;
  // Newest 20 device attestations.
  attestations: readonly TrustAdminAttestationView[];
  lastFixAssurance: string | null;
  // Newest device environment summaries (attestation requests).
  environments?: readonly TrustAdminEnvironmentView[];
  // Other accounts seen on this account's install ids (alt link).
  installLinkedAccounts?: readonly Readonly<{ accountId: string; playerName: string | null; lastSeenAt: string }>[];
  // Every other account linked by a native install id or a login device (the
  // link is symmetric: each side lists the other). Multi-accounting evidence.
  linkedAccounts?: readonly Readonly<{
    accountId: string;
    playerName: string | null;
    via: readonly ("install" | "login_device")[];
    lastSeenAt: string;
  }>[];
  // Distinct native installs this account used (account sharing evidence).
  nativeDeviceCount?: number;
  // Who brought this account to a destination (this account was the guest).
  broughtBy: readonly TrustAdminArrivalView[];
  // Who this account brought in (this account was the host).
  broughtIn: readonly TrustAdminArrivalView[];
}>;

export type TrustAdminAccountDetailResponse = Readonly<{
  account: TrustAdminAccountDetail;
  generatedAt: string;
}>;

// Alert inbox (plan 4.4). Coordinates are rounded to 0.01 degrees.
export const TRUST_ALERT_KINDS = [
  "zone_red",
  "zone_orange",
  "zone_yellow",
  "mismatch",
  "settled_revoked",
  "mass_arrival",
  "kingdom_proximity",
  "multi_account",
  "account_shared",
  "state_hopping"
] as const;
export type TrustAlertKind = (typeof TRUST_ALERT_KINDS)[number];

export const TRUST_ALERT_STATUSES = ["pending", "approved", "locked", "dismissed"] as const;
export type TrustAlertStatus = (typeof TRUST_ALERT_STATUSES)[number];

// unlock: reactivates an account suspended by a trust lock (admin Lock or the
// automatic new-account red-zone lock) and closes the locked alert.
export const TRUST_ALERT_ACTIONS = ["approve", "lock", "dismiss", "unlock"] as const;
export type TrustAlertAction = (typeof TRUST_ALERT_ACTIONS)[number];

export type TrustAdminAlertView = Readonly<{
  id: string;
  accountId: string;
  playerName: string | null;
  kind: TrustAlertKind;
  severity: number;
  status: TrustAlertStatus;
  lat: number | null;
  lon: number | null;
  // details.count (how many times the same alert fired).
  count: number;
  details: Readonly<Record<string, unknown>>;
  allowanceExpiresAt: string | null;
  decidedAt: string | null;
  createdAt: string;
}>;

export type TrustAdminAlertListResponse = Readonly<{
  alerts: readonly TrustAdminAlertView[];
  total: number;
  limit: number;
  offset: number;
  generatedAt: string;
}>;

export type TrustAdminAlertDecisionResponse = Readonly<{
  alert: TrustAdminAlertView;
  generatedAt: string;
}>;

export const trustAlertListQuerySchema = z.object({
  status: z.enum(TRUST_ALERT_STATUSES).optional(),
  kind: z.enum(TRUST_ALERT_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0)
}).strict();
export type TrustAlertListQuery = z.infer<typeof trustAlertListQuerySchema>;

// Quarantine arrivals since T: suspends every guest the host brought in at or
// after `since`. confirm=false is the dry run (count only); a confirmed call
// may carry the dry-run count so a changed set is refused instead of applied.
export const trustQuarantineArrivalsRequestSchema = z.object({
  since: z.string().datetime(),
  confirm: z.boolean().default(false),
  expectedCount: z.number().int().min(0).max(10_000).optional()
}).strict();
export type TrustQuarantineArrivalsRequest = z.infer<typeof trustQuarantineArrivalsRequestSchema>;

export type TrustQuarantineArrivalsResponse = Readonly<{
  hostAccountId: string;
  since: string;
  dryRun: boolean;
  // Active guests that would be (dry run) or were (confirmed) suspended.
  guestCount: number;
  suspendedCount: number;
}>;

export type TrustAdminSettlementActionResponse = Readonly<{
  accountId: string;
  settlement: TrustAdminSettlementView | null;
  generatedAt: string;
}>;

export type TrustAdminUnanchoredRoute = Readonly<{
  destinationKind: string;
  destinationId: string;
  ownerAccountId: string | null;
  attempts: number;
  travellers: number;
  lastAttemptAt: string;
}>;

export type TrustAdminUnanchoredRoutesResponse = Readonly<{
  routes: readonly TrustAdminUnanchoredRoute[];
  since: string;
  generatedAt: string;
}>;

export const trustUnanchoredRoutesQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(500).default(100)
}).strict();

// Developer Trust Lab (dry run). A simulated device + account profile at a
// chosen point; the server runs the live relocation and doorway decision code
// against an in-memory copy of that profile and returns what would happen in
// the current config and with every trust gate enforced. Nothing is stored.
export const TRUST_LAB_ATTESTATIONS = ["pass", "basic_only", "fail", "unavailable", "none"] as const;
export const TRUST_LAB_SETTLED_STATES = ["unsettled", "settled", "provisional", "moved_away"] as const;
export const TRUST_LAB_NETWORKS = ["none", "mobile", "fixed", "vpn"] as const;

const labLatitude = z.number().finite().min(-90).max(90);
const labLongitude = z.number().finite().min(-180).max(180);
const labCountry = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/u).nullable().default(null);

export const trustLabProfileSchema = z.object({
  lat: labLatitude,
  lon: labLongitude,
  accuracyM: z.number().finite().min(1).max(10_000).default(15),
  platform: z.enum(["web", "ios", "android"]),
  plugin: z.boolean().default(true),
  attestation: z.enum(TRUST_LAB_ATTESTATIONS).default("pass"),
  mock: z.boolean().default(false),
  emulator: z.boolean().default(false),
  root: z.boolean().default(false),
  vpnActive: z.boolean().default(false),
  gnssSatellitesUsed: z.number().int().min(0).max(80).nullable().default(null),
  simCountry: labCountry,
  networkCountry: labCountry,
  deviceTimeZone: z.string().trim().min(1).max(64).nullable().default(null),
  network: z.enum(TRUST_LAB_NETWORKS).default("none"),
  // Where the IP address geolocates; null = same point as the GPS fix.
  ipLat: labLatitude.nullable().default(null),
  ipLon: labLongitude.nullable().default(null),
  accountAgeDays: z.number().finite().min(0).max(3650).default(30),
  settled: z.enum(TRUST_LAB_SETTLED_STATES).default("unsettled"),
  // Current home anchor (and Settled home when settled); null = never relocated.
  homeLat: labLatitude.nullable().default(null),
  homeLon: labLongitude.nullable().default(null),
  // Previous accepted fix, at the home anchor, this many minutes ago (speed check).
  lastFixMinutesAgo: z.number().finite().min(0).max(525_600).nullable().default(120),
  lastRelocatedHoursAgo: z.number().finite().min(0).max(87_600).nullable().default(null),
  priorRelocations: z.number().int().min(0).max(1_000).default(0),
  installAccounts: z.number().int().min(1).max(50).default(1),
  pendingRedAlert: z.boolean().default(false),
  hardMismatchFixes24h: z.number().int().min(0).max(10).default(0)
}).strict().refine((value) => (value.homeLat === null) === (value.homeLon === null), {
  message: "home needs both latitude and longitude"
}).refine((value) => (value.ipLat === null) === (value.ipLon === null), {
  message: "IP location needs both latitude and longitude"
});
export type TrustLabProfile = z.infer<typeof trustLabProfileSchema>;
export type TrustLabProfileInput = z.input<typeof trustLabProfileSchema>;

export type TrustLabSignal = Readonly<{
  rule: string;
  weight: number;
  // Where it fires: relocation, attestation, doorway...
  source: string;
}>;

export type TrustLabAlert = Readonly<{ kind: string; status: string; severity: number | null }>;

export type TrustLabStep = Readonly<{ step: string; result: string; detail: string | null }>;

export type TrustLabRelocation = Readonly<{
  outcome: "relocated" | "refused" | "locked";
  // Exactly what the client shows.
  playerMessage: string;
  steps: readonly TrustLabStep[];
  signals: readonly TrustLabSignal[];
  alerts: readonly TrustLabAlert[];
  revocations: readonly string[];
  cooldown: Readonly<{ exemption: "return_home" | "free_repick" | null; consumed: boolean }>;
  verdict: string | null;
  assurance: string | null;
  holdMinutes: number | null;
  settledBefore: string;
  settledAfter: string;
  settlementEvent: string | null;
  difficulty: number;
}>;

export type TrustLabDoorway = Readonly<{
  action: string;
  allowed: boolean;
  // Allowed only because the gate is in shadow (enforce would refuse).
  shadowOnly: boolean;
  code: string | null;
  message: string | null;
  signals: readonly TrustLabSignal[];
}>;

export type TrustLabRun = Readonly<{
  config: "current" | "enforce";
  modes: Readonly<Record<string, string>>;
  relocation: TrustLabRelocation;
  // Checked one hour after the relocation (or for the profile as entered when
  // it was refused), standing at the point with a fresh fix.
  doorways: readonly TrustLabDoorway[];
}>;

export type TrustLabDryRunResponse = Readonly<{
  zone: "red" | "orange" | "rural" | "urban";
  zoneGridLoaded: boolean;
  yellowOwners: number;
  // Other accounts' kingdoms within the kingdom-proximity radius.
  kingdomOwners: number;
  runs: readonly TrustLabRun[];
  generatedAt: string;
}>;
