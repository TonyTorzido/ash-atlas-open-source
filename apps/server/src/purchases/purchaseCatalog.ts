import {
  PREMIUM_PRODUCT_SKUS,
  type PremiumProductKind,
  type PremiumProductSku,
  type PremiumProductView
} from "@ash-atlas/shared";
import type pg from "pg";

export type PremiumProduct = Readonly<{
  sku: PremiumProductSku;
  kind: PremiumProductKind;
  glimmerAmount: bigint;
  firstPurchaseBonusGlimmer: bigint;
  usdCents: number;
  period: "month" | "year" | null;
  appleProductId: string;
  googleProductId: string;
  webSku: string;
  active: boolean;
}>;

type ProductRow = {
  sku: string;
  kind: PremiumProductKind;
  glimmer_amount: string;
  first_purchase_bonus_glimmer: string;
  usd_cents: number;
  period: "month" | "year" | null;
  apple_product_id: string;
  google_product_id: string;
  web_sku: string;
  active: boolean;
};

const CACHE_MS = 60_000;

/** premium_products, cached briefly; the database row is authoritative for every grant. */
export class PremiumCatalog {
  private cached: { at: number; products: readonly PremiumProduct[] } | null = null;

  constructor(private readonly pool: Pick<pg.Pool, "query">, private readonly now: () => number = Date.now) {}

  async all(): Promise<readonly PremiumProduct[]> {
    if (this.cached && this.now() - this.cached.at < CACHE_MS) return this.cached.products;
    const products = await loadPremiumProducts(this.pool);
    this.cached = { at: this.now(), products };
    return products;
  }

  async bySku(sku: string): Promise<PremiumProduct | null> {
    return (await this.all()).find((product) => product.sku === sku && product.active) ?? null;
  }

  async byStoreProductId(platform: "apple" | "google" | "web", id: string): Promise<PremiumProduct | null> {
    return (await this.all()).find((product) => product.active && (
      platform === "apple" ? product.appleProductId === id
        : platform === "google" ? product.googleProductId === id
          : product.webSku === id
    )) ?? null;
  }
}

export async function loadPremiumProducts(queryable: Pick<pg.Pool, "query">): Promise<PremiumProduct[]> {
  const result = await queryable.query<ProductRow>(
    `SELECT sku, kind, glimmer_amount::text, first_purchase_bonus_glimmer::text, usd_cents,
            period, apple_product_id, google_product_id, web_sku, active
     FROM premium_products ORDER BY sort_order, sku`
  );
  return result.rows
    .filter((row) => (PREMIUM_PRODUCT_SKUS as readonly string[]).includes(row.sku))
    .map((row) => ({
      sku: row.sku as PremiumProductSku,
      kind: row.kind,
      glimmerAmount: BigInt(row.glimmer_amount),
      firstPurchaseBonusGlimmer: BigInt(row.first_purchase_bonus_glimmer),
      usdCents: row.usd_cents,
      period: row.period,
      appleProductId: row.apple_product_id,
      googleProductId: row.google_product_id,
      webSku: row.web_sku,
      active: row.active
    }));
}

export function productView(product: PremiumProduct): PremiumProductView {
  return {
    sku: product.sku,
    kind: product.kind,
    glimmer: Number(product.glimmerAmount),
    firstPurchaseBonusGlimmer: Number(product.firstPurchaseBonusGlimmer),
    usdCents: product.usdCents,
    period: product.period,
    appleProductId: product.appleProductId,
    googleProductId: product.googleProductId,
    webSku: product.webSku
  };
}

/** End of a pass period that starts at `start` (calendar month or year, UTC). */
export function addPassPeriod(start: Date, period: "month" | "year"): Date {
  const end = new Date(start.getTime());
  if (period === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}
