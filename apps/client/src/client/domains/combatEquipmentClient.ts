import type { GearScrollMemoryGroup } from "@ash-atlas/shared";
import type { AbilityTargetMode, ClassId, ClientMessage, EquipmentDefinitionId, EquipmentGameplayFamilyId, EquipmentSlot, UtilityGearDefinitionId, ClassLoadoutView, DevProgressionType, GeneralActiveSlotId, GeneralSkillId, LatLon, LaunchClassId, SkillPointMutationTarget, SpecializationId, SubclassId } from "@ash-atlas/shared";
import { requestIdCrypto as crypto } from "../../requestId.js";
import type {
  ClientCommandPort,
  GameplayCommandAttempt
} from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

export class CombatEquipmentClient {
  constructor(private readonly port: ClientCommandPort) {}

  startAttack(targetEntityId: string, confirmNpcHostility = false): GameplayCommandAttempt {
      const requestId = crypto.randomUUID();
      const expectedGeneration = this.port.connectionGeneration?.();
      return {
        requestId,
        outcome: this.port.send({
        type: "START_ATTACK",
        requestId,
        targetEntityId,
        ...(confirmNpcHostility ? { confirmNpcHostility: true } : {})
        }, expectedGeneration)
      };
    }

  startXoralEvent(xoralEntityId: string): GameplayCommandAttempt {
    const requestId = crypto.randomUUID();
    const expectedGeneration = this.port.connectionGeneration?.();
    return {
      requestId,
      outcome: this.port.send({
        type: "START_XORAL_EVENT",
        requestId,
        xoralEntityId
      }, expectedGeneration)
    };
  }

  confirmXoralExit(): GameplayCommandAttempt {
    const requestId = crypto.randomUUID();
    const expectedGeneration = this.port.connectionGeneration?.();
    return {
      requestId,
      outcome: this.port.send({
        type: "CONFIRM_XORAL_EXIT",
        requestId
      }, expectedGeneration)
    };
  }

  pickupXoralRingDrop(dropId: string): GameplayCommandAttempt {
    const requestId = crypto.randomUUID();
    const expectedGeneration = this.port.connectionGeneration?.();
    return {
      requestId,
      outcome: this.port.send({
        type: "PICKUP_XORAL_RING_DROP",
        requestId,
        dropId
      }, expectedGeneration)
    };
  }

  requestCreatureBook(): boolean {
    return this.send({ type: "REQUEST_CREATURE_BOOK" });
  }

  requestProgressionSnapshot(): boolean {
      return this.send({
        type: "REQUEST_PROGRESSION_SNAPSHOT",
        requestId: crypto.randomUUID()
      });
    }

  respawnPlayer(): GameplayCommandAttempt {
    const requestId = crypto.randomUUID();
    const expectedGeneration = this.port.connectionGeneration?.();
    return {
      requestId,
      outcome: this.port.send({ type: "RESPAWN_PLAYER", requestId }, expectedGeneration)
    };
  }

  requestClassSnapshot(): boolean {
      return this.send({ type: "REQUEST_CLASS_SNAPSHOT", requestId: crypto.randomUUID() });
    }

  requestSkillTreeV3Snapshot(requestId: string = crypto.randomUUID()): string | null {
    return this.send({ type: "REQUEST_SKILL_TREE_SNAPSHOT", requestId }) ? requestId : null;
  }

  spendSkillTreeV3Point(
    expectedRevision: number,
    target: SkillPointMutationTarget,
    requestId: string = crypto.randomUUID()
  ): string | null {
    return this.send({ type: "SPEND_SKILL_POINT", requestId, expectedRevision, target }) ? requestId : null;
  }

  refundSkillTreeV3Rank(
    expectedRevision: number,
    target: Exclude<SkillPointMutationTarget, { kind: "world_knowledge" }>,
    requestId: string = crypto.randomUUID()
  ): string | null {
    return this.send({ type: "REFUND_SKILL_RANK", requestId, expectedRevision, target }) ? requestId : null;
  }

