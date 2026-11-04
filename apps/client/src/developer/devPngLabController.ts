import {
  clampRuntimePngMasterScale,
  RUNTIME_PNG_PRESENTATION_CATALOG
} from "@ash-atlas/shared";

import { registeredDevPngAssets } from "./devPngCatalogRegistry.js";
import type { DevPngIntrinsicSize } from "./devPngSizing.js";
import { setWorldPngMasterScalePreview } from "../map/worldPngMasterScale.js";

export const DEV_PNG_MIN_MULTIPLIER = 0.01;
export const DEV_PNG_MAX_MULTIPLIER = 5;
export const DEV_PNG_MULTIPLIER_STEP = 0.01;

export type DevPngPlacement = Readonly<{
  id: string;
  assetId: string;
  longitude: number;
  latitude: number;
  scaleMultiplier: number;
}>;

export type DevPngImageFailure = Readonly<{
  url: string;
  sourcePath: string;
  message: string;
}>;

export type DevPngLabState = Readonly<{
  masterScale: number;
  selectedAssetId: string | null;
  selectedPlacementId: string | null;
  placementMode: boolean;
  nextMultiplier: number;
  placements: readonly DevPngPlacement[];
  intrinsicSizes: Readonly<Record<string, DevPngIntrinsicSize>>;
  imageFailures: Readonly<Record<string, DevPngImageFailure>>;
  status: string;
}>;

export class DevPngLabController {
  private state: DevPngLabState = initialState();
  private readonly listeners = new Set<() => void>();
  private fallbackId = 0;

  readonly getSnapshot = (): DevPngLabState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  selectAsset(assetId: string): void {
    if (!registeredDevPngAssets().some(({ id }) => id === assetId)) return;
    this.update({
      ...this.state,
      selectedAssetId: assetId,
      selectedPlacementId: null
    });
  }

  selectPlacement(placementId: string | null): void {
    const placement = this.state.placements.find(({ id }) => id === placementId);
    this.update({
      ...this.state,
      selectedPlacementId: placement?.id ?? null,
      selectedAssetId: placement?.assetId ?? this.state.selectedAssetId
    });
  }

  setNextMultiplier(value: number): number {
    const multiplier = clampDevPngMultiplier(value);
    this.update({ ...this.state, nextMultiplier: multiplier });
    return multiplier;
  }

  setMasterScale(value: number): number {
    const masterScale = clampRuntimePngMasterScale(value);
    setWorldPngMasterScalePreview(masterScale);
    this.update({
      ...this.state,
      masterScale,
      status: `World PNG Master Scale preview is ${masterScale.toFixed(2)}×.`
    });
    return masterScale;
  }

  resetMasterScale(): void {
    setWorldPngMasterScalePreview(null);
    this.update({
      ...this.state,
      masterScale: RUNTIME_PNG_PRESENTATION_CATALOG.masterScale,
      status: `World PNG Master Scale reset to official ${RUNTIME_PNG_PRESENTATION_CATALOG.masterScale.toFixed(2)}×.`
    });
  }

  setSelectedMultiplier(value: number): number {
    const multiplier = clampDevPngMultiplier(value);
    const selected = this.selectedPlacement();
    if (!selected) return multiplier;
    this.update({
      ...this.state,
      placements: this.state.placements.map((placement) =>
        placement.id === selected.id
          ? { ...placement, scaleMultiplier: multiplier }
          : placement
      )
    });
    return multiplier;
  }

  useSelectedSizeForNewCopies(): void {
    const selected = this.selectedPlacement();
    if (!selected) return;
    this.update({
      ...this.state,
      nextMultiplier: selected.scaleMultiplier,
      status: `New ${assetLabel(selected.assetId)} copies will use ${selected.scaleMultiplier.toFixed(2)}×.`
    });
  }

  registerIntrinsicSize(assetId: string, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const current = this.state.intrinsicSizes[assetId];
    if (current?.width === width && current.height === height) return;
    this.update({
      ...this.state,
      intrinsicSizes: { ...this.state.intrinsicSizes, [assetId]: { width, height } }
    });
  }

  reportImageFailure(placementId: string, failure: DevPngImageFailure): void {
    if (!this.state.placements.some(({ id }) => id === placementId)) return;
    const current = this.state.imageFailures[placementId];
    if (current?.url === failure.url && current.sourcePath === failure.sourcePath &&
        current.message === failure.message) return;
    this.update({
      ...this.state,
      imageFailures: { ...this.state.imageFailures, [placementId]: failure }
    });
  }

  clearImageFailure(placementId: string): void {
    if (!this.state.imageFailures[placementId]) return;
    const imageFailures = { ...this.state.imageFailures };
    delete imageFailures[placementId];
    this.update({ ...this.state, imageFailures });
  }

  startPlacement(): boolean {
    const asset = registeredDevPngAssets().find(({ id }) => id === this.state.selectedAssetId);
    if (!asset?.placeable) return false;
    this.update({
      ...this.state,
      placementMode: true,
      selectedPlacementId: null,
      status: `Placing ${asset.label} at ${this.state.nextMultiplier.toFixed(2)}×.`
    });
    return true;
  }

