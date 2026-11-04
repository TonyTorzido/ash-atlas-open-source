# Ash Atlas — Auth expansion + GPS anti-spoofing: implementation plan

Base: `origin/integration/test` @ `test/t1344` (`a9d076947`). Next free migration numbers: **0880+** (highest at authoring is `0879_level_cap_40.sql`; the runner sorts by `localeCompare`, `apps/server/src/db/migrate.ts:50-78`).

Execution note: wave 1 runs as two lanes on two feature branches:
- Auth lane (WP1, WP2, WP3): `feature/account-trust-antispoof--from-t1344`, worktree `worktrees\account-trust-antispoof__t1344`.
- Trust lane (WP4, WP5, WP6, WP7, WP8): `feature/location-trust--from-t1344`, worktree `worktrees\location-trust__t1344`.
Each WP is its own commit. Shared touchpoints between lanes: `config.ts`, `application.ts`, `.env.example`, `authService.ts` (WP6 login hook), `packages/shared/src/auth.ts`.

## 0. Reality check: what the code actually does (verified)

1. **Device GPS enters the game at exactly one point.** The avatar is server-authoritative and moves by tap-to-move (`MOVE_TO`, `apps/server/src/realtime/handlers/worldGameplayHandler.ts:85`; speed `PLAYER_SPEED_MPS`, default 125 m/s at `packages/shared/src/gameplayArea.ts:13`; step clamp at `apps/server/src/game/state.ts:826`) and by server travel (flag visits, world-map travel, party travel). Initial spawn is server-random US land, not GPS (`apps/server/src/auth/initialSpawn.ts:65`). The only GPS-driven message is `RELOCATE_TO_CURRENT_LOCATION` (`packages/shared/src/protocol/relocationSchemas.ts:11-17`; handler `apps/server/src/realtime/handlers/travelHandler.ts:508-662`), already limited to once per 24 h by a DB-enforced cooldown (`apps/server/src/game/players.ts:520-537`, `:735-749`; constants `packages/shared/src/travel.ts:5-6`; column from `db/migrations/0812_gps_relocation.sql`). The client fetches one fix via `@capacitor/geolocation` / browser geolocation with `maximumAge: 0` (`apps/client/src/location/deviceGeolocation.ts`), and sends `lat, lon, accuracy?`.
   - Consequence: there is no per-tick location stream, so "batches", client `seq`, and continuous speed buckets are mostly moot today. A spoofer's gain is choosing one relocation point per day. The plan keeps the research's mechanisms but scopes them to relocation fixes (plus an optional passive fix, WP8) and treats wave 1 as a **logging/calibration** wave.
   - "Remote presence" already exists (flag/city/shrine travel), so server travel never counts as displacement for the cooldown.

2. **Land actions and where they are authorized server-side:**
   - Flag claim: `PLACE_FLAG` → `apps/server/src/realtime/handlers/flagHandler.ts:63` → `flagBuilds.start(player, ...)` (`apps/server/src/game/flagBuildCoordinator.ts:216`).
   - Flag upgrade/reinforce: `REINFORCE_FLAG` (`flagHandler.ts:135` → `flagHardeningCoordinator.ts:67`) and HTTP `POST /api/flags/:id/upgrade` (`apps/server/src/http/routes/flagRoutes.ts:554`).
   - Raids: `START_FLAG_BURN` (`flagHandler.ts:158` → `flagBurning.ts:167`), `ATTACK_FLAG` (`flagHandler.ts:192` → `flags.ts:2208`).
   - City land: `FOUND_CITY` (`settlementHandler.ts:232`), `CONVERT_CITY_FLAG` (`settlementHandler.ts:1612`).
   - PvP engagement: `START_ATTACK` (`combatEquipmentHandler.ts:1242`, enqueued at `:1290` as world command `start-attack`) → `combatEngine.startAttack` (`combatEngine.ts:3161`) → `validateAttackPair` (`:13389`, PvP predicates `:850-852`). Target is PvP iff `gameState.getPlayer(message.targetEntityId)` is non-null.
   - Realtime handler contexts are built in `apps/server/src/realtime/realtimeApplication.ts` (`:1666` world, `:1844` flag, `:1860` travel, `:1906` settlement, `:2144` combat). `request.ip` is available at connection scope (`:1422`), and `auth.networkHashForRequest(ip)` exists (`authService.ts:126`).

3. **Auth today:** `googleIdentity.ts:77` hard-rejects non-gmail inside the payload parser regardless of config; `authService.requireAllowedIdentity` (`authService.ts:839-852`) re-checks with `AUTH_REQUIRE_GMAIL` (`config.ts:400`); production refuses `AUTH_REQUIRE_GMAIL=false` (`config.ts:939-945`). Sessions are provider-agnostic (`authStore.ts:706-734`; `verified_google_subject` is NULL for non-google identities at `:717`), developer capabilities key off `verifiedGoogleSubject` only (`developerAuthorization.ts:35`). Apple proves the multi-provider pattern (`createOrLoadAppleAccount` `authStore.ts:267-349`, `ACCOUNT_LINK_REQUIRED` at `:289-303`; migration `0850`). Test-access email grants are *not* provider-agnostic: `testAccessService.ts:217-226` filters `provider = 'google'`, and `applyIdentityAccessDecision` (`authStore.ts:1072-1110`) runs only on the Google path. Account deletion anonymizes emails only for `provider = 'google'` (`accountDeletionService.ts:384-403`), which would violate the new `'email'` shape constraint unless updated.

4. **Existing risk/trust infrastructure:** `accounts.trust_tier` ('new'|'standard'|'trusted'|'restricted', never promoted anywhere) and `accounts.risk_score` (0-100 integer, sum of `account_risk_events.weight`, `authStore.ts:813-851`) from `db/migrations/0010_google_accounts.sql`. Signals: `RISK_WEIGHTS` (`riskService.ts:3-9`), `recordDeviceRisk` / `recordNetworkCreationRisk` (`authService.ts:863-927`; `countRecentDistinctAccounts` at `:882-884` only counts `google_login_success`). Creation limits: `enforceNewAccountLimits` (`authService.ts:805-837`), `AUTH_NEW_ACCOUNT_DEVICE_MAX=3`, `AUTH_NEW_ACCOUNT_NETWORK_MAX=5` per 24 h (`config.ts:410-411`), `reserveAuthAttempt` (`authStore.ts:885`, eventType is a two-literal union). Login limits: `AUTH_LOGIN_IP_MAX=20`, `AUTH_LOGIN_DEVICE_MAX=10` per 10 min.

