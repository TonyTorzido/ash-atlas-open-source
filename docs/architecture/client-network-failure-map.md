# Client network failure map

This map records the t090 boundary and the Wave 3A target. It does not change UI or gameplay state
ownership.

| Failure or event | t090 owner and behavior | Wave 3A boundary |
| --- | --- | --- |
| socket construction | `GameClient` calls `new WebSocket` | one raw browser transport owns construction |
| OPEN | resets retry count immediately, sends bare `HELLO`, starts ping | transport emits a generation-fenced event; retry success waits for compatible `WELCOME` |
| incoming text | `GameClient` parses once | transport supplies raw data to one complete protocol parser |
| malformed JSON | caught and surfaced as generic `onError`; unlimited occurrences | counted separately; bounded failure budget closes the connection |
| unknown frame type | cast and dispatched | rejected before application dispatch; counted; bounded close |
| malformed known frame | market-only runtime validation; otherwise unsafe | rejected by the exhaustive server-frame parser; counted; bounded close |
| incompatible `WELCOME` | no protocol concept | terminal update-required snapshot/callback; no reconnect |
| protocol close | no dedicated code | one canonical code/reason; terminal and observable |
| socket message | captured socket identity compared with current socket | raw transport generation fences every asynchronous event |
| socket error | generic error callback | generation-fenced transport failure metric and callback |
| socket close | clears ping, calls `onClose`, may schedule retry | close belongs to one generation; incompatible/session/replacement closes never retry |
| close during handshake | retry count was already reset at OPEN | attempt remains failed until compatible `WELCOME` |
| stale OPEN recovery | 20-second activity threshold; close then replace | transport closes the exact generation; stale callbacks cannot affect replacement |
| offline send | boolean `false` | typed `closed` outcome; no queue |
| throwing browser send | exception can escape | typed `failed` outcome with sanitized observation |
| successful send | boolean `true` | typed `sent` outcome |
| reconnect delay | deterministic 500 ms to 10 s exponential cap | bounded exponential delay with jitter and one timer owner |
| retry timer callback | checks only intentional disconnect | captures connection generation/epoch and cannot open for stale state |
| ping interval callback | cleared on close | captures active generation and cannot send on replacement |
| gameplay mutation offline | caller receives false/null; no replay | unchanged: no automatic replay and no outbound mutation queue |
| metrics | generic message/reconnect counters plus traffic trace | bounded counters for parse, validation, unknown, incompatible, send, reconnect, and stale-event failures |

## Failure budgets

Transient transport closes may continue to retry with one bounded timer and a capped delay. Protocol
failures are not transport retries: malformed/unknown frames consume a small per-connection budget,
confirmed incompatibility is immediately terminal, and all counters remain bounded. No raw frame,
player data, cookie, URL query string, or payload is placed in logs or metrics.

## Ownership constraints

- The transport owns the browser socket and raw send outcome only.
- The shared protocol parser owns wire validation and returns typed success/failure.
- `GameClient` owns connection policy, compatibility state, retry/ping scheduling, and application
  callbacks.
- `App.tsx` continues to consume `ServerMessage`; Wave 3A does not restructure it.
- Domain send methods remain intent-only and never replay automatically.
