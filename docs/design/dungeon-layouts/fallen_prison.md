# Fallen Prison layout (Lv 40, entry level capped by the level cap)

Scaffolded from `tools/appearance-studio/interior-specs/fallen_prison.json` (placeholder floors; no art yet).
Rooms are linear with two optional branches. Doors lock while their room's fight is active.

```
Wreck Gate -> Barracks Hall -> Maze West -> Maze East -> Marshal's Hall  (boss, 13 seals)
  -> Cell Spine -+-> Cell I   (Serpent Jailer, 75 s rescue)
                 +-> Cell II  -> Cell III   (rescues)
                 +-> Brood Chamber (Brood Matron among Coil Hatchlings, 27 seals)
  -> Foot of the Stairs -+-> Treasure I  (real chest, Mimic ambush)
  -> Mid Stairs ---------+-> Treasure II (Mimics, then the chest)
  -> Warden's Den (Trifang Warden, 44 seals)
```

- **Seals** come from a hidden chest each boss reveals (one claim per party member, the existing chest
  rule), not from the mob reward table, so every member is paid. `rewardTableId` is still not read for
  encounters.
- **Rescue:** an encounter with `rescue: { timeLimitMs }` that clears in time gives every player in the
  room a Freed Valkyrie minion (`MinionRuntime`, cap 5, leaves with the dungeon) and sets the dungeon flag
  `<encounter>_rescued`. Late clears announce the loss.
- **Bosses** use `apps/server/src/game/fallenPrisonBosses.ts` on the phased boss kit. The Warden's three
  heads are three phases (66 / 33 / 0 percent), each with its own special.
- **World event:** `apps/server/src/game/fallenPrisonCrash.ts`. Developer trigger
  `POST /api/dev/fallen-prison/crash {playerId, operationKey}` lands it 400 m north of that player for 20 h
  with Spire Scouts/Cloud Sentries/Cloud Arbiter (respawn 5 h). `POST /api/fallen-prison/trail` gives a bearing and
  distance once per 10 h. Developers can also spawn the plain entrance from Developer App -> Spawning ->
  Dungeon entrances (bypasses level, torch, lockout).

- **Automatic crashes:** `FALLEN_PRISON_AUTO_CRASH` in `fallenPrisonCrash.ts` (check interval, crashes per region,
  landing distance). Each check lands one crash per populated region (an online player at the entry level), 300-900 m
  from a random eligible player on walkable land, for 20 h. Clients show a trail panel (bearing and distance) while a
  crash is down.
- **Verdict Altar** (warden den, appears when the Warden dies): 440 Edict Seals discover **Edict Stride**, an active
  targeted World Knowledge skill (2 seals per use; 4 / 4-9 / 9 damage per 100 m the target moves; 12 s to start, 6 s
  active; 2:15 / 1:40 / 1:10 cooldown). It rides `USE_GENERAL_ACTIVE`. The altar is hand-added to the interior JSON, not the
  scaffold spec, so a re-scaffold would drop it. The Warden's chest also gives one Prison Key Fragment per member.

