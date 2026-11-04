# Ash Atlas Market Foundation

The Market Foundation is one authoritative PostgreSQL exchange with two client interfaces:

- **Simple Market** presents grouped items, exact quotes, approachable listings, orders, and collection claims.
- **Merchant Market** presents the same exchange as bids, asks, aggregated depth, limit orders, fills, and open-order management.

There is no Simple-only inventory, listing table, price, escrow, wallet, matching path, or settlement path. A Simple listing is a normal good-until-cancelled sell order. A Simple purchase is an all-or-nothing immediate limit buy routed through the same locked book and matcher used by Merchant orders.

This foundation is designed for adversarial clients and crash-safe committed truth. It is not described as literally bulletproof: operational review, longer soaks, economic monitoring, and future security work remain necessary.

## Fail-closed access policy

Market access is server-authoritative and centralized in `MarketAccessPolicy`. Global access defaults to disabled in every environment. The isolated development launcher and live test harnesses enable it explicitly:

```text
MARKET_GLOBAL_ACCESS=true
```

The client cannot grant access. Production startup rejects `MARKET_GLOBAL_ACCESS=true` unless `MARKET_ALLOW_GLOBAL_ACCESS_IN_PRODUCTION=true` is also set, and startup logs the effective policy without logging secrets. A future policy can replace the global implementation with authoritative trade-hub and player-position checks without changing orders, matching, escrow, or settlement.

The initial venue is the stable `global` venue, named **Ash Atlas Global Exchange**, with scope `global_test`, an access-policy identifier, a versioned fee policy, and a database-backed active state. Every book, order, and trade belongs to a venue.

## Supported assets

The fungible catalog supports default stacks for the ordinary tradable resources declared by
`item_definitions`. Meaningful Enchantment Stone variants are also marketable: Diamond, Onyx,
Opal, Amethyst, Topaz, Sapphire, Ruby, and Emerald each have a separately isolated identity and
order book.

`item_definitions` owns `market_tradable`, `market_fungible`, `market_identity`, and supported
variants. The server resolves these fields; the client cannot declare an item tradable. Default
assets retain their existing `market_identity`. A meaningful non-default variant derives the stable
identity `<market_identity>:<variant>`, while orders and custody continue to store the authoritative
item ID and exact variant explicitly. Variants are never silently merged.

At startup the server compares every compiled definition with the database catalog, including ID, category, stackability, maximum stack, tradability, fungibility, market identity, and supported variants. Missing, extra, or drifting definitions fail startup before market traffic is accepted.

Water is deliberately not marketable. Fresh and salt water are meaningful inventory variants, so the authoritative catalog marks water non-tradable and non-fungible, removes its market identity, and keeps `default`, `fresh`, and `salt` as distinct supported variants. Water is absent from browse/search and quote/order paths reject it through the normal not-tradable result. A future product decision must choose separate market identities, an audited canonicalization, or one explicitly marketable canonical variant; the server never silently merges fresh and salt water.

Equipment instances outside the exact-equipment listing path, equipped items, bound or quest assets,
unsupported variants, damaged/upgraded/enchanted equipment, unique instances, affixed items, and
player-specific metadata are rejected. The current inventory has unlimited stacks and no
slot-capacity model, so item claims move all locked, bounded collection rows. If inventory capacity
is later introduced, the claim transaction must move only the capacity-safe portion and leave the
remainder in collection.

## Glimmer exchange and Lumen

**Lumen** is an ordinary carried item (`lumen`, category `currency`, weightless like a currency so it
never counts against carry capacity, droppable, storable):
it is listed, escrowed, filled, cancelled and collected exactly like any other Gold-priced item,
with no currency fee. Migration 0917 moved existing premium-wallet Lumen into inventory (one
`inventory_migration` wallet debit and one `lumen_wallet_migration` inventory credit per
account; a wallet whose account has no player keeps its balance frozen in place, still auditable,
and the migration reports it with a NOTICE) and closed the Lumen wallet. Lumen left in such a
no-player wallet is unrecoverable: the closed wallet accepts no further events and there is no
player to receive it (test server only; no such accounts are expected). The Economy Observatory
shows that move as an ADMIN debit of `currency:lumen` plus an ADMIN credit of `lumen`. Zero free minting is enforced in the database: a Lumen
inventory credit must come from `lumen_admin_grant` (the audited developer grant, capability
`developer:economy-mutate`), the migration, or a custody move (market fill, cancel, Collection
claim or repair, ground pickup, manor withdrawal), and a Lumen ground drop must match the
dropping player's own inventory debit and can never grow. Lumen follows the generic item rules:
there is no inventory loss on death, and a ground drop that expires is destroyed.

