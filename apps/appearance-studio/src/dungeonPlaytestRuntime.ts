import { createHash, randomUUID } from "node:crypto";
import {
  cisternWarrensRoomNavigation, combatPositionToDungeonLocal, createDevelopmentTestPlayer,
  dungeonAnchorDefinition, dungeonLocalToCombatPosition, dungeonRewardRollSeed,
  dungeonSeededRoll, DUNGEON_METERS_PER_COORDINATE, materializeDungeonRun, DROPPED_ITEM_PICKUP_RADIUS_M, isIndoorNavigationPointWalkable, portalIds, resolveDungeonChestLoot, dungeonTorchBonusSlots,
  type CombatEvent, type DungeonCatalog, type DungeonDefinition, type DungeonSnapshot,
  type PlayerLocationSnapshot, type PortalServerMessage, type DroppedItemSnapshot
} from "@ash-atlas/shared";
import { DungeonRuntime } from "../../server/src/game/dungeon.js";
import { CombatEngine, playerEquipmentCombatStateFromSnapshot,
  type CombatDefeatSettlementCandidate } from "../../server/src/game/combat/combatEngine.js";
import { requireMobAiProfile, requireMobDefinition } from "../../server/src/game/combat/mobDefinitions.js";
import { resolveChanceBasedItemRewards, scaledMobGoldReward } from "../../server/src/game/combat/rewardSettlement.js";
import { assertDropLocationAndRange, DROPPED_ITEM_TTL_MS } from "../../server/src/game/droppedItems.js";
import { requireItemDefinition } from "../../server/src/game/items.js";
import { createCoreBossRuntime } from "../../server/src/game/coreBossRuntime.js";
import type { BossEncounterManager } from "../../server/src/game/bossFramework.js";
import { genericDungeonPortal } from "../../server/src/game/locations/ashAtlasPortalRegistry.js";
import { PortalRegistry } from "../../server/src/game/locations/portalRegistry.js";
import { PlayerLocationError, type PlayerLocationService } from "../../server/src/game/locations/playerLocationService.js";
import { PortalTransitionCoordinator, type PortalMovementAdapter } from "../../server/src/game/locations/portalTransitionCoordinator.js";
import { dungeonObjectApproachPoint } from "../../client/src/ui/dungeonInteraction.js";
import type { CreatePlaytestInput, DungeonPlaytestFrame, PlaytestCommand, PlaytestDebug } from "./dungeonPlaytestContracts.js";

const PLAYER_ID = "studio-test-player";
const ENTRANCE_ID = "studio_sandbox";
const TICK_SECONDS = 1 / 20; // Canonical default SERVER_TICK_HZ.
const SIMULATION_EPOCH = Date.UTC(2026, 0, 1);
type PendingPortal = Parameters<PortalMovementAdapter["approach"]>[0] & { phase: "approach" | "threshold" };

/**
 * One disposable host of the real game services. It owns no database, socket, World
 * client, inventory/progression service, or publication capability. Definitions are
 * cloned at the boundary; all rewards and locations remain inside this instance.
 */
export class DungeonPlaytestRuntime {
  readonly runId = randomUUID();
  readonly seed: string;
  readonly mode: CreatePlaytestInput["mode"];
  private readonly catalog: DungeonCatalog;
  private readonly definition: DungeonDefinition;
  private readonly instanceId: string;
  private readonly player = createDevelopmentTestPlayer(PLAYER_ID);
  private readonly combat: CombatEngine;
  private readonly dungeon: DungeonRuntime;
  private readonly bosses: BossEncounterManager;
  private readonly portals: PortalTransitionCoordinator;
  private readonly registry = new PortalRegistry();
  private location!: PlayerLocationSnapshot;
  private elapsedMs = 0;
  private accumulator = 0;
  private randomIndex = 0;
  private requestIndex = 0;
  private disposed = false;
  private exited = false;
  private paused = false;
  private debug: PlaytestDebug = { invulnerable: false, aiEnabled: true, aggroEnabled: true, speed: 1 };
  private pendingPortal: PendingPortal | null = null;
  private transitionId: string | null = null;
  private pendingInteraction: Extract<PlaytestCommand, { type: "interact" | "harvest" | "pickup" }> | null = null;
  private lastSnapshot!: DungeonSnapshot;
  private readonly messages: PortalServerMessage[] = [];
  private readonly events: CombatEvent[] = [];
  private readonly log: string[] = [];
  private readonly rewardClaims = new Set<string>();
  private readonly inventory = new Map<string, number>();
  private readonly drops = new Map<string, DroppedItemSnapshot>();
  private readonly playerSpawns = new Map<string, { x: number; y: number }>();
  private gold = 0;
  private cityCoins = 0;
  private readonly replays = new Map<string, { hash: string; location: PlayerLocationSnapshot }>();

