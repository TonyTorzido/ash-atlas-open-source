# Drowned City raid: build spec (water game phase E)

Status: spec, 2026-10-05. Builds on phases A-D (`docs/design/WATER_GAME_PLAN.md`). Recommended
answers to the open decisions (section 9) are used unless the owner says otherwise.

## 1. Layout

Id `drowned_city`, `party_ephemeral`, reset `when_empty`, `despawnAfterSeconds: 900`. Scaffold spec
`tools/appearance-studio/interior-specs/drowned_city.json` via `pnpm dungeon:scaffold`. 32 rooms, ids
prefixed `dc_`:

```
[world, afloat] <-> dc_sunken_stair (S world exit)
 -> dc_drowned_causeway -> dc_flooded_plaza -> dc_circle_of_tides (HUB, safe zone)
 HUB W -> Watcher wing   HUB N -> Tidemaw wing   HUB E -> Admiral wing
 each wing (prefix obs_ / kelp_ / harbor_):
   street_1 -> square -> street_2 -> warden_hall
     warden_hall: rift -> past_street -> past_square (one switch each)
     past_square: return rift -> warden_hall
     warden_hall floodgate (both switch flags) -> lower_street -> antechamber -> boss room
 HUB centre "Abyssal Gate" (all three wing flags) -> dc_abyssal_sanctum
```

Existing mechanisms: scaffolder `doors[]` with multi-`dungeon_flag` gates (AND, as Blightwood's
`clearing_to_heartwood`), `lockDoors` clear-locks, citizens as `npc` objects reusing
`drowned-citizen.png` (Grove Hermit pattern; never block a clear), rifts as `type: "portal"` objects
made visible with `set_object_available`, switches as `type: "switch"` objects whose `object_state on`
trigger sets `<w>_switch_n`, hub lighting via each sub-boss `onComplete` (`setFlag <w>_done` +
`set_object_state` on the hub segment), final gate via a trigger on all three `<w>_done` flags.

New: generalise the scaffolder's `shrines` into `objects[]` (type, initialState, available,
portalId, interactionLabel) in `apps/appearance-studio/src/dungeonScaffold.ts`, so ~30 objects are
not hand-added (a re-scaffold drops hand-added objects).

## 2. Entry rules

- Entrances derived from Drowned City site ids `drowned:<band>:<col>`
  (`apps/server/src/game/waterSitePlacement.ts`), no stored rows. `DungeonRuntime.entrance()` /
  `entrancesNear()` (`apps/server/src/game/dungeon.ts`) resolve them via `waterSiteCandidateById` +
  the `WaterSiteService` surface check, failing closed on unknown surface.
  `apps/server/src/game/locations/ashAtlasPortalRegistry.ts` gets a dynamic branch; portal revision =
  `WATER_SITE_PLACEMENT_VERSION` + dungeon revision.
- Site prompt (`apps/client/src/features/water/waterSitePrompt.ts`, `drowned_city_site`) gains
  "Enter the Drowned City" (`USE_PORTAL`); "Present 20 orbs" stays. Map marker switches to the
  entrance art when it exists.
- Access (`dungeonAccessSchema`, `packages/shared/src/dungeonCatalog.ts`): `minimumLevel: 32`;
  `entryCost` 18 `refined_oil` + 1 `wood`; new `requiresAfloat: true` (`authorizeEntry` checks
  `gameState.isAfloat`); new `noReentry: true` (leaving through the world exit before completion
  starts the lockout; death respawns in-room, disconnect restores on reconnect, neither counts).
- One torch per party, paid by whoever opens an empty instance; every member checked for level,
  afloat, lockout; late joiners free. Exit lands afloat at the site (free, `notifyWorldArrival`).
  Lockout: 6-day default.

## 3. Bosses

