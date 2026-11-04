# Ash Atlas: Settled status, doorways, alert zones, and native anti-spoof build

Status: **audited 2026-10-02**. Extends `docs/architecture/ACCOUNT_TRUST_AND_ANTISPOOF_PLAN.md` (WP10 Attestation, WP11 Native
location plugin) and replaces its alt-doorway "3 confirmed days" rule with **Settled**. Verified against `test/t1361` (`cfa197ede`),
worktree `C:\Users\dev\Documents\worktrees\native-antispoof__t1361`. Items marked **[owner]** need a decision (§13);
everything else is ready to implement.

## Audit findings

Severity: High = a motivated cheater still wins or honest players are hurt badly; Med = real weakness or technical error; Low = polish.

| # | Sev | Weakness | Change made |
|---|---|---|---|
| 1 | **High** | **The invite is not the only doorway.** Ordinary travel reaches destinations the alt creates: personal flags in `public`/`normal` mode admit any traveller (`apps/server/src/game/flagAccess.ts:101-113`); city flags admit everyone (`flagAccess.ts:89-91`); cities are joined socially (`JOIN_CITY`, `settlementHandler.ts:1540`) and listed on the World Map (`worldMap.ts:462-473`), kingdom seats for members (`worldMap.ts:485-496`). Flag placement, `FOUND_CITY` (`settlementHandler.ts:275`) and `CONVERT_CITY_FLAG` (`:1664`) are land actions with no check (owner rule). So: alt spoofs once, places a public flag or founds a city, mains travel there with no invite, no Settled, no presence proof. | New §3.3 **anchored destinations**: a flag/city/seat/manor is a travel destination for *other* players only while its owner is Settled with a Settled home within `TRUST_HOME_DESTINATION_RADIUS_KM`. Travel-authorization rule, not a land-action check; owner's own use is unaffected. Shadow first. |
| 2 | **High** | **Presence exemption + land actions = invite chains.** `checkHost` skips presence proof when the destination is the host's own flag, a flag of their city/kingdom, their seat or manor (`altDoorway.ts:209-218`, `trustStore.ts:965-996`). An invited arrival places a flag (allowed; only burn/attack are held, `flagHandler.ts:74` vs `:187-259`) and re-invites to "their own flag" with no presence. A spoofed alt places a flag, goes home, Settles honestly, then invites to the far flag. | Exemption now applies only to **anchored destinations within the radius of the host's Settled home**. Everything else needs a live native fix. Chains die because the arrival's home is far away. Same rule for party travel (`partyHandler.ts:757-809`, `travelRealtimeOperations.ts:2631-2658`). |
| 3 | **High** | **"Web fixes never count" and "phone-only" are claims until attestation.** `clientPlatform` is the WS query parameter (`realtime/clientReleaseGate.ts:20-30`, used at `realtimeApplication.ts:1394,1915`); the native auth exchange is plain HTTP. Presence proof accepts any fix, including spoofed browser fixes. In `shadow` assurance, a browser with `platform=ios` earns Settled. | §2.3/§2.7: presence proof and Settled counting read `last_fix_assurance`; assurance enforce flips **the day both store builds are live** (not after 14 d/90 %); rollout truth stated in §9: until then Settled is only as strong as today's doorway, so the structural fixes (#1, #2, #4) ship in Deploy 1 because they do not depend on attestation. |
| 4 | **High** | **Yellow 10 km geometry is evadable and taxes honest city players.** Siege units march on their own (`militaryIndustry.ts:1482-1508`, deploy after arrival `:2218`, range `SIEGE_ATTACK_RANGE_METERS = 575`, `packages/shared/src/militaryIndustry.ts:111`); the relocation point is not the attack point: relocate or found a city at 11 km and march. And in any populated area every newcomer is within 10 km of someone's territory, so yellow difficulty would hit all honest urban players. | §3.4 **hostile-action gate by status**: unsettled accounts cannot burn/attack others' flags or issue hostile military orders (no geometry, no location check, PvP untouched). Yellow becomes alert + difficulty **only in non-urban cells**. **[owner]** scope in §13. |
| 5 | **High** | **Grandfathering imports old spoofers.** Migration 0884 blanket-confirmed every account older than 14 days (`db/migrations/0884_alt_doorway.sql:21-30`); passive fixes have existed for ~1 day, so almost no `confirmed_days` were earned. Draft §2.5 would make all of them Settled with zero verified checks. | §2.5: accounts with earned `confirmed_days ≥ 3` and no mock/impossible-speed signal → Settled; the rest → **provisional** Settled for 30 days with half targets, revoked if not earned. **[owner]** window length. |
| 6 | **High** | **Red hold is a free alert generator.** Red relocations do not consume the cooldown, so a spoofer can file unlimited red alerts (review-queue DoS); orange/yellow alerts are per relocation. | §4.5: one open red alert per account; repeated red attempts within 30 d refused without a new alert + signal; alert rate limits per account; new-account red = severity 4. |
| 7 | **Med** | **`gps_static` as a hard reset is a false-positive trap.** Stationary phones (iOS especially, with `maximumAge` and low accuracy) return the identical cached fix repeatedly; a player at home for 40 min loses Settled. | Soft signal (+0.5/day, never hard). Settled grant additionally needs ≥ 3 distinct positions among counted fixes. |
| 8 | **Med** | **`ip_location_mismatch` hard reset punishes VPN/CGNAT/hub-routed users and a VPN near the spoofed spot bypasses it.** | On VPN/hosting ASN: skip the distance rule (no hard reset) **and the fix does not count toward Settled**. Mobile ASNs use country-level mismatch (carrier hubs sit hundreds of km away); fixed-line uses 500 km. Hard only on non-VPN ASN, 3 fixes/24 h. |
| 9 | **Med** | **7-day lock and home semantics.** Any relocation > 25 km loses Settled and progress; honest travellers lose it every trip. Plan's "anchor = last relocation" contradicts live `homeSql` (first relocation only, `trustStore.ts:116-122`). The DB guard hardcodes `interval '24 hours'` (`game/players.ts:749`) and copy says 24 h (`travelHandler.ts:700`, `travelRealtimeOperations.ts:1350`, `apps/client/src/App.tsx:4318`). | §2.4 **Settled home** kept separately; relocating back within radius restores Settled and is exempt from the lock **[owner]**. `account_settlement` is the single home source. SQL guard + copy fixed in A1/A5. |
| 10 | **Med** | **Shared-network block (O10) uses a /24 prefix** (`auth/networkTelemetry.ts:55-59`); carrier CGNAT puts strangers in one /24 → honest invites blocked. | Block only when the shared prefix is on a non-mobile ASN (needs A6's ASN classes); mobile ASN stays signal-only. |
| 11 | **Med** | **Account deletion is a soft delete** (`accountDeletionService.ts:416-417`) and touches no trust table, so `ON DELETE CASCADE` never fires; home, fixes, alerts and attestation rows would survive deletion (privacy + store policy). | A9: deletion transaction clears `account_settlement`, `trust_alerts`, attestation rows and (existing gap) `location_reports`, `account_location_state`, `account_regions`, `account_trust_*`. |
| 12 | **Med** | `counted_days date[]` with `CHECK cardinality ≤ 31` would fail the whole location-report transaction on day 32. | `counted_days integer` + `last_counted_day date` (same pattern as 0884). |
| 13 | **Med** | **O11 conflates `trust:reverse` (signals) with undoing game damage.** Burned flags and sieges have no undo. | §3.6: inviter accountability = arrival graph (`trust_arrivals`), **mass-arrival alert**, admin "quarantine everyone this host brought in since T". Game-state restoration is manual and out of scope. |
| 14 | **Med** | **Web becomes unable to invite or lead party travel** once relocation is phone-only: browsers then never produce fixes (`deviceGeolocation.ts:59-77` requires a browser relocation in-session), so presence proof always fails. Not stated anywhere. | Stated as intended (strict) with copy: "Open the Ash Atlas app on your phone to send Travel Invites." |
| 15 | **Med** | Attestation spec gaps: Play Integrity `certificateSha256Digest` is base64url (config is hex); Standard API needs warm-up; default quota 10 k/day; bound-fix compare must use the formatted strings; multi-country IANA zones; DB-IP MMDB needs a reader dependency. | §8.5/§5 notes. |
| 16 | **Med** | Hard-mismatch/mock revocation must also cut the doorway immediately: pending invites from the host stay valid and anchored destinations stay open until read. | Revocation calls `invalidateForInviter` (`game/travelInvites.ts:467`) and anchoring is compute-on-read (no stale column). |
| 17 | **Low** | Passive-fix limiter is per connection (`travelHandler.ts:337-348`); reconnecting resets it. Harmless for Settled (DB gap per account) but the "burst allowance" must be per account to mean anything. | §2.8. |
| 18 | **Low** | Secret-threshold leaks: session `trustActionFixes` reveals *status*, not thresholds (acceptable); the numbers live in this doc, `.env.example` and config defaults, which is fine only while the repo is private. | §2.2: never in wiki, patch notes, UI, or support replies. |

Kept from the draft because it is correct: Settled concept and targets, phone-only relocation, free re-pick, red/orange handling, population grid design, the native plugin, attestation verification flow, signal weights, config layout, store/privacy work, test checklists.

## 0. Threat and principle

An alt is harmless alone. The weapon is **any doorway that brings legitimate accounts to a place the alt faked**: Travel Invites, Party
Travel, **and persistent travel destinations** (public flags, cities, kingdom seats, manors) that the alt creates with a single spoofed
relocation. Secondary threats: spoofed relocation to uninhabited places (rare resources), and settling beside a kingdom to siege it
over days. Avatar movement is leashed (`players.move_leash_radius_m`), so relocation, travel and doorways are the only ways to cross
distance.

Principle: **moving yourself is free; bringing others is earned, in person, at home.** A doorway opens only when a Settled person is
physically there now (invite/party) or the destination sits in the area where they proved they live (anchored destination).

Owner rules (non-negotiable):
- Land actions never wait on a location check. Settled players get **no** action checks. PvP/combat is never checked.
- New players must be able to relocate home and build immediately.
- Strict over loose. Thresholds are **secret**: server-only, never in client code, never in player-facing text.
- Random passive checks every 3–7 min, foreground only, never prompting (already live: `apps/client/src/location/locationFixScheduler.ts`).
- Every new block ships in `shadow` first unless stated; rollback is one env flip.

## 1. Owner decisions (2026-10-02) with audit amendments

| # | Decision | Audit |
|---|---|---|
| O1 | **Settled** status. Earned by play from the home area on a verified phone; lost on a spoof flag. | Kept. Adds **Settled home** and return-home restore (§2.4). |
| O2 | Unsettled accounts cannot send Travel Invites or lead Party Travel. They can accept invites / join parties. | Kept. Now also cannot be the owner of an anchored destination (§3.3) or attack others' flags (§3.4). |
| O3 | Relocation is phone-only (native app). | Kept. Consequence stated: invites/party lead are phone-only too (finding 14). |
| O4 | 7-day home lock; one free re-pick in a new account's first hour. | Kept. Return to Settled home proposed exempt **[owner]**. |
| O5 | Unsettled accounts get non-blocking action checks on top of random checks. | Kept (native only; evidence capture, §2.8). |
| O6 | Alert zones: red = held for review; orange = harder to settle + alert; yellow (≤ 10 km of another's territory) = harder + no siege/burn on that owner until Settled + alert. | **Flaw (finding 4).** Red/orange kept. Yellow attack restriction replaced by the status-based hostile-action gate; yellow alert/difficulty limited to non-urban cells. |
| O7 | Mismatch signals: IP vs GPS, carrier country, timezone, static GPS. | Kept with the corrections in §5 (findings 7, 8). |
| O8 | Play Integrity + App Attest (DeviceCheck fallback) + mock detection. No motion data. | Kept. |
| O9 | No "land actions within X km of real location". Guard the invite. | Kept. The anchoring rule guards *travel to* a destination, never the action that creates it. |
| O10 | Young inviters (< 30 d): 24 h arrival hold; shared-network invites blocked. | Kept; network block limited to non-mobile ASNs (finding 10). |
| O11 | Invites logged per inviter; `trust:reverse` undoes damage. | **Flaw (finding 13).** Replaced by arrival graph + mass-arrival alert + bulk quarantine; `trust:reverse` stays for signals. |

## 2. Settled

### 2.1 State (`account_settlement`, migration `0912`, §7)
One row per account. `home_lat/lon` (**current anchor** = last applied GPS relocation, else first counted native fix), `home_set_at`,
`settled_home_lat/lon`, `settled_home_at` (where Settled was earned; cleared only on revocation for cause), `target_checks`,
`target_days` (secret, per account), `difficulty` (1.0 / 1.5 yellow / 2.0 orange), `counted_checks`, `counted_days`,
`last_counted_day`, `last_counted_at`, `distinct_positions` (count of distinct 4-dp lat/lon among counted fixes, capped at 10),
`settled_at`, `provisional_until`, `unsettled_at`, `unsettle_reason`, `free_repick_used_at`, `updated_at`.
`account_settlement` is the **only** home read by Settled, doorway and anchoring code; the 0884 `account_location_state.home_*` /
`confirmed_days` columns stay for compatibility but nothing new reads them (`altDoorway.ts` stops reading `confirmedDays`).

### 2.2 Targets (server-only, `config.ts`, never sent to clients)
- `TRUST_SETTLE_CHECKS_MIN/MAX` = 22 / 30, `TRUST_SETTLE_DAYS_MIN/MAX` = 4 / 6. Rolled uniformly with `crypto.randomInt` on row
  creation and on every home change, then multiplied by `difficulty` (ceil). Visible only on the developer Trust screen.
- `TRUST_SETTLE_RADIUS_KM` = 25 (from the current anchor), `TRUST_SETTLE_MIN_GAP_SECONDS` = 170, `TRUST_SETTLE_MIN_DISTINCT_POSITIONS` = 3,
  `TRUST_HOME_DESTINATION_RADIUS_KM` = 50 (anchoring and presence exemption, §3).
- Never in wiki, patch notes, player-facing text, or support replies. The repo (`.env.example`, this doc) must stay private.

### 2.3 A fix counts toward Settled only if ALL hold
1. Account has a home anchor; fix within `TRUST_SETTLE_RADIUS_KM`; accuracy ≤ `TRUST_SETTLE_ACCURACY_M` (5000; reduced accuracy accepted).
2. Verdict `accepted` (speed-plausible); not mock/simulated; no tamper; no **hard** mismatch on this fix (§5); not on a VPN/hosting ASN.
3. Platform is native. Assurance requirement is gated by `TRUST_SETTLE_ASSURANCE_MODE`: `shadow` ⇒ `native_legacy`, `unverified`,
   `device_checked`, `attested` count; `enforce` ⇒ only `attested` / `device_checked`. **Web never counts.** Until enforce, "native" is
   the WS query claim (finding 3); this is accepted and dated in §9.
4. ≥ `TRUST_SETTLE_MIN_GAP_SECONDS` since `last_counted_at` (atomic `UPDATE … WHERE last_counted_at IS NULL OR last_counted_at <= $now - gap`
   inside the report transaction, `trustStore.ts:288-396`).

Settled when `counted_checks ≥ target_checks` AND `counted_days ≥ target_days` AND `distinct_positions ≥ TRUST_SETTLE_MIN_DISTINCT_POSITIONS`
AND account age ≥ `TRUST_DOORWAY_MIN_ACCOUNT_AGE_DAYS` (14). On grant: `settled_at = now`, `settled_home_* = home_*`, `provisional_until = NULL`.

### 2.4 Losing progress / Settled
- **Revocation for cause**: `location_mock`, `relocation_mock`, `attest_tamper`, `attest_app_fail`, hard mismatch (§5), admin
  unsettle ⇒ progress 0, `settled_at = NULL`, `settled_home_* = NULL`, `unsettle_reason`, signal `settled_revoked` (+1), pending invites
  invalidated via `TravelInviteService.invalidateForInviter` ("Travel invitation is unavailable."). Anchoring is compute-on-read, so the
  host's destinations close for others at once.
- **Moved away**: relocation farther than `TRUST_SETTLE_RADIUS_KM` from `settled_home` ⇒ `settled_at = NULL`, reason `moved_away`,
  progress 0, new targets; `settled_home_*` kept.
- **Returned home**: relocation within `TRUST_SETTLE_RADIUS_KM` of `settled_home` while reason is `moved_away` ⇒ `settled_at = now`,
  reason cleared (no re-earning). Relocation within the radius of the current anchor while Settled ⇒ nothing changes.
- Admin settle/unsettle from the Trust screen (audited `note` event).

### 2.5 Grandfathering (migration backfill, finding 5)
For every non-deleted account at migration time:
- Age ≥ 14 d AND `account_location_state.confirmed_days ≥ 3` AND no `speed_impossible` / `location_mock` / `relocation_mock` signal in
  `account_trust_events` ⇒ `settled_at = now()`, `settled_home_* = home_*` (0884 home, else last accepted relocation fix, else NULL ⇒
  not Settled).
- Age ≥ 14 d, `home_confirmed_at` set by the 0884 blanket backfill (confirmed_days < 3) ⇒ `settled_at = now()`,
  `provisional_until = now() + TRUST_SETTLE_PROVISIONAL_DAYS` (30), targets rolled then **halved** (ceil). A scheduler job (hourly) revokes
  expired provisional rows that did not reach their targets with reason `grandfather_expired` (not "for cause": `settled_home` kept, no signal).
- Everyone else: unsettled with fresh targets. Seeding may use SQL `random()`; runtime uses `crypto.randomInt`.

### 2.6 What Settled gates (`TRUST_SETTLED_GATE_MODE`, default `enforce`: it replaces the already-enforced doorway rule)
- Send Travel Invite, lead Party Travel (manual and auto-follow): requires Settled (replaces the `TRUST_DOORWAY_CONFIRMED_DAYS` check at
  `altDoorway.ts:186-188`) **plus presence proof** (§2.7).
- Owning an **anchored destination** (§3.3) and **hostile actions** (§3.4), each behind its own mode.
- Player-facing copy, no numbers (replace `altDoorway.ts:197-203`; search the client for `confirmedDays` / `TRAVEL_DOORWAY_UNCONFIRMED`):
  "Travel Invites unlock as you play Ash Atlas from your home area." / "Party Travel to this leader unlocks as they play from their home area."
  Web: "Open the Ash Atlas app on your phone to send Travel Invites."

### 2.7 Presence proof (replaces draft "stays")
Host's last fix is ≤ `TRUST_PRESENCE_MAX_FIX_AGE_SECONDS` (600) old, within `TRUST_PRESENCE_RADIUS_KM` (25) of the host's avatar, and its
`last_fix_assurance` is native (per `TRUST_SETTLE_ASSURANCE_MODE`, same table as §2.3 item 3). Exempt **only** when the destination is
anchored for the host (§3.3) and within `TRUST_HOME_DESTINATION_RADIUS_KM` of the host's `settled_home`. `DoorwayPlayerRecord` gains
`settledAt`, `settledHome`, `lastFixAssurance`; `destinationBelongsTo` becomes `destinationAnchoredForHost`.

### 2.8 Action checks for unsettled accounts (O5)
- Session gains `trustActionFixes?: boolean` (true only while unsettled, native platform, and `TRUST_PASSIVE_FIX_ENABLED`); refreshed on
  session fetch and pushed when Settled changes.
- Client `locationFixScheduler.ts`: `requestActionFix(reason)` — fire-and-forget, never awaited, never prompts, deduped ≤ 1 / 60 s,
  foreground only, native only. Reasons (extend `LOCATION_FIX_REASONS`, `packages/shared/src/protocol/relocationSchemas.ts:39`):
  `action_flag_place`, `action_flag_attack`, `action_city_found`. Call sites: the senders of `PLACE_FLAG`, `START_FLAG_BURN`,
  `ATTACK_FLAG`, `FOUND_CITY`. Never PvP/combat. Relocation reads location itself (blocking, unchanged).
- Server: same handler and evaluation as passive; the per-connection window (`travelHandler.ts:337-348`) becomes **per account**
  (in-process map keyed by account) with a burst of 2 per window when one is an action reason. They count toward Settled subject to the
  gap; their real value is mock/mismatch evidence at action time, stored in `features.fixReason`.

## 3. Doorways

### 3.1 Travel Invites and Party Travel (existing gates, retargeted)
Order of checks for a send/travel (`altDoorway.check`): party relocation shortcut → Settled (§2.6) → presence (§2.7) → linked alts →
young-inviter rules. Invites are checked at send time only (`partyHandler.ts:888-907`, `travelInvites.ts:132`), replays unchanged.
Young inviter (account < `TRUST_YOUNG_INVITER_DAYS` = 30): arrivals get `TRUST_YOUNG_INVITER_ARRIVAL_HOLD_MINUTES` (1440) instead of 60;
shared-network pairs are refused (`TRAVEL_LINKED_ACCOUNT`) **only when the shared prefix's ASN is not mobile** (A6 classes; unknown ASN
= not mobile), else signal only. Dev profiles stay exempt while developer login is enabled.

### 3.2 Arrivals
`noteArrival` (`travelRealtimeOperations.ts:1980-1983`) gains `hostPlayerId`, `kind`, destination centre, and writes `trust_arrivals`
(§7). Arrival raid hold unchanged (`landActionGuard.ts:60-85`).

### 3.3 Anchored destinations (`TRUST_ANCHOR_MODE` off|shadow|enforce, default `shadow`)
Definition: a destination D (personal flag, city flag / city hall, kingdom seat, manor) created by account H is **anchored** iff H is
Settled (not provisional-expired) AND `distance(D, H.settled_home) ≤ TRUST_HOME_DESTINATION_RADIUS_KM`. Computed on read from
`account_settlement` (join on the owner's account; ≤ 30 s in-process cache allowed). No column, so revocation is immediate.

Enforcement points (traveller ≠ owner; the owner always reaches their own destinations):
- `FlagAccessService.authorizeWith` (`flagAccess.ts:726-803`): personal `public`/`normal` and `city`/`city_seat` flags ⇒ denied
  `DESTINATION_UNANCHORED` ("This destination isn't open to travellers yet.") unless anchored. Skip when
  `companionHostPlayerId === ownerPlayerId` (the invite/party doorway already ran).
- World Map travel (`travelHandler.ts:1025` → `WorldMapService`): `city` and `kingdom` destinations are listed but refused with the same
  code unless anchored. City anchor = founder's account (find the founder/mayor column on `cities`; fall back to the city
  hall flag's owner). Kingdom seat anchor = the seat's founding account (verify `kingdom_seats`).
- Presence exemption (§2.7) and party auto-follow destination (`travelRealtimeOperations.ts:2633-2638`).
**Owner decision 2026-10-02:** an unsettled account's flags and every structure it builds are **private**; it cannot switch any of them
to `public`/`normal` (or convert to a city flag open to others) until Settled. Enforce at the access-mode change handlers and at
creation defaults (`TRUST_ANCHOR_MODE`); on revocation, the account's public/normal flags revert to private.
**Superseded for personal flags by owner decision 2026-10-15:** other players must be able to jump to new (unsettled) players'
flags; the anti-spoof concern is invites/referrals, not flag access. Personal flags take the owner's chosen mode
(public/normal/private) whether or not the owner is Settled, are never anchored by the travel check, and are not reverted on
revocation. Harvest access, city founding/conversion, and city/kingdom flag and seat anchoring are unchanged.
Shadow: signal `travel_unanchored_destination` (weight 0, dedupe traveller+destination+day) and an admin report "routes that would be
refused" for the enforce decision. Honest cost: a new player's home is reachable by others only after they Settle (≥ 14 d); a flag placed
> 50 km from home is never a destination for others. Flags are still placed instantly; nothing waits.

### 3.4 Hostile-action gate (`TRUST_HOSTILE_GATE_MODE` off|shadow|enforce, default `shadow`; replaces O6's yellow attack rule)
**Owner decision 2026-10-02: unsettled accounts are fully PvP- and war-blocked** — no hitting players, no flag burn/attack, no access to
sieges, bombers or any hostile military unit/order. This is a status gate, not a location check. **Owner decision 2026-10-02: the
shield is two-way** — unsettled players cannot hit anyone, and no one can hit unsettled players. Their only PvP will be future
designated safe PvP arenas (no EXP, no loot drop; not built yet): keep the gate a single check that an arena zone could exempt later,
but do not build arenas. PvP entry points: find the player-attack
handler(s) and refuses with `HOSTILE_UNSETTLED`. If the actor's account is unsettled: refuse `START_FLAG_BURN` / `ATTACK_FLAG` on flags they do not own (extend `arrivalRaidAllowed`,
`landActionGuard.ts:60-85`, to a `raidAllowed` that checks arrival hold **or** unsettled; same call sites `flagHandler.ts:203,253`) and
hostile military orders (deploy against a target flag / fire: find the order entry points around
`militaryIndustry.ts:2218-2296` and the `settlementHandler.ts` cases that call them; defensive `attackMilitarySiege` at `:1103` stays
allowed). Code `HOSTILE_UNSETTLED`, message "You can't attack other players' flags until you've settled in. Keep playing from your home
area." Signal `hostile_unsettled` 0.25 (per account per day). PvP and combat untouched. Fail open on DB errors like the existing gates.
**[owner]** scope: all others' flags (recommended) or only owners with territory within 10 km of the actor's home anchor.

### 3.5 Mass-arrival alert
In `noteArrival`: if ≥ `TRUST_MASS_ARRIVAL_COUNT` (3) distinct accounts arrived from the same host within 60 min and the destination is
≥ 100 km from each arrival's home anchor (or the anchor is NULL) ⇒ `trust_alerts` kind `mass_arrival`, severity 3, details {host,
arrivals, destination rounded, zone class}. One per host per 6 h. Sieges take days, so a same-day admin review is enough.

