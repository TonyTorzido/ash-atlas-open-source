import {
  cisternWarrensRoomNavigation, combatPositionToDungeonLocal, isIndoorNavigationPointWalkable, isIndoorNavigationSegmentWalkable,
  bearingDegrees, DEFAULT_PLAYER_SPEED_MPS, destinationPoint, dungeonAnchorDefinition, dungeonLocalDistanceToCombatMeters,
  dungeonLocalToCombatPosition, DUNGEON_BOSS_DEFINITIONS, DUNGEON_CATALOG, type BossCastSnapshot, type LatLon, type MobArchetypeKey
} from "@ash-atlas/shared";
import { BossControllerRegistry, BossDefinitionRegistry, BossEncounterManager, type BossController } from "./bossFramework.js";
import { createSewerRatMinibossController } from "./sewerRatBoss.js";
import { RAPTOR_CHIEFTAIN, RAPTOR_CHIEFTAIN_ABILITIES, createRaptorChieftainController } from "./raptorChieftainBoss.js";
import { HOLLOW_ELDER, HOLLOW_ELDER_ABILITIES, createHollowElderController } from "./hollowElderBoss.js";
import { THUNDERWING, THUNDERWING_ABILITIES, createThunderwingController } from "./thunderwingBoss.js";
import { ELDER_DRAGON, ELDER_DRAGON_ABILITIES, createElderDragonController } from "./elderDragonBoss.js";
import { GRANDMASTER, GRANDMASTER_ABILITIES, createGrandmasterController } from "./grandmasterBoss.js";
import { BROOD_MATRIARCH, BROOD_MATRIARCH_ABILITIES, createBroodMatriarchController } from "./broodMatriarchBoss.js";
import { createPhasedController, PHASED_BOSS_SPECS, phasedSpecCastDamage } from "./phasedBossController.js";
import { FALLEN_PRISON_BOSS_SPECS } from "./fallenPrisonBosses.js";
import { DROWNED_CITY_BOSS_SPECS } from "./drownedCityBosses.js";
import { createTidemawController, TIDEMAW, TIDEMAW_ABILITIES } from "./tidemawBoss.js";
import { ABYSSAL_ONE, ABYSSAL_ONE_ABILITIES, createAbyssalOneController } from "./abyssalOneBoss.js";
import {
  CORRUPTED_CORE_ABILITIES, createCorruptedCoreController, createForgemasterController, createGraniteBullController,
  FORGEMASTER, FORGEMASTER_ABILITIES, GRANITE_BULL, GRANITE_BULL_ABILITIES
} from "./golemForgeBosses.js";
import type { CombatEngine } from "./combat/combatEngine.js";

/**
 * Combat position of an authored anchor in the dungeon room a boss stands in. A dungeon zone id is
 * `interior:<instanceId>:<roomId>` and room ids are unique across the dungeon catalog.
 */
export function dungeonRoomAnchorPosition(zoneId: string, anchorId: string): LatLon | null {
  if (!zoneId.startsWith("interior:")) return null;
  const roomId = zoneId.slice(zoneId.lastIndexOf(":") + 1);
  for (const dungeon of DUNGEON_CATALOG.dungeons) {
    const room = dungeon.rooms.find((candidate) => candidate.id === roomId && !candidate.retired);
    if (!room) continue;
    if (!room.anchors.some((anchor) => anchor.id === anchorId && !anchor.retired)) return null;
    const anchor = dungeonAnchorDefinition(room, anchorId);
    return dungeonLocalToCombatPosition(anchor.x, anchor.y);
  }
  return null;
}

/**
 * The last point along the straight line from `from` to `to` that a body can reach inside the dungeon room the zone
 * names (`to` itself when the way is open, `from` when it is blocked at once). Outside a dungeon room, or when the
 * room is unknown, `to` is returned unchanged.
 */
