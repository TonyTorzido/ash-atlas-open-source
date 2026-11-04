import type { EquipmentDefinitionId, PlayerAppearanceSnapshot } from "@ash-atlas/shared";
import { PERSONAL_FLAG_COLOR_HEX, territoryStructureVisual } from "@ash-atlas/shared";
import {
  PixiTextureCache,
  PlayerRenderer,
  loadPixiTexture,
  type GatherActionKind,
  type GatherFishPhase,
  type GatherSide
} from "@ash-atlas/player-renderer";
import { playerAppearanceAssetUrl } from "@ash-atlas/player-renderer/asset-registry";
import { TERRITORY_ARTWORK_URLS } from "../map/flagArtwork.js";
import { flagBuildArtFromTextures, gatheringToolAssetKeyForDefinition } from "../players/gatheringPresentation.js";
import { jacketGatherInput } from "../players/jacketGather.js";
import { createJacketRig, type JacketRig } from "../players/jacketRig.js";
import { Application, Container, Graphics, Text, type Texture } from "pixi.js";
import { useEffect, useRef, useState } from "react";

/** Tool definition id (null = bare hands); the held art resolves through the appearance catalog. */
type PreviewRow = Readonly<{ label: string; kind: GatherActionKind; tool: string | null }>;

const PREVIEW_ROWS: readonly PreviewRow[] = [
  { label: "Chop · wooden hatchet", kind: "chop", tool: "wooden_axe" },
  { label: "Chop · stone hatchet", kind: "chop", tool: "stone_axe" },
  { label: "Mine · wooden pick", kind: "mine", tool: "wooden_pickaxe" },
  { label: "Mine · stone pick", kind: "mine", tool: "stone_pickaxe" },
  { label: "Fish · pole", kind: "fish", tool: "starter_fishing_pole" },
  { label: "Chop · bare hand", kind: "chop", tool: null },
  { label: "Mine · bare hands", kind: "mine", tool: null },
  { label: "Harvest", kind: "harvest", tool: null },
  { label: "Build flag", kind: "flag", tool: null }
];

/** Cloth colour per preview column (personal flag colours). */
const FLAG_CLOTH_COLORS = [
  PERSONAL_FLAG_COLOR_HEX.red,
  PERSONAL_FLAG_COLOR_HEX.blue,
  PERSONAL_FLAG_COLOR_HEX.gold,
  PERSONAL_FLAG_COLOR_HEX.purple
].map((hex) => Number.parseInt(hex.slice(1), 16));

/** Loads the active pack's Soft Flag art (pole + cloth) for the flag-building rows. */
async function loadFlagTextures(): Promise<ReadonlyMap<string, Texture>> {
  const assets = territoryStructureVisual("soft_flag").pieces.map((piece) => piece.asset);
  const loaded = await Promise.all(assets.map(async (asset) => {
    const url = TERRITORY_ARTWORK_URLS[asset];
    if (!url) return null;
    const texture = await loadPixiTexture(url);
    texture.source.scaleMode = "linear";
    return [asset, texture] as const;
  }));
  return new Map(loaded.filter((entry) => entry !== null));
}

const definition = (id: string): EquipmentDefinitionId => id as EquipmentDefinitionId;

function previewAppearance(variant: number): PlayerAppearanceSnapshot {
  const base = {
    schemaVersion: 1 as const,
    catalogRevision: 1,
    revision: variant + 1,
    bodyVariantId: "default" as const,
    poseId: "idle" as const,
    activeHand: "melee" as const
  };
  if (variant === 0) {
    return { ...base, slots: {}, styles: { hair: "soldier-crop-hair", legs: "black-pants" } };
  }
  if (variant === 1) {
    return {
      ...base,
      slots: {
        chest: { equipmentDefinitionId: definition("breast_plate"), appearanceId: "non-swag-breastplate", cosmeticAppearanceId: null },
        melee: { equipmentDefinitionId: definition("starter_sword"), appearanceId: "sword", cosmeticAppearanceId: null }
      },
      styles: { hair: "long-knight-hair", legs: "black-pants", skinToneId: "medium" }
    };
  }
  return {
    ...base,
    slots: {
      chest: { equipmentDefinitionId: definition("leather_armor"), appearanceId: "non-swag-leather", cosmeticAppearanceId: null },
      melee: { equipmentDefinitionId: definition("double_axe"), appearanceId: "double_axe", cosmeticAppearanceId: null }
    },
    styles: { hair: "braided-village-maiden", legs: "cloth-pants-brown", skinToneId: "dark" }
  };
}