### 3.6 Inviter accountability (O11, corrected)
`trust_arrivals` keeps who brought whom (host, guest, kind, rounded destination, 90 d). Trust screen account detail lists "brought in"
and "brought by"; action **Quarantine arrivals since T** suspends every guest of the host (existing suspension path, audited, with a
dry-run count). `trust:reverse` remains for signals only. Burned flags / siege damage are not restored by tooling.

## 4. Alert zones

### 4.1 Population grid
- Source: **GHSL GHS-POP R2023A**, 30 arc-second, epoch 2025 (JRC, CC BY 4.0; attribution in `THIRD_PARTY_DATA.md`
  and `THIRD_PARTY_DATA.md`).
- Build tool `tools/trust/build-population-grid.mjs` (manual, not CI): 0.05° grid (7200 × 3600), one byte per cell = class of the cell
  plus 8 neighbours (≈ 15 × 15 km window): `0` red (< 1 person; nodata counts as 0), `1` orange (< `ORANGE_MAX_PEOPLE`, 200), `2` rural
  (< `URBAN_MIN_PEOPLE`, 20 000), `3` urban. Output `apps/server/data/population-grid-v1.bin.gz` + JSON header (version, source, epoch,
  thresholds, sha256). Commit it (a few MB).
- Server `apps/server/src/auth/trust/populationGrid.ts`: lazy load, `classify(lat, lon) → "red"|"orange"|"rural"|"urban"`. Missing file
  ⇒ `"urban"` + startup warning (never blocks).