export function clampPathToDungeonWalls(zoneId: string, from: LatLon, to: LatLon): LatLon {
  if (!zoneId.startsWith("interior:")) return to;
  const roomId = zoneId.slice(zoneId.lastIndexOf(":") + 1);
  const dungeon = DUNGEON_CATALOG.dungeons.find((candidate) => candidate.rooms.some((room) => room.id === roomId && !room.retired));
  if (!dungeon) return to;
  const navigation = cisternWarrensRoomNavigation(roomId, dungeon);
  const start = combatPositionToDungeonLocal(from);
  const end = combatPositionToDungeonLocal(to);
  if (!isIndoorNavigationPointWalkable(navigation, start)) return to;
  const steps = 32;
  let last = start;
  for (let step = 1; step <= steps; step += 1) {
    const point = { x: start.x + (end.x - start.x) * step / steps, y: start.y + (end.y - start.y) * step / steps };
    if (!isIndoorNavigationSegmentWalkable(navigation, start, point)) break;
    last = point;
  }
  return last === start ? from : step32(last, end, to);
}

function step32(last: { x: number; y: number }, end: { x: number; y: number }, to: LatLon): LatLon {
  return last.x === end.x && last.y === end.y ? to : dungeonLocalToCombatPosition(last.x, last.y);
}

/** Search radius covering the whole Brood Chamber (radius 610 local units). */
const BROOD_CHAMBER_SEARCH_RADIUS_M = dungeonLocalDistanceToCombatMeters(1_400);

/** Search radius covering the whole Hoard Chamber (1600 x 1600 local units). */
const ELDER_DRAGON_ROOM_SEARCH_RADIUS_M = dungeonLocalDistanceToCombatMeters(2_400);

/** Per-ability hit damage for the registered boss casts; anything else uses the generic 12. */
const CAST_DAMAGE: Readonly<Record<string, number>> = Object.freeze({
  [RAPTOR_CHIEFTAIN_ABILITIES.leapSlam]: RAPTOR_CHIEFTAIN.slamDamage,
  [THUNDERWING_ABILITIES.windGust]: THUNDERWING.gustDamage,
  [THUNDERWING_ABILITIES.dive]: THUNDERWING.diveDamage,
  [THUNDERWING_ABILITIES.lightning]: THUNDERWING.lightningDamage,
  [HOLLOW_ELDER_ABILITIES.rootSlam]: HOLLOW_ELDER.slamDamage,
  [HOLLOW_ELDER_ABILITIES.sporeCloud]: HOLLOW_ELDER.sporeCastDamage,
  [ELDER_DRAGON_ABILITIES.breath]: ELDER_DRAGON.breathDamage,
  [ELDER_DRAGON_ABILITIES.buffet]: ELDER_DRAGON.buffetDamage,
  [ELDER_DRAGON_ABILITIES.fireball]: ELDER_DRAGON.fireballDamage,
  [TIDEMAW_ABILITIES.bite]: TIDEMAW.biteDamage,
  [TIDEMAW_ABILITIES.undertow]: TIDEMAW.undertowDamage,
  [ABYSSAL_ONE_ABILITIES.slam]: ABYSSAL_ONE.slamDamage,
  [ABYSSAL_ONE_ABILITIES.gaze]: ABYSSAL_ONE.gazeDamage,
  [GRANITE_BULL_ABILITIES.charge]: GRANITE_BULL.charge.damage,
  [GRANITE_BULL_ABILITIES.stomp]: GRANITE_BULL.stomp.damage,
  [FORGEMASTER_ABILITIES.cleave]: FORGEMASTER.cleave.damage,
  [FORGEMASTER_ABILITIES.slam]: FORGEMASTER.slam.damage,
  [GRANDMASTER_ABILITIES.tigerPalm]: GRANDMASTER.tigerDamage,
  [GRANDMASTER_ABILITIES.mantisStrike]: GRANDMASTER.mantisDamage
});

