# Mobile beta pipeline

The mobile beta pipeline builds only exact accepted `test/tNNN` / `test/tNNNN` generations.
`release_mode: internal` preserves internal distribution. Explicit `release_mode: open-beta`
requires both platforms and reserves an externally eligible pair. Every `new-upload` stops after
internal verification. A separate approved `promote-existing` run distributes the same builds to
Google Play `beta` and the existing external TestFlight public-link group. It cannot target Google
Production or App Store production submission, deploy the server, edit tester lists or unrelated
store metadata, or change compatibility minimums.

### Store coverage boundary

The workflow has two real store paths for each platform:

| Platform | Internal upload | Open beta promotion | Production coverage |
| --- | --- | --- | --- |
| iOS | Fastlane uploads the exact signed IPA to TestFlight internal testing and reconciles the exact App Store Connect build | The existing eligible build is submitted to Beta App Review, then attached to the existing enabled public-link TestFlight group after approval | No App Store submission, phased release, production track, or production metadata write is available in this workflow |
| Android | Fastlane uploads the exact signed AAB to Google Play internal testing and verifies the exact versionCode and SHA-256 | The exact versionCode is assigned only to the literal Google Play `beta` track and must reach `PUBLISHED` with the exact active artifact | No Google Play production track, rollout, managed publishing action, or production metadata write is available in this workflow |

### Coordinated daily tester target

The coordinated daily operation uses the existing tester surfaces: TestFlight testers on iOS and
Google Play internal testing on Android. Its metadata packets must set
`delivery_mode: "daily-testers"` in both platform packets and must carry an explicit destination:

```json
{
  "ios": {
    "tester_destination": {
      "kind": "testflight",
      "group_type": "internal",
      "group_id": "<existing-group-id>"
    }
  },
  "android": {
    "tester_destination": {
      "kind": "google-play-internal",
      "track": "internal"
    }
  }
}
```

For an external TestFlight public-link group, set `group_type` to `external` and include the
existing group's exact `public_link`. The group ID and type must identify one existing group;
the operation never creates a group or link. Missing, conflicting, or ambiguous destination
fields fail before reservation or store mutation.

The signed artifact is first uploaded through the established non-distributing upload path. The
private Fastlane provisioning must keep `COORDINATED_DAILY_TESTERS=true`, `distribute_external:
false`, and omit TestFlight groups before upload; a daily upload must never attach or notify the
external group. For an external TestFlight destination, the trusted store adapter may submit the
exact processed build to Beta App Review during preparation and wait for the candidate-bound
approval. It still leaves the group relationship untouched until authenticated server health.
After health, it attaches the exact build to the configured TestFlight group and re-reads the
group/build state. For Google Play it verifies the exact bundle SHA and versionCode, assigns only
that candidate to the `internal` track, and waits for `RELEASE_LIFECYCLE_STATE_PUBLISHED` with the exact
active artifact. Processing, review, or an edit commit alone is pending; `NOT_SENT_FOR_REVIEW` is
an explicit Console action requirement. A daily receipt is successful only after both store
observations are candidate-bound to the destination.

The server coordinator receives both tester-ready receipts and keeps the old server active until
both exact candidates pass the compatibility fence. Server publication and activation happen only
after that two-platform gate; daily tester mode has no production release or public-availability
step. Resume reuses the operation's durable version plan and destination identities.

Before either internal upload or external promotion, the workflow queries the live server's
`/api/auth/native/compatibility` contract for each candidate. The response must bind the exact
platform, marketing version, build, candidate WebSocket range, live hard minimum, and an immutable
40-character server SHA. A required update, missing server identity, unavailable endpoint, or no
protocol overlap stops before store availability is changed. The proof is recorded with the
reservation and cannot be edited later. Reconciliation and every promotion retry perform the same
live check again, so a resumed run cannot distribute a candidate after the live server policy has
changed.

The mobile registry also carries an optional `activationIntent` while a server activation is in
flight. The intent is an operation-scoped object containing `schemaVersion`, `intentId`, target
`serverSha`, `candidateComponentSha`, `preparedReceiptSha`, `preSwitchEnvSha`, `serverProtocol`,
both-platform `hardMinimum`, and `createdAt`. The receipt and environment hashes are SHA-256
identities; the server and candidate component identities are 40-character commit SHAs. Any
reservation, upload-attempt, availability finalization, release-number cleanup, or external
promotion is rejected while that intent exists; only an exact intent-resolution operation can clear
it. A new upload records an immutable `availabilityPending` identity (reservation, platform,
source, version/build, protocol, artifact SHA and preparation time) before the store API, rechecks
the live endpoint, and marks `uploadAttempted` in a second CAS immediately before the upload. If
the process stops after the store call, leave the pending record in place and resume with
`reconcile-only`; there is no expiry-based cleanup.