**Glimmer** (`currency:glimmer`) has its own Gold-priced book on this exchange. Its
`item_definitions` row only anchors the book; database guards keep it out of inventory and
Collections. Custody is the account premium wallet:

- A sell order debits the premium wallet for its quantity plus the seller's currency fee reserve
  (`market_premium_sell_terms`, 500 bps today).
- Each fill credits the buyer's premium wallet and moves the fee for that fill to the fee sink.
  The fee is `ceil(cumulative filled × bps / 10000)` minus what was already charged, so a fully
  filled order pays exactly `ceil(quantity × 5%)`. Gold legs use the venue's normal fee policy.
- Cancellation and expiration return the unused escrow (remaining quantity plus unused reserve)
  straight to the premium wallet.
- The only exchange wallet reason is `market`; a deferred guard ties every such event to exactly
  one premium escrow debit, fill credit or escrow return, and reconciliation checks the same
  boundary.
- Rate breaker: after a premium fill, the book freezes (operator `system:premium-rate-breaker`,
  audited) when its trailing 24-hour VWAP differs from the previous 24 hours by more than 50%,
  but only when each of the two windows has at least 5 fills and 1,000 Glimmer traded, so a thin
  market or one wash trade cannot trip it. A breaker freeze stops new orders and matching only;
  owners can still cancel and recover their escrow. The breaker mark (`sensitive_reason =
  'premium_rate_breaker'`) cannot outlive its freeze: any change of `frozen` that does not set the
  reason itself clears it, so a later manual freeze blocks cancels as usual. Unfreeze with
  `market:controls`.

**Glimmer-priced books.** `market_order_books.price_currency` is `gold` or `glimmer`; books are
unique per (venue, item identity, price currency), so an item's Gold and Glimmer books never
match each other, and Glimmer's own book can only be Gold. Requests name the book with
`priceCurrency` (`MARKET_GET_BOOK`, `MARKET_REQUEST_QUOTE`, `MARKET_CREATE_ORDER`; Gold when
omitted, and Gold request hashes are unchanged). On a Glimmer book the price leg is asset kind
`glimmer` (no item identity):

- A buy escrows `limit × quantity + buyer tax` in Glimmer from the premium wallet
  (`market-buy-escrow:` key); Simple Buy escrows the quoted total, as in Gold.
- Each fill credits the seller's proceeds (`market-trade-proceeds:<trade>`) and the buyer's
  price-improvement refund (`market-trade-refund:<trade>`) to their premium wallets; the buyer tax
  and seller fee go to the fee sink in Glimmer under the venue's normal fee policy.
- Cancellation and expiration return the unused buy escrow straight to the premium wallet
  (`market-cancel-premium:<order>`), with no Collection.
- The provenance guard ties every such `market` wallet event to exactly one order or trade, the
  order, journal and trade validators check the Glimmer leg against premium-wallet events instead
  of Gold wallet events, and reconciliation checks the same boundary.
- Catalog summaries describe each item's Gold book; a book read for `glimmer` returns that book's
  own summary (`priceCurrency: "glimmer"`).

**Glimmer-priced equipment.** Exact-instance listings carry `market_equipment_listings.price_currency`
(chosen at listing, immutable; `MARKET_CREATE_EQUIPMENT_LISTING.priceCurrency`). A purchase names the
currency the buyer saw (`MARKET_PURCHASE_EQUIPMENT_LISTING.expectedPriceCurrency`, part of the request
hash) and is refused when the listing is priced otherwise. A Glimmer purchase
debits the buyer's premium wallet for asking price plus buyer tax (`market-equipment-buy:`; the tax
leaves supply as it does in Gold) and credits the seller's premium wallet with the asking price
(`market-equipment-seller:<listing>`). The provenance guard accepts these `market` events only for a
sold Glimmer listing, with exactly one debit matching the ledger's `buyer_debit` and one credit, and
no Gold movement; the equipment ledger records Glimmer amounts in `glimmer_delta`. At commit, a listing
that became sold must have exactly its currency's money events (Glimmer: one debit, one credit, no
Gold; Gold: no Glimmer). Cancel and expiry move no currency. Every player market purchase path
(standard orders, Simple Buy and equipment) can therefore be priced in Gold or Glimmer.

