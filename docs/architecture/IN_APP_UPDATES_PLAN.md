# In-app updates plan (iOS / Android)

Status: **pilot in progress** on `feature/ota-mobile-pilot--from-t1256`.

## Frozen shell 8 contract

The descriptor is `NativeBundleDescriptor` in `packages/shared/src/nativeBundle.ts`.
Its exact fields are `bundleId`, `platform` (`ios` or `android`), `url`,
`checksum` (lowercase SHA-256 hex), `signature` (base64), `sizeBytes`,
`artifactType` (`zip` or `manifest`), `clientSha`, `serverSha`, `generation`,
`minShellBuild`, `protocolMin`, and `protocolMax`. The shared validator rejects
invalid descriptors. The pointer at `/srv/ash-atlas/native-bundles/pointer.json`
has `ios` and `android` entries, each with `current` and `previous` (descriptor
or `null`).

`GET /api/native/bundle?platform=<ios|android>&shellBuild=<build>&bundle=<id>`
returns the platform's current descriptor when the shell build is sufficient
and the bundle ID differs; otherwise it returns 204. `NATIVE_OTA_ENABLED`
defaults to false and forces 204 while disabled. The signed artifacts are served
at `https://playashatlas.com/play/native-bundles/<platform>/<clientSha>/`.
The pointer is the single source of truth for native bundles: a 200 response
means an update exists. The app checks at launch, on resume, and when the
existing release poll sees a change. It validates the descriptor, shell build,
and native protocol range, then lets the plugin verify checksum and signature.
`release.json` clients.ios/android hashes are informational for the watermark
and diagnostics; they do not authorize or reject a native bundle.

The pointer must be mode `0640`, group `ash-atlas`, so the game server can read it;
the updater runs under `umask 0077`, so the pointer writers set the mode explicitly.
An unreadable pointer makes the endpoint return 503. After every pointer activation
the updater requires the endpoint to answer 200 or 204 for both platforms.
Production has `NATIVE_OTA_ENABLED=true` (observed 2026-09-26).

The RSA-2048 private key is `/etc/ash-atlas/ota-signing.pem` on the VPS, owned
by `root:root` with mode `0600`. The matching public key is committed in
`capacitor.config.ts`. To make an encrypted offline backup from Windows, connect
the offline backup drive, then run this in PowerShell (change only the drive path):

```powershell
ssh ash-atlas-vps 'sudo -n cat /etc/ash-atlas/ota-signing.pem' |
  gpg --symmetric --cipher-algo AES256 --output 'E:\AshAtlasOffline\ota-signing.pem.gpg'
```

Enter a new backup passphrase when GPG prompts, store it separately from the
drive, and keep the drive offline. To check that the encrypted copy contains the
matching key without printing it, compare the output of these commands; the
SHA-256 fingerprints must match:

```powershell
gpg --decrypt 'E:\AshAtlasOffline\ota-signing.pem.gpg' 2>$null |
  openssl pkey -pubout 2>$null |
  openssl pkey -pubin -outform DER 2>$null |
  openssl dgst -sha256
ssh ash-atlas-vps 'sudo -n openssl pkey -in /etc/ash-atlas/ota-signing.pem -pubout' |
  openssl pkey -pubin -outform DER 2>$null |
  openssl dgst -sha256
```

The rollback command is `tools/release/native-bundle-rollback.sh <ios|android|all>`;
it swaps only `current` and `previous` in the pointer for the selected
platform(s). It does not change `release.json`.

## Goal

The store app becomes a small, stable **shell**. Game code, UI and art update **inside the app**
("Downloading update 1.4 / 2.1 MB"), with no App Store / Play review for ordinary updates.
Store builds are only needed for native changes: new Capacitor plugins, permissions, icon/name,
SDK upgrades, changes to the updater itself, and the first in-app purchase setup.

## How it works

- Plugin: `@capawesome/capacitor-live-update` (MIT, self-hosted, Capacitor 8). Haptics plugin
  ships in the same shell build.
- Each Game Update builds a signed manifest bundle per changed platform (iOS, Android)
  from the exact candidate. The manifest and each file have SHA-256 checksums and RSA
  signatures. The private key lives only on the VPS; the public key is in
  `capacitor.config.ts`.
- Server endpoint `/api/native/bundle?platform=&shellBuild=&bundle=` returns the newest bundle
  compatible with that shell (`minShellBuild`), or 204 if current. Current + previous pointer per
  platform; rollback is a pointer flip. Kill switch: `NATIVE_OTA_ENABLED=false`.
- App start: "Checking for updates" → download with progress → verify → `setNextBundle` + reload.
  Offline or failed download: keep the current bundle unless the server says it is incompatible.
