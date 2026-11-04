import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { FlagEnvironmentDetails, FlagEnvironmentDiagnostics } from "@ash-atlas/shared";

import {
  fetchFlagEnvironmentDiagnostics,
  refreshFlagEnvironments,
  type FlagEnvironmentRefreshReport
} from "../flags/flagEnvironment.js";
import {
  coastlineDistance,
  crossSourceConflict,
  ecologyFallback,
  ecologyStatus,
  elevation,
  formatBoolean,
  formatDate,
  formatDistance,
  geographicCity,
  gameplayCity,
  majorLakeSummary,
  namedRiverSummary,
  nearestWaterSummary,
  oceanDepth,
  present,
  readable,
  searchComplete,
  semantic,
  sourceText,
  type DisplayValue
} from "../flags/flagEnvironmentDisplay.js";
import { useModalBehavior } from "./useModalBehavior.js";
import { GameConfirmationPrompt } from "./GameActionPrompt.js";

type DeveloperFlagDiagnosticsProps = {
  developerAccessEnabled: boolean;
  flagId: string;
  flagName: string;
  serverHttpBase: string;
  csrfToken: string;
  onRefreshed(): void;
  onClose(): void;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; diagnostics: FlagEnvironmentDiagnostics }
  | { status: "error"; message: string };

export function DeveloperFlagDiagnostics({
  developerAccessEnabled,
  flagId,
  flagName,
  serverHttpBase,
  csrfToken,
  onRefreshed,
  onClose
}: DeveloperFlagDiagnosticsProps): React.JSX.Element | null {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [action, setAction] = useState<{ status: "idle" | "running" | "done" | "error"; message?: string; report?: FlagEnvironmentRefreshReport }>({ status: "idle" });
  const [confirmRefreshAll, setConfirmRefreshAll] = useState(false);
  const dialogRef = useModalBehavior<HTMLElement>({ open: developerAccessEnabled, onClose });

  useEffect(() => {
    if (!developerAccessEnabled) {
      setConfirmRefreshAll(false);
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    void fetchFlagEnvironmentDiagnostics(serverHttpBase, flagId, { signal: controller.signal })
      .then((diagnostics) => setState({ status: "ready", diagnostics }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: error instanceof Error ? error.message : "Developer diagnostics are unavailable." });
      });
    return () => controller.abort();
  }, [attempt, developerAccessEnabled, flagId, serverHttpBase]);

  const refresh = async (all: boolean): Promise<void> => {
    setAction({ status: "running", message: all ? "Refreshing eligible snapshots…" : "Refreshing stored snapshot…" });
    try {
      const report = await refreshFlagEnvironments(
        serverHttpBase,
        csrfToken,
        all ? { all: true, limit: 100, onlyNeedsRefresh: true } : { flagId }
      );
      setAction({ status: report.failures.length ? "error" : "done", report, message: `${report.refreshed} of ${report.requested} snapshots refreshed.` });
      onRefreshed();
      setAttempt((value) => value + 1);
    } catch (error) {
      setAction({ status: "error", message: error instanceof Error ? error.message : "Snapshot refresh failed." });
    }
  };

  if (!developerAccessEnabled) return null;
  return <>
    <div className="advanced-flag-scrim developer-flag-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside ref={dialogRef} className="advanced-flag-drawer developer-flag-drawer" role="dialog" aria-modal="true" aria-labelledby="developer-flag-title" tabIndex={-1}>
        <header className="advanced-flag-header developer-flag-header">
          <div><span className="advanced-flag-eyebrow">Developer flag diagnostics</span><h2 id="developer-flag-title">{flagName}</h2></div>
          <button type="button" className="menu-text-close" onClick={onClose} aria-label="Close developer flag diagnostics">Close</button>
        </header>
        <div className="developer-diagnostics-toolbar" aria-label="Diagnostic controls">
          <button type="button" onClick={() => setAttempt((value) => value + 1)} disabled={state.status === "loading"}>Run Live Lookup</button>
          <button type="button" onClick={() => void refresh(false)} disabled={action.status === "running"}>Refresh Stored Snapshot</button>
          <button type="button" onClick={() => setConfirmRefreshAll(true)} disabled={action.status === "running"}>Refresh All Legacy/Incomplete</button>
          {state.status === "ready" ? <button type="button" onClick={() => void copyJson(state.diagnostics)}>Copy Diagnostics JSON</button> : null}
          {state.status === "ready" ? <button type="button" onClick={() => exportJson(flagName, state.diagnostics)}>Export JSON</button> : null}
        </div>
        {action.status !== "idle" ? (
          <div className={`diagnostic-action-status diagnostic-action-${action.status}`} role="status">
            <strong>{action.message}</strong>
            {action.report?.truncated ? <span>More eligible flags remain; run the bounded operation again.</span> : null}
            {action.report?.failures.length ? <ul>{action.report.failures.map((failure) => <li key={failure.flagId}>{failure.flagId}: {failure.error}</li>)}</ul> : null}
          </div>
        ) : null}
        {state.status === "loading" ? <div className="advanced-flag-state" role="status"><span className="advanced-flag-spinner" aria-hidden="true" />Running authoritative live lookup…</div> : null}
        {state.status === "error" ? <div className="advanced-flag-state advanced-flag-error" role="alert"><strong>Diagnostics unavailable</strong><span>{state.message}</span><button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button></div> : null}
        {state.status === "ready" ? <DeveloperDiagnosticsContent diagnostics={state.diagnostics} /> : null}
      </aside>
    </div>
    {confirmRefreshAll ? <GameConfirmationPrompt
      title="Refresh all legacy, stale, incomplete, or unavailable flag snapshots?"
      detail="This operation is bounded to 100 flags."
      confirmLabel="Refresh Eligible Snapshots"
      destructive
      onCancel={() => setConfirmRefreshAll(false)}
      onConfirm={() => {
        setConfirmRefreshAll(false);
        void refresh(true);
      }}
    /> : null}
  </>;
}