### 4.2 Yellow
`yellowOwners(lat, lon)` = other accounts owning flags/territory within `TRUST_KINGDOM_ALERT_RADIUS_KM` (10), bounding-box prefilter on
the flag table (index only if none exists). Yellow applies **only when the cell class is red/orange/rural**. It is an alert + difficulty
1.5; it no longer carries an attack restriction (§3.4). No `yellow_owner_ids` column; owners are listed in `trust_alerts.details`.

### 4.3 On relocation (in `travelHandler.ts` before `performAuthoritativeTravel`, `:780`)
| Zone | Shadow | Enforce |
|---|---|---|
| red | alert + signal `relocation_red_zone` (+3), relocation proceeds | not applied; cooldown and free re-pick not consumed. **Brand-new account** (age < `TRUST_RED_ZONE_LOCK_MAX_AGE_DAYS`, 7, and never Settled, i.e. no `settled_at`): account **locked** at once through the admin Lock suspension path (status `suspended`, `suspended_at`, `suspension_reason = 'trust_red_zone_new_account'`, sessions revoked, live connections closed after the refusal is sent); alert `zone_red` severity 4 status `locked`, `details.autoLocked = true`, `details.accountAgeHours`; signal `relocation_red_zone` (+3); ledger note `auto_red_zone_lock`. **Any other account**: refused with "You can't relocate here."; alert `pending`; §4.5 limits |
| orange | alert + `difficulty = max(difficulty, 2.0)` | same |
| yellow (non-urban only) | alert + `difficulty = max(difficulty, 1.5)` | same |

