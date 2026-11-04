# Ash Atlas market UI redesign

## Design evidence and constraints

The existing Simple and Advanced screens were captured before implementation. Implementation is validated against this written specification and browser screenshots captured from the running application.

## Current UX problems

- Simple mode exposes internal concepts—authoritative quotes, escrow, limit listings, and matching behavior—before the player can understand the basic buy/sell task.
- Empty items still render a large sell-book panel, a purchase form, a custom listing form, repeated zero values, and multiple empty messages.
- Item cards consume too much space while conveying little more than “no listings.”
- Simple and Advanced compete with Browse, My Orders, and Collection navigation; Collection is ambiguous.
- The separate “Get exact price” step makes a normal purchase feel like a financial workflow instead of a game-market action.
- Advanced mode reserves large regions for empty order depth, open orders, and recent trades.
- Tiny technical copy and dense two-column forms increase reading and zoom friction.

## Terminology

- **Quick Trade** replaces Simple.
- **Merchant View** replaces Advanced.
- **Collection Box** replaces Collection because this section contains settled items and gold awaiting claim; it is not a second sell form.
- Quick Trade uses “For sale,” “Wanted,” “Buy,” “Sell,” “You pay,” “Market fee,” and “You receive.”
- Merchant View may use bid, ask, spread, limit order, escrow, and depth, with plain supporting labels.
- Price-level counts are always labelled **orders**, never players.

## Quick Trade information hierarchy

1. Market title, wallet, connection state, and close control.
2. Quick Trade / Merchant View mode switch.
3. Search and compact category chips.
4. Compact item browser, prioritizing listed items and showing lowest seller price, available quantity, and owned quantity.
5. Selected item header with icon, category, owned quantity, total for sale, and total wanted.
6. Up to three aggregated sell price levels and three aggregated buy price levels.
7. A single contextual ticket created by selecting an offer: Buy when selecting a seller level, Sell when selecting a buyer level.
8. Quantity stepper, total/proceeds, one primary action, and a Merchant View link for custom orders.

```text
MARKET                     Wallet 42 gold   [×]
[ Quick Trade ] [ Merchant View ]
[ Search items… ] [All] [Resource]

ITEMS                    WOOD · Resource
Wood  from 5g  71 sale   You own 18 · 71 for sale · 30 wanted
Stone from 8g  24 sale
                         SELLERS          BUYERS
                         [5g 12 · 3 orders] [4g 10 · 2 orders]
                         [6g 40 · 2 orders] [3g 20 · 2 orders]

                         BUY WOOD
                         Quantity [−] 5 [+] [Max]
                         You pay 25 gold
                         [ Buy 5 Wood for 25 gold ]
```

## Merchant View information hierarchy

1. The same item browser and selected-item header for continuity.
2. Best ask, best bid, spread, last real trade, owned quantity, and listed quantity.
3. Full vertically readable seller and buyer depth tables.
4. Compact recent-trades section only when real trades exist.
5. Desktop right-side custom limit-order ticket with buy/sell side, quantity, limit price, fees, estimated escrow/proceeds, wallet/inventory validation, review, and confirmation.
6. Current open orders with side, price, original/remaining/filled quantity, created time, reserved value, and cancellation. Empty open orders collapse to one compact line.

## Buy flow

1. Select an item, then a seller price level.
2. The ticket defaults to one unit and requests a server-authoritative quote automatically.
3. Quantity changes invalidate and refresh that quote; while refreshing, the total states “Checking current total…” without exposing quote mechanics.
4. The primary button is enabled only for a current, fully fillable, affordable server quote.
5. The button reads `Buy {quantity} {item} for {total}`.
6. Stale or changed prices never charge more silently. The player sees a concise retry/price-changed state and explicitly approves the new total.

## Sell flow

