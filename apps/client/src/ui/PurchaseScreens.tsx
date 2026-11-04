import { ATLAS_PASS_DAILY_LUMEN, ATLAS_PASS_FIRST_LUMEN, type PremiumProductView } from "@ash-atlas/shared";

import type { PurchasesController } from "../purchases/usePurchases.js";
import { glimmerPackBonus } from "../shop/shopModel.js";
import { CurrencyGlyph } from "./InventoryCarryList.js";
import {
  GameAppButton,
  GameAppCard,
  GameAppSectionHeader,
  GameAppShell,
  GameAppState,
  GameAppText
} from "./GameAppShell.js";

export const TERMS_URL = "https://playashatlas.com/terms";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function priceLabel(purchases: PurchasesController, product: PremiumProductView): string | null {
  if (purchases.capabilities?.path === "web") return usd.format(product.usdCents / 100);
  return purchases.offers[product.sku]?.price ?? null;
}

function TermsLink(): React.JSX.Element {
  return <a className="purchase-terms-link" href={TERMS_URL} target="_blank" rel="noreferrer">Terms of Service</a>;
}

function Notice({ purchases }: Readonly<{ purchases: PurchasesController }>): React.JSX.Element | null {
  if (!purchases.notice && !purchases.checkoutUrl) return null;
  return <div className="purchase-notice" role="status" aria-live="polite">
    {purchases.notice ? <GameAppText tone="helper">{purchases.notice}</GameAppText> : null}
    {purchases.checkoutUrl ? <a className="purchase-terms-link" href={purchases.checkoutUrl} target="_blank" rel="noreferrer">Open checkout</a> : null}
  </div>;
}

function passPeriodLabel(product: PremiumProductView): string {
  return product.period === "year" ? "Yearly" : "Monthly";
}

/** The Shop's Glimmer tab: real-money packs with their built-in bonus, the Atlas Pass entry and the not-available state. */
export function GlimmerTab({ purchases }: Readonly<{ purchases: PurchasesController }>): React.JSX.Element {
  const capabilities = purchases.capabilities;
  if (!capabilities) {
    return <GameAppState variant="loading" title="Checking purchases">Looking up what can be bought on this device.</GameAppState>;
  }
  const packs = capabilities.products.filter((product) => product.kind === "glimmer_pack");
  const link = capabilities.shopLinks;
  const showPacks = purchases.shopEnabled && purchases.canCheckout && packs.length > 0;
  return <div className="shop-stack">
    {showPacks ? <section>
      <GameAppSectionHeader
        title="Glimmer packs"
        description={capabilities.firstPurchaseBonusAvailable ? "Bigger packs include bonus Glimmer. Your first pack adds even more." : "Bigger packs include bonus Glimmer."}
      />
      <div className="shop-packs" aria-label="Glimmer packs">
        {packs.map((product) => {
          const price = priceLabel(purchases, product);
          const { base, bonus, percent } = glimmerPackBonus(product.glimmer, product.usdCents);
          const first = capabilities.firstPurchaseBonusAvailable ? product.firstPurchaseBonusGlimmer : 0;
          return <div key={product.sku} className="shop-pack">
            <span className="shop-pack-gem"><CurrencyGlyph kind="glimmer" /></span>
            <span className="shop-pack-amount">{product.glimmer.toLocaleString()}</span>
            <span className="shop-pack-split">{bonus > 0 ? <>{base.toLocaleString()} <em>+ {bonus.toLocaleString()} bonus</em></> : " "}</span>
            {bonus > 0 ? <span className="shop-pack-pct">+{percent}% extra</span> : <span className="shop-pack-pct shop-pack-pct-none">{" "}</span>}
            <span className="shop-pack-first">{first > 0 ? `First purchase: +${first.toLocaleString()} more` : " "}</span>
            <GameAppButton
              variant="primary"
              disabled={!price || purchases.busySku !== null}
              aria-label={`Buy ${product.glimmer.toLocaleString()} Glimmer${price ? ` for ${price}` : ""}`}
              onClick={() => void purchases.buy(product.sku)}
            >{purchases.busySku === product.sku ? "Working…" : price ?? (purchases.offersLoading ? "…" : "Unavailable")}</GameAppButton>
          </div>;
        })}
      </div>
    </section> : null}
    {!showPacks && !(link.allowed && link.url) ? <GameAppState variant="disabled" title="Not available">
      Glimmer purchases are not available on this device right now.
    </GameAppState> : null}
    <Notice purchases={purchases} />
    {link.allowed && link.url ? <GameAppCard title="Buy on the web" description="Packs bought on the website arrive on this account.">
      <a className="purchase-terms-link" href={link.url} target="_blank" rel="noreferrer">Open the web shop</a>
    </GameAppCard> : null}
    {purchases.passEnabled ? <GameAppCard
      title="Atlas Pass"
      leading={<CurrencyGlyph kind="lumen" />}
      description={`${ATLAS_PASS_FIRST_LUMEN.toLocaleString()} Lumen to start, ${ATLAS_PASS_DAILY_LUMEN.toLocaleString()} Lumen a day, and member perks.`}
      action={<GameAppButton onClick={() => purchases.open("pass")}>{purchases.pass?.active ? "Manage Atlas Pass" : "View Atlas Pass"}</GameAppButton>}
    >{purchases.pass?.active ? <GameAppText tone="helper">Your pass is active.</GameAppText> : <GameAppText tone="helper">Subscribe monthly or yearly.</GameAppText>}</GameAppCard> : null}
    {purchases.native && purchases.canCheckout ? <GameAppButton
      variant="quiet"
      disabled={purchases.restoring}
      onClick={() => void purchases.restore()}
    >{purchases.restoring ? "Restoring…" : "Restore purchases"}</GameAppButton> : null}
    <GameAppText tone="muted" as="small">Glimmer is for convenience and cosmetics. By buying you agree to the <TermsLink />.</GameAppText>
  </div>;
}

