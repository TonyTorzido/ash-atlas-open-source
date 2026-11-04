# Coordinated production release

The coordinated release keeps the currently active server in place while one exact iOS artifact
and one exact Android artifact move through store approval. The pinned server generation is a
durable `test/tNNN` identity. Integration may advance while the operation waits; the coordinator
publishes only the pinned generation after both app gates pass.

The canonical entry point is `tools/release/accept-and-publish-test-server.ps1`. A new
`CoordinatedRelease` operation reads the mobile worker's manifest, records an append-only journal,
and returns a durable waiting result when a store approval or external console action is pending.
`Inspect` reads that manifest without mutation. `Resume` re-reads the exact child receipts and
continues the first incomplete phase. The operation does not retain a process lease while it waits.

## Durable interface

The manifest uses `schema_version: 1` and `kind: ash-atlas-coordinated-release`. Its pinned identity
contains the exact generation, server SHA, accepted integration SHA, accepted master SHA, and the
server SHA that was active when the operation started. It contains one `ios` and one `android`
candidate with the exact release ID, source SHA, generation, marketing version, build, store build
ID, artifact SHA256, tooling SHA, metadata SHA256, sorted country list, rollout policy, and child
operation ID.

The coordinator stores sidecars in its state root:

```text
<operation-id>.coordinated-manifest.json
<operation-id>.coordinated-journal.json
<operation-id>.coordinated-mobile-dispatch.json
<operation-id>.coordinated-post-health-dispatch.json
<operation-id>.coordinated-server-evidence.json
<operation-id>.coordinated-server-evidence.authenticated.json
<operation-id>.batch-request.json
<operation-id>-admission.batch-validator-receipt.json
<operation-id>-admission.batch-admission-manifest.json
```

The mobile worker supplies the `ash-atlas-coordinated-mobile-result` object. Its `receipts` array
contains exactly one `ash-atlas-mobile-child-receipt` for each platform (top-level `ios`/`android`
and `platforms` aliases are accepted for compatibility). Each child carries the exact
`${coordinatedOperationId}:ios` or `${coordinatedOperationId}:android` operation ID, candidate,
submitted/store state, approval fingerprint, metadata hash, and later release/public evidence. The
PowerShell coordinator recomputes the approval fingerprint from the candidate packet and refuses
any supplied mismatch, child ID change, or candidate identity change.

Before the mobile bootstrap, the trusted controller accepts one ordered `batch_request` JSON array:

```json
[
  {"branch":"feature/example","sha":"<40 lowercase hex>","player_patch_note":"A player-facing note."},
  {"branch":"fix/example","sha":"<40 lowercase hex>","player_patch_note":"A second player-facing note."}
]
```

It resolves each branch to exactly one registered clean worktree, verifies the worktree HEAD and
`origin/<branch>` equal the requested SHA, and writes the request plus resolved paths before invoking
the canonical `IntegrateBatchAdmission` child operation. The child receives one durable UTF-8
admission manifest containing the aligned worktrees, branches, SHAs, and notes. This avoids native
PowerShell argument array flattening and keeps Resume bound to the original packet. The child receives
the aligned `FeatureWorktrees`, `FeatureBranches`, `FeatureTipShas`, and `PlayerPatchNotes` plus explicit
`ConfirmBatchAdmission`, `ConfirmIntegration`, `ConfirmGenerationCheckpoint`, and
`ApprovedIntegrationTest`; confirmations are never inferred. The child records the frozen original
integration/master/generation tuple before merge work, then records `accepted_integration_sha` and
`accepted_generation` after the atomic `integration/test` plus gameplay-tag publication. This mode
does not call the VPS, move `master`, or issue mobile release requests. Resume reuses the same durable
packet and child operation rather than taking a newer integration snapshot.

