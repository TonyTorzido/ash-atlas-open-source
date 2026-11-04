import { WORLD_ENVIRONMENT_OVERLAY_DEFINITION } from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import manifest from "../assets/world-environment-overlays/manifest.json" with { type: "json" };
import subdivisions from "../assets/world-environment-overlays/north-america-administrative-subdivisions.json" with { type: "json" };
import zoneLookupProvenance from "../assets/world-environment-overlays/world-zone-lookup-v1.provenance.json" with { type: "json" };
import {
  createDefaultWorldEnvironmentOverlaySelections,
  installWorldEnvironmentOverlays,
  setAllWorldEnvironmentOverlayCategories,
  setWorldEnvironmentOverlayCategory,
  WORLD_ADMINISTRATIVE_SUBDIVISION_LAYER_ID,
  WORLD_ENVIRONMENT_OVERLAY_BORDER_LAYER_ID,
  WORLD_ENVIRONMENT_OVERLAY_GROUPS
} from "./worldEnvironmentOverlays.js";

describe("World Map environmental overlay manifest", () => {
  it("contains the exact ordered V1 groups, labels, source identity, and generated assets", () => {
    expect(WORLD_ENVIRONMENT_OVERLAY_DEFINITION.worldEnvironmentOverlayVersion).toBe(1);
    expect(WORLD_ENVIRONMENT_OVERLAY_GROUPS.map((group) => group.label)).toEqual([
      "Biomes", "Elevation", "Terrain", "Ocean Depth", "Water"
    ]);
    expect(WORLD_ENVIRONMENT_OVERLAY_GROUPS.map((group) =>
      group.categories.map((category) => category.label)
    )).toEqual([
      [
        "Jungle", "Pinewild", "Greenwood", "Frostwood", "Plains", "Savanna", "Marsh",
        "Highmeadow", "Scrubland", "Badlands", "Steppe", "Tundra", "Frozen Waste"
      ],
      ["Low", "Moderate", "High", "Alpine", "Summit"],
      ["Flat", "Hilly / Rolling", "Mountainous / Rugged"],
      ["Nearshore / Coastal", "Shallow", "Deep", "Abyssal"],
      ["Rivers", "Lakes"]
    ]);
    expect(manifest.assets).toHaveLength(27);
    expect(manifest.assets.map((asset) => `${asset.groupId}:${asset.categoryId}`)).toEqual(
      WORLD_ENVIRONMENT_OVERLAY_GROUPS.flatMap((group) =>
        group.categories.map((category) => `${group.id}:${category.id}`)
      )
    );
    expect(manifest.projection).toBe("EPSG:3857");
    expect(manifest.width).toBe(2048);
    expect(manifest.height).toBe(2048);
    expect(manifest.bounds).toEqual(WORLD_ENVIRONMENT_OVERLAY_DEFINITION.bounds);
    expect(manifest.sourceIdentity.pipelineSha).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.sourceIdentity.overlaySourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.sourceIdentity.waterSurfaceReleases).toEqual({
      rivers: {
        releaseId: "river-surface-v1",
        manifestSha256: "c605631193ff786e33182fb8b6d7cfa3ab868b35d0a47fec5e1aa717ace447d5"
      },
      lakes: {
        releaseId: "lake-surface-v1",
        manifestSha256: "d0c25c2b6a4e9349091a5f483a294fac7988cd098a1f77e354343cb2f27f42b9"
      }
    });
    for (const asset of manifest.assets) {
      const bytes = readFileSync(fileURLToPath(new URL(
        `../assets/world-environment-overlays/${asset.file}`,
        import.meta.url
      )));
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.fileSizeBytes).toBeGreaterThan(0);
      expect(bytes.byteLength).toBe(asset.fileSizeBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
      expect(asset.width).toBe(manifest.width);
      expect(asset.height).toBe(manifest.height);
    }
    const compositeBytes = readFileSync(fileURLToPath(new URL(
      `../assets/world-environment-overlays/${manifest.defaultEnvironmentComposite.file}`,
      import.meta.url
    )));
    expect(manifest.defaultEnvironmentComposite.categoryIds).toEqual(
      WORLD_ENVIRONMENT_OVERLAY_GROUPS[0]!.categories.map((category) => category.id)
    );
    expect(compositeBytes.byteLength).toBe(
      manifest.defaultEnvironmentComposite.fileSizeBytes
    );
    expect(createHash("sha256").update(compositeBytes).digest("hex")).toBe(
      manifest.defaultEnvironmentComposite.sha256
    );
    expect(manifest.defaultEnvironmentTextureMemoryEstimateBytes).toBe(2048 * 2048 * 4);
    expect(manifest.waterGuideTextureMemoryEstimateBytesPerAsset).toBe(2048 * 2048 * 4);
    expect(manifest.waterGuidePairTextureMemoryEstimateBytes).toBe(2 * 2048 * 2048 * 4);
    expect(manifest.audit.water.outputCanvas).toEqual({
      width: 2048,
      height: 2048,
      projection: "EPSG:3857"
    });
    expect(manifest.audit.water.sourceCellSizeM).toBe(125);
    expect(manifest.audit.water.authorities.rivers.releaseId).toBe("river-surface-v1");
    expect(manifest.audit.water.authorities.lakes.releaseId).toBe("lake-surface-v1");
    const subdivisionBytes = readFileSync(fileURLToPath(new URL(
      `../assets/world-environment-overlays/${subdivisions.file}`,
      import.meta.url
    )));
    expect(subdivisions.featureCounts).toEqual({ CAN: 13, MEX: 32, USA: 51 });
    expect(subdivisions.projection).toBe(manifest.projection);
    expect(subdivisions.bounds).toEqual(manifest.bounds);
    expect(subdivisions.format).toBe("PMTiles raster PNG");
    expect(subdivisions.tileSize).toBeLessThanOrEqual(256);
    expect(subdivisions.maxZoom).toBe(5);
    expect(subdivisionBytes.subarray(0, 7).toString()).toBe("PMTiles");
    expect(subdivisionBytes.byteLength).toBe(subdivisions.fileSizeBytes);
    expect(createHash("sha256").update(subdivisionBytes).digest("hex")).toBe(subdivisions.sha256);
  });

  it("was cooked from the World pipeline and releases the runtime lock pins", () => {
    // Regenerate the overlays and zone lookup (tools/world-map/README.md) whenever this fails.
    const lock = JSON.parse(readFileSync(fileURLToPath(new URL(
      "../../../../config/world-runtime.lock.json",
      import.meta.url
    )), "utf8")) as {
      pipeline: { sha: string };
      release: { release_id: string; profile_set_fingerprint: string; build_contract_fingerprint: string };
      river_surface: { release_id: string; manifest_sha256: string };
      lake_surface: { release_id: string; manifest_sha256: string };
    };
    expect(manifest.sourceIdentity).toMatchObject({
      pipelineSha: lock.pipeline.sha,
      worldReleaseId: lock.release.release_id,
      profileSetFingerprint: lock.release.profile_set_fingerprint,
      buildContractFingerprint: lock.release.build_contract_fingerprint,
      waterSurfaceReleases: {
        rivers: { releaseId: lock.river_surface.release_id, manifestSha256: lock.river_surface.manifest_sha256 },
        lakes: { releaseId: lock.lake_surface.release_id, manifestSha256: lock.lake_surface.manifest_sha256 }
      }
    });
    const lookupBytes = readFileSync(fileURLToPath(new URL(
      `../assets/world-environment-overlays/${zoneLookupProvenance.file}`,
      import.meta.url
    )));
    expect(zoneLookupProvenance.pipelineSha).toBe(lock.pipeline.sha);
    expect(lookupBytes.byteLength).toBe(zoneLookupProvenance.fileSizeBytes);
    expect(createHash("sha256").update(lookupBytes).digest("hex")).toBe(zoneLookupProvenance.sha256);
    expect(lookupBytes.subarray(0, 4).toString()).toBe("AAZL");
    expect(lookupBytes.readUInt16LE(4)).toBe(zoneLookupProvenance.formatVersion);
  });

  it("supports independent categories, select all, and clear all without losing other groups", () => {
    const defaults = createDefaultWorldEnvironmentOverlaySelections();
    const withoutTundra = setWorldEnvironmentOverlayCategory(
      defaults, "environment", "tundra", false
    );
    expect(withoutTundra.environment).not.toContain("tundra");
    expect(withoutTundra.elevation).toEqual(defaults.elevation);
    const clearElevation = setAllWorldEnvironmentOverlayCategories(
      withoutTundra, "elevation", false
    );
    expect(clearElevation.elevation).toEqual([]);
    const selectElevation = setAllWorldEnvironmentOverlayCategories(
      clearElevation, "elevation", true
    );
    expect(selectElevation.elevation).toEqual(["low", "moderate", "high", "extreme", "summit"]);
    expect(selectElevation.environment).not.toContain("tundra");
    expect(defaults.water).toEqual(["rivers", "lakes"]);
  });
});

