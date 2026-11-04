import {
  isActiveResourceType,
  LUMEN_ITEM_ID,
  PREMIUM_CURRENCIES,
  RESOURCE_TYPES,
  type PlayerInventorySnapshot,
  type PremiumCurrency,
  type PremiumWalletSnapshot,
  type InventoryItemType
} from "@ash-atlas/shared";
import type pg from "pg";

import { InventoryService, isInventoryCapacityError, type InventoryGrantResult } from "./inventory.js";
import type { FishingService } from "./fishing.js";
import type {
  CityTreasuryService,
  CityContributionCreditInput
} from "./cityTreasury.js";
import { requireItemDefinition } from "./items.js";
import { PremiumWalletService } from "./premiumWallet.js";
import { WalletService } from "./wallet.js";

export const DEVELOPMENT_GRANT_MAX = 1_000_000n;
export const DEVELOPMENT_GRANT_REASON = "development_market_testing_grant";
/**
 * Inventory source of the audited Lumen admin grant. Lumen is a carried item;
 * 0917 admits this source, custody moves and its own migration as the only
 * Lumen inventory credits.
 */
export const LUMEN_ADMIN_GRANT_SOURCE = "lumen_admin_grant";
export type DevelopmentGrant = {
  gold?: bigint;
  cityCoins?: bigint;
  /** Audited admin grants; the only credit path for premium currencies. */
  premium?: Readonly<Partial<Record<PremiumCurrency, bigint>>>;
  /** Audited admin Lumen grant, credited to the player's inventory. */
  lumen?: bigint;
  materials?: readonly { itemId: InventoryItemType; quantity: bigint }[];
};
export type DevelopmentCityCoinGrantResult = {
  creditedAmount: number;
  cityId: string;
  cityName: string;
  treasuryBalance: string;
  playerContribution: string;
};
export type DevelopmentGrantResult = {
  replayed: boolean;
  walletGold: bigint;
  walletVersion: bigint;
  inventory: PlayerInventorySnapshot;
  grants: InventoryGrantResult[];
  cityCoins: DevelopmentCityCoinGrantResult | null;
  /** Present only when the grant included a premium currency. */
  premiumWallet: PremiumWalletSnapshot | null;
};
type DevelopmentWallet = Pick<WalletService, "creditForOperationInTransaction">;
type DevelopmentPremiumWallet = Pick<
  PremiumWalletService,
  "creditForOperationInTransaction" | "snapshotInTransaction"
>;
type DevelopmentInventory = Pick<InventoryService, "grantItemsForOperationInTransaction" | "snapshotInTransaction">;
type DevelopmentFishing = Pick<FishingService, "grantDurableRodsInTransaction">;
type DevelopmentTreasury = Pick<
  CityTreasuryService,
  | "activeMembershipForPlayerInTransaction"
  | "contributionOperationInTransaction"
  | "creditContributionInTransaction"
>;

export class DevelopmentEconomyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DevelopmentEconomyError";
  }
}

export class DevelopmentEconomyService {
  private readonly wallet: DevelopmentWallet;
  private readonly premiumWallet: DevelopmentPremiumWallet;
  private readonly inventory: DevelopmentInventory;
  private readonly cityTreasury: DevelopmentTreasury | null;
  constructor(private readonly pool: pg.Pool, options: {
    wallet?: DevelopmentWallet;
    premiumWallet?: DevelopmentPremiumWallet;
    inventory?: DevelopmentInventory;
    fishing?: DevelopmentFishing;
    cityTreasury?: DevelopmentTreasury | null;
  } = {}) {
    this.wallet = options.wallet ?? new WalletService();
    this.premiumWallet = options.premiumWallet ?? new PremiumWalletService();
    this.inventory = options.inventory ?? new InventoryService(pool);
    this.fishing = options.fishing ?? null;
    this.cityTreasury = options.cityTreasury ?? null;
  }

  private readonly fishing: DevelopmentFishing | null;

