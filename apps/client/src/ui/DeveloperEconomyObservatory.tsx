import { useEffect, useMemo, useState } from "react";
import { CURRENT_LEVEL_CAP } from "@ash-atlas/shared";

import {
  GameAppActionBar,
  GameAppCard,
  GameAppShell,
  GameAppTabs
} from "./GameAppShell.js";

type Layout = "desktop" | "phone";
type Tab = "overview" | "items" | "players" | "flow";
type WindowName = "24h" | "7d" | "30d";
type AccountAgeCohort = "" | "<7d" | "7-30d" | "30+d" | "unknown";
type PlayerFilters = Readonly<{
  activeOnly: boolean;
  lastActiveHours: string;
  activeGameplayHoursMin: string;
  activeGameplayHoursMax: string;
  levelMin: string;
  levelMax: string;
  kingdom: string;
  city: string;
  accountAgeCohort: AccountAgeCohort;
}>;
type HolderFilters = Readonly<{
  search: string;
  sort: string;
  direction: "asc" | "desc";
  activeOnly: boolean;
  levelMin: string;
  levelMax: string;
  kingdom: string;
  activityCohort: string;
  accountAgeCohort: AccountAgeCohort;
}>;

const EMPTY_PLAYER_FILTERS: PlayerFilters = {
  activeOnly: false,
  lastActiveHours: "",
  activeGameplayHoursMin: "",
  activeGameplayHoursMax: "",
  levelMin: "",
  levelMax: "",
  kingdom: "",
  city: "",
  accountAgeCohort: ""
};
const EMPTY_HOLDER_FILTERS: HolderFilters = {
  search: "",
  sort: "currentQuantity",
  direction: "desc",
  activeOnly: false,
  levelMin: "",
  levelMax: "",
  kingdom: "",
  activityCohort: "",
  accountAgeCohort: ""
};

type Props = Readonly<{
  open: boolean;
  serverHttpBase?: string;
  onClose(): void;
}>;

type Metadata = {
  snapshotAsOf: string;
  isolationLevel: string;
  historicalBaselineAvailable: boolean;
  reconciliation: { status: string; imbalancedGroups: number };
  staleness: { isStale: boolean; staleSources: string[]; maxAgeSeconds: number };
};

type Overview = {
  metadata: Metadata;
  scopes: Array<{
    scope: string;
    fungibleUnits: string;
    uniqueAssetCount: number;
    holderCount: number;
    distribution: { hhi: number; normalizedHhi: number | null; topN: { actualCount: number; share: number }; topPercent: { actualCount: number; share: number } };
    health: string;
    confidence: number;
  }>;
  flow: Array<Record<string, string | number>>;
  coverage: Array<{ domain: string; status: string; notes: string }>;
  sessions: { connected: number; active: number; afk: number; activePlayers: number };
};

type Pagination = { page: number; pageSize: number; total: number; hasNext: boolean };
type Items = { metadata: Metadata; items: Array<Item>; pagination: Pagination };
type Item = { assetId: string; variant: string; assetKind: string; displayName: string; category: string; quantity: string; holderCount: number; scope: string };
type Players = { metadata: Metadata; players: Array<Player>; pagination: Pagination };
type Player = {
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
};
type Flow = { metadata: Metadata; flow: Array<Record<string, string | number>> };
type Report = {
  metadata: {
    windowStart: string;
    windowEnd: string;
    snapshotStart: string | null;
    snapshotEnd: string;
    durationSeconds: number;
    generation: string | null;
    releaseSha: string | null;
    runtimeLabel: string | null;
    coverageStatus: string;
    reconciliationStatus: string;
    activePlayerCount: number;
    totalActiveGameplaySeconds: number;
  };
  items: Array<ReportItem>;
  sourceBreakdown: Array<{ assetId: string; direction: string; source: string; quantity: string; percentage: number; eventCount: number }>;
  playerItemRows: Array<PlayerItemRow>;
  cohorts: Array<{ dimension: string; cohort: string; assetId: string; activePlayers: number; holders: number; endingQuantity: string; grossAcquired: string; grossOutflow: string; medianQuantity: number | null; holdingRate: number | null }>;
  coverage: Array<{ domain: string; status: string; notes: string }>;
  dataQuality: Array<{ key: string; status: string; detail: string }>;
};
type ReportItem = {
  assetId: string;
  itemName: string;
  category: string;
  assetKind: string;
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
  attemptMetrics: { supported: boolean; attempts: number | null; successfulAttempts: number | null; observedRate: number | null; note: string };
  labels: Array<{ label: string; reasons: string[]; gated: boolean }>;
};
type PlayerItemRow = {
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
  custodyBreakdown: Record<string, string>;
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
};
type PlayerDetail = {
  metadata: Metadata;
  player: Player | null;
  holdings: Array<{ assetId: string; variant: string; assetKind: string; quantity: string; custodyType: string; custodyId: string; playerId: string | null }>;
  custody: Record<string, Array<{ assetId: string; variant: string; assetKind: string; quantity: string; custodyType: string; custodyId: string; playerId: string | null }>>;
  wallet: { gold: string } | null;
  future: Array<{ assetId: string; quantity: string; custodyType: string }>;
  uniqueAssets: Array<{ assetId: string; quantity: string; custodyType: string; uniqueAssetInstanceId: string | null }>;
  itemRows: Array<PlayerItemRow>;
  events: Array<{ eventId: string; eventKind: string; leg: string; assetId: string; quantity: string; reason: string; occurredAt: string }>;
};
type ItemDetail = { metadata: Metadata; item: Item | null; holders: Array<{ playerId: string; displayName: string; currentQuantity: string; startingQuantity: string | null; endingQuantity: string; grossAcquired: string; grossOutflow: string; netChange: string | null; shareOfPlayerControlledSupply: number | null; percentile: number | null; activeGameplaySeconds: number; quantityPerActiveGameplayHour: number | null; lastActiveAt: string | null; level: number | null; kingdom: string | null; custodyBreakdown: Record<string, string> }>; pagination: Pagination; report: ReportItem | null };