Defaults: `TRUST_ALERT_ZONE_MODE=enforce`, `TRUST_RED_ZONE_LOCK_MAX_AGE_DAYS=7` (owner decision 2026-10-02; `0` = never lock, refuse
only); difficulty always applies. A remaining admin allowance for the cell is checked first and lets the relocation through for any
account. Admin **Approve** inserts a one-shot allowance (account + 0.05° cell, 7 d); **Lock** = existing suspension; **Unlock** (on a
`locked` alert) lifts a trust-lock suspension (`trust_alert_locked` / `trust_red_zone_new_account`; other suspensions stay), the alert
moves to `dismissed` with `details.unlockedAt/unlockedBy`, sessions stay revoked so the player signs in again; **Reverse** =
`trust:reverse`.

### 4.4 Alert inbox
`trust_alerts` (§7). Trust screen (`apps/client/src/ui/TrustAdminScreen.tsx`, routes `apps/server/src/http/developerTrustRoutes.ts`,
capability `developer:test-access-manage`) gains **Alerts**: severity (4 new-account red / mass arrival > red > mismatch > orange >
yellow), account, when, kind, lat/lon rounded to 0.01°, status, actions Approve / Lock / Dismiss / Unlock (locked alerts) / Quarantine
arrivals. No push.

### 4.5 Alert rate limits (finding 6)
- Red (accounts that are not brand-new, §4.3): at most one `pending` red alert per account; further red attempts while pending, or
  after 3 red attempts in 30 d, are refused with the same copy ("You can't relocate here."), no new alert, signal
  `relocation_red_repeat` (+1/day). A brand-new account's red attempt always locks (its `locked` alert is outside these limits).
- Orange/yellow: one alert per account per 7 d per cell; others only update `details.count`.
- Account age < 24 h and red ⇒ severity 4 (pending alerts: shadow mode, or a Settled young account in enforce); auto-lock alerts are
  always severity 4.

## 5. Mismatch signals (server; on every fix that has the data)

| Signal | Rule | Weight | Hard? |
|---|---|---|---|
| `ip_hosting_or_vpn` | ASN classified hosting/VPN/proxy | +1 (per day) | no; **fix does not count toward Settled**; distance rule skipped |
| `ip_location_mismatch` | not VPN. Fixed-line ASN: IP point vs GPS > 500 km. Mobile/unknown ASN: IP country ≠ GPS country | +2 | yes, fixed-line only, 3 fixes in 24 h |
| `ip_satellite` | Starlink/other satellite ASN | 0 (feature) | no |
| `carrier_country_mismatch` | Android `getNetworkCountryIso()` ≠ GPS country (empty ⇒ skip) | +2 | yes, 3 fixes in 24 h |
| `timezone_mismatch` | device zone offset now ≠ GPS zone offset (± 1 h) | +1 | no |
| `gps_static` | ≥ 10 consecutive native fixes with identical lat/lon (6 dp) and accuracy | +0.5 (per day) | **no** (finding 7) |

"Hard" = revocation for cause (§2.4). Data: **DB-IP Lite City + ASN** MMDB (CC BY 4.0, monthly) read with the `maxmind` package
(`apps/server/src/auth/trust/ipGeo.ts`; ops script `tools/trust/update-ipgeo.mjs`, documented in `docs/ops/`); missing DB ⇒ skipped.
GPS → zone via `geo-tz`; zone → countries via `zone1970.tab` (a zone may list several countries; any match passes). Client IP from the
existing trusted-proxy resolution; store only ASN, class, country and a 0.1°-rounded IP point in `features`, never the raw IP. ASN classes
(mobile / fixed / hosting-vpn / satellite) in `asnClasses.ts`, data-driven, with tests.

## 6. Relocation rules (O3, O4)
- `GPS_RELOCATION_COOLDOWN_MS` (`packages/shared/src/travel.ts:5`) → 7 days **and** the SQL guard `interval '24 hours'`
  (`apps/server/src/game/players.ts:749`) → parameterised from the same constant. Copy: `travelHandler.ts:700`,
  `travelRealtimeOperations.ts:1350`, `apps/client/src/App.tsx:4318` ("You can relocate again after the 7-day cooldown."; do not touch
  `FlagMorePrompt.tsx:196`, a different 24 h).
