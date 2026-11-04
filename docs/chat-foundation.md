# Shared Chat Foundation

Step 1 provides one durable, authenticated public-chat system for General, Trading, and Hunting. It uses the game's existing WebSocket connection and PostgreSQL database. It does not create separate room pipelines or put a moderation model in message delivery.

## Generic channel architecture

Migration `0500_chat_foundation.sql` deterministically seeds:

- `public:general` — standard public rate policy
- `public:trading` — stricter repeat/spam policy
- `public:hunting` — standard public rate policy

Every channel row carries its stable key, type, display name, visibility, send-access, retention, rate-limit, moderation, activity, and timestamps. The same model is deliberately shaped for future `kingdom:`, `party:`, `alliance:`, and `direct:` keys, but those channel types and their authorization adapters are not implemented in Step 1.

## Durable messages and ordering

The server derives sender identity and display-name snapshot from the authenticated gameplay connection. It normalizes CRLF/CR to LF, rejects blank/control-character text, and enforces a configurable maximum no greater than 400 Unicode characters. Client sender IDs, timestamps, sequence numbers, and moderation claims are not accepted by the protocol.

PostgreSQL assigns a monotonically increasing sequence inside each channel transaction. An advisory transaction lock serializes a sender/request ID while the channel counter row serializes sequence allocation. Unique `(channel_id, sequence_number)` and `(sender_player_id, client_request_id)` indexes provide durable race-safe ordering and idempotency. Server creation time is authoritative. React renders message bodies as plain text; raw HTML is never injected.

## WebSocket flow and subscriptions

The existing authenticated `/ws` connection carries these typed messages:

- Client: `CHAT_SELECT_CHANNEL`, `CHAT_SEND`, `CHAT_HISTORY_REQUEST`, `CHAT_READ_UPDATE`
- Server: `CHAT_CHANNELS_SNAPSHOT`, `CHAT_CHANNEL_SELECTED`, `CHAT_SEND_RESULT`, `CHAT_MESSAGE`, `CHAT_HISTORY_RESULT`, `CHAT_PREVIEW_UPDATE`, `CHAT_READ_STATE`, `CHAT_MUTE_SNAPSHOT`

The client creates a UUID, inserts a pending row immediately, and sends `CHAT_SEND`. The server validates access, durable mute state, channel policy, and text; commits the message; assigns its sequence and time; broadcasts to active-room subscribers; and returns the authoritative result. The sender reconciles by request ID. A failure becomes a bounded retryable failed row.

Each connection has one active full-message subscription plus lightweight preview subscriptions for the three public rooms. Switching removes the old active subscription before history awaits, and a per-connection generation suppresses stale responses from rapid room changes. History responses merge with full messages delivered during the switch, closing the snapshot/subscription race. Disconnect cleanup removes every active, preview, read-state, and selection entry. Duplicate subscriptions use sets and cannot duplicate a rendered message. No polling or per-room WebSocket exists. The WebSocket server rejects frames above 64 KiB before JSON parsing; chat's schema-level body limit is much smaller.

## Bounded memory and rendering

PostgreSQL is durable history. Neither runtime loads all chat at startup.

Client limits:

- Active channel confirmed messages: 200
- Each inactive channel recent messages: 10
- Pending messages: 20
- Failed messages: 20
- Expiring message/sequence dedupe keys: 1,000
- Preview body: 120 characters
- Store subscribers: 32

Switching rooms prunes the previous room immediately, and every late event/history response re-applies the inactive cap. Dedupe references expire and remain capped. The panel renders only the bounded store window, so DOM rows cannot grow with durable history. Chat state subscribes inside a memoized, isolated `ChatSurface`; stable row DTOs and memoized message rows prevent unrelated gameplay or preview updates from rebuilding the rendered list.

Server limits:

- Recent cache: 100 messages per channel
- Cached channels: 256 with idle expiry
- Rate buckets: 50,000 with idle expiry
- Preview subscriptions per connection: 32
- Public channel definitions returned at bootstrap: 32
- Moderation dispatch queue: configurable, 256 in the default environment

The server holds no global full-history array and no per-message listener. PostgreSQL cursor queries are the history source. The operational maintenance pass prunes expired recent-channel entries and idle rate buckets even when traffic stops.

## History, reconnect, and unread state

Opening a room requests the newest configured page (maximum 50). Older pages use `sequence_number < oldest_sequence` and are limited to that page size; there is no page-number pagination. Prepending preserves the scroll viewport. When paging moves the bounded 200-row window away from the live tail, the store records an explicit newer-tail state: live arrivals update preview/unread without jumping across a sequence hole, and `Jump to newest` requests a fresh bounded tail. If the user is already at the bottom, new messages remain pinned. If the user has scrolled upward or closed the panel, new arrivals do not force scroll and increment a `new messages` indicator.

The client retains each channel's last confirmed sequence. An unexpected mobile disconnect turns unresolved sends into bounded retryable failures with their original idempotency IDs, uses bounded consecutive-failure backoff, repeats authenticated `HELLO`, restores public previews, then requests only messages after the selected room's last sequence. Catch-up uses the configured cap (maximum 100). A larger gap produces a reset to the newest bounded page rather than an enormous response. Message ID and sequence dedupe prevent reconnect duplicates and out-of-order gaps mark the room for a safe refresh.

`chat_channel_read_states` stores one monotonic cursor per player/channel. Unread count is `latest_sequence - last_read_sequence`; no unread-message array is retained. While pinned, newest-sequence changes are coalesced into durable read updates, and delayed acknowledgements merge monotonically rather than regressing local state. The cursor does not advance while the panel is closed or scrolled up. Counts survive reconnect and display as `99+` above 99.