## 1. Decisions and defaults

| # | Decision | Default / rationale |
|---|---|---|
| D1 | Google policy | Keep `AUTH_REQUIRE_GMAIL`, default **false**, remove the production refusal. Any `email_verified=true` Google account (Workspace, school, non-gmail) is accepted. No domain blocklist for Google. |
| D2 | Email domain policy | **Allowlist by default** (owner decision): only mainstream providers in the built-in list (Gmail/Googlemail, Outlook/Hotmail/Live/MSN + common country domains, Yahoo/Ymail/Rocketmail + country domains, iCloud/me/mac, AOL, GMX); `AUTH_EMAIL_DOMAIN_ALLOWLIST` adds domains. No relays, disposables, Proton/Tuta, or custom domains. `blocklist` mode stays available (bundled disposable + relay lists + `AUTH_EMAIL_DOMAIN_BLOCKLIST_EXTRA`). **Alias-proof identity:** the canonical mailbox (lowercase, `+tag` stripped for every domain, Gmail dots removed, googlemail→gmail; TS `canonicalEmail` = SQL `auth_canonical_email`) is the email `provider_subject` and keys codes, per-email limits, new-account checks, email test-access grant matching, and all cross-provider link checks via the generated `account_identities.email_canonical`. Codes are sent to the address as typed. No MX lookups. |
| D3 | Email provider | **Resend** HTTP adapter (`POST https://api.resend.com/emails`, Bearer key, 10 s timeout). Postmark is a drop-in alternative behind the same interface. Dev/test uses `LogEmailSender`. Production refuses `AUTH_EMAIL_SENDER=log` when email login is enabled. |
| D4 | Codes | 6 digits from `crypto.randomInt`, stored as `HMAC-SHA256(AUTH_EMAIL_CODE_HMAC_KEY, "email-code:" + email_normalized + ":" + code)`, 10 min TTL, single use, 5 attempts per code (atomic counter), new request invalidates earlier active codes for that email+purpose. |
| D5 | Enumeration | `start` returns the same 200 body whether the email is new or existing. Domain/syntax failures return 400. `verify` returns one code `EMAIL_CODE_INVALID` for wrong/expired/consumed/over-attempts. |
| D6 | Never auto-merge | Email sign-in whose canonical mailbox (`email_canonical`, see D2) matches any verified identity on another account → 409 `ACCOUNT_LINK_REQUIRED`. Google/Apple sign-in whose canonical email matches an *email-provider* account → same. Linking from settings: Email→(link Google) and Google/Apple→(link email). Google link requires the Google email's canonical form to equal one of the account's verified canonical emails. |
| D7 | Email identity subject | `provider='email'`, `provider_subject = <canonical mailbox>` (`email` keeps the typed address); `UNIQUE (provider, provider_subject)`. |
| D8 | Email accounts and capabilities | Zero developer capabilities (`verifiedGoogleSubject` is null). Test-access grants match verified emails across `google` and `email` providers. |
| D9 | Creation caps for email | `AUTH_NEW_ACCOUNT_EMAIL_DEVICE_MAX=2`, `AUTH_NEW_ACCOUNT_EMAIL_NETWORK_MAX=3` per 24 h. Per-email: 3 codes / 10 min, 10 / day, resend after 60 s. |
| D10 | Location seq/nonce | **Server-assigned** monotonic `seq` per account (`UNIQUE (account_id, seq)`). Client nonce binding deferred to the attestation wave. |
| D11 | Region key | `cell = floor(lat/0.5) + ":" + floor(lon/0.5)`; familiarity = cell with ≥10 interaction-days, last seen ≤90 days, checked over the 3x3 neighborhood. |
| D12 | Trust score | Decaying log-odds `account_trust_state.logodds` (τ = 7 d). Existing `accounts.risk_score` folded in as static prior (`risk_score / 25`). Static priors: provider `email` +1.0, Google non-gmail +0.5, Apple/gmail/dev 0; account age < 7 d +0.5. `effective = decayed + priors`. |
| D13 | Cooldown table | km→min: 1→1, 2→1, 5→2, 10→7, 25→11, 50→17, 100→30, 250→45, 500→60, 750→75, 1000→90, 1250→105, ≥1500→120 (linear interpolation). `d_eff = max(0, d − (accA + accB))`; no hold below 500 m. Displacement measured only from GPS relocation fixes against the last land-action position (fallback: last accepted fix, then avatar position before relocation). |
| D14 | Transit | Bucket from implied speed between consecutive accepted fixes: ≤9 walk, ≤43 cycle, ≤160 car, ≤320 rail, ≤900 air, >900 impossible (reject in enforce). Car/rail/air set a hold of `max(cooldown(d), 10 min)`. |
| D15 | Accuracy | No rejection on accuracy. Logged as a feature; `TRUST_SETTLE_ACCURACY_M` default 5000. |
| D16 | Enforcement | Every mechanism ships in **shadow** mode by default, switched per mechanism by config (section 4). Tiers 3+ computed as `shadow_tier` only; `enforcement_tier` stays 0 until wave 3. |
| D17 | New-account land restrictions | No blanket restriction. Email prior +1, tighter caps, quarantine threshold for `trust_tier='new'` is 6 instead of 8 (enforce only). |
| D18 | Trust tier promotion | `new → standard` after 14 days, ≥5 distinct login days, effective log-odds < 4 (evaluated at login). `restricted` set only by enforce-mode tier 3+ (wave 3). |
| D19 | Admin capability | Reuse `developer:test-access-manage` for trust admin views. |