export function DeveloperEconomyObservatory({ open, serverHttpBase, onClose }: Props): React.JSX.Element | null {
  const [tab, setTab] = useState<Tab>("overview");
  const [layout, setLayout] = useState<Layout>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return "desktop";
    }
    return window.matchMedia("(max-width: 720px)").matches ? "phone" : "desktop";
  });
  const [overview, setOverview] = useState<Overview | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [items, setItems] = useState<Items | null>(null);
  const [players, setPlayers] = useState<Players | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerDetail | null>(null);
  const [selectedItem, setSelectedItem] = useState<ItemDetail | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowName, setWindowName] = useState<WindowName>("24h");
  const [search, setSearch] = useState("");
  const [playerFilters, setPlayerFilters] = useState<PlayerFilters>(EMPTY_PLAYER_FILTERS);
  const [holderFilters, setHolderFilters] = useState<HolderFilters>(EMPTY_HOLDER_FILTERS);
  const [page, setPage] = useState(1);
  const [holderPage, setHolderPage] = useState(1);
  const [itemSort, setItemSort] = useState("quantity");
  const [playerSort, setPlayerSort] = useState("quantity");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    if (typeof window.matchMedia !== "function") {
      setLayout("desktop");
      return;
    }
    const media = window.matchMedia("(max-width: 720px)");
    const update = (): void => setLayout(media.matches ? "phone" : "desktop");
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setTab("overview"); setOverview(null); setReport(null); setItems(null); setPlayers(null); setFlow(null);
      setSelectedPlayer(null); setSelectedItem(null); setSelectedPlayerId(null); setSelectedItemId(null); setError(null); setPage(1); setHolderPage(1); setPlayerFilters(EMPTY_PLAYER_FILTERS); setHolderFilters(EMPTY_HOLDER_FILTERS); return;
    }
    if (!serverHttpBase) { setError("The server endpoint is unavailable."); return; }
    const controller = new AbortController();
    setLoading(true); setError(null);
    void getJson<Overview>(serverHttpBase, "/api/dev/economy/overview", { window: windowName }, controller.signal)
      .then(setOverview)
      .then(() => getJson<Report>(serverHttpBase, "/api/dev/economy/report", { window: windowName }, controller.signal))
      .then(setReport)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Economy Observatory is unavailable."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, serverHttpBase, windowName]);

  useEffect(() => {
    if (!open || !serverHttpBase || tab === "overview") return;
    const controller = new AbortController();
    setLoading(true);
    const path = tab === "items" ? "/api/dev/economy/items" : tab === "players" ? "/api/dev/economy/players" : "/api/dev/economy/flow";
    const params: Record<string, string | number | boolean> = { window: windowName };
    if (tab === "items") Object.assign(params, { scope: "existing_world_supply", page, pageSize: 50, search, sort: itemSort, direction });
    if (tab === "players") {
      Object.assign(params, { page, pageSize: 50, search, activeOnly: playerFilters.activeOnly, sort: playerSort, direction });
      addOptionalParams(params, {
        lastActiveHours: playerFilters.lastActiveHours,
        activeGameplayHoursMin: playerFilters.activeGameplayHoursMin,
        activeGameplayHoursMax: playerFilters.activeGameplayHoursMax,
        levelMin: playerFilters.levelMin,
        levelMax: playerFilters.levelMax,
        kingdom: playerFilters.kingdom,
        city: playerFilters.city,
        accountAgeCohort: playerFilters.accountAgeCohort
      });
    }
    void getJson<Items | Players | Flow>(serverHttpBase, path, params, controller.signal)
      .then((result) => { if (tab === "items") setItems(result as Items); else if (tab === "players") setPlayers(result as Players); else setFlow(result as Flow); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : `Economy ${tab} is unavailable.`); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, serverHttpBase, tab, windowName, page, search, playerFilters, itemSort, playerSort, direction]);

  useEffect(() => {
    if (!open || tab !== "items" || !serverHttpBase || !selectedItemId) return;
    const controller = new AbortController();
    const params: Record<string, string | number | boolean> = {
      window: windowName,
      scope: "existing_world_supply",
      page: holderPage,
      pageSize: 50,
      search: holderFilters.search,
      sort: holderFilters.sort,
      direction: holderFilters.direction,
      activeOnly: holderFilters.activeOnly
    };
    addOptionalParams(params, {
      levelMin: holderFilters.levelMin,
      levelMax: holderFilters.levelMax,
      kingdom: holderFilters.kingdom,
      activityCohort: holderFilters.activityCohort,
      accountAgeCohort: holderFilters.accountAgeCohort
    });
    setLoading(true);
    void getJson<ItemDetail>(serverHttpBase, `/api/dev/economy/items/${encodeURIComponent(selectedItemId)}`, params, controller.signal)
      .then(setSelectedItem)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Item detail is unavailable."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, serverHttpBase, tab, windowName, selectedItemId, holderFilters, holderPage]);

  useEffect(() => {
    if (!open || tab !== "players" || !serverHttpBase || !selectedPlayerId) return;
    const controller = new AbortController();
    setLoading(true);
    void getJson<PlayerDetail>(serverHttpBase, `/api/dev/economy/players/${encodeURIComponent(selectedPlayerId)}`, { window: windowName }, controller.signal)
      .then(setSelectedPlayer)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Player detail is unavailable."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, serverHttpBase, tab, windowName, selectedPlayerId]);

  const exportUrl = useMemo(() => {
    if (!serverHttpBase) return null;
    const url = new URL("/api/dev/economy/export.xlsx", serverHttpBase);
    url.searchParams.set("window", windowName);
    return url.toString();
  }, [serverHttpBase, windowName]);
  const changeTab = (value: string): void => { setTab(value as Tab); setPage(1); setHolderPage(1); setSearch(""); setPlayerFilters(EMPTY_PLAYER_FILTERS); setHolderFilters(EMPTY_HOLDER_FILTERS); setSelectedPlayer(null); setSelectedItem(null); setSelectedPlayerId(null); setSelectedItemId(null); };
  const updatePlayerFilter = <K extends keyof PlayerFilters>(key: K, value: PlayerFilters[K]): void => { setPlayerFilters((current) => ({ ...current, [key]: value })); setPage(1); };
  const updateHolderFilter = <K extends keyof HolderFilters>(key: K, value: HolderFilters[K]): void => { setHolderFilters((current) => ({ ...current, [key]: value })); setHolderPage(1); };

  return <GameAppShell open={open} title="Economy Observatory" eyebrow="Owner only · read-only" subtitle="24-hour balancing report, custody, flow, and player evidence" closeLabel="Close Economy Observatory" className="economy-observatory-app" layout={layout} phoneBackLabel="Back to Developer App" phoneShowReturnToGame={false} onClose={onClose} footer={<GameAppActionBar><label>Window <select aria-label="Report window" value={windowName} onChange={(event) => { setWindowName(event.currentTarget.value as WindowName); setPage(1); }}><option value="24h">24 hours</option><option value="7d">7 days</option><option value="30d">30 days</option></select></label>{exportUrl ? <a className="panel-action" href={exportUrl} download>Download XLSX</a> : null}</GameAppActionBar>}>
    <GameAppTabs variant="housed" scrollable ariaLabel="Economy Observatory sections" tabs={[{ id: "overview", label: "Overview" }, { id: "items", label: "Items" }, { id: "players", label: "Players" }, { id: "flow", label: "Source / Sink" }]} activeTab={tab} onChange={changeTab} />
    {loading ? <p role="status">Reading a coherent economy snapshot…</p> : null}
    {error ? <p role="alert" className="dev-feedback">{error}</p> : null}
    {tab === "overview" && overview ? <OverviewSection overview={overview} report={report} /> : null}
    {tab === "items" ? <ItemsSection items={items} search={search} onSearch={(value) => { setSearch(value); setPage(1); }} sort={itemSort} onSort={(value) => { setItemSort(value); setPage(1); }} direction={direction} onDirection={(value) => { setDirection(value); setPage(1); }} page={page} onPage={setPage} onOpen={(assetId) => { setHolderPage(1); setSelectedItem(null); setSelectedItemId(assetId); }} selectedItem={selectedItem} holderFilters={holderFilters} onHolderFilter={updateHolderFilter} holderPage={holderPage} onHolderPage={setHolderPage} /> : null}
    {tab === "players" ? <PlayersSection players={players} search={search} onSearch={(value) => { setSearch(value); setPage(1); }} sort={playerSort} onSort={(value) => { setPlayerSort(value); setPage(1); }} direction={direction} onDirection={(value) => { setDirection(value); setPage(1); }} filters={playerFilters} onFilter={updatePlayerFilter} page={page} onPage={setPage} onOpen={(playerId) => { setSelectedPlayer(null); setSelectedPlayerId(playerId); }} selectedPlayer={selectedPlayer} /> : null}
    {tab === "flow" ? <FlowSection flow={flow} /> : null}
  </GameAppShell>;
}

function OverviewSection({ overview, report }: Readonly<{ overview: Overview; report: Report | null }>): React.JSX.Element {
  return <><GameAppCard title="24-hour report" description={report ? `${report.metadata.windowStart} → ${report.metadata.windowEnd} · ${report.metadata.coverageStatus} coverage · ${report.metadata.reconciliationStatus} reconciliation` : "The report is loading."} badge={report?.metadata.coverageStatus ?? overview.metadata.reconciliation.status}>{report ? <p>{report.metadata.activePlayerCount.toLocaleString()} active players · {(report.metadata.totalActiveGameplaySeconds / 3600).toFixed(1)} active gameplay hours · {report.items.length.toLocaleString()} catalog/observed items. Generation: {report.metadata.generation ?? "unknown"}.</p> : <p role="status">Preparing the owner balancing dataset…</p>}</GameAppCard><GameAppCard title="Supply scopes" description="Current custody is separated from committed/future entitlements. Top-N counts use actual holder counts."><div className="market-table-scroll"><table className="economy-observatory-table"><thead><tr><th>Scope</th><th>Fungible</th><th>Unique</th><th>Holders</th><th>Norm. HHI</th><th>Top 10%</th><th>Health</th></tr></thead><tbody>{overview.scopes.map((scope) => <tr key={scope.scope}><th scope="row">{scope.scope.replaceAll("_", " ")}</th><td>{formatQuantity(scope.fungibleUnits)}</td><td>{scope.uniqueAssetCount.toLocaleString()}</td><td>{scope.holderCount.toLocaleString()}</td><td>{scope.distribution.normalizedHhi === null ? "—" : scope.distribution.normalizedHhi.toFixed(3)}</td><td>{scope.distribution.topPercent.actualCount} · {(scope.distribution.topPercent.share * 100).toFixed(1)}%</td><td>{scope.health} · {(scope.confidence * 100).toFixed(0)}%</td></tr>)}</tbody></table></div></GameAppCard><GameAppCard title="Connected versus active" description="Active requires persisted non-PING gameplay traffic in the five-minute activity window."><p>{overview.sessions.connected} connected · {overview.sessions.active} active · {overview.sessions.afk} AFK · {overview.sessions.activePlayers} active players</p></GameAppCard><GameAppCard title="Reconciliation and coverage" description={`Snapshot ${new Date(overview.metadata.snapshotAsOf).toLocaleString()} · ${overview.metadata.isolationLevel}`}><p>{overview.metadata.reconciliation.status === "ok" ? "Transfer groups conserve globally." : `${overview.metadata.reconciliation.imbalancedGroups} transfer groups need review.`} {overview.metadata.staleness.isStale ? `Stale: ${overview.metadata.staleness.staleSources.join(", ")}.` : "No stale observed sources."} Historical baseline: {overview.metadata.historicalBaselineAvailable ? "available" : "not captured yet"}.</p><ul>{overview.coverage.map((coverage) => <li key={coverage.domain}>{coverage.domain}: {coverage.status}</li>)}</ul></GameAppCard></>;
}

function ItemsSection({ items, search, onSearch, sort, onSort, direction, onDirection, page, onPage, onOpen, selectedItem, holderFilters, onHolderFilter, holderPage, onHolderPage }: Readonly<{ items: Items | null; search: string; onSearch(value: string): void; sort: string; onSort(value: string): void; direction: "asc" | "desc"; onDirection(value: "asc" | "desc"): void; page: number; onPage(value: number): void; onOpen(assetId: string): void; selectedItem: ItemDetail | null; holderFilters: HolderFilters; onHolderFilter<K extends keyof HolderFilters>(key: K, value: HolderFilters[K]): void; holderPage: number; onHolderPage(value: number): void }>): React.JSX.Element {
  return <><GameAppCard title="Item explorer" description="Server-side search, sorting, and pagination include ordinary catalog items even when current supply is zero."><ExplorerControls search={search} onSearch={onSearch} /><SortControls sort={sort} onSort={onSort} direction={direction} onDirection={onDirection} options={["quantity", "holders", "displayName", "assetId"]} /><div className="market-table-scroll"><table className="economy-observatory-table"><thead><tr><th>Item</th><th>Category</th><th>Kind</th><th>Quantity</th><th>Holders</th><th>Open</th></tr></thead><tbody>{items?.items.map((item) => <tr key={`${item.assetId}:${item.variant}`}><th scope="row">{item.displayName} <small>{item.assetId}</small></th><td>{item.category}</td><td>{item.assetKind}</td><td>{formatQuantity(item.quantity)}</td><td>{item.holderCount.toLocaleString()}</td><td><button type="button" onClick={() => onOpen(item.assetId)}>Inspect</button></td></tr>)}</tbody></table></div><Pagination pagination={items?.pagination} page={page} onPage={onPage} /></GameAppCard>{selectedItem ? <ItemDetailSection detail={selectedItem} filters={holderFilters} onFilter={onHolderFilter} page={holderPage} onPage={onHolderPage} /> : null}</>;
}

function PlayersSection({ players, search, onSearch, sort, onSort, direction, onDirection, filters, onFilter, page, onPage, onOpen, selectedPlayer }: Readonly<{ players: Players | null; search: string; onSearch(value: string): void; sort: string; onSort(value: string): void; direction: "asc" | "desc"; onDirection(value: "asc" | "desc"): void; filters: PlayerFilters; onFilter<K extends keyof PlayerFilters>(key: K, value: PlayerFilters[K]): void; page: number; onPage(value: number): void; onOpen(playerId: string): void; selectedPlayer: PlayerDetail | null }>): React.JSX.Element {
  return <><GameAppCard title="Players explorer" description="Searches display name, player ID, and account ID. Filters, sorting, and pagination are applied server-side; the table is not capped at the first 100 players."><ExplorerControls search={search} onSearch={onSearch} placeholder="Display name, player ID, or account ID" /><SortControls sort={sort} onSort={onSort} direction={direction} onDirection={onDirection} options={["quantity", "activeGameplaySeconds", "level", "lastActiveAt", "displayName", "gold"]} /><PlayerFilterControls filters={filters} onFilter={onFilter} /><div className="market-table-scroll"><table className="economy-observatory-table"><thead><tr><th>Player</th><th>Last Active</th><th>Connected</th><th>Active Gameplay</th><th>Level</th><th>Kingdom / City</th><th>Gold</th><th>Fungible</th><th>Qty</th><th>Unique</th><th>Backpacks</th><th>Resources</th><th>Open</th></tr></thead><tbody>{players?.players.map((player) => <tr key={player.playerId}><th scope="row">{player.displayName}<small>{player.playerId}<br />{player.accountId ?? "no account"}</small></th><td>{formatDate(player.lastActiveAt)}</td><td>{formatSeconds(player.connectedSeconds)}</td><td>{formatSeconds(player.activeGameplaySeconds)}</td><td>{player.level ?? "—"}</td><td>{player.kingdom ?? "—"} / {player.city ?? "—"}</td><td>{formatQuantity(player.gold)}</td><td>{player.fungibleItemCount}</td><td>{formatQuantity(player.quantity)}</td><td>{player.uniqueAssetCount}</td><td>{player.backpackCount}</td><td>{player.distinctResourceCount}</td><td><button type="button" onClick={() => onOpen(player.playerId)}>Inspect</button></td></tr>)}</tbody></table></div><Pagination pagination={players?.pagination} page={page} onPage={onPage} /></GameAppCard>{selectedPlayer ? <PlayerDetailSection detail={selectedPlayer} /> : null}</>;
}

function ItemDetailSection({ detail, filters, onFilter, page, onPage }: Readonly<{ detail: ItemDetail; filters: HolderFilters; onFilter<K extends keyof HolderFilters>(key: K, value: HolderFilters[K]): void; page: number; onPage(value: number): void }>): React.JSX.Element {
  return <GameAppCard title={detail.item ? `${detail.item.displayName} · holders` : "Item detail"} description={detail.report ? `Current ${formatQuantity(detail.report.endingExistingSupply)} · 24h net ${formatQuantity(detail.report.netChange ?? "—")} · labels expose raw evidence and gates.` : "No item data."}>{detail.report ? <><HolderFilterControls filters={filters} onFilter={onFilter} /><SortControls sort={filters.sort} onSort={(value) => onFilter("sort", value)} direction={filters.direction} onDirection={(value) => onFilter("direction", value)} options={["currentQuantity", "grossAcquired", "grossOutflow", "netChange", "percentile", "activeGameplaySeconds", "displayName"]} /><div className="market-table-scroll"><table className="economy-observatory-table"><thead><tr><th>Metric</th><th>Value</th><th>Metric</th><th>Value</th></tr></thead><tbody><tr><th>Player-controlled</th><td>{formatQuantity(detail.report.playerControlledEndingSupply)}</td><th>Organization</th><td>{formatQuantity(detail.report.organizationSupply)}</td></tr><tr><th>World available</th><td>{formatQuantity(detail.report.worldAvailableSupply)}</td><th>Committed/future</th><td>{formatQuantity(detail.report.committedFutureSupply)}</td></tr><tr><th>Acquired / outflow</th><td>{formatQuantity(detail.report.grossInflow)} / {formatQuantity(detail.report.grossOutflow)}</td><th>HHI / Gini</th><td>{detail.report.hhi.toFixed(3)} / {detail.report.gini?.toFixed(3) ?? "—"}</td></tr><tr><th>Labels</th><td colSpan={3}>{detail.report.labels.map((label) => `${label.label}${label.gated ? " (gated)" : ""}: ${label.reasons.join("; ")}`).join(" · ")}</td></tr></tbody></table><table className="economy-observatory-table"><thead><tr><th>Player</th><th>Current</th><th>Start</th><th>Acquired</th><th>Outflow</th><th>Net</th><th>% Supply</th><th>Active h</th><th>Level</th><th>Kingdom</th><th>Custody</th></tr></thead><tbody>{detail.holders.map((holder) => <tr key={holder.playerId}><th scope="row">{holder.displayName}<small>{holder.playerId}</small></th><td>{formatQuantity(holder.currentQuantity)}</td><td>{formatQuantity(holder.startingQuantity ?? "—")}</td><td>{formatQuantity(holder.grossAcquired)}</td><td>{formatQuantity(holder.grossOutflow)}</td><td>{formatQuantity(holder.netChange ?? "—")}</td><td>{formatPercent(holder.shareOfPlayerControlledSupply)}</td><td>{(holder.activeGameplaySeconds / 3600).toFixed(1)}</td><td>{holder.level ?? "—"}</td><td>{holder.kingdom ?? "—"}</td><td>{Object.entries(holder.custodyBreakdown).map(([key, value]) => `${key}:${value}`).join(", ")}</td></tr>)}</tbody></table></div><Pagination pagination={detail.pagination} page={page} onPage={onPage} /></> : <p role="status">No current holders; this may be a zero-supply catalog item.</p>}</GameAppCard>;
}

function PlayerDetailSection({ detail }: Readonly<{ detail: PlayerDetail }>): React.JSX.Element {
  const player = detail.player;
  return <GameAppCard title={player ? `${player.displayName} · economic profile` : "Player detail"} description={player ? `${player.playerId} · ${player.accountId ?? "no account ID"} · level ${player.level ?? "—"} · ${player.kingdom ?? "no kingdom"} / ${player.city ?? "no city"}` : "Player not found."}>{player ? <><p>{formatSeconds(player.connectedSeconds)} connected · {formatSeconds(player.activeGameplaySeconds)} active gameplay · {formatQuantity(player.gold)} gold · {player.accountAgeDays?.toFixed(1) ?? "—"} account age days.</p><div className="market-table-scroll"><table className="economy-observatory-table"><thead><tr><th>Custody</th><th>Rows</th><th>Quantity</th></tr></thead><tbody>{Object.entries(detail.custody).map(([bucket, rows]) => <tr key={bucket}><th scope="row">{bucket}</th><td>{rows.length}</td><td>{formatQuantity(rows.reduce((sum, row) => sum + BigInt(row.quantity), 0n).toString())}</td></tr>)}<tr><th scope="row">committed/future</th><td>{detail.future.length}</td><td>{formatQuantity(detail.future.reduce((sum, row) => sum + BigInt(row.quantity), 0n).toString())}</td></tr><tr><th scope="row">unique equipment</th><td>{detail.uniqueAssets.length}</td><td>{detail.uniqueAssets.length}</td></tr></tbody></table><table className="economy-observatory-table"><thead><tr><th>Item</th><th>Custody</th><th>Start</th><th>End</th><th>Acquired</th><th>Outflow</th><th>Net</th><th>Active pctl</th><th>Holder pctl</th><th>Share</th><th>Active mean/median</th><th>Holder mean/median</th></tr></thead><tbody>{detail.itemRows.map((row) => <tr key={`${row.itemId}:${row.variant}`}><th scope="row">{row.itemName}<small>{row.itemId}</small></th><td>{Object.entries(row.custodyBreakdown).map(([key, value]) => `${key}:${value}`).join(", ") || "—"}</td><td>{formatQuantity(row.startingQuantity ?? "—")}</td><td>{formatQuantity(row.endingQuantity)}</td><td>{formatQuantity(row.grossAcquired)}</td><td>{formatQuantity(row.grossOutflow)}</td><td>{formatQuantity(row.netChange ?? "—")}</td><td>{formatPercent(row.activePlayerPercentile ?? row.endingPercentile)}</td><td>{formatPercent(row.holderPercentile)}</td><td>{formatPercent(row.shareOfPlayerControlledSupply)}</td><td>{formatQuantity(String(row.activePlayerMean ?? "—"))} / {formatQuantity(String(row.activePlayerMedian ?? "—"))}</td><td>{formatQuantity(String(row.holderMean ?? "—"))} / {formatQuantity(String(row.holderMedian ?? "—"))}</td></tr>)}</tbody></table><details><summary>Recent economy events ({detail.events.length})</summary><ul>{detail.events.map((event) => <li key={event.eventId}>{formatDate(event.occurredAt)} · {event.eventKind} {event.leg} · {event.assetId} × {event.quantity} · {event.reason}</li>)}</ul></details></div></> : <p role="status">No player data.</p>}</GameAppCard>;
}

function FlowSection({ flow }: Readonly<{ flow: Flow | null }>): React.JSX.Element {
  return <GameAppCard title="Source / sink / transform flow" description="Transforms are included in gross in/out; transfers remain visible and must net to zero globally."><div className="market-table-scroll"><table className="economy-observatory-table"><thead><tr><th>Asset</th><th>Gross in</th><th>Gross out</th><th>Net</th><th>External</th><th>Sink</th><th>Transform in/out</th><th>Transfer in/out</th></tr></thead><tbody>{flow?.flow.map((row) => <tr key={`${String(row.assetId)}:${String(row.variant)}`}><th scope="row">{String(row.assetId)}</th><td>{formatQuantity(String(row.grossIn))}</td><td>{formatQuantity(String(row.grossOut))}</td><td>{formatQuantity(String(row.net))}</td><td>{formatQuantity(String(row.sourceIn))}</td><td>{formatQuantity(String(row.sinkOut))}</td><td>{formatQuantity(String(row.transformIn))} / {formatQuantity(String(row.transformOut))}</td><td>{formatQuantity(String(row.transferIn))} / {formatQuantity(String(row.transferOut))}</td></tr>)}</tbody></table></div></GameAppCard>;
}

function ExplorerControls({ search, onSearch, placeholder = "Search" }: Readonly<{ search: string; onSearch(value: string): void; placeholder?: string }>): React.JSX.Element {
  return <label>Search <input type="search" value={search} placeholder={placeholder} onChange={(event) => onSearch(event.currentTarget.value)} /></label>;
}

function PlayerFilterControls({ filters, onFilter }: Readonly<{ filters: PlayerFilters; onFilter<K extends keyof PlayerFilters>(key: K, value: PlayerFilters[K]): void }>): React.JSX.Element {
  return <fieldset><legend>Player filters</legend><label><input type="checkbox" checked={filters.activeOnly} onChange={(event) => onFilter("activeOnly", event.currentTarget.checked)} /> Active gameplay only</label><label>Last active within (hours)<input type="number" min="0" step="1" value={filters.lastActiveHours} onChange={(event) => onFilter("lastActiveHours", event.currentTarget.value)} /></label><label>Active gameplay min (hours)<input type="number" min="0" step="1" value={filters.activeGameplayHoursMin} onChange={(event) => onFilter("activeGameplayHoursMin", event.currentTarget.value)} /></label><label>Active gameplay max (hours)<input type="number" min="0" step="1" value={filters.activeGameplayHoursMax} onChange={(event) => onFilter("activeGameplayHoursMax", event.currentTarget.value)} /></label><label>Level min<input type="number" min="0" max={CURRENT_LEVEL_CAP} step="1" value={filters.levelMin} onChange={(event) => onFilter("levelMin", event.currentTarget.value)} /></label><label>Level max<input type="number" min="0" max={CURRENT_LEVEL_CAP} step="1" value={filters.levelMax} onChange={(event) => onFilter("levelMax", event.currentTarget.value)} /></label><label>Kingdom<input type="search" value={filters.kingdom} onChange={(event) => onFilter("kingdom", event.currentTarget.value)} /></label><label>City<input type="search" value={filters.city} onChange={(event) => onFilter("city", event.currentTarget.value)} /></label><label>Account age<select value={filters.accountAgeCohort} onChange={(event) => onFilter("accountAgeCohort", event.currentTarget.value as AccountAgeCohort)}><option value="">All</option><option value="&lt;7d">&lt;7 days</option><option value="7-30d">7–30 days</option><option value="30+d">30+ days</option><option value="unknown">Unknown</option></select></label></fieldset>;
}

function HolderFilterControls({ filters, onFilter }: Readonly<{ filters: HolderFilters; onFilter<K extends keyof HolderFilters>(key: K, value: HolderFilters[K]): void }>): React.JSX.Element {
  return <fieldset><legend>Holder filters</legend><ExplorerControls search={filters.search} onSearch={(value) => onFilter("search", value)} placeholder="Player name or ID" /><label><input type="checkbox" checked={filters.activeOnly} onChange={(event) => onFilter("activeOnly", event.currentTarget.checked)} /> Active players only</label><label>Level min<input type="number" min="0" max={CURRENT_LEVEL_CAP} step="1" value={filters.levelMin} onChange={(event) => onFilter("levelMin", event.currentTarget.value)} /></label><label>Level max<input type="number" min="0" max={CURRENT_LEVEL_CAP} step="1" value={filters.levelMax} onChange={(event) => onFilter("levelMax", event.currentTarget.value)} /></label><label>Kingdom<input type="search" value={filters.kingdom} onChange={(event) => onFilter("kingdom", event.currentTarget.value)} /></label><label>Playtime cohort<select value={filters.activityCohort} onChange={(event) => onFilter("activityCohort", event.currentTarget.value)}><option value="">All</option><option value="&lt;15m">&lt;15 min</option><option value="15-60m">15–60 min</option><option value="1-3h">1–3 hours</option><option value="3+h">3+ hours</option></select></label><label>Account age<select value={filters.accountAgeCohort} onChange={(event) => onFilter("accountAgeCohort", event.currentTarget.value as AccountAgeCohort)}><option value="">All</option><option value="&lt;7d">&lt;7 days</option><option value="7-30d">7–30 days</option><option value="30+d">30+ days</option><option value="unknown">Unknown</option></select></label></fieldset>;
}

function SortControls({ sort, onSort, direction, onDirection, options }: Readonly<{ sort: string; onSort(value: string): void; direction: "asc" | "desc"; onDirection(value: "asc" | "desc"): void; options: readonly string[] }>): React.JSX.Element {
  return <span><label>Sort <select aria-label="Sort results" value={sort} onChange={(event) => onSort(event.currentTarget.value)}>{options.map((option) => <option key={option} value={option}>{option.replaceAll(/([A-Z])/g, " $1")}</option>)}</select></label><label>Order <select aria-label="Sort direction" value={direction} onChange={(event) => onDirection(event.currentTarget.value as "asc" | "desc")}><option value="desc">Descending</option><option value="asc">Ascending</option></select></label></span>;
}

function Pagination({ pagination, page, onPage }: Readonly<{ pagination?: Pagination | undefined; page: number; onPage(value: number): void }>): React.JSX.Element {
  if (!pagination || pagination.total === 0) return <p role="status">No rows match the current filters.</p>;
  return <nav aria-label="Economy results pagination"><button type="button" disabled={page <= 1} onClick={() => onPage(Math.max(1, page - 1))}>Previous</button><span> Page {pagination.page} · {pagination.total.toLocaleString()} total </span><button type="button" disabled={!pagination.hasNext} onClick={() => onPage(page + 1)}>Next</button></nav>;
}

async function getJson<T>(base: string, path: string, params: Record<string, string | number | boolean>, signal: AbortSignal): Promise<T> {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) throw new Error(`Economy request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function addOptionalParams(params: Record<string, string | number | boolean>, values: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(values)) if (value.trim() !== "") params[key] = value;
}

function formatQuantity(value: string): string { try { return BigInt(value).toLocaleString(); } catch { return value; } }
function formatSeconds(value: number): string { return Number.isFinite(value) ? `${(value / 3600).toFixed(1)}h` : "—"; }
function formatDate(value: string | null): string { return value ? new Date(value).toLocaleString() : "—"; }
function formatPercent(value: number | null): string { return value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`; }