The registry command interface is:

```sh
node tools/mobile-release/registry-remote.mjs activation-status
node tools/mobile-release/registry-remote.mjs set-activation-intent --intent-file activation-intent.json
node tools/mobile-release/registry-remote.mjs resolve-activation-intent --intent-id OPERATION_ID
```

`set-activation-intent` also accepts inline `--intent '<canonical JSON>'`. Resolution can use the
full exact intent with `--intent-file`; the ID form matches the stored operation ID. Successful
resolution removes `activationIntent` and appends one immutable receipt to the append-only
`resolvedIntents` history. Each receipt contains the exact resolved intent and its `resolvedAt`
timestamp, and intent IDs are unique. If the CAS commit succeeds but its response is lost,
repeating the same ID or exact intent is an idempotent no-op even after later activations; a
different intent ID or different intent contents fail closed, and an active later intent remains
untouched. Receipts remain in the registry and its Git history so delayed exact retries do not
depend on a time-to-live or archival window. Both mutation commands use the registry branch CAS retry loop,
and a newly observed activation intent causes the in-flight availability mutation to fail closed.

Registries from the original singleton-receipt format may still contain one `resolvedIntent` object.
Status reads expose that receipt through `resolvedIntents`; the next mutating CAS upgrades it to the
append-only array before writing. A malformed singleton or a receipt that conflicts with an existing
history entry fails closed and leaves the remote registry unchanged.

Set the optional repository variable `MOBILE_COMPATIBILITY_SERVER_URL` only when the live server
uses a different HTTPS origin; the default is `https://playashatlas.com`. The endpoint must expose
the same native compatibility contract as the server used by the real devices. A successful store
upload still does not mark a build as `downloadTested` or `supported`: an operator must install the
exact internal or external build on a real iOS or Android device and record the versioned evidence.

## Guarded open-beta operation

First accept this feature into `integration/test` through the normal immutable-generation workflow.
The dispatch ref remains `integration/test`; the requested generation must contain this tooling.
Never run a feature branch with protected signing secrets or modify native output on the runner.

Before authorizing any upload, run this read-only store inspection (replace `tNNNN` with the
accepted generation containing this change, and use the intended marketing versions):

```sh
gh workflow run mobile-beta-internal.yml --ref integration/test \
  -f generation=tNNNN -f run_mode=inspect-store -f release_mode=open-beta \
  -f platforms=both -f ios_marketing_version=1.1.0 -f android_marketing_version=1.1.0 \
  -f dry_run=true -f signing_validation=false -f impact_override=auto
```

Inspection emits the package/app IDs, all returned builds/bundles/APKs and tracks, remote maxima,
Google release lifecycle, beta/production fallback comparison, external group IDs and public links,
and metadata-presence flags. Apple collections are fully paginated. Reviewer contact information,
reviewer credentials and signing secrets are never logged. Google requires an uncommitted edit to
read its bundle/APK/track snapshot; inspection creates and deletes this temporary snapshot, never
updates a track, commits an edit, or uploads. The state branch is never initialized by inspection.
Review the Console's App bundle explorer as well when historical/obsolete artifacts or device
targeting make the API's current-artifact history ambiguous. Never guess a maximum in that case.
For `release_mode=internal`, inspection authenticates only the selected platform(s) and skips
external-group metadata and Google beta lifecycle access. An iOS-only inspection never requests
Google credentials; an Android-only inspection never requests Apple credentials.

For a new reservation, each number is `max(remote maximum + 1, durable nextBuild)` independently.
The observed remote floor becomes permanent so unused reservations cannot reclaim historical numbers.
Snapshots expire after 30 minutes; each upload also checks fresh remote history immediately before
calling the existing internal uploader. A collision consumes an attempted number and fails closed.

The first real command, **only after explicit upload authorization and successful inspection**, is:

```sh
gh workflow run mobile-beta-internal.yml --ref integration/test \
  -f generation=tNNNN -f run_mode=new-upload -f release_mode=open-beta \
  -f platforms=both -f ios_marketing_version=1.1.0 -f android_marketing_version=1.1.0 \
  -f dry_run=false -f signing_validation=false -f impact_override=force-affected
```

`force-affected` here explicitly requests a store rebuild even if that generation is pipeline-only.
For validation keep `dry_run=true`; `signing_validation=true` retains the established local signing
validation, with no reservation/upload/promotion. Unsigned dry runs use seed numbers only for local
injection, never as proposed store numbers.

This command does **not** promote externally, including with `release_mode=open-beta`. Install and
test both exact internal builds, record the evidence below, then explicitly dispatch:

```sh
gh workflow run mobile-beta-internal.yml --ref integration/test \
  -f generation=tNNNN -f run_mode=promote-existing -f release_mode=open-beta \
  -f reconciliation_release_id=ORIGINAL_RELEASE_ID -f platforms=both \
  -f ios_marketing_version=1.1.0 -f android_marketing_version=1.1.0 \
  -f dry_run=false -f signing_validation=false -f impact_override=auto
```

The `mobile-beta-promotion` environment is a separate approval boundary from internal uploads.
Its `MOBILE_BETA_PROMOTION_APPROVED` variable must be exactly `true`; missing configuration fails
closed. This opt-in variable does not prove reviewer protection exists. The owner must verify the
environment's required reviewers, deployment branch restriction to `integration/test`, and secret
scope in GitHub before setting it. A code review or internal-upload approval is not external-release
approval. `reconcile-only` only recovers internal receipts and never enters this promotion job.

Open-beta reservation requires existing required Apple beta metadata and a resolvable public group.
If several enabled public groups exist, set the existing environment variable
`ASH_ATLAS_TESTFLIGHT_EXTERNAL_GROUP_ID` to the chosen **existing** ID. No group or link is created,
replaced or enabled automatically. Missing description/feedback/review details, export declarations
or testing notes fail closed and must be completed in App Store Connect. No reviewer credentials
should be placed in repository code, workflow inputs, artifacts or the ledger.

The iOS export explicitly sets `testFlightInternalTestingOnly=false`. External promotion additionally
requires App Store Connect `buildAudienceType=APP_STORE_ELIGIBLE`, the exact app, marketing version,
numeric build and store ID, valid processing, non-expiration, internal-group attachment, testing
notes and a resolved export-compliance state. Eligibility does not submit an App Store release.
Beta App Review is submitted only through `/v1/betaAppReviewSubmissions`. Approval precedes group
attachment. Completion requires the same enabled public-link group to contain that exact build and
the build to report `IN_BETA_TESTING`. This verifies the public-link group's store configuration;
actual enrollment/install on a real device remains the separate `downloadTested` gate.

Google promotion requires the exact internally verified bundle SHA-256 and versionCode. Only the
literal `beta` endpoint is writable; no caller-supplied track exists. An edit can be committed only
after this process created it and assigned its beta release. All tracks are checked again before
commit to catch operator changes. Verification requires both a completed exact beta assignment and
`RELEASE_LIFECYCLE_STATE_PUBLISHED` with the exact active artifact. An edit commit, review pending,
or `APPROVED_NOT_PUBLISHED` is not success. Production fallback versionCodes must be lower. The
Console superseded label has no direct API field: if fallback/active-artifact evidence is ambiguous,
verify the Console and an external tester device before claiming the issue resolved. Managed
publishing or review actions that would include unrelated changes remain manual.
Unreadable lifecycle (including HTTP 403), unknown/superseded states, partial responses, conflicting
artifacts and in-progress unrelated releases fail before beta PUT or commit. Inspection may report
`betaLifecycleReadable=false` for diagnosis; that is never permission to promote. Fresh lifecycle
and tracks are compared again immediately before the beta assignment.

## Durable beta recovery

Existing schema-v1 records remain valid; new records bind `releaseMode` and add monotone `milestones`:
`reserved`, `built`, `uploaded`, `internal_verified`, `google_open_submitted`,
`google_open_verified`, `ios_beta_review_submitted`, `ios_beta_review_pending`,
`ios_external_verified`, `open_beta_complete`. Existing availability/compatibility fields remain
authoritative for the server gate. Artifact hashes, store IDs and external group/link identities
cannot be changed after recording. `open_beta_complete` is written only after both platforms verify.

