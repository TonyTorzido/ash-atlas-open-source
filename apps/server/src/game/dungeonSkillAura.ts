import {
  HEAL_ZONE_HEAL_FRACTION,
  HEAL_ZONE_TICK_MS,
  GROVE_AURA_HEAL_FRACTION,
  GROVE_AURA_TICK_MS,
  GROVE_LORE_GROVE_DUNGEON_ID,
  distanceMeters,
  groveAuraRadiusM
} from "@ash-atlas/shared";

import { FractionalHealCarry, nextBeatDueAt } from "./fractionalHeal.js";

type AuraEntity = Readonly<{
  lat: number;
  lon: number;
  maxHealth: number;
  currentHealth: number;
  lifeState: string;
}>;

export type DungeonSkillAuraDependencies = Readonly<{
  activePlayerIds(): readonly string[];
  skills: Readonly<{
    ensureLoaded(playerId: string): Promise<void>;
    rankOf(playerId: string, skillId: "grove_lore"): number;
  }>;
  combat: Readonly<{
    entity(entityId: string): AuraEntity | null;
    healEntity(entityId: string, amount: number, sourceEntityId?: string, witheredFraction?: number): number;
    druidHealingAuraTraits?(playerId: string): Readonly<{ extraRangeM: number; witheredFraction: number }>;
    isInCombat(playerId: string): boolean;
  }>;
  dungeon: Readonly<{
    dungeonIdFor(playerId: string): string | null;
    isInHealZone(playerId: string): boolean;
  }>;
  partyMemberIds(playerId: string): readonly string[];
  now?: () => number;
}>;

/**
 * Server-authoritative healing from dungeon skills: the Hermit's Gift aura (the skill, or temporarily
 * everyone inside Blightwood Grove) and the Healing Spring zone. Call `tick` from the game loop; it runs
 * a pass at most once per aura tick.
 */
export class DungeonSkillAuraRuntime {
  private lastAuraAt = 0;
  private lastZoneAt = 0;
  private readonly auraCarry = new FractionalHealCarry();
  private readonly zoneCarry = new FractionalHealCarry();

  constructor(private readonly deps: DungeonSkillAuraDependencies) {}

  private insideGrove(playerId: string): boolean {
    return this.deps.dungeon.dungeonIdFor(playerId) === GROVE_LORE_GROVE_DUNGEON_ID;
  }

  /** Aura radius for the player: Grove Lore rank, or rank 1 while inside Blightwood Grove; 0 = no aura. */
  auraRadiusM(playerId: string): number {
    return groveAuraRadiusM(this.deps.skills.rankOf(playerId, "grove_lore"), this.insideGrove(playerId));
  }

  hasAura(playerId: string): boolean {
    return this.auraRadiusM(playerId) > 0;
  }

  tick(): void {
    const now = (this.deps.now ?? Date.now)();
    const players = this.deps.activePlayerIds();
    if (now - this.lastAuraAt >= GROVE_AURA_TICK_MS) {
      this.lastAuraAt = nextBeatDueAt(this.lastAuraAt, now, GROVE_AURA_TICK_MS);
      for (const playerId of players) void this.deps.skills.ensureLoaded(playerId).catch(() => undefined);
      this.auraPass(players);
    }
    if (now - this.lastZoneAt >= HEAL_ZONE_TICK_MS) {
      this.lastZoneAt = nextBeatDueAt(this.lastZoneAt, now, HEAL_ZONE_TICK_MS);
      this.zonePass(players);
    }
  }

  private auraPass(players: readonly string[]): void {
    const healed = new Set<string>();
    for (const holderId of players) {
      if (!this.hasAura(holderId)) continue;
      const holder = this.alive(holderId);
      if (!holder || this.deps.combat.isInCombat(holderId)) continue;
      const druid = this.deps.combat.druidHealingAuraTraits?.(holderId);
      const radius = this.auraRadiusM(holderId) + (druid?.extraRangeM ?? 0);
      const recipients = new Set<string>([holderId, ...this.deps.partyMemberIds(holderId)]);
      for (const recipientId of recipients) {
        if (healed.has(recipientId) || !players.includes(recipientId)) continue;
        const recipient = recipientId === holderId ? holder : this.alive(recipientId);
        if (!recipient || this.deps.combat.isInCombat(recipientId)) continue;
        if (recipientId !== holderId && distanceMeters(holder, recipient) > radius) continue;
        if (recipient.currentHealth >= recipient.maxHealth) continue;
        healed.add(recipientId);
        const amount = this.auraCarry.take(recipientId, recipient.maxHealth * GROVE_AURA_HEAL_FRACTION);
        if (amount > 0) this.deps.combat.healEntity(recipientId, amount, holderId, druid?.witheredFraction ?? 0);
      }
    }
  }

  private zonePass(players: readonly string[]): void {
    for (const playerId of players) {
      if (!this.deps.dungeon.isInHealZone(playerId)) continue;
      const entity = this.alive(playerId);
      if (!entity || entity.currentHealth >= entity.maxHealth) continue;
      const amount = this.zoneCarry.take(playerId, entity.maxHealth * HEAL_ZONE_HEAL_FRACTION);
      if (amount > 0) this.deps.combat.healEntity(playerId, amount);
    }
  }

  private alive(playerId: string): AuraEntity | null {
    const entity = this.deps.combat.entity(playerId);
    return entity && entity.lifeState === "alive" ? entity : null;
  }
}
