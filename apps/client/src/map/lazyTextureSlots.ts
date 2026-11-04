import type { Texture } from "pixi.js";

type Slot = {
  loader: () => Promise<Texture>;
  texture?: Texture;
  promise?: Promise<Texture>;
};

/**
 * Named presentation textures that load on first need. `request` returns the
 * texture once it is ready (undefined while loading) and starts the load the
 * first time it is called; `onArrive` fires once per slot when it lands so the
 * overlay can mark the layers that draw it dirty.
 */
export class LazyTextureSlots {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly onArrive: (name: string) => void) {}

  define(name: string, loader: () => Promise<Texture>): void {
    if (!this.slots.has(name)) this.slots.set(name, { loader });
  }

  has(name: string): boolean {
    return this.slots.has(name);
  }

  peek(name: string): Texture | undefined {
    return this.slots.get(name)?.texture;
  }

  /** Ready texture, or undefined after starting the load. */
  request(name: string): Texture | undefined {
    const slot = this.slots.get(name);
    if (!slot) return undefined;
    if (slot.texture) return slot.texture;
    void this.load(name);
    return undefined;
  }

  load(name: string): Promise<Texture> {
    const slot = this.slots.get(name);
    if (!slot) return Promise.reject(new Error(`Unknown texture slot: ${name}`));
    if (slot.texture) return Promise.resolve(slot.texture);
    slot.promise ??= slot.loader().then((texture) => {
      slot.texture = texture;
      this.onArrive(name);
      return texture;
    });
    return slot.promise;
  }

  loadedCount(): number {
    let count = 0;
    for (const slot of this.slots.values()) if (slot.texture) count += 1;
    return count;
  }
}

/**
 * The items whose art is ready, as the same array when none are held back so
 * callers keep identity checks. `isReady` is called for every item (it also
 * starts the loads).
 */
export function retainReady<Item>(
  items: readonly Item[],
  isReady: (item: Item) => boolean
): Item[] {
  let kept: Item[] | null = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (isReady(item)) {
      kept?.push(item);
    } else {
      kept ??= items.slice(0, index);
    }
  }
  return kept ?? (items as Item[]);
}
