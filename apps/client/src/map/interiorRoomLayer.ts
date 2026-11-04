import {
  interiorLocalToLngLat,
  type DungeonObjectSnapshot,
  type DungeonPrefabDefinition,
  type DungeonRoomDefinition,
  type IndoorPoint
} from "@ash-atlas/shared";
import { Container, Graphics, Sprite, Texture, TilingSprite } from "pixi.js";

import {
  DUNGEON_BARRICADE_SIZE,
  dungeonAssetPublicUrl,
  dungeonObjectAssetUrl
} from "../ui/DungeonRoomPresentation.js";
import type { InteriorRenderState, InteriorSpriteItem } from "./mapObjects.js";

/** Screen transform of a room's local frame: origin, uniform scale, rotation. */
export type InteriorRoomTransform = Readonly<{
  x: number;
  y: number;
  scale: number;
  rotation: number;
}>;

type Project = (lngLat: [number, number]) => { x: number; y: number };

/**
 * One projection of the room origin and one axis point per frame gives the
 * whole room's similarity transform; nothing inside the room is projected.
 */
export function interiorRoomTransform(
  project: Project,
  frame: Pick<InteriorRenderState, "roomWidth" | "metersPerUnit">
): InteriorRoomTransform {
  const origin = interiorLocalToLngLat({ x: 0, y: 0 }, frame.metersPerUnit);
  const axis = interiorLocalToLngLat({ x: frame.roomWidth, y: 0 }, frame.metersPerUnit);
  const projectedOrigin = project([origin.lon, origin.lat]);
  const projectedAxis = project([axis.lon, axis.lat]);
  const dx = projectedAxis.x - projectedOrigin.x;
  const dy = projectedAxis.y - projectedOrigin.y;
  return {
    x: projectedOrigin.x,
    y: projectedOrigin.y,
    scale: Math.hypot(dx, dy) / frame.roomWidth,
    rotation: Math.atan2(dy, dx)
  };
}

export function interiorLocalToScreen(
  transform: InteriorRoomTransform,
  point: IndoorPoint
): { x: number; y: number } {
  const cos = Math.cos(transform.rotation) * transform.scale;
  const sin = Math.sin(transform.rotation) * transform.scale;
  return {
    x: transform.x + point.x * cos - point.y * sin,
    y: transform.y + point.x * sin + point.y * cos
  };
}