**User must provide (not needed for wave 1 build/verification):** Resend account, API key, verified sending domain (SPF/DKIM DNS), `AUTH_EMAIL_FROM`; production env edits (`AUTH_REQUIRE_GMAIL=false`, `AUTH_EMAIL_*`, `AUTH_EMAIL_CODE_HMAC_KEY` distinct 32+ chars); later waves: Play Console + Play Integrity, Apple App Attest entitlement, MaxMind license key, store builds for native plugin work.

## 2. Architecture overview

### 2.1 Data model (all new, fix-forward)

**`0880_email_login_identity.sql`** (WP2)
```sql
BEGIN;
ALTER TABLE account_identities DROP CONSTRAINT IF EXISTS account_identities_provider_check;
ALTER TABLE account_identities ADD CONSTRAINT account_identities_provider_check
  CHECK (provider IN ('google', 'apple', 'email'));
ALTER TABLE account_identities DROP CONSTRAINT IF EXISTS account_identities_email_shape_check;
ALTER TABLE account_identities ADD CONSTRAINT account_identities_email_shape_check CHECK (
  (provider IN ('google', 'email') AND email IS NOT NULL AND email_verified = true
     AND char_length(email) BETWEEN 3 AND 320)
  OR (provider = 'apple' AND (email IS NULL OR char_length(email) BETWEEN 3 AND 320)
     AND (email_verified IS NULL OR email_verified IN (true, false))));
ALTER TABLE test_access_email_grants DROP CONSTRAINT IF EXISTS test_access_email_grants_claimed_identity_shape_check;
ALTER TABLE test_access_email_grants ADD CONSTRAINT test_access_email_grants_claimed_identity_shape_check CHECK (
  (status = 'claimed' AND claimed_provider IN ('google', 'apple', 'email') AND claimed_subject IS NOT NULL)
  OR (status <> 'claimed' AND claimed_provider IS NULL AND claimed_subject IS NULL));
CREATE TABLE IF NOT EXISTS email_login_codes (
  id uuid PRIMARY KEY,
  email_normalized text NOT NULL CHECK (char_length(email_normalized) BETWEEN 3 AND 320),
  code_hash text NOT NULL CHECK (char_length(code_hash) = 64),
  purpose text NOT NULL CHECK (purpose IN ('signin', 'link')),
  account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  session_id uuid NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT,
  device_installation_id uuid NULL REFERENCES device_installations(id) ON DELETE SET NULL,
  network_hash text NULL CHECK (network_hash IS NULL OR char_length(network_hash) BETWEEN 16 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  consumed_at timestamptz NULL,
  invalidated_at timestamptz NULL,
  invalidation_reason text NULL CHECK (invalidation_reason IS NULL OR invalidation_reason IN ('superseded', 'attempts_exhausted', 'account_deleted')),
  send_status text NOT NULL DEFAULT 'pending' CHECK (send_status IN ('pending', 'sent', 'logged', 'failed')),
  send_provider text NULL CHECK (send_provider IS NULL OR char_length(send_provider) <= 32),
  send_message_id text NULL CHECK (send_message_id IS NULL OR char_length(send_message_id) <= 256),
  send_error text NULL CHECK (send_error IS NULL OR char_length(send_error) <= 1000),
  CHECK (expires_at > created_at),
  CHECK ((purpose = 'signin' AND account_id IS NULL AND session_id IS NULL)
      OR (purpose = 'link' AND account_id IS NOT NULL AND session_id IS NOT NULL)),
  CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
);
CREATE INDEX IF NOT EXISTS email_login_codes_email_created_idx ON email_login_codes (email_normalized, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS email_login_codes_expiry_idx ON email_login_codes (expires_at);
COMMIT;
```
Raw codes are never stored. Verify constraint names and referenced table names (`auth_sessions`, `device_installations`) against the existing migrations before writing; adjust to the real names.

**`0881_location_reports.sql`** (WP4)
```sql
BEGIN;
CREATE TABLE IF NOT EXISTS location_reports (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  player_id text NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  source text NOT NULL CHECK (source IN ('relocation', 'passive')),
  request_id text NULL CHECK (request_id IS NULL OR char_length(request_id) <= 128),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  accuracy_m double precision NULL CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  client_platform text NULL CHECK (client_platform IS NULL OR client_platform IN ('web', 'ios', 'android')),
  device_installation_id uuid NULL REFERENCES device_installations(id) ON DELETE SET NULL,
  network_hash text NULL,
  network_prefix_hash text NULL,
  device_time_zone text NULL CHECK (device_time_zone IS NULL OR char_length(device_time_zone) <= 64),
  received_at timestamptz NOT NULL DEFAULT now(),
  prev_report_id uuid NULL REFERENCES location_reports(id) ON DELETE SET NULL,
  distance_m double precision NULL CHECK (distance_m IS NULL OR distance_m >= 0),
  elapsed_ms bigint NULL CHECK (elapsed_ms IS NULL OR elapsed_ms >= 0),
  implied_kmh double precision NULL CHECK (implied_kmh IS NULL OR implied_kmh >= 0),
  speed_bucket text NULL CHECK (speed_bucket IS NULL OR speed_bucket IN ('stationary', 'walk', 'cycle', 'car', 'rail', 'air', 'impossible')),
  verdict text NOT NULL CHECK (verdict IN ('accepted', 'shadow_rejected', 'rejected', 'travel_failed')),
  verdict_reason text NULL CHECK (verdict_reason IS NULL OR char_length(verdict_reason) <= 64),
  features jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features) = 'object' AND pg_column_size(features) <= 8192),
  score double precision NOT NULL DEFAULT 0,
  UNIQUE (account_id, seq)
);
CREATE INDEX IF NOT EXISTS location_reports_account_received_idx ON location_reports (account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS location_reports_received_idx ON location_reports (received_at);
CREATE TABLE IF NOT EXISTS account_location_state (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_accepted_report_id uuid NULL REFERENCES location_reports(id) ON DELETE SET NULL,
  last_fix_lat double precision NULL, last_fix_lon double precision NULL,
  last_fix_accuracy_m double precision NULL, last_fix_at timestamptz NULL,
  last_land_action_at timestamptz NULL,
  last_land_action_lat double precision NULL, last_land_action_lon double precision NULL,
  land_action_hold_until timestamptz NULL,
  land_action_hold_reason text NULL CHECK (land_action_hold_reason IS NULL OR land_action_hold_reason IN ('relocation_cooldown', 'transit', 'settle')),
  relocations_7d_far integer NOT NULL DEFAULT 0 CHECK (relocations_7d_far >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
```
`seq` is assigned inside the same transaction as the insert: `INSERT ... ON CONFLICT (account_id) DO UPDATE SET last_seq = account_location_state.last_seq + 1 RETURNING last_seq` (the row lock serializes per account).

