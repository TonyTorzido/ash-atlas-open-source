/*
 * Stock armour on the turned-front player (2026-10-21): the four stock chest armours (Tunic = cloth, leather,
 * chainmail, breastplate) draw as a garment LAYER over the bare stock body sheets (tank + black pants), frame for
 * frame: body frame i, then the layer frame i of the same clip, each anchored at its own root
 * (scripts/copy-stock-armour.mjs). Owner 2026-10-21: every other look (no chest armour, or any other chest look) is
 * the bare stock body itself, the tank top with black pants, with no layer; Jacket B is no longer drawn anywhere.
 *
 * Loading: the body and each armour's layers are lazy sheet sets (jacketSheets.ts): a clip loads the first time a
 * player wearing that armour needs it, and is released after RELEASE_AFTER_MS unused (no stock-armoured player on
 * screen, or that armour no longer shown). The five base clips (idle, walk L/R, stand L/R) are kept warm together
 * while a wearer is drawn, so a walk never waits on a load; gather clips load per clip and side on first use.
 */
import type { PlayerAppearanceSnapshot } from "@ash-atlas/shared";
import type { Texture } from "pixi.js";
import bodyManifest from "../assets/player-rig/stock-body/stock-body-sheets.json";
import clothManifest from "../assets/player-rig/stock-armour/cloth/cloth-layers.json";
import leatherManifest from "../assets/player-rig/stock-armour/leather/leather-layers.json";
import chainmailManifest from "../assets/player-rig/stock-armour/chainmail/chainmail-layers.json";
import breastplateManifest from "../assets/player-rig/stock-armour/breastplate/breastplate-layers.json";
import { createLazySheets, type LazySheets, type SheetView } from "./jacketSheets.js";

export const STOCK_ARMOURS = ["cloth", "leather", "chainmail", "breastplate"] as const;
export type StockArmourId = (typeof STOCK_ARMOURS)[number];

/** The stock looks (player-appearance-catalog.json) and the stock chest items that project to them. */
const BY_APPEARANCE: Readonly<Record<string, StockArmourId>> = {
  "non-swag-cloth": "cloth",
  "non-swag-leather": "leather",
  "non-swag-chainmail": "chainmail",
  "non-swag-breastplate": "breastplate"
};
const BY_EQUIPMENT: Readonly<Record<string, StockArmourId>> = {
  padded_tunic: "cloth",
  leather_armor: "leather",
  chain_armor: "chainmail",
  breast_plate: "breastplate"
};

/**
 * The stock armour a player shows, or null for the bare tank top (the default: no chest armour, or any other chest look).
 * The chest slot's look is its selected cosmetic, else the item's own appearance; an item with no appearance falls
 * back to its definition id.
 */
export function stockArmourForAppearance(appearance: PlayerAppearanceSnapshot | null | undefined): StockArmourId | null {
  const chest = appearance?.slots.chest;
  if (!chest) return null;
  const look = chest.cosmeticAppearanceId ?? chest.appearanceId;
  if (look) return BY_APPEARANCE[look] ?? null;
  return BY_EQUIPMENT[chest.equipmentDefinitionId] ?? null;
}

export type StockClipId =
  | "idle" | "walkL" | "walkR" | "standL" | "standR" | "sword_walkL" | "sword_walkR"
  | `${"chop" | "mine" | "harvest" | "fish_cast" | "fish_hold" | "flag_work" | "flag_plant"}${"L" | "R"}`;
export const STOCK_BASE_CLIPS = ["idle", "walkL", "walkR", "standL", "standR"] as const;

type Manifest = { scale: number; fps: number; clips: Record<string, SheetView> };
const BODY = bodyManifest as unknown as Manifest;
const LAYERS: Record<StockArmourId, Manifest> = {
  cloth: clothManifest as unknown as Manifest,
  leather: leatherManifest as unknown as Manifest,
  chainmail: chainmailManifest as unknown as Manifest,
  breastplate: breastplateManifest as unknown as Manifest
};

