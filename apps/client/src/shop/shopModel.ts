import {
  GLIMMER_SHOP_MAX_QUANTITY,
  requireEquipmentDefinition,
  type GlimmerShopCatalogItem
} from "@ash-atlas/shared";
import { playerAppearanceAssetUrl } from "@ash-atlas/player-renderer/asset-registry";

/** Pure Glimmer Shop helpers: item facts, art, cart math and error copy (docs/design/GLIMMER_SHOP.md). */

export type ShopTabId = "featured" | "weapons" | "armour" | "masks" | "manors" | "glimmer";

export const SHOP_TABS: readonly Readonly<{ id: ShopTabId; label: string }>[] = [
  { id: "featured", label: "Featured" },
  { id: "weapons", label: "Weapons" },
  { id: "armour", label: "Armour" },
  { id: "masks", label: "Masks" },
  { id: "manors", label: "Manors" },
  { id: "glimmer", label: "Glimmer" }
];

export const WEAPON_TYPES = {
  sword: "Sword", axe: "Axe", bow: "Bow", crossbow: "Crossbow",
  spear: "Spear", staff: "Staff", shuriken: "Shuriken", sling: "Sling"
} as const;
export type WeaponType = keyof typeof WEAPON_TYPES;

const BASE_WEAPON: Readonly<Record<string, readonly [WeaponType, string]>> = {
  starter_sword: ["sword", "Warrior"],
  double_axe: ["axe", "Warrior"],
  starter_bow: ["bow", "Ranger"],
  training_crossbow: ["crossbow", "Ranger"],
  training_spear: ["spear", "Warrior"],
  starter_staff: ["staff", "Mage"],
  starter_shuriken: ["shuriken", "Ninja"],
  training_sling: ["sling", "Ranger"]
};

/** Weapon type and class of a swag weapon, from the stock weapon it is based on. */
export function shopWeaponKind(item: GlimmerShopCatalogItem): Readonly<{ type: WeaponType; className: string }> | null {
  if (item.kind !== "weapon") return null;
  try {
    const base = requireEquipmentDefinition(item.grantItemId as never).baseDefinitionId;
    const entry = base ? BASE_WEAPON[base] : undefined;
    return entry ? { type: entry[0], className: entry[1] } : null;
  } catch {
    return null;
  }
}

/** Display name of the stock weapon a swag weapon is a skin of ("Starter Sword"). */
export function shopWeaponBaseName(item: GlimmerShopCatalogItem): string | null {
  if (item.kind !== "weapon") return null;
  try {
    const base = requireEquipmentDefinition(item.grantItemId as never).baseDefinitionId;
    return base ? requireEquipmentDefinition(base).displayName : null;
  } catch {
    return null;
  }
}

/** The newest items on sale (by addedAt, newest first) for the Featured carousel. */
export function shopNewestItems(items: readonly GlimmerShopCatalogItem[], limit = 5): readonly GlimmerShopCatalogItem[] {
  return items
    .filter((item) => item.onSale && item.source !== "craft")
    .slice()
    .sort((left, right) => right.addedAt.localeCompare(left.addedAt) || left.sortOrder - right.sortOrder)
    .slice(0, limit);
}

export function shopHeroEyebrow(item: GlimmerShopCatalogItem): string {
  return item.kind === "manor_skin" ? "New manor skin" : item.kind === "mask" ? "New mask" : item.kind === "armour" ? "New swag armour" : "New swag weapon";
}

/** Swag weapons are long sprites; slings and shuriken stay upright. */
export function shopArtTilted(item: GlimmerShopCatalogItem): boolean {
  const type = shopWeaponKind(item)?.type;
  return type !== undefined && type !== "sling" && type !== "shuriken";
}

const MASK_ASSET: Readonly<Record<string, string>> = {
  "mask-1": "mask1", "mask-2": "mask2", "mask-3": "mask3",
  "hockey-mask": "hockeymask", "kitsune-mask": "kitsunemask"
};

const MANOR_FILES = import.meta.glob<string>("../assets/manors/*/*.png", { eager: true, import: "default", query: "?url" });

export const MANOR_VIEWS = [
  { id: "exterior", label: "Outside" },
  { id: "lobby", label: "Lobby" },
  { id: "hall", label: "Hall" },
  { id: "room", label: "Rooms" },
  { id: "lower", label: "Lower floor" }
] as const;

function manorFolder(variant: string): string {
  return variant.replace(/_manor$/u, "");
}

export function shopManorViewUrl(item: GlimmerShopCatalogItem, viewId: string): string | null {
  return MANOR_FILES[`../assets/manors/${manorFolder(item.grantVariant)}/${viewId}.png`] ?? null;
}

/** Art of a mask copy, from its look (mask appearance id). */
export function shopMaskArtUrl(look: string | null | undefined): string | null {
  const file = look ? MASK_ASSET[look] : undefined;
  return file ? playerAppearanceAssetUrl(`masks/${file}.png`) : null;
}

export function shopItemArtUrl(item: GlimmerShopCatalogItem): string | null {
  if (item.kind === "weapon") return playerAppearanceAssetUrl(`weapons/swag/${item.grantItemId.replaceAll("_", "-")}.png`);
  if (item.kind === "mask") {
    const file = MASK_ASSET[item.grantVariant];
    return file ? playerAppearanceAssetUrl(`masks/${file}.png`) : null;
  }
  if (item.kind === "manor_skin") return shopManorViewUrl(item, "exterior");
  return null;
}