  activateSkillTreeV3Specialization(
    expectedRevision: number,
    specializationId: SpecializationId | null,
    requestId: string = crypto.randomUUID()
  ): string | null {
    return this.send({ type: "ACTIVATE_SPECIALIZATION", requestId, expectedRevision, specializationId }) ? requestId : null;
  }

  equipSkillTreeV3GeneralActive(
    expectedRevision: number,
    slot: GeneralActiveSlotId,
    skillId: GeneralSkillId | null,
    requestId: string = crypto.randomUUID()
  ): string | null {
    return this.send({ type: "EQUIP_GENERAL_ACTIVE", requestId, expectedRevision, slot, skillId }) ? requestId : null;
  }

  useSkillTreeV3GeneralActive(
    expectedRevision: number,
    skillId: GeneralSkillId | "edict_stride",
    options: Readonly<{
      targetEntityId?: string;
      targetMode?: "hostile" | "friendly" | "self" | "position" | "direction";
      targetPosition?: LatLon;
      directionDegrees?: number;
    }> = {},
    requestId: string = crypto.randomUUID()
  ): string | null {
    return this.send({
      type: "USE_GENERAL_ACTIVE",
      requestId,
      expectedRevision,
      skillId,
      ...(options.targetEntityId === undefined ? {} : { targetEntityId: options.targetEntityId }),
      ...(options.targetMode === undefined ? {} : { targetMode: options.targetMode }),
      ...(options.targetPosition === undefined ? {} : { targetPosition: options.targetPosition }),
      ...(options.directionDegrees === undefined ? {} : { directionDegrees: options.directionDegrees })
    }) ? requestId : null;
  }

  resetOwnDevSkillTreeV3(
    expectedRevision: number,
    requestId: string = crypto.randomUUID()
  ): string | null {
    return this.send({
      type: "RESET_OWN_DEV_SKILL_TREE",
      requestId,
      expectedRevision
    }) ? requestId : null;
  }

  /** One-time discovery offering for an Advanced General skill. */
  offerSkillTreeV3Unlock(skillId: GeneralSkillId, requestId: string = crypto.randomUUID()): string | null {
    return this.send({ type: "OFFER_SKILL_UNLOCK", requestId, skillId }) ? requestId : null;
  }

  respecSkillTreeV3Build(
    expectedRevision: number,
    requestId: string = crypto.randomUUID(),
    expectedGlimmerCost: number | null = null
  ): string | null {
    return this.send({
      type: "RESPEC_SKILL_BUILD",
      requestId,
      expectedRevision,
      ...(expectedGlimmerCost !== null ? { expectedGlimmerCost } : {})
    }) ? requestId : null;
  }

  /** Pay the Glimmer level-up fee and apply exactly one level (`targetLevel` = current level + 1). */
  confirmLevelUp(targetLevel: number, expectedGlimmerCost: number, requestId: string = crypto.randomUUID()): string | null {
    return this.send({ type: "CONFIRM_LEVEL_UP", requestId, targetLevel, expectedGlimmerCost }) ? requestId : null;
  }

  adjustOwnDevProgression(progressionType: DevProgressionType, targetRank: number): boolean {
      return this.send({
        type: "ADJUST_OWN_DEV_PROGRESSION",
        operationId: crypto.randomUUID(),
        progressionType,
        targetRank
      });
    }

  setOwnDevSubclassUnlock(subclassId: SubclassId, unlocked: boolean): boolean {
      return this.send({
        type: "SET_OWN_DEV_SUBCLASS_UNLOCK",
        operationId: crypto.randomUUID(),
        subclassId,
        unlocked
      });
    }

  updateClassLoadout(loadout: ClassLoadoutView): boolean {
      return this.send({
        type: "UPDATE_CLASS_LOADOUT",
        requestId: crypto.randomUUID(),
        loadout: {
          resetActives: [loadout.resetActives[0] ?? null, loadout.resetActives[1] ?? null],
          normalActives: [loadout.normalActives[0] ?? null, loadout.normalActives[1] ?? null],
          passiveTiers: [
            loadout.passiveTiers[0] ?? null,
            loadout.passiveTiers[1] ?? null,
            loadout.passiveTiers[2] ?? null
          ],
          ultimateActive: loadout.ultimateActive
        }
      });
    }

