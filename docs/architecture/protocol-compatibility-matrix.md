# Protocol compatibility contract

Wave 3A separates game release identity, World pipeline identity, and wire-protocol compatibility.
Protocol versions are small positive integers defined in shared source. They are not package
versions, Git SHAs, World identities, or PostgreSQL values.

## Legacy-safe discovery

The legacy `HELLO` remains exactly `{ type: "HELLO" }`. A new client advertises its bounded protocol
range and additive capabilities as bounded query metadata on the initial `/ws` URL. Accepted older
servers already ignore query metadata while matching the same `/ws` route, so they accept the new
client without a deliberate failed connection. Existing clients omit metadata and continue to send
the strict bare `HELLO`.

A new server treats absent metadata as the accepted legacy version. Valid metadata is negotiated
before session bootstrap. The server includes optional negotiated metadata in `WELCOME` only for a
client that advertised metadata. A new client receiving a legacy `WELCOME` without metadata uses
the accepted legacy path. No Wave 3A gameplay behavior is capability-gated.

Query values and capability count/length are bounded. Invalid or incompatible metadata is closed
with the canonical private protocol-incompatibility code and a fixed sanitized reason before
player application state is created. A confirmed incompatibility is terminal and never enters the
reconnect scheduler.

## Mandatory matrix

| Client | Server | Required and designed result |
| --- | --- | --- |
| existing legacy client | new server | no query metadata; bare `HELLO` is accepted as legacy and gameplay is unchanged |
| new client | existing legacy server | query metadata is ignored; bare `HELLO` succeeds; missing `WELCOME` metadata selects legacy |
| new client | new server | shared negotiation selects the highest mutually supported version and capability intersection |
| unsupported future client | current server | advertised minimum is above the server maximum; controlled terminal incompatibility close |
| current client | unsupported future server | incompatible `WELCOME` metadata produces bounded update-required state and no retry storm |
| absent protocol metadata | current implementation | accepted legacy version and empty negotiated capabilities |

## Shared decision contract

One shared negotiation function owns range validation and comparison for client and server. Its
typed results distinguish:

- compatible current;
- compatible legacy;
- incompatible peer too old;
- incompatible peer too new;
- invalid metadata.

Versions are finite positive safe integers within a small maximum. Ranges require `min <= max`.
Capability identifiers come from one stable explicit allowlist, are additive, and are intersected
without changing gameplay. Unknown capability strings do not grant behavior. Connection-local
state records only the negotiated result for observability and `WELCOME`; nothing is persisted.

## Compatibility failure behavior

Protocol incompatibility uses one shared private close-code constant and fixed bounded reason. It
contains no player identity or frame payload. Existing close code 4002 remains connection
replacement, and existing 4001 session-invalid behavior remains unchanged. Malformed JSON,
unknown frame type, malformed known frame, incompatible protocol, and transport failure remain
separate metric categories.
