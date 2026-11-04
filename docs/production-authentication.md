# Production Authentication Setup

Ash Atlas uses server-verified provider identities and its own server-side session. The current
release candidate has one enabled login method: any Google account whose `email_verified` claim is
true (Gmail, Workspace, school, or other domains). `AUTH_REQUIRE_GMAIL=true` optionally restricts it
to exact `gmail.com` addresses. The source also contains a server-owned Sign in with Apple flow,
but it remains fail-closed behind `APPLE_SIGN_IN_ENABLED=false` until the owner completes the
portal, runtime-secret, callback, and real-device checks in the store documents. Provider subjects,
not email addresses, are the permanent external identities.

The game requests only OpenID identity (`openid`, `email`, and `profile`). It does not request Gmail,
contacts, Drive, Calendar, Google access tokens, or Google refresh tokens. The browser sends the
short-lived GIS ID-token credential directly to the Ash Atlas server and never saves it. The server
verifies the signature, issuer, audience, expiry, subject, email, and `email_verified` claim with
`google-auth-library`.

When Apple is enabled, the server uses the exact HTTPS callback derived from `APP_PUBLIC_ORIGIN`
(`/api/auth/apple/callback`), `response_type=code`, `scope=email`, and `response_mode=form_post`.
State and nonce are independent, hashed, short-lived, single-use database transactions; the
callback does not require the initiating `SameSite=Lax` device cookie or network hash to survive
Apple's cross-site `form_post`. It instead claims the 256-bit state transaction once, exchanges the
code with a bounded ES256 client secret, and verifies Apple JWKS, issuer, audience, expiry, issuance
time, nonce, subject, and claim types. Link transactions retain the initiating account and session
binding. Apple identities never auto-link by email. An email conflict directs the player to
Google-first explicit Account → Link Apple.
The signed notification endpoint accepts Apple’s JWS payload and processes the `events` types
`email-enabled`, `email-disabled`, `consent-revoked`, and `account-deleted`; forwarding state is
informational, consent revokes Apple sessions, and account deletion suspends the account and
queues the existing deletion workflow.

## Google Cloud OAuth client

1. In the Google Cloud console, configure the OAuth consent screen for the production project.
2. Create an OAuth client with application type **Web application**.
3. Add exact authorized JavaScript origins. Typical values are:

   ```text
   http://127.0.0.1:5173
   https://game.example.com
   ```

4. Do not add pathnames or wildcards to an origin.
5. Put the public client ID in both `GOOGLE_CLIENT_ID` (server verification audience) and
   `VITE_GOOGLE_CLIENT_ID` (GIS button initialization).

The basic GIS ID-token flow does not use a Google client secret. Do not create or deploy a client
secret for this flow, and never put a secret in a `VITE_` variable.

## Required production environment

Generate all five purpose-specific HMAC keys independently with at least 256 bits of
cryptographically secure random material. Values below are placeholders only.

```text
NODE_ENV=production
AUTH_RUNTIME_MODE=public
AUTH_MODE=google
GOOGLE_CLIENT_ID=<public OAuth web client id>
VITE_GOOGLE_CLIENT_ID=<same public OAuth web client id>

APP_PUBLIC_ORIGIN=https://game.example.com
AUTH_ALLOWED_ORIGINS=https://game.example.com
AUTH_TRUST_PROXY=127.0.0.1,::1

# Keep Apple disabled until the owner completes the documented portal and real-device hold point.
APPLE_SIGN_IN_ENABLED=false
# If enabled, supply these through the runtime secret manager only:
# APPLE_TEAM_ID=<Apple team id>
# APPLE_SERVICES_ID=<Apple Services ID>
# APPLE_KEY_ID=<Apple private-key id>
# APPLE_PRIVATE_KEY_P8_BASE64=<base64 encoded P8 key>
# APPLE_REFRESH_TOKEN_KEY_ID=v1
# APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64=<base64 encoded 32-byte key>

AUTH_SESSION_TOKEN_HMAC_KEY=<independent random secret>
AUTH_DEVICE_TOKEN_HMAC_KEY=<independent random secret>
AUTH_NETWORK_HMAC_KEY=<independent random secret>
AUTH_NETWORK_HMAC_KEY_VERSION=v1
INITIAL_SPAWN_HMAC_KEY=<independent random secret>
DOG_GENETICS_HMAC_KEY=<independent random secret>

AUTH_SESSION_ABSOLUTE_DAYS=30
AUTH_SESSION_INACTIVITY_DAYS=14
AUTH_REQUIRE_GMAIL=false
DEV_TOOLS_ENABLED=false
DEV_ADMIN_TOOLS_ENABLED=false
DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED=false
DEV_AUTHORIZED_GOOGLE_SUBJECTS=
DEV_PRIVATE_LEADERBOARD_GOOGLE_SUBJECTS=
ALLOW_UNRESOLVED_FLAGS_IN_DEV=false
```

