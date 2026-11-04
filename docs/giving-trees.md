# Giving Trees

All living trees retain their authoritative healing aura: 3 health on entry and every 1.4 seconds
within 50 meters. Overlapping auras do not stack; leaving resets the cadence. Berry
harvesting never removes a living tree or interrupts its aura.

Within the existing Giving Tree variety, the deterministic 60% formerly resin-capable trees now
supply Giving Berries and display as Giving Tree (Fruiting) while berries are available. The
remaining Giving Trees stay plain and offer no secondary harvest. Each berry harvest yields one
item per tree life (plus the existing Forestry District bonus), takes 600ms, and leaves the tree
available for chopping. After gathering, the tree uses plain artwork and the Giving Tree name
until the next tree life. Willow and Chinese Pistache remain unchanged. Trees no longer yield
resin; existing resin items, drops, and crafting ingredients remain intact.

Giving Berries restore 4 health immediately and five more 4-health ticks every 1.4 seconds, up to
24 health. Only one recovery effect can be active. Monk recovery speeds up the tick cadence while
nonaggressive; Hunting District preservation can spare the berry. Resin cannot be eaten and retains
its existing crafting ingredients, inventory balances, market identity, and rarity.

The existing secondary harvest command, depletion revision, and durable recovery table/fields
retain their historical resin names for compatibility; the authoritative item consumed is now
`giving_berry`. Existing durable active recovery effects finish normally.

## Player saplings

Plant a Giving Berry (or a pulled Giving Tree Sapling) from the Build menu, or with Plant in the
Inventory, on open land. Planting is refused:

- while aggressive, or on water;
- in a biome where trees do not grow, and the message names the biome. Allowed: Jungle, Pinewild,
  Greenwood, Frostwood, Plains, Savanna, Marsh, Highmeadow, Scrubland (dry hills with scattered
  woodland, like the Savanna) and Wilds (the unknown-biome fallback). Refused: Badlands, Steppe,
  Tundra, Frozen Waste, Coast, Open Ocean and Lake;
- inside another player's flag territory;
- within 90 m of another sapling or known tree (a 0.5 m tolerance, so two trees on the planting grid
  below never block each other).

**Quick slots and the planting planner.** "Plant Sapling" (Tools group) and the Shovel can be put in any quick
slot. Plant plants a Giving Berry (else a pulled sapling) where you stand. The planner is the "Tree planting
mode" tool in the flag builder's palette (hold the flag slot), or hold the Plant Sapling slot to open it directly: it draws the shared planting grid around you
(free points are rings, taken points red, your point highlighted) and Plant then goes to the grid point
nearest you instead of your exact spot. The grid is a world-anchored triangular lattice
(`packages/shared/src/treeLattice.ts`) whose neighbours are 90 m apart, the densest legal packing, so
everyone's forests line up: rows of constant latitude 90 x sqrt(3) / 2 m apart, a point every 90 m along a
row, odd rows shifted half a step. Unlike a plain per-row cos(latitude) step, which drifts apart
between rows by kilometres far from longitude 0, rows share one longitude step per 170-row band
(about 13 km north-south), so the lattice is regular everywhere except a seam row at each band edge.
`PLANT_SAPLING` carries an optional `target`; the server re-snaps it to the lattice, refuses it when the
snapped point is farther than 20 m from the player's own position, and applies the biome, spacing,
territory and aggressive rules to that point.

There is **no limit** on saplings or grown trees: plant a forest. The 90 m spacing rule
and the cost of a berry per tree are the only brakes, and the server is built so unlimited trees stay
cheap (see "How it scales").

The sapling belongs to the planter and heals like an adult Giving Tree (same 50 m aura), with one
**a sick sapling does not heal.** A sapling is sick from one day after planting or tending
until someone tends it again.

- **Tending.** A sapling can be tended 1 day after it was planted or last tended, and dies if 2 days
  pass with no tending. Anyone within 20 m may tend any sapling: tending costs nothing and keeps a
  free healing aura alive for everyone, so it needs no ownership.
- **Maturity.** 6 days after planting, a sapling that never died becomes a permanent Giving Tree. There
  is no limit on grown trees. It heals, and grows one Giving Berry back every 6 hours; anyone in range
  can gather it, with the Grove Lore double-harvest chance (6/11/17%).
- **Chopping.** Anyone can chop a grown player tree for Wood through the normal harvest flow: same
  Resource Vision and range rules, timing, Wood yield, woodcutter bonuses and replay safety as a wild
  Giving Tree. The tree is removed permanently and never respawns. Saplings that are not grown cannot
  be chopped.
- **Grove Lore rank 2.** When the owner tends it, the sapling matures 4 days after planting instead.
- **Grove Lore rank 3.** Pull a sapling up (your own, or anyone's on unclaimed land or your own
  territory) to get a Giving Tree Sapling item back, which you can replant elsewhere as a fresh sapling.
- **Shovel.** With a Shovel in your inventory you can pull up any growing sapling (any growth, sick
  included), anyone's, anywhere, with no Grove Lore rank. The Shovel is not used up. Grown trees are
  still only chopped.

Tapping a sapling or grown tree on the map opens its prompt: owner, stage, growth, timers, and Tend,
Pull up (Shovel or rank 3), Gather berry or Chop.

### How it scales

Rows live in `player_saplings` (migrations 1015, 1018) and are the source of truth for mutations only.

- **Memory serves the map.** Every live tree sits in an in-memory index (a spatial hash grid plus a map)
  loaded once at boot in keyset pages and updated one tree at a time on plant, tend, sick, mature,
  chop, pull and death. A list request (`REQUEST_SAPLINGS`) never touches the database.
- **Compact rows.** A list row is `id, lat, lon, state, growth (0 to 10), phase, berryAvailable`. The
  owner and exact timers come from one single-tree read (`REQUEST_SAPLING_DETAIL`) when the player
  taps a tree.
- **Push, not poll.** A change is pushed as a small `SAPLING_DELTA` (upserts and removals) to the
  players within 800 m of that tree, found through the combat engine's spatial index and batched
  into one message per player. The client asks for the full list only on connect or reconnect, after
  moving more than 200 m from where the last list was taken, and as a 5-minute safety resync.
- **Bounded view.** A list is the nearest 500 trees within 800 m. A dense forest can only lose trees far
  beyond the 20 m interaction range.
- **Bounded sweep.** Each growing sapling carries one `due_at`: its next change (turning sick, dying or
  maturing). The 30-second sweep reads only rows whose `due_at` has passed (partial index) and does
  nothing when none are due.
- **One tree at a time for healing.** The combat engine's `player-saplings` tree source loads at boot and
  changes per tree; a sick sapling is out of it until tended.

Pure rules: `packages/shared/src/givingSaplings.ts`.