  static async create(input: CreatePlaytestInput): Promise<DungeonPlaytestRuntime> {
    const runtime = new DungeonPlaytestRuntime(input);
    try { await runtime.initialize(input.roomId); return runtime; }
    catch (error) { await runtime.dispose(); throw error; }
  }

  private constructor(input: CreatePlaytestInput) {
    if (!input.seed.trim() || input.seed.length > 160) throw new Error("Use a run seed between 1 and 160 characters.");
    this.seed = input.seed;
    this.mode = input.mode;
    this.catalog = structuredClone(input.catalog);
    const definition = this.catalog.dungeons.find((entry) => !entry.retired && entry.id === input.dungeonId);
    if (!definition) throw new Error("The selected dungeon is unavailable.");
    // Stable gameplay identities reproduce seeded mob appearance, placement, and drops.
    // The externally addressable runId remains unique for lifecycle isolation.
    const seedIdentity = createHash("sha256").update(`${input.dungeonId}:${input.seed}`).digest("hex").slice(0, 24);
    const gameplayRunId = `seed:${seedIdentity}`;
    // The run as the game plays it: the seed picks the roll, exactly as the runtime's enter does.
    this.definition = materializeDungeonRun(definition, gameplayRunId);
    this.instanceId = `studio:${seedIdentity}`;
    this.catalog.entrances = [{
      id: ENTRANCE_ID, dungeonId: definition.id, revision: definition.revision, retired: false,
      name: definition.name, description: definition.description, lat: 0, lon: 0,
      interactionRadiusM: 95, footprintRadiusM: 35, portalId: definition.entrance.portalId,
      portalRevision: definition.revision, interactionLabel: `Enter ${definition.name}`,
      presentation: "door", assetKey: null, preloadSceneKey: `dungeon/${definition.entrance.roomId}`
    }];
    this.combat = new CombatEngine({
      tickRateHz: 20, now: () => this.now(),
      random: () => dungeonSeededRoll(`${this.seed}:combat:${this.randomIndex++}`),
      isPlayerAuthorityActive: (playerId, accountId, connectionId) =>
        !this.disposed && playerId === PLAYER_ID && accountId === this.runId && connectionId === this.runId,
      getAuthoritativeViewCircle: (playerId) => this.dungeon?.gameplayViewCircle(playerId) ?? null,
      movePlayerToward: (playerId, target) => this.dungeon.setCombatTarget(playerId, target),
      stopPlayer: (playerId) => this.dungeon.stop(playerId),
      repositionPlayer: (playerId, target, maximumDistance) => this.dungeon.repositionCombatPlayer(playerId, target, maximumDistance),
      isPlayerMobAttackAuthorized: (playerId, entityId) => this.dungeon.canFightMob(playerId, entityId),
      isMobPlayerAttackAuthorized: (entityId, playerId) => this.dungeon.canFightMob(playerId, entityId),
      canMobProactivelyAcquire: () => this.debug.aggroEnabled,
      mobAiEnabled: () => this.debug.aiEnabled,
      isEntityInvulnerable: (entityId) => entityId === PLAYER_ID && this.debug.invulnerable,
      isMobPositionTraversable: (position) => {
        const snapshot = this.dungeon?.get(PLAYER_ID);
        return Boolean(snapshot && isIndoorNavigationPointWalkable(
          cisternWarrensRoomNavigation(snapshot.spaceId, this.definition), combatPositionToDungeonLocal(position)));
      },
      onPlayerDefeated: () => {
        this.dungeon.stop(PLAYER_ID);
        this.pendingInteraction = null;
        this.pendingPortal = null;
        this.note("Player defeated.");
      },
      onDefeatSettlementCandidate: (candidate) => this.settleDefeat(candidate)
    });
    this.bosses = createCoreBossRuntime(this.combat, undefined, () => this.now());
    this.dungeon = DungeonRuntime.ephemeral({
      combat: this.combat, dungeon: this.definition, catalog: this.catalog,
      runId: gameplayRunId, now: () => this.now(), bossEncounters: this.bosses,
      authorities: {
        appearanceForPlayer: () => this.player.appearance,
        ownsItem: (_playerId, itemId, quantity) => (this.inventory.get(itemId) ?? 0) >= quantity,
        hasQuestFlag: () => false,
        harvestResource: (_playerId, resourceType, quantity) => { this.grant(resourceType, quantity); return quantity; },
        grantReward: (_playerId, rewardId, context) => {
          const key = `${context.runId}:${context.rewardSourceId}`;
          if (this.rewardClaims.has(key)) return;
          const table = this.catalog.rewardTables.find((entry) => !entry.retired && entry.id === rewardId);
          if (!table) throw new Error(`Reward table ${rewardId} is unavailable.`);
          for (const item of resolveDungeonChestLoot(table, dungeonRewardRollSeed(context.runId, context.rewardSourceId, table),
            dungeonTorchBonusSlots(table, context.torchTotal)).items) {
            this.grant(item.itemId, item.quantity);
          }
          this.rewardClaims.add(key);
          this.gold += table.gold ?? 0;
          this.note(`Reward: ${rewardId} (sandbox only).`);
        }
      }
    });
    this.registry.registerResolver((portalId, source, context) =>
      genericDungeonPortal(this.catalog, portalId, source, context.playerId));
    this.portals = new PortalTransitionCoordinator({
      locations: {
        load: async () => this.currentLocation(),
        replayPortalTransition: async (_playerId, requestId, hash) => this.replay(requestId, hash),
        commitPortalTransition: async (input) => this.commitLocation(input)
      },
      portals: this.registry,
      movementFor: () => ({
        approach: (input) => {
          if (!("x" in input.portal.sourceApproach)) throw new Error("Sandbox movement requires an interior source.");
          this.pendingPortal = { ...input, phase: "approach" };
          this.moveTo(input.portal.sourceApproach.x, input.portal.sourceApproach.y);
        },
        stop: () => { this.pendingPortal = null; this.dungeon.stop(PLAYER_ID); }
      }),
      destinationFor: () => ({
        authorize: ({ portal }) => {
          if (!this.combat.isPlayerAlive(PLAYER_ID)) throw new Error("Restart or heal the player before travelling.");
          if (!portal.portalId.startsWith("studio-debug:")) this.dungeon.authorizePortal(PLAYER_ID, portal.portalId);
        },
        commit: async ({ portal, destination }) => {
          const snapshot = this.dungeon.get(PLAYER_ID)!;
          if (destination.kind === "interior") {
            this.dungeon.transferSpace(PLAYER_ID, snapshot.sessionId, destination.spaceId, destination.position,
              portal.portalId.startsWith("studio-debug:") ? undefined : portal.portalId);
            this.playerSpawns.set(destination.spaceId, { ...destination.position });
            this.note(`Entered ${destination.spaceId}.`);
          } else {
            this.lastSnapshot = snapshot;
            await this.dungeon.leave(PLAYER_ID, snapshot.sessionId, portal.portalId);
            this.exited = true;
            this.note(snapshot.completed ? "Dungeon complete; exited through the authored portal." : "Run ended at the authored exit.");
          }
        }
      }),
      effects: { prepare: () => { this.combat.cancelCombat(PLAYER_ID); }, apply: () => {}, release: () => {} },
      send: (_playerId, message) => {
        this.messages.push(message);
        if (message.type === "PORTAL_TRANSITION_PLANNED") this.transitionId = message.transitionId;
        if (message.type === "PLAYER_LOCATION_SNAPSHOT") this.transitionId = null;
      }
    });
  }