Production startup fails for development auth, a non-public authentication runtime mode,
unresolved-development flag behavior,
missing Google client ID, missing/reused development keys, wildcard or
non-HTTPS origins, invalid session lifetimes, or a missing/broad reverse-proxy trust list.
Configuring production owner mutation capabilities also requires the active release
`RUNTIME_SHA`. Enabling production economy mutation additionally fails startup unless the runtime
is production/public, uses Google authentication with development login disabled, enables both
developer tool gates, and has at least one exact authorized Google subject.
Session and device cookies are always `HttpOnly`, `Secure`, `SameSite=Lax`, host-only, and scoped to
`Path=/` in production. The production names are `__Host-aa_session` and `__Host-aa_device`.

The application frontend and API may use separate origins only when they remain on the same
schemeful site (for example, HTTPS subdomains of the same registrable domain), because production
cookies intentionally use `SameSite=Lax`. Both must use HTTPS, the frontend origin must be listed
exactly in `AUTH_ALLOWED_ORIGINS`, API CORS must allow credentials, and browser requests must retain
`credentials: include`. Unrelated cross-site frontend/API domains require a different cookie and
CSRF design and are not supported by this foundation.

## Security headers and Google scripts

The API installs explicit security headers and allows the minimum GIS origins it needs.
The frontend hosting layer must also apply a Content Security Policy compatible with:

```text
script-src 'self' https://accounts.google.com/gsi/client https://static.cloudflareinsights.com
script-src-attr 'none'
frame-src https://accounts.google.com/gsi/
frame-ancestors 'none'
connect-src 'self' <game-api-origin> https://accounts.google.com/gsi/ https://cloudflareinsights.com
style-src 'self' https://accounts.google.com/gsi/style
style-src-attr 'unsafe-inline'
object-src 'none'
base-uri 'self'
form-action 'self'
```

`style-src-attr 'unsafe-inline'` is limited to style attributes because MapLibre and the game overlay
position interactive DOM elements with inline coordinates; inline scripts and `unsafe-eval` remain
forbidden. Also use `Cross-Origin-Opener-Policy: same-origin-allow-popups` so the normal GIS popup can complete.
Add the configured World API and map tile origins to `connect-src`/`img-src` as required. The
Cloudflare sources above narrowly permit its injected Web Analytics beacon. Do not use
wildcard `script-src`, `frame-src`, or `connect-src` policies.

## Account and session behavior

- A unique `(provider, provider_subject)` constraint makes one provider identity resolve to one Ash
  Atlas account, including concurrent first-login races. Google-only `verifiedGoogleSubject`
  capability lookup remains separate from Apple account identity. Apple email relay and forwarding
  state are informational provider metadata; they never auto-link accounts.
- A unique player `account_id` gives each account at most one durable player.
- First Google login asks for a public 3-20 character player name. Google profile name and email are
  not exposed as the public game name.
- Only session-token HMACs are stored. Raw session and device tokens exist only in HttpOnly cookies.
- A purpose-separated HMAC of each accepted Google credential is retained only until that credential
  expires so an exact credential replay cannot mint another session. The raw Google credential is
  never stored. Apple authorization codes, ID/access tokens, state, nonce, and private key material
  are never persisted or logged; a refresh token is retained only when Apple issues one, encrypted
  with versioned AES-256-GCM runtime key material for revocation/disconnect/deletion.