/** Canonical registered dungeon bosses, controllers, cast damage, and movement modifiers. */
export function createCoreBossRuntime(
  combat: CombatEngine,
  playerMovementSpeedMps = DEFAULT_PLAYER_SPEED_MPS,
  now: () => number = Date.now
): BossEncounterManager {
  const bossDefinitions = new BossDefinitionRegistry();
  const bossControllers = new BossControllerRegistry();
  for (const definition of DUNGEON_BOSS_DEFINITIONS) bossDefinitions.register(definition);
  bossControllers.register("xoral", (): BossController => ({}));
  bossControllers.register(
    "sewer_rat_miniboss",
    () => createSewerRatMinibossController(playerMovementSpeedMps)
  );
  bossControllers.register("brood_matriarch", () => createBroodMatriarchController({
    livingBroodCount: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      if (!boss) return 0;
      let living = 0;
      for (const id of combat.nearbyEntityIds({ lat: boss.lat, lon: boss.lon }, BROOD_CHAMBER_SEARCH_RADIUS_M)) {
        const entity = combat.entity(id);
        if (entity?.archetypeKey === "spiderling" && entity.lifeState === "alive" && entity.zoneId === boss.zoneId) living += 1;
      }
      return living;
    },
    playerPosition: (entityId) => {
      const entity = combat.entity(entityId);
      return entity ? { lat: entity.lat, lon: entity.lon } : null;
    }
  }));
  bossControllers.register("raptor_chieftain", () => createRaptorChieftainController({
    bossHealthRatio: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      return boss && boss.maxHealth > 0 ? boss.currentHealth / boss.maxHealth : 1;
    },
    playerPosition: (entityId) => {
      const entity = combat.entity(entityId);
      return entity ? { lat: entity.lat, lon: entity.lon } : null;
    },
    leapBossTo: (bossEntityId, position) => { combat.leapMobTo(bossEntityId, position); },
    warRoar: (bossEntityId, durationMs) => {
      const boss = combat.entity(bossEntityId);
      if (boss) combat.applyWarRoar(boss.zoneId, durationMs);
    }
  }));
  bossControllers.register("thunderwing", () => createThunderwingController({
    bossPosition: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      return boss ? { lat: boss.lat, lon: boss.lon } : null;
    },
    playerPosition: (entityId) => {
      const entity = combat.entity(entityId);
      return entity ? { lat: entity.lat, lon: entity.lon } : null;
    },
    leapBossTo: (bossEntityId, position) => { combat.leapMobTo(bossEntityId, position); }
  }));
  bossControllers.register("hollow_elder", () => createHollowElderController({
    bossHealthRatio: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      return boss && boss.maxHealth > 0 ? boss.currentHealth / boss.maxHealth : 1;
    },
    bossPosition: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      return boss ? { lat: boss.lat, lon: boss.lon } : null;
    },
    playerPosition: (entityId) => {
      const entity = combat.entity(entityId);
      return entity ? { lat: entity.lat, lon: entity.lon } : null;
    },
    livingSprites: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      return boss ? combat.livingMobIds(boss.zoneId, "blight_sprite") : [];
    },
    healBoss: (bossEntityId, fraction) => {
      const boss = combat.entity(bossEntityId);
      if (boss) combat.healMob(bossEntityId, boss.maxHealth * fraction);
    },
    spawnSporeCloud: (bossEntityId, center, radiusM, delayMs, durationMs) => {
      combat.spawnPoisonCloud(bossEntityId, center, radiusM, delayMs, durationMs, HOLLOW_ELDER.sporeTickDamage, "hollow_elder_spore_cloud");
    }
  }));
  bossControllers.register("tidemaw", () => createTidemawController({
    bossPosition: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      return boss ? { lat: boss.lat, lon: boss.lon } : null;
    },
    playerPosition: (entityId) => {
      const entity = combat.entity(entityId);
      return entity ? { lat: entity.lat, lon: entity.lon } : null;
    },
    anchorPosition: (bossEntityId, anchorId) => {
      const boss = combat.entity(bossEntityId);
      return boss ? dungeonRoomAnchorPosition(boss.zoneId, anchorId) : null;
    },
    spawnTentacle: (bossEntityId, archetype, position) => {
      const boss = combat.entity(bossEntityId);
      if (!boss) return null;
      try {
        return combat.spawnMob({
          archetype, position, homePosition: position, regionCode: boss.regionCode, zoneId: boss.zoneId,
          worldAi: true, movementSpeedMpsOverride: 0, summonedByEntityId: bossEntityId
        }).entityId;
      } catch {
        return null;
      }
    },
    isAlive: (entityId) => combat.entity(entityId)?.lifeState === "alive",
    despawn: (entityIds) => { for (const entityId of entityIds) combat.despawnMob(entityId); }
  }));
  bossControllers.register("abyssal_one", () => createAbyssalOneController({
    bossHealthRatio: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      return boss && boss.maxHealth > 0 ? boss.currentHealth / boss.maxHealth : 1;
    },
    bossPosition: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      return boss ? { lat: boss.lat, lon: boss.lon } : null;
    },
    playerPosition: (entityId) => {
      const entity = combat.entity(entityId);
      return entity ? { lat: entity.lat, lon: entity.lon } : null;
    },
    anchorPosition: (bossEntityId, anchorId) => {
      const boss = combat.entity(bossEntityId);
      return boss ? dungeonRoomAnchorPosition(boss.zoneId, anchorId) : null;
    },
    spawnAdds: (bossEntityId, archetype, count, positions) => {
      const boss = combat.entity(bossEntityId);
      if (!boss) return [];
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const position = positions?.[index] ?? destinationPoint({ lat: boss.lat, lon: boss.lon }, 120, (360 / Math.max(1, count)) * index);
        try {
          ids.push(combat.spawnMob({ archetype, position, homePosition: position, regionCode: boss.regionCode, zoneId: boss.zoneId,
            worldAi: true, summonedByEntityId: bossEntityId }).entityId);
        } catch {
          // A failed spawn is one cultist fewer; the ritual still needs the rest dead.
        }
      }
      return ids;
    },
    isAlive: (entityId) => combat.entity(entityId)?.lifeState === "alive",
    despawn: (entityIds) => { for (const entityId of entityIds) combat.despawnMob(entityId); },
    explodeOn: (bossEntityId, playerId, damage) => {
      if (combat.entity(playerId)?.lifeState === "alive") combat.applyScriptedDamage(bossEntityId, playerId, damage, "boss:abyssal_one:tide_bomb");
    }
  }));
  // Golem Forge bosses (golemForgeBosses.ts). Scripted mobs stand still and never attack; the controller walks them.
  const spawnForgeMob = (bossEntityId: string, archetype: MobArchetypeKey, position: LatLon, scripted: boolean): string | null => {
    const boss = combat.entity(bossEntityId);
    if (!boss) return null;
    try {
      const { entityId } = combat.spawnMob({
        archetype, position, homePosition: position, regionCode: boss.regionCode, zoneId: boss.zoneId, worldAi: true,
        summoned: true, noRewards: true, summonedByEntityId: bossEntityId, ...(scripted ? { movementSpeedMpsOverride: 0 } : {})
      });
      if (scripted) combat.setMobInert(entityId);
      return entityId;
    } catch {
      return null;
    }
  };
  const bossHealthRatio = (bossEntityId: string): number => {
    const boss = combat.entity(bossEntityId);
    return boss && boss.maxHealth > 0 ? boss.currentHealth / boss.maxHealth : 1;
  };
  const entityPosition = (entityId: string): LatLon | null => {
    const entity = combat.entity(entityId);
    return entity ? { lat: entity.lat, lon: entity.lon } : null;
  };
  const roomAnchor = (bossEntityId: string, anchorId: string): LatLon | null => {
    const boss = combat.entity(bossEntityId);
    return boss ? dungeonRoomAnchorPosition(boss.zoneId, anchorId) : null;
  };
  bossControllers.register("granite_bull", () => createGraniteBullController({
    bossHealthRatio,
    bossPosition: entityPosition,
    playerPosition: entityPosition,
    anchorPosition: roomAnchor,
    spawnScriptedMob: (bossEntityId, archetype, position) => spawnForgeMob(bossEntityId, archetype, position, true),
    mobPosition: entityPosition,
    moveMobTo: (entityId, position) => combat.leapMobTo(entityId, position),
    // The Bull's charge ends at the last open point of its line, never inside or beyond a wall.
    moveBossTo: (bossEntityId, position) => {
      const boss = combat.entity(bossEntityId);
      return combat.leapMobTo(bossEntityId, boss ? clampPathToDungeonWalls(boss.zoneId, { lat: boss.lat, lon: boss.lon }, position) : position);
    },
    healBoss: (bossEntityId, amount) => { combat.healMob(bossEntityId, amount, true); },
    isAlive: (entityId) => combat.entity(entityId)?.lifeState === "alive",
    despawn: (entityIds) => { for (const entityId of entityIds) combat.despawnMob(entityId); }
  }));
  bossControllers.register("corrupted_core", () => createCorruptedCoreController({
    bossHealthRatio,
    bossPosition: entityPosition,
    playerPosition: entityPosition,
    anchorPosition: roomAnchor,
    spawnHusk: (bossEntityId, archetype, position) => {
      const id = spawnForgeMob(bossEntityId, archetype, position, false);
      if (id) {
        combat.setMobInert(id);
        combat.setMobInvulnerable(id, true);
      }
      return id;
    },
    possessHusk: (huskEntityId, targetPlayerEntityId) => {
      combat.setMobInvulnerable(huskEntityId, false);
      combat.setMobInert(huskEntityId, false);
      combat.setMobAwake(huskEntityId, true);
      if (targetPlayerEntityId) combat.directMobTarget(huskEntityId, targetPlayerEntityId);
    },
    setBossShielded: (bossEntityId, shielded) => { combat.setMobInvulnerable(bossEntityId, shielded); },
    setBossPassive: (bossEntityId, passive) => { combat.setMobPassive(bossEntityId, passive); },
    mobPosition: entityPosition,
    moveBossTo: (bossEntityId, position) => combat.leapMobTo(bossEntityId, position),
    healBossToRatio: (bossEntityId, ratio) => {
      const boss = combat.entity(bossEntityId);
      if (boss) combat.healMob(bossEntityId, ratio * boss.maxHealth - boss.currentHealth);
    },
    isAlive: (entityId) => combat.entity(entityId)?.lifeState === "alive",
    despawn: (entityIds) => { for (const entityId of entityIds) combat.despawnMob(entityId); },
    spawnDamageZone: (bossEntityId, center, radiusM, delayMs, durationMs, damagePerSecond, techniqueId) => {
      combat.spawnDamageZone({ ownerEntityId: bossEntityId, center, radiusM, delayMs, durationMs, damage: damagePerSecond, techniqueId });
    },
    clearDamageZones: (bossEntityId) => { combat.clearDamageZones([bossEntityId]); },
    strikePlayer: (bossEntityId, playerEntityId, damage, techniqueId) => {
      if (combat.entity(playerEntityId)?.lifeState === "alive") combat.applyScriptedDamage(bossEntityId, playerEntityId, damage, techniqueId);
    }
  }));
  bossControllers.register("forgemaster", () => createForgemasterController({
    bossHealthRatio,
    bossPosition: entityPosition,
    playerPosition: entityPosition,
    anchorPosition: roomAnchor,
    spawnMob: spawnForgeMob,
    mobPosition: entityPosition,
    moveMobTo: (entityId, position) => combat.leapMobTo(entityId, position),
    isAlive: (entityId) => combat.entity(entityId)?.lifeState === "alive",
    despawn: (entityIds) => { for (const entityId of entityIds) combat.despawnMob(entityId); },
    spawnDamageZone: (bossEntityId, center, radiusM, delayMs, durationMs, damagePerSecond, techniqueId) => {
      combat.spawnDamageZone({ ownerEntityId: bossEntityId, center, radiusM, delayMs, durationMs, damage: damagePerSecond, techniqueId });
    },
    clearDamageZones: (bossEntityId) => { combat.clearDamageZones([bossEntityId]); }
  }));
  // Phased kit presets: a boss definition selects one by setting `controllerId` to the spec id.
  const phasedCastDamage = new Map<string, number>();
  for (const spec of [...PHASED_BOSS_SPECS, ...FALLEN_PRISON_BOSS_SPECS, ...DROWNED_CITY_BOSS_SPECS]) {
    for (const [abilityId, damage] of phasedSpecCastDamage(spec)) phasedCastDamage.set(abilityId, damage);
    bossControllers.register(spec.id, () => createPhasedController(spec, {
      bossHealthRatio: (bossEntityId) => {
        const boss = combat.entity(bossEntityId);
        return boss && boss.maxHealth > 0 ? boss.currentHealth / boss.maxHealth : 1;
      },
      bossPosition: (bossEntityId) => {
        const boss = combat.entity(bossEntityId);
        return boss ? { lat: boss.lat, lon: boss.lon } : null;
      },
      playerPosition: (entityId) => {
        const entity = combat.entity(entityId);
        return entity ? { lat: entity.lat, lon: entity.lon } : null;
      },
      anchorPosition: (bossEntityId, anchorId) => {
        const boss = combat.entity(bossEntityId);
        return boss ? dungeonRoomAnchorPosition(boss.zoneId, anchorId) : null;
      },
      spawnAdds: (bossEntityId, archetype, count, positions) => {
        const boss = combat.entity(bossEntityId);
        if (!boss) return [];
        const ids: string[] = [];
        for (let index = 0; index < count; index += 1) {
          const position = positions?.[index] ??
            destinationPoint({ lat: boss.lat, lon: boss.lon }, 90, (360 / Math.max(1, count)) * index);
          try {
            ids.push(combat.spawnMob({
              archetype,
              position,
              homePosition: position,
              regionCode: boss.regionCode,
              zoneId: boss.zoneId,
              worldAi: true,
              summoned: true,
              summonedByEntityId: bossEntityId
            }).entityId);
          } catch {
            // A failed spawn just means fewer adds; the shield only holds for adds that exist.
          }
        }
        return ids;
      },
      isAlive: (entityId) => combat.entity(entityId)?.lifeState === "alive",
      despawnAdds: (entityIds) => { for (const entityId of entityIds) combat.despawnMob(entityId); },
      moveBossTo: (bossEntityId, position) => { combat.leapMobTo(bossEntityId, position); }
    }));
  }
  bossControllers.register("elder_dragon", () => createElderDragonController({
    bossHealthRatio: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      return boss && boss.maxHealth > 0 ? boss.currentHealth / boss.maxHealth : 1;
    },
    bossPosition: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      return boss ? { lat: boss.lat, lon: boss.lon } : null;
    },
    playerPosition: (entityId) => {
      const entity = combat.entity(entityId);
      return entity ? { lat: entity.lat, lon: entity.lon } : null;
    },
    setAirborne: (bossEntityId, airborne, retargetPlayerId) => {
      combat.setMobAirborne(bossEntityId, airborne, retargetPlayerId);
    },
    roomOccupied: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      if (!boss) return false;
      return combat.nearbyEntityIds({ lat: boss.lat, lon: boss.lon }, ELDER_DRAGON_ROOM_SEARCH_RADIUS_M).some((id) => {
        const entity = combat.entity(id);
        return entity?.kind === "player" && entity.lifeState === "alive" && entity.zoneId === boss.zoneId;
      });
    },
    spawnLavaPool: (bossEntityId, index, center, radiusM, durationMs) => {
      const boss = combat.entity(bossEntityId);
      if (!boss) return;
      combat.spawnRoomHazard({
        zoneId: boss.zoneId, hazardId: `${bossEntityId}:lava:${index}`, center, radiusM,
        delayMs: 0, durationMs, damage: ELDER_DRAGON.lavaPoolTickDamage, techniqueId: "elder_dragon_lava_pool"
      });
    }
  }));
  bossControllers.register("grandmaster", () => createGrandmasterController({
    bossHealthRatio: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      return boss && boss.maxHealth > 0 ? boss.currentHealth / boss.maxHealth : 1;
    },
    bossPosition: (bossEntityId) => {
      const boss = combat.entity(bossEntityId);
      return boss ? { lat: boss.lat, lon: boss.lon } : null;
    },
    playerPosition: (entityId) => {
      const entity = combat.entity(entityId);
      return entity ? { lat: entity.lat, lon: entity.lon } : null;
    },
    setReflect: (bossEntityId, fraction) => { combat.setMobDamageReflect(bossEntityId, fraction); }
  }));
  bossControllers.register("dungeon", (): BossController => {
    let nextCastAt = 0;
    return {
      onActivate: (context) => { nextCastAt = context.now + 1_000; },
      onReset: () => { nextCastAt = 0; },
      update: (context) => {
        if (context.now < nextCastAt) return;
        const boss = combat.entity(context.encounter.mobEntityId);
        if (!boss || boss.lifeState !== "alive") return;
        const origin = { lat: boss.lat, lon: boss.lon };
        const targetId = context.selectTarget({ kind: "nearest", origin }, origin);
        const target = targetId ? combat.entity(targetId) : null;
        if (!target || target.kind !== "player") return;
        const facing = bearingDegrees(origin, { lat: target.lat, lon: target.lon });
        context.beginCast({
          abilityId: "dungeon_cone_cleave",
          geometry: {
            kind: "cone",
            origin,
            facingDegrees: facing,
            rangeM: 8,
            angleDegrees: 70
          },
          castDurationMs: 1_200,
          targetEntityId: target.entityId
        });
        nextCastAt = context.now + 5_000;
      }
    };
  });
  const manager = new BossEncounterManager(
    bossDefinitions,
    bossControllers,
    {
      now,
      resolver: {
        positionOfEntity: (entityId) => {
          const entity = combat.entity(entityId);
          return entity ? { lat: entity.lat, lon: entity.lon } : null;
        },
        applyHit: (cast: BossCastSnapshot, participantId) => {
          const encounter = manager?.encounter(cast.encounterId);
          const boss = encounter ? combat.entity(encounter.mobEntityId) : null;
          if (!boss || boss.lifeState !== "alive") return;
          // The Core's arc telegraphs are visual only; the controller lands the arc itself.
          if (cast.abilityId === CORRUPTED_CORE_ABILITIES.arcRing || cast.abilityId === CORRUPTED_CORE_ABILITIES.arcBeam) return;
          if (cast.abilityId === BROOD_MATRIARCH_ABILITIES.webSnare) {
            combat.applyScriptedRoot(boss.entityId, participantId, BROOD_MATRIARCH.snareRootMs, "brood_web_snare");
            return;
          }
          if (cast.abilityId === HOLLOW_ELDER_ABILITIES.rootSlam) {
            combat.applyScriptedRoot(boss.entityId, participantId, HOLLOW_ELDER.slamRootMs, "hollow_elder_root_slam");
          }
          if (cast.abilityId === ELDER_DRAGON_ABILITIES.buffet) {
            combat.knockbackPlayer(participantId, { lat: boss.lat, lon: boss.lon }, ELDER_DRAGON.buffetKnockbackM);
          }
          if (cast.abilityId === ELDER_DRAGON_ABILITIES.breath || cast.abilityId === ELDER_DRAGON_ABILITIES.fireball) {
            combat.applyScriptedBurning(boss.entityId, participantId);
          }
          if (cast.abilityId === GRANDMASTER_ABILITIES.tigerPalm) {
            combat.knockbackPlayer(participantId, { lat: boss.lat, lon: boss.lon }, GRANDMASTER.tigerKnockbackM);
          }
          if (cast.abilityId === THUNDERWING_ABILITIES.windGust) {
            combat.knockbackPlayer(participantId, { lat: boss.lat, lon: boss.lon }, THUNDERWING.gustKnockbackM);
          }
          combat.applyScriptedDamage(
            boss.entityId,
            participantId,
            CAST_DAMAGE[cast.abilityId] ?? phasedCastDamage.get(cast.abilityId) ?? 12,
            `boss:${cast.bossId}:${cast.abilityId}`
          );
          if (cast.abilityId === GRANITE_BULL_ABILITIES.charge) {
            // The charge throws its victim down the line and stuns them.
            combat.knockbackPlayer(participantId, cast.origin, GRANITE_BULL.charge.knockbackM);
            combat.stunPlayer(boss.entityId, participantId, GRANITE_BULL.charge.stunMs, "granite_bull_charge_stun");
          }
        }
      }
    }
  );
  combat.setBossCombatModifierProvider((entityId) => {
    const override = manager?.encounterForEntity(entityId)?.movementOverride;
    if (!override) return null;
    return {
      ...(override.movementSpeedMps === undefined ? {} : { movementSpeedMps: override.movementSpeedMps }),
      ...(override.movementSpeedMultiplier === undefined ? {} : { movementSpeedMultiplier: override.movementSpeedMultiplier }),
      ...(override.outgoingDamageMultiplier === undefined ? {} : { outgoingDamageMultiplier: override.outgoingDamageMultiplier }),
      ...(override.incomingDamageMultiplier === undefined ? {} : { incomingDamageMultiplier: override.incomingDamageMultiplier })
    };
  });
  combat.setBossDamageListener((entityId, amount, sourceEntityId) => {
    manager.encounterForEntity(entityId)?.notifyDamage(amount, sourceEntityId);
  });
  combat.setBossEncounterProjectionProvider((entityId, recipientPlayerId) =>
    manager.projectionForEntity(entityId, now(), recipientPlayerId));
  return manager;
}
