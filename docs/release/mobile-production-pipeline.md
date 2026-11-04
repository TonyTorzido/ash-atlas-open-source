# Mobile production promotion

Production promotion is a separate workflow from `mobile-beta-internal.yml`. It promotes the
already verified IPA or AAB recorded in the mobile release registry. It never rebuilds the app and
never treats the beta track as the production baseline.

Run **Mobile production promotion — guarded release** from the exact accepted `test/tNNN` tag.
The workflow defaults to `inspect` with `dry_run=true`. Every production mutation needs the
`mobile-production` environment, the production-only store credentials, the production mutation
approval secret, and the exact candidate identity. The preflight job has `contents: read` and uses
read-only production store credentials. The mutation job has `contents: write` only so it can
commit the registry journal through `mobile-release-state`; it uses the same named environment and
separate production store credentials. The workflow proves the accepted tag is an ancestor of the
published `master` SHA. A coordinated operation may submit and wait for store review before the
server is published; its post-health release step consumes authenticated coordinator evidence.

## Coordinated server/mobile release

Use the same `workflow_dispatch` entry point with `coordinated=true` and one
`coordinated_operation_id` when the server coordinator owns the full release. The workflow resumes
the two platform child operations from the durable `mobile-release-state` journal and writes
append-only `ash-atlas-mobile-child-receipt` records. A retry first reconciles any pending or
uncertain store substep, then continues from the exact recorded store identity; it never repeats a
terminal child operation. The coordinator first records an authenticated
`ash-atlas-coordinated-server-evidence` entry containing the exact iOS and Android candidate
identities; mobile refuses to prepare or mutate a global candidate belonging to another operation.

The child gate exposes these phases to the server coordinator:

`manifest_created -> apps_submitted -> apps_ready -> server_published -> server_activated ->
server_healthy -> apps_release_requested -> completed`.

`apps_ready` requires the exact candidate-bound iOS version to be
`PENDING_DEVELOPER_RELEASE` and the exact Google production release to be
`RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED` with managed publishing explicitly enabled. The
receipt approval fingerprint covers release identity, accepted source and generation, tooling,
metadata, countries, and rollout. The first Google publication also requires the explicit
bootstrap proof in the authenticated candidate evidence. The server coordinator must prove
publication, activation, and public health in the durable registry before the workflow requests
either app release. Phase and server-health booleans are not workflow-dispatch inputs and cannot
unlock a release. Completion requires a fresh public-availability
read: Apple `READY_FOR_SALE` or `READY_FOR_DISTRIBUTION`, and Google `PUBLISHED` with the exact
candidate version code.

The coordinated path remains dry-run by default and has no beta credential or endpoint access. A
workflow can wait through bounded transient reconciliation attempts, but external App Store review,
Google approval, managed-publishing account configuration, and the MacBook self-hosted runner are
operator prerequisites; those states cannot be fabricated by a receipt.

### Trusted one-action bootstrap

The private Windows controller starts the private-control Mac workflow at the exact
`test/<generation>` source tag. The game-repository `coordinated-mobile-bootstrap.yml` remains an
uncredentialed fail-closed handoff and never receives store credentials. The private workflow
proves the source mirror HEAD, immutable control-tooling SHA, and explicit game registry remote
before it invokes any trusted adapter.