Schema version 1 remains backward compatible. `artifactValidation` is additive, immutable and binds
source SHA, platform, marketing version, numeric build, artifact SHA-256 and the bundled push mode.
`internalSmokeEvidence` is a separate versioned immutable object. Existing records without either
proof stay unverified for external promotion. The external `downloadTested` field retains its
original meaning and is never repurposed for internal testing.

Pending availability is durable recovery state rather than a success claim. It is included in the
server compatibility gate alongside protected, supported and unresolved attempted records, while
`distributed-sources` continues to advance only from a completed distributed client.

To record real internal testing, prepare a JSON patch outside Git containing
`{"internalSmokeEvidence": {...}}`, then run `registry-remote.mjs transition --reservation-id
<original-release-id>:<platform> --patch-file <absolute-json-path>` through the authorized registry
operator environment. Do not put credentials, tokens, reviewer passwords or personal device IDs in
the proof. The object requires:

- `schemaVersion: 1`, `checklistVersion: 1`, `result: "passed"`, ISO `testedAt`, tester label, device
  model, `osVersion`, and an HTTPS `evidenceUrl` to the actual test receipt.
- Exact `sourceSha`, `platform`, `marketingVersion`, numeric `build`, `artifactSha256`, and
  `storeBuildId` copied from the verified reservation.
- `pushMode` equal to the immutable artifact validation report (`enabled` or `disabled`).
- A `checks` object with `"passed"` for `store-install-update`, `cold-start`, `sign-in`, `world-load`,
  `movement-inventory`, `background-resume`, and `network-reconnect`. Enabled push also requires
  `notification-permission`, `notification-receive-background`, and `notification-tap`; disabled
  push requires `notification-disabled` (verify the app does not offer/register disabled push).
  Skipped, incomplete, wrong-artifact, or wrong-mode evidence cannot authorize promotion.

For historical builds, do not synthesize artifact or device evidence from an old upload success.
An owner must retrieve and independently validate the retained exact artifact and perform the
applicable store-installed device checklist before genuine evidence can be backfilled. New builds
include `native-build.json` in their bundled web assets so the final package's push mode is checked.
Historical binaries without that marker need an explicit artifact audit; this validator will not
pretend it observed a missing marker. Missing retained artifacts remain a blocker.

The first explicit promotion records `promotionApproval`; each approved run appends a
`promotionExecutions` receipt with its separate tool SHA, workflow run URL and dispatch actor.
`sourceSha` always remains the original artifact source. The actor is the dispatch actor; the run's
environment approval history is the reviewer evidence. A recovery run may use patched current
tooling without rewriting the original approval or rebuilding the source.

Polling is bounded to ten checks at 30-second intervals. Pending review/publication leaves durable
state and exits without claiming completion. Resume with the same generation, versions,
`release_mode=open-beta`, `run_mode=promote-existing`, `dry_run=false`, `platforms=both`, and
`reconciliation_release_id=<original release ID>`. Both internal receipts are reverified and the
external phases resume after the separate environment approval, without rebuilding/reuploading.
Preflight loads current immutable workflow tooling for recovery while reading the original source's
protocol directly by its exact Git SHA. Already assigned beta releases or Apple
review submissions are read instead of duplicated. An interrupted Apple review request with no
discoverable remote submission fails closed for operator reconciliation. Rejected reviews and
unexpected group/version/store state also require operator action.

Pre-upload reserved/built states are inspectable but `reconcile-only` deliberately cannot build or
upload them. Rerun the original new-upload run only for an unattempted reservation. Once upload was
attempted, the number remains permanently consumed; reconcile the remote receipt first.

## Operator flow

1. Accept the desired source into `integration/test`, producing one immutable `test/tNNN` tag.
2. In GitHub Actions, run **Mobile beta candidate — guarded distribution** with that generation and an
   iOS and Android marketing version. They may match (such as `1.1.0`) or advance independently.
3. Leave `dry_run` enabled for the first pass. This validates the source, impact classifier,
   compatibility contract, native web builds, Xcode simulator build, and unsigned Android bundle.
4. After the unsigned pass, leave `dry_run` enabled and select `signing_validation`. This imports
   the configured Apple certificate into an ephemeral keychain, validates the provisioning profile,
   creates and verifies signed iOS and Android artifacts locally, verifies the Android upload-key
   fingerprint, and performs read-only App Store Connect and Google Play authentication. It never
   reserves build numbers, writes the release registry, uploads signed artifacts, or calls a store
   publishing endpoint. The signed artifacts and materialized credentials are deleted afterward.