**Catalog.** Browse rows summarize each item's Gold book plus its Glimmer book
(`glimmerBestAsk`, `glimmerBestBid`, `glimmerSellQuantity`, `glimmerBuyQuantity`,
`glimmerBookVersion`): "For sale" counts other players' listings across both books, the price shows
the best Gold ask with "or N Glimmer" (or the Glimmer ask alone), and an item listed only in Glimmer
is still shown.

**Economy Observatory.** Glimmer movements are projected once each: exchange legs (Glimmer's own Gold
book, Glimmer-priced escrow, fills, refunds and proceeds) come from `market_ledger_entries` as
balanced TRANSFERs (`currency:glimmer`), and the Glimmer fee or buyer tax leg goes into the market
fee holding and out as a SINK. Equipment sales (Gold or Glimmer) come from `market_equipment_ledger`
as a buyer-to-seller TRANSFER of the asking price plus a SINK of the buyer tax. The matching
premium-wallet `market` events and Gold `market_*` wallet events are not projected, so nothing is
counted twice and no market movement reads as a SOURCE. Gold fees and buyer tax on the standard
books get the same treatment (owner decision 2026-10-02): a transfer into the market fee holding and
a SINK out of it, where before 0917 they read as a transfer to external custody.



The repository had authoritative stack inventory but no currency system. Migration `0600_market_exchange_foundation.sql` therefore adds the first canonical account-linked player wallet, not a parallel market balance. Migration 0601 hardens both domains:

- `player_wallets` stores nonnegative integer gold and a mutation version.
- `wallet_events` is append-only and records each audited wallet delta, resulting balance, and exact resulting version.
- `player_inventory` stores bigint quantity and a mutation version; `inventory_events` records bigint delta, resulting quantity, and resulting version.
- Composite foreign keys prove that the authenticated `player_id` and `account_id` belong together.
- Market orders store both identities. Inventory remains player-owned; account identity drives self-trade prevention and replay scope.

`WalletService` and `InventoryService` are the shared transaction primitives. They lock the authoritative row, check a stable operation key, conditionally change the balance/stack and monotonic version, and append exactly one matching immutable event in the caller's transaction. Sell escrow and dropped-item creation use the inventory debit primitive; buy escrow and gold claims use the wallet primitive. Concurrent exact-balance or exact-stack debits therefore serialize in PostgreSQL, not in process memory.

Deferred commit guards independently require a contiguous event chain, one event per resulting version, correct delta/balance-after or delta/quantity-after arithmetic, and agreement between the latest event and authoritative row. Wallet/stack identity cannot change, authoritative rows cannot be deleted, and operations/events are immutable. The migration validates retained histories and inserts explicit genesis evidence only for pre-hardening opening state; it does not alter an existing asset balance.

Market prices, quantities, totals, balances, versions, and sequences use PostgreSQL `bigint`, TypeScript `bigint`, and unsigned decimal strings on the market wire. Inventory storage and event deltas are also bigint. The existing inventory snapshot protocol remains a JavaScript number, so every conversion is checked against the safe-integer ceiling and oversized mutations fail closed. No economic calculation uses floating-point arithmetic.

## Authoritative asset locations

An item unit is in exactly one recognized location: player inventory, live world-drop custody, sell escrow, buyer/return collection, or the explicit destruction sink. Gold is in a player wallet, buy escrow, proceeds/refund collection, or the fee sink. A transfer changes both sides atomically and records the domain event plus market journal or world-custody movement that explains it. Closed orders and non-active drops must have zero remaining custody. Reconciliation checks the durable movements independently; it is detection and protection, not a substitute for the commit guards.

## Dropped-item custody and replay

`world_item_drops.original_quantity` is immutable; `remaining_quantity` is the public snapshot's `quantity` and can only decrease. Creation stores an intent hash and the original committed drop/inventory result in `world_item_drop_requests`. Replaying the same player/request/intent returns that original result without another debit even after partial pickup, full pickup, expiry, or a process restart; a changed intent conflicts.

Drop creation atomically debits through `InventoryService` and appends a `player_to_world` custody movement. Pickup locks the drop, credits through the same inventory domain, decreases remaining custody, and appends one `world_to_player` movement tied to the pickup operation. Expiry sets remaining custody to zero and appends one `world_to_destruction` movement. Unique movement keys and deferred drop-conservation guards reject missing, duplicated, or mismatched custody history at commit.

