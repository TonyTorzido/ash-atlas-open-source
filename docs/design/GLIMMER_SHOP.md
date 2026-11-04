# Glimmer Shop

One central Shop for everything bought with Glimmer, plus buying Glimmer with real money.
Owner decisions 2026-10-06. The approved mockup (look, layout, copy, flows) was not published with this repository.

Branch `feature/glimmer-shop--from-t1471`. Migration block reserved: **1200–1209**.

## What players see

Tabs: **Featured · Weapons · Armour · Masks · Manors · Glimmer**. Header shows the Glimmer balance,
a **Get Glimmer** button (jumps to the Glimmer tab) and a **Cart** button with a count badge.

- **Featured:** a hero banner (one featured manor), a Featured row, a New arrivals row.
- **Weapons:** the 24 swag weapons that are on sale, with weapon-type filter chips. Card = art, name,
  "Sword · Warrior", price, "Shop only" / "Also craftable".
- **Armour:** empty state "Swag armour is on the way" (armour is a later task; the catalog must accept
  an `armour` kind already).
- **Masks:** 5 masks.
- **Manors:** Haunted, Samurai. The default Timber manor is never listed.
- **Glimmer:** the real-money packs and the Atlas Pass card (reuse the existing purchase flow in
  `apps/client/src/purchases/` and `PurchaseScreens.tsx`; this tab replaces the standalone Get Glimmer
  screen). Each pack shows its built-in bonus ("1,000 + 50 bonus", "+5% extra") and the first-purchase
  bonus line. When real-money purchases are off (current flags), show the existing "not available"
  state there; everything else in the shop works.
- **Item panel** (side panel on desktop, bottom sheet on phone, fixed to the viewport): art, name,
  blurb, facts, "You have N" when owned, **quantity stepper 1–99**, total, **Add to cart** / **Buy now**
  → in-panel **Confirm purchase** showing balance after. Not enough Glimmer → "Get more Glimmer".
  Purchase panel footer stays pinned at the bottom.
- **Manor panel:** pages through Outside, Lobby, Hall, Rooms, Lower floor (arrows, swipe, thumbnails).
  Prefer the real interior renderer (pan/zoom) if it can run inside the shop cheaply; otherwise use
  the room art PNGs in `apps/client/src/assets/manors/<type>/`.
- **Cart:** rows with art, price each, stepper, line total, Remove; total, balance, balance after;
  "Buy N items for X" → Confirm. One server request for the whole cart.
- No "Owned" state anywhere: every item can be bought again in any quantity.
- Weapon art: centered on a square tile, long weapons tilted 45° (slings/shuriken upright). Use the
  existing swag sprites in `packages/player-renderer/src/assets/player-appearance/weapons/swag/`.
- Follow the build bible + production components (GameAppShell, tabs, buttons, theme tokens, light and
  dark). New shop card/tile/stepper styles get added to Developer App → UI Standards. No X close
  glyphs, no native scrollbars, no competitor names.

## Prices (Glimmer)

| Kind | Price |
|---|---|
| Swag weapon / swag armour | 1,000 |
| Mask (and similar face/head cosmetics) | 1,500 |
| Manor skin | 2,000 |

All admin-editable per item.

## Catalog (admin-editable, no deploy)

New table (migration in 1200–1209): one row per sellable item. Columns at least: `sku` (pk),
`kind` (`weapon` | `armour` | `mask` | `manor_skin`), the reference to what is granted (equipment
definition / item definition / manor type), `price_glimmer` (bigint > 0), `source` for weapons
(`craft` | `shop` | `both`), `featured`, `on_sale`, `is_new`, `sort_order`, `updated_at`, `updated_by`.

Seed: 24 swag weapons at 1000 with `source = 'craft'` (owner picks `shop` per weapon), 5 masks at 1500,
Haunted + Samurai manor skins at 2000. Timber is not seeded.

- `source = 'craft'`: not sold in the shop; Smithing recipe stays.
- `source = 'shop'`: sold; the Smithing recipe is hidden AND the server refuses the craft.
- Nothing craftable is ever sold (owner, 2026-10-06): there is no 'both'; migration 1206 enforces it.