- Sessions expire after 30 days absolutely or 14 days of inactivity. `last_seen_at` writes are
  throttled to once per five minutes.
- Logout-all increments an account session version while holding the account row lock. Session
  creation reads that version under the same lock, which gives concurrent login/logout-all a clear
  order. Suspending or deleting an account increments the version and revokes its active sessions.
- State-changing HTTP requests require an allowed `Origin` and the session-derived CSRF header.
- Gameplay WebSockets authenticate the same cookie during upgrade. The client sends an identity-free
  `HELLO`; account and player IDs come from the server session.
- The newest gameplay WebSocket for an account replaces the old connection. This is intentionally
  isolated in the connection registry for a future distributed lease implementation.
- Suspended accounts receive a neutral account-suspended result and cannot log in or open a socket.
  Deleted accounts are unavailable. Neither status exposes risk evidence to the client.

## Development authentication

For local work, use:

```text
NODE_ENV=development
AUTH_RUNTIME_MODE=local
AUTH_MODE=dev
AUTH_DEV_LOGIN_ENABLED=true
APP_PUBLIC_ORIGIN=http://127.0.0.1:5173
AUTH_ALLOWED_ORIGINS=http://127.0.0.1:5173
AUTH_DEV_ACCOUNT_EMAIL=developer@example.com
AUTH_DEV_PLAYER_NAME=Developer
```

The main `Run Ash Atlas.cmd` launcher supplies these values to its child processes.
The server reports whether development auth is enabled, and only then does the client show four
clearly labeled local account buttons:

| Button | Profile key sent by the client | Server-owned identity subject | Player name |
| --- | --- | --- | --- |
| Default Dev | `default` | `ash-atlas-dev:<AUTH_DEV_ACCOUNT_EMAIL>` | `AUTH_DEV_PLAYER_NAME` (`Developer` by default) |
| Dev Player 2 | `player2` | `ash-atlas-dev:player2` | `DevPlayer2` |
| Dev Player 3 | `player3` | `ash-atlas-dev:player3` | `DevPlayer3` |
| Dev Player 4 | `player4` | `ash-atlas-dev:player4` | `DevPlayer4` |

The `default` subject deliberately matches the original single developer account, preserving its
player and inventory. The client can submit only a profile key. A strict request schema rejects
extra player IDs, account IDs, emails, or usernames, and the server maps the allowlisted key to all
identity metadata. Each login creates or loads the account and player idempotently, issues a normal
database-backed session, and exercises the authenticated WebSocket path. No seed is needed.

Activation requires all of the following: the explicit flag, `AUTH_RUNTIME_MODE=local` or `private`,
`NODE_ENV=development`, `AUTH_MODE=dev`, and loopback/private-LAN application and allowed origins.
Configuration parsing rejects the flag in public mode, tests, staging-like Google mode, public
origins, and production. The route is registered only after all safeguards pass. Production also
independently requires `AUTH_RUNTIME_MODE=public`, Google mode, HTTPS origins, and
non-development secrets, so there is no hidden fake-login bypass.

Local test sequence:

```powershell
.\tools\dev\run-main.ps1
```

Open `http://127.0.0.1:5173` in four separate browsers or browser profiles and choose a different
button in each. Chrome, Edge, Firefox, and a private window work, as do four named Chromium profiles.
Do not use four ordinary tabs in one profile because they share the session cookie. Refresh each
profile to verify its own session persistence, then sign out of one and confirm the other three stay
authenticated.

## Owner-only developer capabilities

Developer authority comes only from the authenticated session's verified Google provider subject.
Set `DEV_AUTHORIZED_GOOGLE_SUBJECTS` to a comma-separated list of exact Google `sub` values on the
server. Do not commit those values. Empty or missing configuration grants nobody; duplicates,
empty entries, whitespace inside a subject, control characters, and oversized values fail
configuration parsing.