Single-drop expiry holds the row lock used by pickup. Bounded bulk expiry uses one CTE with `FOR UPDATE SKIP LOCKED`, update-returning, and destruction insertion, so a pickup-versus-expiry race has one winner and cleanup/list retries cannot duplicate destruction evidence.

## Database foundation and additive hardening

Migration `0600_market_exchange_foundation.sql` establishes the exchange schema. Additive migration `0601_market_economy_hardening.sql` upgrades already-migrated databases without rewriting 0600; both stay inside the reserved `0600-0699` range. The foundation includes:

- Catalog tradability/search metadata
- Canonical `player_wallets`, immutable `wallet_events`, and append-only hardening for shared `inventory_events`
- `market_fee_policies`
- `market_venues`
- Global, venue, book, and player control/freeze state
- Durable `market_order_books`
- Durable `market_requests` replay results
- `market_orders` and `market_order_escrows`
- Immutable `market_trades`
- `market_collections` and immutable `market_claims`
- Durable Simple quotes
- Immutable `market_ledger_groups` and `market_ledger_entries`
- Immutable `market_audit_events`
- Durable abuse-control windows

The migration seeds exactly one active global venue and a zero-fee policy version. Full-text catalog search has a partial GIN index. Matching uses side-specific partial indexes. Own-order, trade-history, collection, freeze, audit, and reconciliation lookups are indexed.

Database constraints cover positive prices and quantities, nonnegative state, exact `filled + remaining = original`, status/timestamp combinations, actor ownership, venue/book ownership, item/gold collection shape, source provenance, unique priority, unique requests, unique trade settlement, and valid enumerated states. Deferred commit validators reject incomplete replay reservations, empty/unbalanced journals, malformed order/escrow relationships, invalid trade parties or maker prices, missing settlement collections, and provenance mismatches. Closed orders, escrow, collections, inventory/wallet events, trades, claims, journals, and audit evidence are immutable or strictly monotonic as appropriate.

The additive validators also recompute cumulative escrow journal net against the escrow row, require closed escrow to be zero, enforce both order limits and maker price on every trade, reconstruct buy exposure and fee reserve, and independently recompute each price-improvement refund. Ledger group/entry compatibility checks reject extra or missing settlement movements. These are deferred constraint triggers: malformed raw SQL may be assembled during a transaction, but COMMIT is the authority that rejects it.

## Orders and state machine

The supported order states are:

```text
Open -> Partially filled -> Filled
  |          |
  +-------> Cancelled
```

Valid direct transitions are:

- Open → Partially filled
- Open → Filled
- Open → Cancelled
- Partially filled → Filled
- Partially filled → Cancelled

Closed orders cannot transition or receive fills. Price, side, quantity, owner, item, venue, policy, priority, fee version, rules version, and creation identity are immutable. Repricing or increasing quantity requires cancelling the old order and creating a new order with new priority.

Good-until-cancelled limit buy and sell orders are available in Merchant Mode and for Simple listings. Simple purchasing uses an all-or-nothing immediate-or-cancel limit order generated from an authoritative quote. The AON order is never committed partially filled.

Plain IOC is not implemented and is not admitted by the TypeScript or PostgreSQL order-policy constraints. The hardening migration fails closed if it encounters a retained plain-IOC row rather than guessing settlement semantics.

Resting-order limits are evaluated only after matching, while the authoritative book lock is held. A fully crossing Merchant GTC order may therefore take liquidity even when the book, actor, or account/book resting cap is saturated. The incoming order is excluded when counting other resting orders. If matching leaves a nonzero remainder that cannot legally rest, the entire transaction is rejected: fills, escrow, order, collections, journal, audit, and replay result all roll back together. The per-account/per-book resting cap prevents one account from consuming the whole book without changing taker behavior.

## Serialization, matching, and trade price

Every `(venue, item identity)` has one durable order-book row. A mutation obtains `SELECT ... FOR UPDATE` on that row. The lock works across future backend processes; no JavaScript mutex is a financial correctness boundary. Different actors and items may proceed concurrently.

The lock order is global controls, actor control, venue, book, order/request, escrow, and authoritative wallet/inventory/collection rows. PostgreSQL deadlock (`40P01`) and serialization (`40001`) failures receive bounded retries with the same request ID. Other programming or constraint failures are not retried.

Priority is deterministic and server-owned:

- Sells: lowest unit price, then oldest monotonic priority sequence.
- Buys: highest unit price, then oldest monotonic priority sequence.

