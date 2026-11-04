import { INTERIOR_DATA } from "./data/interiors/index.js";

/**
 * Manor skins: one inventory item, `manor_skin`, whose variant is a Manor type
 * (interior space id). Every Manor type except the default one gets a skin
 * automatically, so a Manor type made in Studio needs no code to be sold,
 * traded or installed. Kept free of other shared imports (the inventory
 * catalog reads it).
 */

/**
 * The Manor type every player Manor uses unless a skin is installed (the
 * timber Manor). Never "the first Manor in the catalog": Studio sorts spaces by
 * id, so a new type must not take over.
 */
export const DEFAULT_MANOR_TYPE_ID = "manor_lobby";
export const MANOR_SKIN_ITEM_ID = "manor_skin" as const;
/** Price until the owner sets one on the Manor type in Studio. */
export const DEFAULT_MANOR_SKIN_PRICE_GLIMMER = 500;

type ManorSpaceData = Readonly<{
  id: string;
  kind: string;
  name: string;
  retired: boolean;
  modules?: Readonly<{ manor?: Readonly<{ skinPriceGlimmer?: number }> }>;
}>;

const manorSpaces = (INTERIOR_DATA.spaces as readonly ManorSpaceData[])
  .filter((space) => space.kind === "manor" && space.id !== DEFAULT_MANOR_TYPE_ID);

/**
 * Every skin variant ever published, sorted (retired types stay valid so their
 * items never become unknown). Matches `item_definitions.supported_variants`.
 */
export const MANOR_SKIN_VARIANTS: readonly string[] = Object.freeze(manorSpaces.map((space) => space.id).sort());

/** True for the variant of a skin that may still be installed or bought. */
export function isPurchasableManorSkin(manorTypeId: string): boolean {
  return manorSpaces.some((space) => space.id === manorTypeId && !space.retired);
}

/** Glimmer price of a skin (the Manor type's Studio price, else the placeholder). */
export function manorSkinPriceGlimmer(manorTypeId: string): number {
  const price = manorSpaces.find((space) => space.id === manorTypeId)?.modules?.manor?.skinPriceGlimmer;
  return Number.isSafeInteger(price) && price! > 0 ? price! : DEFAULT_MANOR_SKIN_PRICE_GLIMMER;
}

/** "Samurai Manor Skin" for a skin variant. */
export function manorSkinDisplayName(manorTypeId: string): string {
  const name = manorSpaces.find((space) => space.id === manorTypeId)?.name ??
    manorTypeId.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  return `${name} Skin`;
}
