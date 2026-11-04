import { z } from "zod";

import type { EquipmentSnapshotV2 } from "./equipment.js";
import type { PlayerInventorySnapshot } from "./collectibles.js";
import {
  PLAYER_PACKAGE_ITEM_CATALOG,
  type InventoryCatalogKind,
  type InventoryCatalogItem
} from "./inventoryCatalog.js";

export const PLAYER_PACKAGE_ADMIN_API_BASE = "/api/admin/player-packages" as const;

export const PLAYER_PACKAGE_LIMITS = Object.freeze({
  maximumLines: 24,
  maximumQuantityPerLine: 10_000,
  maximumEquipmentInstances: 100,
  maximumTitleLength: 80,
  maximumMessageLength: 280,
  maximumSpecificRecipients: 200,
  maximumCharacterSearchResults: 25
});

export const PLAYER_PACKAGE_STATUSES = ["unopened", "partial", "claimed"] as const;
export type PlayerPackageStatus = (typeof PLAYER_PACKAGE_STATUSES)[number];
export type PlayerPackageTargetMode = "all" | "specific";
export const PLAYER_PACKAGE_KINDS = ["admin", "player_gift"] as const;
export type PlayerPackageKind = (typeof PLAYER_PACKAGE_KINDS)[number];
export type PlayerPackageAssetKind =
  | InventoryCatalogKind
  | "gold"
  | "city_coins";
export type PlayerPackageAssetType = "physical" | "currency";

export type PlayerPackageCatalogItem = Readonly<{
  itemId: string;
  kind: PlayerPackageAssetKind;
  assetType: PlayerPackageAssetType;
  displayName: string;
  category: string;
  iconKey: string;
  stackable: boolean;
  maxStack: number;
  supportedVariants: readonly string[];
  packageGrantable: true;
}>;

export type PlayerPackageAssetSnapshot = Readonly<{
  lineNumber: number;
  itemKind: PlayerPackageAssetKind;
  itemId: string;
  variant: string | null;
  displayName: string;
  iconKey: string;
  category: string;
  originalQuantity: number;
  remainingQuantity: number;
}>;
export type PlayerPackageItemSnapshot = PlayerPackageAssetSnapshot;

export type PlayerPackageSnapshot = Readonly<{
  packageId: string;
  campaignId: string;
  title: string;
  message: string;
  /** "Ash Atlas" for admin packages; the sender's display name for player gifts. */
  sender: string;
  kind: PlayerPackageKind;
  /** Set only for player gifts. */
  senderPlayerId: string | null;
  status: PlayerPackageStatus;
  readAt: string | null;
  firstClaimedAt: string | null;
  claimedAt: string | null;
  createdAt: string;
  revision: string;
  items: readonly PlayerPackageAssetSnapshot[];
}>;

export const PLAYER_PACKAGE_CLAIM_LINE_STATUSES = [
  "granted",
  "partially_granted",
  "blocked_city_membership",
  "blocked_inventory_capacity",
  "already_consumed"
] as const;
export type PlayerPackageClaimLineStatus =
  (typeof PLAYER_PACKAGE_CLAIM_LINE_STATUSES)[number];

export type PlayerPackageClaimLineResult = Readonly<{
  lineNumber: number;
  itemKind: PlayerPackageAssetKind;
  itemId: string;
  variant: string | null;
  requestedQuantity: number;
  grantedQuantity: number;
  remainingQuantity: number;
  status: PlayerPackageClaimLineStatus;
  blockedReason: "CITY_MEMBERSHIP_REQUIRED" | "INVENTORY_CAPACITY" | null;
}>;

export type PlayerPackageCityCredit = Readonly<{
  creditedAmount: number;
  cityId: string;
  cityName: string;
  treasuryBalance: string;
  playerContribution: string;
}>;

export type PlayerPackageClaimResult = Readonly<{
  requestId: string;
  replayed: boolean;
  walletGold: string;
  walletVersion?: string;
  cityCredit: PlayerPackageCityCredit | null;
  inventory: PlayerInventorySnapshot;
  equipment: EquipmentSnapshotV2;
  package: PlayerPackageSnapshot;
  lines: readonly PlayerPackageClaimLineResult[];
  message: string;
}>;

export type PlayerPackageCharacterSearchResult = Readonly<{
  playerId: string;
  displayName: string;
  identityHint: string;
  online: boolean;
}>;

export type PlayerPackageCampaignSummary = Readonly<{
  campaignId: string;
  title: string;
  targetMode: PlayerPackageTargetMode;
  recipientCount: number;
  unopenedCount: number;
  partialCount: number;
  claimedCount: number;
  createdAt: string;
}>;