| Boss | Builds on | New code |
|---|---|---|
| The Watcher (W) | Phased spec in new `apps/server/src/game/drownedCityBosses.ts` (as `fallenPrisonBosses.ts`), phases 75/50/25/0, each opening with a shielded wave (`summon` + `shieldWhileAlive`); beam + `slam` between | Kit additions in `phasedBossController.ts`: K1 `summon.spawnAnchors` (+ host hook `anchorPosition`), K2 `oncePerPhase`, K4 `retreatToAnchor` (uses `moveBossTo`) |
| Tidemaw (N) | Bespoke `tidemawBoss.ts` (as `hollowElderBoss.ts`): 4 tentacles at fixed anchors, one marked; boss immune while submerged; killing the marked tentacle surfaces it 15 s, then the mark moves; others regrow after 8 s | Controller; marked tentacle is its own archetype (`tidemaw_tentacle_marked`) |
| Drowned Admiral (E) | Pure phased spec: cutlass 100-66 (cleave), harpoon 66-33 (charge + cleave), anchor 33-0 (big slam + 2 deckhands), enrage < 15% | Per-phase art swap only |
| The Abyssal One (final) | Bespoke `abyssalOneBoss.ts`, stationary in a pit with 4 arm objects | K3 timed adds: `summon.deadlineMs` + `onExpire: "fail_encounter"`; rituals at 80/55/30% call 3 `abyssal_cultist` + `setPhaseDeadline(+50 s)` (HUD countdown exists in `BossEncounterHud.tsx`). Failure: new `DungeonRuntime.failEncounterAndEject` reusing the `handlePartyWipe` reset path, moving occupants to the hub via server-started `commitPortalTransition`; boss back at full health. Bombs: host hook forwards `object_interact` to the controller; every 20 s one of 4 `tide_bomb` floor objects becomes available; carried 15 s (explodes on the carrier if not planted); planting on an arm = -15% boss damage per stack, max 3, cleared on reset |

Register in `apps/server/src/game/coreBossRuntime.ts` and `DUNGEON_BOSS_DEFINITIONS`
(`packages/shared/src/dungeonBossDefinitions.ts`). K3 also closes the ladder's "timed adds that
eject and reset" gap.

## 4. Rewards

Hidden chests revealed on each boss defeat, claimed once per member (Fallen Prison pattern):
sub-boss chest 2 Abyssal Orbs + 1,500 gold; sanctum chest 4 orbs + 3,000 gold + `completeDungeon`.
Per member: 10 orbs, 7,500 gold. XP from mob definitions (sub-bosses ~Brood Matron x1.2, final ~x2).
Optional Tidecraft altar in the sanctum (`dungeonSkills.ts` already maps Tidecraft to `drowned_city`).

## 5. Mobs

Phase B mobs are 14-20 and placements have no level override, so add `_dc` dungeon-variant
archetypes (levels 27-31) reusing art via `spriteKey`, per `docs/architecture/MOB_CONTENT_STANDARD.md`.

| Area | Mobs |
|---|---|
| Entry rooms | tide_wraith_dc, darter_dc, ink_pool_dc |
| W wing (sunken observatory) | drowned_cultist_dc, void_wisp (new, blinks), deep_crawler (new, leaps) |
| N wing (kelp deeps) | shellback_dc herds, darter_dc, maw_lily (new, rooted, `pull`), coral_golem_dc |
| E wing (harbor) | drowned_deckhand_dc, phantom_lookout_dc, merfolk_harpooner_dc |
| Warden halls | gate_warden_dc (existing rift call) |
| Past rooms | chrono_wisp (new, only hostile in the past) + citizen NPC objects |
| Sanctum adds | abyssal_cultist (drowned-cultist art), void_wisp |
| Boss parts | tidemaw_tentacle, tidemaw_tentacle_marked |

## 6. Art (per `DUNGEONS_1_4_PLAN.md` section 1)

Missing art stays empty: nothing ships with placeholder floors. A slice that needs a room ships only
when that room's floor exists.

- **Floors (19)**, top-down, 2 px per room unit (<= 3,200 px; <= 2,048 px if `fix/perf-dungeon-floors`
  lands first), `apps/client/public/assets/dungeons/drowned_city/`: sunken-stair 1000x1000,
  drowned-causeway 1600x800, flooded-plaza 1200x1200, circle-of-tides 1600x1600 (base circle painted);
  per wing (x3): street 1600x800, square 1200x1200, warden-hall 1200x1200, boss room 1400x1400;
  shared past-street 1600x800 and past-square 1200x1200 (same doorway geometry); sanctum 1600x1600.
