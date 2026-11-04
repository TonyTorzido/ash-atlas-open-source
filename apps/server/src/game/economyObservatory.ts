import { randomUUID } from "node:crypto";

import type pg from "pg";

export const ECONOMY_OBSERVATORY_CAPABILITY = "developer:observe" as const;
export const ECONOMY_OBSERVATORY_SCOPES = [
  "existing_world_supply",
  "player_controlled_existing_supply",
  "organization_existing_supply",
  "world_available_supply",
  "committed_or_future_supply"
] as const;
export type EconomySupplyScope = (typeof ECONOMY_OBSERVATORY_SCOPES)[number];

export const ECONOMY_EVENT_KINDS = [
  "SOURCE",
  "SINK",
  "TRANSFER",
  "TRANSFORM",
  "ADMIN",
  "UNKNOWN"
] as const;
export type EconomyEventKind = (typeof ECONOMY_EVENT_KINDS)[number];
export type EconomyAssetKind = "fungible" | "unique";
export type EconomyFlowWindow = "24h" | "7d" | "30d";
export type EconomyHealthLabel =
  | "healthy"
  | "watch"
  | "critical"
  | "stale"
  | "insufficient-data";

const WINDOW_DURATIONS_MS: Record<EconomyFlowWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};
const MAX_HOLDING_ROWS = 50_000;
const MAX_SESSION_ROWS = 10_000;
// Keep reads bounded, but leave the owner-facing explorer and workbook well
// above the old first-100-row behavior. Excel's practical row limit is much
// larger than this safety bound and a partial report is called out in data
// quality metadata when it is reached.
const MAX_EXPORT_ROWS = 100_000;
const MAX_EXPORT_COLUMNS = 16_384;
const MAX_ANALYSIS_EVENT_ROWS = 200_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;
const ACTIVE_WINDOW_SECONDS = 300;
const NON_GAMEPLAY_MESSAGE_TYPES = new Set([
  "PING",
  "TELEMETRY_BATCH",
  "STARTUP_TERMINAL_TELEMETRY",
  "APP_SUSPEND",
  "BUG_REPORT_SUBMIT"
]);

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type EconomyGameplayActivitySink = {
  recordConnectionOpened(connection: EconomyConnectionRecord): void;
  recordConnectionHeartbeat(playerId: string, occurredAt: Date): void;
  recordGameplayActivity(playerId: string, occurredAt: Date): void;
  recordConnectionClosed(connection: EconomyConnectionRecord, closedAt: Date): void;
};

export type EconomyConnectionRecord = Readonly<{
  connectionId: string;
  accountId: string | null;
  authSessionId: string | null;
  playerId: string;
  connectedAt: Date;
}>;

export type EconomyLedgerCustody = Readonly<{
  custodyType:
    | "player_inventory"
    | "player_wallet"
    | "equipment"
    | "backpack"
    | "manor_storage"
    | "city_warehouse"
    | "city_treasury"
    | "city_gold_reserve"
    | "kingdom_treasury"
    | "market_escrow"
    | "market_collection"
    | "world_drop"
    | "external"
    | "unknown";
  custodyId: string;
  playerId?: string | null;
  organizationType?: "city" | "kingdom" | "world" | null;
  organizationId?: string | null;
}>;

export type EconomyLedgerAsset = Readonly<{
  assetKind: EconomyAssetKind;
  assetId: string;
  itemId?: string | null;
  variant?: string;
  uniqueAssetInstanceId?: string | null;
  quantity: bigint;
}>;

export type EconomyLedgerEventInput = Readonly<{
  operationKey: string;
  reason: string;
  sourceSystem?: string;
  metadata?: Readonly<Record<string, unknown>> | undefined;
  occurredAt?: Date | undefined;
  coverageDomain?: string | undefined;
  asset: EconomyLedgerAsset;
  custody: EconomyLedgerCustody;
}>;

export type EconomyLedgerResult = Readonly<{
  applied: boolean;
  transferGroupId?: string;
}>;

export type EconomyHolding = Readonly<{
  supplyScope: EconomySupplyScope;
  existingSupply: boolean;
  assetKind: EconomyAssetKind;
  assetId: string;
  itemId: string | null;
  variant: string;
  uniqueAssetInstanceId: string | null;
  quantity: bigint;
  custodyType: string;
  custodyId: string;
  playerId: string | null;
  organizationType: string | null;
  organizationId: string | null;
}>;

type HoldingRow = {
  supply_scope: EconomySupplyScope;
  existing_supply: boolean;
  asset_kind: EconomyAssetKind;
  asset_id: string;
  item_id: string | null;
  variant: string;
  unique_asset_instance_id: string | null;
  quantity: string;
  custody_type: string;
  custody_id: string;
  player_id: string | null;
  organization_type: string | null;
  organization_id: string | null;
};

type FlowRow = {
  asset_id: string;
  variant: string;
  event_kind: EconomyEventKind;
  leg: "debit" | "credit";
  quantity: string;
  event_count: string;
};

type CoverageRow = {
  domain_key: string;
  status: "complete" | "partial" | "unavailable";
  reliable_from: Date | string;
  last_observed_at: Date | string | null;
  notes: string;
};

type LatestCoverageRow = {
  coverage_domain: string;
  latest_at: Date | string | null;
};

type SessionRow = {
  session_id: string;
  player_id: string;
  state: "connected" | "closed";
  connected_at: Date | string;
  last_seen_at: Date | string;
  last_gameplay_at: Date | string | null;
  disconnected_at: Date | string | null;
  connected_seconds: string;
  active_seconds: string;
  inactive_seconds: string;
};

type WatermarkRow = {
  inventory_watermark: string | null;
  wallet_watermark: string | null;
  economy_latest_at: Date | string | null;
  inventory_latest_at: Date | string | null;
  wallet_latest_at: Date | string | null;
  historical_baseline_available: boolean;
  snapshot_start: Date | string | null;
};

type ReconciliationRow = {
  imbalanced_groups: string;
  transfer_groups: string;
};

type ExistingLedgerEventRow = {
  event_kind: EconomyEventKind;
  leg: "debit" | "credit";
  transfer_group_id: string | null;
  asset_kind: EconomyAssetKind;
  asset_id: string;
  item_id: string | null;
  variant: string;
  unique_asset_instance_id: string | null;
  quantity: string;
  custody_type: string;
  custody_id: string;
  player_id: string | null;
  organization_type: string | null;
  organization_id: string | null;
  source_system: string | null;
  source_operation_key: string | null;
  reason: string;
};

type EconomyAnalysisEventRow = {
  event_id: string;
  event_kind: EconomyEventKind;
  leg: "debit" | "credit";
  asset_kind: EconomyAssetKind;
  asset_id: string;
  item_id: string | null;
  variant: string;
  unique_asset_instance_id: string | null;
  quantity: string;
  custody_type: string;
  custody_id: string;
  player_id: string | null;
  organization_type: string | null;
  organization_id: string | null;
  source_system: string | null;
  reason: string;
  occurred_at: Date | string;
};

type CatalogItemRow = {
  item_id: string;
  display_name: string;
  category: string;
  stackable: boolean;
};

type PlayerAnalysisRow = {
  player_id: string;
  display_name: string | null;
  account_id: string | null;
  account_created_at: Date | string | null;
  last_seen_at: Date | string | null;
  level: number | null;
  kingdom_id: string | null;
  kingdom_name: string | null;
  city_id: string | null;
  city_name: string | null;
  gold: string;
  connected_seconds: string;
  active_seconds: string;
  last_active_at: Date | string | null;
};

type AttemptRow = {
  item_id: string;
  attempts: string;
  successful_attempts: string;
};

export type EconomyAnalysisEvent = Readonly<{
  eventId: string;
  eventKind: EconomyEventKind;
  leg: "debit" | "credit";
  assetKind: EconomyAssetKind;
  assetId: string;
  itemId: string | null;
  variant: string;
  uniqueAssetInstanceId: string | null;
  quantity: bigint;
  custodyType: string;
  custodyId: string;
  playerId: string | null;
  organizationType: string | null;
  organizationId: string | null;
  sourceSystem: string | null;
  reason: string;
  occurredAt: string;
}>;

export type CatalogItem = Readonly<{
  itemId: string;
  displayName: string;
  category: string;
  assetKind: EconomyAssetKind;
}>;

export type AnalysisPlayer = Readonly<{
  playerId: string;
  displayName: string;
  accountId: string | null;
  accountCreatedAt: string | null;
  lastSeenAt: string | null;
  level: number | null;
  kingdomId: string | null;
  kingdomName: string | null;
  cityId: string | null;
  cityName: string | null;
  gold: bigint;
  connectedSeconds: number;
  activeSeconds: number;
  lastActiveAt: string | null;
}>;

export type AttemptEvidence = Readonly<{
  attempts: number | null;
  successfulAttempts: number | null;
  supported: boolean;
  note: string;
}>;

export type SnapshotRead = Readonly<{
  snapshotId: string;
  snapshotAsOf: string;
  snapshotStart: string | null;
  holdings: readonly EconomyHolding[];
  flows: readonly EconomyFlow[];
  analysisEvents: readonly EconomyAnalysisEvent[];
  catalog: readonly CatalogItem[];
  players: readonly AnalysisPlayer[];
  attempts: ReadonlyMap<string, AttemptEvidence>;
  analysisEventsTruncated: boolean;
  coverage: readonly EconomyCoverage[];
  sessions: readonly EconomySession[];
  metadata: EconomySnapshotMetadata;
}>;

export type EconomyCoverage = Readonly<{
  domain: string;
  status: "complete" | "partial" | "unavailable";
  reliableFrom: string;
  lastObservedAt: string | null;
  notes: string;
}>;

export type EconomySession = Readonly<{
  sessionId: string;
  playerId: string;
  state: "connected" | "closed";
  connectedAt: string;
  lastSeenAt: string;
  lastGameplayAt: string | null;
  disconnectedAt: string | null;
  connectedSeconds: number;
  activeSeconds: number;
  inactiveSeconds: number;
}>;

export type EconomySnapshotMetadata = Readonly<{
  snapshotId: string;
  snapshotAsOf: string;
  isolationLevel: "REPEATABLE READ";
  historicalBaselineAvailable: boolean;
  sourceWatermarks: Readonly<{
    inventory: string | null;
    wallet: string | null;
    economyLatestAt: string | null;
    inventoryLatestAt: string | null;
    walletLatestAt: string | null;
  }>;
  reconciliation: Readonly<{
    status: "ok" | "failed";
    transferGroups: number;
    imbalancedGroups: number;
  }>;
  staleness: Readonly<{
    isStale: boolean;
    staleSources: readonly string[];
    maxAgeSeconds: number;
  }>;
}>;

export type EconomyDistribution = Readonly<{
  total: string;
  holderCount: number;
  hhi: number;
  normalizedHhi: number | null;
  topN: Readonly<{ requested: number; actualCount: number; share: number }>;
  topPlayers: readonly Readonly<{ requested: number; actualCount: number; share: number }>[];
  topPercent: Readonly<{ requestedPercent: number; actualCount: number; share: number }>;
  topPercents: readonly Readonly<{ requestedPercent: number; actualCount: number; share: number }>[];
}>;

export type EconomyScopeSummary = Readonly<{
  scope: EconomySupplyScope;
  fungibleUnits: string;
  uniqueAssetCount: number;
  holderCount: number;
  distribution: EconomyDistribution;
  health: EconomyHealthLabel;
  confidence: number;
}>;

export type EconomyFlow = {
  assetId: string;
  variant: string;
  sourceIn: bigint;
  sinkOut: bigint;
  transformIn: bigint;
  transformOut: bigint;
  adminIn: bigint;
  adminOut: bigint;
  unknownIn: bigint;
  unknownOut: bigint;
  transferIn: bigint;
  transferOut: bigint;
  eventCount: number;
  classifiedEventCount: number;
};

export type EconomyFlowView = Readonly<{
  assetId: string;
  variant: string;
  grossIn: string;
  grossOut: string;
  net: string;
  sourceIn: string;
  sinkOut: string;
  transformIn: string;
  transformOut: string;
  adminIn: string;
  adminOut: string;
  unknownIn: string;
  unknownOut: string;
  transferIn: string;
  transferOut: string;
  eventCount: number;
}>;

export type EconomyOverview = Readonly<{
  metadata: EconomySnapshotMetadata;
  scopes: readonly EconomyScopeSummary[];
  flow: readonly EconomyFlowView[];
  coverage: readonly EconomyCoverage[];
  sessions: Readonly<{
    connected: number;
    active: number;
    afk: number;
    activePlayers: number;
  }>;
}>;

export type EconomyPagination = Readonly<{
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
}>;

export type EconomyItemSummary = Readonly<{
  assetId: string;
  variant: string;
  assetKind: EconomyAssetKind;
  displayName: string;
  category: string;
  quantity: string;
  holderCount: number;
  scope: EconomySupplyScope;
}>;

export type EconomyPlayerSummary = Readonly<{
  playerId: string;
  displayName: string;
  accountId: string | null;
  level: number | null;
  kingdom: string | null;
  city: string | null;
  accountAgeDays: number | null;
  activeGameplaySeconds: number;
  connectedSeconds: number;
  lastActiveAt: string | null;
  gold: string;
  fungibleItemCount: number;
  backpackCount: number;
  distinctResourceCount: number;
  quantity: string;
  uniqueAssetCount: number;
  assetCount: number;
  lastSeenAt: string | null;
}>;

export type EconomyReportMetadata = Readonly<{
  windowStart: string;
  windowEnd: string;
  snapshotStart: string | null;
  snapshotEnd: string;
  durationSeconds: number;
  generation: string | null;
  releaseSha: string | null;
  runtimeLabel: string | null;
  coverageStatus: "complete" | "partial" | "unavailable";
  reconciliationStatus: "ok" | "failed";
  activePlayerCount: number;
  totalActiveGameplaySeconds: number;
}>;

export type EconomySourceBreakdown = Readonly<{
  assetId: string;
  variant: string;
  direction: "inflow" | "outflow";
  source: string;
  quantity: string;
  percentage: number;
  eventCount: number;
}>;

export type EconomyAttemptMetrics = Readonly<{
  supported: boolean;
  attempts: number | null;
  successfulAttempts: number | null;
  observedRate: number | null;
  note: string;
}>;

export type EconomyItemReport = Readonly<{
  assetId: string;
  itemName: string;
  category: string;
  variant: string;
  assetKind: EconomyAssetKind;
  startingExistingSupply: string | null;
  endingExistingSupply: string;
  existingSupplyChange: string | null;
  existingSupplyChangePercent: number | null;
  playerControlledEndingSupply: string;
  organizationSupply: string;
  worldAvailableSupply: string;
  committedFutureSupply: string;
  holderCount: number;
  activeHolderCount: number;
  activePlayerCount: number;
  holdingRateAmongActivePlayers: number | null;
  zeroHolderRateAmongActivePlayers: number | null;
  activePlayerMean: number | null;
  activePlayerMedian: number | null;
  holderMean: number | null;
  holderMedian: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  maximum: string;
  top1Share: number;
  top3Share: number;
  top5Share: number;
  top10PercentShare: number;
  hhi: number;
  normalizedHhi: number | null;
  gini: number | null;
  externalInflow: string;
  transformInflow: string;
  transformOutflow: string;
  finalSink: string;
  adminPositive: string;
  adminNegative: string;
  transferInflow: string;
  transferOutflow: string;
  grossInflow: string;
  grossOutflow: string;
  netChange: string | null;
  acquisitionEventCount: number;
  outflowEventCount: number;
  uniqueAcquiringPlayers: number;
  uniqueSpendingPlayers: number;
  acquisitionParticipationRate: number | null;
  spendingParticipationRate: number | null;
  meanAcquiredPerActivePlayer: number | null;
  medianAcquiredPerActivePlayer: number | null;
  meanAcquiredPerAcquiringPlayer: number | null;
  medianAcquiredPerAcquiringPlayer: number | null;
  p90AcquiredPerAcquiringPlayer: number | null;
  maximumAcquiredByPlayer: string;
  meanNetChangePerActivePlayer: number | null;
  medianNetChangePerActivePlayer: number | null;
  externallyAcquiredPerActiveHour: number | null;
  grossAcquiredPerActiveHour: number | null;
  acquisitionEventsPer100ActiveHours: number | null;
  averageTimeBetweenAcquisitionEventsSeconds: number | null;
  attemptMetrics: EconomyAttemptMetrics;
  labels: readonly Readonly<{ label: EconomyHealthLabel | "hard-to-acquire" | "scarce" | "concentrated" | "accumulating" | "contracting" | "high-throughput-healthy"; reasons: readonly string[]; gated: boolean }>[];
}>;

export type EconomyPlayerItemReport = Readonly<{
  playerId: string;
  displayName: string;
  itemId: string;
  itemName: string;
  variant: string;
  startingQuantity: string | null;
  endingQuantity: string;
  externalAcquired: string;
  transformedIn: string;
  transferredIn: string;
  transferredOut: string;
  transformedOut: string;
  finalSink: string;
  grossAcquired: string;
  grossOutflow: string;
  netChange: string | null;
  activeGameplaySeconds: number;
  custodyBreakdown: Readonly<Record<string, string>>;
  kingdom: string | null;
  level: number | null;
  accountAgeDays: number | null;
  endingPercentile: number | null;
  acquisitionPercentile: number | null;
  activePlayerPercentile: number | null;
  holderPercentile: number | null;
  shareOfPlayerControlledSupply: number | null;
  activePlayerMean: number | null;
  activePlayerMedian: number | null;
  holderMean: number | null;
  holderMedian: number | null;
}>;

export type EconomyItemHolder = Readonly<{
  playerId: string;
  displayName: string;
  currentQuantity: string;
  startingQuantity: string | null;
  endingQuantity: string;
  grossAcquired: string;
  grossOutflow: string;
  netChange: string | null;
  shareOfPlayerControlledSupply: number | null;
  percentile: number | null;
  activeGameplaySeconds: number;
  quantityPerActiveGameplayHour: number | null;
  lastActiveAt: string | null;
  level: number | null;
  kingdom: string | null;
  custodyBreakdown: Readonly<Record<string, string>>;
}>;