  activateSubclass(subclassId: SubclassId | null): boolean {
      return this.send({
        type: "ACTIVATE_SUBCLASS",
        requestId: crypto.randomUUID(),
        subclassId
      });
    }

  activateClass(classId: ClassId): boolean {
      return this.send({ type: "ACTIVATE_CLASS", requestId: crypto.randomUUID(), classId });
    }

  unlockClass(classId: LaunchClassId): boolean {
      return this.send({ type: "UNLOCK_CLASS", requestId: crypto.randomUUID(), classId });
    }

  useNormalAbility(
      abilityId: string,
      targetEntityId?: string,
      targetMode?: AbilityTargetMode,
      targetPosition?: LatLon
    ): boolean {
      return this.send({
        type: "USE_NORMAL_ABILITY",
        requestId: crypto.randomUUID(),
        abilityId,
        ...(targetEntityId === undefined ? {} : { targetEntityId }),
        ...(targetMode === undefined ? {} : { targetMode }),
        ...(targetPosition === undefined ? {} : { targetPosition })
      });
    }

  useResetAbility(
      abilityId: string,
      targetEntityId?: string,
      targetMode?: AbilityTargetMode
    ): boolean {
      return this.send({
        type: "USE_RESET_ABILITY",
        requestId: crypto.randomUUID(),
        abilityId,
        ...(targetEntityId === undefined ? {} : { targetEntityId }),
        ...(targetMode === undefined ? {} : { targetMode })
      });
    }

  useUniversalTaunt(): boolean {
      return this.send({ type: "USE_UNIVERSAL_TAUNT", requestId: crypto.randomUUID() });
    }

  equipItem(
      instanceId: string,
      slot: EquipmentSlot,
      requestId: string = crypto.randomUUID()
    ): string | null {
      return this.send({ type: "EQUIP_ITEM", requestId, instanceId, slot }) ? requestId : null;
    }

  unequipItem(instanceId: string, requestId: string = crypto.randomUUID()): string | null {
      return this.send({ type: "UNEQUIP_ITEM", requestId, instanceId }) ? requestId : null;
    }

  upgradeEquipment(
      instanceId: string,
      expectedLevel: number,
      requestId: string,
      manorSessionId?: string,
      manorMovementSequence?: number
    ): string | null {
      return this.send({
        type: "UPGRADE_EQUIPMENT",
        requestId,
        instanceId,
        expectedLevel,
        ...(manorSessionId !== undefined ? { manorSessionId } : {}),
        ...(manorMovementSequence !== undefined ? { manorMovementSequence } : {})
      }) ? requestId : null;
    }

  craftEquipment(
      familyId: EquipmentGameplayFamilyId,
      requestId: string,
      manorSessionId: string,
      manorMovementSequence: number,
      swagDefinitionId?: EquipmentDefinitionId
    ): string | null {
      return this.send({
        type: "CRAFT_EQUIPMENT",
        requestId,
        familyId,
        ...(swagDefinitionId !== undefined ? { definitionId: swagDefinitionId } : {}),
        manorSessionId,
        manorMovementSequence
      }) ? requestId : null;
    }

  /** Craft a portable recipe (starter gathering tool) on the player, with no Smithing Station. */
  craftPortableEquipment(familyId: EquipmentGameplayFamilyId, requestId: string): string | null {
      return this.send({ type: "CRAFT_EQUIPMENT", requestId, familyId }) ? requestId : null;
    }

  craftRepairKit(
      requestId: string,
      manorSessionId: string,
      manorMovementSequence: number
    ): string | null {
      return this.send({
        type: "CRAFT_REPAIR_KIT",
        requestId,
        manorSessionId,
        manorMovementSequence
      }) ? requestId : null;
    }