  private async initialize(roomId?: string): Promise<void> {
    const targetRoom = this.mode === "room" ? roomId : this.definition.entrance.roomId;
    const room = this.definition.rooms.find((entry) => !entry.retired && entry.active && entry.id === targetRoom);
    if (!room) throw new Error(this.mode === "room" ? "Select an active room for Quick Room Test." : "The dungeon has no valid Start room.");
    const anchor = dungeonAnchorDefinition(room, this.mode === "full" ? this.definition.entrance.arrivalAnchorId : room.spawnAnchorId);
    this.location = { kind: "interior", locationType: "dungeon", locationId: ENTRANCE_ID,
      instanceId: this.instanceId, spaceId: room.id, regionCode: `interior:${this.instanceId}`,
      zoneId: `interior:${this.instanceId}:${room.id}`, position: { x: anchor.x, y: anchor.y },
      revision: 1, lastPortalId: portalIds.dungeon(ENTRANCE_ID, this.definition.entrance.portalId) };
    this.connectPlayer(anchor.x, anchor.y, room.id);
    this.playerSpawns.set(room.id, { x: anchor.x, y: anchor.y });
    this.lastSnapshot = await this.dungeon.enter({
      playerId: PLAYER_ID, username: "Test Warrior", displayColor: null,
      regionCode: "studio", position: { lat: 0, lon: 0 }, anchor: { lat: 0, lon: 0 },
      moveLeashRadiusM: 0, movementRevision: 0, target: null, online: true,
      updatedAt: new Date(this.now()), appearance: this.player.appearance
    }, ENTRANCE_ID, { locationType: "dungeon", instanceId: this.instanceId, spaceId: room.id, position: anchor });
    this.note(`${this.mode === "full" ? "Full dungeon" : "Quick room"} test · seed ${this.seed}.`);
  }