export function DeveloperDiagnosticsContent({ diagnostics }: { diagnostics: FlagEnvironmentDiagnostics }): React.JSX.Element {
  const stored = diagnostics.stored;
  const live = diagnostics.live.details;
  return (
    <div className="developer-diagnostics-content">
      <DiagnosticSection title="Snapshot Summary" defaultOpen>
        <DiagnosticField label="Stored status" value={snapshotLabel(stored)} />
        <DiagnosticField label="Status reason" value={stored.provenance.snapshotStatusReason} />
        <DiagnosticField label="Snapshot updated" value={formatDate(stored.provenance.snapshotUpdatedAt)} />
        <DiagnosticField label="Stored environment schema" value={stored.provenance.environmentSchemaVersion ?? legacyValue(stored, "Not recorded")} mono />
        <DiagnosticField label="Expected current schema" value={diagnostics.required.environmentSchemaVersion} mono />
        <DiagnosticField label="Stored world release" value={stored.provenance.worldReleaseId} mono />
        <DiagnosticField label="Required world release" value={diagnostics.required.worldReleaseId} mono />
        <DiagnosticField label="Refresh recommended" value={diagnostics.refreshRecommended ? "Yes" : "No"} {...(diagnostics.refreshRecommended ? { tone: "warning" as const } : {})} />
        <DiagnosticField label="Live lookup duration" value={`${diagnostics.live.durationMs.toFixed(1)} ms`} />
        <DiagnosticField label="Package cache" value={diagnostics.live.packageCacheState ?? "Not returned"} />
      </DiagnosticSection>

      <DiagnosticSection title="Stored Snapshot" defaultOpen>
        <DiagnosticDetails details={stored} context="stored" />
      </DiagnosticSection>

      <DiagnosticSection title="Current Live Lookup" defaultOpen>
        <DiagnosticField label="Lookup started" value={formatDate(diagnostics.live.lookupStartedAt)} />
        <DiagnosticField label="Lookup status" value={live.provenance.snapshotStatusReason} />
        <DiagnosticDetails details={live} context="live" />
      </DiagnosticSection>

      <DiagnosticSection title={`Stored versus Live Diff (${diagnostics.comparison.length})`} defaultOpen>
        {diagnostics.comparison.length ? (
          <div className="diagnostic-diff-list">
            {diagnostics.comparison.map((difference) => (
              <div className={`diagnostic-diff diagnostic-diff-${difference.kind}`} key={difference.path}>
                <strong>{difference.label}</strong><span>{displayJsonValue(difference.stored)}</span><span aria-hidden="true">→</span><span>{displayJsonValue(difference.live)}</span>
              </div>
            ))}
          </div>
        ) : <p className="advanced-no-warnings">No meaningful normalized differences detected.</p>}
      </DiagnosticSection>

      <DiagnosticSection title="Raw Data">
        <RawJson title="Stored database environment_snapshot" value={stored.rawSnapshot} />
        <RawJson title="Normalized stored details" value={stored} />
        <RawJson title="Current live World API lookup" value={diagnostics.live.rawLookup} />
        <RawJson title="Stored-versus-live diff" value={diagnostics.comparison} />
      </DiagnosticSection>
    </div>
  );
}

