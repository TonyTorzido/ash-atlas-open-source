import type { CollectibleNode } from "@ash-atlas/shared";

import type { RenderState } from "../map/mapObjects.js";
import type { PixiGameOverlay } from "../map/pixiOverlay.js";
import {
  removePopulationCollectible,
  type PopulationZoneProjectionState
} from "../population/populationZoneProjection.js";
import type { HarvestTask } from "./harvest.js";
import {
  WorldResourcePresentationStore,
  type WorldResourceRemovalReason
} from "./worldResourcePresentationStore.js";

type RefCell<T> = { current: T };

export function removeCollectiblesFromPresentation(options: Readonly<{
  removals: Iterable<Readonly<{
    nodeId: string;
    stateRevision: number | undefined;
    domain?: "population" | "repeatable-resource" | "resource-vision";
    reason?: WorldResourceRemovalReason;
  }>>;
  renderStateRef: RefCell<RenderState>;
  presentationStoreRef?: RefCell<WorldResourcePresentationStore>;
  populationZoneProjectionRef: RefCell<PopulationZoneProjectionState>;
  harvestTaskRef: RefCell<HarvestTask | null>;
  selectedCollectibleIdRef: RefCell<string | null>;
  overlayRef: RefCell<PixiGameOverlay | null>;
  setCollectibles(nodes: CollectibleNode[]): void;
  setSelectedCollectibleId(nodeId: string | null): void;
  settleHarvestAfterAuthoritativeRemoval(nodeId: string): void;
  clearOptimisticResinPresentation(nodeId?: string): void;
}>): ReadonlySet<string> {
  const removals = [...options.removals];
  const revisions = new Map<string, number | undefined>();
  for (const removal of removals) {
    revisions.set(removal.nodeId, removal.stateRevision);
  }
  if (revisions.size === 0) return new Set();

  if (
    options.harvestTaskRef.current &&
    revisions.has(options.harvestTaskRef.current.nodeId)
  ) {
    options.settleHarvestAfterAuthoritativeRemoval(
      options.harvestTaskRef.current.nodeId
    );
  }
  for (const nodeId of revisions.keys()) {
    options.clearOptimisticResinPresentation(nodeId);
  }
  for (const removal of removals) {
    if (removal.domain && removal.domain !== "population") continue;
    options.populationZoneProjectionRef.current = removePopulationCollectible(
      options.populationZoneProjectionRef.current,
      removal.nodeId,
      removal.stateRevision
    );
  }

  const presentationStore = options.presentationStoreRef?.current
    ?? new WorldResourcePresentationStore(
      options.renderStateRef.current.collectibles
    );
  const collectibles = presentationStore.removeBatch(removals.map((removal) => ({
    nodeId: removal.nodeId,
    ...(removal.stateRevision === undefined
      ? {}
      : { stateRevision: removal.stateRevision }),
    ...(removal.domain ? { domain: removal.domain } : {}),
    reason: removal.reason ?? "explicit-server-removal"
  })));
  const clearsSelection = options.selectedCollectibleIdRef.current !== null &&
    revisions.has(options.selectedCollectibleIdRef.current);
  if (clearsSelection) {
    options.selectedCollectibleIdRef.current = null;
    options.setSelectedCollectibleId(null);
  }
  options.renderStateRef.current = {
    ...options.renderStateRef.current,
    collectibles,
    selectedCollectibleId: clearsSelection
      ? null
      : options.renderStateRef.current.selectedCollectibleId
  };
  options.setCollectibles(collectibles);
  options.overlayRef.current?.update(options.renderStateRef.current);
  return new Set(revisions.keys());
}