**`0882_account_trust_state.sql`** (WP6)
```sql
BEGIN;
CREATE TABLE IF NOT EXISTS account_trust_state (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
  logodds double precision NOT NULL DEFAULT 0,
  logodds_updated_at timestamptz NOT NULL DEFAULT now(),
  peak_logodds double precision NOT NULL DEFAULT 0,
  shadow_tier smallint NOT NULL DEFAULT 0 CHECK (shadow_tier BETWEEN 0 AND 6),
  enforcement_tier smallint NOT NULL DEFAULT 0 CHECK (enforcement_tier BETWEEN 0 AND 6),
  tier_entered_at timestamptz NULL,
  tier_exit_eligible_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_trust_state_logodds_idx ON account_trust_state (logodds DESC);
CREATE TABLE IF NOT EXISTS account_trust_events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('signal', 'shadow_tier_change', 'tier_change', 'reversal', 'note')),
  rule text NOT NULL CHECK (char_length(rule) BETWEEN 1 AND 64),
  weight double precision NOT NULL DEFAULT 0,
  logodds_after double precision NOT NULL,
  location_report_id uuid NULL REFERENCES location_reports(id) ON DELETE SET NULL,
  dedupe_key text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz NULL,
  reversal_id uuid NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS account_trust_events_dedupe_idx ON account_trust_events (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_trust_events_account_created_idx ON account_trust_events (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_trust_events_rule_created_idx ON account_trust_events (rule, created_at DESC);
CREATE TABLE IF NOT EXISTS account_regions (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  region_cell text NOT NULL CHECK (region_cell ~ '^-?[0-9]+:-?[0-9]+$'),
  interaction_days integer NOT NULL DEFAULT 1 CHECK (interaction_days >= 1),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_counted_day date NOT NULL,
  PRIMARY KEY (account_id, region_cell)
);
CREATE INDEX IF NOT EXISTS account_regions_account_days_idx ON account_regions (account_id, interaction_days DESC);
COMMIT;
```
Note: `account_regions` is written by WP5 (`recordLandAction`). Because WP5 lands before WP6, WP5 creates `account_regions` in its own migration (`0882_account_regions.sql`) and WP6 uses `0883_account_trust_state.sql` for the remaining two tables. (Root adjustment to keep each WP self-contained.)

### 2.2 Config keys (`apps/server/src/config.ts`, documented in `.env.example`)

| Key | Default | Notes |
|---|---|---|
| `AUTH_REQUIRE_GMAIL` | `false` | WP1. Production refinement removed. |
| `AUTH_EMAIL_LOGIN_ENABLED` | `false` | WP2. Exposed as `emailSignInEnabled` in session response. |
| `AUTH_EMAIL_SENDER` | `log` | `log`\|`resend`. Production + enabled ⇒ must be `resend`. |
| `AUTH_EMAIL_RESEND_API_KEY` | `""` | Required when sender=resend. |
| `AUTH_EMAIL_FROM` | `"Ash Atlas <no-reply@localhost>"` | Must contain `@` in production. |
| `AUTH_EMAIL_CODE_HMAC_KEY` | dev constant (min 32) | Added to the distinct-keys and not-dev-value production checks (`config.ts:946-973`). |
| `AUTH_EMAIL_CODE_TTL_SECONDS` / `AUTH_EMAIL_CODE_RESEND_SECONDS` | 600 / 60 | |
| `AUTH_EMAIL_CODE_PER_EMAIL_10MIN` / `AUTH_EMAIL_CODE_PER_EMAIL_DAY` | 3 / 10 | |
| `AUTH_EMAIL_DOMAIN_POLICY` / `AUTH_EMAIL_DOMAIN_ALLOWLIST` / `AUTH_EMAIL_DOMAIN_BLOCKLIST_EXTRA` | `blocklist` / `""` / `""` | CSV lists. |
| `AUTH_NEW_ACCOUNT_EMAIL_DEVICE_MAX` / `AUTH_NEW_ACCOUNT_EMAIL_NETWORK_MAX` | 2 / 3 | 24 h window. |
| `AUTH_EMAIL_DEV_LOG_CODES` | `false` | Honored only when `NODE_ENV !== "production"`. |
| `TRUST_LOCATION_REJECT_MODE` | `shadow` | `off`\|`shadow`\|`enforce`. |
| `TRUST_LAND_ACTION_MODE` | `shadow` | `off`\|`shadow`\|`enforce`. |
| `TRUST_QUARANTINE_MODE` | `shadow` | `off`\|`shadow`\|`enforce` (production refuses `enforce` unless `TRUST_LADDER_ACK` is set). |
| `TRUST_LADDER_MAX_TIER` | `2` | |
| `TRUST_DECAY_TAU_DAYS` | 7 | |
| `TRUST_FAMILIAR_REGION_DAYS` / `TRUST_FAMILIAR_REGION_STALE_DAYS` | 10 / 90 | |
| `TRUST_QUARANTINE_THRESHOLD` / `TRUST_QUARANTINE_THRESHOLD_NEW` / `TRUST_WARNING_THRESHOLD` | 8 / 6 / 15 | |
| `TRUST_LAND_ACTION_MIN_DISPLACEMENT_M` / `TRUST_TRANSIT_HOLD_MINUTES` / `TRUST_SETTLE_ACCURACY_M` | 500 / 10 / 5000 | |
| `TRUST_LOCATION_REPORT_RETENTION_DAYS` | 180 | |
| `TRUST_PASSIVE_FIX_ENABLED` | `true` | WP8; foreground-only, permission already granted. |
| `TRUST_PASSIVE_FIX_MIN_SECONDS` | `180` | Shortest delay between periodic passive fixes (min 60). |
| `TRUST_PASSIVE_FIX_MAX_SECONDS` | `420` | Longest delay (must be >= min). Each delay is re-rolled uniformly in [min, max] after every fix. |

