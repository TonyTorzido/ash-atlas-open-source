import type { GlimmerShopCatalogItem } from "@ash-atlas/shared";
import { GLIMMER_SHOP_MAX_QUANTITY } from "@ash-atlas/shared";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import type { ShopFeature } from "../features/shop/useShopFeature.js";
import type { PurchasesController } from "../purchases/usePurchases.js";
import {
  MANOR_VIEWS,
  SHOP_TABS,
  WEAPON_TYPES,
  clampShopQuantity,
  shopArtTilted,
  shopCartCount,
  shopItemArtUrl,
  shopItemBlurb,
  shopItemLabel,
  shopItemSubtitle,
  shopManorViewUrl,
  shopHeroEyebrow,
  shopNewestItems,
  shopWeaponBaseName,
  shopWeaponKind,
  type ShopTabId
} from "../shop/shopModel.js";
import { GameAppButton, GameAppSectionHeader, GameAppShell, GameAppState, GameAppTabs, GameAppText } from "./GameAppShell.js";
import { CurrencyGlyph } from "./InventoryCarryList.js";
import { GlimmerTab } from "./PurchaseScreens.js";
import "./ShopApp.css";

type ShopLayout = "desktop" | "phone";
type Sheet = null | "cart" | Readonly<{ sku: string }>;

const fmt = (value: number): string => value.toLocaleString("en-US");

function Price({ value }: Readonly<{ value: number }>): React.JSX.Element {
  return <span className="shop-price"><CurrencyGlyph kind="glimmer" />{fmt(value)}</span>;
}

function ChevronGlyph({ direction }: Readonly<{ direction: "back" | "forward" }>): React.JSX.Element {
  return <svg viewBox="0 0 20 20" aria-hidden="true" className="shop-chevron">
    <path d={direction === "back" ? "M12.5 4 6.5 10l6 6" : "M7.5 4l6 6-6 6"} />
  </svg>;
}

function CartGlyph(): React.JSX.Element {
  return <svg viewBox="0 0 20 20" aria-hidden="true" className="shop-cart-glyph">
    <path d="M2.5 3.5h2.2l1.9 9h8.7l1.7-6.5H5.6" /><circle cx="8" cy="16" r="1.3" /><circle cx="14.3" cy="16" r="1.3" />
  </svg>;
}

/** Art on a square tile: sprites centered, long weapons tilted 45 degrees, slings and shuriken upright. */
function ShopArt({ item, className = "" }: Readonly<{ item: GlimmerShopCatalogItem; className?: string }>): React.JSX.Element {
  const url = shopItemArtUrl(item);
  return <div className={`shop-art shop-art-${item.kind} ${className}`.trim()}>
    {url ? <img src={url} alt="" draggable={false} className={shopArtTilted(item) ? "shop-art-tilted" : undefined} /> : null}
  </div>;
}

export function QuantityStepper({ value, onChange, label = "Quantity" }: Readonly<{
  value: number;
  onChange(next: number): void;
  label?: string;
}>): React.JSX.Element {
  return <div className="shop-stepper" role="group" aria-label={label}>
    <button type="button" aria-label="One fewer" disabled={value <= 1} onClick={() => onChange(clampShopQuantity(value - 1))}>−</button>
    <input
      inputMode="numeric"
      aria-label={label}
      value={value}
      onChange={(event) => {
        const digits = event.target.value.replace(/\D/gu, "");
        if (digits) onChange(clampShopQuantity(Number(digits)));
      }}
    />
    <button type="button" aria-label="One more" disabled={value >= GLIMMER_SHOP_MAX_QUANTITY} onClick={() => onChange(clampShopQuantity(value + 1))}>+</button>
  </div>;
}

