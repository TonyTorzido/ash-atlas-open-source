# Realtime delivery policy

Every one of the 134 existing `ServerMessage` variants has an explicit canonical delivery class.
The table is exhaustive at compile time and its test fails if a new frame is unclassified.

| Delivery class | Canonical variants | Socket mode | Contract |
| --- | ---: | --- | --- |
| critical | 116 | critical | authority/session/mutation/error/result traffic; never intentionally skipped |
| replaceable-world | 8 | replaceable | already-replaceable player, manor, market, chat-preview/read replicated state |
| replaceable-combat | 2 | replaceable | `COMBAT_SNAPSHOT`, `COMBAT_DELTA` |
| replaceable-population | call-site override only | replaceable | only existing proven-safe nonterminal Population state |
| terminal-population | 2 | critical | `POPULATION_ZONE_DELTA`, `RESOURCE_VISION_READY` canonical terminal policy |
| recoverable-social | 6 | recoverable-social | durable DM bootstrap/history/list/open/sync/events recoverable by cursor |
| transient-social | call-site override only | transient-social | existing transient social/presence delivery only |

Explicit call-site modes preserve Wave 1 behavior. The registry default and all pre-registration or
request-scoped direct replies remain critical, avoiding accidental reclassification of legacy
mutation responses. Terminal Population readiness cannot become replaceable merely because its
name contains `POPULATION`.

## Publisher path

`RealtimePublisher` serializes one payload per publish, resolves delivery class once, and passes the
same serialized payload to all recipients. `ConnectionRegistry` owns recipient lookup and concrete
socket backpressure delivery; direct socket replies use the same policy/metrics engine. Raw socket
close remains a transport operation.

## Metrics

Authenticated `/api/dev/diagnostics/realtime` exposes bounded counters for frames/bytes by type and
class, skipped frames/bytes, serialization and send failures, backpressure closures, maximum frame,
current/maximum buffered amount, and broadcast recipient counts. These details are absent from
public `/health`.

The acceptance runtime observed 62 registered frames and 10 direct frames in the captured window,
zero skipped frames, zero serialization failures, zero send failures, zero backpressure closures,
zero buffered bytes, and a 10,962-byte maximum frame. Delivery-policy unit tests also preserve the
critical hard-buffer close and replaceable soft-buffer skip behavior.