const COLUMNS: readonly Readonly<{ side: GatherSide; variant: number }>[] = [
  { side: "right", variant: 0 },
  { side: "left", variant: 0 },
  { side: "right", variant: 1 },
  { side: "left", variant: 2 }
];

function drawTarget(graphics: Graphics, kind: GatherActionKind, x: number, ground: number, size: number): void {
  // Flag building has no separate target: the flag is in the player's hand.
  if (kind === "flag") return;
  if (kind === "chop") {
    graphics
      .roundRect(x - size * 0.12, ground - size * 0.9, size * 0.24, size * 0.9, size * 0.04)
      .fill(0x7a4a24)
      .stroke({ color: 0x3a1000, width: 2 })
      .circle(x, ground - size * 1.05, size * 0.42)
      .fill(0x4f8f3a)
      .stroke({ color: 0x1f3a14, width: 2 });
  } else if (kind === "harvest") {
    // A berry bush: the hand reaches into its near edge.
    graphics
      .roundRect(x - size * 0.34, ground - size * 0.44, size * 0.68, size * 0.44, size * 0.2)
      .fill(0x3f7f34)
      .stroke({ color: 0x1f3a14, width: 2 });
    for (const [dx, dy] of [[-0.18, -0.28], [0.04, -0.34], [0.18, -0.2], [-0.04, -0.14]] as const) {
      graphics.circle(x + dx * size, ground + dy * size, size * 0.045).fill(0xb3263a);
    }
  } else if (kind === "mine") {
    graphics
      .poly([x - size * 0.4, ground, x - size * 0.3, ground - size * 0.42, x, ground - size * 0.55, x + size * 0.36, ground - size * 0.3, x + size * 0.42, ground])
      .fill(0x8c8c8c)
      .stroke({ color: 0x333333, width: 2 });
  } else {
    graphics
      .ellipse(x, ground + size * 0.05, size * 0.75, size * 0.2)
      .fill(0x3d8fb0)
      .stroke({ color: 0x1d4f66, width: 2 });
  }
}

/**
 * Developer preview: every gathering animation looping on layered player
 * sprites, both sides, with and without armour. Mounted only on demand.
 */