Admission is fail-closed until the configured supervisor implements
`ash-atlas-isolated-uncredentialed-vm/v1`. The controller sends it exact baseline and candidate Git
bundles and a request bound to operation ID, candidate SHA, baseline SHA, batch manifest hash,
tooling SHA, validation-plan hash, and toolchain fingerprint. The supervisor runs the plan in an
uncredentialed VM and returns a receipt containing those identities, validator ID and image digest,
one successful result per gate with stdout/stderr/log SHA256 values, `receipt_sha256`, and an
HMAC-SHA256 signature using `ASH_ATLAS_BATCH_VALIDATOR_HMAC_KEY` held by the host supervisor. The
receipt canonical payload excludes `receipt_sha256` and `signature`; both `receipt_sha256` and the
HMAC are computed over that same recursively sorted payload. The controller verifies the receipt
hash and HMAC in constant time before any integration/tag mutation;
the trusted controller never runs candidate checks under its credentialed process identity.

After server health, the controller exports one immutable evidence envelope bound to the operation ID,
generation, server SHA, accepted master SHA, both child IDs and approval fingerprints, and the public
health receipt. The trusted Windows transport signs it with HMAC-SHA256 using the base64
`COORDINATED_SERVER_EVIDENCE_HMAC_KEY` (at least 32 bytes), writes it to the local,
ACL-protected `server_evidence_file`, and passes the exact bytes as `server_evidence_base64` with
`server_evidence_sha256` through private workflow dispatch using `action=post-health`. The envelope
is limited to 32 KiB. The Mac verifies the transport hash and materializes the bytes under its own
durable handoff root, bound to the operation and dispatch nonce. It then verifies the HMAC in constant time, rejects a changed nonce or receipt
hash, and only then performs app release requests. The post-health artifact may contain the receipt
alone; the initial exact seed remains durable on Windows. The two hosts need no shared mount. The
HMAC key remains a secret on each host. The signed envelope contains release evidence, not
credentials; it is carried in the private control workflow inputs, where base64 is only an encoding.

Canonical JSON recursively sorts object keys by ordinal UTF-16 order, preserves array order, uses
compact UTF-8 JSON, and excludes `hmac_sha256` and `receipt_sha256` from the HMAC input. The receipt
hash is SHA-256 over the same canonical object after adding `hmac_sha256`. The cross-language fixture
uses payload `{"a":"x","b":2,"n":[true,null]}` and key bytes `00..1f`: HMAC
`cd5f98f09d7136559555dde956242d5b3641833f8c984721cc9a3278c1e1d525`; adding that HMAC as the
`hmac_sha256` field gives receipt hash
`7fd3ca49814ace17063a68290955832479a10743c120bc7aba452174036b70d3`.

## Gate order

The journal advances through this fixed sequence:

```text
manifest_created
  -> apps_submitted
  -> apps_ready
  -> server_published
  -> server_activated
  -> server_healthy
  -> apps_release_requested
  -> completed
```

`apps_ready` requires Apple `PENDING_DEVELOPER_RELEASE` and Google
`RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED` with managed publishing verified. A first Google
publication also requires an explicit bootstrap proof and a full rollout. The coordinator then
publishes the pinned master generation, activates it, and proves host, World, public release, and
browser health before the mobile release requests are accepted. Completion requires Apple
`READY_FOR_SALE` or `READY_FOR_DISTRIBUTION` and Google
`RELEASE_LIFECYCLE_STATE_PUBLISHED` for the exact artifacts.

Before PREPARE, the server coordinator creates an operation-owned detached worktree at the pinned
server SHA and records its path and head in the durable state. Mobile compatibility, activation,
and public verification read that detached tree, so an advancing `integration/test` checkout cannot
silently change the candidate while store approval is pending. Resume reuses the same path only
after proving its exact SHA, detached state, and cleanliness.

## Mac accessible trigger and trusted controller

`tools/release/request-coordinated-release.sh` is the one-command MacBook request surface. It sends
`start`, `inspect`, or `resume` to the private control repository with `gh`; `start` accepts the
optional third argument (a path or inline value) for the ordered `batch_request` JSON. It never
handles store, VPS, or signing credentials. Until that repository is provisioned it exits with
`ACTION_REQUIRED`.