const BODY_URLS = import.meta.glob<string>("../assets/player-rig/stock-body/*.png", { query: "?url", import: "default" });
const LAYER_URLS = import.meta.glob<string>("../assets/player-rig/stock-armour/*/*.png", { query: "?url", import: "default" });

/** The one-side key the lazy sets use (each stock clip id already names its side). */
const SIDE = "L" as const;
const viewOf = (manifest: Manifest, id: string): SheetView => {
  const view = manifest.clips[id];
  if (!view) throw new Error(`stock armour: no clip ${id}`);
  return view;
};

let bodySheets: LazySheets<StockClipId> | null = null;
const layerSheets = new Map<StockArmourId, LazySheets<StockClipId>>();

function body(): LazySheets<StockClipId> {
  bodySheets ??= createLazySheets<StockClipId>("stock-body", "../assets/player-rig/stock-body/", BODY_URLS, (id) => viewOf(BODY, id));
  return bodySheets;
}

function layers(item: StockArmourId): LazySheets<StockClipId> {
  let sheets = layerSheets.get(item);
  if (!sheets) {
    sheets = createLazySheets<StockClipId>(`stock-${item}`, `../assets/player-rig/stock-armour/${item}/`, LAYER_URLS, (id) => viewOf(LAYERS[item], id));
    layerSheets.set(item, sheets);
  }
  return sheets;
}

export type StockFrames = {
  readonly body: Texture[];
  readonly bodyView: SheetView;
  /** The armour's garment layer frames, or null for the bare tank top (no layer). */
  readonly layer: Texture[] | null;
  readonly layerView: SheetView | null;
};

/**
 * A clip's body frames and (for an armour) its layer frames once on the GPU, else null (starts / keeps their loads).
 * item null = the bare tank top: the body alone.
 */
export function stockClip(item: StockArmourId | null, id: StockClipId, nowMs?: number): StockFrames | null {
  const b = body().get(id, SIDE, nowMs);
  if (!item) return b ? { body: b, bodyView: BODY.clips[id]!, layer: null, layerView: null } : null;
  const l = layers(item).get(id, SIDE, nowMs);
  if (!b || !l) return null;
  return { body: b, bodyView: BODY.clips[id]!, layer: l, layerView: LAYERS[item].clips[id]! };
}

/** The five base clips, or null until all are ready (each call keeps all five warm). item null = the tank top. */
export function stockBaseClips(item: StockArmourId | null, nowMs?: number): Record<(typeof STOCK_BASE_CLIPS)[number], StockFrames> | null {
  let ready = true;
  const out = {} as Record<(typeof STOCK_BASE_CLIPS)[number], StockFrames>;
  for (const id of STOCK_BASE_CLIPS) {
    const clip = stockClip(item, id, nowMs);
    if (clip) out[id] = clip;
    else ready = false;
  }
  return ready ? out : null;
}

/** Dev/test: the load state of a look's clip (body, layer; "none" for the tank top's layer). */
export function stockClipState(item: StockArmourId | null, id: StockClipId): { body: string; layer: string } {
  return { body: body().state(id, SIDE), layer: item ? layers(item).state(id, SIDE) : "none" };
}

/**
 * Dev builds only: a forced look for every player, for runtime checks without crafting each armour. Set by
 * `?stockArmour=<item>|none` or `globalThis.__stockArmourOverride` (same values); undefined = no override.
 */
export function devStockArmourOverride(): StockArmourId | null | undefined {
  if (!import.meta.env.DEV) return undefined;
  let value: unknown = (globalThis as { __stockArmourOverride?: unknown }).__stockArmourOverride;
  if (value === undefined) {
    try {
      value = new URLSearchParams(globalThis.location?.search ?? "").get("stockArmour") ?? undefined;
    } catch {
      value = undefined;
    }
  }
  if (value === "none") return null;
  return (STOCK_ARMOURS as readonly unknown[]).includes(value) ? value as StockArmourId : undefined;
}
