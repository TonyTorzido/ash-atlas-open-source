/*
 * Lazily loaded Jacket B clip sheets (gather and sword sets), one entry per clip and side:
 * - loads on first use, uploads every page to the GPU before the entry is usable (no upload inside a draw);
 * - a failed load is not requested again until a backoff (5 s, doubling to 2 min) has passed;
 * - an entry not drawn for RELEASE_AFTER_MS is released (Assets.unload destroys the pages' GL textures and the
 *   decoded bitmaps) and reloads on its next use (HTTP cache / OTA bundle).
 */
import { Assets, Rectangle, Texture } from "pixi.js";
import { queuePlayerSheetUpload } from "./playerSheetUpload.js";

export type SheetView = { flip: boolean; frameWidth: number; frameHeight: number; rootX: number; rootY: number; pages: string[]; frames: [number, number, number][] };
type Side = "L" | "R";

/** Unused this long (ms) and a clip-side's sheets are released (audit H1, 2026-10-20). */
export const RELEASE_AFTER_MS = 45_000;
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 120_000;
const SWEEP_EVERY_MS = 5_000;

type Entry = {
  state: "loading" | "ready" | "failed";
  textures: Texture[] | null;
  urls: string[];
  lastUsedMs: number;
  retryAtMs: number;
  failures: number;
  /** Bumped on release so a load that finishes after it is dropped. */
  generation: number;
};

export type LazySheets<Id extends string> = {
  /** The clip-side's frame textures, or null while loading / backing off (starts the load). */
  get(id: Id, side: Side, nowMs?: number): Texture[] | null;
  /** Releases entries unused since before nowMs - RELEASE_AFTER_MS; returns how many were released. */
  sweep(nowMs?: number): number;
  /** Dev/test: the state of a clip-side. */
  state(id: Id, side: Side): "loading" | "ready" | "failed" | "none";
};

const sets: LazySheets<string>[] = [];
let sweepTimer: ReturnType<typeof setInterval> | null = null;
const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function createLazySheets<Id extends string>(
  name: string,
  dir: string,
  urls: Record<string, () => Promise<string>>,
  viewFor: (id: Id, side: Side) => SheetView,
  loadPage: (src: string) => Promise<Texture> = (src) => Assets.load<Texture>({ src, data: { autoGenerateMipmaps: true } }),
  unloadPage: (src: string) => Promise<void> = (src) => Assets.unload(src)
): LazySheets<Id> {
  const entries = new Map<string, Entry>();
  let generation = 0;

  const start = (key: string, entry: Entry, view: SheetView): void => {
    entry.state = "loading";
    const gen = entry.generation;
    void (async () => {
      const resolved = await Promise.all(view.pages.map(async (file) => {
        const importer = urls[`${dir}${file}`];
        if (!importer) throw new Error(`jacket ${name} page missing: ${file}`);
        return importer();
      }));
      entry.urls = resolved;
      const pages = await Promise.all(resolved.map(loadPage));
      for (const page of pages) page.source.scaleMode = "linear";
      await queuePlayerSheetUpload(pages.map((page) => page.source));
      if (entry.generation !== gen) return;
      entry.textures = view.frames.map(([page, x, y]) => new Texture({
        source: pages[page]!.source,
        frame: new Rectangle(x, y, view.frameWidth, view.frameHeight)
      }));
      entry.state = "ready";
      entry.failures = 0;
    })().catch((error: unknown) => {
      if (entry.generation !== gen) return;
      entry.state = "failed";
      entry.failures += 1;
      entry.retryAtMs = clock() + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (entry.failures - 1));
      console.warn(`[jacket-rig] ${name} sheet ${key} failed to load (retry in ${Math.round((entry.retryAtMs - clock()) / 1000)} s)`, error);
    });
  };

  const sheets: LazySheets<Id> = {
    get(id, side, nowMs = clock()) {
      const key = `${id}${side}`;
      let entry = entries.get(key);
      if (!entry) {
        entry = { state: "loading", textures: null, urls: [], lastUsedMs: nowMs, retryAtMs: 0, failures: 0, generation: generation++ };
        entries.set(key, entry);
        start(key, entry, viewFor(id, side));
      }
      entry.lastUsedMs = clock();
      if (entry.state === "ready") return entry.textures;
      if (entry.state === "failed" && clock() >= entry.retryAtMs) start(key, entry, viewFor(id, side));
      return null;
    },
    sweep(nowMs = clock()) {
      let released = 0;
      for (const [key, entry] of entries) {
        if (entry.state === "loading" || nowMs - entry.lastUsedMs < RELEASE_AFTER_MS) continue;
        entries.delete(key);
        entry.generation = -1;
        for (const texture of entry.textures ?? []) texture.destroy(false);
        for (const url of entry.urls) void unloadPage(url).catch(() => undefined);
        released += 1;
      }
      return released;
    },
    state(id, side) {
      return entries.get(`${id}${side}`)?.state ?? "none";
    }
  };
  sets.push(sheets as LazySheets<string>);
  if (!sweepTimer && typeof setInterval === "function" && typeof window !== "undefined") {
    sweepTimer = setInterval(() => { for (const set of sets) set.sweep(); }, SWEEP_EVERY_MS);
  }
  return sheets;
}