- Return home **[owner]**: a relocation within `TRUST_SETTLE_RADIUS_KM` of `settled_home` is exempt from the cooldown and does not start a
  new one.
- Free re-pick: account < 24 h old, exactly one applied relocation < 60 min ago, `free_repick_used_at` NULL.
- Phone-only: `TRUST_RELOCATION_NATIVE_ONLY_MODE` (`off|shadow|enforce`, default `shadow`): enforce refuses web with "Relocating uses your
  phone's location. Open the Ash Atlas app on your phone to move your home." Flip with assurance enforce (§9).
- Unchanged: invite cooldown after relocation (1 h), party relocation shortcut closed.

## 7. Migrations
Next free numbers: `0911`, `0912` (highest at writing `0910_creature_book_archetype_validation.sql`; re-check `origin/integration/test`;
duplicates exist, runner sorts with `localeCompare`).

`0915_device_attestation.sql`: tables `attestation_challenges` (id, account, session, installation, platform, purpose, 32-byte challenge,
expires/consumed), `app_attest_keys` (key_id PK, installation, first account, environment, SPKI, receipt, sign_count, last_used, revoked),
`device_attestations` (account, session, installation, platform, method, purpose, challenge, key, outcome pass|fail|unavailable,
assurance, reason, summarized verdict jsonb ≤ 8 KB, bound_fix jsonb, unique token_hash, unique ref_hash, shell_build, expires_at), plus
`location_reports.attestation_id/assurance` and `account_location_state.last_fix_assurance` (`assurance` CHECK IN ('attested',
'device_checked','unverified','native_legacy','web','flagged')).

`0916_settled_and_alert_zones.sql`:
```sql
BEGIN;
CREATE TABLE IF NOT EXISTS account_settlement (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  home_lat double precision NULL CHECK (home_lat IS NULL OR home_lat BETWEEN -90 AND 90),
  home_lon double precision NULL CHECK (home_lon IS NULL OR home_lon BETWEEN -180 AND 180),
  home_set_at timestamptz NULL,
  settled_home_lat double precision NULL CHECK (settled_home_lat IS NULL OR settled_home_lat BETWEEN -90 AND 90),
  settled_home_lon double precision NULL CHECK (settled_home_lon IS NULL OR settled_home_lon BETWEEN -180 AND 180),
  settled_home_at timestamptz NULL,
  target_checks integer NOT NULL CHECK (target_checks BETWEEN 1 AND 500),
  target_days integer NOT NULL CHECK (target_days BETWEEN 1 AND 60),
  difficulty numeric(3,2) NOT NULL DEFAULT 1.00 CHECK (difficulty BETWEEN 1 AND 5),
  counted_checks integer NOT NULL DEFAULT 0 CHECK (counted_checks >= 0),
  counted_days integer NOT NULL DEFAULT 0 CHECK (counted_days >= 0),
  last_counted_day date NULL,
  last_counted_at timestamptz NULL,
  distinct_positions integer NOT NULL DEFAULT 0 CHECK (distinct_positions BETWEEN 0 AND 10),
  last_position_key text NULL CHECK (last_position_key IS NULL OR char_length(last_position_key) <= 32),
  settled_at timestamptz NULL,
  provisional_until timestamptz NULL,
  unsettled_at timestamptz NULL,
  unsettle_reason text NULL CHECK (unsettle_reason IS NULL OR unsettle_reason IN
    ('location_mock','relocation_mock','attest_tamper','attest_app_fail','hard_mismatch','admin','moved_away','grandfather_expired')),
  free_repick_used_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((settled_home_lat IS NULL) = (settled_home_lon IS NULL))
);
CREATE INDEX IF NOT EXISTS account_settlement_provisional_idx ON account_settlement (provisional_until) WHERE provisional_until IS NOT NULL;
CREATE TABLE IF NOT EXISTS trust_alerts (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('zone_red','zone_orange','zone_yellow','mismatch','settled_revoked','mass_arrival')),
  severity smallint NOT NULL CHECK (severity BETWEEN 1 AND 4),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','locked','dismissed')),
  cell_key text NULL CHECK (cell_key IS NULL OR char_length(cell_key) <= 32),
  lat_rounded double precision NULL,
  lon_rounded double precision NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object' AND pg_column_size(details) <= 4096),
  allowance_expires_at timestamptz NULL,
  decided_by uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  decided_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trust_alerts_pending_idx ON trust_alerts (severity DESC, created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS trust_alerts_account_idx ON trust_alerts (account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS trust_alerts_one_pending_red_idx ON trust_alerts (account_id) WHERE kind = 'zone_red' AND status = 'pending';
CREATE TABLE IF NOT EXISTS trust_arrivals (
  id uuid PRIMARY KEY,
  host_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  guest_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('invite','party_manual','party_auto_follow')),
  lat_rounded double precision NULL,
  lon_rounded double precision NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trust_arrivals_host_idx ON trust_arrivals (host_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trust_arrivals_guest_idx ON trust_arrivals (guest_account_id, created_at DESC);
-- Grandfather + seed (§2.5). The migration author writes the INSERT ... SELECT against accounts, account_location_state,
-- account_trust_events and the last accepted relocation in location_reports.
COMMIT;
```
Deletion: accounts are soft-deleted (`accountDeletionService.ts:416`), so CASCADE never fires; A9 deletes these rows explicitly.

## 8. Native build (attestation + mock detection)

### 8.1 Decisions
- Capacitor plugin **`DeviceTrust`** (Android `android/app/src/main/java/com/ashatlas/game/DeviceTrustPlugin.java`, registered in
  `MainActivity.java` before `super.onCreate`; iOS `ios/App/App/DeviceTrustPlugin.swift`, registered in `SceneDelegate.swift` next to
  NativeRuntime, pbxproj entries). Client feature-detects with `Capacitor.isPluginAvailable("DeviceTrust")` + `getCapabilities()`; any
  rejection incl. `UNIMPLEMENTED` ⇒ legacy shell.
- Attestation over HTTP (`/api/trust/attest/*`); the socket carries only `attestationRef` and a `native` signal block.
- Attest on WS-online, every `TRUST_ATTEST_VERDICT_TTL_SECONDS` (1800) while foreground, and per relocation (fix-bound). Never on land
  actions or invites, never in background, never prompts.
- Android pass = `PLAY_RECOGNIZED` + `MEETS_DEVICE_INTEGRITY` + package + cert digest allowlist + `requestHash` + `timestampMillis` ≤ 300 s.
  Basic-only = fail. `UNEVALUATED`/outage = `unavailable` = neutral. `MEETS_STRONG_INTEGRITY` stored as a feature; config
  `TRUST_SETTLE_REQUIRE_STRONG_INTEGRITY` (false) reserved for later.
- iOS: App Attest primary; DeviceCheck only when App Attest is unsupported. Simulator ⇒ `unverified`.
- Assurance per fix: `attested | device_checked | unverified | native_legacy | web | flagged`.
- Android mock: `Location.isMock()` (API 31+) / `isFromMockProvider()`; dev-options logged only; **no `QUERY_ALL_PACKAGES`**. iOS:
  `sourceInformation.isSimulatedBySoftware` (strong), `isProducedByAccessory` (feature only). Android also returns `networkCountryIso`.
- Legacy shells: OTA JS sends `native: {v:1, shellBuild, plugin:false}` ⇒ `native_legacy`.
- Store summarized verdicts only; `sha256(token)` for replay; never raw tokens.
- Play Integrity uses the **Standard API**: call `prepareIntegrityToken(cloudProjectNumber)` at app start (warm-up), then
  `request(requestHash)`. Default quota is 10 000 decodes/day: request a raise before launch. Link to the existing Firebase/Cloud project.
  Server deps: `cbor-x`, `maxmind`; X.509 via `node:crypto`. Android deps: `com.google.android.play:integrity` (pin current 1.x),
  `play-services-location:21.3.0`. Do not edit `ios/App/CapApp-SPM/Package.swift`.

### 8.2 Canonical client data (`packages/shared/src/deviceTrust.ts`)
`"ashatlas-attest-v1\n" + purpose + "\n" + challenge` and, for fix-bound relocation, `"\n" + lat.toFixed(6) + "\n" + lon.toFixed(6) +
"\n" + (accuracy?.toFixed(1) ?? "") + "\n" + fixTimestampMs`. Native code SHA-256s it (Android: base64url without padding ⇒ `requestHash`;
iOS: raw 32 bytes ⇒ `clientDataHash`). JS never hashes. The WS relocation message carries raw numbers plus `native.fixTimestampMs`; the
server **re-formats with the same `toFixed` rules** before comparing to `bound_fix` (string compare, never float compare).

