import type {
  PopulationPreparationProgress
} from "./populationZoneProjection.js";
import {
  usePopulationPreparationVisibility
} from "./usePopulationPreparationVisibility.js";

export function PopulationPreparationNotice({
  progress,
  onStale,
  recovering,
  activityRevision
}: {
  progress: PopulationPreparationProgress;
  onStale(progress: PopulationPreparationProgress): void;
  recovering: boolean;
  activityRevision: number;
}) {
  const visible = usePopulationPreparationVisibility(
    progress,
    onStale,
    activityRevision
  );
  const percent = Math.min(
    100,
    Math.round(progress.completed / Math.max(1, progress.total) * 100)
  );
  const copy = populationPreparationCopy(progress.reason);

  if (recovering) {
    return (
      <div className="population-preparation-status" role="status">
        Refreshing the nearby world&hellip;
      </div>
    );
  }

  if (visible) {
    return (
      <div className="population-preparation-status" role="status">
        <span>
          <strong>{copy.label}</strong>
          <output>{percent}%</output>
        </span>
        <div
          className="population-preparation-progress"
          role="progressbar"
          aria-label={copy.ariaLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <i style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }

  return null;
}

export function populationPreparationCopy(
  reason: PopulationPreparationProgress["reason"]
): Readonly<{ label: string; ariaLabel: string }> {
  switch (reason) {
    case "durable-rehydration":
      return {
        label: "Restoring nearby wildlife…",
        ariaLabel: "Restoring nearby wildlife"
      };
    case "simulation-activation":
      return {
        label: "Waking nearby wildlife…",
        ariaLabel: "Waking nearby wildlife"
      };
    case "generation-expired":
    case "replacement-required":
      return {
        label: "Refreshing local wildlife…",
        ariaLabel: "Refreshing local wildlife"
      };
    case "backpressure-retry":
      return {
        label: "World activity is busy; retrying…",
        ariaLabel: "World activity is busy; retrying"
      };
    case "guarded-materialization":
      return {
        label: "Checking local wildlife compatibility…",
        ariaLabel: "Checking local wildlife compatibility"
      };
    case "unsupported-kind-isolated":
      return {
        label: "Loading supported nearby wildlife…",
        ariaLabel: "Loading supported nearby wildlife"
      };
    case "plan-terminal-failure":
      return {
        label: "Destination wildlife is unavailable",
        ariaLabel: "Destination wildlife is unavailable"
      };
    case "initial-world-generation":
    case "generation-missing":
    case "plan-pending":
    case "ready":
    case "stale-authority":
    case "cancelled":
    case null:
      return {
        label: "Preparing the wilds…",
        ariaLabel: "Preparing the wilds"
      };
  }
}
