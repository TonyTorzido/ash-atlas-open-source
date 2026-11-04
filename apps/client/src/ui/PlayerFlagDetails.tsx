import { useEffect, useState } from "react";
import type { FlagEnvironmentDetails } from "@ash-atlas/shared";

import { fetchFlagEnvironment } from "../flags/flagEnvironment.js";
import {
  coastlineDistance,
  ecologyStatus,
  elevation,
  formatDate,
  formatDistance,
  geographicCity,
  gameplayCity,
  insideMappedCity,
  majorLakeSummary,
  mapDataFallback,
  namedRiverSummary,
  nearestWaterSummary,
  oceanDepth,
  present,
  readable,
  sourceText,
  surfaceClassification,
  textOrMapFallback,
  type DisplayValue
} from "../flags/flagEnvironmentDisplay.js";
import { flagInteractionDisplayName } from "../flags/flagDisplay.js";
import { useModalBehavior } from "./useModalBehavior.js";

type PlayerFlagDetailsProps = {
  flagId: string;
  flagName: string;
  serverHttpBase: string;
  onClose(): void;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; details: FlagEnvironmentDetails }
  | { status: "error"; message: string };

export function PlayerFlagDetails({
  flagId,
  flagName,
  serverHttpBase,
  onClose
}: PlayerFlagDetailsProps): React.JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const dialogRef = useModalBehavior<HTMLElement>({ open: true, onClose });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void fetchFlagEnvironment(serverHttpBase, flagId, { signal: controller.signal })
      .then((details) => setState({ status: "ready", details }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Map data could not be determined at this location."
        });
      });
    return () => controller.abort();
  }, [attempt, flagId, serverHttpBase]);

  return (
    <div className="advanced-flag-scrim player-flag-scrim" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside ref={dialogRef} className="advanced-flag-drawer player-flag-drawer" role="dialog" aria-modal="true" aria-labelledby="player-flag-title" tabIndex={-1}>
        <header className="advanced-flag-header player-flag-header">
          <div>
            <span className="advanced-flag-eyebrow">Player flag details</span>
            <h2 id="player-flag-title">{flagName}</h2>
          </div>
          <button type="button" className="menu-text-close" onClick={onClose} aria-label="Close player flag details">Close</button>
        </header>
        {state.status === "loading" ? <Loading label="Loading flag details…" /> : null}
        {state.status === "error" ? (
          <div className="advanced-flag-state advanced-flag-error" role="alert">
            <strong>Could not load details</strong><span>{state.message}</span>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
          </div>
        ) : null}
        {state.status === "ready" ? <PlayerDetailsContent details={state.details} /> : null}
      </aside>
    </div>
  );
}