1. Select a buyer price level.
2. The ticket shows owned quantity, quantity controls, gross value, fee, and final proceeds.
3. The action reads `Sell {quantity} {item} for {proceeds}`.
4. Quantity is capped by owned inventory and the selected/eligible buyer demand.
5. The existing server-authoritative limit-order submission remains the mutation boundary; no inventory or proceeds are inferred locally after submission.

## Empty, loading, and error states

- No activity: one compact statement for “nothing for sale” and one for “no current buyers,” followed by a Merchant View custom-order link.
- Zero inventory: buying remains available; the sell ticket is replaced by “You do not own any {item} to sell.”
- Zero/insufficient gold: seller levels remain readable; the buy ticket explains the shortfall and disables the action.
- Loading: preserve ticket height where practical and use plain “Loading market…” / “Checking current total…” copy.
- Offline/reconnecting: retain confirmed data, disable mutations, and show one banner.
- Stale/changed price: explain that availability changed, show the prior and refreshed total when available, and require a fresh explicit action.
- Empty open orders and trades collapse rather than reserving large panels.

## Responsive layout

### Desktop (1280 × 720)

The modal uses a compact header and two-column browse layout: a 260–300 px item rail and flexible detail area. Quick Trade offer columns and ticket remain visible without page-level horizontal scrolling. Merchant View uses depth/content plus a sticky 300 px order ticket.

### Mobile (approximately 390 × 720)

Header metadata compresses; mode tabs remain reachable. Search appears first, followed by a horizontally scrollable compact item list, item summary, seller levels, buyer levels, and ticket. Price, quantity, total, and the primary action never require horizontal scrolling. Minimum interactive height is 42–44 px.

### Short height (approximately 1280 × 480)

The market keeps one internal scroll container. Header/navigation shrink, while the selected item, offers, total, and action remain early in reading order. No nested panel is allowed to grow past the viewport.

## Accessibility behavior

- Preserve modal scrim, Escape close, focus containment, initial focus, and focus restoration from `feature/ui-fixes`.
- Mode controls use tabs; item and offer rows use semantic buttons with complete accessible names.
- Selected offer state uses both visual treatment and `aria-pressed`.
- Quantity controls have explicit decrement/increment/max labels and remain keyboard operable.
- Loading, price changes, errors, and successful actions use polite live regions.
- Disabled actions include nearby explanatory text; color is never the only state signal.
- Focus rings remain visible at all tested zoom levels.

## Browser evidence

Final populated and empty-state screenshots were not retained.

## Intentionally deferred

- Historical price/volume charts, because the current backend does not expose a reliable time series.
- Unique buyer/seller counts, because order count does not guarantee unique players.
- Replace/edit order behavior, because only cancellation is currently supported.

## HUD cleanup and developer-tool consolidation

### Design outcome

- The permanent in-game Ash Atlas title/subtitle banner was removed. Login, metadata, and documentation branding are unchanged.
- Chat now owns a single 48 px desktop communication bar. Channel, preview, unread state, connection state, and the compact account menu share that surface. The account menu retains Profile, flag color, and Sign out; mobile uses a keyboard-labelled overflow control.
- Player status is one compact dark-fantasy HUD with authoritative current/max health, the active class's dynamic resource label and values, and a thinner XP track. Health, Rage, Focus, Conviction, Faith, XP, track, and low-health states have semantic CSS tokens/classes. The prior duplicate quick-slot resource meter is hidden in gameplay because the unified HUD now owns that information.
- The default HUD has no Resource Vision, debug, performance, mob-spawner, or developer-console panel. A fail-closed `DEV` entry opens one focus-contained Developer Menu with Economy, World, Spawning, Diagnostics, and Performance sections. Progression tooling is reachable only from that menu; normal Classes remains player-facing.
- The permanent gameplay button strip became a bottom-centred action drawer. It is collapsed by default, groups World/Character/Realm/Economy actions, preserves disabled/contextual rules and shortcut labels, closes with Escape/outside click/toggle, and restores focus.

### Development economy authorization