Set `DEV_PRIVATE_LEADERBOARD_GOOGLE_SUBJECTS` to the exact subset of those developer subjects that
may read owner-only leaderboard metrics. It defaults to empty and does not enable general
developer access by itself.

`DEV_TOOLS_ENABLED` is the global server switch. An allowlisted subject receives
`developer:observe`; `DEV_ADMIN_TOOLS_ENABLED=true` also grants `developer:world-mutate` and
`developer:assets-grant`. Material-only grants require `developer:assets-grant`. Gold grants,
mixed market test-kit grants, and direct progression/subclass controls require
`developer:economy-mutate`.

Local/private development-login behavior grants `developer:economy-mutate` exactly as before.
Production grants it only when `DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED=true` and every safe
production boundary is active: `NODE_ENV=production`, `AUTH_RUNTIME_MODE=public`,
`AUTH_MODE=google`, `AUTH_DEV_LOGIN_ENABLED=false`, `DEV_TOOLS_ENABLED=true`,
`DEV_ADMIN_TOOLS_ENABLED=true`, at least one exact verified provider subject in
`DEV_AUTHORIZED_GOOGLE_SUBJECTS`, and a valid active `RUNTIME_SHA`. The new switch defaults to
false. Do not put a real provider subject in tracked files.

HTTP routes and WebSocket commands recalculate authorization for every operation. The server sends
the resulting capability list in the authenticated session/WELCOME payload, and the client uses
that list only to decide which developer UI to render. Client fields, local storage, visible menus,
emails, usernames, character names, URL parameters, and client-supplied account IDs never grant
authority.

Accepted and rejected developer commands use `auth_events`. Entries identify the authenticated
account, capability, command, transport, target, operation key when applicable, outcome, timestamp,
and active runtime SHA when configured. Production economy mutation cannot start without that SHA,
so every production mutation audit includes it. Mutation result entries record success/failure.
Credentials, session tokens, CSRF tokens, and allowlisted subjects are not written to command
metadata.

Economy grants retain the existing wallet/inventory transaction, ledger, and operation-key
idempotency safeguards. Production access is limited to explicitly allowlisted owner sessions
behind the additional fail-closed switch; ordinary public accounts receive no developer
capabilities.

## Gmail enforcement

After Google verifies the ID token, Ash Atlas trims and lowercases the email and requires
`email_verified=true`. By default (`AUTH_REQUIRE_GMAIL=false`) any verified Google account is
accepted, including Workspace and school domains; there is no Google domain blocklist. Setting
`AUTH_REQUIRE_GMAIL=true` restores the exact-Gmail policy in `AuthService`: exactly one `@` with
domain `gmail.com`, so `googlemail.com`, Workspace/school domains, and suffix tricks such as
`gmail.com.example.com` are rejected with `VERIFIED_GMAIL_REQUIRED`. Dot removal and plus-tag
rewriting are intentionally not done; the verified Google `sub` remains the identity even if the
account email changes.

## Email one-time-code sign-in

Email sign-in ships disabled (`AUTH_EMAIL_LOGIN_ENABLED=false`); the login screen only offers it
when `GET /api/auth/session` reports `emailSignInEnabled: true`.

- `POST /api/auth/email/start` `{ email }` returns the same `200 { ok, resendAvailableAt,
  codeTtlSeconds }` body whether or not the address already has an account. Invalid syntax returns
  400 `EMAIL_INVALID`; a blocked domain returns 400 `EMAIL_DOMAIN_NOT_ALLOWED`; throttling returns
  429 `TOO_MANY_LOGIN_ATTEMPTS` (device/network) or `TOO_MANY_EMAIL_CODE_REQUESTS` (per email:
  one per `AUTH_EMAIL_CODE_RESEND_SECONDS`, `AUTH_EMAIL_CODE_PER_EMAIL_10MIN` per 10 minutes,
  `AUTH_EMAIL_CODE_PER_EMAIL_DAY` per day).
- `POST /api/auth/email/verify` `{ email, code }` sets the session cookies and returns the session
  response. Wrong, expired, consumed, superseded, and over-attempt codes all return 401
  `EMAIL_CODE_INVALID`.