### 2.3 Module boundaries

- `apps/server/src/auth/email/`: `emailSender.ts` (interface + Log + Resend + factory), `emailDomainPolicy.ts`, `disposableDomains.ts`, `loginCodes.ts` (pure). `authService.ts` owns email login/link lifecycle; `authStore.ts` owns SQL.
- `apps/server/src/auth/trust/`: `trustScore.ts` (pure), `trustStore.ts` (SQL), `trustService.ts` (`LocationReportService`, `LandActionGate`, `TrustSignalSink`), `trustReversalCli.ts`.
- `apps/server/src/http/developerTrustRoutes.ts`: admin reads (pattern of `developerCommunitySafetyRoutes.ts`).
- `packages/shared`: `auth.ts` (session response fields), `protocol/relocationSchemas.ts` + `travelMessages.ts` + `travelServerSchemas.ts` (optional fields), new `trust.ts` for admin view types.
- Client: `apps/client/src/auth/authClient.ts`, `ui/LoginScreen.tsx`, `ui/AuthGate.tsx`, `ui/PhoneHud.tsx`, `ui/TrustAdminScreen.tsx`, `location/deviceGeolocation.ts`.

## 3. Work packages

### Wave 1

#### WP1 — Accept any verified Google account (auth)
Files: `apps/server/src/auth/googleIdentity.ts` (remove the check at `:77`; keep `isExactGmailAddress` exported), `authService.ts:839-852` (now the only gate), `config.ts:400` (default `false`), `config.ts:939-945` (delete refinement), `.env.example`, `docs/production-authentication.md` (intro + "Gmail enforcement" section), `apps/client/src/ui/LoginScreen.tsx:137-139` copy (no Gmail claim). Tests: `googleIdentity.test.ts` (parser accepts `user@workspace.example`), `authService.test.ts` (allowed non-gmail with flag false, denied with true), `config.auth.test.ts` (production accepts `false`).
Acceptance: non-gmail verified Google login creates an account; `email_verified=false` still rejected; `VERIFIED_GMAIL_REQUIRED` still returned when flag is `true`.

#### WP2 — Email one-time-code provider, server (auth + migration)
Migration: `db/migrations/0880_email_login_identity.sql`.
Types (`auth/types.ts`): `VerifiedEmailIdentity = { provider: "email"; subject: string; email: string; emailVerified: true; authTime: Date }`; widen `identityProvider` unions and `issueSession`'s parameter to `"google" | "apple" | "email"`; add `AuthFailureCode` members `EMAIL_INVALID`, `EMAIL_DOMAIN_NOT_ALLOWED`, `EMAIL_CODE_INVALID`, `TOO_MANY_EMAIL_CODE_REQUESTS`.
Store (`authStore.ts`):
```ts
findAccountByEmailIdentity(emailNormalized: string): Promise<AuthAccountRecord | null>;
createOrLoadEmailAccount(identity: VerifiedEmailIdentity): Promise<AccountIdentityResult & { provider: "email" }>; // ACCOUNT_LINK_REQUIRED when any verified identity with this email exists on another account (advisory lock `email-identity:<email>`)
linkEmailIdentity(input: { accountId; sessionId; identity: VerifiedEmailIdentity; now }): Promise<{ identityId }>; // ACCOUNT_LINK_CONFLICT
linkGoogleIdentity(input: { accountId; identity: VerifiedGoogleIdentity; now }): Promise<{ identityId }>; // ACCOUNT_LINK_CONFLICT
createEmailLoginCode(input: { id; emailNormalized; codeHash; purpose; accountId?; sessionId?; deviceInstallationId; networkHash; now; expiresAt }): Promise<void>; // invalidates active codes (purpose, email) 'superseded'
consumeEmailLoginCode(input: { emailNormalized; purpose; codeHash; now }): Promise<"consumed" | "invalid">; // one transaction: lock newest active code; match → consumed_at; else attempt_count+1, invalidate at 5
markEmailLoginCodeSent(id, result: { status; provider; messageId?; error? }): Promise<void>;
countRecentEmailLoginCodes(emailNormalized, since): Promise<number>;
listActiveIdentityProviders(accountId): Promise<Array<"google" | "apple" | "email">>;
```
Widen `reserveAuthAttempt` eventType with `"email_code_request"`; `createOrLoadGoogleAccount` / `createOrLoadAppleAccount` throw `ACCOUNT_LINK_REQUIRED` when the verified email belongs to an `email`-provider identity on another account. Generalize `applyIdentityAccessDecision` to `{ subject, email, provider }` and run it for email identities. `testAccessService.ts:220` → `identity.provider IN ('google', 'email')`.
Service (`authService.ts`):
```ts
async startEmailLogin(email: string, context: LoginRequestContext): Promise<{ resendAvailableAt: Date }>;
async verifyEmailLogin(input: { email: string; code: string }, context: LoginRequestContext): Promise<LoginResult>;
async startEmailLink(session: AuthenticatedSession, email: string, context: LoginRequestContext): Promise<{ resendAvailableAt: Date }>;
async verifyEmailLink(session: AuthenticatedSession, input: { email; code }, context): Promise<void>;
async linkGoogleIdentity(session: AuthenticatedSession, credential: string, context): Promise<void>; // consumes credential like loginWithGoogle; requires email match
```
`verifyEmailLogin` order: `prepareLoginContext` → `enforceLoginLimits` → domain policy → `consumeEmailLoginCode` → `findAccountByEmailIdentity`; if absent `enforceNewAccountLimits` with email caps → `createOrLoadEmailAccount` → same lifecycle as `completeIdentityLogin` with `verifiedGoogleSubject = null`, provider `"email"`, events `email_login_success` / `email_login_failure` / `account_created {provider:"email"}`. Fix `countRecentDistinctAccounts` to include `apple_login_success` and `email_login_success`.
Sender (`auth/email/emailSender.ts`):
```ts
export interface EmailSender { send(message: { to: string; subject: string; text: string; html?: string; category: "login_code" }): Promise<{ provider: string; messageId: string | null }>; }
export function createEmailSender(config: AppConfig, logger: AppLogger, fetcher?: typeof fetch): EmailSender;
```
`LogEmailSender` logs `{ to, category, codeId }` (code only when `AUTH_EMAIL_DEV_LOG_CODES` and non-production); `ResendEmailSender` POSTs `{ from, to:[to], subject, text, html }` with Bearer, 10 s `AbortSignal.timeout`; non-2xx → `send_status='failed'` (start still returns 200). Send after the code row commits.
Routes (`authRoutes.ts`, shape of `/api/auth/google`; `assertOrigin`, `ensureDeviceCookie`, rate limit, bodyLimit 1024):
- `POST /api/auth/email/start` `{ email }` → `200 { ok: true, resendAvailableAt: number, codeTtlSeconds: number }`; 400 `EMAIL_INVALID` | `EMAIL_DOMAIN_NOT_ALLOWED`; 404 when disabled; 429 `TOO_MANY_LOGIN_ATTEMPTS` | `TOO_MANY_EMAIL_CODE_REQUESTS`.
- `POST /api/auth/email/verify` `{ email, code }` → sets cookies, returns `AuthSessionResponse`; 401 `EMAIL_CODE_INVALID`; 409 `ACCOUNT_LINK_REQUIRED`; 429; 403 `ACCOUNT_SUSPENDED`.
- `POST /api/auth/email/link/start`, `POST /api/auth/email/link/verify`, `POST /api/auth/google/link` `{ credential }`: session + CSRF; `{ ok: true }`; 409 `ACCOUNT_LINK_CONFLICT`.
- `GET /api/auth/session`: add `emailSignInEnabled: boolean` and, when authenticated, `linkedProviders`.
Other: `accountDeletionService.ts:384-403` treat `provider IN ('google','email')` like google and invalidate that email's active codes; cleanup deletes `email_login_codes` with `expires_at < now() - 7 days`; docs + `.env.example`.
Tests: `loginCodes.test.ts`, `emailDomainPolicy.test.ts`, `emailSender.test.ts` (injected fetch: success, non-2xx, timeout), `authService.email.test.ts` (happy path no dev capabilities; 5 wrong codes invalidate; expired; replay; identical start bodies; ACCOUNT_LINK_REQUIRED both directions; link allowed + conflict), migration text test, DB: email signup claims a test-access grant; deletion of email account passes constraint. Migration populated upgrade + empty second run on disposable `ash_atlas_stability*` DB.
Acceptance: with `AUTH_EMAIL_LOGIN_ENABLED=true`, `AUTH_EMAIL_SENDER=log`, `AUTH_EMAIL_DEV_LOG_CODES=true`, full sign-in via logged code works with curl; disabled by default; production with `sender=log` refused.