`tools/mobile-release/coordinated-mobile-control.mjs` owns the durable sequence: it imports the
isolated unsigned manifest, reserves both build numbers, invokes the controller-owned signer,
delegates upload/prepare/submit/reconcile/release to an external trusted store adapter, and records
one candidate-bound receipt per platform. The private workflow copies the concrete unsigned builder,
Seatbelt supervisor, and signer from the pinned control checkout into operation-specific paths outside
both checkouts;
the store adapter remains immutable control tooling. The unsigned builder runs the pinned source
archive with a positive, non-secret environment allowlist and persists an xcarchive directory
package or AAB before the trusted signer receives it. The signer and store adapter receive only
their explicit request and trusted credential allowlists, and never execute game source scripts.
The private workflow template is `docs/release/mobile-private-control-mac-workflow.example.yml`.
It copies `coordinated-mac-isolated-build-supervisor.mjs` from the pinned tooling checkout and
requires its SHA256 before reservation. The supervisor sends a non-secret, operation-bound JSON
request to a root-owned `coordinated-mac-build-gate.mjs` installed outside both checkouts. The
trusted Mac sudoers rule permits only that exact gate path with no command arguments; the gate
validates the pinned source/tooling/request/profile hashes, checks the fixed non-admin build UID,
and starts the child with a fresh HOME/TMP, closed file descriptors, and an explicit environment.
It returns the operation quarantine to the trusted runner only after the child exits, recursively
drains the exclusive build UID, proves no descendant or open handoff file remains, removes build
write access, and makes the signed handoff read-only. Operation and work-directory parents grant
the build UID group traverse only (`0710`); immutable quarantine directories/files return as
trusted-owned `0500`/`0400`, while reusable request/sandbox work directories return as trusted-owned
`0700`/`0600` so retry and cleanup remain possible. Installed provider files are trusted-owned
`0755`: the build UID can read/execute the pinned builder but cannot modify it. The gate runs the unsigned
builder through macOS Seatbelt (`/usr/bin/sandbox-exec`) with explicit source/tooling read roots,
handoff-only write roots, and a literal `/dev/null` write allowance; the host HOME and common
credential locations remain outside the child policy. A nonempty
`COORDINATED_ISOLATED_BUILD_IDENTITY`, runner label, general `sudo -u`, or same-UID Seatbelt
process cannot satisfy this boundary. The controller performs the gate and target-root
preflight before reservation. If the root-owned gate, its fixed config, the distinct build UID,
Seatbelt, or any pinned hash is absent or changed, the controller keeps the operation at
`ACTION_REQUIRED_PROVISION_ISOLATED_BUILD` before reservation or store mutation.

The gate's root-owned configuration is fixed at
`/etc/ash-atlas/coordinated-mobile-build-gate.json` and contains the non-admin build UID/GID,
the trusted runner UID/GID, the allowed checkout parent, the durable handoff root, and a bounded
deadline. The private workflow supplies only the installed gate path and SHA256; it cannot change
the account, roots, or sudo command through workflow inputs.
It receives these flags and writes one UTF-8 JSON result to the supplied output path:

```text
--action start|resume
--operation-id <operation-id>
--generation <tNNN>
--server-sha <40-hex SHA>
--accepted-master-sha <40-hex SHA>
--current-server-sha <40-hex SHA>
--tooling-sha <40-hex SHA>
--handoff-root <durable private runner path>
--state-file <durable state path>
--plan-file <approved metadata plan>
--output <controller-result-path>
```

The result is an exact `ash-atlas-coordinated-mobile-result` object with one validated iOS and one
validated Android child receipt. The controller persists unsigned and signed manifest hashes,
stable adapter attempt IDs, pending response-loss state, registry receipt retries, and the
operation-bound seed. A new workflow URL reuses those protected files and reconciles an unresolved
remote step before retrying it. `tools/mobile-release/coordinated-bootstrap.mjs` checks the
candidate source/generation, artifact and tooling hashes, metadata/country/rollout approval, and
`${operation}:ios|android` child IDs before atomically writing `coordinated-seed.json` and
`coordinated-mobile-receipt.json`.

If the isolated builder, signer, trusted store adapter, signing account, store account, durable
handoff root, or required review/availability prerequisite is missing, the controller writes a
durable `ACTION_REQUIRED` result with the exact pinned tuple and leaves the pending step fenced.
It never fabricates a seed or candidate and never executes an untrusted provider from the checked-
out tag.

The protected `mobile-production` environment supplies
`COORDINATED_MOBILE_BOOTSTRAP_PLAN_PATH`, an absolute path outside the checkout. The plan is
schema `ash-atlas-coordinated-mobile-bootstrap-plan` version 1 and contains exactly `apps.ios`
and `apps.android`. Each app names an operation-scoped immutable copy of its metadata packet.
The materializer reads the authoritative distributed-source history before creating that copy and
advances each numeric marketing version above the current history. First publication or an
ambiguous store history requires an operation-bound `ash-atlas-coordinated-mobile-version-plan`
override; the controller persists its pinned tuple and refuses a version downgrade. Country scope,
rollout, metadata bytes, and all repeated values are checked before reserving a build. A
representative shape is:

```json
{
  "schemaVersion": 1,
  "kind": "ash-atlas-coordinated-mobile-bootstrap-plan",
  "apps": {
    "ios": { "metadata_packet_path": "/Users/release/handoff/<operation>/metadata/ios.json" },
    "android": {
      "metadata_packet_path": "/Users/release/handoff/<operation>/metadata/android.json",
      "managed_publishing": true,
      "first_publication_bootstrap_verified": false
    }
  }
}
```