- Codes are 6 digits from `crypto.randomInt`, valid for `AUTH_EMAIL_CODE_TTL_SECONDS` (600), single
  use, and invalidated after 5 wrong attempts. A new request supersedes earlier codes for the same
  canonical mailbox. Only `HMAC-SHA256(AUTH_EMAIL_CODE_HMAC_KEY, "email-code:" + canonical + ":" + code)` is stored
  (`email_login_codes`); expired rows are deleted 7 days after expiry by the daily cleanup.
- Canonical mailbox: lowercase, `+tag` stripped for every domain, and for `gmail.com` /
  `googlemail.com` dots removed with `googlemail.com` mapped to `gmail.com` (Outlook and other
  providers keep their dots). `canonicalEmail()` in `apps/server/src/auth/email/emailDomainPolicy.ts`
  and the SQL function `auth_canonical_email()` (migration 0880) must stay identical.
- The identity is `provider = 'email'`, `provider_subject = <canonical mailbox>`; `email` /
  `email_normalized` keep the address as typed (trimmed, lowercased), which is also where codes are
  sent. So `player+alt@gmail.com` or `p.layer@googlemail.com` after `player@gmail.com` signs in to the
  same account instead of creating a new one. Codes, per-email limits, and new-account checks use
  the canonical mailbox. Email accounts never receive developer capabilities (those key off a
  verified Google subject only).
- `account_identities.email_canonical` is a generated column (`auth_canonical_email(email_normalized)`)
  for every provider, with a partial index on verified rows. Cross-provider checks compare
  canonical to canonical, and one `email-canonical:<mailbox>` advisory lock serializes Google,
  Apple, email, and test-access preapproval writes for a mailbox. Test-access grants match email
  identities by canonical mailbox (Google grant matching stays exact).
- Never auto-merge: an email sign-in whose canonical mailbox is already verified on another account,
  or a new Google/Apple sign-in whose canonical mailbox belongs to an email-code account, returns 409
  `ACCOUNT_LINK_REQUIRED`. Signed-in players link explicitly with
  `POST /api/auth/email/link/start` + `/api/auth/email/link/verify`, or
  `POST /api/auth/google/link` `{ credential }` (the Google email's canonical mailbox must already
  be verified on the account). Conflicts return 409 `ACCOUNT_LINK_CONFLICT`.
