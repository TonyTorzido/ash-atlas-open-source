# Ash Atlas iOS development

Ash Atlas uses Capacitor to package the existing React/Vite client as an iOS application. The
native project under `ios/` is persistent source. Do not delete and regenerate it as a routine
upgrade strategy.

## Pinned toolchain and packages

The initial project was created and compiled on:

- macOS 26.5.2 (arm64, Apple M1 Pro)
- Node.js 24.19.0 and pnpm 11.10.0
- Xcode 26.6 (build 17F113), Swift 6.3.3, iOS 26.5 SDK/runtime
- Xcode Command Line Tools 26.5

The repository requires Node `>=24 <25` and pnpm `11.10.0`. Capacitor packages are pinned:

- `@capacitor/core`, `@capacitor/cli`, and `@capacitor/ios`: 8.5.0
- `@capacitor/app`: 8.1.1
- `@capacitor/browser`: 8.0.4
- `@capacitor/geolocation`: 8.2.2

All Capacitor packages and plugins must remain on major version 8 until a deliberate toolchain
compatibility audit approves a major upgrade.

## Build and sync

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm ios:sync
pnpm ios:open
```

`pnpm ios:sync` verifies the appearance catalog, creates the native seed build (code plus boot
icons; the app downloads the rest of the game on first launch, see
`docs/architecture/IN_APP_UPDATES_PLAN.md`), copies it into the Xcode project, and synchronizes
native plugins. For a device build that carries all art, run
`pnpm --filter @ash-atlas/client build:native:full` and then `npx cap sync ios`. Run it after any client, native plugin, or
Capacitor configuration change. The source web bundle is generated under `apps/client/dist`; the
copy under `ios/App/App/public` is intentionally ignored because it is reproducible.

The app uses bundle identifier `com.ashatlas.game`, display name `Ash Atlas`, marketing version
`1.0.0`, build `1`, and minimum iOS 15. The URL scheme `com.ashatlas.game` is registered for the
authentication callback. No `armv7` device capability is required.

The local Sign in with Apple web-button artwork at
`apps/client/public/brand/sign-in-with-apple-continue-white@3x.png` was downloaded on 2026-09-15
from Apple's documented button endpoint with the exact parameters
`height=44&width=320&color=white&border=true&type=continue&border_radius=6&scale=3&locale=en_US`.
It is a 960×132 RGBA PNG displayed at 320×44 CSS pixels; SHA-256 is
`bef40247c7970f3accaa9ba2e0f155137ff68b2abcfb7af6bcc20fd4c72162af`. The asset is bundled
locally so sign-in has no runtime dependency on Apple's image endpoint.

## Networking and authentication

The website remains same-origin. The native build uses the central values in
`apps/client/.env.capacitor`:

- HTTP API and world data: `https://playashatlas.com`
- realtime: `wss://playashatlas.com`

Capacitor retains its normal `localhost` hostname and secure local scheme. There are no App
Transport Security exceptions and no global cleartext allowances.

In the native app only, Pixi loads textures through WebView image elements instead of worker-backed
`fetch()`/`createImageBitmap()` and does not apply an anonymous cross-origin attribute to those
elements. A native loader guard also waits for WKWebView image decoding when it reports an image as
complete before its dimensions settle, then updates the Pixi texture source to the decoded size.
Pixi's native resolver also pins both its base and root to `capacitor://localhost/`, ensuring a
root-relative path such as `/assets/tree.png` keeps the required `localhost` host. These safeguards
keep packaged sprite URLs loadable; the website and PWA retain Pixi's normal resolver, preferences,
and loader.

Google authentication stays in the production website's first-party browser context. The native
app first verifies the server's iOS authorization protocol, creates a PKCE verifier, and opens the
authorization endpoint in a full-screen secure browser. An unauthenticated browser is sent through
the provider-neutral website login; an authenticated browser returns directly to the app with a
single-use code at `com.ashatlas.game://auth/callback`. The app exchanges that code for a separate
native cookie session. Native WebSockets use an opaque server-issued ticket in the WebSocket
subprotocol; raw session cookies are never exposed to application JavaScript. The compatibility
check keeps an older server from accidentally leaving the web game open inside the sign-in browser.
The server-owned Apple path remains disabled in the current release candidate until the owner
configures the Services ID/key/HTTPS callback and completes the real-device Apple-only, linked,
disconnect, notification, and deletion-revocation tests; no native Apple SDK or second callback
pipeline is used.

The matching client and server changes must be released to `playashatlas.com` before end-to-end
native sign-in can succeed. An unreleased server can still serve the initial anonymous session and
the installed app can be inspected, but the new authorization endpoints will not exist yet.

## Install on an iPhone

1. Open the project with `pnpm ios:open`.
2. In the project navigator, select **App**, then the **App** target, then **Signing & Capabilities**.
3. Keep **Automatically manage signing** enabled and select your Apple development team.
4. Connect and unlock the iPhone, trust the Mac if prompted, and enable Developer Mode on the
   iPhone if iOS requests it.
5. Choose the connected iPhone in Xcode's run-destination menu and press **Run**.

Xcode may provision the bundle identifier on the first run. No TestFlight or App Store setup is
required for this local device milestone.

## Inspect a device build

For native and bridge messages, keep Xcode's debug area open with **View > Debug Area > Activate
Console**. Filter for `App`, `Capacitor`, `WebView`, or the request path involved.

For JavaScript, DOM, and network inspection:

1. On the iPhone, enable **Settings > Apps > Safari > Advanced > Web Inspector**.
2. On the Mac, enable Safari's **Develop** menu under **Safari > Settings > Advanced**.
3. Run the Debug build from Xcode.
4. In Safari, choose **Develop > [iPhone] > Ash Atlas**.

Capacitor automatically marks WebView content inspectable in development builds. This project does
not force inspection on for release builds.

During the first physical-device run, inspect these in order:

1. The initial `/api/auth/session` request reaches `https://playashatlas.com` without a CORS or
   cookie error.
2. **Continue with Google** opens the production website and the callback returns to Ash Atlas. If
   Apple is enabled for the submitted release, verify the equally prominent Apple choice and its
   return through the same website/native continuation.
3. Onboarding and authenticated mutation requests include CSRF protection and succeed.
4. The gameplay WebSocket connects over `wss://` and remains connected after one minute.
5. Map, PMTiles, sprites, and other assets load without CSP or mixed-content failures.
6. Refresh/resume keeps the app at its packaged root rather than navigating to the website's
   `/play/` route.
7. Privacy and Terms links open the production website.

The current client calls browser geolocation only after the player chooses Relocate to Current
Location. `ios/App/App/Info.plist` declares foreground `NSLocationWhenInUseUsageDescription` with
that exact purpose and does not request background location. Verify the permission prompt and the
relocation flow on a physical device before submission; do not add broader location modes.