5. Run again with `dry_run` disabled only when the candidate is ready for internal testers. The
   protected `mobile-beta-internal` environment must require an owner approval.
6. Install the resulting update through TestFlight and Google Play on real devices, complete the
   applicable versioned checklist, and record proof in the registry. For an `open-beta` reservation,
   explicitly dispatch `promote-existing` and approve its separate protected environment.

`signing_validation` is accepted only with `dry_run: true` and `run_mode: new-upload`. It uses the
temporary build numbers derived from the seed registry solely for local version injection. Selecting
it with a real run or reconciliation fails during preflight before signing, state mutation, or store
access.

Normal pushes and merges cannot invoke the workflow. The preflight reads the durable registry's
last distributed source independently for iOS and Android, then compares each selected platform's
candidate against that exact source. This cumulative comparison includes mobile changes carried
through any number of interleaved server-only generations and handles iOS/Android source divergence.
A selected platform classified `MOBILE_UNAFFECTED` is refused unless the operator deliberately
selects `force-affected`.
Use `run_mode: new-upload` for a new candidate. If a store upload was attempted but receipt
recording or availability verification failed, rerun with `run_mode: reconcile-only` and the
original release ID. Reconciliation queries the existing store build and never uploads it again.

## Required GitHub configuration

Create a protected environment named `mobile-beta-internal` with required reviewers. Configure:
Before the first live open-beta dispatch, verify this protection in GitHub. A branch allowlist
alone does not provide a required-reviewer approval gate; adding reviewer protection is an owner
configuration action, not something this workflow silently changes.
Create and verify `mobile-beta-promotion` separately with required reviewers and the same accepted
branch restriction. Give it only store verification/testing-promotion credentials and the existing
group variables, plus `MOBILE_BETA_PROMOTION_APPROVED=true` after review. Do not copy signing P12,
keystore, provisioning profile or server push-provider secrets into that environment.
Repository Actions must also have permission to write contents so the workflow can advance the
dedicated `mobile-release-state` branch. If that branch is protected, allow this workflow's
`GITHUB_TOKEN` to append commits while continuing to prohibit force pushes and deletion.

### Free self-hosted Mac runner

Every job is pinned to `[self-hosted, macOS, ash-atlas-mobile]`. GitHub-hosted runners are
intentionally forbidden so this private repository does not consume billable hosted-runner
minutes. Register one repository-level runner from **Settings → Actions → Runners → New
self-hosted runner**, choose macOS and the Mac's actual architecture, and follow GitHub's generated
download and configuration commands. Add the custom label `ash-atlas-mobile` during configuration;
do not paste the short-lived registration token into chat, documentation, Git, or logs.

For the first dry run, start the runner interactively with the generated `run.sh` command and keep
that terminal open. The Mac must remain awake and online. Install it as a background service only
after the dry run succeeds. Keep the runner repository-scoped, use it only for this private trusted
repository, and do not route pull-request workflows or untrusted forks to it.

The runner account needs Xcode with its license accepted, plus Homebrew Ruby `3.3.12` at
`/opt/homebrew/opt/ruby@3.3/bin` and Bundler `2.4.22` installed for that Ruby. The workflow installs
its pinned Node, Java, and package dependencies through setup actions, but deliberately validates
and uses the Mac's local Ruby and Bundler instead of `ruby/setup-ruby`; that action assumes a
GitHub-hosted `/Users/runner` home and cannot initialize on this personal runner. Gems are restored
to and installed under `${{ runner.temp }}`, never `/Users/runner` or the repository. Android Studio's
SDK must exist at `$HOME/Library/Android/sdk`; the Android job validates that directory and exports
both `ANDROID_HOME` and `ANDROID_SDK_ROOT` before Capacitor or Gradle build work. Real iOS uploads
use a temporary keychain while preserving and restoring the Mac user's original keychain search
list and default keychain. Job files use a unique private directory and registry clones containing
transport credentials live under it. Cleanup attempts all recovery operations, verifies final host
settings, and deletes only a profile installed by that job after checking its contents are unchanged.
Signing validation also removes both copied artifacts and the original Gradle release bundle.
Unsigned dry runs do not load signing or store credentials.