- **Props (17)**, 512x512 unless noted: coral-barricade, floodgate closed/open, time-rift
  dormant/open, return-rift, tide-switch off/on, hub circle lit segment x3 (1200x1200),
  abyssal-gate sealed/open, tide-bomb, abyssal-arm intact/bombed, tidecraft-altar.
- **Mobs and bosses (19)**, 1254x1254, `apps/client/src/assets/mobs/dungeons/`: deep-crawler,
  chrono-wisp, void-wisp, maw-lily; Watcher + shielded; Tidemaw surfaced + submerged; tentacle +
  marked tentacle; Admiral cutlass / harpoon / anchor; Abyssal One + weakened.
- **Entrance (1)**: ~1448x1086 ruined spire breaking the waves.
- Reused: shellback, darter, ink-pool, tide-wraith, gate-warden, drowned-cultist, coral-golem,
  drowned-deckhand, phantom-lookout, merfolk-harpooner, drowned-citizen, shared chest, abyssal-orb.

About 56 new PNGs. Not yet proven by the pipeline: (1) per-phase boss art (client maps art by
archetype only; needs an `(archetype, phaseId)` map falling back to base), (2) overlays > 512 px,
(3) an entrance drawn on the water layer, (4) carried-item visuals (use a `show_message` instead),
(5) texture memory for 32 rooms (needs the unmerged floor-perf branch), (6) exact floor geometry
(wall border and doorway sockets) from generated art: run a floor pilot first.

## 7. Migrations

None expected (orbs exist, mobs are TS-only, entrances derived, lockout ledger exists, bombs live in
controller state). If stored entrance rows or a bomb item are chosen, scan all remote branches first.

## 8. Build order

1. **Front door and hub:** entrance resolver, access fields, site action, afloat exit, scaffolder
   `objects[]`, all rooms + entry mobs + `_dc` archetypes, wings ending in stand-in bosses so hub
   lighting and the final gate work end to end. Tests: `authorizeEntry` (level, afloat, lockout,
   torch), no re-entry, `drowned:` id on a land slot is unavailable, portal registry round trip, afloat
   exit, catalog reachability/recovery invariants, the 3-flag gate trigger, and whether kit-summoned
   adds and rift cultists are attackable inside dungeon rooms.
2. **Wings, Watcher, Admiral:** rifts, switches, floodgates, K1/K2/K4, 2-orb chests. Tests: K1/K2/K4
   units, spec validation, switches open the floodgate, chest once per player per run, citizens never
   block a clear.
3. **Tidemaw + per-phase art:** mark rotation, submerged immunity, regrow, reset clears adds, client
   phase-art fallback.
4. **The Abyssal One:** K3, `failEncounterAndEject`, bomb hooks, final chest + lockout. Tests: missed
   deadline ejects the room to the hub via the location CAS (and reconnect after eject), boss resets
   to full, success path, bomb pickup/plant/expiry/cap, replayed interactions don't double-apply, a
   full run grants 10 orbs.

## 9. Open decisions (recommendation in bold)

1. Failed ritual sends the party to: **the hub** (ejecting outside would end the raid under no-re-entry).
2. No re-entry: **leaving starts the lockout** (vs. per-run ban only).
3. Orbs: **guaranteed 2+2+2+4** (vs. the procgen branch's chance drops); Tidecraft (20 orbs) = 2 full runs.
4. Lockout: **6-day default** (vs. 72 h).
5. Level-30 mobs: **`_dc` variant archetypes** (vs. a per-placement level override feature).
6. Entrances: **derived from site ids, no migration** (vs. durable rows).
7. Floors: **19 with reuse** (vs. 32 unique).
8. Party size: **no minimum, tuned for 3-5**.
9. Procgen torch-lobby tier `t30`: **declare once that branch merges; don't wait**.
