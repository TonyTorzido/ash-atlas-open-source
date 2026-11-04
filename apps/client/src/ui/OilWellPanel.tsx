import {
  OIL_WELL_UNIT_INTERVAL_MS,
  type OilWellSnapshot
} from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { DestinationShell } from "./DestinationShell.js";
import { ItemArtwork } from "./ItemArtwork.js";

export type OilWellProductionPresentation = Readonly<{
  full: boolean;
  progress: number;
  timerLabel: string;
}>;

export function oilWellProductionPresentation(
  well: OilWellSnapshot,
  nowMs: number
): OilWellProductionPresentation {
  if (well.storedCrudeOil >= well.capacity) {
    return { full: true, progress: 1, timerLabel: "Storage Full" };
  }
  const nextUnitAtMs = well.nextUnitAt ? Date.parse(well.nextUnitAt) : Number.NaN;
  if (!Number.isFinite(nextUnitAtMs)) {
    return { full: false, progress: 0, timerLabel: "Production starting" };
  }
  const remainingMs = Math.max(0, nextUnitAtMs - nowMs);
  const remainingSeconds = Math.ceil(remainingMs / 1_000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return {
    full: false,
    progress: Math.max(0, Math.min(1, 1 - remainingMs / OIL_WELL_UNIT_INTERVAL_MS)),
    timerLabel: `Next unit in ${minutes}:${seconds.toString().padStart(2, "0")}`
  };
}

export function OilWellPanel({
  open,
  well,
  feedback,
  busy,
  online,
  layout,
  onHarvest,
  onDestroy,
  onClose
}: {
  open: boolean;
  well: OilWellSnapshot | null;
  feedback: string | null;
  busy: boolean;
  online: boolean;
  layout: "desktop" | "phone";
  onHarvest(): void;
  onDestroy(): void;
  onClose(): void;
}): React.JSX.Element | null {
  const [authoritativeNowMs, setAuthoritativeNowMs] = useState(
    well?.serverTime ?? Date.now()
  );
  const [managementOpen, setManagementOpen] = useState(false);
  useEffect(() => {
    if (!well) return;
    const receivedAtMs = Date.now();
    setAuthoritativeNowMs(well.serverTime);
    if (!open || !well.nextUnitAt || well.storedCrudeOil >= well.capacity) return;
    const timer = window.setInterval(() => {
      setAuthoritativeNowMs(well.serverTime + Date.now() - receivedAtMs);
    }, 250);
    return () => window.clearInterval(timer);
  }, [open, well?.capacity, well?.nextUnitAt, well?.serverTime, well?.storedCrudeOil]);
  useEffect(() => {
    setManagementOpen(false);
  }, [open, well?.structureId]);
  if (!well) return null;
  const production = oilWellProductionPresentation(well, authoritativeNowMs);
  const harvestLabel = busy
    ? "Harvesting..."
    : well.storedCrudeOil > 0
      ? `Harvest ${well.storedCrudeOil} Crude Oil`
      : "No Crude Oil Available";
  return (
    <DestinationShell
      open={open}
      title={`${well.ownerUsername}'s Oil Well`}
      subtitle={well.isOwner !== false
        ? `${well.accessMode === "public" ? "Public" : "Private"} · Change access in person at the Oil Well`
        : `Public harvest · ${well.tollGold ?? "0"} Gold per harvest`}
      closeLabel="Close Oil Well"
      className="oil-well-destination"
      layout={layout}
      onClose={onClose}
      footer={layout === "desktop" ? undefined : (
        <button type="button" className="oil-well-close" onClick={onClose}>
          Close
        </button>
      )}
    >
      <div className="oil-well-summary">
        <div className="oil-well-art"><ItemArtwork itemId="crude_oil" label="Crude Oil" /></div>
        <div>
          <span>Stored Crude Oil</span>
          <strong>{well.storedCrudeOil} / {well.capacity}</strong>
          <small>Produces {well.productionPerHour} per hour &middot; one unit every 6 minutes</small>
        </div>
      </div>
      <section className="oil-well-production" aria-label="Crude Oil production">
        <div className="oil-well-production-heading">
          <span>Next Crude Oil</span>
          <strong>{production.timerLabel}</strong>
        </div>
        <div
          className="oil-well-progress"
          role="progressbar"
          aria-label="Next Crude Oil production progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(production.progress * 100)}
        >
          <span style={{ width: `${production.progress * 100}%` }} />
        </div>
      </section>
      {feedback ? <p className="oil-well-feedback" role="status">{feedback}</p> : null}
      <div className="oil-well-actions">
        <button type="button" className="panel-action primary" disabled={!online || busy || !well.canHarvest} onClick={onHarvest}>
          {harvestLabel}
        </button>
      </div>
      {well.isOwner !== false ? <div className="oil-well-management">
        <button
          type="button"
          className="oil-well-options-toggle"
          aria-expanded={managementOpen}
          onClick={() => setManagementOpen((current) => !current)}
        >
          Well options
        </button>
        {managementOpen ? (
          <div className="oil-well-management-actions">
            <span>Permanent owner action</span>
            <button
              type="button"
              className="danger"
              disabled={!online || busy || !well.canDestroy}
              onClick={() => {
                setManagementOpen(false);
                onDestroy();
              }}
            >
              Destroy Oil Well
            </button>
          </div>
        ) : null}
      </div> : null}
    </DestinationShell>
  );
}