#### WP3 — Email sign-in and linking, client
Depends on WP2. Files: `authClient.ts` (`startEmailLogin`, `verifyEmailLogin`, `startEmailLink`, `verifyEmailLink`, `linkGoogle`; extend error codes), `authState.ts` (messages), `LoginScreen.tsx` (`emailSignInEnabled`, states `idle → email → code`, 6-digit input, resend timer, inline errors, back; no native scrollbars; prompt sizes to fit per build bible), `AuthGate.tsx` handlers, `PhoneHud.tsx` account section ("Link email", "Link Google" driven by `session.linkedProviders`), `App.tsx` wiring. Native login uses the web login in the system browser; verify `native_auth` return still completes after email login.
Tests: `LoginScreen.test.tsx`, `AuthGate.test.tsx`, `authClient.test.ts`. Check feature runtime at phone width.

#### WP4 — Location report ledger, speed buckets, shadow reject (migration + concurrency)
Migration `0881_location_reports.sql`. Pure `auth/trust/trustScore.ts`: `speedBucket(kmh)`, `effectiveDistanceM`, `cooldownMinutesForKm(km)` (D13), `regionCell(lat, lon)`, `locationReportScore(features) -> { score, signals }` with weights `speed_impossible` +4, `speed_air` +1, `relocation_far_repeat` +2 (each ≥100 km relocation beyond the third in 7 days), `region_familiar` −1 (0 until WP6), `accuracy_constant` 0 (log only).
Service `auth/trust/trustService.ts`:
```ts
export type LocationFixInput = { accountId; playerId; source: "relocation" | "passive"; requestId?; lat; lon; accuracyM?: number; clientPlatform?: "web"|"ios"|"android"; deviceInstallationId: string | null; networkHash: string | null; networkPrefixHash: string | null; deviceTimeZone?: string; avatarPosition: LatLon | null; now?: Date };
export type LocationFixEvaluation = { verdict: "accepted" | "shadow_rejected" | "rejected"; reason: string | null; distanceM: number | null; impliedKmh: number | null; bucket: SpeedBucket | null; holdUntil: Date | null; holdReason: "relocation_cooldown" | "transit" | null; score: number; features: Record<string, unknown> };
class LocationReportService {
  evaluate(input: LocationFixInput): Promise<LocationFixEvaluation>; // reads state; no writes
  record(input: LocationFixInput, evaluation: LocationFixEvaluation, outcome: "accepted" | "travel_failed"): Promise<{ reportId; seq }>; // one transaction
}
export interface TrustSignalSink { recordSignals(input: { accountId; reportId?: string; signals: Array<{ rule; weight; metadata? }> }): Promise<void>; } // no-op default; WP6 implements
```
`rejected` only when `TRUST_LOCATION_REJECT_MODE=enforce` and `speed_impossible`; `shadow_rejected` in shadow.
Hook `travelHandler.ts:508-662`: after the cooldown check call `evaluate`; `rejected` → failure result "Your device location could not be confirmed. Try again later.", record `travel_failed`; else travel, record `accepted` / `travel_failed`. Context additions: `locationReports`, `connectionNetwork` (via new `auth.networkTelemetryForRequest(ip)`), `clientPlatform`. Register in `application.ts`. Cleanup deletes `location_reports` older than retention.
Tests: `trustScore.test.ts`, `trustService.location.test.ts` (fake store), DB concurrency test (two concurrent records → distinct seq), migration text + populated/empty-second-run. Relocation still works in shadow mode (feature runtime).