  stopPlacement(): void {
    if (!this.state.placementMode) return;
    this.update({
      ...this.state,
      placementMode: false,
      status: "PNG placement mode stopped."
    });
  }

  place(longitude: number, latitude: number): DevPngPlacement | null {
    const asset = registeredDevPngAssets().find(({ id }) => id === this.state.selectedAssetId);
    if (!asset?.placeable || !Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      return null;
    }
    const placement: DevPngPlacement = {
      id: this.localId(),
      assetId: asset.id,
      longitude,
      latitude,
      scaleMultiplier: this.state.nextMultiplier
    };
    this.update({
      ...this.state,
      placements: [...this.state.placements, placement],
      selectedPlacementId: placement.id,
      status: `Placed ${asset.label} locally. Placement mode remains active.`
    });
    return placement;
  }

  placeAtPlayer(position: Readonly<{ longitude: number; latitude: number }> | null): DevPngPlacement | null {
    return position ? this.place(position.longitude, position.latitude) : null;
  }

  movePlacement(placementId: string, longitude: number, latitude: number): void {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
    const placement = this.state.placements.find(({ id }) => id === placementId);
    if (!placement) return;
    this.update({
      ...this.state,
      selectedAssetId: placement.assetId,
      selectedPlacementId: placement.id,
      placements: this.state.placements.map((entry) =>
        entry.id === placement.id ? { ...entry, longitude, latitude } : entry
      ),
      status: `Moved ${assetLabel(placement.assetId)} locally.`
    });
  }

  deleteSelected(): void {
    const selectedId = this.state.selectedPlacementId;
    if (!selectedId) return;
    const imageFailures = { ...this.state.imageFailures };
    delete imageFailures[selectedId];
    this.update({
      ...this.state,
      placements: this.state.placements.filter(({ id }) => id !== selectedId),
      imageFailures,
      selectedPlacementId: null,
      status: "Selected local PNG deleted."
    });
  }

  deletePlacement(placementId: string): void {
    this.selectPlacement(placementId);
    this.deleteSelected();
  }

  duplicateSelected(): DevPngPlacement | null {
    const selected = this.selectedPlacement();
    if (!selected) return null;
    const duplicate = { ...selected, id: this.localId() };
    this.update({
      ...this.state,
      placements: [...this.state.placements, duplicate],
      selectedPlacementId: duplicate.id,
      status: `Duplicated ${assetLabel(duplicate.assetId)} locally.`
    });
    return duplicate;
  }

  duplicatePlacement(placementId: string): DevPngPlacement | null {
    this.selectPlacement(placementId);
    return this.duplicateSelected();
  }

  clearSelectedAsset(): void {
    const assetId = this.state.selectedAssetId;
    if (!assetId) return;
    const retainedIds = new Set(
      this.state.placements
        .filter((placement) => placement.assetId !== assetId)
        .map(({ id }) => id)
    );
    this.update({
      ...this.state,
      placements: this.state.placements.filter((placement) => retainedIds.has(placement.id)),
      imageFailures: Object.fromEntries(
        Object.entries(this.state.imageFailures).filter(([placementId]) =>
          retainedIds.has(placementId)
        )
      ),
      selectedPlacementId: null,
      status: `Cleared local ${assetLabel(assetId)} placements.`
    });
  }

  clearAll(): void {
    this.update({
      ...this.state,
      placements: [],
      imageFailures: {},
      selectedPlacementId: null,
      placementMode: false,
      status: "All local PNG placements cleared."
    });
  }

  reset(): void {
    setWorldPngMasterScalePreview(null);
    this.state = initialState();
    this.emit();
  }

  selectedPlacement(): DevPngPlacement | null {
    return this.state.placements.find(({ id }) => id === this.state.selectedPlacementId) ?? null;
  }

  private localId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `dev-png-${crypto.randomUUID()}`;
    }
    this.fallbackId += 1;
    return `dev-png-${Date.now()}-${this.fallbackId}`;
  }

  private update(next: DevPngLabState): void {
    this.state = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function clampDevPngMultiplier(value: number): number {
  const finite = Number.isFinite(value) ? value : 1;
  const clamped = Math.min(DEV_PNG_MAX_MULTIPLIER, Math.max(DEV_PNG_MIN_MULTIPLIER, finite));
  return Math.round(clamped / DEV_PNG_MULTIPLIER_STEP) * DEV_PNG_MULTIPLIER_STEP;
}

export function consumeDevPngMapClick(
  controller: DevPngLabController,
  longitude: number,
  latitude: number
): boolean {
  if (!controller.getSnapshot().placementMode) return false;
  controller.place(longitude, latitude);
  return true;
}

function assetLabel(assetId: string): string {
  return registeredDevPngAssets().find(({ id }) => id === assetId)?.label ?? "PNG";
}

function initialState(): DevPngLabState {
  return {
    masterScale: RUNTIME_PNG_PRESENTATION_CATALOG.masterScale,
    selectedAssetId: registeredDevPngAssets().find(({ placeable }) => placeable)?.id ?? null,
    selectedPlacementId: null,
    placementMode: false,
    nextMultiplier: 1,
    placements: [],
    intrinsicSizes: {},
    imageFailures: {},
    status: "PNG Lab ready."
  };
}