Provision the private controller from `tools/release/coordinated-release-control.example.json` and
`coordinated-release-control-workflow.example.yml`. The controller runs as the dedicated
`AshAtlasCoordinatedReleaseRunner` account with an ACL-protected state root, derives the current accepted
generation and public server identity, invokes the mobile bootstrap child for both exact candidates,
creates the immutable seed, and invokes the pinned `tools/release/accept-and-publish-test-server.ps1`.
The source checkout supplies the accepted generation snapshot; the separate tooling checkout supplies
the controller, canonical coordinator, and generation scripts. Its bounded schedule may call `Resume`
only for active manifests. Manifest and receipt paths are derived under that state root; they are not
workflow inputs. Provisioning must replace the example tooling placeholder with the exact clean
immutable tooling checkout HEAD SHA and configure both checkout roots; the controller rejects a
different or dirty tooling checkout, source checkout, or integration worktree. The source checkout and
integration worktree are the game Git/ref authority; the separate tooling checkout supplies only pinned
executables. It stops with `ACTION_REQUIRED` when
the mobile seed, Google first-publication bootstrap, or store console action is unavailable.

The control workflow checks out only the private control repository. It reads
`trusted_controller.controller_script` from the ACL-protected control configuration and invokes that
absolute path in the separately pinned, clean tooling checkout; it does not assume the controller
script is present in the control repository or mutable source checkout. The scheduled `resume-active` action enumerates at most 16 active
durable operations and skips terminal operations. A Mac request therefore needs only the request surface
and the trusted control workflow; state paths and the initial operation ID remain controller-owned.

The Windows controller does not build iOS locally. The configured mobile transport dispatches the
private control workflow `coordinated-mobile-bootstrap.yml` to the dedicated
`ash-atlas-mobile-control` macOS runner at its immutable control ref. The dispatch carries the game
source SHA as `server_sha`, the exact generation, accepted/current server identities, and separate
immutable `control_sha` and `tooling_sha` pins. It polls a run whose `headSha` equals the pinned
control SHA and whose workflow run name equals the immutable dispatch name. Before dispatch, the
Windows transport journals a schema 2 record with a random 128-bit `dispatch_nonce`, derives the
run name from that nonce, and passes the nonce as a workflow input. A lost dispatch response can
therefore be reconciled by the exact name or safely retried with the same fence; multiple matches
remain `ACTION_REQUIRED`. Artifact presence is checked only after the exact run is complete. The
transport then downloads the named `ash-atlas-private-mobile-<operation-id>` artifact. The artifact
contains one `coordinated-result.json`; the Windows transport materializes the initial seed
and receipt with `tools/mobile-release/coordinated-bootstrap.mjs`, then verifies operation,
generation, server SHA, both `${operation}:ios|android` child IDs, candidate hashes, approval
fingerprints, and receipt hashes before atomically copying the files under the Windows state root.
The `post-health` action may return only the result receipt because the initial seed and its pinned
tuple are already durable. The private control repository, control workflow ref/SHA, private tooling
SHA, and mutually mounted evidence path are required configuration; placeholder values leave the
controller `ACTION_REQUIRED`.
For post-health evidence, `receipt_sha256` is the canonical authenticated envelope fingerprint with
that field excluded; the transport separately journals the SHA256 of the exact UTF-8 evidence bytes.
`tools/release/coordinated-mobile-bootstrap-transport.example.ps1` is the reviewable transport
implementation for the private control repository.

## Server/web-only Game Update

`tools/release/request-game-update.sh` dispatches the separate private control workflow
`game-update-control.yml`. Before a `start`, it resolves and displays the exact current accepted
`integration/test` generation and SHA, then asks for one `y` confirmation. The workflow receives the
pinned tuple and an explicit exact-publish confirmation. This path updates the accepted server/web
build only; it does not enter the mobile signing or store delivery flow. `inspect` and `resume` take
the durable operation ID printed by the controller.

The workflow checks out only the private control repository, reads the ACL-protected
`C:\ProgramData\AshAtlas\CoordinatedRelease\control.json`, and invokes the absolute
`tools/release/game-update-controller.ps1` path beneath `trusted_controller.tooling_checkout_root`.
The wrapper requires the configured runner account, verifies that the tooling checkout is clean at
the exact `source_policy.allowed_tooling_sha`, checks the configured source and integration
checkouts and state root, and invokes the canonical publish coordinator with the pinned tuple.
The canonical coordinator compares that tuple before release-side effects and again immediately
before VPS PREPARE, so a newer accepted integration generation cannot replace the Mac-approved
candidate. `inspect` and `resume` continue to use the canonical coordinator's durable operation
state.