const boundedPositiveInteger = z.number().int().positive()
  .max(PLAYER_PACKAGE_LIMITS.maximumQuantityPerLine);

const physicalPackageLineInputSchema = z.object({
  itemKind: z.enum(["resource", "consumable", "equipment"]),
  itemId: z.string().min(1).max(120),
  variant: z.string().min(1).max(80).nullable().optional(),
  quantity: boundedPositiveInteger
}).strict();

const goldPackageLineInputSchema = z.object({
  itemKind: z.literal("gold"),
  itemId: z.literal("gold"),
  variant: z.null().optional(),
  quantity: boundedPositiveInteger
}).strict();

const cityCoinPackageLineInputSchema = z.object({
  itemKind: z.literal("city_coins"),
  itemId: z.literal("city_coins"),
  variant: z.null().optional(),
  quantity: boundedPositiveInteger
}).strict();

export const playerPackageLineInputSchema = z.discriminatedUnion("itemKind", [
  physicalPackageLineInputSchema,
  goldPackageLineInputSchema,
  cityCoinPackageLineInputSchema
]);

export const createPlayerPackageCampaignSchema = z.object({
  operationKey: z.string().uuid(),
  targetMode: z.enum(["all", "specific"]),
  recipientPlayerIds: z.array(z.string().min(1).max(160))
    .max(PLAYER_PACKAGE_LIMITS.maximumSpecificRecipients),
  title: z.string().trim().min(1)
    .max(PLAYER_PACKAGE_LIMITS.maximumTitleLength),
  message: z.string().trim()
    .max(PLAYER_PACKAGE_LIMITS.maximumMessageLength),
  items: z.array(playerPackageLineInputSchema)
    .min(1)
    .max(PLAYER_PACKAGE_LIMITS.maximumLines),
  allCharactersConfirmation: z.literal("SEND").optional()
}).strict().superRefine((value, context) => {
  if (value.targetMode === "all") {
    if (value.recipientPlayerIds.length !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipientPlayerIds"],
        message: "All-character campaigns cannot include client-selected recipients"
      });
    }
    if (value.allCharactersConfirmation !== "SEND") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allCharactersConfirmation"],
        message: "All-character campaigns require the SEND confirmation"
      });
    }
  } else if (value.recipientPlayerIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recipientPlayerIds"],
      message: "Specific campaigns require at least one recipient"
    });
  }
});

export type CreatePlayerPackageCampaignInput = z.infer<
  typeof createPlayerPackageCampaignSchema
>;

export const playerPackageCharacterSearchQuerySchema = z.object({
  search: z.string().trim().max(64).default(""),
  limit: z.coerce.number().int().min(1)
    .max(PLAYER_PACKAGE_LIMITS.maximumCharacterSearchResults)
    .default(PLAYER_PACKAGE_LIMITS.maximumCharacterSearchResults),
  cursor: z.string().regex(/^\d+$/).optional()
}).strict();

export const requestPlayerPackagesMessageSchema = z.object({
  type: z.literal("REQUEST_PLAYER_PACKAGES"),
  requestId: z.string().uuid()
}).strict();

export const claimPlayerPackageMessageSchema = z.object({
  type: z.literal("CLAIM_PLAYER_PACKAGE"),
  requestId: z.string().uuid(),
  packageId: z.string().uuid(),
  expectedRevision: z.string().regex(/^\d+$/)
}).strict();

const VIRTUAL_PACKAGE_ASSETS: readonly PlayerPackageCatalogItem[] = Object.freeze([
  {
    itemId: "gold",
    kind: "gold",
    assetType: "currency",
    displayName: "Gold",
    category: "currency",
    iconKey: "gold",
    stackable: true,
    maxStack: PLAYER_PACKAGE_LIMITS.maximumQuantityPerLine,
    supportedVariants: [],
    packageGrantable: true
  },
  {
    itemId: "city_coins",
    kind: "city_coins",
    assetType: "currency",
    displayName: "City Coins",
    category: "city treasury",
    iconKey: "city_coins",
    stackable: true,
    maxStack: PLAYER_PACKAGE_LIMITS.maximumQuantityPerLine,
    supportedVariants: [],
    packageGrantable: true
  }
]);

export function playerPackageCatalog(): readonly PlayerPackageCatalogItem[] {
  return Object.freeze([
    ...VIRTUAL_PACKAGE_ASSETS,
    ...PLAYER_PACKAGE_ITEM_CATALOG.map((item: InventoryCatalogItem) => ({
      ...item,
      assetType: "physical" as const,
      packageGrantable: true as const
    }))
  ]);
}