The resting maker's limit price is the trade price. Each resting order is locked and revalidated before settlement. Matching walks deterministic batches of at most 500 rows while retaining the durable book lock until the incoming order is filled or no eligible liquidity remains; quotes use the same bounded price-time traversal. Account-equal resting orders are skipped, so a player cannot wash trade against another session or client path on the same account. Public book and trade DTOs never expose counterparty identity.

`matching_enabled` is independent of the new-order switch. When new orders are disabled, every create is rejected. When matching alone is disabled, Simple Buy is rejected, and a Merchant order is checked under the book lock: an eligible non-self crossing order is rejected, while a noncrossing GTC order may rest if every normal cap passes. Cancellation and collection claims remain governed by their own controls.

## Simple quotes and purchases

Simple search is server-side, full-text indexed, cursor-paginated, and bounded. The client debounces requests by 200 ms, ignores stale responses, retains at most 40 item summaries, and never loads the complete market.

A quote contains item identity, requested and fillable quantity, exact quoted total, maximum unit price, book version, expiration, and quote ID. The quote excludes the player's own asks. Confirmation sends only the quote ID and a maximum acceptable total.

Quote creation uses the client request ID as durable account-scoped idempotency. Repeating the same request and intent returns the original committed quote; reusing the ID for different intent conflicts. A new quote for the same account and book replaces the prior unexpired quote, and the configured outstanding-quote cap defaults to one. Replacement/expiry affects usability, not durable replay truth.

The purchase transaction relocks the quote and book, verifies ownership/expiry/version, recomputes non-self liquidity and total, and either:

- Fills the complete quantity at maker prices within the confirmed maximum; or
- Rejects without debiting gold or creating any trade.

One UI result may represent multiple immutable fills. For example, four ore at 8 and six ore at 9 settle as two fills and one 86-gold Simple result.

Browse, category, book, quote, and subscription operations use database-backed account rate windows. The WebSocket boundary adds a cheaper connection and privacy-preserving hashed-network limiter before database work. Market reads have bounded statement timeouts, and each compound browse/book snapshot runs in one read-only repeatable-read transaction so summary, depth, trades, wallet, orders, and collections come from one PostgreSQL snapshot.

## Escrow, settlement, and fees

Sell creation moves inventory → sell escrow atomically. Buy creation moves wallet → buy escrow atomically. Escrow cannot be used, equipped, dropped, consumed, relisted, or spent elsewhere.

Each fill atomically creates or updates:

- Both order quantities and states
- Both escrow balances
- One immutable trade at maker price
- Buyer item collection
- Seller proceeds collection
- Any exact price-improvement refund
- Explicit fee sink entries
- One balanced journal group
- An audit event

Settlement does not depend on either party being connected. WebSocket messages are notifications of committed database truth.

Fee policies are versioned and use integer amounts/basis points with deterministic floor rounding. Every order snapshots its policy ID/version. A fill uses the buy order's snapshot for the buyer fee and the sell order's snapshot for the seller fee, and the immutable trade persists both references. Trade journal groups carry both buyer and seller policy provenance, order escrow/cancellation groups carry the order policy, and claim groups carry no fictitious fee version. Rotating the venue to a new policy therefore never changes or underfunds a resting order. Policy IDs, versions, economic terms, and creation timestamps are immutable; only `active` may change.

Development policy version 1 sets listing, buyer, seller, and cancellation fees to zero. Buyer and seller transaction fee paths are implemented; zero fees use the same settlement code. Listing and cancellation fee columns remain reserved for a later explicit product decision. If either value is nonzero, this server fails the affected quote/order/cancellation closed with `MARKET_FEE_POLICY_UNSUPPORTED` instead of silently ignoring the configuration.

## Collections and claims

Trades and cancellations never force asynchronous assets into normal inventory or wallet state. Collection storage safely holds:

- Purchased items
- Cancelled sell returns
- Seller proceeds
- Cancelled buy refunds
- Price-improvement refunds

Claims authenticate the actor, lock a bounded ordered set of collection rows, use the shared inventory or canonical wallet transaction path, journal both sides, and mark only committed rows claimed. Requests are durable and idempotent. A repeat with the same request ID returns the prior result. Concurrent different claim IDs serialize; assets move at most once.

## Conservation journal and reconciliation

Every movement has paired append-only entries grouped by asset identity. Examples include:

- Inventory → sell escrow
- Wallet → buy escrow
- Sell escrow → buyer collection
- Buy escrow → seller proceeds/refund/fee sink
- Escrow → cancellation collection
- Collection → inventory/wallet
- Inventory → world-drop custody
- World-drop custody → inventory or destruction sink