function DiagnosticDetails({ details, context }: { details: FlagEnvironmentDetails; context: "stored" | "live" }): React.JSX.Element {
  const legacy = details.provenance.snapshotStatus === "legacy";
  const legacyMissing = context === "stored" && legacy ? "Not recorded in legacy snapshot" : "Unable to determine";
  return (
    <div className="diagnostic-detail-groups">
      <DiagnosticGroup title="Administrative Geography">
        <DiagnosticField label="Country" value={joined(details.administrative.countryName, details.administrative.countryCode)} />
        <DiagnosticField label="Country ID" value={details.administrative.countryId} mono copy />
        <DiagnosticField label="Region" value={joined(details.administrative.regionName, details.administrative.regionCode)} />
        <DiagnosticField label="Region ID" value={details.administrative.regionId} mono copy />
        <DiagnosticField label="Geographic city" value={geographicCity(details)} />
        <DiagnosticField label="Geographic City ID" value={details.administrative.cityId} mono copy />
        <DiagnosticField label="Inside geographic city" value={formatBoolean(details.administrative.insideCity)} />
        <DiagnosticField label="City-boundary distance" value={formatDistance(details.administrative.cityBoundaryDistanceM)} />
        <DiagnosticField label="Gameplay Associated City ID" value={details.identity.cityId ?? "None — flag is not associated with a player-founded city"} mono={Boolean(details.identity.cityId)} copy={Boolean(details.identity.cityId)} />
        <DiagnosticField label="Gameplay city" value={details.identity.cityName ?? gameplayCity(details).text} />
      </DiagnosticGroup>

      <DiagnosticGroup title="Terrain and Land Cover">
        <DiagnosticField label="Elevation" value={elevation(details)} />
        <DiagnosticField label="Terrain class" value={readable(details.terrain.terrainClass)} />
        <DiagnosticField label="Authoritative land" value={formatBoolean(details.terrain.isLand)} />
        <DiagnosticField label="Saltwater" value={formatBoolean(details.terrain.isSaltwater)} />
        <DiagnosticField label="Coastal" value={formatBoolean(details.terrain.isCoastal)} />
        <DiagnosticField label="Coastline distance" value={coastlineDistance(details)} />
        <DiagnosticField label="Coastline technical distance" value={details.terrain.coastlineDistanceM == null ? "null" : `${details.terrain.coastlineDistanceM} m`} mono />
        <DiagnosticField label="Coastline search radius" value={details.terrain.coastlineSearchRadiusM == null ? legacyMissing : formatDistance(details.terrain.coastlineSearchRadiusM)} />
        <DiagnosticField label="Coastline search complete" value={searchComplete(details.terrain.coastlineSearchComplete, legacy)} />
        <DiagnosticField label="Coastal threshold" value={details.terrain.coastalThresholdM == null ? legacyMissing : formatDistance(details.terrain.coastalThresholdM)} />
        <DiagnosticField label="Land-cover class" value={readable(details.terrain.landCoverClass)} />
        <DiagnosticField label="Source land-cover code" value={details.terrain.sourceLandCoverCode?.toString() ?? legacyMissing} mono />
        <DiagnosticField label="Cross-source conflict" value={crossSourceConflict(details)} {...(details.terrain.landCoverConflict ? { tone: "warning" as const } : {})} />
        {details.terrain.landCoverConflict ? <p className="diagnostic-explanation">Authoritative OSM land conflicts with ESA inland-water classification.</p> : null}
      </DiagnosticGroup>

      <DiagnosticGroup title="Ecology">
        <DiagnosticField label="Biome" value={details.ecology.biomeName} />
        <DiagnosticField label="Biome explanation" value={sourceText(details.ecology.biomeName, "Biome is not classified in this map source")} />
        <DiagnosticField label="Biome ID" value={details.ecology.biomeId} mono copy />
        <DiagnosticField label="Ecoregion" value={details.ecology.ecoregionName} />
        <DiagnosticField label="Ecoregion explanation" value={sourceText(details.ecology.ecoregionName, "Ecoregion is not classified in this map source")} />
        <DiagnosticField label="Ecoregion ID" value={details.ecology.ecoregionId} mono copy />
        <DiagnosticField label="Exact versus inferred" value={ecologyStatus(details)} />
        <DiagnosticField label="Resolution" value={readable(details.ecology.resolution)} mono />
        <DiagnosticField label="Polygon distance" value={details.ecology.distanceM == null ? legacyMissing : formatDistance(details.ecology.distanceM)} />
        <DiagnosticField label="Ecology source package" value={details.ecology.sourcePackageId ?? legacyMissing} mono copy={Boolean(details.ecology.sourcePackageId)} />
        <DiagnosticField label="Fallback maximum" value={ecologyFallback(details)} />
        <DiagnosticField label="Search complete" value={searchComplete(details.ecology.searchComplete, legacy)} />
        <DiagnosticField label="Ecology explanation" value={ecologyStatus(details)} />
      </DiagnosticGroup>

      <DiagnosticGroup title="Water and Hydrology">
        <DiagnosticField label="Nearest-water explanation" value={nearestWaterSummary(details)} />
        <DiagnosticField label="Nearest source type" value={details.water.nearest.sourceType ?? legacyMissing} />
        <DiagnosticField label="Nearest source ID" value={details.water.nearest.sourceId ?? legacyMissing} mono copy={Boolean(details.water.nearest.sourceId)} />
        <DiagnosticField label="Nearest source name" value={details.water.nearest.sourceName ?? legacyMissing} />
        <DiagnosticField label="Fresh / salt / unknown" value={readable(details.water.nearest.kind) ?? legacyMissing} />
        <DiagnosticField label="Nearest distance" value={details.water.nearest.distanceM == null ? legacyMissing : formatDistance(details.water.nearest.distanceM)} />
        <DiagnosticField label="Nearest resolution" value={details.water.nearest.resolution ?? legacyMissing} mono />
        <DiagnosticField label="Nearest search radius" value={details.water.nearest.searchRadiusM == null ? legacyMissing : formatDistance(details.water.nearest.searchRadiusM)} />
        <DiagnosticField label="Nearest search complete" value={searchComplete(details.water.nearest.searchComplete, legacy)} />
        <DiagnosticField label="Named-river explanation" value={namedRiverSummary(details)} />
        <DiagnosticField label="Named river" value={details.water.namedRiver.name ?? "null"} />
        <DiagnosticField label="Named river ID" value={details.water.namedRiver.id ?? legacyMissing} mono copy={Boolean(details.water.namedRiver.id)} />
        <DiagnosticField label="River class" value={details.water.namedRiver.riverClass ?? legacyMissing} />
        <DiagnosticField label="Named river distance" value={details.water.namedRiver.distanceM == null ? legacyMissing : formatDistance(details.water.namedRiver.distanceM)} />
        <DiagnosticField label="Named-river search radius" value={details.water.namedRiver.searchRadiusM == null ? legacyMissing : formatDistance(details.water.namedRiver.searchRadiusM)} />
        <DiagnosticField label="Named-river search complete" value={searchComplete(details.water.namedRiver.searchComplete, legacy)} />
        <DiagnosticField label="HydroRIVERS ID" value={details.water.supportingRiver.id ?? (legacy ? "Not recorded — run live lookup or refresh snapshot" : "No supporting waterway found")} mono copy={Boolean(details.water.supportingRiver.id)} />
        <DiagnosticField label="Flow order" value={details.water.supportingRiver.flowOrder?.toString() ?? legacyMissing} />
        <DiagnosticField label="Discharge" value={details.water.supportingRiver.dischargeCms == null ? legacyMissing : `${details.water.supportingRiver.dischargeCms} m³/s`} />
        <DiagnosticField label="Drainage area" value={details.water.supportingRiver.drainageAreaSqKm == null ? legacyMissing : `${details.water.supportingRiver.drainageAreaSqKm} km²`} />
        <DiagnosticField label="HydroRIVERS distance" value={details.water.supportingRiver.distanceM == null ? legacyMissing : formatDistance(details.water.supportingRiver.distanceM)} />
        <DiagnosticField label="HydroRIVERS search radius" value={details.water.supportingRiver.searchRadiusM == null ? legacyMissing : formatDistance(details.water.supportingRiver.searchRadiusM)} />
        <DiagnosticField label="HydroRIVERS search complete" value={searchComplete(details.water.supportingRiver.searchComplete, legacy)} />
        <DiagnosticField label="Major-lake explanation" value={majorLakeSummary(details)} />
        <DiagnosticField label="Major lake" value={details.water.majorLake.name ?? "null"} />
        <DiagnosticField label="Major lake ID" value={details.water.majorLake.id ?? legacyMissing} mono copy={Boolean(details.water.majorLake.id)} />
        <DiagnosticField label="Inside major lake" value={formatBoolean(details.water.majorLake.inside) ?? legacyMissing} />
        <DiagnosticField label="Major lake distance" value={details.water.majorLake.distanceM == null ? legacyMissing : formatDistance(details.water.majorLake.distanceM)} />
        <DiagnosticField label="Major-lake search radius" value={details.water.majorLake.searchRadiusM == null ? legacyMissing : formatDistance(details.water.majorLake.searchRadiusM)} />
        <DiagnosticField label="Major-lake search complete" value={searchComplete(details.water.majorLake.searchComplete, legacy)} />
        <DiagnosticField label="Ocean-depth class" value={readable(details.water.oceanDepthClass) ?? legacyMissing} />
        <DiagnosticField label="Ocean-depth explanation" value={oceanDepth(details)} />
      </DiagnosticGroup>

      <DiagnosticGroup title="Territory and Ownership">
        <DiagnosticField label="Flag ID" value={details.identity.flagId} mono copy />
        <DiagnosticField label="Flag name" value={details.identity.flagName} />
        <DiagnosticField label="Owner ID" value={details.identity.ownerId} mono copy />
        <DiagnosticField label="Owner name" value={details.identity.ownerName} />
        <DiagnosticField label="Owner color" value={details.identity.ownerColor} mono copy />
        <DiagnosticField label="Claim radius" value={formatDistance(details.identity.claimRadiusM)} />
        <DiagnosticField label="Created" value={formatDate(details.identity.createdAt)} />
      </DiagnosticGroup>

      <DiagnosticGroup title="World Release and Provenance">
        <DiagnosticField label="Environment schema" value={details.provenance.environmentSchemaVersion ?? legacyMissing} mono />
        <DiagnosticField label="World release ID" value={details.provenance.worldReleaseId} mono copy />
        <DiagnosticField label="Package ID" value={details.coordinates.packageId} mono copy />
        <DiagnosticField label="Profile-set fingerprint" value={details.provenance.profileSetFingerprint} mono copy />
        <DiagnosticField label="Build-contract fingerprint" value={details.provenance.buildContractFingerprint} mono copy />
        <DiagnosticField label="Boundary release ID" value={details.provenance.boundaryReleaseId} mono copy />
        <DiagnosticField label="Package count" value={details.provenance.packageCount?.toLocaleString() ?? legacyMissing} />
        {Object.entries(details.provenance.sourceVersions).map(([source, version]) => <DiagnosticField key={source} label={`Source · ${readable(source)}`} value={version} mono />)}
        <DiagnosticField label="Derived tags" value={details.provenance.derivedTags.length ? details.provenance.derivedTags.join(", ") : "None"} />
        <DiagnosticField label="Warnings" value={details.provenance.warnings.length ? details.provenance.warnings.join(" · ") : "None"} />
      </DiagnosticGroup>
    </div>
  );
}