### 8.3 HTTP endpoints (`apps/server/src/http/deviceTrustRoutes.ts`; session + origin + CSRF via `installAuthGuard`; per-session rate limit; 404 when off)
- `POST /api/trust/attest/challenge {platform, purpose: session|relocation|ios_key}` → `{challengeId, challenge (b64url 32 B), expiresAt}` (TTL 300 s; 20/session/hour).
- `POST /api/trust/attest/android {challengeId, purpose, shellBuild, token?, clientError?, fix?}`
- `POST /api/trust/attest/ios/key {challengeId, keyId, attestationObject}` (409 `ATTEST_KEY_EXISTS`)
- `POST /api/trust/attest/ios/assert {challengeId, purpose, keyId, assertion, shellBuild, fix?}` (409 `ATTEST_KEY_UNKNOWN` ⇒ client regenerates ≤ 1/24 h)
- `POST /api/trust/attest/ios/devicecheck {challengeId, purpose, deviceToken, shellBuild}`

All return `{attestationRef, expiresAt, refreshAfterSeconds}`, identical body for pass and fail.

### 8.4 Wire + session
- `relocationSchemas.ts`: add `native: z.unknown().optional()`, `attestationRef: z.unknown().optional()` to both strict schemas (server ships
  first). Lenient `nativeLocationSignalsSchema` (`v`, `shellBuild`, `plugin`, `provider`, `mock`, `simulated`, `accessory`, `devOptions`,
  `reducedAccuracy`, `networkCountryIso`, `fixTimestampMs`, `fixAgeMs`; `.strip()`; > 1 KB ⇒ ignored + `native_malformed`).
- Session (`packages/shared/src/auth.ts:57-61` block): `trustNativeSignalsAccepted?`, `trustActionFixes?`, `trustAttestation?: {mode,
  android?: {cloudProjectNumber}, ios?: {appAttest, deviceCheck}, refreshSeconds}`. Client sends new fields only when
  `trustNativeSignalsAccepted === true`.

### 8.5 Verification
- Play Integrity: `POST https://playintegrity.googleapis.com/v1/{package}:decodeIntegrityToken` via `GoogleAuth` (scope
  `…/auth/playintegrity`), timeout 4 s; atomic single-use challenge bound to session/account/platform/purpose; unique `token_hash`.
  `appIntegrity.certificateSha256Digest` entries are **base64url (no padding)**: convert the hex/colon config values once at startup.
- App Attest attestation: CBOR; `x5c` chain to the committed Apple App Attestation Root CA; leaf extension `1.2.840.113635.100.8.2`
  (SEQUENCE { [1] OCTET STRING nonce }) = SHA256(authData ‖ clientDataHash); keyId = SHA256(uncompressed public key); rpIdHash =
  SHA256(`ABCDE12345.com.ashatlas.game`); signCount 0; aaguid `appattest` + 7 × 0x00 (`appattestdevelop` only when allowed, never in
  production); credentialId = keyId.
- Assertion: ECDSA over SHA256(authenticatorData ‖ SHA256(clientData)); rpIdHash; atomic `sign_count` increase (regression ⇒
  `attest_tamper`). Confirm with a real-device fixture.
- DeviceCheck: `validate_device_token` with ES256 JWT. 200 ⇒ `device_checked`, 400 ⇒ fail, else unavailable.
- `AttestationResolver` resolves `attestationRef` (same account+session+installation, unexpired; LRU 10 min); relocation `bound_fix`
  mismatch ⇒ `attest_tamper` + `flagged`.

### 8.6 Signals (`trustScore.ts`, via `TrustSignalSink`, dedupe keys)
`location_mock` +3 (per hour), `relocation_mock` +4, `attest_device_fail` +2 (per day), `attest_app_fail` +3 (per day), `attest_tamper` +4,
`attest_risky_env` +1 (per day), `attest_pass` −0.5 (per day), §5 signals, `relocation_red_zone` +3, `relocation_red_repeat` +1 (per day),
`settled_revoked` +1, `hostile_unsettled` 0.25 (per day), `travel_unanchored_destination` 0. Gate each family by its own mode, not by
`TRUST_LOCATION_REJECT_MODE` (today `trustService.ts:393` gates all signals on it: split per family).

### 8.7 Config (`TRUST_*` block of `apps/server/src/config.ts:500-527` + `.env.example`; production refinements near `:1088`)
`TRUST_ATTESTATION_MODE` (shadow), `TRUST_MOCK_LOCATION_MODE` (shadow), `TRUST_SETTLE_ASSURANCE_MODE` (shadow),
`TRUST_PLAY_INTEGRITY_ENABLED` (false), `_PACKAGE_NAME`, `_CLOUD_PROJECT_NUMBER`, `_CERT_SHA256` (CSV hex, colons accepted),
`_CREDENTIALS_JSON_BASE64` (empty ⇒ ADC), `TRUST_APP_ATTEST_ENABLED` (false), `_APP_ID`, `_ALLOW_DEVELOPMENT` (refused in production),
`TRUST_DEVICECHECK_ENABLED/_KEY_ID/_PRIVATE_KEY_P8_BASE64/_ENVIRONMENT`, `TRUST_ATTEST_VERDICT_TTL_SECONDS` (1800),
`_CHALLENGE_TTL_SECONDS` (300), `_VERIFY_TIMEOUT_MS` (4000), `TRUST_ATTEST_RETENTION_DAYS` (90), `TRUST_SETTLE_*` (§2.2),
`TRUST_SETTLE_PROVISIONAL_DAYS` (30), `TRUST_SETTLED_GATE_MODE` (enforce), `TRUST_ANCHOR_MODE` (shadow), `TRUST_HOSTILE_GATE_MODE`
(shadow), `TRUST_HOME_DESTINATION_RADIUS_KM` (50), `TRUST_ALERT_ZONE_MODE` (enforce), `TRUST_RED_ZONE_LOCK_MAX_AGE_DAYS` (7),
`TRUST_KINGDOM_ALERT_RADIUS_KM` (10),
`TRUST_RELOCATION_NATIVE_ONLY_MODE` (shadow), `TRUST_YOUNG_INVITER_DAYS` (30), `TRUST_YOUNG_INVITER_ARRIVAL_HOLD_MINUTES` (1440),
`TRUST_MASS_ARRIVAL_COUNT` (3).
`TRUST_REVIEW_ACCOUNT_IDS` (empty; comma list of account ids): store-review accounts (Apple App Review, Play pre-launch) count as
Settled, are never red-zone locked or refused, and their signals are recorded at weight 0 and never revoke Settled.

