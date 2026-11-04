/*
 * GPU upload of the Jacket B sheet pages ahead of first use (2026-10-20, owner: "character animation is laggy ... it
 * stutters at some points"). Pixi uploads a texture (and builds its mipmaps) on the frame it first draws, so a 2048 px
 * page used for the first time mid-walk, mid-breath or at a gather start cost a frame spike. Loaded pages are queued
 * here and uploaded one per animation frame, before the clip reaches them.
 */
import type { TextureSource } from "pixi.js";

type UploadRenderer = { readonly texture: { initSource(source: TextureSource): unknown } };

let renderer: UploadRenderer | null = null;
const queue: TextureSource[] = [];
const queued = new WeakSet<TextureSource>();
/** Resolves each queued source's waiters once it is uploaded (or dropped). */
const waiters = new Map<TextureSource, (() => void)[]>();
const settle = (source: TextureSource): void => {
  const list = waiters.get(source);
  waiters.delete(source);
  for (const resolve of list ?? []) resolve();
};
let scheduled = false;

function schedule(): void {
  if (scheduled || !renderer || queue.length === 0 || typeof requestAnimationFrame !== "function") return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const source = queue.shift();
    if (source && !source.destroyed && renderer) {
      try {
        renderer.texture.initSource(source);
      } catch (error: unknown) {
        console.warn("[jacket-rig] sheet upload failed; it uploads on first draw instead", error);
      }
    }
    if (source) settle(source);
    schedule();
  });
}

/** The overlay renderer the sheets draw with (set once it exists). */
export function setPlayerSheetRenderer(next: UploadRenderer | null): void {
  renderer = next;
  schedule();
}

/**
 * Queues loaded sheet pages for upload, one per frame. Resolves once all of them are on the GPU, so a caller can
 * publish its clip only then (audit M4); resolves at once when there is no renderer yet (they upload on first draw).
 */
export function queuePlayerSheetUpload(sources: readonly TextureSource[]): Promise<void> {
  if (!renderer || typeof requestAnimationFrame !== "function") return Promise.resolve();
  const pending: Promise<void>[] = [];
  for (const source of sources) {
    if (!queued.has(source)) {
      queued.add(source);
      queue.push(source);
    } else if (!waiters.has(source)) {
      continue; // already uploaded
    }
    pending.push(new Promise<void>((resolve) => {
      const list = waiters.get(source) ?? [];
      list.push(resolve);
      waiters.set(source, list);
    }));
  }
  schedule();
  return Promise.all(pending).then(() => undefined);
}