/** Featured: the newest shop items, one large slide at a time, advancing every 5 seconds. */
function FeaturedCarousel({ slides, onOpen }: Readonly<{
  slides: readonly GlimmerShopCatalogItem[];
  onOpen(item: GlimmerShopCatalogItem): void;
}>): React.JSX.Element {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return undefined;
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  const count = slides.length;
  const current = Math.min(index, count - 1);
  const go = (delta: number): void => setIndex((value) => (value + delta + count) % count);
  // Every slide stays mounted and layered, so images are already loaded and a change is a pure crossfade.
  return <div
    className={`shop-carousel-wrap${paused ? " shop-carousel-paused" : ""}`}
    onPointerEnter={() => setPaused(true)}
    onPointerLeave={() => setPaused(false)}
    onPointerDown={() => setPaused(true)}
    onPointerCancel={() => setPaused(false)}
    onFocus={() => setPaused(true)}
    onBlur={() => setPaused(false)}
  >
    <section className="shop-hero shop-carousel" aria-roledescription="carousel" aria-label="Newest in the shop">
      <div className="shop-art-frame shop-carousel-art">
        {slides.map((slide, position) => <div key={slide.sku} className={`shop-carousel-layer${position === current ? " is-active" : ""}`} aria-hidden={position !== current}>
          <ShopArt item={slide} />
        </div>)}
        {count > 1 ? <>
          <button type="button" className="shop-gallery-nav shop-gallery-prev" aria-label="Previous item" onClick={() => go(-1)}><ChevronGlyph direction="back" /></button>
          <button type="button" className="shop-gallery-nav shop-gallery-next" aria-label="Next item" onClick={() => go(1)}><ChevronGlyph direction="forward" /></button>
        </> : null}
      </div>
      <div className="shop-hero-copy shop-carousel-copy">
        {slides.map((slide, position) => <div key={slide.sku} className={`shop-carousel-layer shop-carousel-text${position === current ? " is-active" : ""}`} aria-hidden={position !== current} {...(position !== current ? { inert: true } : {})}>
          <span className="shop-eyebrow">{shopHeroEyebrow(slide)}</span>
          <h3>{slide.displayName}</h3>
          <p>{shopItemBlurb(slide)}{slide.kind === "manor_skin" ? " Swaps the look of your Manor inside and out. Rooms, storage and decorations stay as they are." : ""}</p>
          <div className="shop-hero-actions">
            <GameAppButton variant="primary" tabIndex={position === current ? 0 : -1} onClick={() => onOpen(slide)}><Price value={slide.priceGlimmer} /></GameAppButton>
          </div>
        </div>)}
      </div>
    </section>
    {count > 1 ? <div className="shop-carousel-dots" role="tablist" aria-label="Choose a slide">
      {slides.map((entry, position) => <button
        key={entry.sku}
        type="button"
        role="tab"
        aria-selected={position === current}
        aria-label={`${entry.displayName}, ${position + 1} of ${count}`}
        onClick={() => setIndex(position)}
      >
        <span className="shop-carousel-dot" aria-hidden="true" />
        {position === current && !reduced ? <svg className="shop-carousel-ring" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="shop-carousel-ring-track" cx="12" cy="12" r="10" />
          <circle key={`${entry.sku}:${current}`} className="shop-carousel-ring-fill" cx="12" cy="12" r="10" pathLength="100"
            onAnimationEnd={() => setIndex((value) => (value + 1) % count)} />
        </svg> : null}
      </button>)}
    </div> : null}
  </div>;
}

function ShopCard({ item, inCart, onOpen }: Readonly<{
  item: GlimmerShopCatalogItem;
  inCart: number;
  onOpen(): void;
}>): React.JSX.Element {
  return <button type="button" className="shop-card" onClick={onOpen} aria-label={`${item.displayName}, ${fmt(item.priceGlimmer)} Glimmer`}>
    <div className={`shop-art-frame shop-art-frame-${item.kind}`}>
      <ShopArt item={item} />
      {item.isNew ? <span className="shop-tag shop-tag-new">New</span> : null}
      {item.kind === "weapon" ? <span className="shop-tag shop-tag-limited">Limited time</span> : null}
      {inCart > 0 ? <span className="shop-tag shop-tag-cart">In cart ×{inCart}</span> : null}
    </div>
    <span className="shop-card-name">{item.displayName}</span>
    <span className="shop-card-sub">{shopItemSubtitle(item)}</span>
    {item.kind === "weapon" && shopWeaponBaseName(item) ? <span className="shop-card-sub">Skin of {shopWeaponBaseName(item)}</span> : null}
    <span className="shop-card-price"><Price value={item.priceGlimmer} /></span>
  </button>;
}