The Economy section grants only the currently authenticated development player. The WebSocket request contains a bounded positive integer intent and optional supported resource IDs; it contains no player/account/resulting-balance field. The server derives player and account from the authenticated session and independently requires all of:

- non-production runtime
- `AUTH_RUNTIME_MODE=local` or `private`
- `AUTH_MODE=dev`
- `AUTH_DEV_LOGIN_ENABLED=true`
- `DEV_ADMIN_TOOLS_ENABLED=true`
- exact server-authorized verified provider subject
- authenticated player session
- supported resource definition
- quantity from 1 through 1,000,000

`DEV_ADMIN_TOOLS_ENABLED` defaults to false in `.env.example` and is enabled by the canonical
development supervisor. The client receives capabilities from the authenticated server session;
there is no Vite/client admin preference. Public mode may permit owner observation/world mutation,
but never grants the economy capability.

Gold credits use `WalletService`; materials use `InventoryService`. A combined Market test kit is one database transaction, records wallet/inventory ledger evidence under `development_market_testing_grant`, uses request-scoped idempotency keys, and rolls back the complete operation on failure. A committed result refreshes client inventory and Market private state without a restart. Browser validation committed 10,000 gold and 500 each of Wood, Stone, Food, Ore, and Water, then confirmed the Market displayed 10,000 gold and the new owned quantities.

### Developer Menu contents and default state

- **Economy:** current wallet/materials, bounded custom gold/material grants, +1,000/+10,000 gold, and atomic Market test kit.
- **World:** Resource Vision toggle. Its map visualization and compact panel are off by default.
- **Spawning:** the existing archetype choices, map spawn mode, cancellation, and clear-mobs action.
- **Diagnostics:** debug HUD, developer console, and server-authoritative progression controls.
- **Performance:** existing performance panel and recording instrumentation.
- **Disable all overlays:** turns Resource Vision, Debug HUD, and Performance off together.

### Responsive and accessibility decisions

- Desktop keeps chat and player status centred without overlap, a compact left combat cluster, and small Actions/DEV launchers at the bottom edge.
- Mobile (390 × 720) uses the full safe width for chat/status, an explicit account overflow control, two-column abilities/actions, and no horizontal overflow.
- Short-height desktop (1280 × 480) constrains the action drawer to 370 px with internal scrolling; its heading and close button remain visible below the communication bar.
- Developer Menu and existing large menus use the shared modal focus trap, Escape close, focus restoration, blocking scrim, visible focus rings, internal scrolling, and viewport containment.
- Reduced-motion users do not receive the drawer entrance or bar-width transition.

### HUD browser checks
Browser checks covered 2560 × 1080, 1280 × 720, 390 × 720, and 1280 × 480. Effective viewport checks corresponding to 80%, 100%, 125%, 150%, and 200% browser zoom retained the account, Actions, and DEV entry points with zero horizontal overflow. The settled browser console had no warnings or errors; the only observed messages were a favicon 404 and a transient WebSocket-close warning during the login navigation, before the gameplay session settled.

### Validation performed

- TypeScript: client, shared, and server passed.
- ESLint: passed.
- Production builds: client and server passed. Vite retained its existing large-chunk advisory.
- Client: 433 tests passed.
- Shared: 130 tests passed.
- Server: 790 tests passed; 122 opt-in database tests were skipped by the general suite.
- Relevant live PostgreSQL Market/economy hardening: 72 tests passed against `ash_atlas_market_ui_redesign_validation`.
- Launcher: PowerShell parse/runtime smoke passed; it reused the shared PostGIS container and existing development database, applied no pending migrations, started frontend 5190/backend 3017, and continued in documented degraded mode while the optional World API was unavailable.

### Intentionally deferred HUD polish

- The combat ability cluster keeps its existing component and visual language. Only its duplicate resource meter and overlap positioning changed; combat mechanics and target/party behavior were not redesigned.
- No map renderer, normal gameplay behavior, market economic rule, or production analytics/chart behavior changed.