export function interiorScreenToLocal(
  transform: InteriorRoomTransform,
  point: { x: number; y: number }
): IndoorPoint {
  const dx = point.x - transform.x;
  const dy = point.y - transform.y;
  const cos = Math.cos(transform.rotation) / transform.scale;
  const sin = Math.sin(transform.rotation) / transform.scale;
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/** Painter's order for y-sorted actors: lower on screen draws later. */
export function interiorActorSortKey(screenY: number): number {
  return Math.round(screenY * 16);
}

const CHEST_OPEN_FX_MS = 700;

type LayerId = keyof DungeonRoomDefinition["layers"];
type RoomItem = {
  key: string;
  layerId: LayerId;
  /** Local anchor the item container sits on. */
  anchor: IndoorPoint;
  /** Local y used for actor depth sorting. */
  sortY: number;
  container: Container;
};


function authoredSprite(
  texture: Texture,
  prefab: Pick<DungeonPrefabDefinition, "renderMode" | "pivotX" | "pivotY" | "defaultWidth" | "defaultHeight">,
  width: number,
  height: number,
  rotationDeg: number,
  flipX: boolean,
  flipY: boolean,
  opacity: number
): Sprite | TilingSprite {
  const sprite = prefab.renderMode === "tile"
    ? new TilingSprite({ texture, width, height })
    : new Sprite(texture);
  if (sprite instanceof TilingSprite) {
    sprite.tileScale.set(
      prefab.defaultWidth / Math.max(1, texture.width),
      prefab.defaultHeight / Math.max(1, texture.height)
    );
  } else {
    sprite.width = width;
    sprite.height = height;
  }
  sprite.anchor.set(prefab.pivotX, prefab.pivotY);
  sprite.rotation = rotationDeg * Math.PI / 180;
  if (flipX) sprite.scale.x *= -1;
  if (flipY) sprite.scale.y *= -1;
  sprite.alpha = opacity;
  return sprite;
}

export type InteriorRoomLayerOptions = Readonly<{
  /** Container shared with world players and mobs so actors y-sort together. */
  actorParent: Container;
  loadTexture(url: string): Promise<Texture>;
  /** May return a promise; it settles once the texture is fully destroyed. */
  unloadTexture(url: string): Promise<void> | void;
  /** True when world rendering also uses the url, so leaving interior space must not unload it. */
  isTextureShared?(url: string): boolean;
}>;

/**
 * Pixi presentation of one authored interior room: background/below_player
 * under everything, actors mixed into the shared dynamic entity layer,
 * above_player over actors, ceiling over the local player and floaters.
 */
export class InteriorRoomLayer {
  readonly below = new Container();
  readonly above = new Container();
  readonly ceiling = new Container();
  private state: InteriorRenderState | null = null;
  private items: RoomItem[] = [];
  private dynamicSignature = "";
  /** Textures of the current interior space; kept across room changes, released on leaving to the world. */
  private textures = new Map<string, Promise<Texture>>();
  private releasing = new Map<string, Promise<void>>();
  private ready: Promise<void> = Promise.resolve();
  private transform: InteriorRoomTransform | null = null;
  private generation = 0;
  /** Last seen chest states, to catch the moment one flips to looted. */
  private chestStates = new Map<string, string>();
  private justOpened = new Set<string>();
  private chestFx = new Map<string, { startedAt: number; container: Container; glow: Graphics }>();

  constructor(private readonly options: InteriorRoomLayerOptions) {
    this.below.label = "interior-below";
    this.above.label = "interior-above";
    this.ceiling.label = "interior-ceiling";
  }

  update(state: InteriorRenderState | null): void {
    if (!state) {
      if (this.state) this.clear();
      this.releaseTextures();
      return;
    }
    const spaceChanged = this.state?.spaceKey !== state.spaceKey;
    // Room-to-room changes destroy sprites but keep every texture: unloading a
    // texture the next room shares destroys it under the new sprites and
    // crashes Pixi's render loop. Textures are released on leaving interiors.
    if (spaceChanged && this.state) this.clear();
    this.state = state;
    if (spaceChanged) {
      this.generation += 1;
      this.buildPlacements(state);
      this.ready = this.preload(state);
    }
    const signature = dynamicItemsSignature(state);
    if (spaceChanged || signature !== this.dynamicSignature) {
      this.dynamicSignature = signature;
      this.rebuildDynamicItems(state);
    }
  }

  /** Resolves once the given space's room textures are loaded (or failed). */
  async whenReady(spaceKey: string): Promise<boolean> {
    if (this.state?.spaceKey !== spaceKey) return false;
    await this.ready;
    return this.state?.spaceKey === spaceKey;
  }

  frame(project: Project): InteriorRoomTransform | null {
    const state = this.state;
    if (!state) {
      this.transform = null;
      return null;
    }
    const transform = interiorRoomTransform(project, state);
    this.transform = transform;
    for (const layer of [this.below, this.above, this.ceiling]) {
      layer.position.set(transform.x, transform.y);
      layer.scale.set(transform.scale);
      layer.rotation = transform.rotation;
    }
    this.animateOpenedChests();
    const actorParent = this.options.actorParent;
    actorParent.sortableChildren = true;
    for (const child of actorParent.children) {
      child.zIndex = interiorActorSortKey(child.position.y);
    }
    for (const item of this.items) {
      if (item.layerId !== "actors") continue;
      const screen = interiorLocalToScreen(transform, item.anchor);
      item.container.position.set(screen.x, screen.y);
      item.container.scale.set(transform.scale * this.chestPop(item.key));
      item.container.rotation = transform.rotation;
      const sortScreen = interiorLocalToScreen(transform, { x: item.anchor.x, y: item.sortY });
      item.container.zIndex = interiorActorSortKey(sortScreen.y);
    }
    return transform;
  }

  private chestPop(itemKey: string): number {
    const fx = this.chestFx.get(itemKey.slice("object:".length));
    if (!fx) return 1;
    const t = (performance.now() - fx.startedAt) / CHEST_OPEN_FX_MS;
    return t >= 1 ? 1 : 1 + 0.22 * Math.sin(Math.PI * t);
  }

  /** Short lid-pop: the chest swells and a golden glow fades; non-actor chests scale their own container. */
  private animateOpenedChests(): void {
    const now = performance.now();
    for (const [id, fx] of [...this.chestFx]) {
      const t = (now - fx.startedAt) / CHEST_OPEN_FX_MS;
      if (fx.container.destroyed || t >= 1) {
        if (!fx.container.destroyed) { fx.glow.destroy(); fx.container.scale.set(1); }
        this.chestFx.delete(id);
        continue;
      }
      fx.glow.alpha = 1 - t;
      const item = this.items.find((candidate) => candidate.key === `object:${id}`);
      if (item && item.layerId !== "actors") item.container.scale.set(1 + 0.22 * Math.sin(Math.PI * t));
    }
  }

  pickObjectAt(point: { x: number; y: number }): DungeonObjectSnapshot | null {
    return this.pickObjectsAt(point)[0]?.object ?? null;
  }

  /**
   * Every object whose prefab frame contains the point (grown by paddingPx of
   * screen space), topmost first, with the screen distance to its frame centre.
   */
  pickObjectsAt(
    point: { x: number; y: number },
    paddingPx = 0
  ): Array<{ object: DungeonObjectSnapshot; distancePx: number }> {
    const state = this.state;
    const transform = this.transform;
    if (!state || !transform) return [];
    const local = interiorScreenToLocal(transform, point);
    const padding = paddingPx / transform.scale;
    const prefabs = new Map(state.prefabs.map((prefab) => [prefab.id, prefab]));
    const hits: Array<{ object: DungeonObjectSnapshot; distancePx: number }> = [];
    for (const object of visibleObjects(state)) {
      const prefab = prefabs.get(object.prefabId);
      const width = prefab?.defaultWidth ?? 64;
      const height = prefab?.defaultHeight ?? 64;
      const pivotX = prefab?.pivotX ?? 0.5;
      const pivotY = prefab?.pivotY ?? 0.5;
      const left = object.x - pivotX * width;
      const top = object.y - pivotY * height;
      const extra = state.objectHitFrames?.get(object.id);
      const inside = (local.x >= left - padding &&
        local.x <= left + width + padding &&
        local.y >= top - padding &&
        local.y <= top + height + padding) || (!!extra &&
        local.x >= extra.left - padding && local.x <= extra.right + padding &&
        local.y >= extra.top - padding && local.y <= extra.bottom + padding);
      if (!inside) continue;
      const center = interiorLocalToScreen(transform, { x: left + width / 2, y: top + height / 2 });
      hits.push({ object, distancePx: Math.hypot(point.x - center.x, point.y - center.y) });
    }
    return hits.sort((a, b) =>
      b.object.zIndex - a.object.zIndex || b.object.y - a.object.y
    );
  }

  destroy(): void {
    this.clear();
    this.releaseTextures();
    this.below.destroy({ children: true });
    this.above.destroy({ children: true });
    this.ceiling.destroy({ children: true });
  }

  private clear(): void {
    this.chestStates.clear();
    this.chestFx.clear();
    for (const item of this.items) item.container.destroy({ children: true });
    this.items = [];
    this.dynamicSignature = "";
    this.state = null;
    this.transform = null;
    this.generation += 1;
    const actorParent = this.options.actorParent;
    // Pixi marks the parent sortable whenever a child's zIndex is set.
    for (const child of actorParent.children) child.zIndex = 0;
    actorParent.sortableChildren = false;
  }

  /** Sprites are already destroyed by clear(); only then are their textures unloaded. */
  private releaseTextures(): void {
    for (const [url, loading] of [...this.textures]) {
      this.textures.delete(url);
      if (this.options.isTextureShared?.(url)) continue;
      const release: Promise<void> = loading
        .then(() => this.options.unloadTexture(url))
        .catch(() => undefined)
        .then(() => {
          if (this.releasing.get(url) === release) this.releasing.delete(url);
        });
      this.releasing.set(url, release);
    }
  }

  private texture(url: string): Promise<Texture> {
    let texture = this.textures.get(url);
    if (!texture) {
      // A still-settling unload of this url would destroy the fresh texture.
      texture = (this.releasing.get(url) ?? Promise.resolve())
        .then(() => this.options.loadTexture(url))
        .catch(() => Texture.EMPTY);
      this.textures.set(url, texture);
    }
    return texture;
  }

  private textureUrls(state: InteriorRenderState): Set<string> {
    const urls = new Set<string>();
    const prefabs = new Map(state.prefabs.map((prefab) => [prefab.id, prefab]));
    for (const layerId of Object.keys(state.layers) as LayerId[]) {
      for (const placement of state.layers[layerId]) {
        const prefab = prefabs.get(placement.prefabId);
        const url = prefab && !placement.retired ? dungeonAssetPublicUrl(prefab.assetKey) : null;
        if (url) urls.add(url);
      }
    }
    for (const object of visibleObjects(state)) {
      const prefab = prefabs.get(object.prefabId);
      const url = prefab ? dungeonObjectAssetUrl(object, prefab) : null;
      if (url) urls.add(url);
    }
    for (const sprite of state.sprites ?? []) urls.add(sprite.url);
    return urls;
  }

  private preload(state: InteriorRenderState): Promise<void> {
    return Promise.all([...this.textureUrls(state)].map((url) => this.texture(url))).then(() => undefined);
  }

  private addItem(item: Omit<RoomItem, "container">, build: (container: Container) => Promise<void> | void): void {
    const container = new Container();
    container.label = `interior-item:${item.key}`;
    if (item.layerId === "actors") {
      this.options.actorParent.addChild(container);
    } else {
      container.position.set(item.anchor.x, item.anchor.y);
      this.layerContainer(item.layerId).addChild(container);
    }
    this.items.push({ ...item, container });
    void build(container);
  }

  private layerContainer(layerId: LayerId): Container {
    return layerId === "background" || layerId === "below_player"
      ? this.below
      : layerId === "ceiling" ? this.ceiling : this.above;
  }

  private buildPlacements(state: InteriorRenderState): void {
    const prefabs = new Map(state.prefabs.map((prefab) => [prefab.id, prefab]));
    const generation = this.generation;
    for (const layerId of ["background", "below_player", "actors", "above_player", "ceiling"] as const) {
      const placements = state.layers[layerId]
        .filter((placement) => !placement.retired)
        .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
      for (const placement of placements) {
        const prefab = prefabs.get(placement.prefabId);
        const url = prefab ? dungeonAssetPublicUrl(prefab.assetKey) : null;
        if (!prefab || !url) continue;
        this.addItem({
          key: `placement:${placement.id}`,
          layerId,
          anchor: {
            x: placement.x + prefab.pivotX * placement.width,
            y: placement.y + prefab.pivotY * placement.height
          },
          sortY: placement.y + placement.height
        }, async (container) => {
          const texture = await this.texture(url);
          if (generation !== this.generation || container.destroyed) return;
          container.addChild(authoredSprite(
            texture, prefab, placement.width, placement.height,
            placement.rotationDeg, placement.flipX, placement.flipY, placement.opacity
          ));
        });
      }
    }
  }

  private rebuildDynamicItems(state: InteriorRenderState): void {
    this.items = this.items.filter((item) => {
      if (item.key.startsWith("placement:")) return true;
      item.container.destroy({ children: true });
      return false;
    });
    const prefabs = new Map(state.prefabs.map((prefab) => [prefab.id, prefab]));
    const generation = this.generation;
    this.justOpened = new Set();
    for (const object of state.objects) {
      if (object.kind !== "chest") continue;
      const before = this.chestStates.get(object.id);
      if (before !== undefined && before !== "looted" && object.state === "looted") this.justOpened.add(object.id);
      this.chestStates.set(object.id, object.state);
    }
    for (const object of visibleObjects(state)) {
      const prefab = prefabs.get(object.prefabId);
      const url = prefab ? dungeonObjectAssetUrl(object, prefab) : null;
      const width = prefab?.defaultWidth ?? 64;
      const height = prefab?.defaultHeight ?? 64;
      const selected = state.selectedObjectId === object.id;
      this.addItem({
        key: `object:${object.id}`,
        layerId: object.layerId,
        anchor: { x: object.x, y: object.y },
        sortY: object.y
      }, async (container) => {
        if (selected) container.addChild(selectionRing(width, height));
        if (!prefab || !url) {
          container.addChild(new Graphics().rect(-width / 2, -height / 2, width, height)
            .fill({ color: 0x9ca3af, alpha: 0.6 }));
          return;
        }
        const texture = await this.texture(url);
        if (generation !== this.generation || container.destroyed) return;
        const sprite = authoredSprite(
          texture, { ...prefab, renderMode: "sprite" }, width, height,
          object.rotationDeg, object.flipX, object.flipY, object.opacity
        );
        // A looted chest with open art shows it; without any it reads as spent (dimmed, desaturated). A fresh opening pops.
        if (object.kind === "chest" && object.state === "looted") {
          if (!prefab.stateAssets.some((asset) => asset.stateId === "looted")) {
            sprite.tint = 0x8f877b;
            sprite.alpha = object.opacity * 0.6;
          }
          if (this.justOpened.has(object.id)) {
            const glow = new Graphics().circle(0, 0, Math.max(width, height) * 0.7).fill({ color: 0xfacc15, alpha: 0.55 });
            container.addChildAt(glow, 0);
            this.chestFx.set(object.id, { startedAt: performance.now(), container, glow });
          }
        }
        container.addChild(sprite);
      });
    }
    const sprites = [...(state.sprites ?? [])]
      .sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0) || left.key.localeCompare(right.key));
    for (const item of sprites) {
      this.addItem({
        key: `sprite:${item.key}`,
        layerId: item.layerId,
        anchor: { x: item.x, y: item.y },
        sortY: item.y
      }, async (container) => {
        const texture = await this.texture(item.url);
        if (generation !== this.generation || container.destroyed) return;
        container.addChild(plainSprite(texture, item));
      });
    }
    for (const barricade of state.barricades ?? []) {
      const url = dungeonAssetPublicUrl(barricade.assetKey);
      if (!url) continue;
      this.addItem({
        key: `barricade:${barricade.portalId}`,
        layerId: "above_player",
        anchor: { x: barricade.x, y: barricade.y },
        sortY: barricade.y
      }, async (container) => {
        const texture = await this.texture(url);
        if (generation !== this.generation || container.destroyed) return;
        const sprite = new Sprite(texture);
        sprite.anchor.set(0.5);
        sprite.width = DUNGEON_BARRICADE_SIZE;
        sprite.height = DUNGEON_BARRICADE_SIZE;
        container.addChild(sprite);
      });
    }
  }
}