  private connectPlayer(x: number, y: number, roomId: string): void {
    const stats = this.player.equipment.derivedStats;
    this.combat.connectPlayer({ playerId: PLAYER_ID, name: "Test Warrior", accountId: this.runId, connectionId: this.runId,
      position: dungeonLocalToCombatPosition(x, y), regionCode: `interior:${this.instanceId}`,
      zoneId: `interior:${this.instanceId}:${roomId}`,
      profile: { playerId: PLAYER_ID, maxHealth: stats.maximumHealth, currentHealth: stats.maximumHealth,
        baseAttackDamage: stats.pveAttackPower, defense: stats.pveDefense, level: stats.characterLevel } });
    this.combat.updatePlayerClassState(PLAYER_ID, { ...this.player.classes, serverTime: this.now() }, this.player.equipment);
    this.combat.syncPlayerEquipmentCombatState(PLAYER_ID, playerEquipmentCombatStateFromSnapshot(this.player.equipment));
    this.combat.updatePlayerSkillState(PLAYER_ID, {
      playerId: PLAYER_ID, characterLevel: stats.characterLevel,
      pointState: { totalEarned: 0, totalSpent: 0, available: 0, revision: 1 }, generalSkills: [], specializations: [],
      committedSpecializationId: null, activeSpecializationId: null, equippedClassTechniqueId: null,
      fullBuildRespecAvailable: false, fullClassRosterEnabled: false, ultimatesEnabled: false,
      generalActiveLoadout: [null, null], ultimate: null, cooldownEndsAt: {}, worldKnowledge: [], serverTime: this.now(), revision: 1
    });
  }