Before any work, a durable host marker is written at
`~/Library/Application Support/AshAtlasRelease/cleanup-required.json`. Successful cleanup removes
it. Failure or interrupted cleanup leaves it in place and blocks every subsequent job. The owner
must inspect the recorded job directory, restore the original keychain search list and default,
preserve pre-existing identities/profiles, remove that job's credentials/artifacts, and verify
recovery before clearing the marker. Never clear it merely to retry a failed job.

The final **exported IPA** is unpacked and checked for exact identity, bundled Capacitor config,
web build marker, Apple certificate requirement, code signature, embedded profile validity and
profile-authorized signer. Android uses upstream bundletool 1.18.3 (SHA-256
`a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29`) to validate the final AAB and read
its manifest/resources, then checks JAR signature coverage and the existing upload certificate.
The pinned digest is from the [upstream release](https://github.com/google/bundletool/releases/tag/1.18.3).
All workflow actions are pinned to upstream commit SHAs, resolved from their v4 tags on 2026-09-19.

`VITE_NATIVE_PUSH_ENABLED` defaults to `false`. Enabling it is an owner configuration decision:
the accepted Android source must contain the correct public `android/app/google-services.json`;
the final AAB must contain the matching Firebase app/sender resources. iOS uses the opt-in
`App/AppPush.entitlements` only for enabled builds and requires production APNs entitlement in
both the final app and distribution profile. The workflow never creates capabilities, keys or
profiles. Public Firebase app config is distinct from private Firebase service-account JSON.
APNs/FCM provider credentials belong on the server, never in the app, artifact or workflow inputs.
Package validation does not prove remote capability enrollment, provider credentials, domain
association hosting, real push delivery, device targeting or physical-device install/update;
these remain explicit owner setup and real-device evidence requirements.

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `APP_STORE_CONNECT_KEY_ID` | App Store Connect API key ID |
| Secret | `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect issuer ID |
| Secret | `APP_STORE_CONNECT_KEY_P8_BASE64` | Base64 API private key |
| Secret | `APPLE_DISTRIBUTION_P12_BASE64` | Base64 Apple Distribution certificate and key |
| Secret | `APPLE_DISTRIBUTION_P12_PASSWORD` | P12 password |
| Secret | `APPLE_PROVISIONING_PROFILE_BASE64` | Base64 App Store provisioning profile |
| Variable | `APPLE_TEAM_ID` | Apple developer team ID |
| Variable | `APPLE_PROVISIONING_PROFILE_SPECIFIER` | Exact profile name |
| Variable | `ASH_ATLAS_TESTFLIGHT_INTERNAL_GROUP` | Existing internal TestFlight group |
| Variable | `MOBILE_COMPATIBILITY_SERVER_URL` | Optional HTTPS origin for the live native compatibility endpoint; defaults to `https://playashatlas.com` |
| Secret | `ANDROID_UPLOAD_KEYSTORE_BASE64` | Existing Play upload keystore |
| Secret | `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | Keystore password |
| Secret | `ANDROID_UPLOAD_KEY_ALIAS` | Upload key alias |
| Secret | `ANDROID_UPLOAD_KEY_PASSWORD` | Upload key password |
| Secret | `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64` | Restricted Play service account JSON |

The Play service account should be restricted to Ash Atlas and testing-release operations. Keep
Play App Signing enabled. Reviewer usernames and passwords belong only in App Store Connect and
Google Play review-access fields; they must never be placed in GitHub, Git, logs, artifacts, or the
release registry.
Workflow inputs enter shell steps only through validated environment variables. Checkout credentials
are not persisted in build jobs, the registry token exists only on registry-update steps, and the
App Store Connect private key exists only on the upload/reconciliation verification step.

## Identity and immutable source

Each platform's marketing version and store build number are independent:

```text
iOS marketing version:      1.1.0
iOS CFBundleVersion:        14
Android marketing version:  1.0.7
Android versionCode:        12
Accepted source:            test/t1200 at one exact SHA
```

The workflow passes identity through Vite environment variables and native build overrides.
`xcodebuild` receives `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`; Gradle receives
`ashAtlasVersionName` and `ashAtlasVersionCode`. Source version files are not rewritten.

## Registry and collision safety

Durable state lives on the dedicated `mobile-release-state` branch in
`mobile-release-registry.json`. The branch contains no application source. The workflow initializes
it from `config/mobile-release-registry.seed.json` when absent.

The `distributed-sources` registry read selects the highest consumed build independently for each
platform from records marked `compatibilityProtected`, `internal`, `supported`, or externally
available. The selected record's immutable `sourceSha` is the mobile impact baseline. A pending
reservation or a generation that only changed the server never advances either platform baseline.

The registry owns independent `nextBuild.ios` and `nextBuild.android` counters. Its immutable
`buildFloor` preserves numbers consumed before the registry existed. Workflow-level
concurrency serializes normal runs, while the registry updater additionally uses an optimistic
non-fast-forward push and retries against the new tip. A release ID is idempotent, so retrying the
same GitHub run receives the same numbers. A reservation may be released and reclaimed only before
`uploadAttempted`. Once any store upload is attempted, that number is permanently consumed even if
the store rejects it. This prevents reuse of a number Apple or Google may already have observed.
Unused reservations can be released in any order; the allocator collapses the unattempted tail back
to `buildFloor` without crossing historical or upload-attempted records.

The seed includes exact source identities for both historical build-1 clients. Because those builds
predate this registry, their missing artifact/store receipts are not fabricated. Instead they are
`compatibilityProtected`, which makes the server gate preserve them while leaving their unproven
store-availability fields false. Newly automated candidates become compatibility-protected only
after the store proves internal availability.

State advances monotonically:

```text
reserved → uploadAttempted → uploaded → processed → internal
                                                    ↓
    externalApproved (iOS)
                                      open (Android)
                                                    ↓
                                           downloadTested
                                                    ↓
                                              supported
```

An uploaded or internal record is invalid without an immutable artifact SHA-256, store build ID,
and HTTPS receipt. `downloadTested` additionally requires iOS external approval/availability or
Android open-test availability, as appropriate. Retrying an identical reservation or transition is
a successful no-op and returns the existing reservation state without creating an empty commit.

Every upload stops at `internal`. Explicit approved `promote-existing` for an original open-beta
reservation adds external approval/open testing. Real-device download proof and support designation remain manual. Registry validation
rejects impossible transitions. `supported` requires both external/open availability and
`downloadTested: true`.

## Compatibility and server deployment gate

Each platform has independent hard minimum, recommended minimum, and latest identities, each made
of marketing version plus numeric build. The hard minimum defaults to `0.0.0 (0)` and the upload
workflow never changes it. Protocol incompatibility can still block an unusable client.
The extended response deliberately retains compatibility-contract v1 and its legacy version fields
so the already-uploaded build 1 clients continue to parse it while newer clients use build-aware fields.

The protected server release orchestrator reads the durable registry immediately after preparing a
candidate and before protected publication or activation. It derives the proposed WebSocket range
from that exact prepared candidate's `protocolCompatibility.ts`, never controller environment
defaults. It refuses a server whose WebSocket protocol range cannot overlap every registry record
marked `supported` or
`compatibilityProtected`. New API/database work must remain compatible with those builds using
expand-then-contract changes.

Only a build proven externally available **and installed from the store on a real device** may be
marked `downloadTested` and `supported`. Only such a record may be used to suggest raising a
recommended or hard minimum. Raising either minimum remains a separate manual, reviewed server
configuration change; it is not part of upload or promotion.

## Failure, retry, and rollback

- Build failure before upload: retry the same run/release ID and reuse its reservation. An owner may
  release an unused reservation with `registry-remote.mjs release-unused`.
- Store definitively rejected the attempted binary: never reuse the number; fix it and allocate a new build.
- Store upload may have succeeded but verification/recording failed: use `reconcile-only` with the
  original release ID. The workflow refuses a second upload and only verifies the existing build.
- Bad internal build: remove it from internal testing; external testers are unaffected.
- Bad external build: stop distribution and upload the last good source with higher build numbers.
- Bad server release: use the existing exact-SHA server rollback. Lowering a mistaken hard minimum
  can restore access without a new mobile binary.
- Registry update race: the losing writer fetches the winner, reapplies its idempotent operation,
  validates, and retries. It never force-pushes the state branch.

Ruby `3.3.12`, Bundler `2.4.22`, and Fastlane `2.228.0` are pinned. Fastlane only transports
already-built, explicitly verified IPA/AAB
artifacts. The dedicated self-hosted Mac restores its pinned gem bundle only from GitHub Actions
cache into the job temporary directory and deletes the temporary Apple keychain after each job.
