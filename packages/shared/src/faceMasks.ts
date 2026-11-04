/**
 * Face masks (Glimmer Shop, docs/design/GLIMMER_SHOP.md): one paid inventory item, `face_mask`,
 * whose variant is the mask's appearance id in the player appearance catalog (familyId "mask").
 * Wearing a mask needs a copy in the inventory; the worn copy is locked there (1200), extra copies
 * trade like any item. Kept free of other shared imports (the inventory catalog reads it).
 */
export const FACE_MASK_ITEM_ID = "face_mask" as const;

const FACE_MASK_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "mask-1": "Oni Mask",
  "mask-2": "Rebel Mask",
  "mask-3": "Calavera Mask",
  "hockey-mask": "Hockey Mask",
  "kitsune-mask": "Kitsune Mask"
});

/** Every mask variant, sorted. Matches `item_definitions.supported_variants` of `face_mask`. */
export const FACE_MASK_VARIANTS: readonly string[] = Object.freeze(Object.keys(FACE_MASK_NAMES).sort());

export function isFaceMaskVariant(appearanceId: string): boolean {
  return Object.hasOwn(FACE_MASK_NAMES, appearanceId);
}

/** "Oni Mask" for a mask variant. */
export function faceMaskDisplayName(appearanceId: string): string {
  return FACE_MASK_NAMES[appearanceId] ?? "Mask";
}