  polishRing(instanceId: string, requestId: string): string | null {
      return this.send({ type: "POLISH_RING", requestId, instanceId }) ? requestId : null;
    }

  craftGearScroll(requestId: string): string | null {
      return this.send({ type: "CRAFT_GEAR_SCROLL", requestId }) ? requestId : null;
    }

  requestGearScrolls(requestId: string): string | null {
      return this.send({ type: "REQUEST_GEAR_SCROLLS", requestId }) ? requestId : null;
    }

  rememberGearScroll(position: number, group: GearScrollMemoryGroup, requestId: string): string | null {
      return this.send({ type: "REMEMBER_GEAR_SCROLL", requestId, position, group }) ? requestId : null;
    }

  equipGearScroll(position: number, requestId: string): string | null {
      return this.send({ type: "EQUIP_GEAR_SCROLL", requestId, position }) ? requestId : null;
    }

  craftUtilityGear(definitionId: UtilityGearDefinitionId, requestId: string): string | null {
      return this.send({ type: "CRAFT_UTILITY_GEAR", requestId, definitionId }) ? requestId : null;
    }

  dumpRing(instanceId: string, requestId: string): string | null {
      return this.send({ type: "DUMP_RING", requestId, instanceId }) ? requestId : null;
    }

  mendEquipment(instanceId: string, requestId: string, stackId?: string): string | null {
      return this.send({
        type: "MEND_EQUIPMENT",
        requestId,
        instanceId,
        ...(stackId ? { stackId } : {})
      }) ? requestId : null;
    }

  repairEquipment(
      instanceId: string,
      expectedCondition: number,
      requestId: string,
      manorSessionId: string,
      manorMovementSequence: number
    ): string | null {
      return this.send({
        type: "REPAIR_EQUIPMENT",
        requestId,
        instanceId,
        expectedCondition,
        manorSessionId,
        manorMovementSequence
      }) ? requestId : null;
    }

  purchaseLimitedEquipment(
      definitionId: EquipmentDefinitionId,
      requestId: string,
      manorSessionId: string,
      manorMovementSequence: number
    ): string | null {
      return this.send({
        type: "PURCHASE_LIMITED_EQUIPMENT",
        requestId,
        definitionId,
        manorSessionId,
        manorMovementSequence
      }) ? requestId : null;
    }

  saveCombatKit(
      kitIndex: number,
      expectedInventoryRevision: number,
      requestId: string = crypto.randomUUID()
    ): string | null {
      return this.send({
        type: "SAVE_COMBAT_KIT",
        requestId,
        kitIndex,
        expectedInventoryRevision
      }) ? requestId : null;
    }

  renameCombatKit(
      kitIndex: number,
      name: string,
      requestId: string = crypto.randomUUID()
    ): string | null {
      return this.send({
        type: "RENAME_COMBAT_KIT",
        requestId,
        kitIndex,
        name
      }) ? requestId : null;
    }

  clearCombatKit(
      kitIndex: number,
      expectedInventoryRevision: number,
      requestId: string = crypto.randomUUID()
    ): string | null {
      return this.send({
        type: "CLEAR_COMBAT_KIT",
        requestId,
        kitIndex,
        expectedInventoryRevision
      }) ? requestId : null;
    }

  activateCombatKit(
      kitIndex: number,
      expectedInventoryRevision: number,
      requestId: string = crypto.randomUUID()
    ): string | null {
      return this.send({
        type: "ACTIVATE_COMBAT_KIT",
        requestId,
        kitIndex,
        expectedInventoryRevision
      }) ? requestId : null;
    }

  toggleReadiedWeapon(
      readiedWeaponSlot: "melee" | "secondary",
      expectedInventoryRevision: number,
      requestId: string = crypto.randomUUID()
    ): string | null {
      return this.send({
        type: "TOGGLE_READIED_WEAPON",
        requestId,
        readiedWeaponSlot,
        expectedInventoryRevision
      }) ? requestId : null;
    }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }
}