export type EconomyReportCohort = Readonly<{
  dimension: "level" | "active_time" | "activity" | "account_age" | "social" | "kingdom";
  cohort: string;
  assetId: string;
  activePlayers: number;
  holders: number;
  endingQuantity: string;
  grossAcquired: string;
  grossOutflow: string;
  medianQuantity: number | null;
  holdingRate: number | null;
}>;

export type EconomyDataQuality = Readonly<{
  key: string;
  status: "ok" | "partial" | "unsupported" | "failed";
  detail: string;
}>;

export type EconomyReport = Readonly<{
  metadata: EconomyReportMetadata;
  items: readonly EconomyItemReport[];
  sourceBreakdown: readonly EconomySourceBreakdown[];
  playerItemRows: readonly EconomyPlayerItemReport[];
  cohorts: readonly EconomyReportCohort[];
  coverage: readonly EconomyCoverage[];
  dataQuality: readonly EconomyDataQuality[];
}>;

export function isEconomyGameplayActivityMessage(messageType: string): boolean {
  return !NON_GAMEPLAY_MESSAGE_TYPES.has(messageType);
}

export function calculateDistribution(values: readonly (number | bigint)[]): EconomyDistribution {
  const normalizedValues = values
    .map((value) => typeof value === "bigint" ? Number(value) : value)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => right - left);
  const total = normalizedValues.reduce((sum, value) => sum + value, 0);
  const holderCount = normalizedValues.length;
  if (holderCount === 0 || total <= 0) {
    return {
      total: "0",
      holderCount: 0,
      hhi: 0,
      normalizedHhi: null,
      topN: { requested: 10, actualCount: 0, share: 0 },
      topPlayers: concentrationByCount([], 0),
      topPercent: { requestedPercent: 10, actualCount: 0, share: 0 },
      topPercents: concentrationByPercent([], 0)
    };
  }
  const shares = normalizedValues.map((value) => value / total);
  const hhi = shares.reduce((sum, share) => sum + share * share, 0);
  const normalizedHhi = holderCount <= 1
    ? 1
    : Math.max(0, Math.min(1, (hhi - 1 / holderCount) / (1 - 1 / holderCount)));
  const topPlayers = concentrationByCount(normalizedValues, total);
  const topPercents = concentrationByPercent(normalizedValues, total);
  return {
    total: bigintSafeIntegerString(total),
    holderCount,
    hhi,
    normalizedHhi,
    topN: topPlayers[topPlayers.length - 1] ?? { requested: 10, actualCount: 0, share: 0 },
    topPlayers,
    topPercent: topPercents[topPercents.length - 1] ?? { requestedPercent: 10, actualCount: 0, share: 0 },
    topPercents
  };
}

export function calculateDistributionFromBigints(values: readonly bigint[]): EconomyDistribution {
  const total = values.reduce((sum, value) => sum + value, 0n);
  const positive = values.filter((value) => value > 0n).sort((left, right) => left > right ? -1 : left < right ? 1 : 0);
  if (positive.length === 0 || total <= 0n) {
    return {
      total: "0", holderCount: 0, hhi: 0, normalizedHhi: null,
      topN: { requested: 10, actualCount: 0, share: 0 },
      topPlayers: concentrationByCount([], 0n),
      topPercent: { requestedPercent: 10, actualCount: 0, share: 0 },
      topPercents: concentrationByPercent([], 0n)
    };
  }
  const shares = positive.map((value) => bigintRatio(value, total));
  const hhi = shares.reduce((sum, share) => sum + share * share, 0);
  const holderCount = positive.length;
  const normalizedHhi = holderCount <= 1
    ? 1
    : Math.max(0, Math.min(1, (hhi - 1 / holderCount) / (1 - 1 / holderCount)));
  const topPlayers = concentrationByCount(positive, total);
  const topPercents = concentrationByPercent(positive, total);
  return {
    total: total.toString(),
    holderCount,
    hhi,
    normalizedHhi,
    topN: topPlayers[topPlayers.length - 1] ?? { requested: 10, actualCount: 0, share: 0 },
    topPlayers,
    topPercent: topPercents[topPercents.length - 1] ?? { requestedPercent: 10, actualCount: 0, share: 0 },
    topPercents
  };
}

export function economyHealthLabel(input: Readonly<{
  coverage: number;
  eventCount: number;
  holderCount: number;
  reconciliationOk: boolean;
  stale: boolean;
  normalizedHhi?: number | null;
  activePlayerCount?: number;
  historicalBaselineAvailable?: boolean;
  observationWindowMs?: number;
}>): EconomyHealthLabel {
  if (input.stale) return "stale";
  if (!input.reconciliationOk) return "critical";
  if (
    input.coverage < 0.8 ||
    input.eventCount < 5 ||
    input.holderCount < 2 ||
    (input.activePlayerCount !== undefined && input.activePlayerCount < 2) ||
    input.historicalBaselineAvailable === false ||
    (input.observationWindowMs !== undefined && input.observationWindowMs < 24 * 60 * 60 * 1000)
  ) {
    return "insufficient-data";
  }
  if ((input.normalizedHhi ?? 0) >= 0.8) return "watch";
  return "healthy";
}

export function transferConservation(legs: readonly Readonly<{ leg: "debit" | "credit"; quantity: bigint }>[]): bigint {
  return legs.reduce(
    (net, leg) => net + (leg.leg === "credit" ? leg.quantity : -leg.quantity),
    0n
  );
}

type TopPlayerConcentration = Readonly<{ requested: number; actualCount: number; share: number }>;
type TopPercentConcentration = Readonly<{ requestedPercent: number; actualCount: number; share: number }>;

function concentrationByCount(
  values: readonly (number | bigint)[],
  total: number | bigint
): TopPlayerConcentration[] {
  return [1, 3, 5, 10].map((requested) => {
    const actualCount = Math.min(requested, values.length);
    const selected = values.slice(0, actualCount);
    const selectedTotal = selected.reduce<number | bigint>(
      (sum, value) => typeof sum === "bigint" || typeof value === "bigint"
        ? BigInt(sum) + BigInt(value)
        : sum + value,
      typeof total === "bigint" ? 0n : 0
    );
    return {
      requested,
      actualCount,
      share: ratio(selectedTotal, total)
    };
  });
}

function concentrationByPercent(
  values: readonly (number | bigint)[],
  total: number | bigint
): TopPercentConcentration[] {
  return [1, 5, 10].map((requestedPercent) => {
    const actualCount = values.length === 0
      ? 0
      : Math.min(values.length, Math.max(1, Math.ceil(values.length * requestedPercent / 100)));
    const selected = values.slice(0, actualCount);
    const selectedTotal = selected.reduce<number | bigint>(
      (sum, value) => typeof sum === "bigint" || typeof value === "bigint"
        ? BigInt(sum) + BigInt(value)
        : sum + value,
      typeof total === "bigint" ? 0n : 0
    );
    return {
      requestedPercent,
      actualCount,
      share: ratio(selectedTotal, total)
    };
  });
}