function DiagnosticSection({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }): React.JSX.Element {
  return <details className="advanced-details-section diagnostic-section" open={defaultOpen}><summary>{title}</summary><div className="advanced-details-grid">{children}</div></details>;
}

function DiagnosticGroup({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return <section className="diagnostic-group"><h4>{title}</h4>{children}</section>;
}

function DiagnosticField({ label, value, mono = false, copy = false, tone }: { label: string; value: string | null | DisplayValue; mono?: boolean; copy?: boolean; tone?: "warning" }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const display = typeof value === "object" && value !== null ? value : value ? present(value) : semantic("unavailable", "Unable to determine");
  return <div className={`advanced-field${tone ? " advanced-field-warning" : ""}`}><span className="advanced-field-label">{label}</span><span className={`${mono ? "advanced-field-value mono" : "advanced-field-value"} semantic-${display.kind}`}>{display.text}</span>{copy && display.kind === "present" ? <button className="advanced-copy" type="button" onClick={() => { void navigator.clipboard?.writeText(display.text); setCopied(true); window.setTimeout(() => setCopied(false), 1_000); }}>{copied ? "Copied" : "Copy"}</button> : null}</div>;
}

function RawJson({ title, value }: { title: string; value: unknown }): React.JSX.Element {
  const json = useMemo(() => JSON.stringify(value, null, 2), [value]);
  return <details className="diagnostic-raw"><summary>{title}</summary><button type="button" onClick={() => void navigator.clipboard?.writeText(json)}>Copy JSON</button><pre className="advanced-raw-snapshot">{json}</pre></details>;
}

function snapshotLabel(details: FlagEnvironmentDetails): string {
  return details.provenance.snapshotStatus === "legacy"
    ? `${details.provenance.environmentSchemaVersion ?? "world-profile-v1"} (legacy)`
    : `${readable(details.provenance.snapshotStatus)} snapshot`;
}

function legacyValue(details: FlagEnvironmentDetails, fallback: string): string {
  return details.provenance.snapshotStatus === "legacy" ? "world-profile-v1 (legacy)" : fallback;
}

function joined(name: string | null, code: string | null): string | null {
  return name && code ? `${name} (${code})` : name ?? code;
}

function displayJsonValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

async function copyJson(value: unknown): Promise<void> {
  await navigator.clipboard?.writeText(JSON.stringify(value, null, 2));
}

function exportJson(flagName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${flagName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-diagnostics.json`;
  link.click();
  URL.revokeObjectURL(url);
}
