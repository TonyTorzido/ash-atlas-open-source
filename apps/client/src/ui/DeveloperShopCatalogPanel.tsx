import {
  GLIMMER_SHOP_MAX_PRICE,
  GLIMMER_SHOP_SOURCES,
  type GlimmerShopCatalogEdit,
  type GlimmerShopCatalogItem,
  type GlimmerShopSource
} from "@ash-atlas/shared";
import { useCallback, useEffect, useState } from "react";

import { requestIdCrypto as crypto } from "../requestId.js";
import { shopItemArtUrl, shopArtTilted } from "../shop/shopModel.js";
import "./ShopApp.css";

const SOURCE_LABELS: Readonly<Record<GlimmerShopSource, string>> = {
  craft: "Craftable (not sold)",
  shop: "Glimmer Shop only"
};

/** Developer App -> Shop catalog: source, price, featured, on sale and new per row; edits apply without a deploy. */
export function DeveloperShopCatalogPanel({ serverHttpBase, csrfToken }: Readonly<{
  serverHttpBase: string;
  csrfToken: string;
}>): React.JSX.Element {
  const [items, setItems] = useState<readonly GlimmerShopCatalogItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingSku, setSavingSku] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(new URL("/api/dev/shop/catalog", serverHttpBase), { credentials: "include" });
      if (!response.ok) throw new Error("Could not load the shop catalog.");
      setItems(((await response.json()) as { items: GlimmerShopCatalogItem[] }).items);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the shop catalog.");
    }
  }, [serverHttpBase]);
  useEffect(() => { void load(); }, [load]);

  const save = async (sku: string, edit: Omit<GlimmerShopCatalogEdit, "operationKey">): Promise<void> => {
    setSavingSku(sku);
    try {
      const response = await fetch(new URL(`/api/dev/shop/catalog/${encodeURIComponent(sku)}`, serverHttpBase), {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ operationKey: crypto.randomUUID(), ...edit })
      });
      if (!response.ok) throw new Error("The change was refused.");
      const { item } = (await response.json()) as { item: GlimmerShopCatalogItem };
      setItems((current) => current?.map((entry) => entry.sku === item.sku ? item : entry) ?? current);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change failed.");
      void load();
    } finally {
      setSavingSku(null);
    }
  };

  return <section className="developer-economy-section" aria-label="Shop catalog">
    <span className="eyebrow">Shop catalog</span>
    <p className="muted">
      Pick where each item comes from, its Glimmer price, and whether it is featured, on sale or new. "Craftable"
      keeps the Smithing recipe and hides it from the shop. "Glimmer Shop only" sells it and removes the recipe. Nothing is both. Changes apply without a deploy.
    </p>
    {error ? <p className="muted" role="alert">{error}</p> : null}
    {items === null && !error ? <p className="muted" role="status">Loading…</p> : null}
    {items ? <div className="shop-admin-wrap"><table className="shop-admin-table">
      <thead><tr><th>Item</th><th>Type</th><th>Source</th><th>Price (Glimmer)</th><th>Featured</th><th>On sale</th><th>New</th></tr></thead>
      <tbody>{items.map((item) => {
        const busy = savingSku === item.sku;
        const url = shopItemArtUrl(item);
        return <tr key={item.sku}>
          <td><span className="shop-admin-item"><span className="shop-art">{url ? <img src={url} alt="" className={shopArtTilted(item) ? "shop-art-tilted" : undefined} /> : null}</span>{item.displayName}</span></td>
          <td>{item.kind === "manor_skin" ? "Manor" : item.kind[0]!.toUpperCase() + item.kind.slice(1)}</td>
          <td>{item.source === null ? "Shop" : <select
            aria-label={`${item.displayName} source`}
            value={item.source}
            disabled={busy}
            onChange={(event) => void save(item.sku, { source: event.target.value as GlimmerShopSource })}
          >{GLIMMER_SHOP_SOURCES.map((source) => <option key={source} value={source}>{SOURCE_LABELS[source]}</option>)}</select>}</td>
          <td><input
            type="number"
            aria-label={`${item.displayName} price`}
            min={1}
            max={GLIMMER_SHOP_MAX_PRICE}
            step={25}
            defaultValue={item.priceGlimmer}
            key={`${item.sku}:${item.priceGlimmer}`}
            disabled={busy}
            onBlur={(event) => {
              const value = Math.round(Number(event.target.value));
              if (value >= 1 && value <= GLIMMER_SHOP_MAX_PRICE && value !== item.priceGlimmer) void save(item.sku, { priceGlimmer: value });
            }}
          /></td>
          {(["featured", "onSale", "isNew"] as const).map((field) => <td key={field}><input
            type="checkbox"
            className="shop-switch"
            aria-label={`${item.displayName} ${field === "isNew" ? "new" : field === "onSale" ? "on sale" : "featured"}`}
            checked={item[field]}
            disabled={busy}
            onChange={(event) => void save(item.sku, { [field]: event.target.checked })}
          /></td>)}
        </tr>;
      })}</tbody>
    </table></div> : null}
  </section>;
}