function ratio(numerator: number | bigint, denominator: number | bigint): number {
  if (typeof numerator === "bigint" || typeof denominator === "bigint") {
    const numeratorBigInt = BigInt(numerator);
    const denominatorBigInt = BigInt(denominator);
    return denominatorBigInt <= 0n ? 0 : bigintRatio(numeratorBigInt, denominatorBigInt);
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function bigintRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  const scale = 1_000_000_000_000n;
  return Number((numerator * scale) / denominator) / Number(scale);
}

export class EconomyLedgerService {
  constructor(private readonly pool: pg.Pool) {}

  async recordSource(input: EconomyLedgerEventInput): Promise<EconomyLedgerResult> {
    return this.recordSingle(input, "SOURCE", "credit");
  }

  async recordSink(input: EconomyLedgerEventInput): Promise<EconomyLedgerResult> {
    return this.recordSingle(input, "SINK", "debit");
  }

  async recordAdminCredit(input: EconomyLedgerEventInput): Promise<EconomyLedgerResult> {
    return this.recordSingle(input, "ADMIN", "credit");
  }

  async recordAdminDebit(input: EconomyLedgerEventInput): Promise<EconomyLedgerResult> {
    return this.recordSingle(input, "ADMIN", "debit");
  }

  async recordUnknown(input: EconomyLedgerEventInput, leg: "debit" | "credit"): Promise<EconomyLedgerResult> {
    return this.recordSingle(input, "UNKNOWN", leg);
  }

  async recordTransfer(input: Readonly<{
    operationKey: string;
    reason: string;
    asset: EconomyLedgerAsset;
    debit: EconomyLedgerCustody;
    credit: EconomyLedgerCustody;
    metadata?: Readonly<Record<string, unknown>> | undefined;
    occurredAt?: Date | undefined;
    coverageDomain?: string | undefined;
  }>): Promise<EconomyLedgerResult> {
    validateAsset(input.asset);
    const client = await this.pool.connect();
    const transferGroupId = randomUUID();
    try {
      await client.query("BEGIN");
      const group = await client.query<{ transfer_group_id: string }>(
        `INSERT INTO economy_transfer_groups (transfer_group_id, operation_key, reason)
         VALUES ($1,$2,$3)
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING transfer_group_id::text`,
        [transferGroupId, input.operationKey, input.reason]
      );
      const existing = group.rows[0]?.transfer_group_id ?? (
        await client.query<{ transfer_group_id: string }>(
          "SELECT transfer_group_id::text FROM economy_transfer_groups WHERE operation_key=$1",
          [input.operationKey]
        )
      ).rows[0]?.transfer_group_id;
      if (!existing) throw new Error("Economy transfer group could not be created");
      const existingGroupEvents = await client.query<{ source_system: string | null; source_id: string | null }>(
        "SELECT source_system, source_id FROM economy_events WHERE transfer_group_id=$1",
        [existing]
      );
      if (existingGroupEvents.rows.some((row) => row.source_system !== "economy_ledger")) {
        throw new Error(`Economy transfer group ${existing} is owned by another source`);
      }
      const expectedSourceIds = new Set([
        `${input.operationKey}:debit`,
        `${input.operationKey}:credit`
      ]);
      const existingSourceIds = existingGroupEvents.rows.map((row) => row.source_id);
      if (
        existingSourceIds.length > 0 &&
        (existingSourceIds.length !== expectedSourceIds.size ||
          existingSourceIds.some((sourceId) => !sourceId || !expectedSourceIds.has(sourceId)))
      ) {
        throw new Error(`Economy transfer operation ${input.operationKey} was reused with different intent`);
      }
      const debitApplied = await this.insertEvent(client, {
        ...input,
        sourceSystem: "economy_ledger",
        operationKey: input.operationKey,
        custody: input.debit
      }, "TRANSFER", "debit", existing, `${input.operationKey}:debit`);
      const creditApplied = await this.insertEvent(client, {
        ...input,
        sourceSystem: "economy_ledger",
        operationKey: input.operationKey,
        custody: input.credit
      }, "TRANSFER", "credit", existing, `${input.operationKey}:credit`);
      await client.query("COMMIT");
      return { applied: debitApplied || creditApplied, transferGroupId: existing };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordTransform(input: Readonly<{
    operationKey: string;
    reason: string;
    inputs: readonly Readonly<{ asset: EconomyLedgerAsset; custody: EconomyLedgerCustody }>[];
    outputs: readonly Readonly<{ asset: EconomyLedgerAsset; custody: EconomyLedgerCustody }>[];
    metadata?: Readonly<Record<string, unknown>> | undefined;
    occurredAt?: Date | undefined;
    coverageDomain?: string | undefined;
  }>): Promise<EconomyLedgerResult> {
    if (input.inputs.length === 0 || input.outputs.length === 0) {
      throw new Error("An economy transform requires at least one input and output");
    }
    input.inputs.forEach(({ asset }) => validateAsset(asset));
    input.outputs.forEach(({ asset }) => validateAsset(asset));
    const client = await this.pool.connect();
    const eventGroupId = randomUUID();
    try {
      await client.query("BEGIN");
      let applied = false;
      for (const [index, entry] of input.inputs.entries()) {
        applied = await this.insertEvent(client, {
          operationKey: input.operationKey,
          reason: input.reason,
          sourceSystem: "economy_ledger",
          metadata: input.metadata,
          occurredAt: input.occurredAt,
          coverageDomain: input.coverageDomain,
          asset: entry.asset,
          custody: entry.custody
        }, "TRANSFORM", "debit", null, `${input.operationKey}:input:${index}`, eventGroupId) || applied;
      }
      for (const [index, entry] of input.outputs.entries()) {
        applied = await this.insertEvent(client, {
          operationKey: input.operationKey,
          reason: input.reason,
          sourceSystem: "economy_ledger",
          metadata: input.metadata,
          occurredAt: input.occurredAt,
          coverageDomain: input.coverageDomain,
          asset: entry.asset,
          custody: entry.custody
        }, "TRANSFORM", "credit", null, `${input.operationKey}:output:${index}`, eventGroupId) || applied;
      }
      const expectedSourceIds = new Set([
        ...input.inputs.map((_, index) => `${input.operationKey}:input:${index}`),
        ...input.outputs.map((_, index) => `${input.operationKey}:output:${index}`)
      ]);
      const existingSourceIds = await client.query<{ source_id: string }>(
        `SELECT source_id
         FROM economy_events
         WHERE source_system='economy_ledger' AND source_operation_key=$1`,
        [input.operationKey]
      );
      if (
        existingSourceIds.rows.length !== expectedSourceIds.size ||
        existingSourceIds.rows.some((row) => !expectedSourceIds.has(row.source_id)) ||
        [...expectedSourceIds].some((sourceId) => !existingSourceIds.rows.some((row) => row.source_id === sourceId))
      ) {
        throw new Error(`Economy transform operation ${input.operationKey} was reused with different intent`);
      }
      await client.query("COMMIT");
      return { applied };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async recordSingle(
    input: EconomyLedgerEventInput,
    kind: Exclude<EconomyEventKind, "TRANSFER" | "TRANSFORM">,
    leg: "debit" | "credit"
  ): Promise<EconomyLedgerResult> {
    validateAsset(input.asset);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const applied = await this.insertEvent(client, input, kind, leg, null, input.operationKey);
      await client.query("COMMIT");
      return { applied };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertEvent(
    queryable: Queryable,
    input: EconomyLedgerEventInput,
    eventKind: EconomyEventKind,
    leg: "debit" | "credit",
    transferGroupId: string | null,
    sourceId: string,
    eventGroupId = randomUUID()
  ): Promise<boolean> {
    const asset = input.asset;
    const custody = input.custody;
    const sourceSystem = input.sourceSystem ?? "economy_ledger";
    const existing = await queryable.query<ExistingLedgerEventRow>(
      `SELECT event_kind, leg, transfer_group_id::text, asset_kind, asset_id,
              item_id, variant, unique_asset_instance_id::text, quantity::text,
              custody_type, custody_id, player_id, organization_type,
              organization_id, source_system, source_operation_key, reason
       FROM economy_events
       WHERE source_system=$1 AND source_id=$2`,
      [sourceSystem, sourceId]
    );
    if (existing.rows[0]) {
      assertLedgerEventMatches(existing.rows[0], input, eventKind, leg, transferGroupId, sourceSystem, sourceId);
      return false;
    }
    const result = await queryable.query(
      `INSERT INTO economy_events (
         event_group_id, transfer_group_id, leg, event_kind, asset_kind, asset_id,
         item_id, variant, unique_asset_instance_id, quantity, custody_type, custody_id,
         player_id, organization_type, organization_id, source_system, source_id,
         source_operation_key, reason, metadata, occurred_at, coverage_domain
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22)
       ON CONFLICT (source_system, source_id) DO NOTHING`,
      [
        eventGroupId,
        transferGroupId,
        leg,
        eventKind,
        asset.assetKind,
        asset.assetId,
        asset.itemId ?? null,
        asset.variant ?? "default",
        asset.uniqueAssetInstanceId ?? null,
        asset.quantity.toString(),
        custody.custodyType,
        custody.custodyId,
        custody.playerId ?? null,
        custody.organizationType ?? null,
        custody.organizationId ?? null,
        sourceSystem,
        sourceId,
        input.operationKey,
        input.reason,
        JSON.stringify(input.metadata ?? {}),
        input.occurredAt ?? new Date(),
        input.coverageDomain ?? "manual"
      ]
    );
    if (result.rowCount === 1) return true;
    const replay = await queryable.query<ExistingLedgerEventRow>(
      `SELECT event_kind, leg, transfer_group_id::text, asset_kind, asset_id,
              item_id, variant, unique_asset_instance_id::text, quantity::text,
              custody_type, custody_id, player_id, organization_type,
              organization_id, source_system, source_operation_key, reason
       FROM economy_events
       WHERE source_system=$1 AND source_id=$2`,
      [sourceSystem, sourceId]
    );
    if (!replay.rows[0]) throw new Error("Economy ledger event disappeared after an idempotent insert");
    assertLedgerEventMatches(replay.rows[0], input, eventKind, leg, transferGroupId, sourceSystem, sourceId);
    return false;
  }
}

function assertLedgerEventMatches(
  row: ExistingLedgerEventRow,
  input: EconomyLedgerEventInput,
  eventKind: EconomyEventKind,
  leg: "debit" | "credit",
  transferGroupId: string | null,
  sourceSystem: string,
  sourceId: string
): void {
  const asset = input.asset;
  const custody = input.custody;
  const matches = row.event_kind === eventKind
    && row.leg === leg
    && row.transfer_group_id === transferGroupId
    && row.asset_kind === asset.assetKind
    && row.asset_id === asset.assetId
    && row.item_id === (asset.itemId ?? null)
    && row.variant === (asset.variant ?? "default")
    && row.unique_asset_instance_id === (asset.uniqueAssetInstanceId ?? null)
    && row.quantity === asset.quantity.toString()
    && row.custody_type === custody.custodyType
    && row.custody_id === custody.custodyId
    && row.player_id === (custody.playerId ?? null)
    && row.organization_type === (custody.organizationType ?? null)
    && row.organization_id === (custody.organizationId ?? null)
    && row.source_system === sourceSystem
    && row.source_operation_key === input.operationKey
    && row.reason === input.reason;
  if (!matches) {
    throw new Error(`Economy ledger source identity ${sourceSystem}:${sourceId} was reused with different intent`);
  }
}

export class EconomyObservatoryService implements EconomyGameplayActivitySink {
  readonly ledger: EconomyLedgerService;
  private sessionWrite: Promise<void> = Promise.resolve();

  constructor(private readonly pool: pg.Pool) {
    this.ledger = new EconomyLedgerService(pool);
  }

  recordConnectionOpened(connection: EconomyConnectionRecord): void {
    this.enqueueSessionWrite(() => this.pool.query(
      `INSERT INTO economy_sessions (
         session_id, connection_id, account_id, auth_session_id, player_id,
         connected_at, last_seen_at, state
       ) VALUES ($1,$2,$3,$4,$5,$6,$6,'connected')
       ON CONFLICT (connection_id) DO UPDATE
       SET account_id=EXCLUDED.account_id,
           auth_session_id=EXCLUDED.auth_session_id,
           player_id=EXCLUDED.player_id,
           connected_at=EXCLUDED.connected_at,
           last_seen_at=EXCLUDED.last_seen_at,
           last_gameplay_at=NULL,
           disconnected_at=NULL,
           connected_seconds=0,
           active_seconds=0,
           inactive_seconds=0,
           state='connected',
           close_reason=NULL,
           revision=economy_sessions.revision+1,
           updated_at=clock_timestamp()`,
      [
        randomUUID(),
        connection.connectionId,
        connection.accountId,
        connection.authSessionId,
        connection.playerId,
        connection.connectedAt
      ]
    ).then(() => undefined));
  }

  recordConnectionHeartbeat(playerId: string, occurredAt: Date): void {
    this.enqueueSessionWrite(() => this.pool.query(
      `UPDATE economy_sessions session
       SET connected_seconds=greatest(
             session.connected_seconds,
             floor(extract(epoch FROM ($2::timestamptz - session.connected_at)))::bigint
           ),
           inactive_seconds=greatest(
             0,
             greatest(
               session.connected_seconds,
               floor(extract(epoch FROM ($2::timestamptz - session.connected_at)))::bigint
             ) - session.active_seconds
           ),
           last_seen_at=$2,
           revision=session.revision+1,
           updated_at=clock_timestamp()
       WHERE session.player_id=$1 AND session.state='connected'`,
      [playerId, occurredAt]
    ).then(() => undefined));
  }

  recordGameplayActivity(playerId: string, occurredAt: Date): void {
    this.enqueueSessionWrite(() => this.pool.query(
      `WITH durations AS (
         SELECT session_id,
                greatest(0, floor(extract(epoch FROM ($2::timestamptz - connected_at))))::bigint AS connected,
                CASE WHEN last_gameplay_at IS NULL THEN 0::bigint
                     ELSE least($3::bigint, greatest(0, floor(extract(epoch FROM ($2::timestamptz - last_gameplay_at))))::bigint)
                END AS active_delta
         FROM economy_sessions
         WHERE player_id=$1 AND state='connected'
       )
       UPDATE economy_sessions session
       SET connected_seconds=durations.connected,
           active_seconds=least(durations.connected, session.active_seconds + durations.active_delta),
           inactive_seconds=greatest(0, durations.connected - least(durations.connected, session.active_seconds + durations.active_delta)),
           last_seen_at=$2,
           last_gameplay_at=$2,
           revision=session.revision+1,
           updated_at=clock_timestamp()
       FROM durations
       WHERE session.session_id=durations.session_id`,
      [playerId, occurredAt, ACTIVE_WINDOW_SECONDS]
    ).then(() => undefined));
  }

  recordConnectionClosed(connection: EconomyConnectionRecord, closedAt: Date): void {
    this.enqueueSessionWrite(() => this.pool.query(
      `WITH durations AS (
         SELECT session_id,
                greatest(0, floor(extract(epoch FROM ($2::timestamptz - connected_at))))::bigint AS connected,
                CASE WHEN last_gameplay_at IS NULL THEN 0::bigint
                     ELSE least($3::bigint, greatest(0, floor(extract(epoch FROM ($2::timestamptz - last_gameplay_at))))::bigint)
                END AS active_delta
         FROM economy_sessions
         WHERE connection_id=$1 AND state='connected'
       )
       UPDATE economy_sessions session
       SET connected_seconds=durations.connected,
           active_seconds=least(durations.connected, session.active_seconds + durations.active_delta),
           inactive_seconds=greatest(0, durations.connected - least(durations.connected, session.active_seconds + durations.active_delta)),
           last_seen_at=$2,
           disconnected_at=$2,
           state='closed',
           close_reason='connection_closed',
           revision=session.revision+1,
           updated_at=clock_timestamp()
       FROM durations
       WHERE session.session_id=durations.session_id`,
      [connection.connectionId, closedAt, ACTIVE_WINDOW_SECONDS]
    ).then(() => undefined));
  }

  private enqueueSessionWrite(write: () => Promise<void>): void {
    this.sessionWrite = this.sessionWrite.then(write, write).catch(() => undefined);
  }

  async overview(window: EconomyFlowWindow = "24h"): Promise<EconomyOverview> {
    const snapshot = await this.readSnapshot(window);
    const completeCoverage = snapshot.coverage.filter((row) => row.status === "complete").length;
    const coverageConfidence = snapshot.coverage.length === 0 ? 0 : completeCoverage / snapshot.coverage.length;
    const sessions = summarizeSessions(snapshot.sessions, snapshot.snapshotAsOf);
    const eventCount = snapshot.flows.reduce((sum, row) => sum + row.classifiedEventCount, 0);
    const scopes = ECONOMY_OBSERVATORY_SCOPES.map((scope) => summarizeScope(
      scope,
      snapshot.holdings.filter((holding) => holding.supplyScope === scope),
      snapshot.metadata,
      coverageConfidence,
      eventCount,
      sessions.activePlayers,
      snapshot.metadata.historicalBaselineAvailable,
      WINDOW_DURATIONS_MS[window]
    ));
    return {
      metadata: snapshot.metadata,
      scopes,
      flow: snapshot.flows.map(flowView),
      coverage: snapshot.coverage,
      sessions
    };
  }

  async listItems(input: Readonly<{
    scope?: EconomySupplyScope | undefined;
    search?: string | undefined;
    limit?: number | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
    sort?: "quantity" | "holders" | "assetId" | "displayName" | undefined;
    direction?: "asc" | "desc" | undefined;
    category?: string | undefined;
    assetKind?: EconomyAssetKind | undefined;
    window?: EconomyFlowWindow | undefined;
  }> = {}): Promise<Readonly<{ metadata: EconomySnapshotMetadata; items: readonly EconomyItemSummary[]; pagination: EconomyPagination }>> {
    const snapshot = await this.readSnapshot(input.window ?? "24h");
    const search = (input.search ?? "").trim().toLowerCase();
    const scope = input.scope ?? "existing_world_supply";
    const catalogById = new Map(snapshot.catalog.map((item) => [item.itemId, item]));
    const grouped = new Map<string, { assetKind: EconomyAssetKind; quantity: bigint; holders: Set<string>; displayName: string; category: string }>();
    for (const item of snapshot.catalog) {
      if (input.assetKind && item.assetKind !== input.assetKind) continue;
      if (input.category && item.category !== input.category) continue;
      if (search && !`${item.itemId} ${item.displayName}`.toLowerCase().includes(search)) continue;
      grouped.set(`${item.itemId}\u0000default`, {
        assetKind: item.assetKind,
        quantity: 0n,
        holders: new Set<string>(),
        displayName: item.displayName,
        category: item.category
      });
    }
    for (const holding of snapshot.holdings) {
      const catalog = catalogById.get(holding.assetId);
      if (holding.supplyScope !== scope || (search && !`${holding.assetId} ${catalog?.displayName ?? ""}`.toLowerCase().includes(search))) continue;
      if (input.assetKind && holding.assetKind !== input.assetKind) continue;
      if (input.category && catalog?.category !== input.category) continue;
      const key = `${holding.assetId}\u0000${holding.variant}`;
      const current = grouped.get(key) ?? {
        assetKind: holding.assetKind,
        quantity: 0n,
        holders: new Set<string>(),
        displayName: catalog?.displayName ?? holding.assetId,
        category: catalog?.category ?? "unknown"
      };
      current.quantity += holding.quantity;
      current.holders.add(holderKey(holding));
      grouped.set(key, current);
    }
    const allItems = [...grouped.entries()]
      .map(([key, value]) => {
        const [assetId, variant] = key.split("\u0000");
        return {
          assetId: assetId ?? "",
          variant: variant ?? "default",
          assetKind: value.assetKind,
          displayName: value.displayName,
          category: value.category,
          quantity: value.quantity.toString(),
          holderCount: value.holders.size,
          scope
        } satisfies EconomyItemSummary;
      })
      .sort(itemComparator(input.sort ?? "quantity", input.direction ?? "desc"));
    const pagination = pageDetails(input.page, input.pageSize ?? input.limit, allItems.length);
    return { metadata: snapshot.metadata, items: allItems.slice((pagination.page - 1) * pagination.pageSize, pagination.page * pagination.pageSize), pagination };
  }

  async inspectItem(
    assetId: string,
    scope: EconomySupplyScope = "existing_world_supply",
    window: EconomyFlowWindow = "24h",
    input: Readonly<{
      search?: string | undefined;
      page?: number | undefined;
      pageSize?: number | undefined;
      sort?: "currentQuantity" | "grossAcquired" | "grossOutflow" | "netChange" | "percentile" | "activeGameplaySeconds" | "displayName" | undefined;
      direction?: "asc" | "desc" | undefined;
      activeOnly?: boolean | undefined;
      levelMin?: number | undefined;
      levelMax?: number | undefined;
      kingdom?: string | undefined;
      activityCohort?: string | undefined;
      accountAgeCohort?: string | undefined;
    }> = {}
  ): Promise<Readonly<{ metadata: EconomySnapshotMetadata; item: EconomyItemSummary | null; holders: readonly EconomyItemHolder[]; pagination: EconomyPagination; report: EconomyItemReport | null }>> {
    const snapshot = await this.readSnapshot(window);
    const rows = snapshot.holdings.filter((holding) => holding.supplyScope === scope && holding.assetId === assetId);
    const report = buildEconomyReport(snapshot, window);
    const reportItem = report.items.find((item) => item.assetId === assetId) ?? null;
    if (rows.length === 0 && !reportItem) return { metadata: snapshot.metadata, item: null, holders: [], pagination: pageDetails(input.page, input.pageSize, 0), report: null };
    const byHolder = new Map<string, bigint>();
    for (const holding of rows) byHolder.set(holderKey(holding), (byHolder.get(holderKey(holding)) ?? 0n) + holding.quantity);
    const quantity = [...byHolder.values()].reduce((sum, value) => sum + value, 0n);
    const holderRows = report.playerItemRows
      .filter((row) => row.itemId === assetId && BigInt(row.endingQuantity) > 0n)
      .map((row) => itemHolderFromPlayerItem(row, snapshot, scope))
      .filter((holder) => holderMatches(holder, input, snapshot.snapshotAsOf, snapshot.players))
      .filter((holder) => !input.search || `${holder.playerId} ${holder.displayName}`.toLowerCase().includes(input.search.trim().toLowerCase()))
      .sort(holderComparator(input.sort ?? "currentQuantity", input.direction ?? "desc"))
      .map((holder) => ({
        ...holder,
        shareOfPlayerControlledSupply: reportItem && BigInt(reportItem.playerControlledEndingSupply) > 0n
          ? Number(holder.currentQuantity) / Number(reportItem.playerControlledEndingSupply)
          : null
      }));
    const pagination = pageDetails(input.page, input.pageSize, holderRows.length);
    return {
      metadata: snapshot.metadata,
      item: {
        assetId,
        variant: rows[0]?.variant ?? "default",
        assetKind: rows[0]?.assetKind ?? snapshot.catalog.find((item) => item.itemId === assetId)?.assetKind ?? "fungible",
        displayName: snapshot.catalog.find((item) => item.itemId === assetId)?.displayName ?? assetId,
        category: snapshot.catalog.find((item) => item.itemId === assetId)?.category ?? "unknown",
        quantity: quantity.toString(),
        holderCount: byHolder.size,
        scope
      },
      holders: holderRows.slice((pagination.page - 1) * pagination.pageSize, pagination.page * pagination.pageSize),
      pagination,
      report: reportItem
    };
  }

  async listPlayers(input: Readonly<{
    search?: string | undefined;
    limit?: number | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
    sort?: "quantity" | "activeGameplaySeconds" | "level" | "lastActiveAt" | "displayName" | "gold" | undefined;
    direction?: "asc" | "desc" | undefined;
    activeOnly?: boolean | undefined;
    lastActiveHours?: number | undefined;
    activeGameplayHoursMin?: number | undefined;
    activeGameplayHoursMax?: number | undefined;
    levelMin?: number | undefined;
    levelMax?: number | undefined;
    kingdom?: string | undefined;
    city?: string | undefined;
    accountAgeCohort?: string | undefined;
    window?: EconomyFlowWindow | undefined;
  }> = {}): Promise<Readonly<{ metadata: EconomySnapshotMetadata; players: readonly EconomyPlayerSummary[]; pagination: EconomyPagination }>> {
    const snapshot = await this.readSnapshot(input.window ?? "24h");
    const summaries = playerSummaries(snapshot)
      .filter((player) => playerMatches(player, input, snapshot.snapshotAsOf))
      .sort(playerComparator(input.sort ?? "quantity", input.direction ?? "desc"));
    const pagination = pageDetails(input.page, input.pageSize ?? input.limit, summaries.length);
    return { metadata: snapshot.metadata, players: summaries.slice((pagination.page - 1) * pagination.pageSize, pagination.page * pagination.pageSize), pagination };
  }

  async inspectPlayer(playerId: string, window: EconomyFlowWindow = "24h"): Promise<Readonly<{
    metadata: EconomySnapshotMetadata;
    player: EconomyPlayerSummary | null;
    holdings: readonly EconomyHolding[];
    custody: Readonly<Record<string, readonly EconomyHolding[]>>;
    wallet: Readonly<{ gold: string }> | null;
    future: readonly EconomyHolding[];
    uniqueAssets: readonly EconomyHolding[];
    itemRows: readonly EconomyPlayerItemReport[];
    events: readonly Readonly<{ eventId: string; eventKind: EconomyEventKind; leg: "debit" | "credit"; assetId: string; quantity: string; reason: string; occurredAt: string }>[];
  }>> {
    const snapshot = await this.readSnapshot(window);
    const report = buildEconomyReport(snapshot, window);
    const holdings = snapshot.holdings.filter((holding) => holding.playerId === playerId && holding.supplyScope === "player_controlled_existing_supply");
    const player = playerSummaries(snapshot).find((entry) => entry.playerId === playerId) ?? null;
    if (!player) return { metadata: snapshot.metadata, player: null, holdings: [], custody: {}, wallet: null, future: [], uniqueAssets: [], itemRows: [], events: [] };
    const future = snapshot.holdings.filter((holding) => holding.playerId === playerId && holding.supplyScope === "committed_or_future_supply");
    const uniqueAssets = holdings.filter((holding) => holding.assetKind === "unique");
    const custody = holdings.reduce<Record<string, EconomyHolding[]>>((groups, holding) => {
      (groups[holding.custodyType] ??= []).push(holding);
      return groups;
    }, {});
    return {
      metadata: snapshot.metadata,
      player,
      holdings,
      custody,
      wallet: { gold: player.gold },
      future,
      uniqueAssets,
      itemRows: report.playerItemRows.filter((row) => row.playerId === playerId),
      events: snapshot.analysisEvents.filter((event) => event.playerId === playerId).slice(-100).map((event) => ({
        eventId: event.eventId,
        eventKind: event.eventKind,
        leg: event.leg,
        assetId: event.assetId,
        quantity: event.quantity.toString(),
        reason: event.reason,
        occurredAt: event.occurredAt
      }))
    };
  }

  async cohorts(window: EconomyFlowWindow = "24h"): Promise<Readonly<{ metadata: EconomySnapshotMetadata; cohorts: readonly Readonly<{ cohort: string; sessions: number; connectedSeconds: number; activeSeconds: number; inactiveSeconds: number }>[] }>> {
    const snapshot = await this.readSnapshot(window);
    const groups = new Map<string, { sessions: number; connectedSeconds: number; activeSeconds: number; inactiveSeconds: number }>();
    for (const session of snapshot.sessions) {
      const active = session.lastGameplayAt !== null &&
        Date.parse(session.lastGameplayAt) >= Date.parse(snapshot.snapshotAsOf) - ACTIVE_WINDOW_SECONDS * 1000;
      const cohort = session.state === "connected" ? active ? "active" : "afk" : "closed";
      const current = groups.get(cohort) ?? { sessions: 0, connectedSeconds: 0, activeSeconds: 0, inactiveSeconds: 0 };
      current.sessions += 1;
      current.connectedSeconds += session.connectedSeconds;
      current.activeSeconds += session.activeSeconds;
      current.inactiveSeconds += session.inactiveSeconds;
      groups.set(cohort, current);
    }
    return {
      metadata: snapshot.metadata,
      cohorts: [...groups.entries()].map(([cohort, value]) => ({ cohort, ...value }))
    };
  }

  async flow(window: EconomyFlowWindow = "24h"): Promise<Readonly<{ metadata: EconomySnapshotMetadata; flow: readonly EconomyFlowView[] }>> {
    const snapshot = await this.readSnapshot(window);
    return { metadata: snapshot.metadata, flow: snapshot.flows.map(flowView) };
  }

  async report(window: EconomyFlowWindow = "24h"): Promise<EconomyReport> {
    const snapshot = await this.readSnapshot(window);
    return buildEconomyReport(snapshot, window);
  }

  async captureSnapshot(window: EconomyFlowWindow = "24h"): Promise<EconomySnapshotMetadata> {
    const snapshot = await this.readSnapshot(window);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO economy_snapshot_runs (
           snapshot_id, requested_at, started_at, completed_at, snapshot_as_of,
           isolation_level, status, source_watermarks, reconciliation, stale_sources
         ) VALUES ($1,$2,$2,$3,$4,'REPEATABLE READ','completed',$5::jsonb,$6::jsonb,$7::text[])`,
        [
          snapshot.metadata.snapshotId,
          new Date(),
          new Date(),
          snapshot.metadata.snapshotAsOf,
          JSON.stringify(snapshot.metadata.sourceWatermarks),
          JSON.stringify(snapshot.metadata.reconciliation),
          [...snapshot.metadata.staleness.staleSources]
        ]
      );
      for (const holding of snapshot.holdings) {
        await client.query(
          `INSERT INTO economy_snapshot_holdings (
             snapshot_id, supply_scope, asset_kind, asset_id, item_id, variant,
             unique_asset_instance_id, quantity, custody_type, custody_id,
             player_id, organization_type, organization_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            snapshot.metadata.snapshotId,
            holding.supplyScope,
            holding.assetKind,
            holding.assetId,
            holding.itemId,
            holding.variant,
            holding.uniqueAssetInstanceId,
            holding.quantity.toString(),
            holding.custodyType,
            holding.custodyId,
            holding.playerId,
            holding.organizationType,
            holding.organizationId
          ]
        );
      }
      await client.query("COMMIT");
      return snapshot.metadata;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async exportWorkbook(window: EconomyFlowWindow = "24h"): Promise<Buffer> {
    const snapshot = await this.readSnapshot(window);
    const report = buildEconomyReport(snapshot, window);
    const overview = this.buildOverviewFromSnapshot(snapshot, window);
    const players = playerSummaries(snapshot);
    const playerById = new Map(players.map((player) => [player.playerId, player]));
    const dynamicItems = report.items.map((item) => item.assetId);
    const itemById = new Map(report.items.map((item) => [item.assetId, item]));
    const reportMetadataRows = [
      ["window_start", report.metadata.windowStart],
      ["window_end", report.metadata.windowEnd],
      ["snapshot_start", report.metadata.snapshotStart],
      ["snapshot_end", report.metadata.snapshotEnd],
      ["duration_seconds", report.metadata.durationSeconds],
      ["generation", report.metadata.generation],
      ["release_sha", report.metadata.releaseSha],
      ["runtime_label", report.metadata.runtimeLabel],
      ["coverage_status", report.metadata.coverageStatus],
      ["reconciliation_status", report.metadata.reconciliationStatus],
      ["active_player_count", report.metadata.activePlayerCount],
      ["total_active_gameplay_seconds", report.metadata.totalActiveGameplaySeconds]
    ] satisfies readonly (readonly XlsxCell[])[];
    const itemStatisticsHeaders = [
      "asset_id", "item_name", "category", "variant", "asset_kind", "starting_existing_supply", "ending_existing_supply", "existing_supply_change", "existing_supply_change_percent",
      "player_controlled_ending_supply", "organization_supply", "world_available_supply", "committed_future_supply", "holder_count", "active_holder_count", "active_player_count", "holding_rate_active", "zero_holder_rate_active",
      "active_player_mean", "active_player_median", "holder_mean", "holder_median", "p25", "p50", "p75", "p90", "p95", "p99", "maximum", "top1_share", "top3_share", "top5_share", "top10_percent_share", "hhi", "normalized_hhi", "gini",
      "external_inflow", "transform_inflow", "transform_outflow", "final_sink", "admin_positive", "admin_negative", "transfer_inflow", "transfer_outflow", "gross_inflow", "gross_outflow", "net_change", "acquisition_event_count", "outflow_event_count", "unique_acquiring_players", "unique_spending_players", "acquisition_participation_rate", "spending_participation_rate", "mean_acquired_active", "median_acquired_active", "mean_acquired_acquiring", "median_acquired_acquiring", "p90_acquired_acquiring", "maximum_acquired_by_player", "mean_net_change_active", "median_net_change_active", "externally_acquired_per_active_hour", "gross_acquired_per_active_hour", "acquisition_events_per_100_active_hours", "average_time_between_acquisition_events_seconds", "attempts_supported", "attempts", "successful_attempts", "observed_attempt_rate", "label_summary"
    ];
    const itemStatisticsRows = report.items.map((item) => [
      item.assetId, item.itemName, item.category, item.variant, item.assetKind, item.startingExistingSupply, item.endingExistingSupply, item.existingSupplyChange, item.existingSupplyChangePercent,
      item.playerControlledEndingSupply, item.organizationSupply, item.worldAvailableSupply, item.committedFutureSupply, item.holderCount, item.activeHolderCount, item.activePlayerCount, item.holdingRateAmongActivePlayers, item.zeroHolderRateAmongActivePlayers,
      item.activePlayerMean, item.activePlayerMedian, item.holderMean, item.holderMedian, item.p25, item.p50, item.p75, item.p90, item.p95, item.p99, item.maximum, item.top1Share, item.top3Share, item.top5Share, item.top10PercentShare, item.hhi, item.normalizedHhi, item.gini,
      item.externalInflow, item.transformInflow, item.transformOutflow, item.finalSink, item.adminPositive, item.adminNegative, item.transferInflow, item.transferOutflow, item.grossInflow, item.grossOutflow, item.netChange, item.acquisitionEventCount, item.outflowEventCount, item.uniqueAcquiringPlayers, item.uniqueSpendingPlayers, item.acquisitionParticipationRate, item.spendingParticipationRate, item.meanAcquiredPerActivePlayer, item.medianAcquiredPerActivePlayer, item.meanAcquiredPerAcquiringPlayer, item.medianAcquiredPerAcquiringPlayer, item.p90AcquiredPerAcquiringPlayer, item.maximumAcquiredByPlayer, item.meanNetChangePerActivePlayer, item.medianNetChangePerActivePlayer, item.externallyAcquiredPerActiveHour, item.grossAcquiredPerActiveHour, item.acquisitionEventsPer100ActiveHours, item.averageTimeBetweenAcquisitionEventsSeconds, item.attemptMetrics.supported, item.attemptMetrics.attempts, item.attemptMetrics.successfulAttempts, item.attemptMetrics.observedRate, item.labels.map((label) => `${label.label}${label.gated ? " (gated)" : ""}: ${label.reasons.join("; ")}`).join(" | ")
    ]);
    const playerHeaders = ["player_id", "display_name", "account_id", "last_active_at", "connected_seconds", "active_gameplay_seconds", "level", "kingdom", "city", "gold", "fungible_item_count", "total_fungible_quantity", "unique_equipment_count", "backpack_count", "distinct_resource_count", "account_age_days"];
    const playerRows = players.map((player) => [player.playerId, player.displayName, player.accountId, player.lastActiveAt, player.connectedSeconds, player.activeGameplaySeconds, player.level, player.kingdom, player.city, player.gold, player.fungibleItemCount, player.quantity, player.uniqueAssetCount, player.backpackCount, player.distinctResourceCount, player.accountAgeDays]);
    const holdingsWideHeaders = ["player_id", "display_name", "level", "kingdom", "active_gameplay_seconds", "gold", ...dynamicItems];
    const holdingsWideRows = players.map((player) => {
      const rowMap = new Map(report.playerItemRows.filter((row) => row.playerId === player.playerId).map((row) => [row.itemId, row.endingQuantity]));
      return [player.playerId, player.displayName, player.level, player.kingdom, player.activeGameplaySeconds, player.gold, ...dynamicItems.map((itemId) => rowMap.get(itemId) ?? "0")];
    });
    const holdingsLongHeaders = ["player_id", "display_name", "item_id", "item_name", "variant", "quantity", "custody_bucket", "asset_kind", "scope"];
    const holdingsLongRows = snapshot.holdings.filter((holding) => holding.playerId && holding.supplyScope === "player_controlled_existing_supply").map((holding) => [holding.playerId, playerById.get(holding.playerId!)?.displayName ?? holding.playerId, holding.assetId, itemById.get(holding.assetId)?.itemName ?? holding.assetId, holding.variant, holding.quantity.toString(), holding.custodyType, holding.assetKind, holding.supplyScope]);
    const playerFlowHeaders = ["player_id", "display_name", "item_id", "item_name", "variant", "starting_quantity", "ending_quantity", "external_acquired", "transformed_in", "transferred_in", "transferred_out", "transformed_out", "final_sink", "gross_acquired", "gross_outflow", "net_change", "active_gameplay_seconds", "kingdom", "level", "account_age_days", "ending_percentile", "acquisition_percentile", "active_player_percentile", "holder_percentile", "share_player_controlled", "active_player_mean", "active_player_median", "holder_mean", "holder_median", "custody_breakdown"];
    const playerFlowRows = report.playerItemRows.map((row) => [row.playerId, row.displayName, row.itemId, row.itemName, row.variant, row.startingQuantity, row.endingQuantity, row.externalAcquired, row.transformedIn, row.transferredIn, row.transferredOut, row.transformedOut, row.finalSink, row.grossAcquired, row.grossOutflow, row.netChange, row.activeGameplaySeconds, row.kingdom, row.level, row.accountAgeDays, row.endingPercentile, row.acquisitionPercentile, row.activePlayerPercentile, row.holderPercentile, row.shareOfPlayerControlledSupply, row.activePlayerMean, row.activePlayerMedian, row.holderMean, row.holderMedian, JSON.stringify(row.custodyBreakdown)]);
    const holderHeaders = ["asset_id", "item_name", "player_id", "display_name", "current_quantity", "starting_24h_quantity", "ending_24h_quantity", "gross_acquired", "gross_outflow", "net_change", "share_player_controlled", "percentile", "active_gameplay_seconds", "quantity_per_active_gameplay_hour", "last_active_at", "level", "kingdom", "custody_breakdown"];
    const holderRows = report.items.flatMap((item) => report.playerItemRows.filter((row) => row.itemId === item.assetId && BigInt(row.endingQuantity) > 0n).map((row) => {
      const holder = itemHolderFromPlayerItem(row, snapshot, "player_controlled_existing_supply");
      const playerSupply = BigInt(item.playerControlledEndingSupply);
      return [item.assetId, item.itemName, holder.playerId, holder.displayName, holder.currentQuantity, holder.startingQuantity, holder.endingQuantity, holder.grossAcquired, holder.grossOutflow, holder.netChange, playerSupply > 0n ? Number(holder.currentQuantity) / Number(playerSupply) : null, holder.percentile, holder.activeGameplaySeconds, holder.quantityPerActiveGameplayHour, holder.lastActiveAt, holder.level, holder.kingdom, JSON.stringify(holder.custodyBreakdown)];
    }));
    const uniqueHeaders = ["asset_id", "item_id", "variant", "unique_asset_instance_id", "quantity", "custody_type", "custody_id", "player_id", "organization_type", "organization_id", "scope"];
    const uniqueRows = snapshot.holdings.filter((holding) => holding.assetKind === "unique").map((holding) => [holding.assetId, holding.itemId, holding.variant, holding.uniqueAssetInstanceId, holding.quantity.toString(), holding.custodyType, holding.custodyId, holding.playerId, holding.organizationType, holding.organizationId, holding.supplyScope]);
    const organizationHeaders = ["asset_id", "item_id", "variant", "quantity", "custody_type", "custody_id", "organization_type", "organization_id", "scope"];
    const organizationRows = snapshot.holdings.filter((holding) => holding.organizationType || holding.supplyScope === "organization_existing_supply").map((holding) => [holding.assetId, holding.itemId, holding.variant, holding.quantity.toString(), holding.custodyType, holding.custodyId, holding.organizationType, holding.organizationId, holding.supplyScope]);
    const acquisitionHeaders = ["asset_id", "item_name", "external_inflow", "externally_acquired_per_active_hour", "gross_acquired_per_active_hour", "unique_acquiring_players", "acquisition_participation_rate", "median_acquired_active_including_zeros", "median_acquired_acquiring", "average_time_between_acquisition_events_seconds", "acquisition_events_per_100_active_hours", "attempts_supported", "attempts", "successful_attempts", "observed_attempt_rate", "denominator_note"];
    const acquisitionRows = report.items.map((item) => [item.assetId, item.itemName, item.externalInflow, item.externallyAcquiredPerActiveHour, item.grossAcquiredPerActiveHour, item.uniqueAcquiringPlayers, item.acquisitionParticipationRate, item.medianAcquiredPerActivePlayer, item.medianAcquiredPerAcquiringPlayer, item.averageTimeBetweenAcquisitionEventsSeconds, item.acquisitionEventsPer100ActiveHours, item.attemptMetrics.supported, item.attemptMetrics.attempts, item.attemptMetrics.successfulAttempts, item.attemptMetrics.observedRate, item.attemptMetrics.note]);
    const sourceSinkHeaders = ["asset_id", "item_name", "external_inflow", "transform_inflow", "transform_outflow", "final_sink", "admin_positive", "admin_negative", "transfer_inflow", "transfer_outflow", "gross_inflow", "gross_outflow", "net_change", "acquisition_event_count", "outflow_event_count"];
    const sourceSinkRows = report.items.map((item) => [item.assetId, item.itemName, item.externalInflow, item.transformInflow, item.transformOutflow, item.finalSink, item.adminPositive, item.adminNegative, item.transferInflow, item.transferOutflow, item.grossInflow, item.grossOutflow, item.netChange, item.acquisitionEventCount, item.outflowEventCount]);
    const concentrationHeaders = ["asset_id", "item_name", "holder_count", "active_holder_count", "top1_share", "top3_share", "top5_share", "top10_percent_share", "hhi", "normalized_hhi", "gini", "labels"];
    const concentrationRows = report.items.map((item) => [item.assetId, item.itemName, item.holderCount, item.activeHolderCount, item.top1Share, item.top3Share, item.top5Share, item.top10PercentShare, item.hhi, item.normalizedHhi, item.gini, item.labels.map((label) => `${label.label}: ${label.reasons.join("; ")}`).join(" | ")]);
    const sheets: XlsxSheet[] = [
      {
        name: "README",
        rows: [
          ["Ash Atlas Economy Observatory 24h report"],
          ...reportMetadataRows,
          [],
          ["definition", "value"],
          ["active gameplay", "A persisted non-PING gameplay activity signal; connection presence and keepalive traffic are not active gameplay."],
          ["external inflow", "SOURCE credits from authoritative economy events."],
          ["transformation inflow/outflow", "TRANSFORM credits/debits; transforms are included in gross flow but are not external creation."],
          ["current versus future", "Existing/world/player/organization scopes are current custody; committed_future_supply is separate and excluded from existing supply."],
          ["transfers", "TRANSFER debit and credit legs are shown for player behavior and must net to zero globally."],
          ["active-player metrics", "Include zero holders/acquirers in the active-player denominator; holder metrics include positive current holders only."],
          ["null values", "Null means unavailable or unsupported; zero means observed zero."],
          ["labels", "Evidence labels expose raw reasons and are gated by coverage, activity, sample, staleness, and reconciliation."],
          ["attempt denominators", "Harvest session attempts are reported where available. Other source denominators remain unsupported rather than fabricated."],
          ["coverage limitations", report.dataQuality.filter((row) => row.status !== "ok").map((row) => `${row.key}: ${row.detail}`).join(" | ") || "none"]
        ]
      },
      {
        name: "24h Summary",
        rows: [...reportMetadataRows, [], ["metric", "value"], ["item_count", report.items.length], ["player_item_rows", report.playerItemRows.length], ["source_breakdown_rows", report.sourceBreakdown.length], ["cohort_rows", report.cohorts.length]]
      },
      {
        name: "Overview",
        rows: [["snapshot_as_of", snapshot.metadata.snapshotAsOf], ["isolation", snapshot.metadata.isolationLevel], ["historical_baseline", snapshot.metadata.historicalBaselineAvailable], ["reconciliation", snapshot.metadata.reconciliation.status], ["stale_sources", snapshot.metadata.staleness.staleSources.join(", ")], [], ["scope", "fungible_units", "unique_assets", "holders", "hhi", "normalized_hhi", "health"], ...overview.scopes.map((scope) => [scope.scope, scope.fungibleUnits, scope.uniqueAssetCount, scope.holderCount, scope.distribution.hhi, scope.distribution.normalizedHhi, scope.health])]
      },
      {
        name: "Item Statistics",
        rows: [itemStatisticsHeaders, ...itemStatisticsRows.slice(0, MAX_EXPORT_ROWS)]
      },
      {
        name: "Acquisition Difficulty",
        rows: [acquisitionHeaders, ...acquisitionRows.slice(0, MAX_EXPORT_ROWS)]
      },
      {
        name: "Source Sink Flow",
        rows: [sourceSinkHeaders, ...sourceSinkRows.slice(0, MAX_EXPORT_ROWS)]
      },
      {
        name: "Source Breakdown",
        rows: [["asset_id", "variant", "direction", "source", "quantity", "percentage", "event_count"], ...report.sourceBreakdown.slice(0, MAX_EXPORT_ROWS).map((row) => [row.assetId, row.variant, row.direction, row.source, row.quantity, row.percentage, row.eventCount])]
      },
      {
        name: "Players",
        rows: [playerHeaders, ...playerRows.slice(0, MAX_EXPORT_ROWS)]
      },
      {
        name: "Player Holdings Wide",
        rows: [holdingsWideHeaders, ...holdingsWideRows.slice(0, MAX_EXPORT_ROWS)]
      },
      {
        name: "Player Holdings Long",
        rows: [holdingsLongHeaders, ...holdingsLongRows.slice(0, MAX_EXPORT_ROWS)]
      },
      {
        name: "Player 24h Flow",
        rows: [playerFlowHeaders, ...playerFlowRows.slice(0, MAX_EXPORT_ROWS)]
      },
      {
        name: "Item Holders",
        rows: [holderHeaders, ...holderRows.slice(0, MAX_EXPORT_ROWS)]
      },
      {
        name: "Unique Assets",
        rows: [uniqueHeaders, ...uniqueRows.slice(0, MAX_EXPORT_ROWS)]
      },
      {
        name: "Organization Holdings",
        rows: [organizationHeaders, ...organizationRows.slice(0, MAX_EXPORT_ROWS)]
      },
      {
        name: "Cohort Statistics",
        rows: [["dimension", "cohort", "asset_id", "active_players", "holders", "ending_quantity", "gross_acquired", "gross_outflow", "median_quantity", "holding_rate"], ...report.cohorts.slice(0, MAX_EXPORT_ROWS).map((row) => [row.dimension, row.cohort, row.assetId, row.activePlayers, row.holders, row.endingQuantity, row.grossAcquired, row.grossOutflow, row.medianQuantity, row.holdingRate])]
      },
      {
        name: "Concentration",
        rows: [concentrationHeaders, ...concentrationRows.slice(0, MAX_EXPORT_ROWS)]
      },
      {
        name: "Coverage",
        rows: [
          ["domain", "status", "reliable_from", "last_observed", "notes"],
          ...snapshot.coverage.map((coverage) => [coverage.domain, coverage.status, coverage.reliableFrom, coverage.lastObservedAt, coverage.notes])
        ]
      },
      {
        name: "Data Quality",
        rows: [["key", "status", "detail"], ...report.dataQuality.map((row) => [row.key, row.status, row.detail])]
      }
    ];
    return createXlsxWorkbook(sheets);
  }

  private buildOverviewFromSnapshot(
    snapshot: SnapshotRead,
    window: EconomyFlowWindow
  ): EconomyOverview {
    const completeCoverage = snapshot.coverage.filter((row) => row.status === "complete").length;
    const confidence = snapshot.coverage.length === 0 ? 0 : completeCoverage / snapshot.coverage.length;
    const sessions = summarizeSessions(snapshot.sessions, snapshot.snapshotAsOf);
    const eventCount = snapshot.flows.reduce((sum, row) => sum + row.classifiedEventCount, 0);
    return {
      metadata: snapshot.metadata,
      scopes: ECONOMY_OBSERVATORY_SCOPES.map((scope) => summarizeScope(
        scope,
        snapshot.holdings.filter((holding) => holding.supplyScope === scope),
        snapshot.metadata,
        confidence,
        eventCount,
        sessions.activePlayers,
        snapshot.metadata.historicalBaselineAvailable,
        WINDOW_DURATIONS_MS[window]
      )),
      flow: snapshot.flows.map(flowView),
      coverage: snapshot.coverage,
      sessions
    };
  }

  private async readSnapshot(window: EconomyFlowWindow): Promise<SnapshotRead> {
    await this.sessionWrite;
    const client = await this.pool.connect();
    const snapshotId = randomUUID();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const asOfResult = await client.query<{ snapshot_as_of: Date | string; isolation_level: string }>(
        "SELECT clock_timestamp() AS snapshot_as_of, current_setting('transaction_isolation') AS isolation_level"
      );
      const snapshotAsOf = asIso(asOfResult.rows[0]?.snapshot_as_of ?? new Date());
      const watermarks = await client.query<WatermarkRow>(
        `SELECT
           (SELECT max(id)::text FROM inventory_events WHERE created_at <= $1::timestamptz) AS inventory_watermark,
           (SELECT max(event_id)::text FROM wallet_events WHERE created_at <= $1::timestamptz) AS wallet_watermark,
           (SELECT max(occurred_at) FROM economy_events WHERE occurred_at <= $1::timestamptz) AS economy_latest_at,
           (SELECT max(created_at) FROM inventory_events WHERE created_at <= $1::timestamptz) AS inventory_latest_at,
           (SELECT max(created_at) FROM wallet_events WHERE created_at <= $1::timestamptz) AS wallet_latest_at,
           (SELECT EXISTS (SELECT 1 FROM economy_snapshot_runs WHERE status = 'completed')) AS historical_baseline_available,
           (SELECT max(snapshot_as_of)
            FROM economy_snapshot_runs
            WHERE status = 'completed' AND snapshot_as_of <= $2::timestamptz) AS snapshot_start`,
        [snapshotAsOf, new Date(Date.parse(snapshotAsOf) - WINDOW_DURATIONS_MS[window])]
      );
      const holdingResult = await client.query<HoldingRow>(
        `SELECT supply_scope, existing_supply, asset_kind, asset_id, item_id, variant,
                unique_asset_instance_id, quantity::text, custody_type, custody_id,
                player_id, organization_type, organization_id
         FROM economy_current_holdings
         ORDER BY supply_scope, asset_id, variant, custody_id
         LIMIT $1`,
        [MAX_HOLDING_ROWS]
      );
      const flowResult = await client.query<FlowRow>(
        `SELECT asset_id, variant, event_kind, leg,
                sum(quantity)::text AS quantity, count(*)::text AS event_count
         FROM economy_events
         WHERE occurred_at >= $1::timestamptz AND occurred_at <= $2::timestamptz
         GROUP BY asset_id, variant, event_kind, leg
         ORDER BY asset_id, variant, event_kind, leg`,
        [new Date(Date.parse(snapshotAsOf) - WINDOW_DURATIONS_MS[window]), snapshotAsOf]
      );
      const analysisEventResult = await client.query<EconomyAnalysisEventRow>(
        `SELECT event_id::text, event_kind, leg, asset_kind, asset_id, item_id,
                variant, unique_asset_instance_id::text, quantity::text,
                custody_type, custody_id, player_id, organization_type,
                organization_id, source_system, reason, occurred_at
         FROM economy_events
         WHERE occurred_at >= $1::timestamptz AND occurred_at <= $2::timestamptz
         ORDER BY occurred_at, event_id
         LIMIT $3`,
        [new Date(Date.parse(snapshotAsOf) - WINDOW_DURATIONS_MS[window]), snapshotAsOf, MAX_ANALYSIS_EVENT_ROWS + 1]
      );
      const catalogResult = await client.query<CatalogItemRow>(
        `SELECT item_id, display_name, category, stackable
         FROM item_definitions ORDER BY item_id`
      );
      const playerResult = await client.query<PlayerAnalysisRow>(
        `SELECT player.id AS player_id,
                player.username AS display_name,
                player.account_id::text AS account_id,
                COALESCE(account.created_at, player.created_at) AS account_created_at,
                player.last_seen_at,
                progression.level,
                kingdom_membership.kingdom_id::text AS kingdom_id,
                kingdom.display_name AS kingdom_name,
                city_membership.city_id::text AS city_id,
                city.name AS city_name,
                COALESCE(wallet.gold_balance, 0)::text AS gold,
                COALESCE(session.connected_seconds, 0)::text AS connected_seconds,
                COALESCE(session.active_seconds, 0)::text AS active_seconds,
                session.last_active_at
         FROM players player
         LEFT JOIN accounts account ON account.id = player.account_id
         LEFT JOIN player_progression_profiles progression ON progression.player_id = player.id
         LEFT JOIN player_wallets wallet ON wallet.player_id = player.id
         LEFT JOIN LATERAL (
           SELECT membership.kingdom_id
           FROM kingdom_memberships membership
           WHERE membership.player_id = player.id AND membership.status = 'active'
           ORDER BY membership.joined_at DESC LIMIT 1
         ) kingdom_membership ON true
         LEFT JOIN kingdoms kingdom ON kingdom.id = kingdom_membership.kingdom_id
         LEFT JOIN LATERAL (
           SELECT membership.city_id
           FROM city_memberships membership
           WHERE membership.player_id = player.id AND membership.left_at IS NULL
           ORDER BY membership.joined_at DESC LIMIT 1
         ) city_membership ON true
         LEFT JOIN cities city ON city.id = city_membership.city_id
         LEFT JOIN LATERAL (
           SELECT
             sum(GREATEST(0, EXTRACT(EPOCH FROM (
               LEAST(COALESCE(session.disconnected_at, $1::timestamptz), $1::timestamptz)
               - GREATEST(session.connected_at, $2::timestamptz)
             )))::bigint) AS connected_seconds,
             sum(LEAST(session.active_seconds,
               GREATEST(0, EXTRACT(EPOCH FROM (
                 LEAST(COALESCE(session.disconnected_at, $1::timestamptz), $1::timestamptz)
                 - GREATEST(session.connected_at, $2::timestamptz)
               )))::bigint)) AS active_seconds,
             max(session.last_gameplay_at) AS last_active_at
           FROM economy_sessions session
           WHERE session.player_id = player.id
             AND session.connected_at <= $1::timestamptz
             AND COALESCE(session.disconnected_at, $1::timestamptz) >= $2::timestamptz
         ) session ON true
         ORDER BY player.id`,
        [snapshotAsOf, new Date(Date.parse(snapshotAsOf) - WINDOW_DURATIONS_MS[window])]
      );
      const attemptResult = await client.query<AttemptRow>(
        `SELECT resource_type AS item_id,
                count(*)::text AS attempts,
                count(*) FILTER (WHERE status = 'completed')::text AS successful_attempts
         FROM harvest_sessions
         WHERE started_at >= $1::timestamptz AND started_at <= $2::timestamptz
         GROUP BY resource_type`,
        [new Date(Date.parse(snapshotAsOf) - WINDOW_DURATIONS_MS[window]), snapshotAsOf]
      );
      const coverageResult = await client.query<CoverageRow>(
        `SELECT domain_key, status, reliable_from, last_observed_at, notes
         FROM economy_instrumentation_coverage ORDER BY domain_key`
      );
      const latestCoverageResult = await client.query<LatestCoverageRow>(
        `SELECT coverage_domain, max(occurred_at) AS latest_at
         FROM economy_events
         WHERE occurred_at <= $1::timestamptz
         GROUP BY coverage_domain`,
        [snapshotAsOf]
      );
      const sessionResult = await client.query<SessionRow>(
        `SELECT session_id::text, player_id, state, connected_at, last_seen_at,
                last_gameplay_at, disconnected_at, connected_seconds::text,
                active_seconds::text, inactive_seconds::text
         FROM economy_sessions
         ORDER BY connected_at DESC
         LIMIT $1`,
        [MAX_SESSION_ROWS]
      );
      const reconciliationResult = await client.query<ReconciliationRow>(
        `WITH group_totals AS (
           SELECT transfer_group_id, asset_kind, asset_id, variant, unique_asset_instance_id,
                  count(*) FILTER (WHERE leg='debit') AS debits,
                  count(*) FILTER (WHERE leg='credit') AS credits,
                  sum(CASE WHEN leg='credit' THEN quantity ELSE -quantity END) AS net
           FROM economy_events
           WHERE transfer_group_id IS NOT NULL
           GROUP BY transfer_group_id, asset_kind, asset_id, variant, unique_asset_instance_id
         )
         SELECT
           count(*) FILTER (WHERE debits=0 OR credits=0 OR net<>0)::text AS imbalanced_groups,
           count(DISTINCT transfer_group_id)::text AS transfer_groups
         FROM group_totals`
      );
      await client.query("COMMIT");
      const watermark = watermarks.rows[0];
      const reconciliation = reconciliationResult.rows[0] ?? { imbalanced_groups: "0", transfer_groups: "0" };
      const requestedWindowStart = Date.parse(snapshotAsOf) - WINDOW_DURATIONS_MS[window];
      const coverage = coverageResult.rows.map((row) => {
        const view = coverageView(row);
        if (view.status !== "complete" || Date.parse(view.reliableFrom) <= requestedWindowStart) return view;
        return {
          ...view,
          status: "partial" as const,
          notes: `${view.notes} Requested window begins before reliable instrumentation.`
        };
      });
      const latestByDomain = new Map(latestCoverageResult.rows.map((row) => [row.coverage_domain, row.latest_at]));
      const staleSources = coverage
        .filter((row) => {
          const latest = latestByDomain.get(row.domain);
          return latest !== null && latest !== undefined && Date.parse(snapshotAsOf) - Date.parse(asIso(latest)) > 15 * 60 * 1000;
        })
        .map((row) => row.domain);
      const maxAgeSeconds = Math.max(0, ...[...latestByDomain.values()]
        .filter((value): value is Date | string => value !== null)
        .map((value) => Math.floor((Date.parse(snapshotAsOf) - Date.parse(asIso(value))) / 1000)));
      const metadata: EconomySnapshotMetadata = {
          snapshotId,
          snapshotAsOf,
          isolationLevel: "REPEATABLE READ",
          historicalBaselineAvailable: watermark?.historical_baseline_available === true,
        sourceWatermarks: {
          inventory: watermark?.inventory_watermark ?? null,
          wallet: watermark?.wallet_watermark ?? null,
          economyLatestAt: watermark?.economy_latest_at ? asIso(watermark.economy_latest_at) : null,
          inventoryLatestAt: watermark?.inventory_latest_at ? asIso(watermark.inventory_latest_at) : null,
          walletLatestAt: watermark?.wallet_latest_at ? asIso(watermark.wallet_latest_at) : null
        },
        reconciliation: {
          status: Number(reconciliation.imbalanced_groups) === 0 ? "ok" : "failed",
          transferGroups: Number(reconciliation.transfer_groups),
          imbalancedGroups: Number(reconciliation.imbalanced_groups)
        },
        staleness: {
          isStale: staleSources.length > 0,
          staleSources,
          maxAgeSeconds
        }
      };
      return {
        snapshotId,
        snapshotAsOf,
        snapshotStart: watermark?.snapshot_start ? asIso(watermark.snapshot_start) : null,
        holdings: holdingResult.rows.map(holdingView),
        flows: aggregateFlowRows(flowResult.rows),
        analysisEvents: analysisEventResult.rows.slice(0, MAX_ANALYSIS_EVENT_ROWS).map(analysisEventView),
        catalog: catalogWithCurrencies(catalogResult.rows),
        players: playerResult.rows.map(analysisPlayerView),
        attempts: new Map(attemptResult.rows.map((row) => [row.item_id, {
          attempts: Number(row.attempts),
          successfulAttempts: Number(row.successful_attempts),
          supported: true,
          note: "Harvest session starts are the authoritative attempt denominator for this item."
        } satisfies AttemptEvidence])),
        analysisEventsTruncated: analysisEventResult.rows.length > MAX_ANALYSIS_EVENT_ROWS,
        coverage,
        sessions: sessionResult.rows.map((row) => sessionView(row, snapshotAsOf)),
        metadata
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function analysisEventView(row: EconomyAnalysisEventRow): EconomyAnalysisEvent {
  return {
    eventId: row.event_id,
    eventKind: row.event_kind,
    leg: row.leg,
    assetKind: row.asset_kind,
    assetId: row.asset_id,
    itemId: row.item_id,
    variant: row.variant,
    uniqueAssetInstanceId: row.unique_asset_instance_id,
    quantity: BigInt(row.quantity),
    custodyType: row.custody_type,
    custodyId: row.custody_id,
    playerId: row.player_id,
    organizationType: row.organization_type,
    organizationId: row.organization_id,
    sourceSystem: row.source_system,
    reason: row.reason,
    occurredAt: asIso(row.occurred_at)
  };
}

function analysisPlayerView(row: PlayerAnalysisRow): AnalysisPlayer {
  return {
    playerId: row.player_id,
    displayName: row.display_name ?? row.player_id,
    accountId: row.account_id,
    accountCreatedAt: row.account_created_at ? asIso(row.account_created_at) : null,
    lastSeenAt: row.last_seen_at ? asIso(row.last_seen_at) : null,
    level: row.level,
    kingdomId: row.kingdom_id,
    kingdomName: row.kingdom_name,
    cityId: row.city_id,
    cityName: row.city_name,
    gold: BigInt(row.gold || "0"),
    connectedSeconds: Number(row.connected_seconds || "0"),
    activeSeconds: Number(row.active_seconds || "0"),
    lastActiveAt: row.last_active_at ? asIso(row.last_active_at) : null
  };
}

function catalogWithCurrencies(rows: readonly CatalogItemRow[]): readonly CatalogItem[] {
  const catalog = new Map<string, CatalogItem>(rows.map((row) => [row.item_id, {
    itemId: row.item_id,
    displayName: row.display_name,
    category: row.category,
    assetKind: row.stackable ? "fungible" : "unique"
  }]));
  for (const currency of [
    ["gold", "Gold", "currency"],
    ["city_coin", "City Coin", "currency"]
  ] as const) {
    if (!catalog.has(currency[0])) {
      catalog.set(currency[0], { itemId: currency[0], displayName: currency[1], category: currency[2], assetKind: "fungible" });
    }
  }
  return [...catalog.values()].sort((left, right) => left.itemId.localeCompare(right.itemId));
}

function reportCatalog(snapshot: SnapshotRead): readonly CatalogItem[] {
  const catalog = new Map(snapshot.catalog.map((item) => [item.itemId, item]));
  for (const holding of snapshot.holdings) {
    if (!catalog.has(holding.assetId)) {
      catalog.set(holding.assetId, {
        itemId: holding.assetId,
        displayName: holding.assetId,
        category: "observed",
        assetKind: holding.assetKind
      });
    }
  }
  for (const event of snapshot.analysisEvents) {
    if (!catalog.has(event.assetId)) {
      catalog.set(event.assetId, {
        itemId: event.assetId,
        displayName: event.assetId,
        category: "observed",
        assetKind: event.assetKind
      });
    }
  }
  return [...catalog.values()].sort((left, right) => left.itemId.localeCompare(right.itemId));
}

type PlayerMovement = {
  externalAcquired: bigint;
  transformedIn: bigint;
  transferredIn: bigint;
  transferredOut: bigint;
  transformedOut: bigint;
  finalSink: bigint;
  adminPositive: bigint;
  adminNegative: bigint;
  unknownIn: bigint;
  unknownOut: bigint;
  signedDelta: bigint;
  acquisitionEventCount: number;
  outflowEventCount: number;
  acquisitionTimes: string[];
};

function emptyPlayerMovement(): PlayerMovement {
  return {
    externalAcquired: 0n,
    transformedIn: 0n,
    transferredIn: 0n,
    transferredOut: 0n,
    transformedOut: 0n,
    finalSink: 0n,
    adminPositive: 0n,
    adminNegative: 0n,
    unknownIn: 0n,
    unknownOut: 0n,
    signedDelta: 0n,
    acquisitionEventCount: 0,
    outflowEventCount: 0,
    acquisitionTimes: []
  };
}

function applyMovement(movement: PlayerMovement, event: EconomyAnalysisEvent): void {
  const inbound = event.leg === "credit";
  movement.signedDelta += inbound ? event.quantity : -event.quantity;
  if (inbound) {
    if (event.eventKind === "SOURCE") movement.externalAcquired += event.quantity;
    else if (event.eventKind === "TRANSFORM") movement.transformedIn += event.quantity;
    else if (event.eventKind === "TRANSFER") movement.transferredIn += event.quantity;
    else if (event.eventKind === "ADMIN") movement.adminPositive += event.quantity;
    else movement.unknownIn += event.quantity;
    if (event.eventKind === "SOURCE" || event.eventKind === "TRANSFORM") {
      movement.acquisitionEventCount += 1;
      movement.acquisitionTimes.push(event.occurredAt);
    }
  } else {
    if (event.eventKind === "SINK") movement.finalSink += event.quantity;
    else if (event.eventKind === "TRANSFORM") movement.transformedOut += event.quantity;
    else if (event.eventKind === "TRANSFER") movement.transferredOut += event.quantity;
    else if (event.eventKind === "ADMIN") movement.adminNegative += event.quantity;
    else movement.unknownOut += event.quantity;
    if (event.eventKind === "SINK" || event.eventKind === "TRANSFORM") movement.outflowEventCount += 1;
  }
}

function movementGrossIn(movement: PlayerMovement): bigint {
  // Gross economy flow describes creation and transformation only. Transfer
  // legs are exposed separately for player behavior and must not inflate
  // acquisition totals; administrative adjustments remain separate too.
  return movement.externalAcquired + movement.transformedIn;
}

function movementGrossOut(movement: PlayerMovement): bigint {
  return movement.finalSink + movement.transformedOut;
}

function itemSourceLabel(event: EconomyAnalysisEvent, direction: "inflow" | "outflow"): string {
  const key = `${event.sourceSystem ?? ""} ${event.reason}`.toLowerCase();
  if (key.includes("harvest")) return key.includes("mine") || key.includes("ore") ? "mining" : "harvesting";
  if (key.includes("combat") || key.includes("mob") || key.includes("loot")) return "combat drops";
  if (key.includes("dungeon")) return "dungeon drops";
  if (key.includes("craft") || key.includes("process") || key.includes("smelt") || key.includes("furnace") || key.includes("loom") || key.includes("tannery")) {
    return direction === "inflow" ? "crafting" : "transformation";
  }
  if (key.includes("production") || key.includes("oil_well")) return "production facilities";
  if (key.includes("reward") || key.includes("grant") || key.includes("starter")) return "rewards";
  if (key.includes("market") || key.includes("trade")) return "market";
  if (event.eventKind === "SINK") return "final sink";
  if (event.eventKind === "ADMIN") return "admin";
  return "other";
}

function activePlayer(player: AnalysisPlayer, windowStart: string): boolean {
  // A non-zero session counter can describe gameplay before this report's
  // window. The last authoritative gameplay timestamp is the safe activity
  // boundary for a windowed active-player denominator.
  return player.lastActiveAt !== null && Date.parse(player.lastActiveAt) >= Date.parse(windowStart);
}

function accountAgeDays(player: AnalysisPlayer, asOf: string): number | null {
  if (!player.accountCreatedAt) return null;
  return Math.max(0, (Date.parse(asOf) - Date.parse(player.accountCreatedAt)) / (24 * 60 * 60 * 1000));
}

function medianNumber(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? null;
}

function percentileNumber(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1));
  return sorted[index] ?? null;
}

function percentileRank(values: readonly number[], value: number): number | null {
  if (values.length === 0) return null;
  return values.filter((candidate) => candidate <= value).length / values.length;
}

function giniFromBigints(values: readonly bigint[]): number | null {
  const positive = values.filter((value) => value > 0n).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (positive.length < 2) return positive.length === 1 ? 0 : null;
  const total = positive.reduce((sum, value) => sum + value, 0n);
  const weighted = positive.reduce((sum, value, index) => sum + BigInt(index + 1) * value, 0n);
  return bigintRatio(2n * weighted, BigInt(positive.length) * total) - (positive.length + 1) / positive.length;
}

function labelGate(snapshot: SnapshotRead, activeCount: number, eventCount: number): { gated: boolean; reason: string } {
  const complete = snapshot.coverage.length > 0 && snapshot.coverage.every((row) => row.status === "complete");
  if (snapshot.metadata.reconciliation.status !== "ok") return { gated: true, reason: "transfer reconciliation failed" };
  if (snapshot.metadata.staleness.isStale) return { gated: true, reason: `observed sources are stale: ${snapshot.metadata.staleness.staleSources.join(", ") || "unknown source"}` };
  if (!complete) return { gated: true, reason: "instrumentation coverage is partial or unavailable" };
  if (!snapshot.metadata.historicalBaselineAvailable) return { gated: true, reason: "historical baseline is unavailable" };
  if (activeCount < 2) return { gated: true, reason: "fewer than two active players" };
  if (eventCount < 5) return { gated: true, reason: "fewer than five classified events in the window" };
  return { gated: false, reason: "coverage, activity, sample, and reconciliation gates passed" };
}

function deriveLabels(input: Readonly<{
  report: Pick<EconomyItemReport, "externalInflow" | "grossInflow" | "grossOutflow" | "netChange" | "zeroHolderRateAmongActivePlayers" | "acquisitionParticipationRate" | "externallyAcquiredPerActiveHour" | "activePlayerMedian" | "normalizedHhi" | "gini" | "holderCount" | "acquisitionEventCount" | "outflowEventCount">;
  activeCount: number;
  eventCount: number;
  snapshot: SnapshotRead;
}>): readonly EconomyItemReport["labels"][number][] {
  const gate = labelGate(input.snapshot, input.activeCount, input.eventCount);
  const labels: EconomyItemReport["labels"][number][] = [];
  const health = economyHealthLabel({
    coverage: input.snapshot.coverage.length === 0 ? 0 : input.snapshot.coverage.filter((row) => row.status === "complete").length / input.snapshot.coverage.length,
    eventCount: input.eventCount,
    holderCount: input.report.holderCount,
    reconciliationOk: input.snapshot.metadata.reconciliation.status === "ok",
    stale: input.snapshot.metadata.staleness.isStale,
    normalizedHhi: input.report.normalizedHhi,
    activePlayerCount: input.activeCount,
    historicalBaselineAvailable: input.snapshot.metadata.historicalBaselineAvailable,
    observationWindowMs: 24 * 60 * 60 * 1000
  });
  const labelsGated = gate.gated || health === "insufficient-data" || health === "stale" || health === "critical";
  labels.push({ label: health, gated: labelsGated, reasons: [gate.reason] });
  const lowAcquisition = (input.report.acquisitionParticipationRate ?? 0) <= 0.2 && (input.report.externallyAcquiredPerActiveHour ?? 0) <= 1;
  const scarce = (input.report.zeroHolderRateAmongActivePlayers ?? 0) >= 0.5 || input.report.holderCount < 2;
  const concentrated = (input.report.normalizedHhi ?? 0) >= 0.8 || (input.report.gini ?? 0) >= 0.8;
  const accumulating = input.report.netChange !== null && BigInt(input.report.netChange) > 0n && BigInt(input.report.grossInflow) > BigInt(input.report.grossOutflow);
  const contracting = input.report.netChange !== null && BigInt(input.report.netChange) < 0n && BigInt(input.report.grossOutflow) > BigInt(input.report.grossInflow);
  const highThroughput = BigInt(input.report.grossInflow) > 0n && BigInt(input.report.grossOutflow) > 0n &&
    ratio(BigInt(input.report.grossInflow), BigInt(input.report.grossOutflow)) >= 0.75 &&
    ratio(BigInt(input.report.grossInflow), BigInt(input.report.grossOutflow)) <= 1.33;
  if (lowAcquisition) labels.push({ label: "hard-to-acquire", gated: labelsGated, reasons: ["low external quantity per active gameplay hour", "low acquisition participation", gate.reason] });
  if (scarce) labels.push({ label: "scarce", gated: labelsGated, reasons: ["high zero-holder rate or low holder count", gate.reason] });
  if (concentrated) labels.push({ label: "concentrated", gated: labelsGated, reasons: ["HHI/Gini concentration evidence is high", gate.reason] });
  if (accumulating) labels.push({ label: "accumulating", gated: labelsGated, reasons: ["gross inflow exceeds gross outflow and ending supply grew", gate.reason] });
  if (contracting) labels.push({ label: "contracting", gated: labelsGated, reasons: ["gross outflow exceeds gross inflow and ending supply fell", gate.reason] });
  if (highThroughput && !accumulating && !contracting) labels.push({ label: "high-throughput-healthy", gated: labelsGated, reasons: ["both inflow and outflow are material and approximately balanced", gate.reason] });
  return labels;
}

export function buildEconomyReport(snapshot: SnapshotRead, window: EconomyFlowWindow): EconomyReport {
  const windowEnd = snapshot.snapshotAsOf;
  const durationSeconds = Math.round(WINDOW_DURATIONS_MS[window] / 1000);
  const windowStart = new Date(Date.parse(windowEnd) - WINDOW_DURATIONS_MS[window]).toISOString();
  const catalog = reportCatalog(snapshot);
  const catalogById = new Map(catalog.map((item) => [item.itemId, item]));
  const players = snapshot.players;
  const playersById = new Map(players.map((player) => [player.playerId, player]));
  const activePlayers = players.filter((player) => activePlayer(player, windowStart));
  const activeIds = new Set(activePlayers.map((player) => player.playerId));
  const eventsByItem = new Map<string, EconomyAnalysisEvent[]>();
  for (const event of snapshot.analysisEvents) {
    const rows = eventsByItem.get(event.assetId) ?? [];
    rows.push(event);
    eventsByItem.set(event.assetId, rows);
  }
  const holdingsByItem = new Map<string, EconomyHolding[]>();
  for (const holding of snapshot.holdings) {
    const rows = holdingsByItem.get(holding.assetId) ?? [];
    rows.push(holding);
    holdingsByItem.set(holding.assetId, rows);
  }

  const playerItemCustody = new Map<string, Map<string, bigint>>();
  for (const holding of snapshot.holdings) {
    if (holding.supplyScope !== "player_controlled_existing_supply" || !holding.playerId) continue;
    const key = `${holding.playerId}\u0000${holding.assetId}`;
    const custody = playerItemCustody.get(key) ?? new Map<string, bigint>();
    custody.set(holding.custodyType, (custody.get(holding.custodyType) ?? 0n) + holding.quantity);
    playerItemCustody.set(key, custody);
  }

  const playerItemStates = new Map<string, { ending: bigint; events: EconomyAnalysisEvent[] }>();
  for (const holding of snapshot.holdings) {
    if (holding.supplyScope !== "player_controlled_existing_supply" || !holding.playerId) continue;
    const key = `${holding.playerId}\u0000${holding.assetId}`;
    const state = playerItemStates.get(key) ?? { ending: 0n, events: [] };
    state.ending += holding.quantity;
    playerItemStates.set(key, state);
  }
  for (const event of snapshot.analysisEvents) {
    if (!event.playerId || !isPlayerRelevantCustody(event.custodyType)) continue;
    const key = `${event.playerId}\u0000${event.assetId}`;
    const state = playerItemStates.get(key) ?? { ending: 0n, events: [] };
    state.events.push(event);
    playerItemStates.set(key, state);
  }

  // Keep the normalized player × item dataset dense for the players and
  // catalog visible in this snapshot. Zero rows are meaningful evidence for
  // active-player denominators and for distinguishing an unpursued item from
  // an item that had no supply.
  for (const player of players) {
    for (const item of catalog) {
      const key = `${player.playerId}\u0000${item.itemId}`;
      if (!playerItemStates.has(key)) playerItemStates.set(key, { ending: 0n, events: [] });
    }
  }

  const playerItemRows: EconomyPlayerItemReport[] = [];
  const playerItemRowIndexes = new Map<string, number>();
  for (const [key, state] of playerItemStates) {
    const [playerId, itemId] = key.split("\u0000");
    if (!playerId || !itemId) continue;
    const player = playersById.get(playerId);
    if (!player) continue;
    const movement = emptyPlayerMovement();
    for (const event of state.events) applyMovement(movement, event);
    const hasBaseline = snapshot.snapshotStart !== null || state.events.length > 0;
    const starting = hasBaseline ? state.ending - movement.signedDelta : null;
    const item = catalogById.get(itemId) ?? { itemId, displayName: itemId, category: "observed", assetKind: "fungible" as const };
    const custody = playerItemCustody.get(key);
    const rowIndex = playerItemRows.length;
    playerItemRows.push({
      playerId,
      displayName: player.displayName,
      itemId,
      itemName: item.displayName,
      variant: "all",
      startingQuantity: starting?.toString() ?? null,
      endingQuantity: state.ending.toString(),
      externalAcquired: movement.externalAcquired.toString(),
      transformedIn: movement.transformedIn.toString(),
      transferredIn: movement.transferredIn.toString(),
      transferredOut: movement.transferredOut.toString(),
      transformedOut: movement.transformedOut.toString(),
      finalSink: movement.finalSink.toString(),
      grossAcquired: movementGrossIn(movement).toString(),
      grossOutflow: movementGrossOut(movement).toString(),
      netChange: starting === null ? null : (state.ending - starting).toString(),
      activeGameplaySeconds: player.activeSeconds,
      custodyBreakdown: Object.fromEntries(custody ? [...custody.entries()].map(([custodyType, quantity]) => [custodyType, quantity.toString()]) : []),
      kingdom: player.kingdomName,
      level: player.level,
      accountAgeDays: accountAgeDays(player, windowEnd),
      endingPercentile: null,
      acquisitionPercentile: null,
      activePlayerPercentile: null,
      holderPercentile: null,
      shareOfPlayerControlledSupply: null,
      activePlayerMean: null,
      activePlayerMedian: null,
      holderMean: null,
      holderMedian: null
    });
    playerItemRowIndexes.set(key, rowIndex);
  }
  const rowsByItem = new Map<string, EconomyPlayerItemReport[]>();
  for (const row of playerItemRows) {
    const rows = rowsByItem.get(row.itemId) ?? [];
    rows.push(row);
    rowsByItem.set(row.itemId, rows);
  }
  const rowsByItemPlayer = new Map<string, EconomyPlayerItemReport>();
  for (const row of playerItemRows) rowsByItemPlayer.set(`${row.itemId}\u0000${row.playerId}`, row);
  for (const [itemId, rows] of rowsByItem) {
    const activeEndings = activePlayers.map((player) => Number(rowsByItemPlayer.get(`${itemId}\u0000${player.playerId}`)?.endingQuantity ?? "0"));
    const activeAcquisitions = activePlayers.map((player) => Number(rowsByItemPlayer.get(`${itemId}\u0000${player.playerId}`)?.grossAcquired ?? "0"));
    const holderEndings = rows.map((row) => Number(row.endingQuantity)).filter((value) => value > 0);
    const playerControlledTotal = rows.reduce((sum, row) => sum + BigInt(row.endingQuantity), 0n);
    const activeMean = activeEndings.length === 0 ? null : activeEndings.reduce((sum, value) => sum + value, 0) / activeEndings.length;
    const activeMedian = medianNumber(activeEndings);
    const holderMean = holderEndings.length === 0 ? null : holderEndings.reduce((sum, value) => sum + value, 0) / holderEndings.length;
    const holderMedian = medianNumber(holderEndings);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]!;
      const ending = Number(row.endingQuantity);
      const acquired = Number(row.grossAcquired);
      const next = {
        ...row,
        endingPercentile: percentileRank(activeEndings, ending),
        acquisitionPercentile: percentileRank(activeAcquisitions, acquired),
        activePlayerPercentile: percentileRank(activeEndings, ending),
        holderPercentile: ending > 0 ? percentileRank(holderEndings, ending) : null,
        shareOfPlayerControlledSupply: playerControlledTotal > 0n ? Number(row.endingQuantity) / Number(playerControlledTotal) : null,
        activePlayerMean: activeMean,
        activePlayerMedian: activeMedian,
        holderMean,
        holderMedian
      };
      rows[rowIndex] = next;
      const globalIndex = playerItemRowIndexes.get(`${itemId}\u0000${row.playerId}`);
      if (globalIndex !== undefined) playerItemRows[globalIndex] = next;
      rowsByItemPlayer.set(`${itemId}\u0000${row.playerId}`, next);
    }
  }

  const sourceBreakdown: EconomySourceBreakdown[] = [];
  const items: EconomyItemReport[] = [];
  for (const item of catalog) {
    const itemEvents = eventsByItem.get(item.itemId) ?? [];
    const itemHoldings = holdingsByItem.get(item.itemId) ?? [];
    const endByScope = new Map<EconomySupplyScope, bigint>(ECONOMY_OBSERVATORY_SCOPES.map((scope) => [scope, 0n]));
    const playerEndById = new Map<string, bigint>();
    for (const holding of itemHoldings) {
      endByScope.set(holding.supplyScope, (endByScope.get(holding.supplyScope) ?? 0n) + holding.quantity);
      if (holding.supplyScope === "player_controlled_existing_supply" && holding.playerId) {
        playerEndById.set(holding.playerId, (playerEndById.get(holding.playerId) ?? 0n) + holding.quantity);
      }
    }
    const globalMovement = emptyPlayerMovement();
    const sourceTotals = new Map<string, { quantity: bigint; events: number }>();
    const outflowTotals = new Map<string, { quantity: bigint; events: number }>();
    for (const event of itemEvents) {
      applyMovement(globalMovement, event);
      const direction: "inflow" | "outflow" | null = event.leg === "credit" && (event.eventKind === "SOURCE" || event.eventKind === "TRANSFORM")
        ? "inflow" : event.leg === "debit" && (event.eventKind === "SINK" || event.eventKind === "TRANSFORM") ? "outflow" : null;
      if (!direction) continue;
      const source = itemSourceLabel(event, direction);
      const totals = (direction === "inflow" ? sourceTotals : outflowTotals).get(source) ?? { quantity: 0n, events: 0 };
      totals.quantity += event.quantity;
      totals.events += 1;
      (direction === "inflow" ? sourceTotals : outflowTotals).set(source, totals);
    }
    const endingExisting = endByScope.get("existing_world_supply") ?? 0n;
    const hasBaseline = snapshot.snapshotStart !== null || itemEvents.length > 0;
    const startingExisting = hasBaseline ? endingExisting - globalMovement.signedDelta : null;
    const playerValues = [...playerEndById.values()].filter((value) => value > 0n);
    const activeValues = activePlayers.map((player) => playerEndById.get(player.playerId) ?? 0n);
    const activeNumeric = activeValues.map((value) => Number(value));
    const holderNumeric = playerValues.map((value) => Number(value));
    const distribution = calculateDistributionFromBigints(playerValues);
    const flowIn = movementGrossIn(globalMovement);
    const flowOut = movementGrossOut(globalMovement);
    const acquisitionValues = activePlayers.map((player) => Number(rowsByItemPlayer.get(`${item.itemId}\u0000${player.playerId}`)?.grossAcquired ?? "0"));
    const acquiringValues = acquisitionValues.filter((value) => value > 0);
    const netValues = activePlayers.map((player) => Number(rowsByItemPlayer.get(`${item.itemId}\u0000${player.playerId}`)?.netChange ?? "0"));
    const startingChange = startingExisting === null ? null : endingExisting - startingExisting;
    const activeHours = activePlayers.reduce((sum, player) => sum + player.activeSeconds, 0) / 3600;
    const itemReportBase: EconomyItemReport = {
      assetId: item.itemId,
      itemName: item.displayName,
      category: item.category,
      variant: "all",
      assetKind: item.assetKind,
      startingExistingSupply: startingExisting?.toString() ?? null,
      endingExistingSupply: endingExisting.toString(),
      existingSupplyChange: startingChange?.toString() ?? null,
      existingSupplyChangePercent: startingExisting !== null && startingExisting !== 0n ? Number(startingChange) / Number(startingExisting) : null,
      playerControlledEndingSupply: (endByScope.get("player_controlled_existing_supply") ?? 0n).toString(),
      organizationSupply: (endByScope.get("organization_existing_supply") ?? 0n).toString(),
      worldAvailableSupply: (endByScope.get("world_available_supply") ?? 0n).toString(),
      committedFutureSupply: (endByScope.get("committed_or_future_supply") ?? 0n).toString(),
      holderCount: playerValues.length,
      activeHolderCount: activePlayers.filter((player) => (playerEndById.get(player.playerId) ?? 0n) > 0n).length,
      activePlayerCount: activePlayers.length,
      holdingRateAmongActivePlayers: activePlayers.length === 0 ? null : activePlayers.filter((player) => (playerEndById.get(player.playerId) ?? 0n) > 0n).length / activePlayers.length,
      zeroHolderRateAmongActivePlayers: activePlayers.length === 0 ? null : activePlayers.filter((player) => (playerEndById.get(player.playerId) ?? 0n) === 0n).length / activePlayers.length,
      activePlayerMean: activeNumeric.length === 0 ? null : activeNumeric.reduce((sum, value) => sum + value, 0) / activeNumeric.length,
      activePlayerMedian: medianNumber(activeNumeric),
      holderMean: holderNumeric.length === 0 ? null : holderNumeric.reduce((sum, value) => sum + value, 0) / holderNumeric.length,
      holderMedian: medianNumber(holderNumeric),
      p25: percentileNumber(holderNumeric, 0.25),
      p50: percentileNumber(holderNumeric, 0.5),
      p75: percentileNumber(holderNumeric, 0.75),
      p90: percentileNumber(holderNumeric, 0.9),
      p95: percentileNumber(holderNumeric, 0.95),
      p99: percentileNumber(holderNumeric, 0.99),
      maximum: (playerValues.reduce((max, value) => value > max ? value : max, 0n)).toString(),
      top1Share: distribution.topPlayers.find((entry) => entry.requested === 1)?.share ?? 0,
      top3Share: distribution.topPlayers.find((entry) => entry.requested === 3)?.share ?? 0,
      top5Share: distribution.topPlayers.find((entry) => entry.requested === 5)?.share ?? 0,
      top10PercentShare: distribution.topPercents.find((entry) => entry.requestedPercent === 10)?.share ?? 0,
      hhi: distribution.hhi,
      normalizedHhi: distribution.normalizedHhi,
      gini: giniFromBigints(playerValues),
      externalInflow: globalMovement.externalAcquired.toString(),
      transformInflow: globalMovement.transformedIn.toString(),
      transformOutflow: globalMovement.transformedOut.toString(),
      finalSink: globalMovement.finalSink.toString(),
      adminPositive: globalMovement.adminPositive.toString(),
      adminNegative: globalMovement.adminNegative.toString(),
      transferInflow: globalMovement.transferredIn.toString(),
      transferOutflow: globalMovement.transferredOut.toString(),
      grossInflow: flowIn.toString(),
      grossOutflow: flowOut.toString(),
      netChange: startingChange?.toString() ?? null,
      acquisitionEventCount: globalMovement.acquisitionEventCount,
      outflowEventCount: globalMovement.outflowEventCount,
      uniqueAcquiringPlayers: new Set(itemEvents.filter((event) => event.playerId && event.leg === "credit" && (event.eventKind === "SOURCE" || event.eventKind === "TRANSFORM")).map((event) => event.playerId)).size,
      uniqueSpendingPlayers: new Set(itemEvents.filter((event) => event.playerId && event.leg === "debit" && (event.eventKind === "SINK" || event.eventKind === "TRANSFORM")).map((event) => event.playerId)).size,
      acquisitionParticipationRate: activePlayers.length === 0 ? null : acquiringValues.length / activePlayers.length,
      spendingParticipationRate: activePlayers.length === 0 ? null : new Set(itemEvents.filter((event) => event.playerId && activeIds.has(event.playerId) && event.leg === "debit" && (event.eventKind === "SINK" || event.eventKind === "TRANSFORM")).map((event) => event.playerId)).size / activePlayers.length,
      meanAcquiredPerActivePlayer: acquisitionValues.length === 0 ? null : acquisitionValues.reduce((sum, value) => sum + value, 0) / acquisitionValues.length,
      medianAcquiredPerActivePlayer: medianNumber(acquisitionValues),
      meanAcquiredPerAcquiringPlayer: acquiringValues.length === 0 ? null : acquiringValues.reduce((sum, value) => sum + value, 0) / acquiringValues.length,
      medianAcquiredPerAcquiringPlayer: medianNumber(acquiringValues),
      p90AcquiredPerAcquiringPlayer: percentileNumber(acquiringValues, 0.9),
      maximumAcquiredByPlayer: acquiringValues.reduce((maximum, value) => Math.max(maximum, value), 0).toString(),
      meanNetChangePerActivePlayer: netValues.length === 0 ? null : netValues.reduce((sum, value) => sum + value, 0) / netValues.length,
      medianNetChangePerActivePlayer: medianNumber(netValues),
      externallyAcquiredPerActiveHour: activeHours <= 0 ? null : Number(globalMovement.externalAcquired) / activeHours,
      grossAcquiredPerActiveHour: activeHours <= 0 ? null : Number(flowIn) / activeHours,
      acquisitionEventsPer100ActiveHours: activeHours <= 0 ? null : globalMovement.acquisitionEventCount / activeHours * 100,
      averageTimeBetweenAcquisitionEventsSeconds: averageTimeBetween(globalMovement.acquisitionTimes),
      attemptMetrics: attemptMetrics(snapshot.attempts.get(item.itemId)),
      labels: []
    };
    const classifiedEventCount = itemEvents.filter((event) => event.eventKind !== "UNKNOWN").length;
    items.push({ ...itemReportBase, labels: deriveLabels({ report: itemReportBase, activeCount: activePlayers.length, eventCount: classifiedEventCount, snapshot }) });
    const inTotal = [...sourceTotals.values()].reduce((sum, value) => sum + value.quantity, 0n);
    const outTotal = [...outflowTotals.values()].reduce((sum, value) => sum + value.quantity, 0n);
    for (const [source, value] of sourceTotals) sourceBreakdown.push({ assetId: item.itemId, variant: "all", direction: "inflow", source, quantity: value.quantity.toString(), percentage: ratio(value.quantity, inTotal), eventCount: value.events });
    for (const [source, value] of outflowTotals) sourceBreakdown.push({ assetId: item.itemId, variant: "all", direction: "outflow", source, quantity: value.quantity.toString(), percentage: ratio(value.quantity, outTotal), eventCount: value.events });
  }

  const metadata: EconomyReportMetadata = {
    windowStart,
    windowEnd,
    snapshotStart: snapshot.snapshotStart,
    snapshotEnd: snapshot.snapshotAsOf,
    durationSeconds,
    generation: process.env.RUNTIME_GENERATION ?? process.env.TELEMETRY_RELEASE_GENERATION ?? null,
    releaseSha: process.env.RUNTIME_SHA ?? null,
    runtimeLabel: process.env.RUNTIME_LABEL ?? null,
    coverageStatus: snapshot.coverage.length === 0 ? "unavailable" : snapshot.coverage.some((row) => row.status === "unavailable") ? "unavailable" : snapshot.coverage.some((row) => row.status !== "complete") ? "partial" : "complete",
    reconciliationStatus: snapshot.metadata.reconciliation.status,
    activePlayerCount: activePlayers.length,
    totalActiveGameplaySeconds: activePlayers.reduce((sum, player) => sum + player.activeSeconds, 0)
  };
  const dataQuality: EconomyDataQuality[] = snapshot.coverage.map((row) => ({ key: `coverage:${row.domain}`, status: row.status === "complete" ? "ok" : row.status === "unavailable" ? "unsupported" : "partial", detail: row.notes }));
  dataQuality.push({ key: "reconciliation", status: snapshot.metadata.reconciliation.status === "ok" ? "ok" : "failed", detail: `${snapshot.metadata.reconciliation.transferGroups} transfer groups; ${snapshot.metadata.reconciliation.imbalancedGroups} imbalanced.` });
  dataQuality.push({ key: "starting_quantities", status: snapshot.snapshotStart ? "ok" : "partial", detail: snapshot.snapshotStart ? "Derived from a retained snapshot or immutable event ledger." : "No retained snapshot precedes the requested window; rows without ledger activity have null starting quantities." });
  dataQuality.push({ key: "analysis_event_bound", status: snapshot.analysisEventsTruncated ? "partial" : "ok", detail: snapshot.analysisEventsTruncated ? `More than ${MAX_ANALYSIS_EVENT_ROWS.toLocaleString()} events matched; analysis rows are bounded.` : "All matched economy events were loaded." });
  dataQuality.push({ key: "attempt_denominators", status: "partial", detail: "Harvest-session attempts are supported where present; other source attempt denominators remain null unless authoritative telemetry exists." });
  dataQuality.push({ key: "dynamic_catalog", status: "ok", detail: "Catalog and observed economy asset IDs are discovered from authoritative rows; zero-supply catalog items remain in Item Statistics." });
  return {
    metadata,
    items,
    sourceBreakdown,
    playerItemRows,
    cohorts: buildCohortStatistics(items, playerItemRows, activePlayers, windowEnd),
    coverage: snapshot.coverage,
    dataQuality
  };
}

function isPlayerRelevantCustody(custodyType: string): boolean {
  return [
    "player_inventory", "player_wallet", "equipment", "backpack", "manor_storage",
    "market_escrow", "market_collection"
  ].includes(custodyType);
}

function attemptMetrics(evidence: AttemptEvidence | undefined): EconomyAttemptMetrics {
  if (!evidence) return { supported: false, attempts: null, successfulAttempts: null, observedRate: null, note: "No authoritative attempt denominator is instrumented for this item/source." };
  return {
    supported: evidence.supported,
    attempts: evidence.attempts,
    successfulAttempts: evidence.successfulAttempts,
    observedRate: evidence.attempts && evidence.attempts > 0 && evidence.successfulAttempts !== null ? evidence.successfulAttempts / evidence.attempts : null,
    note: evidence.note
  };
}

function averageTimeBetween(times: readonly string[]): number | null {
  if (times.length < 2) return null;
  const ordered = [...times].sort((left, right) => Date.parse(left) - Date.parse(right));
  let total = 0;
  for (let index = 1; index < ordered.length; index += 1) total += Math.max(0, Date.parse(ordered[index]!) - Date.parse(ordered[index - 1]!));
  return total / (ordered.length - 1) / 1000;
}

function buildCohortStatistics(
  items: readonly EconomyItemReport[],
  rows: readonly EconomyPlayerItemReport[],
  activePlayers: readonly AnalysisPlayer[],
  asOf: string
): readonly EconomyReportCohort[] {
  const rowsByItemPlayer = new Map(rows.map((row) => [`${row.itemId}\u0000${row.playerId}`, row]));
  const dimensions: readonly [EconomyReportCohort["dimension"], (player: AnalysisPlayer) => string][] = [
    ["level", (player) => player.level === null ? "unknown" : player.level <= 5 ? "1-5" : player.level <= 10 ? "6-10" : player.level <= 15 ? "11-15" : player.level <= 20 ? "16-20" : "21-25"],
    ["active_time", (player) => {
      const hours = player.activeSeconds / 3600;
      return hours < 2 ? "<2h" : hours < 10 ? "2-10h" : hours < 25 ? "10-25h" : hours < 50 ? "25-50h" : "50+h";
    }],
    ["activity", (player) => {
      const minutes = player.activeSeconds / 60;
      return minutes < 15 ? "<15m" : minutes < 60 ? "15-60m" : minutes < 180 ? "1-3h" : "3+h";
    }],
    ["account_age", (player) => {
      const days = accountAgeDays(player, asOf);
      return days === null ? "unknown" : days < 7 ? "<7d" : days < 30 ? "7-30d" : "30+d";
    }],
    ["social", (player) => player.kingdomName ? "kingdom" : "no kingdom"],
    ["kingdom", (player) => player.kingdomName ?? "no kingdom"]
  ];
  const result: EconomyReportCohort[] = [];
  for (const item of items) {
    for (const [dimension, valueOf] of dimensions) {
      const groups = new Map<string, AnalysisPlayer[]>();
      for (const player of activePlayers) {
        const value = valueOf(player);
        const group = groups.get(value) ?? [];
        group.push(player);
        groups.set(value, group);
      }
      for (const [cohort, players] of groups) {
        const values = players.map((player) => Number(rowsByItemPlayer.get(`${item.assetId}\u0000${player.playerId}`)?.endingQuantity ?? "0"));
        const acquired = players.reduce((sum, player) => sum + BigInt(rowsByItemPlayer.get(`${item.assetId}\u0000${player.playerId}`)?.grossAcquired ?? "0"), 0n);
        const outflow = players.reduce((sum, player) => sum + BigInt(rowsByItemPlayer.get(`${item.assetId}\u0000${player.playerId}`)?.grossOutflow ?? "0"), 0n);
        result.push({
          dimension,
          cohort,
          assetId: item.assetId,
          activePlayers: players.length,
          holders: values.filter((value) => value > 0).length,
          endingQuantity: values.reduce((sum, value) => sum + BigInt(Math.max(0, Math.round(value))), 0n).toString(),
          grossAcquired: acquired.toString(),
          grossOutflow: outflow.toString(),
          medianQuantity: medianNumber(values),
          holdingRate: players.length === 0 ? null : values.filter((value) => value > 0).length / players.length
        });
      }
    }
  }
  return result;
}

function itemComparator(sort: "quantity" | "holders" | "assetId" | "displayName", direction: "asc" | "desc"): (left: EconomyItemSummary, right: EconomyItemSummary) => number {
  const sign = direction === "asc" ? 1 : -1;
  return (left, right) => {
    const compared = sort === "quantity" ? (BigInt(left.quantity) > BigInt(right.quantity) ? 1 : BigInt(left.quantity) < BigInt(right.quantity) ? -1 : 0)
      : sort === "holders" ? left.holderCount - right.holderCount
      : (sort === "displayName" ? left.displayName.localeCompare(right.displayName) : left.assetId.localeCompare(right.assetId));
    return compared * sign || left.assetId.localeCompare(right.assetId);
  };
}

function holderComparator(
  sort: "currentQuantity" | "grossAcquired" | "grossOutflow" | "netChange" | "percentile" | "activeGameplaySeconds" | "displayName",
  direction: "asc" | "desc"
): (left: EconomyItemHolder, right: EconomyItemHolder) => number {
  const sign = direction === "asc" ? 1 : -1;
  const bigintCompare = (left: string | null, right: string | null): number => {
    const leftValue = left === null ? 0n : BigInt(left);
    const rightValue = right === null ? 0n : BigInt(right);
    return leftValue > rightValue ? 1 : leftValue < rightValue ? -1 : 0;
  };
  return (left, right) => {
    const compared = sort === "currentQuantity" ? bigintCompare(left.currentQuantity, right.currentQuantity)
      : sort === "grossAcquired" ? bigintCompare(left.grossAcquired, right.grossAcquired)
      : sort === "grossOutflow" ? bigintCompare(left.grossOutflow, right.grossOutflow)
      : sort === "netChange" ? bigintCompare(left.netChange, right.netChange)
      : sort === "percentile" ? (left.percentile ?? -1) - (right.percentile ?? -1)
      : sort === "activeGameplaySeconds" ? left.activeGameplaySeconds - right.activeGameplaySeconds
      : left.displayName.localeCompare(right.displayName);
    return compared * sign || left.playerId.localeCompare(right.playerId);
  };
}

function playerSummaries(snapshot: SnapshotRead): EconomyPlayerSummary[] {
  const holdingsByPlayer = new Map<string, EconomyHolding[]>();
  for (const holding of snapshot.holdings) {
    if (holding.supplyScope !== "player_controlled_existing_supply" || !holding.playerId) continue;
    const playerRows = holdingsByPlayer.get(holding.playerId) ?? [];
    playerRows.push(holding);
    holdingsByPlayer.set(holding.playerId, playerRows);
  }
  return snapshot.players.map((player) => {
    const holdings = holdingsByPlayer.get(player.playerId) ?? [];
    const fungibleIds = new Set(holdings.filter((holding) => holding.assetKind === "fungible").map((holding) => holding.assetId));
    return {
      playerId: player.playerId,
      displayName: player.displayName,
      accountId: player.accountId,
      level: player.level,
      kingdom: player.kingdomName,
      city: player.cityName,
      accountAgeDays: accountAgeDays(player, snapshot.snapshotAsOf),
      activeGameplaySeconds: player.activeSeconds,
      connectedSeconds: player.connectedSeconds,
      lastActiveAt: player.lastActiveAt,
      gold: player.gold.toString(),
      fungibleItemCount: fungibleIds.size,
      backpackCount: holdings.filter((holding) => holding.custodyType === "backpack").length,
      distinctResourceCount: new Set(holdings.map((holding) => holding.assetId)).size,
      quantity: holdings.filter((holding) => holding.assetKind === "fungible").reduce((sum, holding) => sum + holding.quantity, 0n).toString(),
      uniqueAssetCount: holdings.filter((holding) => holding.assetKind === "unique").length,
      assetCount: new Set(holdings.map((holding) => holding.assetId)).size,
      lastSeenAt: player.lastSeenAt
    } satisfies EconomyPlayerSummary;
  });
}

function playerMatches(
  player: EconomyPlayerSummary,
  input: Readonly<{ search?: string | undefined; activeOnly?: boolean | undefined; lastActiveHours?: number | undefined; activeGameplayHoursMin?: number | undefined; activeGameplayHoursMax?: number | undefined; levelMin?: number | undefined; levelMax?: number | undefined; kingdom?: string | undefined; city?: string | undefined; accountAgeCohort?: string | undefined }>,
  asOf: string
): boolean {
  const search = input.search?.trim().toLowerCase() ?? "";
  if (search && !`${player.displayName} ${player.playerId} ${player.accountId ?? ""}`.toLowerCase().includes(search)) return false;
  if (input.activeOnly && player.activeGameplaySeconds <= 0) return false;
  if (input.lastActiveHours !== undefined && (!player.lastActiveAt || Date.parse(asOf) - Date.parse(player.lastActiveAt) > input.lastActiveHours * 60 * 60 * 1000)) return false;
  const activeGameplayHours = player.activeGameplaySeconds / 3600;
  if (input.activeGameplayHoursMin !== undefined && activeGameplayHours < input.activeGameplayHoursMin) return false;
  if (input.activeGameplayHoursMax !== undefined && activeGameplayHours > input.activeGameplayHoursMax) return false;
  if (input.levelMin !== undefined && (player.level === null || player.level < input.levelMin)) return false;
  if (input.levelMax !== undefined && (player.level === null || player.level > input.levelMax)) return false;
  if (input.kingdom && (player.kingdom ?? "").toLowerCase() !== input.kingdom.toLowerCase()) return false;
  if (input.city && (player.city ?? "").toLowerCase() !== input.city.toLowerCase()) return false;
  if (input.accountAgeCohort && ageCohort(player.accountAgeDays) !== input.accountAgeCohort) return false;
  return true;
}

function playerComparator(sort: "quantity" | "activeGameplaySeconds" | "level" | "lastActiveAt" | "displayName" | "gold", direction: "asc" | "desc"): (left: EconomyPlayerSummary, right: EconomyPlayerSummary) => number {
  const sign = direction === "asc" ? 1 : -1;
  return (left, right) => {
    const compared = sort === "quantity" ? (BigInt(left.quantity) > BigInt(right.quantity) ? 1 : BigInt(left.quantity) < BigInt(right.quantity) ? -1 : 0)
      : sort === "gold" ? (BigInt(left.gold) > BigInt(right.gold) ? 1 : BigInt(left.gold) < BigInt(right.gold) ? -1 : 0)
      : sort === "activeGameplaySeconds" ? left.activeGameplaySeconds - right.activeGameplaySeconds
      : sort === "level" ? (left.level ?? -1) - (right.level ?? -1)
      : sort === "lastActiveAt" ? (Date.parse(left.lastActiveAt ?? "1970-01-01") - Date.parse(right.lastActiveAt ?? "1970-01-01"))
      : left.displayName.localeCompare(right.displayName);
    return compared * sign || left.playerId.localeCompare(right.playerId);
  };
}

function ageCohort(days: number | null): string {
  if (days === null) return "unknown";
  return days < 7 ? "<7d" : days < 30 ? "7-30d" : "30+d";
}

function pageDetails(pageValue: number | undefined, pageSizeValue: number | undefined, total: number): EconomyPagination {
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(Number.isFinite(pageSizeValue) && pageSizeValue ? pageSizeValue : DEFAULT_PAGE_SIZE)));
  const page = Math.max(1, Math.floor(Number.isFinite(pageValue) && pageValue ? pageValue : 1));
  return { page, pageSize, total, hasNext: page * pageSize < total };
}

function itemHolderFromPlayerItem(row: EconomyPlayerItemReport, snapshot: SnapshotRead, scope: EconomySupplyScope): EconomyItemHolder {
  const custody = new Map<string, bigint>();
  for (const holding of snapshot.holdings) {
    if (holding.playerId === row.playerId && holding.assetId === row.itemId && holding.supplyScope === scope) {
      custody.set(holding.custodyType, (custody.get(holding.custodyType) ?? 0n) + holding.quantity);
    }
  }
  const end = BigInt(row.endingQuantity);
  const playerQuantity = row.endingQuantity;
  return {
    playerId: row.playerId,
    displayName: row.displayName,
    currentQuantity: playerQuantity,
    startingQuantity: row.startingQuantity,
    endingQuantity: row.endingQuantity,
    grossAcquired: row.grossAcquired,
    grossOutflow: row.grossOutflow,
    netChange: row.netChange,
    shareOfPlayerControlledSupply: null,
    percentile: row.endingPercentile,
    activeGameplaySeconds: row.activeGameplaySeconds,
    quantityPerActiveGameplayHour: row.activeGameplaySeconds > 0 ? Number(end) / (row.activeGameplaySeconds / 3600) : null,
    lastActiveAt: snapshot.players.find((player) => player.playerId === row.playerId)?.lastActiveAt ?? null,
    level: row.level,
    kingdom: row.kingdom,
    custodyBreakdown: Object.fromEntries([...custody.entries()].map(([key, value]) => [key, value.toString()]))
  };
}

function holderMatches(
  holder: EconomyItemHolder,
  input: Readonly<{ activeOnly?: boolean | undefined; levelMin?: number | undefined; levelMax?: number | undefined; kingdom?: string | undefined; activityCohort?: string | undefined; accountAgeCohort?: string | undefined }>,
  asOf: string,
  players: readonly AnalysisPlayer[]
): boolean {
  if (input.activeOnly && holder.activeGameplaySeconds <= 0) return false;
  if (input.levelMin !== undefined && (holder.level === null || holder.level < input.levelMin)) return false;
  if (input.levelMax !== undefined && (holder.level === null || holder.level > input.levelMax)) return false;
  if (input.kingdom && (holder.kingdom ?? "").toLowerCase() !== input.kingdom.toLowerCase()) return false;
  if (input.activityCohort && activityCohort(holder.activeGameplaySeconds) !== input.activityCohort) return false;
  // Holder rows do not carry account age to keep the response compact. The
  // server-side account-age filter is applied by inspecting the source player.
  if (input.accountAgeCohort) {
    const player = players.find((candidate) => candidate.playerId === holder.playerId);
    if (!player || ageCohort(accountAgeDays(player, asOf)) !== input.accountAgeCohort) return false;
  }
  return true;
}

function activityCohort(activeSeconds: number): string {
  const minutes = activeSeconds / 60;
  return minutes < 15 ? "<15m" : minutes < 60 ? "15-60m" : minutes < 180 ? "1-3h" : "3+h";
}

function validateAsset(asset: EconomyLedgerAsset): void {
  if (!asset.assetId || asset.assetId.length > 160 || asset.quantity <= 0n) {
    throw new Error("Economy ledger assets must have a bounded positive identity and quantity");
  }
  if (asset.assetKind === "unique" && (asset.quantity !== 1n || !asset.uniqueAssetInstanceId)) {
    throw new Error("Unique economy assets require quantity one and an instance identity");
  }
  if (asset.assetKind === "fungible" && asset.uniqueAssetInstanceId) {
    throw new Error("Fungible economy assets cannot carry a unique instance identity");
  }
}

function holdingView(row: HoldingRow): EconomyHolding {
  return {
    supplyScope: row.supply_scope,
    existingSupply: row.existing_supply,
    assetKind: row.asset_kind,
    assetId: row.asset_id,
    itemId: row.item_id,
    variant: row.variant,
    uniqueAssetInstanceId: row.unique_asset_instance_id,
    quantity: BigInt(row.quantity),
    custodyType: row.custody_type,
    custodyId: row.custody_id,
    playerId: row.player_id,
    organizationType: row.organization_type,
    organizationId: row.organization_id
  };
}

function coverageView(row: CoverageRow): EconomyCoverage {
  return {
    domain: row.domain_key,
    status: row.status,
    reliableFrom: asIso(row.reliable_from),
    lastObservedAt: row.last_observed_at ? asIso(row.last_observed_at) : null,
    notes: row.notes
  };
}

function sessionView(row: SessionRow, snapshotAsOf: string): EconomySession {
  let connectedSeconds = Number(row.connected_seconds);
  let activeSeconds = Number(row.active_seconds);
  if (row.state === "connected") {
    connectedSeconds = Math.max(
      connectedSeconds,
      Math.floor(Math.max(0, Date.parse(snapshotAsOf) - Date.parse(asIso(row.connected_at))) / 1000)
    );
    if (row.last_gameplay_at) {
      activeSeconds += Math.min(
        ACTIVE_WINDOW_SECONDS,
        Math.floor(Math.max(0, Date.parse(snapshotAsOf) - Date.parse(asIso(row.last_gameplay_at))) / 1000)
      );
    }
  }
  activeSeconds = Math.min(connectedSeconds, activeSeconds);
  return {
    sessionId: row.session_id,
    playerId: row.player_id,
    state: row.state,
    connectedAt: asIso(row.connected_at),
    lastSeenAt: asIso(row.last_seen_at),
    lastGameplayAt: row.last_gameplay_at ? asIso(row.last_gameplay_at) : null,
    disconnectedAt: row.disconnected_at ? asIso(row.disconnected_at) : null,
    connectedSeconds,
    activeSeconds,
    inactiveSeconds: Math.max(0, connectedSeconds - activeSeconds)
  };
}

function aggregateFlowRows(rows: readonly FlowRow[]): EconomyFlow[] {
  const grouped = new Map<string, EconomyFlow>();
  for (const row of rows) {
    const key = `${row.asset_id}\u0000${row.variant}`;
    const current = grouped.get(key) ?? {
      assetId: row.asset_id,
      variant: row.variant,
      sourceIn: 0n,
      sinkOut: 0n,
      transformIn: 0n,
      transformOut: 0n,
      adminIn: 0n,
      adminOut: 0n,
      unknownIn: 0n,
      unknownOut: 0n,
      transferIn: 0n,
      transferOut: 0n,
      eventCount: 0,
      classifiedEventCount: 0
    } satisfies EconomyFlow;
    const quantity = BigInt(row.quantity);
    const inbound = row.leg === "credit";
    if (row.event_kind === "SOURCE") {
      if (inbound) current.sourceIn += quantity;
    } else if (row.event_kind === "SINK") {
      if (!inbound) current.sinkOut += quantity;
    } else if (row.event_kind === "TRANSFORM") {
      if (inbound) current.transformIn += quantity;
      else current.transformOut += quantity;
    } else if (row.event_kind === "ADMIN") {
      if (inbound) current.adminIn += quantity;
      else current.adminOut += quantity;
    } else if (row.event_kind === "TRANSFER") {
      if (inbound) current.transferIn += quantity;
      else current.transferOut += quantity;
    } else if (inbound) {
      current.unknownIn += quantity;
    } else {
      current.unknownOut += quantity;
    }
    current.eventCount += Number(row.event_count);
    if (row.event_kind !== "UNKNOWN" && row.event_kind !== "TRANSFER") {
      current.classifiedEventCount += Number(row.event_count);
    }
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) => left.assetId.localeCompare(right.assetId) || left.variant.localeCompare(right.variant));
}

function flowView(flow: EconomyFlow): EconomyFlowView {
  const grossIn = flow.sourceIn + flow.transformIn;
  const grossOut = flow.sinkOut + flow.transformOut;
  return {
    assetId: flow.assetId,
    variant: flow.variant,
    grossIn: grossIn.toString(),
    grossOut: grossOut.toString(),
    net: (grossIn - grossOut + flow.adminIn - flow.adminOut).toString(),
    sourceIn: flow.sourceIn.toString(),
    sinkOut: flow.sinkOut.toString(),
    transformIn: flow.transformIn.toString(),
    transformOut: flow.transformOut.toString(),
    adminIn: flow.adminIn.toString(),
    adminOut: flow.adminOut.toString(),
    unknownIn: flow.unknownIn.toString(),
    unknownOut: flow.unknownOut.toString(),
    transferIn: flow.transferIn.toString(),
    transferOut: flow.transferOut.toString(),
    eventCount: flow.eventCount
  };
}

function summarizeScope(
  scope: EconomySupplyScope,
  holdings: readonly EconomyHolding[],
  metadata: EconomySnapshotMetadata,
  confidence: number,
  eventCount: number,
  activePlayerCount: number,
  historicalBaselineAvailable: boolean,
  observationWindowMs: number
): EconomyScopeSummary {
  const fungible = holdings.filter((holding) => holding.assetKind === "fungible");
  const unique = holdings.filter((holding) => holding.assetKind === "unique");
  const byHolder = new Map<string, bigint>();
  for (const holding of holdings) {
    const key = holderKey(holding);
    byHolder.set(key, (byHolder.get(key) ?? 0n) + holding.quantity);
  }
  const distribution = calculateDistributionFromBigints([...byHolder.values()]);
  const fungibleUnits = fungible.reduce((sum, holding) => sum + holding.quantity, 0n);
  const status = economyHealthLabel({
    coverage: confidence,
    eventCount,
    holderCount: byHolder.size,
    reconciliationOk: metadata.reconciliation.status === "ok",
    stale: metadata.staleness.isStale,
    normalizedHhi: distribution.normalizedHhi,
    activePlayerCount,
    historicalBaselineAvailable,
    observationWindowMs
  });
  return {
    scope,
    fungibleUnits: fungibleUnits.toString(),
    uniqueAssetCount: unique.length,
    holderCount: byHolder.size,
    distribution,
    health: status,
    confidence
  };
}

function summarizeSessions(sessions: readonly EconomySession[], snapshotAsOf: string): EconomyOverview["sessions"] {
  const cutoff = Date.parse(snapshotAsOf) - ACTIVE_WINDOW_SECONDS * 1000;
  const connected = sessions.filter((session) => session.state === "connected").length;
  const active = sessions.filter((session) => session.state === "connected" && session.lastGameplayAt !== null && Date.parse(session.lastGameplayAt) >= cutoff).length;
  return {
    connected,
    active,
    afk: Math.max(0, connected - active),
    activePlayers: new Set(sessions.filter((session) => session.state === "connected" && session.lastGameplayAt !== null && Date.parse(session.lastGameplayAt) >= cutoff).map((session) => session.playerId)).size
  };
}

function holderKey(holding: EconomyHolding): string {
  if (holding.playerId) return `player:${holding.playerId}`;
  if (holding.organizationType && holding.organizationId) return `${holding.organizationType}:${holding.organizationId}`;
  return `${holding.custodyType}:${holding.custodyId}`;
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function bigintSafeIntegerString(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.max(0, Math.round(value)).toString();
}

type XlsxCell = string | number | boolean | null | undefined;
export type XlsxSheet = Readonly<{ name: string; rows: readonly (readonly XlsxCell[])[] }>;

export function createXlsxWorkbook(sheets: readonly XlsxSheet[]): Buffer {
  const safeSheets = sheets.map((sheet, index) => ({
    name: sanitizeSheetName(sheet.name, index),
    rows: sheet.rows.slice(0, MAX_EXPORT_ROWS + 1).map((row) => row.slice(0, MAX_EXPORT_COLUMNS))
  }));
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", content: contentTypesXml(safeSheets.length) },
    { name: "_rels/.rels", content: rootRelsXml() },
    { name: "xl/workbook.xml", content: workbookXml(safeSheets) },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRelsXml(safeSheets.length) },
    { name: "xl/styles.xml", content: stylesXml() },
    ...safeSheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      content: worksheetXml(sheet.rows)
    }))
  ];
  return zipStore(entries);
}

type ZipEntry = Readonly<{ name: string; content: string }>;

function sanitizeSheetName(name: string, index: number): string {
  const safe = name.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 31);
  return safe || `Sheet ${index + 1}`;
}

function worksheetXml(rows: readonly (readonly XlsxCell[])[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => cellXml(cell, rowIndex + 1, columnIndex + 1)).join("")}</row>`).join("") +
    `</sheetData></worksheet>`;
}

function cellXml(value: XlsxCell, row: number, column: number): string {
  if (value === null || value === undefined || value === "") return "";
  const reference = `${columnName(column)}${row}`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  const textValue = formulaSafeText(String(value));
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(textValue)}</t></is></c>`;
}

function formulaSafeText(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function columnName(column: number): string {
  let value = column;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function contentTypesXml(sheetCount: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${Array.from({ length: sheetCount }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`;
}

function rootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

function workbookXml(sheets: readonly { name: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`;
}

function workbookRelsXml(sheetCount: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: sheetCount }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Aptos"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>`;
}

function zipStore(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const crc = crc32(content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, content);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
