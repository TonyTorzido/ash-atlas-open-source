import type { ShopProvenance } from "@ash-atlas/shared";

/** "#7KQ3-M9XD": the permanent tag of a Glimmer Shop copy. */
export function shopTagLabel(provenance: ShopProvenance): string {
  return `Tag #${provenance.tag}`;
}

/** Details of a tagged copy: its tag and original buyer (inventory, market and trade views). */
export function ShopProvenanceDetails({ provenance }: Readonly<{ provenance: ShopProvenance }>): React.JSX.Element {
  return <dl className="shop-provenance" aria-label="Item details">
    <div><dt>Tag</dt><dd>#{provenance.tag}</dd></div>
    <div><dt>Originally bought by</dt><dd>{provenance.originalBuyerName}</dd></div>
  </dl>;
}