The trusted store adapter allocates build numbers through `mobile-release-state`, imports only the
isolated unsigned artifacts, signs and verifies persisted bytes, records an availability-pending
receipt before each upload, and invokes production prepare/submit/reconcile actions with the exact
child operation IDs. A missing plan, credential, signing tool, metadata packet, compatibility
proof, or managed-publishing/first-publication prerequisite produces `ACTION_REQUIRED`; it does
not fall back to a manually copied artifact or guessed version. If Google Play leaves the exact
production edit in `draft` after the review submission request, the receipt records the exact
`ACTION_REQUIRED` console step (`Send for review`) and the controller waits for a fresh
`APPROVED_NOT_PUBLISHED` observation before continuing.

## Candidate identity

`prepare` records one candidate per platform in the dedicated production registry state. The
candidate binds:

- the accepted source SHA, generation, marketing version, build number, store build ID, and artifact
  SHA256;
- the tooling approval SHA and approval receipt;
- the metadata SHA256 and sorted country list;
- the first-publish or update classification and rollout mode/fraction;
- the live server protocol and hard-minimum proof; and
- the production store snapshot fingerprint observed during prepare.

The metadata hash is checked against the bytes of the approved packet supplied to every mutation
invocation. A platform country list must be representable by the store API before a write; this
adapter refuses an Apple country widening because Apple availability is not part of this guarded
pipeline, while Google country targeting is sent only for `inProgress` or `halted` releases.

The prepare request itself carries the verified release identity used by the metadata and store
policy checks. If a retry runs under a different workflow URL, the existing semantic candidate is
reused with its original tooling approval receipt; a changed artifact, policy, compatibility proof,
or activation fence cannot silently inherit that receipt.

The registry keeps an independent `ios` and `android` production baseline and append-only history.
An Android internal build or a beta release does not change either baseline. A changed store
snapshot, candidate identity, server compatibility result, activation intent, or registry baseline
fails before a store write. Every later invocation rebinds the candidate to the current tooling
SHA, release ID, source SHA, generation, an ancestry proof from the prepared master to the freshly
fetched master, metadata SHA256, countries, rollout, store build ID, and artifact SHA256. Release,
advance, pause, and resume also require an approval SHA256 equal to the prepared candidate or the
exact immutable rollout transition.

## Actions

| Action | Effect |
| --- | --- |
| `inspect` | Read production store history and the registry. It never writes. |
| `prepare` | Validate the exact existing internal artifact and persist a production candidate. With `dry_run=true`, it only prints the plan. |
| `cancel` | Abandon a rejected or abandoned candidate after the exact store snapshot and authoritative no-mutation receipts prove that no transition was published. The cancellation is idempotent and records a durable reason. |
| `submit` | Apple creates or reuses the exact manual App Store version, attaches the exact build, and submits it for review. Google assigns the exact version code to the production track as a draft while retaining every unrelated release. |
| `reconcile` | Re-read the store after an interrupted or uncertain operation. An operation is terminal only when the exact remote identity is observed or an authoritative no-mutation result is proven. |
| `release` | Performs the separately approved release. Apple sends the manual release request; Google changes the exact production release to its approved full or staged rollout. |
| `advance` | Moves a staged rollout to the next approved fraction or completion. |
| `pause` | Pauses the current staged rollout. Google uses `halted`; Apple pauses its phased release. |
| `resume` | Resumes a paused staged rollout. Google changes `halted` to `inProgress`; Apple changes `PAUSED` to `ACTIVE`. |

Each platform has its own operation ID and receipt. If iOS succeeds and Android is interrupted, the
next run reconciles Android without repeating iOS. A lost response leaves the operation unresolved;
the operator runs `reconcile` with that exact operation ID before any retry. Successful retries only
read the terminal receipt. A failed operation requires a new operation ID and a fresh store
snapshot proof. The registry write that marks an operation pending is committed before the
corresponding store mutation, and each remote substep records a stable request fingerprint and
returned store identity. An intermediate identity-bound result advances the operation CAS snapshot
and resumes only the next proven step; unchanged reads after a journaled write do not prove that no
mutation occurred. Each transition records its own expected remote snapshot so a normal submit,
review wait, and release sequence can advance the mutable store state without changing the immutable
artifact identity. `reconcile`, `cancel`, `release`, `advance`, `pause`, and `resume`
are run for one platform at a time because their operation or approval identity is platform
specific; `submit` may process both platforms independently.

## Apple rules