## User interface and blocks

The persistent mobile-first chat bar shows the selected room, latest confirmed sender/body preview, and unread badge. The room selector remains quick while the main button opens cached chat even offline. Selection is remembered locally, defaulting to General.

The bounded panel provides room tabs, older-history loading, safe text rows, character count, pending/failed/retry states, rate feedback, mute expiry, a new-message jump button, and a compact composer. It avoids per-message animation and heavy profile cards. Sender names retain a small profile extension point.

The existing Profiles block list is reused client-side. Chat content remains neutral until the initial bounded block-list fetch completes, and a successful local block/unblock mutation refreshes it immediately. Messages from blocked senders are hidden without altering public channel history or sequence continuity, and blocked previews show a neutral placeholder. The sender receives no information about who blocked them.

## Optional message translation

The chat action menu can request a translation for one existing visible durable message at a time;
translation is opt-in per message and never runs automatically. The
authenticated server retrieves the message after applying the same channel and membership checks
as history, then sends only that authoritative text to Google Cloud Translation Basic v2 using the
NMT model. The browser sends a message ID and one of the supported target languages (`en`, `es`,
`fr`, `de`, `pt`, or `ja`); it never receives or stores the provider key and cannot submit
arbitrary text to this endpoint. The provider is optional: leave `CHAT_TRANSLATION_GOOGLE_API_KEY`
blank to show a temporary unavailable state. `CHAT_TRANSLATION_TIMEOUT_MS` bounds provider waits
and defaults to five seconds. Completed translations are cached by message identity, target,
provider, model, and version. A durable UTC-calendar-month source-character ledger enforces
`CHAT_TRANSLATION_MONTHLY_CHAR_CAP`, which defaults to 450,000 and may only be lowered. Provider,
quota, and network failures leave the original chat message unchanged and do not consume the
monthly character budget.

### Google Cloud setup

Create or select a Google Cloud project, enable the **Cloud Translation API**, and create an API
key restricted to that API. Supply the key only to the server runtime as
`CHAT_TRANSLATION_GOOGLE_API_KEY`; do not put it in client build variables, browser storage, or
source control. The Basic v2 endpoint accepts the server-side key and uses only NMT text
translation. The default application ceiling is 450,000 source characters per UTC calendar month,
below Google's recurring 500,000-character free NMT allowance; lower it with
`CHAT_TRANSLATION_MONTHLY_CHAR_CAP` when desired. Changing the key or cap requires a server
restart.

## Rate limits and mutes

Rate policy is centralized and data-driven. General/Hunting allow a short burst of five and sustained refill; Trading allows a burst of three, slower refill, and a longer duplicate window. The server returns explicit rate or repeat rejection codes with retry timing. The bounded single-process limiter is replaceable when multi-instance routing arrives; durable correctness does not depend on it.

`chat_mutes` supports global-chat and channel scopes, system/automated/human sources, reason and actor metadata, expiry, revocation, moderation linkage, and semantic idempotency. Conflicting reuse of an idempotency key or decision linkage is rejected. Every send queries active, unrevoked, unexpired PostgreSQL state. Reconnect cannot bypass it. A mute rejection immediately updates the local expiring composer state, whose server expiry is re-evaluated without requiring reload. Automated duration is capped by an explicitly supplied server limit; normal WebSocket clients have no mute mutation command.

## Moderation integration and safeguards

After authoritative acceptance, a bounded asynchronous dispatcher emits only message ID, channel ID/key/type, sender player ID, text, server time, and policy version. It excludes sessions, authentication secrets, coordinates, inventory, account data, and social relationships. In-process consumers work now; local HTTP and queue consumers can implement the same transport-neutral interface later. Enqueue is constant-time and schedules consumer work for a later event-loop turn. Retry, capacity, duplicate, failure, and dead-letter metrics are bounded. Consumer failure never rolls back or delays accepted chat delivery.

The private moderation decision service accepts a stable decision ID, message/player identity, categories, confidence, recommendation, scope/duration, model/rules/policy versions, and reason. PostgreSQL audits the recommended and applied actions separately. Low-confidence or non-severe decisions only flag for human review. Only configured severe categories above the confidence threshold can hide or issue temporary mutes. Automated mutes cannot exceed the server maximum, exact duplicate decisions replay while semantic conflicts are rejected, permanent bans are impossible through this interface, and reversal revokes linked mutes and records its actor/reason. Reversing one hide cannot reveal a message still covered by another active hide decision. The bot has no unrestricted database contract and no public client endpoint.

## Operations and validation

Structured counters cover accepted/replayed/rejected messages, rate events, database insertion and history latency, reconnect catch-ups, bounded snapshots, active subscribers, cache/bucket sizes, delivery latency, moderation queue depth/failure/overflow, and automated decisions. Logs contain IDs and policy metadata, not message bodies. The chat panel exposes its current bounded loaded-row count for development inspection.

Integrated main runtime allocation:

- Launcher: `Run Ash Atlas.cmd`
- Branch: `feature/progression-foundation` (validated through `integration/chat-foundation-merge`)
- Integrated frontend: `5173` with Vite strict-port mode
- Integrated backend: `3000`
- Retained main database: `ash_atlas_game` on `127.0.0.1:35432`
- Shared container: `ash-atlas-postgis`

## Deferred features

The following are intentionally not implemented in Step 1:

- Kingdom chat authorization adapter (Kingdom chat must use this shared foundation)
- Party and Alliance chat
- Direct messages
- Item links or trade execution
- Moderator dashboard
- Player reports UI
- Message editing and full deletion workflows
- Redis or multi-instance pub/sub
- Production AI moderation model
- Voice chat