Developer App → **Shop catalog** editor (as in the mockup): source, price, featured, on sale, new.
Server admin route behind the existing admin authorization, with an audit entry per change.

## Buying (server-authoritative, money rules)

One command for single items and carts, e.g. `BUY_SHOP_ITEMS { requestId, lines: [{ sku, quantity }],
expectedTotalGlimmer }`.

- Server re-reads prices; rejects if any line is off sale, unknown, quantity outside 1–99, more than
  20 lines, or the total differs from `expectedTotalGlimmer` (price changed → client refreshes).
- One DB transaction: debit the premium wallet, mint every item, write ledger rows. All or nothing.
- Idempotent on `requestId`: a replay returns the original result and never charges twice.
- Inventory full → reject the whole purchase with a clear message (no partial delivery).
- Reuse `apps/server/src/game/premiumWallet.ts` and existing ledger patterns; mint items through the
  same paths crafting/rewards use.
- Retire the old `BUY_MANOR_SKIN` buy path (route it through the shop or remove it); the shop is the
  only Glimmer store (owner rule: no per-feature Glimmer sale spots).

## Masks become paid items

- The 5 masks (`mask-1` Oni, `mask-2` Rebel, `mask-3` Calavera, `hockey-mask`, `kitsune-mask`;
  display names are new) become inventory item definitions, tradable on the market and between players.
- No free masks in the Salon any more. Wearing a mask requires owning the item; equip/unequip from the
  inventory (same pattern as manor skins). The equipped copy cannot be traded/dropped/sold; extra
  copies can. Server validates appearance: a mask can only be worn if owned.
- Server reset is planned, so clearing existing free mask selections is fine (do it in the migration;
  never touch the live DB by hand).

## Manor skins become tradable

Extra copies are tradable (market + player trade). The equipped skin stays locked. Today manor skins
cannot be dropped/traded/sold/stored; relax that for unequipped copies.

## Glimmer packs and Atlas Pass (new prices)

Migration updates `premium_products` (from 0990):

| sku | Glimmer | first-purchase bonus | usd_cents |
|---|---|---|---|
| glimmer_pinch | 200 | 200 | 199 |
| glimmer_handful | 500 | 500 | 499 |
| glimmer_pouch | 1050 | 1050 | 999 |
| glimmer_satchel | 2150 | 0 | 1999 |
| glimmer_chest | 5500 | 0 | 4999 |
| glimmer_hoard | 11250 | 0 | 9999 |
| atlas_pass_monthly | – | – | 1999 |
| atlas_pass_yearly | – | – | 19999 |

Built-in bonus shown in the UI = Glimmer − 100 × whole dollars (0, 0, 50, 150, 500, 1250).
App Store / Google Play prices are set in the store consoles by hand (not part of this branch).

## Testing (money + items + migration)

Focused only: purchase debits and mints atomically; replay of the same `requestId` charges once;
insufficient balance; price-changed rejection; off-sale rejection; quantity/line bounds; inventory-full
rejection; `source = 'shop'` craft refused; mask worn without owning it is refused; admin catalog
edit allowed for admin and denied for a normal player; migration populated upgrade + empty rerun.
Use disposable `ash_atlas_stability*` databases.

## Provenance tags (owner, 2026-10-06)

Every item bought from the Glimmer Shop carries a permanent **tag** and its **original buyer**.

- Long-press (hold) the item in the inventory → **Details** shows: item name, **Tag** (e.g. `#7KQ3-M9XD`),
  **Originally bought by** <buyer's name at purchase time>. Market listings / trade views of a tagged copy
  show the same Details.
- Tags are random, NOT sequential: they must never reveal how many were sold or the purchase order.
  Random 40-bit Crockford base32 formatted `XXXX-XXXX`, unique constraint, retry on collision. Nothing
  else player-visible (ids, counters) may leak sales counts either.
- The tag and buyer stay with that exact copy forever: through trades, gifts, market sales, drops, storage,
  equip/unequip. Each copy is distinct, so tagged items cannot merge into an anonymous stack. Masks and
  manor skins therefore become per-copy items (like equipment instances); the market lists specific copies.
- Crafted swag weapons have no tag (not bought from the shop).

Theme: the shop always uses the player's own menu theme (light/dark); it has no theme switch of its own.