- Domain policy: `AUTH_EMAIL_DOMAIN_POLICY=allowlist` (default) accepts only exact matches of the
  built-in mainstream list (Gmail/Googlemail; Outlook, Hotmail, Live, MSN and their common country
  domains; Yahoo, Ymail, Rocketmail and country domains; iCloud, me.com, mac.com; AOL; GMX) plus
  `AUTH_EMAIL_DOMAIN_ALLOWLIST`, which adds domains without a code change. Relays, disposables,
  Proton/Tuta, custom domains, and subdomains are rejected with 400 `EMAIL_DOMAIN_NOT_ALLOWED`
  ("Email sign-in supports Gmail, Outlook/Hotmail, Yahoo, iCloud, AOL and GMX. You can also continue
  with Google or Apple."). `blocklist` remains available: it rejects bundled disposable and relay
  domains (and their subdomains) plus `AUTH_EMAIL_DOMAIN_BLOCKLIST_EXTRA`. There are no MX lookups.
- New email accounts use tighter creation caps: `AUTH_NEW_ACCOUNT_EMAIL_DEVICE_MAX=2` and
  `AUTH_NEW_ACCOUNT_EMAIL_NETWORK_MAX=3` per 24 hours.
- Delivery: `AUTH_EMAIL_SENDER=resend` posts to `https://api.resend.com/emails` with a 10 second
  timeout; a failed send is recorded on the code row and the start request still returns 200.
  `AUTH_EMAIL_SENDER=log` only logs that a code was issued; with `AUTH_EMAIL_DEV_LOG_CODES=true`
  outside production it also logs the code for local testing. Production refuses enabled email
  sign-in with the log sender, a missing Resend key, the default `AUTH_EMAIL_FROM`, or a
  development/reused `AUTH_EMAIL_CODE_HMAC_KEY`.

## Device and network privacy

The device cookie is random installation-local material, not a hardware fingerprint. The database
stores its HMAC plus broad browser and OS families derived from the ordinary User-Agent. Ash Atlas
does not collect hardware serials, MAC addresses, canvas/audio/WebGL fingerprints, fonts, plugins,
battery data, or cross-site identifiers.

Raw IP addresses are not stored in long-term auth telemetry. The server normalizes the request IP and
stores versioned HMACs for the full address and its IPv4 `/24` or IPv6 `/56` prefix. Shared devices and
network bursts create advisory evidence. They never automatically suspend or ban an account.

The scheduled cleanup and the manual command retain expired/revoked sessions and ordinary auth/network
telemetry for approximately 90 days:

```powershell
pnpm auth:cleanup
```

Consumed Google credential HMAC records are removed after their credential expiration rather than
using the 90-day telemetry window.

Risk/security evidence is retained separately for later review. Revisit retention with legal/privacy
requirements before launch.

## Reverse proxy topology

The Node server binds to loopback. Put Caddy or another reverse proxy on the public interface, have
it connect to `127.0.0.1:3001`, and set `AUTH_TRUST_PROXY` to only the addresses from which that proxy
actually connects (normally `127.0.0.1,::1` for a same-host proxy). The proxy must replace, rather
than preserve as authoritative, forwarding headers received from the public client. Never configure
`0.0.0.0/0`, `::/0`, a wildcard, or Fastify's trust-all mode. Fastify then ignores attacker-supplied
leftmost `X-Forwarded-For` values and uses the first untrusted address nearest the known proxy for
rate limiting and privacy-preserving network telemetry.

The free launch build intentionally has no reCAPTCHA Enterprise or paid Account Defense client.
Local device/network evidence remains advisory and cannot automatically suspend an account.

## Migration and rollback notes

Migration `0010_google_accounts.sql` is additive. Existing gameplay players retain a nullable
`account_id`; production authentication only loads players through a non-null account association,
so it never adopts an unowned legacy row. Identity, session, device-link, and player ownership
foreign keys use restrictive or nulling delete behavior intentionally and do not cascade-delete
gameplay players, flags, or inventory. Migration `0011_auth_security_hardening.sql` adds session
versioning, bounded telemetry constraints, and short-lived credential-use HMAC records.

There is no destructive automatic down migration. Roll application code back while leaving these
tables and nullable columns in place. Take a database backup and verify no newer runtime depends on
the data before considering a manual schema removal.

## Key rotation

The current implementation uses one active key per purpose; it does not support a dual-key grace
period.

1. Back up the database and confirm access to the previous application release and secrets.
2. Revoke sessions or schedule a maintenance window before rotating the session key. A new session
   key intentionally signs everyone out.
3. Rotating the device key makes existing device cookies appear new; communicate the telemetry break
   before doing so.
4. Rotate the network key with a new `AUTH_NETWORK_HMAC_KEY_VERSION`. Historical hashes remain
   unlinkable to the new version by design.
5. Deploy all instances with the same new keys atomically, then verify login/session/WebSocket health.

Never reuse one key for multiple purposes and never commit current or previous keys.

## Deployment recovery

If authentication breaks after a release, do not enable `AUTH_MODE=dev` or weaken Origin/CSRF/cookie
checks in production. Instead:

1. Stop new traffic or put the site in maintenance mode.
2. Check `/health`, `/ready`, startup configuration errors, Google OAuth authorized origins, clock
   synchronization, and secret availability.
3. Restore the last known-good application image and its matching secrets. Migrations `0010` and
   `0011` are additive, so the prior runtime can remain deployed while the auth release is repaired.
4. If an HMAC key was lost, rotate it deliberately and accept the resulting session/device reset;
   never substitute a public/default value.
5. Re-run migration and automated auth checks in staging, then redeploy normally.

No administrative suspension endpoint or browser bypass is exposed by this release. Account status
changes remain an operational database/admin concern until a separately authenticated admin service
is designed.