#### WP5 — Land-action gate (cooldown + transit), shadow mode (protocol + concurrency)
Depends on WP4. Migration `0882_account_regions.sql` (the `account_regions` table from 2.1).
```ts
export type LandActionKind = "flag_place" | "flag_reinforce" | "flag_upgrade" | "flag_burn" | "flag_attack" | "city_found" | "city_convert" | "pvp_engage";
export type LandActionDecision = { allowed: true; shadowBlocked: boolean } | { allowed: false; code: "LAND_ACTION_SETTLING"; message: "Try again later."; retryAfterMs: number };
class LandActionGate {
  check(input: { accountId; playerId; action: LandActionKind; position: LatLon }): Promise<LandActionDecision>; // in-memory hold cache, hydrated from account_location_state, updated by LocationReportService.record
  recordLandAction(input: { accountId; playerId; action; position }): Promise<void>; // last_land_action_*; account_regions interaction day upsert
}
```
Shadow-blocked → signal `land_action_during_hold` +0.5, dedupe `hold:<accountId>:<holdUntil ms>`.
Hooks: `flagHandler.ts:63/135/158/192`, `settlementHandler.ts:232/1612`, `combatEquipmentHandler.ts:1242` (PvP only, before enqueue), `flagRoutes.ts:554` (HTTP 429). Blocked → `sendCombatError(socket, requestId, "LAND_ACTION_SETTLING", message, { retryable: true, retryAfterMs })`.
Protocol (careful lane): optional `landActionAvailableAt?: number | null` on `TRAVEL_INBOX_SNAPSHOT` and `TRAVEL_RESULT`. Client ignores it in this WP.
Tests: `landActionGate.test.ts` (off/shadow/enforce, expiry, retryAfterMs, hydration); one allowed + one denied in enforce via flagHandler; region day counting; parser fixture; connect/disconnect/reconnect check.

#### WP6 — Trust score, familiarity, priors, tiers (migration)
Depends on WP4, WP5. Migration `0883_account_trust_state.sql` (`account_trust_state`, `account_trust_events`).
Pure: `decayLogodds`, `staticPrior({ providers, createdAt, riskScore, now })`, `shadowTierFor(effective, trustTier, config)`, `trustTierPromotion(account, loginDays, effective)`.
Store: `applySignals` (FOR UPDATE, decay, add, insert events with dedupe, peak, shadow tier + change events), `recomputeLogodds`, `familiarCells`, `listTopAccounts`, `accountDetail`.
Service: implement `TrustSignalSink`; `isFamiliar` (3x3); feed `region_familiar` −1 and `relocation_unfamiliar` +0.5 into WP4 evaluation; login hook (Google/Apple/email) applies promotion. Production refuses `TRUST_QUARANTINE_MODE=enforce` without `TRUST_LADDER_ACK`.
Tests: pure math; DB (two signals, decay over a week, dedupe, recompute == incremental within 1e-9, familiarity after 10 days and staleness after 90); migration text + populated/empty-second-run.

#### WP7 — Admin top-risk view + bulk reversal CLI
Depends on WP6. Routes `developerTrustRoutes.ts` (capability `developer:test-access-manage`): `GET /api/dev/trust/accounts?limit=50&minLogodds=0`, `GET /api/dev/trust/accounts/:id` (types in `packages/shared/src/trust.ts`). Client `TrustAdminScreen.tsx` modeled on `TestAccessAdminScreen.tsx`. CLI `trustReversalCli.ts` (`trust:reverse`; `--rule|--all-rules`, `--since`, `--until`, `--reason`, `--apply`; dry run default; idempotent).
Tests: route allowed/denied; CLI DB reverse + re-run zero changes.

#### WP8 (optional) — Passive fix + device timezone (protocol, careful lane)
Depends on WP4. Optional `deviceTimeZone` on relocation message; new `LOCATION_FIX` message (all protocol touchpoints, not in dungeon world-only list); client `getPassiveDeviceLocation()` only when permission already granted, one send ≤60 s after HELLO when `trustPassiveFixEnabled`; server rate 1/60 s per connection, source `passive`, never sets holds. **Extended:** periodic foreground fixes at a random interval, uniform in [`TRUST_PASSIVE_FIX_MIN_SECONDS`, `TRUST_PASSIVE_FIX_MAX_SECONDS`] (default 180–420 s) re-rolled after every fix so players cannot predict the next check; no location check on land actions (a pre-action fix was tried and removed); optional `reason` (`periodic`; legacy `pre_action` still accepted and treated like periodic); server rate window for all reasons ≥ max(55 s, min−5 s); passive pairs feed speed buckets (noise guard: <20 s apart logs car/rail/air/impossible as features only) and may set transit holds only; redundant passive fixes (≤50 m effective, <15 min from the last stored fix, no signals) update `account_location_state` without a row; passive rows kept 30 days; `region_familiar` credits relocations only.

### Later waves (design only)
- **WP9 Corroboration**: tz→country, GeoLite2 country/ASN, `ip_country_mismatch` +3, `tz_country_mismatch` +2.5, hosting/Tor +3; never store raw IPs.
- **WP10 Attestation**: Play Integrity (`PLAY_RECOGNIZED` + `MEETS_DEVICE_INTEGRITY`) and App Attest, bound to land actions.
- **WP11 Native location plugin**: `isMock`, satellites, iOS `sourceInformation`, pedometer.
- **WP12 Ladder go-live**: tiers 3-4 enforce, restricted semantics, player reporting, HUD indicator, fairness policy, privacy labels.

## 4. Enforcement mode flags (all default shadow)

| Mechanism | Flag | off | shadow | enforce |
|---|---|---|---|---|
| Impossible-speed relocation reject | `TRUST_LOCATION_REJECT_MODE` | log row only | `shadow_rejected`, signal | relocation refused |
| Land-action hold | `TRUST_LAND_ACTION_MODE` | no checks | signal | `LAND_ACTION_SETTLING` |
| Quarantine / warning tiers | `TRUST_QUARANTINE_MODE` | no tiers | `shadow_tier` only | wave 3 |
| Tier ceiling | `TRUST_LADDER_MAX_TIER` | — | — | default 2 |
| Email sign-in | `AUTH_EMAIL_LOGIN_ENABLED` | hidden | — | visible |
| Passive fix | `TRUST_PASSIVE_FIX_ENABLED` | client never sends | — | — |

