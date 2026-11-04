# Kitchen + Simple Food

The Kitchen is a fixed outdoor Manor workstation. It uses the shared outdoor
station clearance and job/queue model; the station is visible to nearby
players, while each job and its output remain owned by the player who started
it. Construction costs 25 Wood and 10 Stone and takes 30 seconds. A cooking
batch takes 5 seconds. Retained species-meat recipes accept 10, 20, 30, 40,
or 50 units; universal ingredients accept 1–50 units.

The initial recipes are one input species per recipe:

| Recipe/input item | Output |
| --- | --- |
| `deer_meat` | 1 `simple_food` per 10 |
| `wolf_meat` | 1 `simple_food` per 10 |
| `hog_meat` | 1 `simple_food` per 10 |
| `bear_meat` | 1 `simple_food` per 10 |
| `alligator_meat` | 1 `simple_food` per 10 |
| `wild_meat` | 1 `simple_food` per 10 |
| `squid_meat` | 1 `simple_food` per 10 |

Combat V6 also gives every real killable mob one independent 5% chance to
drop exactly one non-edible Kitchen ingredient. The universal roll is uniform;
food balance lives in the ingredient's Kitchen output rather than in per-mob
drop chances. These ingredients use one input per batch and retain the
station's 1–50 input limit:

| Ingredient | Sources | Simple Food output |
| --- | --- | ---: |
| `frog_legs` | Frog | 1 |
| `crab_meat` | Coastal Crab | 2 |
| `jellyfish_jelly` | Jellyfish | 2 |
| `crawler_flesh` | Resin Crawler | 2 |
| `squid_cut` | Squid | 3 |
| `wolf_cut` | Wolf | 4 |
| `deer_cut` | Deer | 5 |
| `hog_cut` | Hog | 6 |
| `alligator_tail` | Alligator | 8 |
| `bear_cut` | Bear | 10 |
| `field_ration` | Goblin, Bandit, Mysterious Traveler | 4 |
| `hearty_ration` | Orc Brute, Ogre | 8 |
| `scorching_bird_meat` | Fire Bird | 20 |
| `zappy_bird_meat` | Lightning Bird | 20 |
| `freezing_bird_meat` | Ice Bird | 20 |
| `xoral_essence` | The Xoral | 20 |

`small_catch` and `elemental_ration` remain indefinitely available as
non-dropping compatibility ingredients for retained inventory and historical
Kitchen jobs. They are not remapped or deleted.

The V6 combat catalog no longer creates new carcass or body/flesh food-chain
drops. Historical carcass identities remain addressable only for durable
retirement/migration compatibility; live gameplay uses the retained meat
catalog directly.
retained player inventory and historical settlement replay.

`simple_food` is the first edible item. Consuming one removes exactly one item,
restores up to 100 Hunger, and clamps ordinary Hunger at 2,000. A full player
receives `You're already full.` and is not debited. Raw species meat and
universal combat ingredients have no edible action and remain Kitchen
ingredients. Simple Food is player-market
tradable and deliberately has no Goblin Market offer.

## Extension points

- Travel Hunger consumption belongs in the existing authoritative player
  persistence/mutation path used by `SimpleFoodService`; it is a separate
  travel action and does not add passive time drain. V1 charges only deliberate
  long-distance overworld World Map/flag jumps. The cost is
  `ceil(100 * authoritativeDistanceM / 5,000,000m)`, clamped to `1..100`,
  using the existing `WORLD_MAP_DISTANCE_AT_MAX_DURATION_M` range source.
  `travel_hunger_consumption_operations` is committed with the relocation and
  row-locked Hunger debit for replay and concurrency safety. Each party
  traveler pays their own distance-based cost. Manual movement, GPS Relocate,
  Manor/building and dungeon portals, respawn/recovery, reconnect recentering,
  and forced/admin relocation remain free. The authoritative travel snapshot
  refreshes the Hunger HUD immediately and reconnect reads persisted Hunger.
- Advanced meals extend `KITCHEN_RECIPES` and `KitchenRecipeDefinition` with
  additional typed input lines and output metadata. Do not collapse retained
  species meat into a generic item; this keeps future Bear Stew-style recipes
  possible while universal combat ingredients can use their own fixed yields.
- Saturation/over-cap Hunger belongs in the existing `HungerSnapshot` base
  capacity model. Advanced food may opt into an explicit over-cap rule; the
  ordinary Simple Food path must continue using
  `clampHungerForOrdinaryWrite`.
- Farming and fishing should add their own canonical item IDs and then reference
  them as Kitchen recipe inputs. They do not need Kitchen-specific authority or
  new location pipelines.

No dedicated production Kitchen art asset exists in this slice. The client
uses the canonical development artwork hook/fallback for the world marker and
item presentation; production Kitchen art can replace that hook later without
changing Kitchen identity or protocol.