- Shell identity (version/build) is read at runtime from `App.getInfo()`, never baked into JS.
- Art stays in the native bundle. Manifest mode passed Android emulator and iOS
  simulator acceptance on 2026-09-25: a one-PNG change downloaded only that file,
  tampering was rejected, and rollback and offline relaunch worked. Publishing uses
  manifest mode; previously published zip descriptors remain supported.

## Seed bundle in the store binary

- `pnpm build:native` / `build:android` (the store builds' webDir) now emit a **seed bundle**:
  all code, styles and data plus only the root-level app icons the boot screens show (about
  10 MB instead of the ~300 MB full client). `build:native:full` / `build:android:full` keep the
  old full build for local device work. OTA bundles (`build-native-bundles.mjs`) always carry
  the full client and are unchanged. The file rule is `nativeBundleFileClass` in
  `apps/client/src/native/nativeSeedBundle.ts`; the seed is compiled with
  `VITE_NATIVE_SEED_BUNDLE=true` (`clientConfig.nativeSeedBundle`).
- A seed never starts the game. At launch (`main.tsx`) it checks the bundle endpoint, reads the
  download size with `readNativeUpdateDownloadBytes` (files missing from the seed's manifest),
  shows `ConnectionRecoveryScreen` `first_run_ready` (size, Wi-Fi hint, Download), and only then
  downloads the full signed bundle and reloads into it (App Store 4.2.3(iii)). Unreachable server,
  unknown size, a 204 from the endpoint, or a failed download all stay on a blocking screen with
  Try Again. Files the seed already has are copied, not downloaded.
- Store updates: Capacitor itself boots the built-in bundle after any binary version change
  (`Bridge.isNewBinary` on Android, `CAPBridgeViewController.isNewBinary` on iOS clear the saved
  server path); Capawesome 8.4.3 only resets its own app-ID config then and has no
  keep-bundle option, and `ready()` with `autoDeleteBundles` deletes every bundle that is not
  current or next. So the seed calls `restoreKeptNativeBundle()` instead of `ready()`: it marks
  a downloaded, unblocked bundle as next (so `ready()` keeps it) and reloads into it; that
  bundle's own launch check updates it before play. If it can't start, the 10-second rollback
  returns to the seed, `ready()` blocks it, and the seed shows the first-run download.
- Not resumable across a failure: Capawesome 8.4.3 downloads into a temporary folder that it
  deletes when a download fails, so Try Again fetches every file the seed lacks again.
- On-demand packs (for example `assets/dungeons/`) would be a new class in
  `nativeBundleFileClass`, left out of the full OTA manifest and fetched when first needed.
  Not built.
- Opt-in (`ASH_ATLAS_PNG_OPTIMIZE=true`, default off): every client build (web, OTA, seed) can run a lossless oxipng pass over all PNGs
  (`apps/client/src/bundling/optimizePngAssets.ts`, `@jsquash/oxipng` pinned). Filenames are
  unchanged and output is deterministic; results are cached by input hash in
  `~/.cache/ash-atlas/png-optimize` (`ASH_ATLAS_PNG_CACHE_DIR`), unused entries pruned after
  30 days. Measured 287.0 -> 263.1 MB (-8%); a 256-colour lossy pass measured 263.1 -> 69.5 MB.
  Turning it on changes every PNG checksum once, so installed apps
  re-download their PNGs with that update.

## Rollback rules (corrected after review)

- If a bundle fails to call `ready()` in time, the plugin resets to the **embedded** shell bundle,
  not the previous update.
- Use the plugin's built-in `autoBlockRolledBackBundles` + `getBlockedBundles()` as the
  failed-bundle skip list so a bad bundle is never re-downloaded. `ready()` returns a `rollback`
  flag and the previous bundle ID; report it to diagnostics.
- The first shell embeds a live-update manifest so manifest updates can reuse unchanged
  files. The Android emulator and iOS simulator self-hosted tests passed before enabling
  manifest publishing.
- iOS privacy manifest: add the `UserDefaults` reason `CA92.1` required by the plugin.
- Call `ready()` right after the first screen renders. Do **not** wait for the server (an outage
  would roll back a healthy bundle). A bundle that renders but can't connect is handled
  server-side by flipping the pointer back.
- The embedded bundle's updater and the bundle endpoint are a **permanent contract** for the life
  of each shell build.

## Shared with the web version system

- Versions: client (per platform: `web`, `ios`, `android`), server, protocol.
- Rules: server-only change → no update; native bundle endpoint 200 → download
  and apply at a safe moment; protocol incompatible → force before reconnecting.
- One `applyClientUpdate(target)` interface: web = cache-busting reload; native = download bundle.
- The web loop guard (2 tries, then a help screen) mirrors the native blocked-bundle list.
- Web also treats Vite's `vite:preloadError` (a code chunk failed to load after a deploy) as
  "client changed" and runs the quick update.
- The version watermark shows the shell build in the app.

## Apple / Google

- Google Play allows JavaScript running in a WebView to update outside the store.
- Apple's license (3.3.1(B)) allows downloaded interpreted code that doesn't change the app's
  primary purpose or bypass security, but Guideline 2.5.2 says downloaded code may not introduce
  or change features. Bug fixes, art, balance, UI fixes and server-driven content are easy to
  defend; brand-new gameplay systems delivered to iOS by bundle are review-sensitive. The pilot
  proves the technology, not Apple's acceptance of arbitrary feature delivery, so ship big new
  systems through an occasional store build. Always: signed bundles, honest App Review notes
  ("downloads game content and updates at launch"), no hidden features, IAP for anything sold.

## Alternatives checked (Sept 2026)

Ionic Appflow: no new customers, shuts down Dec 31, 2027. Capgo: fine but no reason to switch.
Loading the live site in the app (`server.url`): no offline, higher review risk. DIY bundle
swapping: rebuilds what the plugin already does. Converting all content to data catalogs first:
too slow as a prerequisite.

## Pilot acceptance (both physical phones, unchanged build number)

1. An update installs.
2. A broken update rolls back to the embedded bundle and is skipped afterward.
3. The app launches offline.
4. A bad release can be pulled server-side.

Estimate when resumed: roughly 5–8 active engineering days for a proven pilot, plus one store
review for the new shell build.


## Retiring the pre-web-install store builds

The registry supports reversible compatibility retirement only for iOS builds 1, 2, 3, 5,
6, 7 and Android builds 1, 2, 3, 4, 6, 7. Build 8 is beta/internal and cannot be retired;
newer builds and every other build are also excluded. Retirement neither changes store
availability nor deletes upload history, protection flags, reservations or consumed build numbers.

Use the audited registry command with the exact reservation ID from the registry:

```sh
node tools/mobile-release/registry-remote.mjs retire --reservation-id <exact-id> --action-id <unique-id> --actor <operator> --note "retired; replaced by web install; build 8 is beta/internal"
node tools/mobile-release/registry-remote.mjs unretire --reservation-id <exact-id> --action-id <new-unique-id> --actor <operator> --note "restore compatibility protection"
```

For a disposable local snapshot, append `--file <snapshot.json>`. Without `--file`, the existing
registry remote CAS protocol appends the evidence to `mobile-release-state`. An exact retry of an
action ID is idempotent; changing its action, identity, actor or note is rejected. Each audit entry
records the exact release/artifact/store identity, operator and time. A later unretire entry restores
compatibility protection; earlier entries remain intact. The additive schema-v1 `retirementAudit`
field leaves historical Mac tooling and upload records readable. Consumers must preserve this
field when writing registry snapshots.

Activation intents, pending availability and unresolved production operations block both commands.
Every server compatibility gate validates and replays the audit before skipping retired builds;
malformed or out-of-allowlist evidence fails closed. Other protected and uploaded builds retain their
protocol and hard-minimum checks. Read-only `compatibility-releases` returns the validated selection.

W6 keeps the live hard minimum at 1.0.0 build 8; retiring these obsolete builds does not restart
the game server or modify its environment. Build 8 remains internal-only until its future public
release is approved. (Production `NATIVE_OTA_ENABLED` has since been set to true; see the top
of this document.)

The frozen `coordinated-20260101T000000-00000000` PREPARED receipt can hand off from the reviewed
t1280 updater to the exact retirement updater without rebuilding artifacts. This one-operation
bridge requires a quiescent prepared state, no activation or migration, the original environment
and live release links, a valid original receipt checksum, and both exact build-8 submission
identities. An immutable audit stores the complete original receipt and links old/new updater
hashes and the authoritative registry snapshot. The preparation descriptor and artifact hashes
remain unchanged; all normal ACTIVATE integrity, environment, migration and pointer checks run.
The receipt's updater and checksum change in one atomic write. Every other updater change refuses.

For frozen t1278 activation, `master` and its immutable generation tag must still equal the frozen
source. A later integration generation is allowed only when it is tagged, descended from t1278,
and its entire diff is release tooling (`tools/release/`, `tools/mobile-release/`, or this plan).
Gameplay, native-shell or configuration changes refuse activation. The canonical installer still
verifies exact committed controller/updater bytes before Resume.

Completed W6 activation resumes through normal terminal reconciliation only after the exact
authoritative completed receipt and live public/game identities match the durable intent.
The same-process failure came from replacing the parsed intent with an `OrderedDictionary`:
the property-based identity reader saw missing fields even though persisted JSON was identical.
The controller now retains the parsed identity after CAS; no comparison is relaxed. Resolution
appends an immutable audit with original intent JSON and hash, normalized identity, registry
snapshot hash, server receipt and live identity, actor, audit version and controller hash.
An exact retry preserves that receipt after a lost response; different intents, partial activation
and mismatched live identity refuse. This path does not dispatch ACTIVATE again or cancel stale work.