The database checks each group balances at commit. Corrections require compensating entries rather than history mutation.

`MarketReconciliationService` independently validates orders, fills, escrow, trade references and maker price, fees, journal balance/location, collection provenance and claims, negative state, duplicate/orphan state, and closed-order escrow. It joins each market sell debit and item claim to the exact shared inventory operation/event, each buy escrow and gold claim to the exact wallet event, and verifies inventory and wallet event chains against current authoritative balances. Its set-based dropped-item pass independently reconciles original quantity, live remainder, pickup records/movements, destruction, replay rows, and the matching inventory events. A journal or custody history that balances internally but disagrees with a domain boundary therefore fails reconciliation.

Every market mutation takes a shared transaction-scoped PostgreSQL advisory lock. A full reconciliation takes the corresponding exclusive session lock before opening one read-only repeatable-read transaction, which drains earlier mutations and blocks later ones until detection, configured protection, and critical audit evidence have committed together. This closes the detection-to-freeze transaction gap without relying on a process-local mutex. Lock acquisition and reconciliation statements have bounded timeouts.

The normal server owns a reconciliation supervisor. Startup runs a full reconciliation before market traffic is accepted; an exception fails startup, findings may proceed only after configured protection commits, and protection failure fails startup. Scheduled runs are non-overlapping, an invariant failure requests a prompt coalesced run, and graceful shutdown clears the timer and waits for the active run. Readiness exposes last start/completion/success, duration, issue count, bounded last error, protection state, affected books, global read-only state, in-progress state, and successful-run age. It is unhealthy after a failed run, detected issues, global read-only protection, no successful run, or a configurable stale threshold.

Run:

```powershell
pnpm --filter @ash-atlas/server market:reconcile
pnpm --filter @ash-atlas/server market:reconcile -- --read-only
pnpm --filter @ash-atlas/server market:reconcile -- --audit
pnpm --filter @ash-atlas/server market:reconcile -- --freeze-books
pnpm --filter @ash-atlas/server market:reconcile -- --freeze-global
```

With no CLI options, reconciliation honors `auto_pause_on_invariant_failure` from `market_global_controls`: failures record a critical audit, freeze affected books, and fall back to global read-only for unscoped failures. `--read-only` performs diagnosis without mutation; the other flags select an explicit protection mode. Protection uses the same locked reconciliation transaction and retries only recognized PostgreSQL deadlock/serialization failures. It never guesses a balance correction or automatically unfreezes a scope.

## Circuit breakers

Database-backed controls independently support:

- Global read-only mode
- New-order disable
- Matching disable
- Cancellation disable
- Claim disable
- Venue freeze
- Item/book freeze
- Account/player mutation freeze
- Automatic reconciliation protection

Normal clients have no control mutation protocol. Privileged local operators can inspect controls without mutation. Every mutating command requires an explicit operator identity and nonempty reason; an incident/change identifier is optional:

```powershell
pnpm --filter @ash-atlas/server market:controls
pnpm --filter @ash-atlas/server market:controls -- --global-read-only=true --operator=ops@example --reason=incident-review --incident-id=INC-123
pnpm --filter @ash-atlas/server market:controls -- --item-id=ore --item-frozen=true --operator=ops@example --reason=book-review
pnpm --filter @ash-atlas/server market:controls -- --global-read-only=false --new-orders=true --matching=true --operator=ops@example --reason=recovery-complete
```

The CLI supplies audit context with transaction-local PostgreSQL settings. Database triggers on global, venue, book, and player controls reject a real state change without operator/reason context and atomically append immutable prior state, resulting state, target scope, timestamp, operator, reason, and optional incident ID. The status view includes every global switch, including automatic invariant protection. Sensitive reasons stay operator-only and are not exposed in public DTOs.

### Recovery after automatic protection

1. Leave the affected books frozen or the market globally read-only. Do not disable triggers or edit immutable history.
2. Preserve the critical reconciliation event and the control-change audit chain, including the incident ID used for response work.
3. Run read-only reconciliation and inspect every reported order, collection, wallet, inventory, drop, and journal boundary.
4. Repair only through a reviewed migration or explicit compensating economic entries; never rewrite settled trades or events.
5. Run full reconciliation again and require a clean report plus a recent healthy readiness state.
6. Restore the narrowest control scope with `market:controls`, a named operator, a recovery reason, and the incident ID. Reconcile once more after restoration.