function ManorGallery({ item }: Readonly<{ item: GlimmerShopCatalogItem }>): React.JSX.Element {
  const [index, setIndex] = useState(0);
  const swipeStart = useRef<number | null>(null);
  const step = (delta: number): void => setIndex((current) => (current + delta + MANOR_VIEWS.length) % MANOR_VIEWS.length);
  const view = MANOR_VIEWS[index]!;
  const onPointerUp = (event: ReactPointerEvent): void => {
    if (swipeStart.current === null) return;
    const dx = event.clientX - swipeStart.current;
    swipeStart.current = null;
    if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
  };
  return <div
    className="shop-gallery"
    onKeyDown={(event) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    }}
  >
    <div
      className={`shop-gallery-view${index > 0 ? " shop-gallery-inside" : ""}`}
      onPointerDown={(event) => { swipeStart.current = event.clientX; }}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { swipeStart.current = null; }}
    >
      {shopManorViewUrl(item, view.id) ? <img src={shopManorViewUrl(item, view.id)!} alt={`${item.displayName}, ${view.label}`} draggable={false} /> : null}
      <button type="button" className="shop-gallery-nav shop-gallery-prev" aria-label="Previous view" onClick={() => step(-1)}><ChevronGlyph direction="back" /></button>
      <button type="button" className="shop-gallery-nav shop-gallery-next" aria-label="Next view" onClick={() => step(1)}><ChevronGlyph direction="forward" /></button>
      <span className="shop-gallery-caption">{view.label} <i>{index + 1} / {MANOR_VIEWS.length}</i></span>
    </div>
    <div className="shop-gallery-thumbs" role="tablist" aria-label="Manor views">
      {MANOR_VIEWS.map((entry, position) => <button
        key={entry.id}
        type="button"
        role="tab"
        aria-selected={position === index}
        onClick={() => setIndex(position)}
      >
        {shopManorViewUrl(item, entry.id) ? <img src={shopManorViewUrl(item, entry.id)!} alt="" draggable={false} /> : null}
        <span>{entry.label}</span>
      </button>)}
    </div>
  </div>;
}

function itemFacts(item: GlimmerShopCatalogItem): readonly (readonly [string, string])[] {
  if (item.kind === "weapon") {
    const kind = shopWeaponKind(item);
    return [
      ["What it is", kind ? `${WEAPON_TYPES[kind.type]} · ${kind.className} swag` : "Swag weapon"],
      ["Skin of", shopWeaponBaseName(item) ?? "The base weapon"],
      ["Availability", "Limited time"],
      ["Stats", kind ? `Same as the base ${WEAPON_TYPES[kind.type].toLowerCase()}, starts at +0` : "Same as the base weapon, starts at +0"],
      ["Upgrades", "Upgrade at a Smithing Station as usual"],
      ["Trading", "Tradable on the market"]
    ];
  }
  if (item.kind === "mask") {
    return [["Slot", "Mask (face)"], ["Stats", "None, looks only"], ["Wear", "From your inventory"], ["Trading", "Tradable on the market"]];
  }
  if (item.kind === "manor_skin") {
    return [
      ["Applies to", "Your Manor, inside and out"],
      ["Equip", "From your inventory, any time"],
      ["Keeps", "Rooms, storage, decorations"],
      ["Trading", "Copies you are not using are tradable"]
    ];
  }
  return [["Stats", "Same as the base armour"]];
}

export type ShopAppProps = Readonly<{
  open: boolean;
  layout: ShopLayout;
  tab: ShopTabId;
  online: boolean;
  glimmerBalance: number;
  feature: ShopFeature;
  purchases: PurchasesController;
  ownedCount(item: GlimmerShopCatalogItem): number;
  onTabChange(tab: ShopTabId): void;
  onClose(): void;
}>;