  async grant(playerId: string, accountId: string, requestId: string, grant: DevelopmentGrant): Promise<DevelopmentGrantResult> {
    const materials = [...(grant.materials ?? [])];
    const premiumGrants = PREMIUM_CURRENCIES.flatMap((currency) => {
      const amount = grant.premium?.[currency];
      return amount === undefined ? [] : [{ currency, amount }];
    });
    if (
      !requestId ||
      (
        grant.gold === undefined &&
        grant.cityCoins === undefined &&
        premiumGrants.length === 0 &&
        grant.lumen === undefined &&
        materials.length === 0
      )
    ) throw new Error("Development grant must contain an asset");
    if (grant.gold !== undefined) assertQuantity(grant.gold);
    if (grant.cityCoins !== undefined) assertQuantity(grant.cityCoins);
    for (const premium of premiumGrants) assertQuantity(premium.amount);
    if (grant.lumen !== undefined) assertQuantity(grant.lumen);
    for (const material of materials) {
      assertQuantity(material.quantity);
      requireItemDefinition(material.itemId);
      if (material.itemId === LUMEN_ITEM_ID) {
        throw new Error("Lumen is granted only through the audited premium grant");
      } else if (material.itemId === "fishing_rod") {
        if (material.quantity !== 1n) {
          throw new Error("Fishing Rod grants must contain exactly one durable rod.");
        }
      } else if (
        !RESOURCE_TYPES.includes(material.itemId as (typeof RESOURCE_TYPES)[number]) ||
        !isActiveResourceType(material.itemId as (typeof RESOURCE_TYPES)[number])
      ) {
        throw new Error(`${material.itemId} is not currently grantable`);
      }
    }
    if (new Set(materials.map((material) => material.itemId)).size !== materials.length) throw new Error("Development material grant contains duplicates");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const walletResult = grant.gold === undefined ? null : await this.wallet.creditForOperationInTransaction(client, {
        playerId, accountId, amount: grant.gold, operationKey: `dev-grant:${requestId}:gold`, reason: DEVELOPMENT_GRANT_REASON
      });
      let premiumApplied = false;
      for (const premium of premiumGrants) {
        const credit = await this.premiumWallet.creditForOperationInTransaction(client, {
          accountId,
          currency: premium.currency,
          amount: premium.amount,
          operationKey: `dev-grant:${requestId}:${premium.currency}`,
          reason: "admin",
          actorPlayerId: playerId,
          refType: "developer_request",
          refId: requestId,
          metadata: { source: DEVELOPMENT_GRANT_REASON, operatorAccountId: accountId }
        });
        premiumApplied ||= credit.applied;
      }
      const premiumWallet = premiumGrants.length === 0
        ? null
        : await this.premiumWallet.snapshotInTransaction(client, accountId);
      const lumenResult = grant.lumen === undefined
        ? null
        : await this.inventory.grantItemsForOperationInTransaction(client, {
            operationKey: `dev-grant:${requestId}:lumen`,
            playerId,
            source: LUMEN_ADMIN_GRANT_SOURCE,
            sourceEntityType: "developer_request",
            sourceEntityId: requestId,
            metadata: { source: DEVELOPMENT_GRANT_REASON, operatorAccountId: accountId },
            grants: [{ itemId: LUMEN_ITEM_ID, variant: null, quantity: grant.lumen }]
          });
      const commodityMaterials = materials.filter((material) => material.itemId !== "fishing_rod");
      const rodMaterial = materials.find((material) => material.itemId === "fishing_rod");
      const commodityResult = commodityMaterials.length > 0
        ? await this.inventory.grantItemsForOperationInTransaction(client, {
            operationKey: `dev-grant:${requestId}:materials`, playerId, source: DEVELOPMENT_GRANT_REASON,
            sourceEntityType: "authenticated_developer", sourceEntityId: accountId,
            metadata: { requestId },
            grants: commodityMaterials.map((material) => ({ itemId: material.itemId, variant: null, quantity: material.quantity }))
          })
        : {
            applied: false,
            inventory: await this.inventory.snapshotInTransaction(client, playerId),
            grants: []
          };
      const rodResult = rodMaterial
        ? await this.requireFishing().grantDurableRodsInTransaction(client, {
            operationKey: `dev-grant:${requestId}:fishing-rods`,
            playerId,
            quantity: rodMaterial.quantity,
            source: DEVELOPMENT_GRANT_REASON,
            sourceEntityType: "authenticated_developer",
            sourceEntityId: accountId,
            metadata: { requestId }
          })
        : null;
      const inventoryResult = {
        applied: (lumenResult?.applied ?? false) || commodityResult.applied || (rodResult?.applied ?? false),
        inventory: rodResult?.inventory ?? commodityResult.inventory,
        grants: [...(lumenResult?.grants ?? []), ...commodityResult.grants, ...(rodResult?.grants ?? [])]
      };
      let cityCoins: DevelopmentCityCoinGrantResult | null = null;
      let cityApplied = false;
      if (grant.cityCoins !== undefined) {
        if (!this.cityTreasury) {
          throw new DevelopmentEconomyError(
            "DEV_CITY_TREASURY_UNAVAILABLE",
            "City treasury service is unavailable"
          );
        }
        const operationKey = `dev-grant:${requestId}:city-coins`;
        const replay =
          await this.cityTreasury.contributionOperationInTransaction(
            client,
            operationKey
          );
        const membership = replay ?? (
          await this.cityTreasury.activeMembershipForPlayerInTransaction(
            client,
            playerId
          )
        );
        if (!membership) {
          throw new DevelopmentEconomyError(
            "DEV_CITY_MEMBERSHIP_REQUIRED",
            "Join a city before granting City Coins."
          );
        }
        const amount = Number(grant.cityCoins);
        const cityInput: CityContributionCreditInput = {
          operationKey,
          cityId: membership.cityId,
          playerId,
          membershipId: membership.membershipId,
          amount,
          sourceType: "development_grant",
          sourceId: requestId,
          ledgerEntryType: "development_grant",
          metadata: { accountId, requestId }
        };
        const credit =
          await this.cityTreasury.creditContributionInTransaction(
            client,
            cityInput
          );
        cityApplied = credit.applied;
        cityCoins = {
          creditedAmount: amount,
          cityId: membership.cityId,
          cityName: membership.cityName,
          treasuryBalance: credit.balance,
          playerContribution: credit.contribution
        };
      }
      const walletSnapshot = walletResult
        ? null
        : await client.query<{ gold_balance: string; version: string }>(
            "SELECT gold_balance::text, version::text FROM player_wallets WHERE player_id=$1 AND account_id=$2",
            [playerId, accountId]
          );
      const balance = walletResult?.goldBalance ??
        BigInt(walletSnapshot?.rows[0]?.gold_balance ?? "0");
      const walletVersion = walletResult?.version ??
        BigInt(walletSnapshot?.rows[0]?.version ?? "0");
      await client.query("COMMIT");
      return {
        replayed: !(walletResult?.applied ?? false) &&
          !inventoryResult.applied &&
          !cityApplied &&
          !premiumApplied,
        walletGold: balance,
        walletVersion,
        inventory: inventoryResult.inventory,
        grants: inventoryResult.grants,
        cityCoins,
        premiumWallet
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new DevelopmentEconomyError("DEV_CARRY_CAPACITY_EXCEEDED", "This grant would exceed carrying capacity.");
      throw error;
    } finally { client.release(); }
  }

  private requireFishing(): DevelopmentFishing {
    if (!this.fishing) {
      throw new DevelopmentEconomyError(
        "DEV_FISHING_SERVICE_UNAVAILABLE",
        "Fishing Rod grants are unavailable"
      );
    }
    return this.fishing;
  }
}

function assertQuantity(quantity: bigint): void {
  if (quantity <= 0n || quantity > DEVELOPMENT_GRANT_MAX) throw new Error(`Development grant quantity must be between 1 and ${DEVELOPMENT_GRANT_MAX}`);
}