## Quick Trade quote loading correction

### Root cause and account behavior

The permanent “Checking current total…” state was client-side. Selecting a different seller row invalidated the current quote, but the automatic quote effect depended on side, quantity, item, and book version—not the selected price. No replacement WebSocket request was sent, so the server had nothing to answer and the component treated the missing quote as endless loading. Quote matching also omitted the selected price cap, which allowed a quote from one seller level to remain associated with another. Live reproduction confirmed that the initial distinct-account Buyer B request received a server result, while changing levels produced no new request. Same-account sessions made the symptom more visible because public depth includes the account's own orders, but they were not the cause.

### State-machine correction

- A quote request now includes the clicked seller price as `maximumUnitPrice`. Cheaper eligible offers may fill first, but neither the quote nor purchase can exceed that unit-price boundary.
- Controller correlation now covers request ID, item, quantity, and price cap. A newer selection or quantity supersedes the prior request; mismatched and stale responses cannot enable purchase.
- Pending quotes have a nine-second timeout. Response, error, supersession, item change, close, disconnect, and destruction clear the timer. Timeout shows “Couldn’t load the current price.” with a keyboard-accessible Retry action and never enables purchase.
- Server quote results explicitly distinguish `available`, `quantity_unavailable`, `no_eligible_liquidity`, and `self_trade_only`. Same-account orders remain excluded at the account level; the UI announces “You cannot buy your own market order” rather than loading indefinitely.
- The ticket uses a compact live status (“Checking latest price…”), one small progress indicator, “Up to N gold each” before the quote, and an authoritative exact total with multi-level wording after success.

### Focused validation

- Reproduced with distinct authenticated development accounts and with separate connections sharing one account.
- Final browser/WebSocket smoke: DevPlayer2 listed 3 Food at 9 gold; DevPlayer3 received the authoritative 9-gold total and bought 1. Buyer wallet became 9,991, inventory remained 500 until collection claim, Collection Box received 1 Food, seller Collection Box received 9 gold, the order became 1/3 filled with 2 remaining, and public depth became 2. A second DevPlayer2 connection saw the public offer but received the explicit self-trade message and a disabled purchase action. A fresh settled browser tab reported no console warnings or errors.
- Client controller/UI: 34 focused tests passed, covering success, exact totals, rejection, explicit liquidity outcomes, timeout/Retry, quantity, level, and book-version supersession, stale response filtering, close/disconnect cleanup, reconnect behavior, Strict Mode, and disabled invalid quotes.
- Shared protocol: 34 tests passed.
- WebSocket boundary: 13 tests passed, including originating-connection routing and terminal MarketError/unexpected-error responses.
- Live PostgreSQL market integration: 47 tests passed, including capped multi-level quotes, same-account-only liquidity, no-liquidity outcomes, self-trade protection, no-trade/no-debit failure behavior, idempotency, concurrency, reconciliation, and price-time priority.

## Market reliability audit (2026-07-12)

A bounded reliability hardening pass added exact rendered regressions for 9→13, 13→9, and repeated activation of the already-selected seller level; a 50,000-transition deterministic quote-state model; protocol/runtime validator fuzzing; and authenticated WebSocket terminal-response coverage. It also tightened signed-bigint wire bounds, depth ordering/uniqueness/order-count validation, production mapping of pre-commit PostgreSQL `57014` to retryable `MARKET_BUSY`, and validation-harness reconciliation admission/drain coordination.

The fresh 5,000-operation Stage A run completed successfully with zero unexpected failures and clean reconciliation. Longer Stage B attempts exposed severe synthetic long-history throughput degradation and harness reconciliation/process-lifecycle defects; they were intentionally stopped and are not claimed as passes. Stage C, WebSocket stress, real multi-browser stress, and soak testing were not run. The historical generated evidence remains available in Git history; current reliability is governed by the repository quality gate and the production-hardening validation record.