export function GatheringAnimationPreview(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [large, setLarge] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [fishPhase, setFishPhase] = useState<GatherFishPhase>("wait");
  const optionsRef = useRef({ large, reducedMotion, fishPhase });
  optionsRef.current = { large, reducedMotion, fishPhase };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let initialized = false;
    const app = new Application();
    const renderers: { renderer: PlayerRenderer; rig: JacketRig | null; row: PreviewRow; side: GatherSide; startedAtMs: number }[] = [];
    const cells: Container[] = [];
    const textures = new PixiTextureCache(playerAppearanceAssetUrl);
    let appliedLarge: boolean | null = null;
    let appliedReduced: boolean | null = null;
    let appliedFishPhase: GatherFishPhase | null = null;
    const layout = (): void => {
      const { large: isLarge } = optionsRef.current;
      const scale = isLarge ? 1.9 : 0.63;
      const cellWidth = isLarge ? 300 : 150;
      const cellHeight = isLarge ? 260 : 120;
      const labelWidth = 120;
      app.renderer.resize(labelWidth + cellWidth * COLUMNS.length, cellHeight * PREVIEW_ROWS.length);
      cells.forEach((cell, index) => {
        const rowIndex = Math.floor(index / COLUMNS.length);
        const columnIndex = index % COLUMNS.length;
        const column = COLUMNS[columnIndex]!;
        const row = PREVIEW_ROWS[rowIndex]!;
        cell.position.set(labelWidth + columnIndex * cellWidth, rowIndex * cellHeight);
        const ground = cellHeight * 0.82;
        const centerX = cellWidth * 0.42;
        const targetX = centerX + (column.side === "right" ? 1 : -1) * cellWidth * 0.36;
        const graphics = cell.getChildAt(0) as Graphics;
        graphics.clear()
          .rect(0, 0, cellWidth, cellHeight)
          .fill((rowIndex + columnIndex) % 2 === 0 ? 0x6f9a5a : 0x67915a)
          .ellipse(centerX, ground, 22 * scale, 6 * scale)
          .fill({ color: 0x000000, alpha: 0.18 });
        drawTarget(graphics, row.kind, targetX, ground, 70 * scale);
        const renderer = renderers[index]!.renderer;
        renderer.root.scale.set(scale);
        renderer.root.position.set(centerX, ground);
        renderer.setGatheringLineTarget(row.kind === "fish"
          ? { x: (targetX - centerX) / scale, y: 2 }
          : null);
      });
    };
    const initialize = async (): Promise<void> => {
      await app.init({
        width: 720,
        height: 600,
        backgroundColor: 0x2b2118,
        antialias: true,
        resolution: Math.max(2, globalThis.devicePixelRatio || 1),
        autoDensity: true
      });
      initialized = true;
      if (disposed) {
        app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
        return;
      }
      host.replaceChildren(app.canvas);
      PREVIEW_ROWS.forEach((row, rowIndex) => {
        const label = new Text({
          text: row.label,
          style: { fill: 0xf3e6c8, fontSize: 13, fontFamily: "Georgia, serif" }
        });
        label.position.set(8, rowIndex * 120 + 8);
        label.label = `row-label-${rowIndex}`;
        app.stage.addChild(label);
        for (const column of COLUMNS) {
          const cell = new Container();
          cell.addChild(new Graphics());
          const renderer = new PlayerRenderer({ local: true, color: 0x38bdf8, textureLoader: textures });
          cell.addChild(renderer.root);
          // The Jacket B player (the live body) on the plain-body columns; the armoured columns keep the drawn body.
          const rig = column.variant === 0 ? createJacketRig(`preview-${rowIndex}-${column.side}`, 2) : null;
          if (rig) renderer.root.addChild(rig.root);
          app.stage.addChild(cell);
          cells.push(cell);
          renderers.push({ renderer, rig, row, side: column.side, startedAtMs: performance.now() + rowIndex * 90 });
          void renderer.updateAppearance(previewAppearance(column.variant));
        }
      });
      void loadFlagTextures().then((textures) => {
        if (disposed) return;
        renderers.forEach((entry, index) => {
          if (entry.row.kind !== "flag") return;
          entry.renderer.setFlagBuildArt(flagBuildArtFromTextures(
            (asset) => textures.get(asset),
            FLAG_CLOTH_COLORS[index % COLUMNS.length]!
          ));
        });
      });
      app.ticker.add(() => {
        const options = optionsRef.current;
        if (options.large !== appliedLarge) {
          appliedLarge = options.large;
          layout();
          app.stage.children.forEach((child) => {
            if (child.label?.startsWith("row-label-")) {
              const index = Number(child.label.slice("row-label-".length));
              child.position.y = index * (options.large ? 260 : 120) + 8;
            }
          });
        }
        const now = performance.now();
        const restart = options.reducedMotion !== appliedReduced;
        const fishChanged = options.fishPhase !== appliedFishPhase;
        appliedReduced = options.reducedMotion;
        appliedFishPhase = options.fishPhase;
        for (const entry of renderers) {
          if (restart || (fishChanged && entry.row.kind === "fish")) {
            entry.renderer.setGatheringAction({
              kind: entry.row.kind,
              tool: entry.row.tool ? gatheringToolAssetKeyForDefinition(entry.row.tool) : null,
              side: entry.side,
              startedAtMs: entry.startedAtMs,
              fishPhase: options.fishPhase,
              reducedMotion: options.reducedMotion
            });
          }
          entry.renderer.updateAnimation(now);
          if (entry.rig) {
            // Flag rows: a 5 s build loop (4 s work, the 1 s plant, then 1 s planted) to show the final plant.
            const flagCompletesAt = entry.row.kind === "flag"
              ? now + 4000 - ((now - entry.startedAtMs) % 6000)
              : undefined;
            entry.rig.update({
              lat: 0, lon: 0, walking: false, nowMs: now, bearingDeg: 0,
              targetHeight: entry.renderer.baseHeightPx * entry.renderer.overallScale,
              gather: jacketGatherInput(entry.renderer, flagCompletesAt, now)
            });
            entry.renderer.visualRoot.visible = !entry.rig.ready;
            entry.renderer.setGatherImpactOrigin(entry.rig.ready ? entry.rig.gatherImpactPoint ?? null : null);
          }
        }
      });
    };
    void initialize();
    return () => {
      disposed = true;
      for (const entry of renderers) { entry.rig?.destroy(); entry.renderer.destroy(); }
      if (initialized) app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
    };
  }, []);

  return <div className="gathering-animation-preview">
    <div className="gathering-animation-preview-controls" role="group" aria-label="Gathering preview options">
      <label><input type="checkbox" checked={large} onChange={(event) => setLarge(event.target.checked)} /> 3× zoom</label>
      <label><input type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} /> Reduced motion</label>
      <label>Fishing phase{" "}
        <select value={fishPhase} onChange={(event) => setFishPhase(event.target.value as GatherFishPhase)}>
          <option value="ready">Ready (not cast)</option>
          <option value="wait">Cast · waiting</option>
          <option value="bite">Bite</option>
          <option value="fight">Hooked · fighting</option>
        </select>
      </label>
    </div>
    <div ref={hostRef} className="gathering-animation-preview-canvas" />
  </div>;
}