const BLURBS: Readonly<Record<string, string>> = {
  legion_gladius: "A drilled soldier's short blade, bronze-hilted and battle-polished.",
  barrow_blade: "Pulled from a frost barrow. The edge never quite warms.",
  tidefang_sabre: "Curved like a breaking wave, set with a shark's tooth.",
  troll_cleaver: "Heavy, crude and proud of it.",
  rimebeard_axe: "Rimed iron bound in northern fur.",
  packfang_axe: "Fang-toothed haft from the wolf runs.",
  owlfeather_longbow: "Silent fletching, pale wood, a hunter's patience.",
  grovewood_bow: "Living heartwood that still puts out blossoms.",
  steppe_horn_bow: "Horn-and-sinew recurve from the open plains.",
  kappa_shell_crossbow: "Shell-plated stock, river-green and lacquered.",
  scrap_iron_arbalest: "Goblin engineering. It works, mostly.",
  stormlatch_crossbow: "A charged core hums in the latch.",
  merfolk_trident: "Three tines of reef-forged steel.",
  centaur_lance: "Long, plumed and built for the charge.",
  reefspear: "Coral heartstone set in a sea-worn shaft.",
  livingwood_staff: "Still growing. Prune with care.",
  hexwood_crook: "Grave vine twisted around a mana shard.",
  pilgrim_staff: "Ibex horn and yak wool for the long road.",
  pantherclaw_stars: "Claw-tipped and rosette-marked.",
  runestar: "Rune fragments etched into each point.",
  viper_stars: "Venom-grooved and quick.",
  riverhide_sling: "Beaver and otter hide, stitched tight.",
  steppe_sling: "Horsehair-tasseled, plains-made.",
  nixie_sling: "A lakeglass tear for a pouch.",
  "mask-1": "Red-faced, horned and grinning. Wards off spirits, and most people.",
  "kitsune-mask": "A painted fox spirit with cherry blossoms and a silk bow.",
  "mask-3": "A bright painted skull for festival nights.",
  "hockey-mask": "Scuffed, cracked and a little unsettling.",
  "mask-2": "A pale smiling face with a thin moustache.",
  haunted_manor: "Crooked gables, cold drafts, and a lantern that is never lit by anyone.",
  samurai_manor: "Tiered roofs and paper screens around a quiet inner hall."
};

export function shopItemBlurb(item: GlimmerShopCatalogItem): string {
  return BLURBS[item.kind === "weapon" ? item.grantItemId : item.grantVariant] ?? "";
}

export function shopItemSubtitle(item: GlimmerShopCatalogItem): string {
  if (item.kind === "weapon") {
    const kind = shopWeaponKind(item);
    return kind ? `${WEAPON_TYPES[kind.type]} · ${kind.className} swag` : "Swag weapon";
  }
  if (item.kind === "mask") return "Mask · Any class";
  if (item.kind === "manor_skin") return `Manor skin · ${MANOR_VIEWS.length} views`;
  return "Swag armour";
}

export function shopItemLabel(item: GlimmerShopCatalogItem): string {
  return item.kind === "weapon" ? "Swag weapon" : item.kind === "mask" ? "Mask" : item.kind === "manor_skin" ? "Manor skin" : "Swag armour";
}

export function clampShopQuantity(value: number): number {
  return Math.max(1, Math.min(GLIMMER_SHOP_MAX_QUANTITY, Math.round(Number.isFinite(value) ? value : 1)));
}

export type ShopCart = Readonly<Record<string, number>>;
export type ShopCartLine = Readonly<{ item: GlimmerShopCatalogItem; quantity: number }>;

export function shopCartLines(cart: ShopCart, items: readonly GlimmerShopCatalogItem[]): readonly ShopCartLine[] {
  return items.flatMap((item) => (cart[item.sku] ? [{ item, quantity: cart[item.sku]! }] : []));
}

export function shopCartTotal(lines: readonly ShopCartLine[]): number {
  return lines.reduce((sum, { item, quantity }) => sum + item.priceGlimmer * quantity, 0);
}

export function shopCartCount(cart: ShopCart): number {
  return Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
}

/** Built-in bonus of a Glimmer pack: Glimmer minus 100 per dollar of the price, rounded ("1,000 + 50 bonus"). */
export function glimmerPackBonus(glimmer: number, usdCents: number): Readonly<{ base: number; bonus: number; percent: number }> {
  const base = Math.round(usdCents / 100) * 100;
  const bonus = Math.max(0, glimmer - base);
  return { base, bonus, percent: base > 0 ? Math.round((bonus / base) * 1000) / 10 : 0 };
}

const SHOP_ERROR_TEXT: Readonly<Record<string, string>> = {
  SHOP_INVALID_REQUEST: "That purchase could not be read. Check your cart and try again.",
  SHOP_ITEM_UNAVAILABLE: "One of those items is no longer for sale.",
  SHOP_PRICE_CHANGED: "A price changed, so nothing was bought. The shop has been refreshed.",
  SHOP_INSUFFICIENT_GLIMMER: "You do not have enough Glimmer for that.",
  SHOP_INVENTORY_FULL: "Your inventory is full. Make room and try again; nothing was bought.",
  SHOP_IDEMPOTENCY_CONFLICT: "That purchase was already submitted. Check your inventory.",
  SHOP_UNAVAILABLE: "The shop is not available right now.",
  SHOP_FAILED: "The purchase failed and you were not charged. Try again."
};

export function shopErrorText(code: string, serverMessage: string): string {
  return SHOP_ERROR_TEXT[code] ?? (serverMessage || SHOP_ERROR_TEXT.SHOP_FAILED!);
}
