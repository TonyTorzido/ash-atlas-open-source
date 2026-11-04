import { CITY_MARKET_STANDARD_BUYER_TAX_BPS } from "@ash-atlas/shared";
import type {
  MarketBookSnapshot,
  MarketCollectionScope,
  MarketMutationResult,
  MarketPriceCurrency,
  MarketQuote,
  MarketSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import {
  MarketAccessPolicy,
  type AuthorizedMarketVenue
} from "./marketAccess.js";
import type {
  MarketBrowseInput,
  MarketReadService
} from "./marketReadService.js";
import type { MarketActor } from "./marketRules.js";
import {
  MarketService,
  type CreateMarketOrderInput
} from "./marketService.js";

const LEGACY_TEST_CONNECTION_ID = "legacy-market-test-connection";
const LEGACY_TEST_SESSION_ID = "00000000-0000-4000-8000-000000000601";
export const LEGACY_TEST_VENUE_ID = "00000000-0000-4000-8000-000000000600";

export const LEGACY_TEST_AUTHORITY: AuthorizedMarketVenue = {
  sessionId: LEGACY_TEST_SESSION_ID,
  venueId: LEGACY_TEST_VENUE_ID,
  venueKey: "global",
  displayName: "Ash Atlas Global Exchange",
  cityId: "00000000-0000-4000-8000-000000000602",
  cityName: "Legacy Market Test City",
  marketStructureId: "00000000-0000-4000-8000-000000000603",
  activeMonumentTypes: [],
  taxRevision: "1",
  relocationRevision: 0
};

type LegacyMarketReadService = Omit<
  MarketReadService,
  "snapshot" | "book" | "assertSubscriptionAccess"
> & {
  snapshot(actor: MarketActor, input?: MarketBrowseInput): Promise<MarketSnapshot>;
  book(
    actor: MarketActor,
    itemId: string,
    requestedDepth?: number,
    priceCurrency?: MarketPriceCurrency
  ): Promise<MarketBookSnapshot>;
  assertSubscriptionAccess(actor: MarketActor): Promise<AuthorizedMarketVenue>;
};

export type LegacyMarketTestService = Omit<
  MarketService,
  "read" | "quote" | "createOrder" | "simpleBuy" | "cancelOrder" | "claim"
> & {
  read: LegacyMarketReadService;
  quote(
    actor: MarketActor,
    requestId: string,
    itemId: string,
    quantity: string,
    maximumUnitPrice?: string,
    priceCurrency?: MarketPriceCurrency
  ): Promise<MarketQuote>;
  createOrder(
    actor: MarketActor,
    input: CreateMarketOrderInput
  ): Promise<MarketMutationResult>;
  simpleBuy(
    actor: MarketActor,
    requestId: string,
    quoteId: string,
    maximumTotal: string
  ): Promise<MarketMutationResult>;
  cancelOrder(
    actor: MarketActor,
    requestId: string,
    orderId: string
  ): Promise<MarketMutationResult>;
  claim(
    actor: MarketActor,
    requestId: string,
    scope: MarketCollectionScope
  ): Promise<MarketMutationResult>;
};

/**
 * Keeps pre-localization market suites useful without weakening production
 * session authority. New coverage must use physical City Market sessions.
 */
export function createLegacyMarketTestService(
  pool: pg.Pool,
  config: AppConfig,
  logger: AppLogger,
  options: ConstructorParameters<typeof MarketService>[3] = {}
): LegacyMarketTestService {
  if (config.NODE_ENV !== "test") {
    throw new Error("Legacy market adapter is test-only");
  }
  const access = new LegacyMarketTestAccess(config);
  const core = new MarketService(pool, config, logger, {
    ...options,
    access,
    districtBenefits: options.districtBenefits ?? {
      async resolveMarketTax() {
        return {
          cityId: LEGACY_TEST_AUTHORITY.cityId,
          districtType: null,
          monumentTier: null,
          taxRevision: "1",
          buyerTaxBps: CITY_MARKET_STANDARD_BUYER_TAX_BPS,
          specialtyApplied: false,
          qualifyingTaxTag: null
        };
      }
    }
  });
  const read = new Proxy(core.read, {
    get(target, property, receiver) {
      if (property === "snapshot") {
        return (actor: MarketActor, input?: MarketBrowseInput) =>
          target.snapshot(actor, LEGACY_TEST_AUTHORITY, input);
      }
      if (property === "book") {
        return (actor: MarketActor, itemId: string, requestedDepth?: number, priceCurrency?: MarketPriceCurrency) =>
          target.book(actor, LEGACY_TEST_AUTHORITY, itemId, requestedDepth, priceCurrency);
      }
      if (property === "assertSubscriptionAccess") {
        return (actor: MarketActor) =>
          target.assertSubscriptionAccess(
            actor,
            LEGACY_TEST_CONNECTION_ID,
            LEGACY_TEST_SESSION_ID
          );
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as unknown as LegacyMarketReadService;

  return new Proxy(core, {
    get(target, property, receiver) {
      if (property === "read") return read;
      if (property === "quote") {
        return (
          actor: MarketActor,
          requestId: string,
          itemId: string,
          quantity: string,
          maximumUnitPrice?: string,
          priceCurrency?: MarketPriceCurrency
        ) => target.quote(
          actor,
          LEGACY_TEST_CONNECTION_ID,
          LEGACY_TEST_SESSION_ID,
          requestId,
          itemId,
          quantity,
          maximumUnitPrice,
          priceCurrency
        );
      }
      if (property === "createOrder") {
        return (actor: MarketActor, input: CreateMarketOrderInput) =>
          target.createOrder(
            actor,
            LEGACY_TEST_CONNECTION_ID,
            LEGACY_TEST_SESSION_ID,
            input
          );
      }
      if (property === "simpleBuy") {
        return (
          actor: MarketActor,
          requestId: string,
          quoteId: string,
          maximumTotal: string
        ) => target.simpleBuy(
          actor,
          LEGACY_TEST_CONNECTION_ID,
          LEGACY_TEST_SESSION_ID,
          requestId,
          quoteId,
          maximumTotal
        );
      }
      if (property === "cancelOrder") {
        return (actor: MarketActor, requestId: string, orderId: string) =>
          target.cancelOrder(
            actor,
            LEGACY_TEST_CONNECTION_ID,
            LEGACY_TEST_SESSION_ID,
            requestId,
            orderId
          );
      }
      if (property === "claim") {
        return (
          actor: MarketActor,
          requestId: string,
          scope: MarketCollectionScope
        ) => target.claim(
          actor,
          LEGACY_TEST_CONNECTION_ID,
          LEGACY_TEST_SESSION_ID,
          requestId,
          scope
        );
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as unknown as LegacyMarketTestService;
}

export async function activateLegacyGlobalMarketForTest(
  pool: pg.Pool
): Promise<void> {
  await pool.query(
    `INSERT INTO market_venues (
       venue_id,
       venue_key,
       display_name,
       scope_type,
       access_policy_id,
       fee_policy_id,
       active,
       state
     )
     VALUES ($1, 'global', 'Ash Atlas Global Exchange', 'global_test', 'global-development-v1', 2, true, 'active')
     ON CONFLICT (venue_id) DO UPDATE
     SET active = true,
         state = 'active'`,
    [LEGACY_TEST_VENUE_ID]
  );
  await pool.query(
    `INSERT INTO market_venue_controls (
       venue_id,
       frozen,
       new_orders_enabled,
       matching_enabled,
       cancellations_enabled,
       claims_enabled
     )
     VALUES ($1, false, true, true, true, true)
     ON CONFLICT (venue_id) DO UPDATE
     SET frozen = false,
         new_orders_enabled = true,
         matching_enabled = true,
         cancellations_enabled = true,
         claims_enabled = true,
         updated_at = clock_timestamp()`,
    [LEGACY_TEST_VENUE_ID]
  );
}

class LegacyMarketTestAccess extends MarketAccessPolicy {
  override async openSession(): Promise<AuthorizedMarketVenue> {
    return LEGACY_TEST_AUTHORITY;
  }

  override async requireSession(): Promise<AuthorizedMarketVenue> {
    return LEGACY_TEST_AUTHORITY;
  }

  override async isAccessAllowed(): Promise<boolean> {
    return true;
  }

  override async assertAccess(): Promise<void> {
    return;
  }
}