  async command(command: PlaytestCommand): Promise<DungeonPlaytestFrame> {
    this.assertActive();
    if (command.type === "debug") {
      for (const key of ["invulnerable", "aiEnabled", "aggroEnabled"] as const) {
        if (typeof command[key] === "boolean") this.debug[key] = command[key];
      }
      if (command.speed !== undefined) {
        if (!Number.isFinite(command.speed) || command.speed < 0.25 || command.speed > 4) throw new Error("Simulation speed must be between 0.25× and 4×.");
        this.debug.speed = command.speed;
      }
      if (command.paused !== undefined) this.paused = command.paused;
      return this.snapshot();
    }
    if (this.exited) throw new Error("This run has exited. Start a new run.");
    if (command.type === "heal") {
      if (!this.combat.isPlayerAlive(PLAYER_ID)) {
        const snapshot = this.dungeon.get(PLAYER_ID)!;
        this.combat.disconnectPlayer(PLAYER_ID);
        this.connectPlayer(snapshot.player.x, snapshot.player.y, snapshot.spaceId);
      } else this.combat.healEntity(PLAYER_ID, this.player.equipment.derivedStats.maximumHealth);
      this.note("Player healed (debug).");
      return this.snapshot();
    }
    if (command.type === "restart_room") {
      await this.cancelActions();
      const snapshot = this.dungeon.get(PLAYER_ID)!;
      this.combat.disconnectPlayer(PLAYER_ID);
      const room = this.definition.rooms.find((entry) => entry.id === snapshot.spaceId)!;
      const spawn = dungeonAnchorDefinition(room, room.spawnAnchorId);
      this.connectPlayer(spawn.x, spawn.y, room.id);
      this.dungeon.resetEphemeralRoom(PLAYER_ID);
      this.playerSpawns.set(room.id, { x: spawn.x, y: spawn.y });
      for (const [id, drop] of this.drops) if (drop.zoneId === `interior:${this.instanceId}:${room.id}`) this.drops.delete(id);
      this.rewardClaims.clear();
      this.note(`Restarted ${room.name} (debug).`);
      return this.snapshot();
    }
    if (!this.combat.isPlayerAlive(PLAYER_ID)) throw new Error("The test player is dead. Restart the dungeon or heal to continue.");
    if (command.type === "damage") {
      if (command.amount !== 1000) throw new Error("Studio damage command must deal exactly 1,000 damage.");
      const target = this.dungeon.get(PLAYER_ID)!.enemies.find((enemy) => enemy.entityId === command.targetEntityId && enemy.lifeState === "alive");
      if (!target) throw new Error("The selected enemy is no longer alive.");
      this.combat.applyScriptedDamage(PLAYER_ID, target.entityId, command.amount, "studio_debug_damage");
      await Promise.resolve();
      await this.dungeon.tick(0);
      this.note(`Dealt 1,000 damage to ${target.name} (debug).`);
      return this.snapshot();
    }
    if (this.paused) throw new Error("Resume Play Test before interacting.");
    switch (command.type) {
      case "move": await this.cancelActions(); this.moveTo(command.x, command.y); break;
      case "attack":
        await this.cancelActions();
        this.combat.startAttack({ attackerId: PLAYER_ID, accountId: this.runId, connectionId: this.runId,
          targetEntityId: command.targetEntityId, requestId: this.requestId() }); break;
      case "cancel_combat": await this.cancelActions(); this.combat.cancelCombat(PLAYER_ID); break;
      case "portal": await this.cancelActions(); await this.usePortal(command.portalId); break;
      case "teleport": await this.cancelActions(); await this.teleport(command.roomId); break;
      case "interact": case "harvest": case "pickup": {
        await this.cancelActions();
        const snapshot = this.dungeon.get(PLAYER_ID)!;
        const target = this.interactionTarget(command, snapshot);
        if (!target) throw new Error("The selected interaction no longer exists in this room.");
        this.pendingInteraction = command;
        if (Math.hypot(target.x - snapshot.player.x, target.y - snapshot.player.y) > target.interactionRadius) {
          const point = dungeonObjectApproachPoint(snapshot.player, target);
          this.moveTo(point.x, point.y);
        }
        await this.finishInteraction();
        break;
      }
      case "kill_room":
        for (const enemy of this.dungeon.get(PLAYER_ID)!.enemies) if (enemy.lifeState === "alive") {
          this.combat.applyScriptedDamage(PLAYER_ID, enemy.entityId, enemy.maxHealth * 100, "studio_debug_kill");
        }
        await Promise.resolve();
        await this.dungeon.tick(0);
        this.note("Killed current room enemies (debug).");
        break;
    }
    return this.snapshot();
  }