Apple versions use `releaseType=MANUAL`. The submission and the developer release are separate
actions. The first publish is manual only; Apple phased release is available for updates after the
version is released. The adapter only allowlists App Store Connect app-version, build linkage,
submission, manual-release, and phased-release routes. It does not expose beta review, metadata, or
arbitrary app writes.

The current API creates a review submission shell, adds the exact version as a review item, and
sets `submitted=true` on that submission. The retired `appStoreVersionSubmissions` create route is
not allowlisted. An update must have an `INACTIVE` phased policy verified before the manual release
request. A first publish may use a pre-provisioned manual App Store version or create the unique
version during the guarded submit; in both paths the approved localizations are verified before
attaching the exact processed build. A pre-provisioned version may have no build attached yet; the
adapter verifies the marketing-version identity and absence of a conflicting build before attaching
the exact processed build. Version,
  review-submission, item, and phased-policy identities are journaled, and a retry adopts a journaled
  remote resource instead of creating a duplicate after a lost response. If the review-shell create
  response is lost before its remote ID is journaled, `review_shell_adoption_id` supplies explicit
  operation-bound approval; the shell is re-read and must match the production app, iOS/manual
  candidate, adoptable state, and detached association before the exact version item is written. A rejected submission
receives a new submission identity. A release receipt is terminal only after a fresh read shows
`READY_FOR_SALE` or `READY_FOR_DISTRIBUTION`; `READY_FOR_REVIEW`, review queue states, and
`PENDING_DEVELOPER_RELEASE` remain non-terminal availability evidence.

The API supports creating an App Store version at
[Create an app store version](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-appstoreversions),
submitting a version through
[Create a Review Submission](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-reviewsubmissions),
adding the version through
[Create a Review Submission Item](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-reviewsubmissionitems),
and manually releasing an approved version through
[App Store version release requests](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-appstoreversionreleaserequests).
Apple documents phased release as an update-only capability in
[App Store Version Phased Releases](https://developer.apple.com/documentation/appstoreconnectapi/app-store-version-phased-releases?changes=la_9_6).

## Google rules

Google writes only the production track through a process-owned edit. The desired track body
includes every existing production release and the exact candidate version code, so an unrelated
release cannot disappear during an update. A first publish is recorded separately from an update
and must be a full release; a draft or newer internal build does not count as published production
history. The submit edit commits with `changesNotSentForReview=false`, which requests Play review;
managed publishing may still require the operator's separate `Publish changes` console action after
approval. A live production version/build may not be downgraded. Staged releases use an `inProgress`
release with an explicit `userFraction`; a pause uses `halted`, resume uses `inProgress`, and
completion uses `completed`. `userFraction` is omitted when the release is completed and
`countryTargeting` is emitted only for `inProgress` releases. A completed release can be halted only
when an older published completed release is available as the fallback; a first completed release
is refused. A halted release does not carry country targeting on the wire, so resume recovers the
approved scope from the durable candidate and refuses any scope that differs from retained store
evidence.

These status and country-targeting rules follow the official
[Google Play edits.tracks resource](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks).

## Server compatibility

`prepare` and every store action query the live compatibility endpoint for the exact candidate.
The candidate must overlap the server protocol and meet the server hard minimum. If the daily server
release changes while a store candidate is pending, the action fails closed until a fresh compatible
  proof is recorded. A confirmed Google production assignment waiting for review or publication
  releases the short mutation CAS fence for staged releases, full first publication, and approved
  rollout transitions, so a compatible daily server activation can proceed while the candidate remains
  durable and the production baseline stays unchanged. Unknown or unresolved store outcomes retain
  the fence.

## Recovery

Do not rerun `submit`, `release`, `advance`, `pause`, or `resume` blindly after a timeout. Run
`reconcile` with the same candidate and operation identity. The registry receipt records the observed
store identity and the result. An identity-bound partial result advances the remote CAS snapshot and
allows the same operation to resume only after its completed substeps are recorded; unresolved
substeps remain blocked. A failed or partially successful platform remains active until its own
terminal receipt is recorded; production baselines advance only after a terminal release receipt. A prepared
candidate can be replaced only with `cancel`, after the exact candidate fingerprint, prepare-time
snapshot, and no-mutation proof are checked. Unknown observations stay pending.

The focused fixture suite uses mocked store adapters and disposable registry files. It covers wrong
identity with zero writes, response loss, partial platform success, first publish, a newer internal
Android build, a server activation race, unrelated production releases, cumulative production
source history, review/publish state, phased policy, country scope, metadata packet drift, and
lifecycle transitions. It never calls Apple or Google production services.