There is intentionally no automatic unfreeze path.

## Live updates and client behavior

The existing authenticated WebSocket derives both actor IDs from the live session. Market payloads cannot supply player, account, seller, balance, fee, trade result, escrow, or success authority.

Subscriptions are full replacement sets keyed by connection, with a capped visible-item list, one focused book, private-state preference, and monotonic revision. They are centrally removed on ordinary close, replacement, logout, backpressure closure, or shutdown.

Public summary/book notifications are replaceable under backpressure. Private order/collection notifications and direct request results are critical and go only to the originating/affected connection. Reconnect gates economic actions until a fresh bounded market snapshot arrives, then replays pending mutation intent with the same stable request ID. Duplicate or missed events never move assets. The client runtime-validates every market server-message variant before market state or `BigInt` rendering sees it.

Committed notification fanout currently uses the backend process's connection registry. PostgreSQL economic correctness is safe across multiple backend processes, but a horizontally scaled deployment must add a shared committed-event transport so subscribers attached to other processes receive timely refresh notifications. Missed notifications remain safe because reconnect and refresh always reload bounded authoritative database state.

The client applies no permanent optimistic economic result. It displays pending, confirmed, stale, maintenance, and failed states and refreshes normal inventory after sell escrow or item claims.

## User interfaces

The HUD includes a visible **Market** button and keyboard shortcut. The responsive overlay has:

- Simple/Merchant presentation toggle
- Server categories, search, sorting, grouped item cards, and local bundled icons
- Item detail and bounded loading states
- Exact Simple quote/confirmation and Simple sell review
- Merchant bid/ask depth, recent trades, item-scoped own open orders, and limit-only order entry
- My Orders with partial quantities and cancellation
- Collection Box with item/gold claims
- Wallet, access, freeze, stale-price, offline, retry, and committed-result feedback

The overlay is mobile-first with safe viewport sizing, sticky navigation/actions, horizontally scrollable categories, large touch targets, keyboard/Escape behavior, accessible dialog/tab semantics, and bounded rendering.

## Limits and abuse controls

Conservative settings are centralized in environment configuration:

- Active orders per player/account
- Open orders per item book across all accounts, hard-capped at 500 so every possible fill set fits the shared bounded mutation-result contract
- Resting orders per account and book
- Order quantity, unit price, and total value
- Requests and cancellations per minute
- Browse, book, quote, and subscription database requests per account
- Market requests per connection and hashed network identity at the WebSocket boundary
- Outstanding unexpired quotes per account and book
- Collection rows per claim
- Simple purchase quantity
- Search results and depth levels
- Quote lifetime
- Read/reconciliation statement timeouts and reconciliation-lock timeout
- WebSocket frame and pre-parse payload bytes
- Transaction retry count

The WebSocket server and the pre-JSON-parse boundary enforce the same payload ceiling. Oversized frames are closed deterministically without parsing or logging an attacker-controlled body. Invalid or malicious inputs are rejected, never silently clamped into another order.

## Testing and operational harnesses

Financial correctness tests use live PostgreSQL. They cover validation attacks, durable replay, one thousand simultaneous duplicates, exact inventory/wallet escrow races, a 200-buyer final-unit race, concurrent book-limit enforcement, same-price server time priority, one large order filling many counterparties, fill/cancel and claim races, self-trade attempts, account/item control races, maker pricing, multi-seller AON purchases, stale quotes, fault rollback, lost responses, fresh-pool restart recovery, migration constraints, and full reconciliation.

Controlled fault points exist before/after inventory debit, after escrow, after order creation, during multi-fill, after trade, after journal insertion, before commit, after commit/before response, during cancellation, and during claim. Production configuration cannot enable test faults.

The deterministic property gate runs two serial live-PostgreSQL state machines. The main market model compares independent reference state, database state, and reconciliation after every generated step (20 cases by 40 transitions by default). A seeded cross-domain machine forces nonzero buyer/seller fees, durable quote replacement and replay, an illegal post-fill remainder rollback, and dropped-item create/partial-pickup/full-pickup/expiry/restart-replay conservation. `MARKET_PROPERTY_SEED`, `MARKET_PROPERTY_CASES`, and `MARKET_PROPERTY_STEPS` make a failing run exactly reproducible; assertion labels include the seed and step. The local matrix script defaults to ten distinct seeds (`600001` through `600010`) and refuses to run without a dedicated live test database:

```powershell
$env:MARKET_TEST_DATABASE_URL = 'postgres://ash_atlas:ash_atlas@127.0.0.1:55432/ash_atlas_markets_test'
pnpm test:market:property:matrix
```

The GitHub Actions market-hardening gate gives each of those seeds an isolated PostGIS service and uploads the verbose seed log. A separate live job verifies a fresh migration and no-op rerun, then captures live integration, deterministic stress, a bounded 30-second soak, final reconciliation, and authenticated WebSocket smoke evidence as retained workflow artifacts. The stress/soak harness refuses any database not ending `_test` or `_validation`, seeds audited assets, mixes reads and economic mutations, models deterministic disconnect/reconnect availability with a fresh bounded snapshot on reconnect, reconciles periodically/finally, and reports latency percentiles, connection-state counters, failures, retries/deadlocks, memory, handles, pool state, and database counts. The authenticated smoke harness remains the real WebSocket reconnect boundary; the direct-service stress model does not claim to open network sockets.

`pnpm build` emits the server entrypoint expected by `pnpm --filter @ash-atlas/server start` and the production client bundle. The server build bundles repository-owned server/shared TypeScript while leaving installed runtime packages external; `pnpm build:verify` syntax-checks the emitted Node entrypoint.

```powershell
$env:MARKET_TEST_DATABASE_URL = 'postgres://ash_atlas:ash_atlas@127.0.0.1:55432/ash_atlas_markets_test'
pnpm --filter @ash-atlas/server market:stress -- --operations=5000 --players=200 --concurrency=32 --seed=600002
pnpm --filter @ash-atlas/server market:soak -- --duration-seconds=600 --players=200 --concurrency=24 --seed=600003
pnpm --filter @ash-atlas/server market:smoke-auth
```

The authenticated smoke harness creates three real development identities and sessions in a disposable validation database, exercises the WebSocket boundary, flow/replay/race/read-only/reconnect behavior, reconciles, and drops the database. It also reports a bounded request-send-to-committed-book-notification latency measured at a consistently subscribed non-actor socket. It refuses gameplay database names.

After launching the isolated Markets runtime, the same full authenticated flow can explicitly target its real network listener:

```powershell
$env:MARKET_SMOKE_RUNTIME_WS_URL = 'ws://127.0.0.1:3011/ws'
$env:MARKET_SMOKE_DATABASE_URL = 'postgres://ash_atlas:ash_atlas@127.0.0.1:55432/ash_atlas_markets_dev'
$env:MARKET_SMOKE_KEEP_DB = 'true'
pnpm --filter @ash-atlas/server market:smoke-auth
```

This mode reports `launched-network-websocket`, sends real WebSocket upgrades with authenticated Cookie and Origin headers, and never creates, migrates, recreates, or drops the retained dev database. The opt-in fails before database access unless all three values exactly select the local Markets listener and `ash_atlas_markets_dev`. Its audited smoke records remain available for inspection; rebuild the isolated dev database before a fresh repeat.

## Runtime

The feature-specific Markets launcher was retired after integration. Run the permanent baseline:

```powershell
.\tools\dev\run-main.ps1
```

or double-click `Run Ash Atlas.cmd`. The canonical launcher requires protected `master`, verifies the
paired pipeline identity, enables development global access, applies migrations idempotently, and
uses strict-port mode.

## Known limitations

- The first venue is still a global development exchange. Physical access and geographic market boundaries are not implemented.
- Committed notification fanout remains process-local. Multi-process economic correctness is database-backed, but timely cross-process refresh needs a shared committed-event transport; clients recover from missed hints through bounded refresh/reconnect.
- Scheduled and invariant-triggered reconciliation runs are full scans. There is no separate targeted reconciliation pass between full runs.
- Water trading remains disabled until variant market identity is a deliberate product decision.
- Listing and cancellation fee columns are reserved but nonzero values fail closed; only buyer and seller transaction fees are implemented.
- Control mutation is an authenticated operational database/CLI procedure, not a remote game-client administration API.

## Explicitly deferred

- Physical trade hubs and geographic proximity access
- Regional, kingdom, and city-local markets
- Auctions
- Direct player-to-player trading
- Unique/upgraded/damaged gear equivalence
- Enchanted or affixed-item equivalence
- Candlesticks and advanced price charts
- Full economic analytics dashboard
- Margin, loans, leverage, short selling
- Shipping time
- Merchant reputation

These features must not bypass or fork the authoritative exchange when introduced.