  async advance(deltaSeconds: number): Promise<DungeonPlaytestFrame> {
    this.assertActive();
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 1) throw new Error("Invalid simulation step.");
    if (this.paused || this.exited || !this.combat.isPlayerAlive(PLAYER_ID)) return this.snapshot();
    this.accumulator += deltaSeconds * this.debug.speed;
    while (this.accumulator + 1e-9 >= TICK_SECONDS && this.combat.isPlayerAlive(PLAYER_ID) && !this.exited) {
      this.accumulator -= TICK_SECONDS;
      this.elapsedMs += TICK_SECONDS * 1_000;
      for (const drop of this.drops.values()) if (drop.status === "active" && Date.parse(drop.expiresAt) <= this.now()) drop.status = "expired";
      this.dungeon.advanceMovement(TICK_SECONDS);
      this.combat.beginTick();
      if (this.debug.aiEnabled) this.bosses.tick(this.now());
      this.combat.finishTick();
      await this.dungeon.tick(TICK_SECONDS, { movementAlreadyAdvanced: true });
      if (!this.combat.isPlayerAlive(PLAYER_ID)) await this.cancelActions();
      await this.advancePortal();
      await this.finishInteraction();
      this.events.push(...this.combat.beginDeltaFlush().events);
    }
    return this.snapshot();
  }

  snapshot(): DungeonPlaytestFrame {
    this.assertActive();
    this.lastSnapshot = this.dungeon.get(PLAYER_ID) ?? this.lastSnapshot;
    const playerEntity = this.combat.entity(PLAYER_ID);
    const snapshot = structuredClone(this.lastSnapshot);
    const navigation = cisternWarrensRoomNavigation(snapshot.spaceId, this.definition);
    return {
      runId: this.runId, seed: this.seed, mode: this.mode,
      lifecycle: !this.combat.isPlayerAlive(PLAYER_ID) ? "PLAYER_DEAD" : this.paused ? "DEBUG_PAUSED"
        : snapshot.completed ? "DUNGEON_COMPLETED" : this.exited ? "RUN_EXITED" : "PLAYING",
      snapshot, combatEntities: [playerEntity, ...snapshot.enemies.map((enemy) => this.combat.entity(enemy.entityId))]
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
      events: this.events.splice(0).concat(this.combat.beginDeltaFlush().events),
      portalMessages: this.messages.splice(0), drops: [...this.drops.values()].map((drop) => ({ ...drop })), classId: this.player.profile.classId,
      weaponName: this.player.equipment.weapon!.displayName, armorName: this.player.equipment.chest!.displayName,
      appearance: structuredClone(this.player.appearance), debug: { ...this.debug }, log: [...this.log],
      geometry: { playerCollisionRadius: navigation.playerRadius,
        playerAttackRange: this.player.equipment.derivedStats.attackRangeM / DUNGEON_METERS_PER_COORDINATE,
        mobs: snapshot.enemies.map((enemy) => ({ entityId: enemy.entityId,
          attackRange: (this.combat.entity(enemy.entityId)?.attackRangeM ?? requireMobDefinition(enemy.archetype).attackRangeM) / DUNGEON_METERS_PER_COORDINATE,
          aggroRange: (requireMobAiProfile(enemy.archetype).proactive?.radiusM ?? 0) / DUNGEON_METERS_PER_COORDINATE })),
        spawns: [
          ...snapshot.enemies.flatMap((enemy) => {
            const origin = this.combat.entityHomePosition(enemy.entityId);
            return origin ? [{ id: enemy.entityId, kind: "mob" as const, ...combatPositionToDungeonLocal(origin) }] : [];
          }),
          ...(snapshot.resources ?? []).map((resource) => ({ id: resource.id, kind: "resource" as const, x: resource.x, y: resource.y })),
          { id: PLAYER_ID, kind: "player", ...(this.playerSpawns.get(snapshot.spaceId) ?? snapshot.player) }
        ] },
      sandbox: { storageAttempts: this.dungeon.ephemeralStorageAttempts, inventory: Object.fromEntries(this.inventory),
        gold: this.gold, cityCoins: this.cityCoins, exited: this.exited }
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.portals) await this.portals.disconnect(PLAYER_ID);
    this.pendingInteraction = null;
    this.pendingPortal = null;
    if (this.dungeon) await this.dungeon.detachRuntime(PLAYER_ID);
    this.bosses?.clearCasts();
    this.combat?.disconnectPlayer(PLAYER_ID);
    this.combat?.clearMobs();
    this.disposed = true;
  }

  get storageAttempts(): number { return this.dungeon.ephemeralStorageAttempts; }
  private now(): number { return SIMULATION_EPOCH + this.elapsedMs; }
  private assertActive(): void { if (this.disposed) throw new Error("This Play Test has stopped."); }
  private requestId(): string { return `${this.runId}:${++this.requestIndex}`; }
  private note(message: string): void { this.log.push(message); if (this.log.length > 80) this.log.shift(); }
  private grant(itemId: string, quantity: number): void {
    this.inventory.set(itemId, (this.inventory.get(itemId) ?? 0) + quantity);
    this.note(`+${quantity} ${itemId} (sandbox only).`);
  }
  private settleDefeat(candidate: CombatDefeatSettlementCandidate): boolean | Promise<boolean> {
    const grant = () => {
      if (this.rewardClaims.has(candidate.settlementKey)) return true;
      const definition = requireMobDefinition(candidate.mobArchetype);
      const items = [...definition.rewards.items, ...resolveChanceBasedItemRewards({
        settlementKey: candidate.settlementKey, mobArchetype: candidate.mobArchetype,
        mobBalanceVersion: definition.balanceVersion, rewards: definition.rewards.chanceItems
      })];
      for (const [index, item] of items.entries()) {
        if (definition.rewards.itemDelivery === "ground" && candidate.lootLocation) {
          const dropId = `${candidate.settlementKey}:${index}`;
          const itemDefinition = requireItemDefinition(item.itemId);
          this.drops.set(dropId, { dropId, droppedBy: PLAYER_ID, itemId: item.itemId, variant: null,
            regionCode: candidate.lootLocation.regionCode, zoneId: candidate.lootLocation.zoneId,
            pileId: candidate.settlementKey, pileOrder: index, quantity: item.quantity,
            ...(itemDefinition.maxStack === null ? {} : { maxStack: itemDefinition.maxStack }),
            ...candidate.lootLocation.position, status: "active", createdAt: new Date(this.now()).toISOString(),
            expiresAt: new Date(this.now() + DROPPED_ITEM_TTL_MS).toISOString(), pickedUpBy: null, pickedUpAt: null });
        } else this.grant(item.itemId, item.quantity);
      }
      this.gold += scaledMobGoldReward({ baseGold: definition.rewards.gold,
        mobLevel: candidate.mobLevel ?? definition.level, settlementKey: candidate.settlementKey });
      this.cityCoins += definition.rewards.cityCoins;
      this.rewardClaims.add(candidate.settlementKey);
      this.note(`Defeated ${definition.name}; rewards remain in this sandbox.`);
      return true;
    };
    return candidate.bossOwnership ? this.bosses.acceptDefeatCandidate(candidate, grant) : grant();
  }
  private moveTo(x: number, y: number): void {
    const snapshot = this.dungeon.get(PLAYER_ID)!;
    this.dungeon.moveTo(PLAYER_ID, snapshot.sessionId, x, y);
  }
  private async cancelActions(): Promise<void> {
    this.pendingInteraction = null;
    if (this.transitionId) await this.portals.cancel(PLAYER_ID, this.transitionId);
    this.transitionId = null;
    this.pendingPortal = null;
  }
  private async finishInteraction(): Promise<void> {
    const command = this.pendingInteraction;
    if (!command || !this.combat.isPlayerAlive(PLAYER_ID)) return;
    const snapshot = this.dungeon.get(PLAYER_ID)!;
    const target = this.interactionTarget(command, snapshot);
    if (!target) { this.pendingInteraction = null; return; }
    if (Math.hypot(target.x - snapshot.player.x, target.y - snapshot.player.y) > target.interactionRadius) return;
    this.pendingInteraction = null;
    if (command.type === "interact") this.dungeon.interact(PLAYER_ID, snapshot.sessionId, command.objectId, this.requestId());
    else if (command.type === "harvest") await this.dungeon.harvestResource(PLAYER_ID, snapshot.sessionId, command.resourceId, this.requestId());
    else {
      const drop = this.drops.get(command.dropId)!;
      assertDropLocationAndRange({ playerId: PLAYER_ID, regionCode: `interior:${this.instanceId}`,
        zoneId: `interior:${this.instanceId}:${snapshot.spaceId}`,
        position: dungeonLocalToCombatPosition(snapshot.player.x, snapshot.player.y) }, {
        region_code: drop.regionCode, zone_id: drop.zoneId!, lat: drop.lat, lon: drop.lon,
        manor_id: null, space_id: null, local_x: null, local_y: null, dropped_by: drop.droppedBy
      });
      this.grant(drop.itemId, drop.quantity);
      drop.status = "picked_up";
      drop.pickedUpBy = PLAYER_ID;
      drop.pickedUpAt = new Date(this.now()).toISOString();
      drop.quantity = 0;
    }
  }
  private interactionTarget(command: NonNullable<typeof this.pendingInteraction>, snapshot: DungeonSnapshot) {
    if (command.type === "interact") return snapshot.objects.find((entry) => entry.id === command.objectId);
    if (command.type === "harvest") return snapshot.resources?.find((entry) => entry.id === command.resourceId);
    const drop = this.drops.get(command.dropId);
    if (!drop || drop.status !== "active" || drop.zoneId !== `interior:${this.instanceId}:${snapshot.spaceId}`) return undefined;
    return { ...combatPositionToDungeonLocal(drop), interactionRadius: DROPPED_ITEM_PICKUP_RADIUS_M / DUNGEON_METERS_PER_COORDINATE };
  }
  private async usePortal(portalId: string): Promise<void> {
    const runtimeId = portalId.startsWith("dungeon:") || portalId.startsWith("studio-debug:")
      ? portalId : portalIds.dungeon(ENTRANCE_ID, portalId);
    await this.portals.usePortal({ playerId: PLAYER_ID, requestId: this.requestId(), portalId: runtimeId,
      expectedLocationRevision: this.location.revision });
    const planned = [...this.messages].reverse().find((message) => message.type === "PORTAL_TRANSITION_PLANNED");
    if (planned?.type === "PORTAL_TRANSITION_PLANNED") {
      this.portals.destinationReady(PLAYER_ID, planned.transitionId, planned.preloadSceneKey ?? "studio");
    }
    await this.advancePortal();
  }
  private async advancePortal(): Promise<void> {
    const pending = this.pendingPortal;
    const snapshot = this.dungeon.get(PLAYER_ID);
    if (!pending || !snapshot) return;
    const target = pending.phase === "approach" ? pending.portal.sourceApproach : pending.portal.sourceThreshold;
    if (!("x" in target) || Math.hypot(snapshot.player.x - target.x, snapshot.player.y - target.y) > 0.001) return;
    if (pending.phase === "approach") {
      if (!("x" in pending.portal.sourceThreshold)) throw new Error("Invalid sandbox portal threshold.");
      pending.phase = "threshold";
      this.moveTo(pending.portal.sourceThreshold.x, pending.portal.sourceThreshold.y);
    }
    const threshold = pending.portal.sourceThreshold;
    if ("x" in threshold && Math.hypot(snapshot.player.x - threshold.x, snapshot.player.y - threshold.y) <= 0.001) {
      this.pendingPortal = null;
      pending.onThreshold();
      // Flush the coordinator's asynchronous CAS + domain projection chain.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
  }
  private async teleport(roomId: string): Promise<void> {
    const room = this.definition.rooms.find((entry) => !entry.retired && entry.active && entry.id === roomId);
    if (!room) throw new Error("That room is unavailable.");
    const current = this.currentLocation();
    if (current.kind !== "interior") throw new Error("The run has exited.");
    const spawn = dungeonAnchorDefinition(room, room.spawnAnchorId);
    const portalId = `studio-debug:${this.requestId()}`;
    this.registry.register({ portalId, source: current,
      destination: { ...current, spaceId: room.id, position: { x: spawn.x, y: spawn.y } },
      sourceApproach: current.position, sourceThreshold: current.position,
      destinationArrival: { x: spawn.x, y: spawn.y }, enabled: true, revision: "1",
      interactionLabel: "Debug teleport", transitionPresentation: "door" });
    this.note(`Debug teleport to ${room.name}; this run no longer validates the full path.`);
    await this.usePortal(portalId);
  }
  private currentLocation(): PlayerLocationSnapshot {
    const snapshot = this.dungeon.get(PLAYER_ID);
    if (snapshot && this.location.kind === "interior") {
      this.location = { ...this.location, position: { x: snapshot.player.x, y: snapshot.player.y } };
    }
    return structuredClone(this.location);
  }
  private replay(requestId: string, hash: string): PlayerLocationSnapshot | null {
    const replay = this.replays.get(requestId);
    if (!replay) return null;
    if (replay.hash !== hash) throw new PlayerLocationError("REQUEST_ID_REUSED", "That request ID was already used.");
    return structuredClone(replay.location);
  }
  private commitLocation(input: Parameters<PlayerLocationService["commitPortalTransition"]>[0]) {
    const hash = input.requestHash ?? "";
    const replay = this.replay(input.requestId, hash);
    if (replay) return { location: replay, replayed: true };
    if (this.location.revision !== input.expectedRevision) throw new PlayerLocationError("STALE_LOCATION", "The test location changed.");
    const destination = input.destination;
    this.location = { ...destination, revision: this.location.revision + 1, lastPortalId: input.portalId,
      regionCode: destination.kind === "interior" ? `interior:${destination.instanceId}` : destination.regionCode,
      zoneId: destination.kind === "interior" ? `interior:${destination.instanceId}:${destination.spaceId}` : "studio-exit" };
    this.replays.set(input.requestId, { hash, location: structuredClone(this.location) });
    return { location: structuredClone(this.location), replayed: false };
  }
}
