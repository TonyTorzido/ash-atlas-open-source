import type { BossEntityOwnership, ServerMessage } from "@ash-atlas/shared";

import type { CombatDefeatSettlementCandidate } from "./combat/combatEngine.js";

export interface OverworldBossEventPublisher {
  send(playerId: string, message: ServerMessage): void;
  broadcast(message: ServerMessage): void;
}

export type OverworldBossRewardSettlementPolicy = "canonical" | "xoral_bespoke";

export interface OverworldBossEventHandler {
  readonly handlerId: string;
  readonly rewardSettlementPolicy: OverworldBossRewardSettlementPolicy;
  ownsEntity(entityId: string): boolean;
  ownsDefeatCandidate(candidate: CombatDefeatSettlementCandidate): boolean;
  canPlayerAttack(playerId: string, entityId: string): boolean;
  canMobAttack(entityId: string, playerId: string): boolean;
  isSharedCombat(entityId: string): boolean;
  canMobContinueIntent?(entityId: string, playerId: string): boolean;
  acceptDefeat(candidate: CombatDefeatSettlementCandidate): Promise<boolean>;
}

export class OverworldBossEventRegistry {
  private readonly handlersById = new Map<string, OverworldBossEventHandler>();

  register(handler: OverworldBossEventHandler): void {
    if (!handler.handlerId.trim()) {
      throw new Error("Overworld boss handler id is required");
    }
    if (handler.rewardSettlementPolicy === "xoral_bespoke" && handler.handlerId !== "xoral") {
      throw new Error("Only the Xoral handler may use the bespoke reward settlement policy");
    }
    if (handler.handlerId === "xoral" && handler.rewardSettlementPolicy !== "xoral_bespoke") {
      throw new Error("The Xoral handler must use the bespoke reward settlement policy");
    }
    if (this.handlersById.has(handler.handlerId)) {
      throw new Error(`Duplicate overworld boss handler id: ${handler.handlerId}`);
    }
    this.handlersById.set(handler.handlerId, handler);
  }

  handlerForEntity(entityId: string): OverworldBossEventHandler | null {
    return this.uniqueOwner(
      `entity ${entityId}`,
      (handler) => handler.ownsEntity(entityId)
    );
  }

  handlerForOwnership(ownership: Pick<BossEntityOwnership, "encounterHandlerId" | "hostKind"> | null | undefined): OverworldBossEventHandler | null {
    if (!ownership || ownership.hostKind !== "overworld") return null;
    return this.handlersById.get(ownership.encounterHandlerId) ?? null;
  }

  handlerForDefeatCandidate(
    candidate: CombatDefeatSettlementCandidate
  ): OverworldBossEventHandler | null {
    if (candidate.bossOwnership) {
      return this.handlerForOwnership(candidate.bossOwnership);
    }
    return this.uniqueOwner(
      `defeat candidate ${candidate.settlementKey}`,
      (handler) => handler.ownsDefeatCandidate(candidate)
    );
  }

  private uniqueOwner(
    description: string,
    owns: (handler: OverworldBossEventHandler) => boolean
  ): OverworldBossEventHandler | null {
    let owner: OverworldBossEventHandler | null = null;
    for (const handler of this.handlersById.values()) {
      if (!owns(handler)) continue;
      if (owner) {
        throw new Error(
          `Ambiguous overworld boss ownership for ${description}: ` +
          `${owner.handlerId}, ${handler.handlerId}`
        );
      }
      owner = handler;
    }
    return owner;
  }
}