export function ShopApp({
  open, layout, tab, online, glimmerBalance, feature, purchases, ownedCount, onTabChange, onClose
}: ShopAppProps): React.JSX.Element | null {
  const { items, cart, cartLines, cartTotal, pending, error, toast } = feature;
  const [sheet, setSheet] = useState<Sheet>(null);
  const [quantity, setQuantity] = useState(1);
  const [confirming, setConfirming] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const sheetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    if (items === null) feature.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) { setSheet(null); setConfirming(false); }
  }, [open]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(feature.dismissToast, 2600);
    return () => window.clearTimeout(timer);
  }, [toast, feature.dismissToast]);
  useEffect(() => { sheetRef.current?.scrollTo?.({ top: 0 }); }, [sheet]);
  // A purchase leaves its panel open until the server answers: success closes it, an error stays visible there.
  useEffect(() => {
    if (!submitted || pending) return;
    setSubmitted(false);
    if (!error) { setSheet(null); setConfirming(false); }
  }, [submitted, pending, error]);
  useEffect(() => {
    if (!sheet) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.stopPropagation(); closeSheet(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  if (!open) return null;

  const closeSheet = (): void => { setSheet(null); setConfirming(false); };
  const openItem = (item: GlimmerShopCatalogItem): void => { setSheet({ sku: item.sku }); setQuantity(1); setConfirming(false); feature.dismissError(); };
  const count = shopCartCount(cart);
  const list = (items ?? []).filter((item) => item.onSale && item.source !== "craft");
  const ofKind = (kind: GlimmerShopCatalogItem["kind"]): readonly GlimmerShopCatalogItem[] => list.filter((item) => item.kind === kind);
  const card = (item: GlimmerShopCatalogItem): React.JSX.Element =>
    <ShopCard key={item.sku} item={item} inCart={cart[item.sku] ?? 0} onOpen={() => openItem(item)} />;
  const goTab = (next: ShopTabId): void => { closeSheet(); onTabChange(next); };

  let body: React.JSX.Element;
  if (tab === "glimmer") {
    body = <GlimmerTab purchases={purchases} />;
  } else if (items === null) {
    body = <GameAppState variant="loading" title="Opening the shop">{online ? "Loading what is for sale." : "Reconnect to see the shop."}</GameAppState>;
  } else if (tab === "featured") {
    const slides = shopNewestItems(list);
    const featuredItems = list.filter((item) => item.featured).slice().sort((left, right) => right.addedAt.localeCompare(left.addedAt));
    body = slides.length ? <div className="shop-stack">
      <FeaturedCarousel slides={slides} onOpen={openItem} />
      {featuredItems.length ? <section><GameAppSectionHeader title="Featured" /><div className="shop-grid">{featuredItems.map(card)}</div></section> : null}
    </div> : <GameAppState title="Nothing featured yet">Browse the tabs above to see what is for sale.</GameAppState>;
  } else if (tab === "weapons") {
    const weapons = ofKind("weapon");
    body = <>
      <GameAppSectionHeader title="Swag weapons" description="Limited-time skins. Same stats as the base weapon; upgrade and trade them as usual." />
      {weapons.length ? <div className="shop-grid">{weapons.map(card)}</div>
        : <GameAppState title="No swag weapons in the shop right now">New ones rotate in regularly.</GameAppState>}
    </>;
  } else if (tab === "armour") {
    const armour = ofKind("armour");
    body = armour.length
      ? <><GameAppSectionHeader title="Swag armour" description="Cosmetic only. Same stats as the armour it is based on." /><div className="shop-grid">{armour.map(card)}</div></>
      : <GameAppState title="Swag armour is on the way">Cosmetic armour sets will be sold here for 1,000 Glimmer each. They keep the stats of the armour they are based on.</GameAppState>;
  } else if (tab === "masks") {
    body = <><GameAppSectionHeader title="Masks" description="Cosmetic only. Each mask is an item you can wear, trade or sell." /><div className="shop-grid">{ofKind("mask").map(card)}</div></>;
  } else {
    body = <><GameAppSectionHeader title="Manor skins" description="Equip from your inventory. Your rooms and storage stay put." /><div className="shop-grid shop-grid-manors">{ofKind("manor_skin").map(card)}</div></>;
  }

  const sheetItem = sheet && sheet !== "cart" ? (items ?? []).find((item) => item.sku === sheet.sku) ?? null : null;
  const shortBy = (total: number): number => Math.max(0, total - glimmerBalance);

  let sheetContent: React.JSX.Element | null = null;
  if (sheet === "cart") {
    const after = glimmerBalance - cartTotal;
    sheetContent = <>
      <div className="shop-sheet-head"><button type="button" className="shop-back" aria-label="Back to Shop" onClick={closeSheet}><ChevronGlyph direction="back" /></button><span>Your cart</span></div>
      <div className="shop-sheet-body">
        <h3>Cart</h3>
        {cartLines.length === 0
          ? <GameAppState title="Your cart is empty" action={<GameAppButton onClick={closeSheet}>Keep shopping</GameAppButton>}>Open an item and choose Add to cart. You can buy several of the same item.</GameAppState>
          : <ul className="shop-cart-list">
            {cartLines.map(({ item, quantity: lineQuantity }) => <li key={item.sku} className="shop-cart-row">
              <ShopArt item={item} className="shop-art-thumb" />
              <div className="shop-cart-info">
                <span className="shop-card-name">{item.displayName}</span>
                <span className="shop-card-sub shop-price-each"><CurrencyGlyph kind="glimmer" />{fmt(item.priceGlimmer)} each</span>
                <QuantityStepper value={lineQuantity} label={`${item.displayName} quantity`} onChange={(next) => { setConfirming(false); feature.setCartQuantity(item.sku, next); }} />
              </div>
              <div className="shop-cart-side">
                <Price value={item.priceGlimmer * lineQuantity} />
                <button type="button" className="shop-link" onClick={() => { setConfirming(false); feature.removeFromCart(item.sku); }}>Remove</button>
              </div>
            </li>)}
          </ul>}
        {cartLines.length > 0 ? <div className="shop-buy-box">
          <div className="shop-row"><span>Total</span><b><Price value={cartTotal} /></b></div>
          <div className="shop-row"><span>You have</span><b><Price value={glimmerBalance} /></b></div>
          {after >= 0 ? <div className="shop-row"><span>Balance after</span><b><Price value={after} /></b></div> : null}
          {error ? <GameAppText tone="error" role="alert">{error}</GameAppText> : null}
          {after < 0
            ? <GameAppButton variant="primary" onClick={() => goTab("glimmer")}>Get {fmt(shortBy(cartTotal))} more Glimmer</GameAppButton>
            : !confirming
              ? <GameAppButton variant="primary" disabled={!online} onClick={() => setConfirming(true)}>Buy {count} {count === 1 ? "item" : "items"} for <Price value={cartTotal} /></GameAppButton>
              : <div className="shop-split">
                <GameAppButton variant="quiet" disabled={pending} onClick={() => setConfirming(false)}>Cancel</GameAppButton>
                <GameAppButton variant="primary" disabled={pending} onClick={() => { if (feature.buy(cartLines.map(({ item, quantity: q }) => ({ sku: item.sku, quantity: q })), cartTotal)) { setConfirming(false); setSubmitted(true); } }}>{pending ? "Buying…" : "Confirm purchase"}</GameAppButton>
              </div>}
        </div> : null}
      </div>
    </>;
  } else if (sheetItem) {
    const total = sheetItem.priceGlimmer * quantity;
    const after = glimmerBalance - total;
    const have = ownedCount(sheetItem);
    sheetContent = <>
      <div className="shop-sheet-head"><button type="button" className="shop-back" aria-label="Back to Shop" onClick={closeSheet}><ChevronGlyph direction="back" /></button><span>{shopItemLabel(sheetItem)}</span></div>
      {sheetItem.kind === "manor_skin"
        ? <ManorGallery item={sheetItem} />
        : <div className={`shop-art-frame shop-art-frame-${sheetItem.kind} shop-sheet-art`}><ShopArt item={sheetItem} />{sheetItem.isNew ? <span className="shop-tag shop-tag-new">New</span> : null}</div>}
      <div className="shop-sheet-body">
        <h3>{sheetItem.displayName}</h3>
        {shopItemBlurb(sheetItem) ? <p className="shop-blurb">{shopItemBlurb(sheetItem)}</p> : null}
        <dl className="shop-facts">
          {itemFacts(sheetItem).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          {have > 0 ? <div><dt>You have</dt><dd>{fmt(have)}</dd></div> : null}
        </dl>
      </div>
      <div className="shop-buy-box shop-buy-pinned">
        <div className="shop-row"><span>Quantity</span><QuantityStepper value={quantity} onChange={(next) => { setConfirming(false); setQuantity(next); }} /></div>
        <div className="shop-row"><span>{quantity > 1 ? `${fmt(sheetItem.priceGlimmer)} × ${quantity}` : "Price"}</span><b className="shop-total"><Price value={total} /></b></div>
        {confirming ? <div className="shop-row"><span>Balance after</span><b><Price value={Math.max(0, after)} /></b></div> : null}
        {error ? <GameAppText tone="error" role="alert">{error}</GameAppText> : null}
        {confirming
          ? <div className="shop-split">
            <GameAppButton variant="quiet" disabled={pending} onClick={() => setConfirming(false)}>Cancel</GameAppButton>
            <GameAppButton variant="primary" disabled={pending} onClick={() => { if (feature.buy([{ sku: sheetItem.sku, quantity }], total)) { setConfirming(false); setSubmitted(true); } }}>{pending ? "Buying…" : "Confirm purchase"}</GameAppButton>
          </div>
          : <div className="shop-split">
            <GameAppButton onClick={() => { feature.addToCart(sheetItem.sku, quantity); closeSheet(); feature.showToast(`Added ${quantity} × ${sheetItem.displayName} to your cart`); }}>Add to cart</GameAppButton>
            {after < 0
              ? <GameAppButton variant="primary" onClick={() => goTab("glimmer")}>Get more Glimmer</GameAppButton>
              : <GameAppButton variant="primary" disabled={!online} onClick={() => setConfirming(true)}>Buy now</GameAppButton>}
          </div>}
      </div>
    </>;
  }

  const wallet = <div className="shop-wallet">
    <button type="button" className="shop-glimmer-cta" aria-label={`Glimmer balance ${fmt(glimmerBalance)}. Get Glimmer`} onClick={() => goTab("glimmer")}>
      <CurrencyGlyph kind="glimmer" />
      <span className="shop-glimmer-balance">{fmt(glimmerBalance)}</span>
      <span className="shop-glimmer-get">Get Glimmer</span>
      <span className="shop-glimmer-plus" aria-hidden="true">+</span>
    </button>
  </div>;
  const cartButton = <button
    type="button"
    className="phone-menu-nav-trailing shop-cart-nav"
    aria-label={`Cart, ${count} ${count === 1 ? "item" : "items"}`}
    onClick={() => { setSheet("cart"); setConfirming(false); feature.dismissError(); }}
  ><CartGlyph /><span className="phone-menu-nav-label">Cart</span>{count > 0 ? <span className="shop-cart-count" aria-hidden="true">{count}</span> : null}</button>;

  return <GameAppShell
    open
    title="Shop"
    menuId="shop"
    closeLabel="Close Shop"
    navTrailing={cartButton}
    className="shop-app"
    layout={layout}
    phoneBackLabel="Back to Game"
    phoneOnReturnToGame={onClose}
    onClose={onClose}
  >
    <div className="shop-body">
      {wallet}
      <GameAppTabs tabs={SHOP_TABS.map(({ id, label }) => ({ id, label }))} activeTab={tab} onChange={(id) => goTab(id as ShopTabId)} ariaLabel="Shop sections" variant="housed" />
      {error && !sheet ? <GameAppState variant="error" title="Shop">{error}</GameAppState> : null}
      <div className="shop-content" role="tabpanel">{body}</div>
    </div>
    {typeof document !== "undefined" ? createPortal(
      <>
        {sheet ? <div className="shop-scrim" onClick={closeSheet} /> : null}
        {sheet && sheetContent ? <aside ref={sheetRef} className="shop-sheet" role="dialog" aria-modal="true" aria-label={sheet === "cart" ? "Cart" : sheetItem?.displayName ?? "Item"}>{sheetContent}</aside> : null}
        {toast ? <div className="shop-toast" role="status" aria-live="polite">{toast.text}</div> : null}
      </>,
      document.body
    ) : null}
  </GameAppShell>;
}