**Owner decisions 2026-10-04 (weights are config defaults in `apps/server/src/config.ts`; env overrides single rules; all secret):**
- `TRUST_ENVIRONMENT_SIGNAL_WEIGHTS` defaults (`DEFAULT_TRUST_ENVIRONMENT_SIGNAL_WEIGHTS`, applied while
  `TRUST_ENVIRONMENT_SIGNALS_MODE=enforce`): `env_emulator` 2, `pi_virtual_integrity` 2 (Play Integrity
  MEETS_VIRTUAL_INTEGRITY without MEETS_DEVICE_INTEGRITY = Google's emulator), `env_root` 2, `env_debugger` 0.5,
  `env_sideload` 0.5, `env_vpn_active` 1, `env_sim_country_mismatch` / `env_network_country_mismatch` /
  `env_cell_country_mismatch` 1.5, `env_timezone_country_mismatch` 1, `gnss_zero_satellites` 2, `install_multi_account` 3,
  `devicecheck_spoof_bit` 3, `pi_high_device_activity` 1, `pi_risky_app_access` 1.
- `TRUST_RISK_SIGNAL_WEIGHTS` defaults (`DEFAULT_TRUST_RISK_SIGNAL_WEIGHTS`, weighted whenever their gate is not off):
  `kingdom_proximity` 3, `territory_proximity` 1, `account_shared` 3, `state_hopping` 4.
- `TRUST_KINGDOM_PROXIMITY_RED_KM` (3): relocating this close to another account's kingdom seat/territory = severity-4
  `kingdom_proximity` alert + signal (no lock, no refusal). Yellow (`TRUST_KINGDOM_ALERT_RADIUS_KM`) now alerts in urban
  cells too (`territory_proximity`); extra difficulty stays non-urban.
- Multi-accounting: `TRUST_INSTALL_ALT_ACCOUNT_THRESHOLD` (2) accounts on one native install id (iOS keychain id survives
  reinstalls) or one login device ⇒ `install_multi_account` + `multi_account` alert. Account sharing: one account on
  `TRUST_ACCOUNT_SHARED_DEVICES` (2) native installs, or a fix from another device faster than `TRUST_ACCOUNT_SHARED_MAX_KMH`
  (900) within `TRUST_ACCOUNT_SHARED_WINDOW_MINUTES` (120) ⇒ `account_shared` + alert. The admin account detail lists
  linked accounts (both directions). Play Integrity has no stable device id; a DeviceCheck bit0 device is
  `devicecheck_spoof_bit`.
- State hopping: `TRUST_STATE_HOP_REGION_KM` (300), `_MAX_KMH` (900), `_MIN_HOPS` (2), `_WINDOW_DAYS` (7) over the
  stored history (passive fixes at session start and every 3-7 min in the foreground, plus relocations) ⇒ `state_hopping`
  + alert; an impossible jump between two passive fixes alerts too (already `speed_impossible` +4).
- `TRUST_MISMATCH_REVOKE_WEIGHT` (5): in mismatch enforce, mismatch-family weight in 24 h at or above this revokes Settled
  (`hard_mismatch`, kind `accumulated`) without a hard mismatch.
- Red zone ordering: a rejected relocation fix still runs the red zone (alert, signal, brand-new-account lock).
- Review hold: a Settled (incl. provisional) account's red attempt in enforce is refused with "This location needs
  review. Your Settled status is paused until it's checked.", a severity-4 red alert, and Settled paused
  (`unsettle_reason = review_hold`, migration 0996) until Approve restores it; doorways close meanwhile.

### 8.8 Native tooling + store
- iOS entitlement `ios/App/App/App.entitlements` with `com.apple.developer.devicecheck.appattest-environment` = `$(APP_ATTEST_ENVIRONMENT)`
  (Debug development / Release production) via `CODE_SIGN_ENTITLEMENTS`; merge `aps-environment` when push is enabled. Prove the
  entitlement survives the unsigned-archive + export re-sign (`codesign -d --entitlements :- Payload/App.app`).
- `tools/mobile-release/verify-artifact.mjs`: entitlement = production; AAB permissions exactly INTERNET, COARSE, FINE.
- Info.plist purpose string: "Ash Atlas uses your location while the app is open: to place your character when you choose Relocate, and
  from time to time during play to confirm your real location and protect other players from location spoofing."
- Store builds are paused (`config/release-mode.json`); owner un-pauses for the store step.
- Privacy docs: The store privacy disclosures (not published) still say location is sent only on Relocate; add
  periodic foreground checks, attestation (Google/Apple as processors), IP-derived ASN/country (local DB-IP data, no processor), GHSL and
  DB-IP attribution, retention (`trust_arrivals` 90 d, alerts 180 d), and deletion behaviour (A9).

### 8.9 Device environment + integrity signals (all shadow by default)
- Plugin: `getCapabilities().environment` + `getEnvironment()` (contract in `apps/client/src/native/nativeDeviceTrust.ts`);
  `getCurrentFix()` adds Android `gnssSatellitesUsed`, `gnssSatellitesVisible`, `gnssAvgCn0` (ride in the `native` fix block).
- Wire: `environment` (bounded by `deviceEnvironmentSchema` in `packages/shared/src/deviceTrust.ts`; only `v` and `installId`
  required; any out-of-bounds field drops the block) on every `/api/trust/attest/*` body; iOS adds `deviceCheckToken` to
  `ios/key` and `ios/assert` when DeviceCheck is enabled. Never per fix.
- Server: `apps/server/src/auth/trust/attestation/deviceEnvironment.ts`; table `device_environment_reports` (migration 0995:
  sha256(installId), flags, derived countries only, Play Integrity excerpt, DeviceCheck bit0), retention
  `TRUST_ATTEST_RETENTION_DAYS`, deleted with the account.
- Signals (`TRUST_ENVIRONMENT_SIGNALS_MODE` off|shadow|enforce, default shadow = weight 0; enforce uses
  `TRUST_ENVIRONMENT_SIGNAL_WEIGHTS` "rule=weight,...", default all 0): `env_emulator`, `env_root`, `env_debugger`,
  `env_sideload`, `env_vpn_active`, `env_sim_country_mismatch`, `env_network_country_mismatch`, `env_cell_country_mismatch`,
  `env_timezone_country_mismatch` (vs the relocation fix or the account's last fix), `gnss_zero_satellites` (0 used with
  accuracy ≤ `TRUST_GNSS_ZERO_SAT_MAX_ACCURACY_M`), `install_multi_account` (≥ `TRUST_INSTALL_ALT_ACCOUNT_THRESHOLD` accounts
  on one install id), `devicecheck_spoof_bit`, `pi_high_device_activity` (LEVEL_3/4), `pi_risky_app_access`. Hooking
  detection is not part of the contract. Nothing here blocks or revokes.
- DeviceCheck two bits: queried on every iOS attestation that carries a token; bit0 is set on admin Lock and red-zone
  auto-lock when `TRUST_DEVICECHECK_BIT_SET_ENABLED=true` (default false; keeps the latest token 7 days).
- **[owner]** Play Integrity optional verdicts (app access risk, Play Protect, recent device activity) must be enabled in
  Play Console → App integrity → Play Integrity API settings; until then they are simply absent.
- Web Relocate: session `trustRelocationPhoneOnly` (web while `TRUST_RELOCATION_NATIVE_ONLY_MODE=enforce`) shows
  "Relocate from the Ash Atlas app on your phone" instead of a failing button.

## 9. Work packages and rollout

One commit per WP. Focused tests only; DB tests on a disposable
`ash_atlas_stability*` database with `--no-file-parallelism`.

**Deploy 1 — server, careful lane (migrations + protocol).** Rollout truth: until the store build is live and assurance is enforced,
Settled is earnable from a spoofed browser/legacy shell (finding 3), i.e. no stronger than today's doorway. A3–A5b still raise the bar
on day one because they are status/anchoring rules: a spoofer must now hold Settled *at the target* for ≥ 14 days to open any doorway, and
a later mock/mismatch flag closes it retroactively.
- **A1** Shared contract: `deviceTrust.ts`, schema fields, session fields, `LOCATION_FIX_REASONS`, 7-day constant + `players.ts:749`
  SQL from the constant + copy. Tests: parser fixtures; relocation status/guard agree at 7 d.
- **A2** Migrations 0911 + 0912 with grandfather backfill. Tests: text tests, populated upgrade + empty second run; backfill fixture
  with earned / blanket / flagged accounts.
- **A3** Settled engine `apps/server/src/auth/trust/settlement.ts` (pure targets/progress + store) inside the report transaction;
  Settled home / moved-away / return; revocation (invites invalidated); provisional expiry job; doorway switched to Settled + presence
  assurance + anchored-only exemption; leaking copy removed; young-inviter rules. Tests: §10.1 Settled + doorway + **chain test**.
- **A4** Population grid tool + data + `populationGrid.ts`; yellow-owner query; anchoring query helpers (owner settlement join).
- **A5** Relocation pipeline: zones, red hold + allowance + rate limits, free re-pick, return-home exemption, native-only mode,
  alerts writer, `account_settlement` home update on applied relocation.
- **A5b** Anchored destinations in `flagAccess.authorizeWith` + World Map resolution + party/invite exemption; hostile-action gate
  in `landActionGuard.ts` and the military order handlers; `trust_arrivals` + mass-arrival alert. Both gates `shadow`.
- **A6** Mismatch signals: `ipGeo.ts` (DB-IP MMDB), `asnClasses.ts`, zone/country lookup, `gps_static`, VPN handling, network
  block ASN condition.
- **A7** Attestation server: evaluators, Play Integrity / DeviceCheck clients, App Attest verifier, service, store, routes,
  resolver; ledger wiring of `native` + `attestationRef` + `last_fix_assurance`; per-family signal gating; retention.
- **A8** Admin: Alerts tab, Settled detail (targets/progress/home/provisional), arrivals graph, attestation history, approve /
  lock / dismiss / quarantine-arrivals routes, unanchored-routes report.
- **A9** Deletion cleanup in `accountDeletionService.ts` (trust/settlement/alert/arrival/attestation/location rows) + privacy docs.

**Deploy 2 — client JS via normal deploy + OTA (legacy shells keep working)**
- Plugin contract (method names, arguments, return shapes, error codes): header of `apps/client/src/native/nativeDeviceTrust.ts`.
- **B1** `nativeDeviceTrust.ts` bridge, `deviceGeolocation.ts` native path + `native` block, action fixes (native only), copy.
- **B2** `deviceAttestation.ts` AttestationManager (warm-up, foreground refresh, relocation-bound attest with 6 s budget, iOS key
  lifecycle, backoff).
- Gate: 48 h, no client errors, `native_legacy` rows carry `shellBuild`.

**Store build — careful lane, owner-gated.** N1 Android location + mock + carrier country; N2 Android Play Integrity; N3 iOS location +
purpose string; N4 iOS App Attest + DeviceCheck + entitlement; N5 release-tooling verification; N6 TestFlight + Play internal → §10.2 →
phased production. Do not raise the minimum shell build here.

**After the store build**
1. The day both stores are live: `TRUST_SETTLE_ASSURANCE_MODE=enforce`, `TRUST_RELOCATION_NATIVE_ONLY_MODE=enforce`. Legacy shells keep
   Settled but stop earning; the existing update banner nudges them. **[owner]**
2. ≥ 14 days live and ≥ 90 % of native fixes non-legacy ⇒ raise `NATIVE_MINIMUM_SHELL_BUILD` (`packages/shared/src/nativeCompatibility.ts:16`,
   `tools/release/build-native-bundles.mjs:214`).
3. One flip per deploy after review, in this order: `TRUST_ANCHOR_MODE` (after the unanchored-routes report), `TRUST_HOSTILE_GATE_MODE`,
   `TRUST_MOCK_LOCATION_MODE`, `TRUST_ATTESTATION_MODE`, then the existing `TRUST_LOCATION_REJECT_MODE` / `TRUST_LAND_ACTION_MODE` /
   `TRUST_QUARANTINE_MODE`. Dry-run `trust:reverse` before each.

## 10. Test checklists

### 10.1 Automated (per WP)
Settled: targets randomized within range and absent from every client payload (assert session JSON); gap rule under two concurrent
records; distinct-day and distinct-position rules; web and VPN fixes never count; reset + invite invalidation on mock; moved-away /
return-home; provisional expiry; grandfather fixture. Doorway: unsettled refused with numberless copy; presence requires native assurance
in enforce; exemption only for anchored near-home destinations; **chain test**: A (Settled, present) invites B; B at the spot places a flag
and cannot invite C (presence fails, flag unanchored). Anchoring: owner always allowed; stranger denied on unanchored public flag / city
/ seat, allowed when anchored; `companionHostPlayerId` bypass; shadow records signal only. Hostile gate: unsettled denied on others'
flag and hostile order, allowed on own flag, Settled allowed, PvP untouched. Zones: classify fixtures (Antarctica red, mid-Pacific red,
Manhattan urban, a remote Alaska village orange/rural); yellow only non-urban; red hold does not consume cooldown; one pending red per
account; allowance one-shot. Mismatch: each rule positive/negative; VPN suppresses distance and counting; satellite neutral; `gps_static`
never hard. Arrivals: mass-arrival alert at 3 within 60 min, none for near-home arrivals. Attestation: every verifier branch, replay,
counter regression, identical pass/fail bodies, CSRF denied, digest hex→base64url. Relocation: 7-day guard in SQL and status agree;
return-home exempt. Deletion: all trust rows gone.

### 10.2 On-device (record in `./test-results/native-antispoof\`)
Android (Play internal): clean phone ⇒ `attested`; permission denied ⇒ no prompt; fake-GPS app ⇒ `location_mock`, progress reset,
pending invites invalidated; sideloaded APK ⇒ `attest_app_fail`; emulator ⇒ `attest_device_fail`; airplane mode ⇒ neutral; build-8 shell +
new OTA ⇒ `native_legacy`; stationary 45 min ⇒ no revocation. iOS: simulator ⇒ `simulated`, no crash; dev build ⇒ key registers, golden
fixture captured; Xcode Simulate Location ⇒ `location_mock`; TestFlight ⇒ `attested`; reinstall ⇒ one key regeneration; stationary
45 min ⇒ no revocation.

## 11. Owner action items (plain language)
- Decide the six questions in §13 (each has a recommendation; "go with the recommendations" is a valid answer).
- Google: Play Console → App integrity → link the Firebase/Cloud project; enable the Play Integrity API in Cloud Console; send the
  **project number** and the **app signing SHA-256**; request a Play Integrity quota raise; update Data safety.
- Apple: enable **App Attest** on `com.ashatlas.game`; regenerate + re-upload the App Store profile; create a **DeviceCheck key** (.p8 + Key
  ID); update App Privacy.
- Hardware: one Android phone (+ a fake-GPS app), one iPhone, the Mac.
- Release: approve the careful-lane deploys; un-pause store builds for N6; approve each enforce flip in the §9 order.
- Expect a few honest red holds (Alaska, deserts, national parks): review them the same day.
- Keep the thresholds out of the wiki, patch notes and support replies.

## 12. Known limits and non-goals
A second real phone kept at the target ("drop phone") is indistinguishable from a resident: the defences are cost (a device and
connectivity at the target for ≥ 14 days), linked-device/network signals if the operator ever mixes devices, the young-inviter hold,
the mass-arrival alert, and bulk quarantine. Rooted/jailbroken phones with hiding tools and leaked keyboxes can sometimes pass device
integrity; mismatch signals, Settled, anchoring and alerts are the backstop. Non-Play Android is never `attested` and cannot Settle
once assurance is enforced (accepted). DB-IP and GHSL are approximations: mismatch and orange never block alone; only red holds, and red
is admin-recoverable. Accounts already inside a place stay there; tooling closes doorways, it does not evict or restore game state.
No motion/step data; no background location; no checks on Settled players' actions, PvP, or combat; no `QUERY_ALL_PACKAGES`; no App
Attest receipt fraud metric; no change to existing trust weights.
Unsettled alts are unhittable (two-way shield, §3.4), so they must not be able to body-block, claim, or occupy contested spots: the A5b
check every PvP-adjacent mechanic an untouchable alt could abuse (blocking paths or spawns, holding resource nodes or
capture points, standing on contested tiles). Scouting by an unsettled alt is accepted.

## 13. Owner answers (2026-10-02)
1. Unsettled = no PvP, no flag attacks, no sieges/bombers (§3.4). Two-way shield: no one can hit an unsettled player either.
2. Unsettled flags/structures private; cannot be made public/normal until Settled (§3.3).
3. Return home free of the 7-day lock: yes.
4. Provisional grandfathering 30 d / half targets: yes.
5. Assurance enforce the day both store builds are live: yes.
6. Doorways need a fresh verified phone fix at the spot; web cannot produce one, so web cannot invite (accepted as a consequence).

## 13a. Original open questions (answered above)
1. **Hostile-action gate scope.** Recommend: unsettled accounts cannot burn/attack any other player's flag or issue hostile military
   orders (≥ 14 days for honest newcomers). Alternative: only against owners with territory within 10 km of the actor's home anchor
   (weaker, keeps O6's shape).
2. **Anchoring cost for new players.** Recommend accepting that a new player's flags/city are not travel destinations for others until
   they Settle, with `TRUST_HOME_DESTINATION_RADIUS_KM = 50`. Without this, the invite guard is decorative (finding 1).
3. **Return home free of the 7-day lock.** Recommend yes: relocating back within 25 km of the Settled home never costs anything and
   restores Settled; it gives cheaters nothing.
4. **Provisional grandfathering.** Recommend 30 days with half targets for accounts the 0884 backfill confirmed without earned days;
   alternative: treat them as fully Settled (imports existing spoofers).
5. **Assurance enforce timing.** Recommend the day both store builds are live (legacy shells stop earning, keep what they have);
   alternative: wait for the 14 d / 90 % shell threshold (leaves the legacy spoof window open longer).
6. **Phone-only doorways.** Recommend accepting that invites and party leadership require the phone app once relocation is phone-only
   (browser fixes cannot be trusted and will no longer exist).
