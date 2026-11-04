import { useEffect, useState } from "react";

import {
  populationPreparationCheckpointKey,
  type PopulationPreparationProgress
} from "./populationZoneProjection.js";

export const POPULATION_PREPARATION_VISIBILITY_DELAY_MS = 180;
export const POPULATION_PREPARATION_STALE_MS = 15_000;

export function usePopulationPreparationVisibility(
  progress: PopulationPreparationProgress,
  onStale?: (progress: PopulationPreparationProgress) => void,
  activityRevision = 0
): boolean {
  const [visible, setVisible] = useState(false);
  const pending = progress.status === "pending"
    && progress.total > 0
    && progress.completed < progress.total
    && progress.operation?.requiredForGameplay === true
    && progress.operation.scope === "required-visible";
  const checkpointKey = populationPreparationCheckpointKey(progress);
  useEffect(() => {
    if (!pending) {
      setVisible(false);
      return;
    }
    const visibilityTimer = window.setTimeout(
      () => setVisible(true),
      POPULATION_PREPARATION_VISIBILITY_DELAY_MS
    );
    const staleTimer = window.setTimeout(() => {
      setVisible(false);
      onStale?.(progress);
    }, POPULATION_PREPARATION_STALE_MS);
    return () => {
      window.clearTimeout(visibilityTimer);
      window.clearTimeout(staleTimer);
    };
  }, [activityRevision, checkpointKey, onStale, pending]);
  return visible;
}