## 5. Rollout and verification
1. Each WP: focused tests, typecheck touched packages, `git diff --check`, commit `feat(auth): ...` / `feat(trust): ...`, push.
2. Migrations (WP2, WP4, WP5, WP6) and protocol (WP5, WP8) go through the careful lane.
3. Deploy wave 1 with every trust flag `shadow`, `AUTH_EMAIL_LOGIN_ENABLED=false`. Enable email only after Resend DNS verifies and a real code arrives.
4. Calibrate after ≥30 days; first enforce candidate is `TRUST_LAND_ACTION_MODE`. Dry-run `trust:reverse` before any enforce flip.

## 6. Non-goals
No continuous GPS tracking; no change to the 24 h relocation cooldown or flag/city travel; no automatic rollback; no native plugin / attestation / MaxMind / ocean layers / cell lookups in wave 1; no MX checks, passwords, or magic links; no new developer capability; no `ios/`, `android/`, `fastlane/`, release tooling changes; no retroactive scoring.

## 7. Alt doorway protections

Threat: cheap alt accounts spoof GPS, relocate next to an enemy kingdom or a rare spot, then bring main accounts there with Travel Invites or Party Travel, and the mains raid right away. Principle: **moving yourself is free; bringing others is earned.** Every mechanism has an `off|shadow|enforce` mode, default **enforce**; shadow records the trust signal and allows. Code: `apps/server/src/auth/trust/altDoorway.ts` (`AltDoorwayGate`), store `PostgresAltDoorwayStore` in `trustStore.ts`, migration `0884_alt_doorway.sql`.

| # | Mechanism | Mode | Rule | Refusal code |
|---|---|---|---|---|
| 1 | Home + confirmed days | (data) | `account_location_state.home_lat/home_lon/home_set_at/home_source` set from the first accepted fix (passive or relocation); a passive-derived home is replaced once by the first accepted GPS relocation, so players who never relocate still earn days. A UTC day is confirmed (`confirmed_days`, `last_confirmed_day`) when a passive fix (stored or redundant) lands within `TRUST_PRESENCE_RADIUS_KM` (25) of home. `home_confirmed_at` is set when `confirmed_days` reaches `TRUST_DOORWAY_CONFIRMED_DAYS` (3). Migration 0884 grandfathers every non-deleted account created more than 14 days before it ran (`home_confirmed_at = now()`). | — |
| 2 | Doorway eligibility | `TRUST_DOORWAY_MODE` | Sending a Travel Invite, and Party Travel (manual or auto-follow) to a leader, need the inviter/leader account to be ≥ `TRUST_DOORWAY_MIN_ACCOUNT_AGE_DAYS` (14) old and doorway-confirmed (`home_confirmed_at` set or `confirmed_days` ≥ target). Dev profiles (`ash-atlas-dev:*` subjects) are exempt while developer login is enabled. | `TRAVEL_DOORWAY_UNCONFIRMED` |
| 3 | Presence proof | `TRUST_DOORWAY_MODE` | The inviter/leader's last fix (`last_fix_*`, relocation or passive) is ≤ `TRUST_PRESENCE_MAX_FIX_AGE_SECONDS` (600) old and within `TRUST_PRESENCE_RADIUS_KM` of their current avatar. Exempt when the destination is their own flag, a flag of their city or kingdom, their kingdom's seat, or their own manor. | `TRAVEL_DOORWAY_NO_PRESENCE` |
| 4 | Party relocation shortcut | always on (bug fix) | Party Travel (manual and auto-follow) to a leader whose `players.last_relocated_at` is within `TRAVEL_INVITE_AFTER_RELOCATION_COOLDOWN_MS` (1 h) is refused, matching the invite cooldown. Auto-follow after a leader's GPS relocation is therefore refused. | `PARTY_TRAVEL_RELOCATION_COOLDOWN` |
| 5 | Arrival raid wait | `TRUST_ARRIVAL_RAID_MODE` | After travel of kind `invite`, `party_manual`, or `party_auto_follow` commits (`applyAuthoritativeTravelPhase1`), the arriving player cannot `START_FLAG_BURN` or `ATTACK_FLAG` (the client's after-approach variants send the same messages) on flags they do not own for `TRUST_ARRIVAL_RAID_HOLD_MINUTES` (60). Persisted in `account_location_state.arrival_raid_hold_until` (never shortened) with a 30 s in-process cache. PvP is not affected. Manor entries do not set the hold. | `ARRIVAL_RAID_HOLD` (`retryAfterMs`) |
| 6 | Linked alts | `TRUST_LINKED_ALT_MODE` | Inviter/leader versus invitee/member: a shared device installation (`account_device_links`, any time) is refused in enforce; a shared `network_prefix_hash` in `auth_events` over the last 30 days only records `linked_network` (families, roommates), never blocks. | `TRAVEL_LINKED_ACCOUNT` |

Trust signals (via `TrustSignalSink`, shown on the Account Trust admin detail with the other events): `doorway_unconfirmed` 0.25 (dedupe per account per UTC day), `doorway_no_presence` 0.5 (per account per UTC hour), `linked_device` 1.5 and `linked_network` 0.25 (recorded on both accounts, per pair per UTC day), `arrival_raid_blocked` 0.25 (per hold). Every refusal and every shadow pass records its signal.

Order of checks for a send/travel: relocation shortcut (party only) → eligibility → presence → linked alts. Invites are checked at send time, only for new sends (`TravelInviteService.send` `beforeCreate`, after the operation replay check), so a replayed request returns the original invite; acceptance still requires the inviter to stay in the same gameplay layer. Refusals reach the client as `ERROR` frames (invite, manual party travel, flag raids) or failed `TRAVEL_RESULT` frames (auto-follow) with readable messages; no protocol fields changed.