const PASS_STATUS_TEXT: Readonly<Record<string, string>> = {
  active: "Active",
  grace: "Active, payment retrying",
  on_hold: "On hold, payment needed",
  paused: "Paused",
  expired: "Expired",
  revoked: "Ended",
  none: "Not subscribed"
};

export function AtlasPassScreen({ purchases, layout }: Readonly<{
  purchases: PurchasesController;
  layout: "desktop" | "phone";
}>): React.JSX.Element | null {
  const capabilities = purchases.capabilities;
  const open = purchases.view === "pass" && purchases.passEnabled;
  if (!open || !capabilities) return null;
  const plans = capabilities.products.filter((product) => product.kind === "atlas_pass");
  const pass = purchases.pass;
  const active = pass?.active === true;
  const until = pass?.activeUntil ? new Date(pass.activeUntil).toLocaleDateString() : null;
  return <GameAppShell
    open
    title="Atlas Pass"
    closeLabel="Close Atlas Pass"
    className="purchase-app"
    layout={layout}
    phoneBackLabel="Back to Game"
    phoneOnReturnToGame={purchases.close}
    onClose={purchases.close}
  >
    <div className="purchase-body">
      <GameAppCard title="Your pass" {...(active ? { badge: "Active" } : {})}>
        <dl className="game-app-stats">
          <dt>Status</dt>
          <dd>{purchases.passLoading && !pass ? "Checking…" : PASS_STATUS_TEXT[pass?.status ?? "none"] ?? "Not subscribed"}</dd>
          {active && until ? <><dt>{pass?.autoRenew === false ? "Ends" : "Renews"}</dt><dd>{until}</dd></> : null}
        </dl>
        {pass && pass.lumenCredited > 0 ? <GameAppText tone="helper">{pass.lumenCredited.toLocaleString()} Lumen added to your inventory.</GameAppText> : null}
      </GameAppCard>
      <GameAppSectionHeader title="Benefits" />
      <div className="game-app-rows" aria-label="Atlas Pass benefits">
        <div className="game-app-row">
          <CurrencyGlyph kind="lumen" />
          <span><strong>{ATLAS_PASS_FIRST_LUMEN.toLocaleString()} Lumen to start</strong><small>Once per account</small></span>
          <span />
        </div>
        <div className="game-app-row">
          <CurrencyGlyph kind="lumen" />
          <span><strong>{ATLAS_PASS_DAILY_LUMEN.toLocaleString()} Lumen every day</strong><small>For each day you are subscribed</small></span>
          <span />
        </div>
      </div>
      {!active && purchases.canCheckout ? <>
        <GameAppSectionHeader title="Subscribe" />
        <div className="game-app-rows" aria-label="Atlas Pass plans">
          {plans.map((product) => {
            const price = priceLabel(purchases, product);
            return <div key={product.sku} className="game-app-row">
              <CurrencyGlyph kind="lumen" />
              <span><strong>{passPeriodLabel(product)}</strong><small>Renews automatically until cancelled</small></span>
              <GameAppButton
                variant="primary"
                className="game-app-button-compact"
                disabled={!price || purchases.busySku !== null}
                aria-label={`Subscribe ${passPeriodLabel(product).toLowerCase()}${price ? ` for ${price}` : ""}`}
                onClick={() => void purchases.buy(product.sku)}
              >{purchases.busySku === product.sku ? "Working…" : price ?? (purchases.offersLoading ? "…" : "Unavailable")}</GameAppButton>
            </div>;
          })}
        </div>
      </> : null}
      <Notice purchases={purchases} />
      {purchases.native && purchases.canCheckout ? <>
        {active ? <GameAppButton onClick={() => void purchases.manageSubscription()}>Manage subscription</GameAppButton> : null}
        <GameAppButton variant="quiet" disabled={purchases.restoring} onClick={() => void purchases.restore()}>
          {purchases.restoring ? "Restoring…" : "Restore purchases"}
        </GameAppButton>
      </> : null}
      <GameAppText tone="muted" as="small">
        Subscriptions renew until cancelled in your store account. See the <TermsLink />.
      </GameAppText>
    </div>
  </GameAppShell>;
}