describe("World Map environmental overlay MapLibre presenter", () => {
  it("keeps only the default composite or explicitly selected textures resident", () => {
    const harness = createMapHarness();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const presenter = installWorldEnvironmentOverlays(harness.map, vi.fn());
    presenter.sync(null, []);
    expect(harness.addSource).toHaveBeenCalledTimes(1);
    expect(harness.addLayer).toHaveBeenCalledTimes(1);
    expect(harness.addSource).toHaveBeenCalledWith(
      "world-map-administrative-subdivisions-source",
      expect.objectContaining({
        type: "raster",
        url: expect.stringMatching(/^pmtiles:/),
        tileSize: 256,
        maxzoom: 5
      })
    );
    expect(harness.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: WORLD_ADMINISTRATIVE_SUBDIVISION_LAYER_ID }),
      WORLD_ENVIRONMENT_OVERLAY_BORDER_LAYER_ID
    );

    presenter.sync("environment", WORLD_ENVIRONMENT_OVERLAY_GROUPS[0]!.categories.map(
      (category) => category.id
    ));
    expect(harness.addSource).toHaveBeenCalledTimes(2);
    expect(harness.addLayer).toHaveBeenCalledTimes(2);
    expect(harness.addLayer.mock.calls.slice(1).every((call) =>
      call[1] === WORLD_ADMINISTRATIVE_SUBDIVISION_LAYER_ID
    )).toBe(true);

    presenter.sync("environment", ["jungle", "tundra"]);
    expect(harness.addSource).toHaveBeenCalledTimes(4);
    expect([...harness.sources.keys()].filter((id) => id.includes("world-environment-overlay")))
      .toEqual(expect.arrayContaining([
        "world-environment-overlay-source--environment:jungle",
        "world-environment-overlay-source--environment:tundra"
      ]));
    presenter.sync("environment", ["tundra", "frozen_waste"]);
    expect(harness.addSource).toHaveBeenCalledTimes(5);
    expect(harness.sources.has(
      "world-environment-overlay-source--environment:jungle"
    )).toBe(false);
    expect(harness.sources.has(
      "world-environment-overlay-source--environment:frozen_waste"
    )).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    presenter.sync("elevation", ["low", "high"]);
    expect([...harness.layers.keys()].filter((id) => id !== WORLD_ADMINISTRATIVE_SUBDIVISION_LAYER_ID)
      .every((id) => id.includes("elevation"))).toBe(true);
    expect([...harness.sources.keys()].filter((id) => id !== "world-map-administrative-subdivisions-source")
      .every((id) => id.includes("elevation"))).toBe(true);
    expect(harness.addSource).toHaveBeenCalledTimes(7);

    presenter.sync("water", ["rivers", "lakes"]);
    expect(harness.addSource).toHaveBeenCalledTimes(9);
    expect([...harness.sources.keys()]).toEqual(expect.arrayContaining([
      "world-environment-overlay-source--water:rivers",
      "world-environment-overlay-source--water:lakes"
    ]));
    presenter.sync("water", ["rivers"]);
    expect(harness.sources.has("world-environment-overlay-source--water:lakes")).toBe(false);
    expect(harness.sources.has("world-environment-overlay-source--water:rivers")).toBe(true);
    presenter.destroy();
    expect(harness.sources.size).toBe(0);
    expect(harness.layers.size).toBe(0);
    fetchSpy.mockRestore();
  });

  it("reports one non-blocking error for a failed category source", () => {
    const harness = createMapHarness();
    const error = vi.fn();
    const presenter = installWorldEnvironmentOverlays(harness.map, error);
    presenter.sync("terrain", ["flat"]);
    const handler = harness.handlers.get("error");
    handler?.({ sourceId: "world-environment-overlay-source--terrain:flat" });
    handler?.({ sourceId: "world-environment-overlay-source--terrain:flat" });
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("Flat");
    presenter.destroy();
  });
});

function createMapHarness() {
  const sources = new Map<string, object>();
  const layers = new Map<string, object>();
  const handlers = new Map<string, (event: { sourceId?: string }) => void>();
  const addSource = vi.fn((id: string, source: object) => sources.set(id, source));
  const addLayer = vi.fn((layer: { id: string }, beforeId?: string) => {
    layers.set(layer.id, { ...layer, beforeId });
  });
  const map = {
    addSource,
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => sources.delete(id),
    addLayer,
    getLayer: (id: string) => layers.get(id),
    removeLayer: (id: string) => layers.delete(id),
    on: (event: string, handler: (value: { sourceId?: string }) => void) => handlers.set(event, handler),
    off: (event: string) => handlers.delete(event)
  } as unknown as maplibregl.Map;
  return { map, sources, layers, handlers, addSource, addLayer };
}