export function PlayerDetailsContent({ details }: { details: FlagEnvironmentDetails }): React.JSX.Element {
  const quality = dataQualityMessages(details);
  return (
    <div className="player-flag-content">
      <section className="player-detail-card player-overview-card">
        <h3>Overview</h3>
        <div className="player-owner-line">
          <span className="owner-color-dot" style={{ backgroundColor: details.identity.ownerColor ?? "#d83a3a" }} aria-hidden="true" />
          <strong>{flagInteractionDisplayName({ ownerUsername: details.identity.ownerName })}</strong>
          <span>by {details.identity.ownerName ?? "Owner name was not recorded"}</span>
        </div>
        <PlayerField label="Created" value={present(formatDate(details.identity.createdAt))} />
        <PlayerField label="Claim radius" value={present(formatDistance(details.identity.claimRadiusM) ?? "0 m")} />
        <PlayerField label="Player city" value={gameplayCity(details)} />
      </section>

      <section className="player-detail-card">
        <h3>Location</h3>
        <PlayerField label="Country" value={administrativeValue(details.administrative.countryName, "Country boundary data could not be determined here")} />
        <PlayerField label="Region" value={administrativeValue(details.administrative.regionName, "Regional boundary data could not be determined here")} />
        <PlayerField label="Geographic city" value={geographicCity(details)} />
        <PlayerField label="City boundary" value={insideMappedCity(details)} />
      </section>

      <section className="player-detail-card">
        <h3>Terrain</h3>
        <PlayerField label="Elevation" value={elevation(details)} />
        <PlayerField label="Terrain" value={details.terrain.isSaltwater ? present("Open water") : textOrMapFallback(readable(details.terrain.terrainClass))} />
        <PlayerField label="Land cover" value={details.terrain.isSaltwater ? present("Open saltwater") : textOrMapFallback(readable(details.terrain.landCoverClass))} />
        <PlayerField label="Surface" value={surfaceClassification(details)} />
        <PlayerField label="Coastal" value={coastalStatus(details)} />
        <PlayerField label="Coastline" value={coastlineDistance(details)} />
      </section>

      <section className="player-detail-card">
        <h3>Ecology</h3>
        <div className={`player-status-badge semantic-${ecologyStatus(details).kind}`}>{ecologyStatus(details).text}</div>
        {details.ecology.biomeName ? <PlayerField label="Biome" value={sourceText(details.ecology.biomeName, "Biome is not classified in this map source")} /> : null}
        {details.ecology.ecoregionName ? <PlayerField label="Ecoregion" value={sourceText(details.ecology.ecoregionName, "Ecoregion is not classified in this map source")} /> : null}
      </section>

      <section className="player-detail-card">
        <h3>Nearby Water</h3>
        <PlayerField label="Nearest water" value={nearestWaterSummary(details)} />
        <PlayerField label="Named river" value={namedRiverSummary(details)} />
        <PlayerField label="Major lake" value={majorLakeSummary(details)} />
        {details.terrain.isSaltwater === true ? <PlayerField label="Ocean depth" value={oceanDepth(details)} /> : null}
      </section>

      {quality.length > 0 ? (
        <section className="player-detail-card player-quality-card">
          <h3>Data Quality</h3>
          <ul>{quality.map((message) => <li key={message}>{message}</li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}

function PlayerField({ label, value, copyValue }: { label: string; value: DisplayValue; copyValue?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="player-detail-field">
      <span>{label}</span>
      <strong className={`semantic-${value.kind}`}>{value.text}</strong>
      {copyValue ? <button type="button" onClick={() => { void navigator.clipboard?.writeText(copyValue); setCopied(true); window.setTimeout(() => setCopied(false), 1_000); }}>{copied ? "Copied" : "Copy"}</button> : null}
    </div>
  );
}

function Loading({ label }: { label: string }): React.JSX.Element {
  return <div className="advanced-flag-state" role="status"><span className="advanced-flag-spinner" aria-hidden="true" />{label}</div>;
}

function administrativeValue(value: string | null, missingMessage: string): DisplayValue {
  return sourceText(value, missingMessage);
}

function coastalStatus(details: FlagEnvironmentDetails): DisplayValue {
  if (details.terrain.isCoastal === true) return present("Within the mapped coastal threshold");
  if (details.terrain.isCoastal === false) return present("Outside the mapped coastal threshold");
  return mapDataFallback();
}

function dataQualityMessages(details: FlagEnvironmentDetails): string[] {
  const messages: string[] = [];
  if (details.ecology.resolution === "nearest_land_fallback") messages.push("Ecology was estimated from nearby mapped land.");
  if (details.provenance.snapshotStatus === "legacy") messages.push("This flag uses an older stored world snapshot.");
  if (details.provenance.snapshotStatus === "stale") messages.push("Stored environment details are out of date and should be refreshed.");
  if (details.provenance.snapshotStatus === "incomplete") messages.push("This stored world snapshot is incomplete.");
  if (details.provenance.snapshotStatus === "unavailable") messages.push("No stored world snapshot is available for this flag.");
  if (details.terrain.landCoverConflict === true) messages.push("Map sources disagree about the surface at this location.");
  if (details.provenance.snapshotStatus === "legacy" && !details.water.supportingRiver.id) messages.push("Some detailed hydrology fields require a refreshed snapshot.");
  return messages;
}
