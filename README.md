# Ash Atlas

> **Archived - no longer developed.** This is a frozen snapshot, released for anyone to read, fork
> and reuse. Issues and pull requests are not reviewed (see [CONTRIBUTING.md](CONTRIBUTING.md)).
> Suggested topics: `mmo`, `location-based`, `capacitor`, `pixijs`, `postgis`, `typescript`, `game`.

Ash Atlas is a location-based mobile MMO: an authoritative multiplayer game with a React client
(wrapped for iOS/Android with Capacitor), a Node.js server, and PostgreSQL/PostGIS persistence.

**Ash Atlas is no longer in development.** It is released free for any use, including commercial
use, under the licenses below. No live server is provided; to run the game you host your own, and
all secrets and keys must be supplied through environment variables (see `.env.example`).

## License

- **Source code**: MIT, see [LICENSE](LICENSE).
- **Art, images, audio, music, and documentation**: CC BY 4.0, see
  [LICENSE-ASSETS.md](LICENSE-ASSETS.md). Attribution line: "Ash Atlas by TonyTorzido".
- Exceptions: Cinzel font (SIL OFL 1.1), Phosphor menu icons (MIT), Gradle wrapper (Apache-2.0), and
  the population grid data (CC BY 4.0, see [THIRD_PARTY_DATA.md](THIRD_PARTY_DATA.md)). Map data
  attribution (OpenStreetMap, Natural Earth) is in [LICENSE-ASSETS.md](LICENSE-ASSETS.md).

## Overview

The runtime includes world movement and flag travel, harvesting and inventory, equipment and
combat, progression and classes, social and party systems, settlements and markets, and enterable
dungeon and interior locations. A separate map data pipeline (not included) supplied
the pinned World API and spatial data; this repository owns player state, gameplay, persistence,
and presentation.

| Path | Responsibility |
| --- | --- |
| `apps/client` | Browser/native client: UI, map rendering, domain commands |
| `apps/server` | Authentication, HTTP/realtime boundaries, authoritative gameplay, persistence |
| `apps/appearance-studio` | Appearance and content authoring UI |
| `packages/shared` | Shared contracts, protocol schemas, catalogs, deterministic calculations |
| `packages/player-renderer`, `packages/animator` | Player appearance rendering and animation tooling |
| `ios`, `android`, `capacitor.config.ts` | Native client hosts |
| `tools/` | Dev runtime, release, and maintenance tooling (PowerShell-based) |
| `docs/` | Architecture, design, build-bible standards, and plans |

Good starting points: [World data and World API](docs/WORLD_DATA.md),
[known gaps and ideas for forks](docs/IMPROVEMENTS.md),
[application map](docs/architecture/current-application-map.md),
[Build Bible](docs/build-bible/README.md), and
[production authentication](docs/production-authentication.md).

## Running locally

Requirements: Node.js 24 (`>=24 <25`), pnpm 11 (exact version in `package.json`), and Docker (for
PostgreSQL/PostGIS).

1. `pnpm install --frozen-lockfile`
2. Copy `.env.example` to `.env` and fill it in. Every `*_HMAC_KEY` is blank on purpose: generate a
   random 32+ byte value for each. Provider keys (Resend, Apple, Google, etc.) are optional and
   left empty.
3. Start the database: `docker compose -f docker-compose.dev.yml up -d` (PostGIS on
   `127.0.0.1:35432`, matching `DATABASE_URL` in `.env.example`).
4. Load `.env` into your shell. The server does not read it by itself. On Linux/macOS:
   `set -a; . ./.env; set +a`. In PowerShell, set the variables from `.env` (for example with a
   small loop over its lines).
5. `pnpm db:migrate`, then `pnpm dev` (starts the server and the client together; the client dev
   server listens on port 5270).

Development movement and tick tuning (defaults in `.env.example`):

```
PLAYER_SPEED_MPS=125
SERVER_TICK_HZ=20
WORLD_DELTA_HZ=20
```

The server also needs a **World API**, an HTTP service that answers land/water, biome, overlay and
settlement lookups for a coordinate. The service and its map data pipeline are not part of this
repository. [docs/WORLD_DATA.md](docs/WORLD_DATA.md) documents the endpoints, the source datasets,
the pinned identity in `config/world-runtime.lock.json`, and a minimal path for local development.
Known gaps in this snapshot are listed in [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md).

### What runs without the World API

- Unit tests and typechecks: `pnpm typecheck`, `pnpm test:unit` (database suites need a disposable
  PostgreSQL database), `pnpm test:architecture`.
- The shared packages, the animator/appearance tooling, the player renderer, and the client UI in
  isolation (component and browser tests).
- The server boots against PostgreSQL and serves auth, inventory, combat and other non-spatial
  systems, but anything that needs land/water/overlay lookups (movement on the real map, flags,
  settlements, spawns) needs a World API that implements the lookup contract, or your own
  equivalent. Degraded world lookups are disabled in `.env.example`.
- Native builds need your own Firebase config (copy the `.example` files for
  `google-services.json` and `GoogleService-Info.plist`), Apple team ID and signing identities.
  `apps/client/.env.capacitor*` point at the original author's hosting; change them to your own.

Many dev and release scripts under `tools/` and `config/dev-runtime.defaults.json` assume the
original author's Windows layout (`C:\Users\dev\...`); adjust those paths for your machine. The
release and VPS tooling describes the original hosting and is not runnable as-is (see
[tools/release/README.md](tools/release/README.md)).

### Unpublished documents

Some plan and design documents were not published with this snapshot, so code comments may cite
plans (for example `docs/plans/class-roster-v2.md` or `docs/design/WATER_GAME_PLAN.md`) that are not
present here.

## Checks

| Command | Coverage |
| --- | --- |
| `pnpm typecheck` | Workspace TypeScript contracts |
| `pnpm lint` | Repository lint rules |
| `pnpm test:unit` | Workspace unit tests (database suites need a disposable test database) |
| `pnpm test:architecture` | Import/ownership guardrails |
| `pnpm build:production` | Server and client production bundles |

Bug report emails are sent only if `BUG_REPORT_NOTIFICATION_RECIPIENT` is set.
