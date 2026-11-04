/**
 * Sprite hooks for the Tilted Vault art pass. Every texture is looked up by
 * key; when a file is missing the renderer keeps its procedural drawing, so the
 * art pass only has to add PNGs:
 *
 *   apps/client/public/art/vault/<key>.png
 *
 * Cell art is stretched to one cell (80 room units); `wall-0..3` are flat block
 * tops picked per cell, `wall-shadow` is a padded soft square drawn offset under
 * them and `grout` is an additive line overlay. `marble` is one ball (168 px on a
 * 216 px canvas) tinted per kind, with `marble-highlight` and `marble-shadow` on
 * the same canvas kept unrotated. `plate` / `plate-pressed` are tinted per kind;
 * `seal`, `seal-open` and `goal` fill a square on their spot. `room-<roomId>` is
 * the painted room drawn under the board at the room's full size.
 */
import { Texture } from "pixi.js";

export const VAULT_SPRITE_KEYS = [
  "floor", "floor-alt", "wall-0", "wall-1", "wall-2", "wall-3", "wall-shadow", "grout", "slit-v", "slit-h",
  "hole", "crack-1", "crack-2", "crack-3",
  "marble", "marble-highlight", "marble-shadow",
  "plate", "plate-pressed",
  "seal", "seal-open", "goal"
] as const;

export type VaultSpriteKey = typeof VAULT_SPRITE_KEYS[number] | `room-${string}`;

/** The painted room art key for a puzzle room. */
export const vaultRoomArtKey = (roomId: string): VaultSpriteKey => `room-${roomId}`;

/** Ball diameter over canvas size in the `marble` art. */
export const VAULT_MARBLE_CANVAS_RATIO = 216 / 168;

const cache = new Map<string, Texture | null | "loading">();

const urlFor = (key: string): string => `${import.meta.env.BASE_URL}art/vault/${key}.png`;

/** Retries after a failed load (ms before each), then the key sits out a cooldown and a later draw tries again. */
export const VAULT_TEXTURE_RETRY_DELAYS_MS: readonly number[] = [500, 1500, 4000];
export const VAULT_TEXTURE_COOLDOWN_MS = 15_000;

/** Keys whose load failed after every retry and have not yet loaded since (stuck telemetry reads this). */
const failedKeys = new Set<string>();
export const vaultTextureFailures = (): string[] => [...failedKeys];

function loadVaultTexture(key: VaultSpriteKey, attempt: number): void {
  const img = new Image();
  img.onload = () => {
    try { cache.set(key, Texture.from(img)); failedKeys.delete(key); } catch { failLoad(key, attempt); }
  };
  // A missing file (or the dev server HTML fallback) is not an image: retry, then stay procedural.
  img.onerror = () => { failLoad(key, attempt); };
  img.src = urlFor(key);
}

function failLoad(key: VaultSpriteKey, attempt: number): void {
  const delay = VAULT_TEXTURE_RETRY_DELAYS_MS[attempt];
  if (delay !== undefined) {
    setTimeout(() => loadVaultTexture(key, attempt + 1), delay);
    return;
  }
  cache.set(key, null);
  failedKeys.add(key);
  // Drop the cached failure after a cooldown so a later draw retries (a transient network error is not permanent).
  setTimeout(() => { if (cache.get(key) === null) cache.delete(key); }, VAULT_TEXTURE_COOLDOWN_MS);
}

/** The texture for `key`, or null while it loads or when no file exists. Never throws. */
export function vaultTexture(key: VaultSpriteKey): Texture | null {
  const hit = cache.get(key);
  if (hit === "loading") return null;
  if (hit !== undefined) return hit;
  cache.set(key, "loading");
  if (typeof Image === "undefined") { cache.set(key, null); return null; }
  loadVaultTexture(key, 0);
  return null;
}

/** Tests and the art preview can drop a texture in without a file. */
export function setVaultTexture(key: VaultSpriteKey, texture: Texture | null): void {
  cache.set(key, texture);
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  Object.assign(window, { __vaultSprites: { keys: VAULT_SPRITE_KEYS, set: setVaultTexture } });
}