function plainSprite(texture: Texture, item: InteriorSpriteItem): Sprite {
  const sprite = new Sprite(texture);
  sprite.anchor.set(item.anchorX, item.anchorY);
  const width = item.width;
  const height = item.height ?? width * texture.height / Math.max(1, texture.width);
  if (item.fit === "contain" && item.height !== null) {
    // object-fit: contain, centred in the box the anchor places.
    const scale = Math.min(width / Math.max(1, texture.width), height / Math.max(1, texture.height));
    const drawnWidth = texture.width * scale;
    const drawnHeight = texture.height * scale;
    sprite.anchor.set(0, 0);
    sprite.x = -item.anchorX * width + (width - drawnWidth) / 2;
    sprite.y = -item.anchorY * height + (height - drawnHeight) / 2;
    sprite.width = drawnWidth;
    sprite.height = drawnHeight;
    sprite.alpha = item.alpha ?? 1;
    return sprite;
  }
  sprite.width = width;
  sprite.height = height;
  sprite.scale.x *= item.scaleX ?? 1;
  sprite.scale.y *= item.scaleY ?? 1;
  sprite.rotation = (item.rotationDeg ?? 0) * Math.PI / 180;
  sprite.alpha = item.alpha ?? 1;
  return sprite;
}

function visibleObjects(state: InteriorRenderState): DungeonObjectSnapshot[] {
  return state.objects.filter((object) => object.kind !== "chest" || object.available);
}

function selectionRing(width: number, height: number): Graphics {
  return new Graphics()
    .ellipse(0, 0, width * 0.6, height * 0.6)
    .stroke({ width: 4, color: 0xfacc15, alpha: 0.9 });
}

function dynamicItemsSignature(state: InteriorRenderState): string {
  return JSON.stringify([
    state.selectedObjectId,
    state.objects.map((object) => [
      object.id, object.state, object.available, object.assetKey ?? null,
      object.x, object.y, object.layerId, object.rotationDeg, object.opacity
    ]),
    (state.barricades ?? []).map((barricade) => [barricade.portalId, barricade.x, barricade.y, barricade.assetKey]),
    state.sprites ?? []
  ]);
}
